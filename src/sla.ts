import cron from 'node-cron';
import { config } from './config.js';
import * as store from './store.js';
import { availabilityService } from './availability.js';
import { auditIssueEvent, logAudit } from './audit.js';
import { slackIdForGithubUsername } from './utils/workload.js';
import { PRIORITIES, PRIORITY_NAMES, type GitHubIssue, type GitHubProvider, type PostMessageFn, type Priority } from './types.js';

/**
 * SLA = "is anyone moving this?", not "how old is it?".
 *
 *   Not started (Todo)  → waiting longer than its priority allows (High 8 h · Medium 2 days · Low 5 days of WORKING time).
 *                         Urgent (P0) is handled by P0 escalation instead.
 *   In progress         → never alerts for age; only if there has been NO activity for 3 working days.
 *   Blocked             → no alerts; listed under "Needs attention" in the daily digest.
 *   Big tasks           → effort:high gets double the time.
 *   Assignee away (OOO) → the clock pauses.
 *   ETA                 → "@bot #1 will take till Friday" silences reminders until that day passes.
 *   Snooze              → 💤 on a reminder pauses it for 3 days.
 *
 * Reminders go to the issue's Slack thread, tagging only the assignee, at most every 3 days, only during working
 * hours. The 3rd reminder goes to the channel once, then it stops. "Working time" = Mon–Fri 9–18 in BOT_TIMEZONE.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type SlaCfg = typeof config.sla;
const tzName = () => config.bot.timezone;

// ── Time helpers (timezone-aware, no external deps) ────────────────────────

export function tzOffsetMs(utcMs: number, tz = tzName()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function localParts(ms: number, tz = tzName()) {
  const local = new Date(ms + tzOffsetMs(ms, tz));
  const jsDay = local.getUTCDay(); // 0 = Sun
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    hour: local.getUTCHours() + local.getUTCMinutes() / 60,
    weekday: jsDay === 0 ? 7 : jsDay, // 1 = Mon … 7 = Sun
  };
}

export function localToUtcMs(y: number, m: number, d: number, hour: number, tz = tzName()): number {
  const guess = Date.UTC(y, m - 1, d, hour);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}

export function isWorkingTime(ms: number, cfg: SlaCfg = config.sla, tz = tzName()): boolean {
  const p = localParts(ms, tz);
  return cfg.workDays.includes(p.weekday) && p.hour >= cfg.workStart && p.hour < cfg.workEnd;
}

/** Hours of working time (Mon–Fri, workStart–workEnd local) between two instants. */
export function workingHoursBetween(startMs: number, endMs: number, cfg: SlaCfg = config.sla, tz = tzName()): number {
  if (endMs <= startMs) return 0;
  let { y, m, d } = localParts(startMs, tz);
  const last = localParts(endMs, tz);
  const lastKey = last.y * 10000 + last.m * 100 + last.d;
  let total = 0;
  for (let i = 0; i < 800; i++) {
    const key = y * 10000 + m * 100 + d;
    if (key > lastKey) break;
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
    if (cfg.workDays.includes(weekday)) {
      const from = Math.max(localToUtcMs(y, m, d, cfg.workStart, tz), startMs);
      const to = Math.min(localToUtcMs(y, m, d, cfg.workEnd, tz), endMs);
      if (to > from) total += (to - from) / HOUR;
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return total;
}

export function formatLocalDate(ms: number, tz = tzName()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** End of the given local calendar day ("YYYY-MM-DD") in BOT_TIMEZONE, as epoch ms. Null if not a real date. */
export function etaEndOfDayMs(isoDate: string, tz = tzName()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return localToUtcMs(y, mo, d + 1, 0, tz) - 1;
}

function fmtWorking(hours: number, cfg: SlaCfg = config.sla): string {
  const day = cfg.workEnd - cfg.workStart;
  return hours >= day ? `${(hours / day).toFixed(1)} working days` : `${Math.max(1, Math.round(hours))} working hours`;
}

// ── Rules (pure) ───────────────────────────────────────────────────────────

export type SlaStatus = 'todo' | 'in-progress' | 'blocked';

export function statusOf(issue: Pick<GitHubIssue, 'labels'>): SlaStatus {
  if (issue.labels.includes('blocked')) return 'blocked';
  if (issue.labels.includes('in-progress')) return 'in-progress';
  return 'todo';
}

export const priorityOf = (issue: Pick<GitHubIssue, 'labels'>): Priority | undefined => PRIORITIES.find(p => issue.labels.includes(p));
const isBig = (issue: Pick<GitHubIssue, 'labels'>) => issue.labels.includes('effort:high');

export function notStartedThresholdHours(priority: Priority | undefined, big: boolean, cfg: SlaCfg = config.sla): number | null {
  const day = cfg.workEnd - cfg.workStart;
  let hours: number;
  switch (priority) {
    case 'P0':
      return null; // handled by P0 escalation
    case 'P1':
      hours = cfg.highHours;
      break;
    case 'P3':
      hours = cfg.lowDays * day;
      break;
    default:
      hours = cfg.mediumDays * day; // Medium, or no priority set
  }
  return big ? hours * cfg.bigTaskFactor : hours;
}

export function staleThresholdHours(big: boolean, cfg: SlaCfg = config.sla): number {
  return cfg.staleDays * (cfg.workEnd - cfg.workStart) * (big ? cfg.bigTaskFactor : 1);
}

export type SlaKind = 'ok' | 'not_started' | 'stale' | 'eta_missed' | 'blocked' | 'snoozed' | 'paused' | 'skipped';

export interface SlaVerdict {
  kind: SlaKind;
  /** Working hours spent waiting / silent. */
  hours: number;
  thresholdHours?: number;
  detail: string;
}

export function evaluateSla(
  issue: GitHubIssue,
  state: store.SlaStateRow | null,
  nowMs: number,
  opts: { assigneeAway?: boolean } = {},
  cfg: SlaCfg = config.sla
): SlaVerdict {
  const status = statusOf(issue);
  const paused = state?.pausedHours ?? 0;
  const updatedMs = new Date(issue.updatedAt).getTime() || 0;
  const activitySince = Math.max(updatedMs, state?.lastActivityMs ?? 0);

  if (status === 'blocked') {
    const hours = Math.max(0, workingHoursBetween(activitySince || nowMs, nowMs, cfg) - paused);
    return { kind: 'blocked', hours, detail: `blocked for ${fmtWorking(hours, cfg)}` };
  }

  if (state?.etaMs) {
    if (nowMs < state.etaMs) return { kind: 'ok', hours: 0, detail: `ETA ${formatLocalDate(state.etaMs)}` };
    if (!state.etaAlerted) return { kind: 'eta_missed', hours: 0, detail: `ETA ${formatLocalDate(state.etaMs)} has passed` };
  }
  if (state?.snoozedUntilMs && nowMs < state.snoozedUntilMs) return { kind: 'snoozed', hours: 0, detail: 'snoozed' };
  if (opts.assigneeAway) return { kind: 'paused', hours: 0, detail: 'assignee is out of office' };

  const big = isBig(issue);
  if (status === 'in-progress') {
    const hours = Math.max(0, workingHoursBetween(activitySince || nowMs, nowMs, cfg) - paused);
    const threshold = staleThresholdHours(big, cfg);
    return hours >= threshold
      ? { kind: 'stale', hours, thresholdHours: threshold, detail: `no update for ${fmtWorking(hours, cfg)}` }
      : { kind: 'ok', hours, thresholdHours: threshold, detail: 'in progress' };
  }

  const threshold = notStartedThresholdHours(priorityOf(issue), big, cfg);
  if (threshold === null) return { kind: 'skipped', hours: 0, detail: 'Urgent — P0 escalation applies' };
  const since = Math.max(new Date(issue.createdAt).getTime(), state?.lastActivityMs ?? 0);
  const hours = Math.max(0, workingHoursBetween(since, nowMs, cfg) - paused);
  return hours >= threshold
    ? { kind: 'not_started', hours, thresholdHours: threshold, detail: `not started, waiting ${fmtWorking(hours, cfg)}` }
    : { kind: 'ok', hours, thresholdHours: threshold, detail: 'waiting' };
}

// ── State helpers ──────────────────────────────────────────────────────────

const blankState = (issueNumber: number): store.SlaStateRow => ({
  issueNumber,
  lastStatus: null,
  lastActivityMs: null,
  lastTickMs: null,
  pausedHours: 0,
  lastAlertMs: null,
  alertCount: 0,
  snoozedUntilMs: null,
  etaMs: null,
  etaAlerted: false,
});

/** Record an ETA ("@bot #1 will take till Friday"): no reminders until that day has passed. */
export async function setIssueEta(github: GitHubProvider, issueNumber: number, etaMs: number): Promise<string> {
  const state = store.getSlaState(issueNumber) ?? blankState(issueNumber);
  state.etaMs = etaMs;
  state.etaAlerted = false;
  state.alertCount = 0;
  store.saveSlaState(state);
  const label = formatLocalDate(etaMs);
  await auditIssueEvent(github, issueNumber, 'sla.eta_set', `ETA set to **${label}** — reminders paused until then`);
  return label;
}

/** 💤 on a reminder: pause reminders for this issue for SLA_SNOOZE_DAYS. Returns the "until" label. */
export function snoozeSla(issueNumber: number, nowMs = Date.now(), cfg: SlaCfg = config.sla): string {
  const state = store.getSlaState(issueNumber) ?? blankState(issueNumber);
  state.snoozedUntilMs = nowMs + cfg.snoozeDays * DAY;
  store.saveSlaState(state);
  logAudit('sla.snoozed', { issueNumber, detail: `until ${formatLocalDate(state.snoozedUntilMs)}` });
  return formatLocalDate(state.snoozedUntilMs);
}

// ── The hourly check ───────────────────────────────────────────────────────

function mentionFor(issue: GitHubIssue): string {
  const assignee = issue.assignees[0];
  const slackId = assignee ? slackIdForGithubUsername(assignee) : null;
  if (slackId) return `<@${slackId}>`;
  return assignee ? `*${assignee}*` : config.team.map(m => `<@${m.slackId}>`).join(' ');
}

function alertText(issue: GitHubIssue, verdict: SlaVerdict, state: store.SlaStateRow, cfg: SlaCfg): string {
  const who = mentionFor(issue);
  const ref = `<${issue.url}|#${issue.number} ${issue.title}>`;
  const how = `\`@bot #${issue.number} will take till Friday\``;
  switch (verdict.kind) {
    case 'eta_missed':
      return `📅 ${who} the ETA (${formatLocalDate(state.etaMs!)}) for ${ref} has passed. Done? React ✅ — or set a new ETA with ${how}.`;
    case 'stale':
      return `🕸️ ${who} there's been no update on ${ref} for ${fmtWorking(verdict.hours, cfg)}. Still on it? Drop a quick note here, or set an ETA with ${how}. React 💤 to snooze for ${cfg.snoozeDays} days.`;
    default: {
      const p = priorityOf(issue);
      return `⏳ ${who} ${ref} hasn't been started yet${p ? ` (${PRIORITY_NAMES[p]} priority)` : ''} — waiting ${fmtWorking(verdict.hours, cfg)}. Pick it up with 👀, or set an ETA with ${how}. React 💤 to snooze for ${cfg.snoozeDays} days.`;
    }
  }
}

/**
 * One pass over all open issues. Exported for tests (inject `nowMs`).
 */
export async function runSlaCheck(github: GitHubProvider, post: PostMessageFn, nowMs = Date.now(), cfg: SlaCfg = config.sla): Promise<void> {
  const issues = await github.getAllOpenIssues();
  const openNumbers = new Set(issues.map(i => i.number));
  for (const n of store.listSlaIssueNumbers()) if (!openNumbers.has(n)) store.deleteSlaState(n); // closed

  const working = isWorkingTime(nowMs, cfg);

  for (const issue of issues) {
    const state = store.getSlaState(issue.number) ?? blankState(issue.number);
    const status = statusOf(issue);

    // Activity: a status change (also from dragging the card on the board) counts as movement.
    if (state.lastStatus && state.lastStatus !== status) state.lastActivityMs = nowMs;
    state.lastStatus = status;

    // Pause the clock while the assignee is out of office.
    const assignee = issue.assignees[0];
    const slackId = assignee ? slackIdForGithubUsername(assignee) : null;
    const away = slackId ? (await availabilityService.get(slackId, nowMs)).available === false : false;
    if (away && state.lastTickMs) state.pausedHours += workingHoursBetween(state.lastTickMs, nowMs, cfg);
    state.lastTickMs = nowMs;

    const verdict = evaluateSla(issue, state, nowMs, { assigneeAway: away }, cfg);
    const reminderDue =
      (verdict.kind === 'not_started' || verdict.kind === 'stale') &&
      state.alertCount < 3 &&
      (state.lastAlertMs === null || nowMs - state.lastAlertMs >= cfg.repeatDays * DAY);

    if (working && (verdict.kind === 'eta_missed' || reminderDue)) {
      const link = store.getIssueLink(issue.number);
      const isLast = verdict.kind !== 'eta_missed' && state.alertCount === 2;
      try {
        if (isLast) {
          await post(
            config.slack.devopsChannelId || link?.channelId || '',
            undefined,
            `⚠️ <${issue.url}|#${issue.number} ${issue.title}> still has no movement after 2 reminders to ${mentionFor(issue)} (${verdict.detail}). Team: should it be reassigned or re-scoped?`
          );
        } else if (link) {
          await post(link.channelId, link.threadTs, alertText(issue, verdict, state, cfg));
        } else {
          await post(config.slack.devopsChannelId, undefined, alertText(issue, verdict, state, cfg)); // not created from Slack
        }
        if (verdict.kind === 'eta_missed') state.etaAlerted = true;
        else {
          state.alertCount += 1;
          state.lastAlertMs = nowMs;
        }
        logAudit('sla.alerted', { issueNumber: issue.number, detail: `${verdict.kind}; ${verdict.detail}; reminder #${state.alertCount}${isLast ? ' (channel)' : ''}` });
      } catch (err) {
        console.error(`❌ Could not send SLA reminder for #${issue.number}:`, err);
      }
    }
    store.saveSlaState(state);
  }
}

/** Lines for the daily digest's "Needs attention" section. */
export async function slaAttentionLines(github: GitHubProvider, nowMs = Date.now(), cfg: SlaCfg = config.sla): Promise<string[]> {
  const issues = await github.getAllOpenIssues();
  const rows: { hours: number; line: string }[] = [];
  for (const issue of issues) {
    const v = evaluateSla(issue, store.getSlaState(issue.number), nowMs, {}, cfg);
    if (!['not_started', 'stale', 'eta_missed', 'blocked'].includes(v.kind)) continue;
    const who = issue.assignees[0] ? ` — *${issue.assignees[0]}*` : ' — unassigned';
    rows.push({ hours: v.hours, line: `<${issue.url}|#${issue.number}> ${issue.title}${who} — ${v.detail}` });
  }
  return rows.sort((a, b) => b.hours - a.hours).slice(0, 8).map(r => r.line);
}

export function startSlaChecker(github: GitHubProvider, post: PostMessageFn): void {
  cron.schedule(
    '0 * * * *',
    () => {
      runSlaCheck(github, post).catch(err => console.error('❌ SLA check failed:', err));
    },
    { timezone: config.bot.timezone }
  );
  const c = config.sla;
  console.log(
    `✓ SLA checker running hourly — Todo: High ${c.highHours}h / Medium ${c.mediumDays}d / Low ${c.lowDays}d, in-progress: ${c.staleDays}d of silence ` +
      `(working time ${c.workStart}:00–${c.workEnd}:00, ${config.bot.timezone})`
  );
}
