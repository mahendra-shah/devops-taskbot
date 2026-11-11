import * as store from './store.js';

/**
 * Detects whether a DevOps team member is out of office, by looking at THREE places on
 * their Slack profile (people use any of them):
 *   1. status text + status emoji (and Slack's own "clear after" expiry)
 *   2. display name
 *   3. full (real) name
 *
 * Rules
 *   - OOO keyword / emoji + a date or range  ("OOO till 15 Nov", "Leave 12-14 Nov") → away for those dates.
 *   - Slack status with an expiry                                                  → away until the expiry.
 *   - OOO marker with NO date and NO expiry                                         → away for THAT DAY ONLY
 *     (measured from the day the marker was first seen, in the person's timezone).
 *
 * Everything here is deterministic (no LLM). Parsing is day-first (15/11 = 15 Nov).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type OooSource = 'status' | 'display_name' | 'real_name';

export interface SlackProfileInfo {
  userId: string;
  displayName?: string;
  realName?: string;
  statusText?: string;
  /** e.g. ":palm_tree:" */
  statusEmoji?: string;
  /** Epoch seconds. 0 / undefined = status never expires. */
  statusExpiration?: number;
  /** Seconds east of UTC (Slack's `tz_offset`). */
  tzOffset?: number;
}

export interface Availability {
  available: boolean;
  /** Human-readable cause, e.g. `status "Vacationing"`. */
  reason?: string;
  source?: OooSource;
  /** Epoch ms when the leave ends (end of the last away day, or the status expiry). */
  until?: number;
  /** e.g. "Fri 14 Nov" or "today". */
  untilLabel?: string;
}

interface YMD {
  y: number;
  m: number;
  d: number;
}

interface DateRange {
  start?: YMD;
  end?: YMD;
}

interface OooSignal {
  source: OooSource;
  text: string;
  signature: string;
  range: DateRange | null;
  /** Epoch ms of the Slack status expiry (status source only). */
  expiryMs?: number;
}

// ── Keyword / emoji detection ──────────────────────────────────────────────

const BASE_KEYWORDS = [
  '(?<!\\w)o\\.?o\\.?o(?!\\w)',
  'ooto',
  'out[\\s-]+of[\\s-]+(?:the[\\s-]+)?office',
  'out\\s+sick',
  'out\\s+of\\s+town',
  'on[\\s-]+leave',
  'leaves?',
  'vacation(?:ing)?',
  'holidays?',
  'pto',
  'time[\\s-]+off',
  'day[\\s-]+off',
  'sick(?:[\\s-]+leave)?',
  'unwell',
  'not[\\s-]+available',
  'unavailable',
  '(?:out|off|away)\\s+(?:till|until|from|today|tomorrow|tmrw)',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKeywordRegex(): RegExp {
  const extra = (process.env.OOO_EXTRA_KEYWORDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => escapeRegex(s).replace(/\s+/g, '\\s+'));
  return new RegExp(`(?<!\\w)(?:${[...BASE_KEYWORDS, ...extra].join('|')})(?!\\w)`, 'i');
}

const KEYWORD_RE = buildKeywordRegex();

/** 🌴 🏖 🏝 🤒 🤧 ✈ 🧳 🛫 */
const UNICODE_OOO_EMOJI_RE = /[\u{1F334}\u{1F3D6}\u{1F3DD}\u{1F912}\u{1F927}\u{2708}\u{1F9F3}\u{1F6EB}]/u;

const OOO_EMOJI_NAMES = new Set([
  'palm_tree',
  'beach_with_umbrella',
  'desert_island',
  'face_with_thermometer',
  'thermometer',
  'sneezing_face',
  'airplane',
  'airplane_departure',
  'luggage',
]);

export function hasOooKeyword(text: string): boolean {
  return KEYWORD_RE.test(text) || UNICODE_OOO_EMOJI_RE.test(text);
}

function isOooEmoji(emoji: string | undefined): boolean {
  if (!emoji) return false;
  const name = emoji.replace(/^:|:$/g, '').toLowerCase().replace(/::skin-tone-\d/, '');
  if (OOO_EMOJI_NAMES.has(name)) return true;
  // Custom emoji such as :ooo:, :on-leave:, :out_of_office:
  return KEYWORD_RE.test(name.replace(/[_-]+/g, ' '));
}

// ── Date helpers (calendar math on the person's LOCAL date) ───────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayNum = (x: YMD): number => x.y * 10000 + x.m * 100 + x.d;

function addDays(x: YMD, n: number): YMD {
  const dt = new Date(Date.UTC(x.y, x.m - 1, x.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function localDate(nowMs: number, offsetSec: number): YMD {
  const dt = new Date(nowMs + offsetSec * 1000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function weekdayOf(x: YMD): number {
  return new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();
}

function endOfLocalDayMs(x: YMD, offsetSec: number): number {
  return Date.UTC(x.y, x.m - 1, x.d + 1) - offsetSec * 1000 - 1;
}

function isValidYMD(x: YMD): boolean {
  if (x.m < 1 || x.m > 12 || x.d < 1 || x.d > 31) return false;
  const dt = new Date(Date.UTC(x.y, x.m - 1, x.d));
  return dt.getUTCMonth() === x.m - 1 && dt.getUTCDate() === x.d;
}

/** Pick the year for a date written without one: this year, unless that is >30 days ago (then next year). */
function resolveYear(m: number, d: number, today: YMD, explicitYear?: number): YMD | null {
  if (explicitYear) {
    const y = explicitYear < 100 ? 2000 + explicitYear : explicitYear;
    const out = { y, m, d };
    return isValidYMD(out) ? out : null;
  }
  let out = { y: today.y, m, d };
  if (!isValidYMD(out)) return null;
  if (dayNum(out) < dayNum(addDays(today, -30))) {
    out = { y: today.y + 1, m, d };
    if (!isValidYMD(out)) return null;
  }
  return out;
}

// ── Date-phrase parsing ────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_RE = '(\\d{1,2})(?:st|nd|rd|th)?';
const SEP_RE = '(?:-|–|—|to|till|until|thru|through)';
const WEEKDAY_RE = '(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?';

const monthNum = (s: string): number => MONTHS[s.slice(0, 3).toLowerCase()];

interface Mention {
  index: number;
  end: number;
  date: YMD;
  /** `today`/`tomorrow`/weekday words: a bare mention means "that day" and nothing about a start. */
  relative: boolean;
}

type Connector = 'until' | 'back' | 'from' | 'none';

function connectorBefore(text: string, index: number): Connector {
  const before = text.slice(Math.max(0, index - 24), index).toLowerCase();
  if (/(?:till|until|upto|up\s+to|through|thru|\bto|\bby|ends?)(?:\s+on)?(?:\s+the)?\s*$/.test(before)) return 'until';
  if (/(?:back|returning|returns?|resum(?:e|es|ing)|available|reachable)(?:\s+(?:on|from|by|at|the))*\s*$/.test(before)) return 'back';
  if (/(?:from|starting|starts?)(?:\s+on)?(?:\s+the)?\s*$/.test(before)) return 'from';
  return 'none';
}

/**
 * Extracts a date range from free text such as:
 *   "OOO till 15 Nov", "Leave 12-14 Nov", "on leave Nov 12 to Nov 15", "back on Monday",
 *   "OOO tomorrow", "vacation 20/11 - 25/11", "OOO until friday"
 */
export function parseDateRange(rawText: string, today: YMD): DateRange | null {
  const text = rawText.replace(/\s+/g, ' ');

  // 1) Explicit ranges that share a month: "12-14 Nov", "12 to 14th November", "Nov 12-14"
  const rangeA = new RegExp(`\\b${DAY_RE}\\s*${SEP_RE}\\s*${DAY_RE}\\s*(?:of\\s+)?${MONTH_RE}\\b(?:\\s*,?\\s*(\\d{4}))?`, 'i').exec(text);
  if (rangeA) {
    const m = monthNum(rangeA[3]);
    const start = resolveYear(m, parseInt(rangeA[1], 10), today, rangeA[4] ? parseInt(rangeA[4], 10) : undefined);
    let end = resolveYear(m, parseInt(rangeA[2], 10), today, rangeA[4] ? parseInt(rangeA[4], 10) : undefined);
    if (start && end) {
      if (dayNum(end) < dayNum(start)) end = { ...end, y: end.y + 1 };
      return { start, end };
    }
  }
  const rangeB = new RegExp(`\\b${MONTH_RE}\\.?\\s+${DAY_RE}\\s*${SEP_RE}\\s*${DAY_RE}\\b(?!\\s*${MONTH_RE})(?:\\s*,?\\s*(\\d{4}))?`, 'i').exec(text);
  if (rangeB) {
    const m = monthNum(rangeB[1]);
    const start = resolveYear(m, parseInt(rangeB[2], 10), today, rangeB[4] ? parseInt(rangeB[4], 10) : undefined);
    let end = resolveYear(m, parseInt(rangeB[3], 10), today, rangeB[4] ? parseInt(rangeB[4], 10) : undefined);
    if (start && end) {
      if (dayNum(end) < dayNum(start)) end = { ...end, y: end.y + 1 };
      return { start, end };
    }
  }

  // 2) Individual date mentions
  const mentions: Mention[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => claimed.some(([s, e]) => a < e && b > s);
  const push = (index: number, end: number, date: YMD | null, relative = false) => {
    if (!date || overlaps(index, end)) return;
    claimed.push([index, end]);
    mentions.push({ index, end, date, relative });
  };

  for (const m of text.matchAll(new RegExp(`\\b${DAY_RE}\\s*(?:of\\s+)?${MONTH_RE}\\b(?:\\s*,?\\s*(\\d{4}))?`, 'gi'))) {
    push(m.index!, m.index! + m[0].length, resolveYear(monthNum(m[2]), parseInt(m[1], 10), today, m[3] ? parseInt(m[3], 10) : undefined));
  }
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+${DAY_RE}\\b(?!\\d)(?:\\s*,?\\s*(\\d{4}))?`, 'gi'))) {
    push(m.index!, m.index! + m[0].length, resolveYear(monthNum(m[1]), parseInt(m[2], 10), today, m[3] ? parseInt(m[3], 10) : undefined));
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) {
    // day-first (India): 15/11 = 15 Nov
    push(m.index!, m.index! + m[0].length, resolveYear(parseInt(m[2], 10), parseInt(m[1], 10), today, m[3] ? parseInt(m[3], 10) : undefined));
  }
  for (const m of text.matchAll(/\b(today|tonight|eod|tomorrow|tmrw)\b/gi)) {
    const w = m[1].toLowerCase();
    push(m.index!, m.index! + m[0].length, w === 'tomorrow' || w === 'tmrw' ? addDays(today, 1) : today, true);
  }
  for (const m of text.matchAll(new RegExp(`\\b${WEEKDAY_RE}\\b`, 'gi'))) {
    const target = WEEKDAYS[m[1].slice(0, 3).toLowerCase()];
    const delta = (target - weekdayOf(today) + 7) % 7; // today counts ("till friday" said on a Friday = today)
    push(m.index!, m.index! + m[0].length, addDays(today, delta), true);
  }

  if (mentions.length === 0) return null;
  mentions.sort((a, b) => a.index - b.index);

  // Two or more dates → first..last
  if (mentions.length >= 2) {
    const dates = mentions.map(m => m.date).sort((a, b) => dayNum(a) - dayNum(b));
    return { start: dates[0], end: dates[dates.length - 1] };
  }

  const only = mentions[0];
  switch (connectorBefore(text, only.index)) {
    case 'until':
      return { end: only.date };
    case 'back':
      return { end: addDays(only.date, -1) }; // back on Monday → away through Sunday
    case 'from':
      return { start: only.date, end: only.date };
    default:
      return { start: only.date, end: only.date }; // "OOO 15 Nov" / "OOO tomorrow" → that day
  }
}

// ── Signal detection + evaluation (pure) ───────────────────────────────────

/**
 * `anchorOf(signature)` is the day the marker was FIRST SEEN. Relative words ("tomorrow", "till friday",
 * "back monday") and year inference are resolved against that day — not against today — so a status
 * written on Wednesday as "OOO till friday" doesn't turn into *next* Friday once Friday has passed.
 */
function collectSignals(profile: SlackProfileInfo, anchorOf: (signature: string) => YMD): OooSignal[] {
  const signals: OooSignal[] = [];
  const status = (profile.statusText || '').trim();
  const emoji = (profile.statusEmoji || '').trim();

  if (status || emoji) {
    if (hasOooKeyword(status) || isOooEmoji(emoji)) {
      const expiryMs = profile.statusExpiration && profile.statusExpiration > 0 ? profile.statusExpiration * 1000 : undefined;
      const signature = `status|${status}|${emoji}|${expiryMs ?? ''}`;
      signals.push({
        source: 'status',
        text: status || emoji,
        signature,
        range: parseDateRange(status, anchorOf(signature)),
        expiryMs,
      });
    }
  }

  const display = (profile.displayName || '').trim();
  const real = (profile.realName || '').trim();
  const names: Array<[OooSource, string]> = [['display_name', display]];
  if (real && real !== display) names.push(['real_name', real]);

  for (const [source, text] of names) {
    if (text && hasOooKeyword(text)) {
      const signature = `${source}|${text}`;
      signals.push({ source, text, signature, range: parseDateRange(text, anchorOf(signature)) });
    }
  }
  return signals;
}

function formatEnd(endMs: number, offsetSec: number, today: YMD, withTime: boolean): string {
  const local = new Date(endMs + offsetSec * 1000);
  const ymd: YMD = { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
  const isToday = dayNum(ymd) === dayNum(today);
  const dateLabel = isToday ? 'today' : `${WEEKDAY_ABBR[local.getUTCDay()]} ${ymd.d} ${MONTH_ABBR[ymd.m - 1]}`;
  if (!withTime) return dateLabel;
  const h = local.getUTCHours();
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateLabel} ${h12}:${mm} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Pure availability evaluation. `firstSeenMs` tells when a date-less OOO marker was first observed.
 */
export function evaluateAvailability(
  profile: SlackProfileInfo,
  nowMs: number,
  opts: {
    defaultOffsetSec: number;
    firstSeenMs?: (signature: string) => number | null;
  }
): { availability: Availability; signals: OooSignal[] } {
  const offset = profile.tzOffset ?? opts.defaultOffsetSec;
  const today = localDate(nowMs, offset);
  const anchorOf = (signature: string): YMD => {
    const first = opts.firstSeenMs?.(signature);
    return first ? localDate(first, offset) : today;
  };
  const signals = collectSignals(profile, anchorOf);

  let best: { signal: OooSignal; endMs: number; expiryBased: boolean } | null = null;

  for (const s of signals) {
    let endMs: number | null = null;
    let expiryBased = false;

    if (s.expiryMs !== undefined) {
      // Slack status with "clear after"
      if (s.expiryMs <= nowMs) continue;
      if (s.range?.start && dayNum(s.range.start) > dayNum(today)) continue;
      endMs = s.expiryMs;
      expiryBased = true;
    } else if (s.range && (s.range.start || s.range.end)) {
      const start = s.range.start;
      const end = s.range.end ?? s.range.start!;
      if (start && dayNum(today) < dayNum(start)) continue;
      if (dayNum(today) > dayNum(end)) continue; // stale label — leave is over
      endMs = endOfLocalDayMs(end, offset);
    } else {
      // No date, no expiry → that day only
      const first = opts.firstSeenMs?.(s.signature) ?? nowMs;
      if (dayNum(localDate(first, offset)) !== dayNum(today)) continue;
      endMs = endOfLocalDayMs(today, offset);
    }

    if (endMs !== null && (!best || endMs > best.endMs)) best = { signal: s, endMs, expiryBased };
  }

  if (!best) return { availability: { available: true }, signals };

  const label = best.signal.source === 'status' ? 'status' : best.signal.source === 'display_name' ? 'display name' : 'full name';
  const endLocal = new Date(best.endMs + offset * 1000);
  const endsMidDay = best.expiryBased && !(endLocal.getUTCHours() === 23 && endLocal.getUTCMinutes() >= 59) && !(endLocal.getUTCHours() === 0 && endLocal.getUTCMinutes() === 0);
  return {
    availability: {
      available: false,
      reason: `${label} “${best.signal.text}”`,
      source: best.signal.source,
      until: best.endMs,
      untilLabel: formatEnd(best.endMs, offset, today, endsMidDay),
    },
    signals,
  };
}

// ── Service (caching + persistence of first-seen) ──────────────────────────

export type ProfileFetcher = (userId: string) => Promise<SlackProfileInfo | null>;

const PROFILE_TTL_MS = 5 * 60 * 1000;

export class AvailabilityService {
  private fetcher: ProfileFetcher | null = null;
  private cache = new Map<string, { at: number; profile: SlackProfileInfo }>();
  public defaultOffsetSec = (parseInt(process.env.DEFAULT_TZ_OFFSET_MINUTES || '330', 10) || 0) * 60;

  setFetcher(fn: ProfileFetcher | null): void {
    this.fetcher = fn;
    this.cache.clear();
  }

  /** Drop (or replace) the cached profile — called on Slack `user_change` events. */
  invalidate(userId: string, profile?: SlackProfileInfo): void {
    if (profile) this.cache.set(userId, { at: Date.now(), profile });
    else this.cache.delete(userId);
  }

  async getProfile(userId: string): Promise<SlackProfileInfo | null> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    if (!this.fetcher) return null;
    try {
      const profile = await this.fetcher(userId);
      if (profile) this.cache.set(userId, { at: Date.now(), profile });
      return profile;
    } catch (err) {
      console.warn(`⚠️ Could not read Slack profile for ${userId}: ${(err as Error).message}`);
      return hit?.profile ?? null;
    }
  }

  /** Fail-open: if the profile can't be read, the person is treated as available. */
  async get(userId: string, nowMs = Date.now()): Promise<Availability> {
    const profile = await this.getProfile(userId);
    if (!profile) return { available: true };

    const { availability, signals } = evaluateAvailability(profile, nowMs, {
      defaultOffsetSec: this.defaultOffsetSec,
      firstSeenMs: sig => store.getOooFirstSeen(userId, sig),
    });

    // Remember when each marker first appeared (anchor for relative dates + the day-only rule);
    // forget markers that are gone.
    for (const s of signals) store.setOooFirstSeen(userId, s.signature, nowMs);
    store.pruneOooSeen(userId, signals.map(s => s.signature));
    return availability;
  }

  async getMany(userIds: string[], nowMs = Date.now()): Promise<Map<string, Availability>> {
    const entries = await Promise.all(userIds.map(async id => [id, await this.get(id, nowMs)] as const));
    return new Map(entries);
  }

  async displayNameOf(userId: string): Promise<string | null> {
    const p = await this.getProfile(userId);
    return p ? p.displayName || p.realName || null : null;
  }
}

export const availabilityService = new AvailabilityService();

export function describeAvailability(a: Availability): string {
  if (a.available) return 'available';
  return `out until ${a.untilLabel ?? 'later'}`;
}

/** Builds a profile from a Slack `users.info` user or a `user_change` event user. */
export function profileFromSlackUser(user: any): SlackProfileInfo {
  const p = user?.profile || {};
  return {
    userId: user?.id,
    displayName: p.display_name || p.display_name_normalized || '',
    realName: p.real_name || user?.real_name || p.real_name_normalized || '',
    statusText: p.status_text || '',
    statusEmoji: p.status_emoji || '',
    statusExpiration: typeof p.status_expiration === 'number' ? p.status_expiration : 0,
    tzOffset: typeof user?.tz_offset === 'number' ? user.tz_offset : undefined,
  };
}
