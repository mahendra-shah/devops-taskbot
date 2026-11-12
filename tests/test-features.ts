process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:'; // tests never touch the real state DB

import nodemailer from 'nodemailer';
import { config } from '../src/config.js';
import { DevOpsBot, type AgentRunner } from '../src/bot.js';
import * as store from '../src/store.js';
import { AuditedGitHubProvider, AUDIT_MARKER, BOT_NOTE_MARKER, runWithAudit } from '../src/audit.js';
import { overlayIssue, matchOption, statusFromName, priorityFromName, effortFromName, STATUS_PATTERNS } from '../src/projectBoard.js';
import { FakeBoard } from './fake-board.js';
import { explainError, shouldAlertTeam, resetAlertsForTests, LlmUnavailableError } from '../src/errors.js';
import { fetchTeamWorkload } from '../src/utils/workload.js';
import { setIssueExtras } from '../src/audit.js';
import type { GitHubIssue } from '../src/types.js';
import {
  availabilityService,
  evaluateAvailability,
  parseDateRange,
  type SlackProfileInfo,
} from '../src/availability.js';
import { chooseAssignee, composeIssueBody, generateDailyDigest } from '../src/llm.js';
import { workingHoursBetween, isWorkingTime, etaEndOfDayMs, evaluateSla, runSlaCheck, setIssueEta, slaAttentionLines } from '../src/sla.js';
import { runEscalationCheck } from '../src/escalation.js';
import { runClosurePoll } from '../src/requesterUpdates.js';
import { fallbackTopic } from '../src/topics.js';
import { buildWeeklyReport, sendReportEmail, isEmailConfigured } from '../src/report.js';
import { trackPendingReply, snoozeReplyTimer, clearPendingReply, restorePendingReplies } from '../src/scheduler.js';
import type { TeamWorkload } from '../src/utils/workload.js';
import { MockGitHubProvider } from './github-mock.js';
import { SimulatedSlackEnvironment } from './simulator.js';
import { mockAgentRunner } from './mock-agent.js';

// ── Test plumbing ──────────────────────────────────────────────────────────

let passed = 0;
function banner(title: string) {
  console.log('\n' + '═'.repeat(72) + `\n🧪 ${title}\n` + '═'.repeat(72));
}
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  passed++;
  console.log(`   ✅ PASS: ${message}`);
}

// Three synthetic devs so the tests don't depend on how many people are in .env
config.team.splice(
  0,
  config.team.length,
  { slackId: 'UDEVA0001', githubUsername: 'dev-a' },
  { slackId: 'UDEVB0002', githubUsername: 'dev-b' },
  { slackId: 'UDEVC0003', githubUsername: 'dev-c' }
);
config.bot.timezone = 'Asia/Kolkata'; // SLA working time is computed in this zone (tests assume IST)
const A = 'UDEVA0001';
const B = 'UDEVB0002';
const C = 'UDEVC0003';

const IST = 19800;
const at = (y: number, m: number, d: number, h = 10, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - IST * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Nov"-style label for (today + n days) in IST, so tests never go stale. */
function dateLabel(offsetDays: number): string {
  const d = new Date(Date.now() + IST * 1000 + offsetDays * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function evalAt(profile: Partial<SlackProfileInfo>, now: number, firstSeen: number | null = null) {
  return evaluateAvailability({ userId: 'U1', tzOffset: IST, ...profile }, now, {
    defaultOffsetSec: IST,
    firstSeenMs: () => firstSeen,
  }).availability;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Out-of-office detection (pure parsing + rules)
// ═══════════════════════════════════════════════════════════════════════════
function testAvailabilityParsing() {
  banner('A. OOO detection from status, display name and full name');

  const NOW = at(2026, 11, 11, 10); // Wed 11 Nov 2026, 10:00 IST

  // Status
  let a = evalAt({ statusText: 'OOO' }, NOW);
  assert(!a.available && a.untilLabel === 'today', 'status "OOO" with no date → away for today only');

  a = evalAt({ statusText: 'OOO' }, NOW, at(2026, 11, 10, 9));
  assert(a.available, 'status "OOO" first seen YESTERDAY, no date → treated as stale (day-only rule)');

  a = evalAt({ statusText: 'OOO till 15 Nov' }, NOW);
  assert(!a.available && a.untilLabel === 'Sun 15 Nov', 'status "OOO till 15 Nov" → away until Sun 15 Nov');

  a = evalAt({ statusText: 'Vacationing', statusEmoji: ':palm_tree:', statusExpiration: Math.floor((NOW + 3 * 86_400_000) / 1000) }, NOW);
  assert(!a.available && /14 Nov/.test(a.untilLabel || ''), 'Slack status with expiry (+3d) → away until the expiry');

  a = evalAt({ statusText: '', statusEmoji: ':palm_tree:', statusExpiration: Math.floor((NOW + 86_400_000) / 1000) }, NOW);
  assert(!a.available, 'emoji-only status (🌴) with expiry → away');

  a = evalAt({ statusText: 'OOO', statusExpiration: Math.floor((NOW - 3600_000) / 1000) }, NOW);
  assert(a.available, 'expired status (expiry in the past) is ignored');

  a = evalAt({ statusText: 'In a meeting', statusEmoji: ':spiral_calendar_pad:' }, NOW);
  assert(a.available, '"In a meeting" is not OOO');
  for (const text of ['Working remotely', 'Focusing', 'Commuting', 'Out for lunch', 'Lunch break']) {
    assert(evalAt({ statusText: text }, NOW).available, `"${text}" is not OOO`);
  }

  a = evalAt({ statusText: 'Out sick' }, NOW);
  assert(!a.available, '"Out sick" with no date → away today');

  // Display name
  a = evalAt({ displayName: 'Ravi [Leave 12-14 Nov]' }, NOW);
  assert(a.available, 'display name "Leave 12-14 Nov" → not away yet on 11 Nov');
  a = evalAt({ displayName: 'Ravi [Leave 12-14 Nov]' }, at(2026, 11, 12, 10));
  assert(!a.available && a.untilLabel === 'Sat 14 Nov', 'display name range → away on 12 Nov until Sat 14 Nov');
  a = evalAt({ displayName: 'Ravi [Leave 12-14 Nov]' }, at(2026, 11, 15, 10));
  assert(a.available, 'display name range → back on 15 Nov (stale label ignored)');

  // Full name
  a = evalAt({ displayName: '', realName: 'Priya Sharma (on leave until 20/11)' }, NOW);
  assert(!a.available && a.untilLabel === 'Fri 20 Nov' && a.source === 'real_name', 'full name "on leave until 20/11" (day-first) → until Fri 20 Nov');

  a = evalAt({ displayName: 'Ravi 🌴' }, NOW);
  assert(!a.available, 'unicode 🌴 in display name → away (that day)');

  // Relative words + connectors
  a = evalAt({ statusText: 'OOO back Monday' }, NOW);
  assert(!a.available && a.untilLabel === 'Sun 15 Nov', '"OOO back Monday" → away through Sunday');
  a = evalAt({ statusText: 'OOO tomorrow' }, NOW);
  assert(a.available, '"OOO tomorrow" → not away today');
  a = evalAt({ statusText: 'OOO tomorrow' }, at(2026, 11, 12, 10), NOW);
  assert(!a.available, '"OOO tomorrow" written on the 11th → away on the 12th (anchored to when it was written)');
  a = evalAt({ statusText: 'OOO tomorrow' }, at(2026, 11, 13, 10), NOW);
  assert(a.available, '"OOO tomorrow" written on the 11th → over by the 13th (does not slide forward)');
  a = evalAt({ statusText: 'OOO till friday' }, NOW);
  assert(!a.available && a.untilLabel === 'Fri 13 Nov', '"OOO till friday" → until Fri 13 Nov');
  a = evalAt({ statusText: 'OOO till friday' }, at(2026, 11, 14, 10), NOW);
  assert(a.available, '"OOO till friday" on the Saturday after → NOT reinterpreted as next Friday');
  a = evalAt({ statusText: 'OOO 15 Nov' }, NOW);
  assert(a.available, '"OOO 15 Nov" (single date) → just that day, not today');
  a = evalAt({ statusText: 'OOO 15 Nov' }, at(2026, 11, 15, 10));
  assert(!a.available, '"OOO 15 Nov" → away on the 15th');
  a = evalAt({ statusText: 'OOO till 5 Nov' }, NOW);
  assert(a.available, 'stale "OOO till 5 Nov" (already past) → available');

  // Year rollover
  a = evalAt({ statusText: 'Leave 30 Dec - 3 Jan' }, at(2026, 12, 28, 10));
  assert(a.available, 'year rollover: leave starts 30 Dec → not away on 28 Dec');
  a = evalAt({ statusText: 'Leave 30 Dec - 3 Jan' }, at(2026, 12, 31, 10));
  assert(!a.available && a.untilLabel === 'Sun 3 Jan', 'year rollover: away on 31 Dec until Sun 3 Jan 2027');

  // Multiple sources: the latest end date wins
  a = evalAt({ statusText: 'OOO till 12 Nov', displayName: 'Ravi (OOO till 18 Nov)' }, NOW);
  assert(!a.available && a.untilLabel === 'Wed 18 Nov', 'status + name both OOO → the later end date wins');

  // Timezone / local-day boundary: 12 Nov 01:30 IST — "OOO" first seen 11 Nov is stale
  a = evalAt({ statusText: 'OOO' }, Date.UTC(2026, 10, 11, 20, 0), at(2026, 11, 11, 10));
  assert(a.available, 'day-only rule uses the person\'s LOCAL day (IST midnight rollover)');

  // Date range parser
  const r = parseDateRange('on leave Nov 12 to Nov 15', { y: 2026, m: 11, d: 11 });
  assert(r?.start?.d === 12 && r?.end?.d === 15, 'parses "Nov 12 to Nov 15"');
}

// ═══════════════════════════════════════════════════════════════════════════
// B. AvailabilityService: first-seen persistence
// ═══════════════════════════════════════════════════════════════════════════
async function testAvailabilityService() {
  banner('B. AvailabilityService — "no date = that day only" survives across days');

  let profile: SlackProfileInfo = { userId: 'USVC00001', displayName: 'Svc', statusText: 'OOO', tzOffset: IST };
  availabilityService.setFetcher(async () => profile);

  const day1 = at(2026, 11, 11, 10);
  const day2 = at(2026, 11, 12, 10);
  assert(!(await availabilityService.get('USVC00001', day1)).available, 'day 1: bare "OOO" → away');
  assert((await availabilityService.get('USVC00001', day2)).available, 'day 2: same bare "OOO" → no longer away');

  profile = { ...profile, statusText: '' };
  availabilityService.invalidate('USVC00001', profile);
  await availabilityService.get('USVC00001', day2);
  const rows = (store.getDb().prepare('SELECT COUNT(*) c FROM ooo_seen WHERE user_id = ?').get('USVC00001') as any).c;
  assert(rows === 0, 'cleared status → first-seen record is forgotten');

  profile = { ...profile, statusText: 'OOO' };
  availabilityService.invalidate('USVC00001', profile);
  assert(!(await availabilityService.get('USVC00001', at(2026, 11, 13, 10))).available, 'a NEW "OOO" later is treated as fresh → away that day');

  // fail-open
  availabilityService.setFetcher(async () => {
    throw new Error('slack down');
  });
  assert((await availabilityService.get('UNOBODY01')).available, 'Slack API failure → fail open (treated as available)');
}

// ═══════════════════════════════════════════════════════════════════════════
// C. chooseAssignee guarantee
// ═══════════════════════════════════════════════════════════════════════════
function testChooseAssignee() {
  banner('C. Assignment never lands on someone who is out of office');

  const wl = (id: string, name: string, load: number): TeamWorkload => ({ slackId: id, githubUsername: name, openIssues: [], loadScore: load });
  const team = [wl(A, 'dev-a', 1), wl(B, 'dev-b', 5), wl(C, 'dev-c', 3)];
  const out = { available: false, untilLabel: 'Fri 14 Nov', reason: 'status' };

  let c = chooseAssignee('dev-a', team, new Map());
  assert(c.assignee === 'dev-a', 'requested dev is available → kept');
  c = chooseAssignee('dev-a', team, new Map([[A, out]]));
  assert(c.assignee === 'dev-c' && /out of office/.test(c.note), 'requested dev is out → lowest-load AVAILABLE dev (dev-c)');
  c = chooseAssignee('dev-a', team, new Map([[A, out], [C, out]]));
  assert(c.assignee === 'dev-b', 'two devs out → the remaining one');
  c = chooseAssignee('dev-b', team, new Map([[A, out], [B, out], [C, out]]));
  assert(c.assignee === 'dev-a' && /everyone is out/.test(c.note), 'everyone out → lowest load, flagged in the note');
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario harness
// ═══════════════════════════════════════════════════════════════════════════
function setup() {
  store.resetDbForTests(); // fresh in-memory DB per scenario
  const mock = new MockGitHubProvider(false);
  const github = new AuditedGitHubProvider(mock);
  const bot = new DevOpsBot(github, mockAgentRunner, {
    classifyTopic: async title => (/vpn/i.test(title) ? 'vpn-access-reset' : null),
  });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  const latest = () => mock.getAllIssuesSnapshot().slice(-1)[0];
  const repliesIn = (threadTs: string) => slack.capturedReplies.filter(r => r.threadTs === threadTs).map(r => r.text);
  const clearOoo = () => {
    for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });
  };
  clearOoo();
  return { mock, github, bot, slack, latest, repliesIn, clearOoo };
}

const REQ = { userId: 'UREQ00001', userName: 'Ananya (Backend)' };

// ═══════════════════════════════════════════════════════════════════════════
// D. OOO inside the bot flow
// ═══════════════════════════════════════════════════════════════════════════
async function testOooInBotFlow() {
  banner('D1. Tagged dev is OOO (status) → task goes to an available dev + notice + timers + audit');
  {
    const { mock, slack, latest, repliesIn } = setup();
    slack.setProfile(A, { statusText: 'OOO' });
    const t = await slack.sendMessage({ ...REQ, text: 'Hey @dev-a please rotate the staging database password' });
    const issue = latest();
    assert(issue.assignees[0] === 'dev-b', 'issue assigned to dev-b, NOT the OOO dev-a');
    const replies = repliesIn(t).join('\n');
    assert(replies.includes(`<@${A}> is out of office`) && replies.includes(`<@${B}>`), 'thread notice: dev-a is out, assigned to dev-b instead');
    const timers = slack.getThread(t)!.pendingTaggedMembers;
    assert(!timers.includes(A) && timers.includes(B), 'no-reply timer skips the OOO dev, covers the assignee');

    const full = await mock.getIssueByNumber(issue.number);
    const audit = full!.comments!.find(c => c.body.startsWith(AUDIT_MARKER))!;
    assert(Boolean(audit) && audit.body.includes('Requested by') && audit.body.includes('Ananya'), 'audit comment on the GitHub issue names the requester');
    assert(audit.body.includes('dev-a is out of office'), 'audit comment explains WHY dev-b was chosen');
    assert(store.listAuditSince(0, 'issue.created').length === 1 && store.listAuditSince(0, 'ooo.redirected').length === 1, 'audit log (SQLite) has issue.created + ooo.redirected');
  }

  banner('D2. OOO via DISPLAY NAME and via FULL NAME');
  {
    const { slack, latest } = setup();
    slack.setProfile(A, { displayName: `dev-a [OOO till ${dateLabel(3)}]` });
    await slack.sendMessage({ ...REQ, text: 'Hey @dev-a please renew the wildcard certificate' });
    assert(latest().assignees[0] === 'dev-b', 'display-name OOO with a future end date → skipped');

    slack.setProfile(A, { displayName: 'dev-a' });
    slack.setProfile(B, { realName: `dev-b (on leave until ${dateLabel(2)})` });
    await slack.sendMessage({ ...REQ, text: 'Hey @dev-b please clean the unused load balancers' });
    assert(latest().assignees[0] === 'dev-a', 'full-name OOO → skipped (dev-a is back, dev-b is out)');
  }

  banner('D3. Everyone is OOO → still tracked, flagged, no pointless timer');
  {
    const { slack, latest, repliesIn } = setup();
    for (const id of [A, B, C]) slack.setProfile(id, { statusText: 'OOO' });
    const t = await slack.sendMessage({ ...REQ, text: 'Hey @dev-a please resize the staging cluster' });
    assert(Boolean(latest()), 'issue still created');
    assert(repliesIn(t).join('\n').includes('nobody else on the team is available'), 'thread explains nobody is available');
    assert(slack.getThread(t)!.pendingTaggedMembers.length === 0, 'no timer armed (nobody can reply)');
  }

  banner('D4. Silent when the bot has nothing to say — even if the tagged dev is OOO');
  {
    const { slack } = setup();
    slack.setProfile(A, { statusText: 'OOO' });
    const before = slack.capturedReplies.length;
    await slack.sendMessage({ ...REQ, text: 'Hey @dev-a thanks for yesterday, wanna grab coffee?' });
    assert(slack.capturedReplies.length === before, 'casual banter → no reply, no OOO notice');
  }

  banner('D5. @bot status shows who is out; assigning to an OOO dev warns');
  {
    const { slack } = setup();
    await slack.sendMessage({ ...REQ, text: '@bot please add a Grafana dashboard for the queue depth' });
    slack.setProfile(A, { statusText: `OOO till ${dateLabel(2)}` });
    await slack.sendMessage({ ...REQ, text: '@bot status' });
    const status = slack.capturedReplies.slice(-1)[0].text;
    assert(status.includes('🌴') && status.includes('dev-a'), '`@bot status` marks dev-a as 🌴 out until …');
    await slack.sendMessage({ ...REQ, text: '@bot assign #1 to dev-a' });
    assert(slack.capturedReplies.slice(-1)[0].text.includes('Heads up'), '`@bot assign … dev-a` warns that dev-a is out of office');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// E. Requester updates
// ═══════════════════════════════════════════════════════════════════════════
async function testRequesterUpdates() {
  banner('E. Requester gets told in the ORIGINAL thread when their request is closed');
  const { mock, github, slack, repliesIn } = setup();
  const poster = slack.createPoster();
  const resolved = (t: string) => repliesIn(t).filter(x => x.includes('your request is resolved'));

  // via ✅
  const t1 = await slack.sendMessage({ ...REQ, text: '@bot please add a new S3 bucket for staging backups' });
  await slack.react(t1, 'white_check_mark', A);
  assert(resolved(t1).length === 1 && resolved(t1)[0].includes(`<@${REQ.userId}>`), '✅ by a dev → requester tagged in the original thread');
  assert(store.getIssueLink(1)?.closedNotified === true, 'closure recorded as notified');
  await runClosurePoll(github, poster);
  assert(resolved(t1).length === 1, 'poll does not announce the same closure twice');

  // closed directly on GitHub
  const t2 = await slack.sendMessage({ ...REQ, text: '@bot please upgrade the nginx ingress helm chart' });
  mock.closeDirectly(2);
  await runClosurePoll(github, poster);
  assert(resolved(t2).length === 1, 'closed directly on GitHub → picked up by the poll → requester told');
  await runClosurePoll(github, poster);
  assert(resolved(t2).length === 1, 'still only one message after another poll');

  // reopen + close again
  await github.updateIssueStatus(2, 'open');
  await runClosurePoll(github, poster);
  assert(store.getIssueLink(2)?.closedNotified === false, 'reopened issue resets the notified flag');
  mock.closeDirectly(2);
  await runClosurePoll(github, poster);
  assert(resolved(t2).length === 2, 'closing it again notifies again');
}

// ═══════════════════════════════════════════════════════════════════════════
// F. P0 escalation
// ═══════════════════════════════════════════════════════════════════════════
async function testEscalation() {
  const MIN = 60_000;
  const escalations = (rs: string[]) => rs.filter(x => x.includes('P0 escalation'));

  banner('F1. Un-acknowledged P0 escalates at 30 / 60 / 120 min');
  {
    const { mock, github, slack, repliesIn } = setup();
    const poster = slack.createPoster();
    const t = await slack.sendMessage({ ...REQ, text: '@bot URGENT prod checkout is returning 502 errors' });
    assert(store.listP0Watches().length === 1, 'P0 watch started on creation');
    const base = Date.now();

    await runEscalationCheck(github, poster, base + 29 * MIN);
    assert(escalations(repliesIn(t)).length === 0, '29 min: nothing yet');

    await runEscalationCheck(github, poster, base + 31 * MIN);
    let e = escalations(repliesIn(t));
    assert(e.length === 1 && e[0].includes('1/3') && e[0].includes(`<@${A}>`) && !e[0].includes(`<@${B}>`), '31 min: level 1 → reminds ONLY the assignee');

    await runEscalationCheck(github, poster, base + 32 * MIN);
    assert(escalations(repliesIn(t)).length === 1, 'level 1 is not repeated on the next check');

    await runEscalationCheck(github, poster, base + 61 * MIN);
    e = escalations(repliesIn(t));
    assert(e.length === 2 && e[1].includes('2/3') && [A, B, C].every(id => e[1].includes(`<@${id}>`)) && !e[1].includes('<!here>'), '61 min: level 2 → tags every available dev');

    await runEscalationCheck(github, poster, base + 121 * MIN);
    e = escalations(repliesIn(t));
    assert(e.length === 3 && e[2].includes('3/3') && e[2].includes('<!here>'), '121 min: level 3 → everyone + @here');

    const full = await mock.getIssueByNumber(1);
    assert(full!.comments!.some(c => c.body.includes('P0 escalation 3/3')), 'each escalation is recorded as an audit comment on the issue');
  }

  banner('F2. Acknowledgement stops escalation (👀, thread reply, GitHub status, closed)');
  {
    // reaction
    let h = setup();
    let t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod api gateway is down 502' });
    await h.slack.react(t, 'eyes', B);
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 200 * MIN);
    assert(store.listP0Watches().length === 0 && escalations(h.repliesIn(t)).length === 0, '👀 from any dev → watch cleared, no escalation');

    // thread reply
    h = setup();
    t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod redis cluster is down 502' });
    await h.slack.sendMessage({ userId: B, userName: 'dev-b', text: 'Looking at it now', threadTs: t });
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 200 * MIN);
    assert(store.listP0Watches().length === 0 && escalations(h.repliesIn(t)).length === 0, 'a dev replying in the thread → watch cleared');

    // status changed on GitHub
    h = setup();
    t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod queue workers are down 502' });
    await h.github.updateIssueStatus(1, 'in-progress');
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 200 * MIN);
    assert(escalations(h.repliesIn(t)).length === 0, 'status → in-progress on GitHub → no escalation');

    // closed
    h = setup();
    t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod dns resolver is down 502' });
    h.mock.closeDirectly(1);
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 200 * MIN);
    assert(store.listP0Watches().length === 0 && escalations(h.repliesIn(t)).length === 0, 'issue closed → watch dropped, no escalation');
  }

  banner('F3. OOO-aware targets + no message burst after downtime');
  {
    let h = setup();
    let t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod search cluster is down 502' });
    h.slack.setProfile(A, { statusText: 'OOO' }); // assignee goes OOO AFTER creation
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 31 * MIN);
    let e = escalations(h.repliesIn(t));
    assert(e.length === 1 && !e[0].includes(`<@${A}>`) && e[0].includes(`<@${B}>`) && e[0].includes(`<@${C}>`), 'assignee is OOO → level 1 goes to the available devs instead');

    h = setup();
    t = await h.slack.sendMessage({ ...REQ, text: '@bot URGENT prod auth service is down 502' });
    await runEscalationCheck(h.github, h.slack.createPoster(), Date.now() + 200 * MIN);
    e = escalations(h.repliesIn(t));
    assert(e.length === 1 && e[0].includes('3/3'), 'bot was down for hours → ONE message at the highest due level, not three');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// G. Repeat-request detection
// ═══════════════════════════════════════════════════════════════════════════
async function testRepeatRequests() {
  banner('G. Same kind of request 3× in 30 days → one note to the devops channel');
  const { mock, bot, slack } = setup();
  const flags = () => slack.capturedReplies.filter(r => r.threadTs === 'CHANNEL' && r.text.includes('Repeat request spotted'));

  const asks = [
    '@bot please reset VPN access for Aman',
    '@bot VPN access reset needed for Neha',
    '@bot please reset VPN access for Rohit',
    '@bot please reset VPN access for Kiran',
  ];
  for (let i = 0; i < asks.length; i++) {
    await slack.sendMessage({ ...REQ, text: asks[i] });
    await bot.flushBackground();
    mock.closeDirectly(i + 1); // so the mock agent's duplicate check doesn't swallow the next one
    if (i === 1) assert(flags().length === 0, 'after 2 requests: no flag yet');
    if (i === 2) assert(flags().length === 1 && flags()[0].text.includes('#1, #2, #3'), 'after 3 requests: ONE note listing #1, #2, #3');
  }
  assert(flags().length === 1, '4th request in the same window: not flagged again');
  assert(fallbackTopic('reset vpn access') === fallbackTopic('vpn access reset'), 'fallback topic ignores word order (used when the LLM is unavailable)');
}

// ═══════════════════════════════════════════════════════════════════════════
// H. Persistence of timers
// ═══════════════════════════════════════════════════════════════════════════
async function testTimerPersistence() {
  banner('H. No-reply timers survive a restart');
  store.resetDbForTests();
  const say = async () => {};

  trackPendingReply('T_PERSIST', 'C1', [A], say);
  const rows = store.listPendingReplies();
  assert(rows.length === 1 && rows[0].messageTs === 'T_PERSIST' && rows[0].taggedIds[0] === A, 'timer is written to SQLite');

  const before = rows[0].fireAt;
  snoozeReplyTimer('T_PERSIST');
  assert(store.listPendingReplies()[0].fireAt > before, '💤 snooze moves the stored fire time');

  // simulate rows left behind by a previous process
  store.savePendingReply({ messageTs: 'T_OLD_RUN', channelId: 'C1', taggedIds: [B], fireAt: Date.now() + 10 * 60_000 });
  store.savePendingReply({ messageTs: 'T_STALE', channelId: 'C1', taggedIds: [B], fireAt: Date.now() - 7 * 3600_000 });
  const restored = restorePendingReplies(say);
  assert(restored >= 1, 'restart: timers re-armed from disk');
  assert(!store.listPendingReplies().some(r => r.messageTs === 'T_STALE'), 'restart: timers >6h overdue are dropped');

  for (const r of store.listPendingReplies()) clearPendingReply(r.messageTs);
  assert(store.listPendingReplies().length === 0, 'clearing a timer removes it from SQLite');
}

// ═══════════════════════════════════════════════════════════════════════════
// I. Weekly email report
// ═══════════════════════════════════════════════════════════════════════════
async function testWeeklyReport() {
  banner('I. Weekly report builds and is sent via nodemailer');
  const { mock, github, bot, slack } = setup();

  const asks = ['@bot please add Loki log retention policy', '@bot please prune old ECR images', '@bot please enable GuardDuty findings export'];
  for (let i = 0; i < asks.length; i++) {
    await slack.sendMessage({ ...REQ, text: asks[i] });
    await bot.flushBackground();
    mock.closeDirectly(i + 1);
  }
  await slack.sendMessage({ ...REQ, text: '@bot please rotate the Terraform state bucket keys' }); // stays open

  const report = await buildWeeklyReport(github, async id => `Name(${id})`);
  assert(report.subject.includes('3 done') && report.subject.includes('1 open'), `subject summarises the week: "${report.subject}"`);
  assert(report.text.includes('Handled by') && report.text.includes('dev-a: 3 done'), 'text body lists work handled per dev');
  assert(report.text.includes('Name(UREQ00001): 4'), 'top requesters are resolved to names');
  assert(report.html.includes('<table') && report.html.includes('Still open'), 'HTML body has tables');

  config.report.smtp.host = '';
  assert(!isEmailConfigured(), 'email disabled until SMTP_HOST / REPORT_TO are set');
  config.report.smtp.host = 'smtp.example.com';
  config.report.from = 'devops-bot@example.com';
  config.report.to = ['team@example.com', 'lead@example.com'];
  assert(isEmailConfigured(), 'email enabled once configured');

  const info: any = await sendReportEmail(report, nodemailer.createTransport({ jsonTransport: true }));
  const sent = JSON.parse(info.message);
  assert(sent.subject === report.subject && sent.to.length === 2 && Boolean(sent.html) && Boolean(sent.text), 'nodemailer message has subject, both recipients, HTML and text');
}

// ═══════════════════════════════════════════════════════════════════════════
// J. Changing priority / effort of an existing issue
// ═══════════════════════════════════════════════════════════════════════════
async function testPriorityChange() {
  banner('J. Priority / effort changes: labels swap, audit comment, P0 escalation starts/stops');
  store.resetDbForTests();
  const mock = new MockGitHubProvider(false);
  const github = new AuditedGitHubProvider(mock);

  // Stand-in for the LLM tool call: "set priority P0" / "set effort high" inside an issue thread
  const runner: AgentRunner = async params => {
    const p = params.event.text.match(/set priority (P[012])/i);
    const e = params.event.text.match(/set effort (low|medium|high)/i);
    if ((p || e) && params.linkedIssue) {
      const priority = p ? (p[1].toUpperCase() as 'P0' | 'P1' | 'P2') : undefined;
      await params.github.updateIssueMeta(params.linkedIssue.number, { priority, estimate: e ? (e[1] as 'low' | 'medium' | 'high') : undefined });
      return {
        replyText: 'Updated.',
        createdIssue: null,
        priorityChanges: priority ? [{ issueNumber: params.linkedIssue.number, priority }] : [],
      };
    }
    return mockAgentRunner(params);
  };
  const bot = new DevOpsBot(github, runner, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });

  const t = await slack.sendMessage({ ...REQ, text: '@bot please add a Grafana alert for disk usage' });
  const labels = async () => (await mock.getIssueByNumber(1))!.labels;
  assert((await labels()).includes('P2') && store.listP0Watches().length === 0, 'starts as P2, no escalation watch');

  await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot set priority P0', threadTs: t });
  let l = await labels();
  assert(l.includes('P0') && !l.includes('P2') && l.filter(x => /^P[012]$/.test(x)).length === 1, 'P2 → P0: old priority label replaced, exactly one priority label');
  assert(store.listP0Watches().length === 1 && store.listP0Watches()[0].threadTs === t, 'raising to P0 starts escalation in the original thread');
  assert(slack.capturedReplies.some(r => r.text.includes('P0 ALERT')), 'P0 alert posted to the assignee');

  const audit = (await mock.getIssueByNumber(1))!.comments!.find(c => c.body.includes('Priority:'));
  assert(Boolean(audit) && audit!.body.includes('Medium → **Urgent**') && audit!.body.includes('dev-b'), 'audit comment records Medium → Urgent and who did it');

  await runEscalationCheck(github, slack.createPoster(), Date.now() + 31 * 60_000);
  assert(slack.capturedReplies.some(r => r.text.includes('P0 escalation 1/3')), 'the new P0 escalates like any other');

  await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot set priority P1', threadTs: t });
  assert(store.listP0Watches().length === 0 && (await labels()).includes('P1'), 'lowering to P1 stops escalation');

  await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot set effort high', threadTs: t });
  l = await labels();
  assert(l.includes('effort:high') && l.filter(x => x.startsWith('effort:')).length === 1, 'effort swapped: exactly one effort label');
}

// ═══════════════════════════════════════════════════════════════════════════
// K. Project board = source of truth (status / priority / effort), bot-vs-human markers, issue body
// ═══════════════════════════════════════════════════════════════════════════
function boardHarness() {
  store.resetDbForTests();
  const mock = new MockGitHubProvider(false, { boardMode: true }); // like live board mode: no status/priority labels
  const board = new FakeBoard();
  const github = new AuditedGitHubProvider(mock, { board });
  const bot = new DevOpsBot(github, mockAgentRunner, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });
  const raw = (n = 1) => mock.getAllIssuesSnapshot().find(i => i.number === n)!;
  return { mock, board, github, bot, slack, raw };
}

async function testBoardAndMarkers() {
  banner('K1. Names on YOUR board map to our values');
  assert(
    priorityFromName('Urgent') === 'P0' && priorityFromName('High') === 'P1' && priorityFromName('Medium') === 'P2' && priorityFromName('Low') === 'P3',
    'Priority options Urgent / High / Medium / Low ↔ P0 / P1 / P2 / P3'
  );
  assert(statusFromName('Todo') === 'open' && statusFromName('In Progress') === 'in-progress' && statusFromName('Done') === 'done', 'Status options Todo / In Progress / Done map correctly');
  assert(effortFromName('Small') === 'low' && effortFromName('Medium') === 'medium' && effortFromName('XL') === 'high', 'effort options map (Small/Medium/XL)');
  assert(matchOption([{ id: '1', name: 'Todo' }, { id: '2', name: 'In Progress' }, { id: '3', name: 'Done' }], STATUS_PATTERNS.blocked) === null, 'a 3-column board has no "Blocked" → bot uses a label for blocked');

  const base = { number: 1, labels: ['devops', 'P2', 'in-progress', 'effort:low'] } as GitHubIssue;
  const o1 = overlayIssue(base, { status: 'open', priority: 'P0' }, false);
  assert(!o1.labels.includes('in-progress') && o1.labels.includes('P0') && !o1.labels.includes('P2'), 'board says Todo/Urgent → stale in-progress and P2 labels are overridden');
  assert(overlayIssue(base, undefined, false) === base, 'card with no board values → labels untouched');
  assert(overlayIssue({ ...base, labels: ['blocked'] } as GitHubIssue, { status: 'in-progress' }, false).labels.includes('blocked'), 'blocked label kept when the board has no Blocked column');
  assert(!overlayIssue({ ...base, labels: ['blocked'] } as GitHubIssue, { status: 'in-progress' }, true).labels.includes('blocked'), 'blocked label dropped when the board CAN show blocked');

  banner('K2. New issue: priority/status/effort go on the BOARD, not into labels');
  const { mock, board, github, slack, raw } = boardHarness();
  const t = await slack.sendMessage({ ...REQ, text: '@bot please add a Prometheus alert for pod restarts' });
  assert(!raw().labels.some(l => /^P[0-3]$/.test(l)) && !raw().labels.includes('in-progress'), 'issue has NO P*/in-progress labels (only devops, bot-created, effort:*)');
  const card = board.cards.get(1)!;
  assert(card.priority === 'Medium' && card.status === 'Todo' && card.effort === 'low', 'board card: Priority=Medium, Status=Todo, Effort=low');

  await runWithAudit({ actorId: B, actorName: 'dev-b', via: 'test' }, async () => {
    setIssueExtras({ estimateHours: 2.5 });
    await github.createIssue({ title: 'Rotate TLS certs', body: 'x', priority: 'P1', estimate: 'medium' }, 'dev-a', '9.9', 'C1');
  });
  assert(board.cards.get(2)!.hours === 2.5 && board.cards.get(2)!.priority === 'High', 'estimated hours land in the board\'s Estimate field (P1 → High)');

  banner('K3. 👀 / ✅ / priority changes move the card; the bot reads the board back');
  await slack.react(t, 'eyes', B);
  assert(board.cards.get(1)!.status === 'In Progress' && !raw().labels.includes('in-progress'), '👀 → card moves to In Progress, no label added');
  assert((await github.getIssueByNumber(1))!.labels.includes('in-progress'), 'the bot still SEES it as in-progress (reads the board)');
  const load = async () => (await fetchTeamWorkload(github)).find(w => w.githubUsername === 'dev-a')!.loadScore;
  const withProgress = await load();
  board.humanSet(1, { status: 'Todo' });
  const withoutProgress = await load();
  assert(withProgress - withoutProgress === 1, 'load score includes the +1 in-progress bonus while the BOARD says In Progress, and drops when a human drags the card back to Todo');

  await runWithAudit({ actorId: B, actorName: 'dev-b', via: 'test' }, () => github.updateIssueMeta(1, { priority: 'P0' }));
  assert(board.cards.get(1)!.priority === 'Urgent' && !raw().labels.includes('P0'), 'priority → Urgent on the board, no label');
  assert((await github.getIssueByNumber(1))!.labels.includes('P0'), 'bot sees P0 (so escalation logic still works)');
  await runWithAudit({ actorId: B, actorName: 'dev-b', via: 'test' }, () => github.updateIssueMeta(1, { priority: 'P3' }));
  assert(board.cards.get(1)!.priority === 'Low', 'Low priority exists too (P3 → Low)');

  await slack.react(t, 'no_entry', B);
  assert(board.cards.get(1)!.status === 'Todo' && raw().labels.includes('blocked'), '🚫 on a board with no Blocked column → falls back to a `blocked` label');

  await slack.react(t, 'white_check_mark', B);
  assert(board.cards.get(1)!.status === 'Done' && raw().state === 'closed', '✅ → card Done and issue closed');

  banner('K4. If the board is unreachable the bot degrades to labels instead of breaking');
  board.failing = true;
  await slack.sendMessage({ ...REQ, text: '@bot please clean up the old staging buckets' });
  const created = mock.getAllIssuesSnapshot().slice(-1)[0];
  assert(created.labels.includes('P2'), 'board write failed → priority kept as a label (nothing lost)');
  assert((await github.getAllOpenIssues()).length >= 1, 'board read failed → reads fall back to labels, no crash');

  banner('K5. "I did it" vs "the bot did it" is visible on the issue');
  const h = boardHarness();
  const tt = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Prometheus alert for pod restarts' });
  const full = (await h.mock.getIssueByNumber(1))!;
  assert(full.labels.includes('bot-created'), 'issue carries the `bot-created` label');
  assert(full.body.includes('Created by the **DevOps Taskbot** at the request of **Ananya (Backend)**'), 'body footer says the Taskbot created it, and for whom');
  assert(full.comments!.some(c => c.body.startsWith(AUDIT_MARKER)), 'bot changes carry the 🤖 audit-trail comment');
  await runWithAudit({ actorId: B, actorName: 'dev-b', via: 'Slack message to @bot' }, () => h.github.addIssueComment(1, 'restarted nginx, monitoring'));
  const note = (await h.mock.getIssueByNumber(1))!.comments!.find(c => c.body.includes('restarted nginx'))!;
  assert(note.body.startsWith(BOT_NOTE_MARKER) && note.body.includes('on behalf of dev-b'), 'a note the bot writes for someone is labelled "Posted by the DevOps Taskbot on behalf of dev-b"');
  const before = (await h.mock.getIssueByNumber(1))!.comments!.filter(c => c.body.includes(BOT_NOTE_MARKER)).length;
  await h.github.addIssueComment(1, `${AUDIT_MARKER}\n- already marked`);
  await h.github.addIssueComment(1, '🤖 **DevOps Tracker — audit trail**\n- old-format marker');
  assert((await h.mock.getIssueByNumber(1))!.comments!.filter(c => c.body.includes(BOT_NOTE_MARKER)).length === before, 'audit comments (incl. the pre-rename format) are not double-labelled');
  void tt;

  banner('K6. Issue body: summary line, requester, estimate, and BOTH original messages');
  const ev = {
    requesterName: 'Renuka Chouhan',
    originalText: 'Please grant write access on the clips bucket\nIt blocks our TTS tests',
    askedBy: { name: 'Mahendra', text: 'could you add this to github?' },
    priority: 'P1' as const,
    estimate: 'low' as const,
    estimateHours: 1,
  };
  let body = composeIssueBody('## Request\nGrant S3 write access\n\n## Definition of done\n- [ ] access confirmed', ev);
  assert(body.startsWith('> **Priority:** High · **Effort:** ~1 h (low) · **Requested by:** Renuka Chouhan'), 'body starts with Priority · Effort · Requested by');
  assert(body.includes('> Please grant write access on the clips bucket') && body.includes('> It blocks our TTS tests'), 'original request quoted (all lines) under the REAL requester');
  assert(body.includes('Message to the bot — Mahendra') && body.includes('could you add this to github?'), 'the teammate who tagged the bot is kept separately');
  assert(body.includes('## Definition of done'), 'LLM sections are kept');
  body = composeIssueBody('', { requesterName: 'Ananya', originalText: 'prod deploy failed', priority: 'P0', estimate: 'high' });
  assert(body.includes('## Request') && body.includes('Urgent') && body.includes('high (> 4 h)'), 'no LLM body → falls back to the message; effort shown with its range');
}

// ═══════════════════════════════════════════════════════════════════════════
// L. Friendly errors + unknown teammates
// ═══════════════════════════════════════════════════════════════════════════
async function testFriendlyErrors() {
  banner('L1. Error classification: plain language, no secrets');
  resetAlertsForTests();
  const auth = new LlmUnavailableError([{ provider: 'deepseek', status: 401, message: 'Authentication Fails, Your api key: ****b882 is invalid' }]);
  const f = explainError(auth, { log: false });
  assert(f.kind === 'llm_auth' && f.notifyTeam, 'invalid AI key → llm_auth, team is notified');
  assert(!/b882|401|api key:/i.test(f.userMessage) && !/b882/.test(f.adminHint), 'no key fragment / raw provider text in the Slack message or hint');
  assert(f.userMessage.includes('rejecting the bot’s API key') && f.userMessage.includes('not something you did'), 'tells the requester it is a setup problem, not their fault');
  assert(explainError(new LlmUnavailableError([{ provider: 'deepseek', status: 402, message: 'x' }]), { log: false }).kind === 'llm_quota', '402 → out of credit');
  assert(explainError(new LlmUnavailableError([{ provider: 'gemini', status: 429, message: 'x' }]), { log: false }).kind === 'llm_rate', '429 → rate limited (no team ping)');
  assert(explainError(new LlmUnavailableError([{ provider: 'gemini', message: 'timeout' }]), { log: false }).kind === 'llm_down', 'timeout → provider down');
  const gh422: any = Object.assign(new Error('Validation Failed: assignees invalid'), { status: 422, response: { url: 'https://api.github.com/repos/o/r/issues/1', data: { errors: [{ field: 'assignees' }] } } });
  const e422 = explainError(gh422, { log: false });
  assert(e422.kind === 'github_assignee' && e422.userMessage.includes('collaborator'), 'GitHub 422 on assignee → explains the collaborator / username fix');
  const unknown = explainError(new Error('kaboom internal detail'), { log: false });
  assert(unknown.kind === 'unknown' && !unknown.userMessage.includes('kaboom') && /ref `[a-z0-9]{6}`/.test(unknown.userMessage), 'unknown error → generic text + a ref id, internals stay in the logs');
  assert(shouldAlertTeam('llm_auth', 10_000_000) && !shouldAlertTeam('llm_auth', 10_000_000 + 60_000) && shouldAlertTeam('llm_auth', 10_000_000 + 31 * 60_000), 'the team is pinged once per 30 min per problem, not on every message');

  banner('L2. In Slack: a failing AI provider produces a helpful thread reply');
  resetAlertsForTests();
  store.resetDbForTests();
  const mock = new MockGitHubProvider(false);
  const github = new AuditedGitHubProvider(mock);
  const down: AgentRunner = async () => {
    throw auth;
  };
  const bot = new DevOpsBot(github, down, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });
  const t1 = await slack.sendMessage({ ...REQ, text: '@bot could you assign this to komal?' });
  const r1 = slack.capturedReplies.filter(r => r.threadTs === t1).map(r => r.text).join('\n');
  assert(r1.includes('rejecting the bot’s API key') && !/b882|Authentication Fails/.test(r1), 'thread gets a plain-language explanation (no raw provider error)');
  assert(r1.includes(`<@${A}>`) && r1.includes('DEEPSEEK') === false && r1.includes('Check the key'), 'the team is pinged with what to check');
  const t2 = await slack.sendMessage({ ...REQ, text: '@bot please add a dashboard' });
  const r2 = slack.capturedReplies.filter(r => r.threadTs === t2).map(r => r.text).join('\n');
  assert(r2.includes('rejecting the bot’s API key') && !r2.includes(`<@${A}>`), 'second failure within 30 min: explained again, team NOT pinged again');

  banner('L3. Asking for someone who is not in TEAM_MEMBERS');
  const ok = setup();
  await ok.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard' });
  await ok.slack.sendMessage({ ...REQ, text: '@bot assign #1 to komal' });
  const msg = ok.slack.capturedReplies.slice(-1)[0].text;
  assert(msg.includes('I don\'t know “komal”') && msg.includes('dev-a') && msg.includes('TEAM_MEMBERS'), '`@bot assign … komal` → says komal is unknown, lists who it can assign to, and what an admin must do');
  assert(ok.mock.getAllIssuesSnapshot()[0].assignees[0] !== 'komal', 'the issue was NOT silently assigned to anyone else');
  await ok.slack.sendMessage({ ...REQ, text: '@bot assign #1 to dev-c' });
  assert(ok.mock.getAllIssuesSnapshot()[0].assignees[0] === 'dev-c', 'a real teammate still works');
}

// ═══════════════════════════════════════════════════════════════════════════
// M. The REAL requester (thread author), and no pointless "your request is resolved"
// ═══════════════════════════════════════════════════════════════════════════
async function testRealRequester() {
  const resolved = (rs: string[]) => rs.filter(x => x.includes('your request is resolved'));

  banner('M1. Teammate says "@bot add this to github" in Renuka\'s thread → Renuka is the requester');
  {
    const { mock, github, slack, repliesIn } = setup();
    const renuka = { userId: 'URENUKA01', userName: 'Renuka Chouhan' };
    const t = await slack.sendMessage({ ...renuka, text: 'Please grant my AWS user write access to the clips bucket' });
    await slack.sendMessage({ userId: A, userName: 'dev-a', text: '@bot could you add this to github and assign it to me?', threadTs: t });
    assert(store.getIssueLink(1)?.requesterId === 'URENUKA01', 'requester = the thread\'s first author (Renuka), not dev-a who tagged the bot');
    const audit = (await mock.getIssueByNumber(1))!.comments!.find(c => c.body.startsWith(AUDIT_MARKER))!;
    assert(audit.body.includes('**Requested by:** Renuka Chouhan') && audit.body.includes('Asked the bot to log it'), 'audit comment names Renuka as requester AND dev-a as the one who asked the bot');

    await slack.react(t, 'white_check_mark', B);
    const r = resolved(repliesIn(t));
    assert(r.length === 1 && r[0].includes('<@URENUKA01>') && r[0].includes(`by <@${B}>`), '✅ by dev-b → Renuka (not dev-a) is told, and who closed it');
    void github;
  }

  banner('M2. No "your request is resolved" when it would be pointless');
  {
    const { mock, github, slack, repliesIn } = setup();
    const poster = slack.createPoster();

    // requester closes their own request (via ✅)
    const t1 = await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot please renew my VPN cert' });
    await slack.react(t1, 'white_check_mark', B);
    assert(resolved(repliesIn(t1)).length === 0, 'requester closed it themselves (✅) → no announcement');

    // requester closes their own request directly on GitHub (the screenshot case)
    const t2 = await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot please grant me write access to staging bucket' });
    mock.closeDirectly(2, 'dev-b');
    await runClosurePoll(github, poster);
    assert(resolved(repliesIn(t2)).length === 0, 'closed on GitHub by the requester → no announcement');

    // requester is also the assignee (asked for work for themselves)
    const t3 = await slack.sendMessage({ userId: A, userName: 'dev-a', text: '@bot please rotate my deploy key' });
    const assignee3 = mock.getAllIssuesSnapshot()[2].assignees[0];
    mock.closeDirectly(3, assignee3 === 'dev-a' ? 'dev-c' : 'dev-a');
    await runClosurePoll(github, poster);
    if (assignee3 === 'dev-a') assert(resolved(repliesIn(t3)).length === 0, 'requester is the assignee → no announcement');

    // someone ELSE closes it on GitHub → requester IS told, and by whom
    const t4 = await slack.sendMessage({ userId: 'UOTHER0001', userName: 'Karan (QA)', text: '@bot please restart the QA database' });
    mock.closeDirectly(4, 'dev-c');
    await runClosurePoll(github, poster);
    const r4 = resolved(repliesIn(t4));
    assert(r4.length === 1 && r4[0].includes('<@UOTHER0001>') && r4[0].includes(`by <@${C}>`), 'closed on GitHub by a teammate → requester told, with the closer named');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// N. SLA = "is anyone moving this?" (working time, priority, silence, ETA, snooze, OOO)
// ═══════════════════════════════════════════════════════════════════════════
async function testSla() {
  const TZ = 'Asia/Kolkata';
  const cfg = config.sla;
  const MON = at(2026, 11, 9, 10); // Monday 10:00 IST
  const mk = (labels: string[], createdMs: number, updatedMs = createdMs): GitHubIssue => ({
    number: 1,
    title: 'Task',
    body: '',
    url: 'https://github.com/o/r/issues/1',
    state: 'open',
    labels,
    assignees: ['dev-a'],
    createdAt: new Date(createdMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
  });
  const st = (patch: Partial<store.SlaStateRow> = {}): store.SlaStateRow => ({
    issueNumber: 1, lastStatus: null, lastActivityMs: null, lastTickMs: null, pausedHours: 0,
    lastAlertMs: null, alertCount: 0, snoozedUntilMs: null, etaMs: null, etaAlerted: false, ...patch,
  });
  const v = (labels: string[], now: number, state: store.SlaStateRow | null = null, opts: { assigneeAway?: boolean } = {}, updated = MON) =>
    evaluateSla(mk(labels, MON, updated), state, now, opts, cfg);

  banner('N1. Working time = Mon–Fri 9:00–18:00 IST');
  assert(workingHoursBetween(at(2026, 11, 13, 17), at(2026, 11, 16, 10), cfg, TZ) === 2, 'Fri 17:00 → Mon 10:00 = 2 working hours (1 h Friday + 1 h Monday)');
  assert(workingHoursBetween(at(2026, 11, 14, 10), at(2026, 11, 15, 18), cfg, TZ) === 0, 'a weekend counts as zero');
  assert(workingHoursBetween(at(2026, 11, 9, 0), at(2026, 11, 10, 0), cfg, TZ) === 9, 'a full working day = 9 h');
  assert(workingHoursBetween(at(2026, 11, 9, 7), at(2026, 11, 9, 10), cfg, TZ) === 1, 'hours before 9:00 do not count');
  assert(isWorkingTime(MON, cfg, TZ) && !isWorkingTime(at(2026, 11, 9, 19), cfg, TZ) && !isWorkingTime(at(2026, 11, 14, 11), cfg, TZ), 'Mon 10:00 is working time; Mon 19:00 and Saturday are not');
  assert(etaEndOfDayMs('2026-11-14', TZ) === at(2026, 11, 15, 0) - 1, 'an ETA date means the END of that day in IST');
  assert(etaEndOfDayMs('2026-02-30', TZ) === null && etaEndOfDayMs('friday', TZ) === null, 'invalid ETA dates are rejected');

  banner('N2. Not started: how long is too long depends on priority (working time)');
  assert(v(['P1'], at(2026, 11, 9, 17)).kind === 'ok' && v(['P1'], at(2026, 11, 9, 18)).kind === 'not_started', 'High: fine at 7 h, due at 8 h');
  assert(v(['P2'], at(2026, 11, 11, 9, 30)).kind === 'ok' && v(['P2'], at(2026, 11, 11, 10)).kind === 'not_started', 'Medium: fine at 17.5 h, due at 2 working days (18 h)');
  assert(v([], at(2026, 11, 11, 10)).kind === 'not_started', 'no priority is treated as Medium');
  assert(v(['P3'], at(2026, 11, 13, 10)).kind === 'ok' && v(['P3'], at(2026, 11, 16, 10)).kind === 'not_started', 'Low: fine after 4 days (36 h), due after 5 working days (45 h)');
  assert(v(['P0'], at(2026, 11, 30, 10)).kind === 'skipped', 'Urgent (P0) never uses this rule — P0 escalation handles it');
  assert(v(['P1', 'effort:high'], at(2026, 11, 10, 10)).kind === 'ok' && v(['P1', 'effort:high'], at(2026, 11, 11, 10)).kind === 'not_started', 'a big task (effort:high) gets double the time (High is due at 16 h, not 8)');
  assert(v(['P2'], at(2026, 11, 13, 18)).hours === v(['P2'], at(2026, 11, 16, 9)).hours, 'a weekend does not make an issue look older: waiting time at Fri 18:00 equals Mon 9:00');

  banner('N3. In progress: only silence matters. Blocked never alerts. ETA, snooze and OOO pause');
  const THU = at(2026, 11, 12, 10);
  assert(v(['in-progress'], THU).kind === 'stale', 'in progress and untouched for 3 working days → stale');
  assert(v(['in-progress'], at(2026, 11, 12, 9, 30)).kind === 'ok', '26.5 h of silence → still fine');
  assert(v(['in-progress'], THU, null, {}, at(2026, 11, 12, 9)).kind === 'ok', 'a recent update on the issue resets the silence clock');
  assert(v(['in-progress'], THU, st({ lastActivityMs: at(2026, 11, 12, 9) })).kind === 'ok', 'moving the card on the board counts as activity too');
  assert(v(['in-progress', 'effort:high'], THU).kind === 'ok', 'a big in-progress task gets double the silence allowance');
  assert(v(['blocked'], at(2026, 12, 20, 10)).kind === 'blocked', 'blocked → never a reminder (it shows in the digest instead)');
  const eta = etaEndOfDayMs('2026-11-13', TZ)!;
  assert(v(['P1'], at(2026, 11, 11, 10), st({ etaMs: eta })).kind === 'ok', 'an ETA in the future silences reminders');
  assert(v(['P1'], at(2026, 11, 16, 10), st({ etaMs: eta })).kind === 'eta_missed', 'once the ETA has passed → one "ETA missed" nudge');
  assert(v(['P1'], at(2026, 11, 16, 10), st({ etaMs: eta, etaAlerted: true })).kind === 'not_started', 'after that, normal rules apply again');
  assert(v(['P1'], at(2026, 11, 11, 10), st({ snoozedUntilMs: at(2026, 11, 13, 10) })).kind === 'snoozed', '💤 snooze silences reminders');
  assert(v(['P1'], at(2026, 11, 11, 10), null, { assigneeAway: true }).kind === 'paused', 'assignee out of office → paused');
  assert(v(['P2'], at(2026, 11, 11, 10), st({ pausedHours: 4 })).kind === 'ok', 'hours spent while the assignee was away are subtracted (18 h − 4 h = 14 h)');

  const started = (x: string) => x.includes("hasn't been started yet");

  banner('N4. The hourly check: reminder in the thread, repeat gap, working hours only, channel after 2, no labels');
  {
    const h = setup();
    const t = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    h.mock.backdate(1, MON);
    const poster = h.slack.createPoster();
    const count = () => h.repliesIn(t).filter(started).length;

    await runSlaCheck(h.github, poster, at(2026, 11, 11, 10), cfg);
    const r = h.repliesIn(t).filter(started);
    assert(r.length === 1 && r[0].includes(`<@${A}>`) && !r[0].includes(`<@${B}>`) && r[0].includes('💤'), 'Medium issue untouched for 2 working days → ONE reminder, in its own thread, tagging only the assignee');
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 11), cfg);
    assert(count() === 1, 'no repeat an hour later');
    await runSlaCheck(h.github, poster, at(2026, 11, 14, 11), cfg);
    assert(count() === 1, 'nothing on a Saturday — reminders only during working hours');
    await runSlaCheck(h.github, poster, at(2026, 11, 16, 10), cfg);
    assert(count() === 2, 'a second reminder after the 3-day gap');
    await runSlaCheck(h.github, poster, at(2026, 11, 20, 10), cfg);
    const chan = h.slack.capturedReplies.filter(x => x.threadTs === 'CHANNEL' && x.text.includes('still has no movement after 2 reminders'));
    assert(chan.length === 1 && count() === 2, 'the 3rd goes to the channel ONCE for the team (not another thread reply)');
    await runSlaCheck(h.github, poster, at(2026, 11, 27, 10), cfg);
    assert(h.slack.capturedReplies.filter(x => x.threadTs === 'CHANNEL' && x.text.includes('no movement')).length === 1 && count() === 2, 'then it stops');
    assert(!h.mock.getAllIssuesSnapshot()[0].labels.includes('sla-breach-alerted'), 'no `sla-breach-alerted` label is added to the issue any more');
  }

  banner('N5. 💤 on the thread snoozes reminders; "@bot #1 will take till Friday" sets an ETA');
  {
    const h = setup();
    const t = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    h.mock.backdate(1, MON);
    const poster = h.slack.createPoster();
    const count = () => h.repliesIn(t).filter(started).length;
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 10), cfg);
    await h.slack.sendMessage({ userId: A, userName: 'dev-a', text: 'looking at it', threadTs: t }); // clears the no-reply timer
    await h.slack.react(t, 'zzz', B);
    assert(h.repliesIn(t).some(x => x.includes('snoozed until')), '💤 snoozes the reminders and says until when');
    await runSlaCheck(h.github, poster, at(2026, 11, 13, 10), cfg);
    assert(count() === 1, 'no reminder while snoozed');
    await runSlaCheck(h.github, poster, at(2026, 11, 16, 10), cfg);
    assert(count() === 2, 'reminders resume after the snooze');
  }
  {
    const h = setup();
    const t = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    h.mock.backdate(1, MON);
    const poster = h.slack.createPoster();
    const label = await runWithAudit({ actorId: A, actorName: 'dev-a', via: 'test' }, () => setIssueEta(h.github, 1, etaEndOfDayMs('2026-11-13', TZ)!));
    assert(label.includes('13 Nov'), 'ETA recorded as Fri 13 Nov');
    assert((await h.mock.getIssueByNumber(1))!.comments!.some(c => c.body.includes('ETA set to')), 'the ETA is written to the issue as an audit comment');
    await runSlaCheck(h.github, poster, at(2026, 11, 12, 10), cfg);
    assert(h.repliesIn(t).filter(x => started(x) || x.includes('ETA')).length === 0, 'issue is well past 18 h, but the ETA keeps it quiet');
    await runSlaCheck(h.github, poster, at(2026, 11, 16, 10), cfg);
    const etaMsgs = h.repliesIn(t).filter(x => x.includes('ETA') && x.includes('has passed'));
    assert(etaMsgs.length === 1 && etaMsgs[0].includes(`<@${A}>`), 'after the ETA passes → ONE "ETA has passed" nudge');
    await runSlaCheck(h.github, poster, at(2026, 11, 16, 11), cfg);
    assert(h.repliesIn(t).filter(x => x.includes('has passed')).length === 1, 'the ETA nudge is not repeated');
  }

  banner('N6. Assignee out of office → the clock pauses');
  {
    const h = setup();
    const t = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    h.mock.backdate(1, MON);
    const poster = h.slack.createPoster();
    h.slack.setProfile(A, { statusText: `OOO till ${dateLabel(30)}` });
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 10), cfg);
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 11), cfg);
    assert(h.repliesIn(t).filter(started).length === 0, 'assignee is OOO → no reminders');
    assert(store.getSlaState(1)!.pausedHours === 1, 'the hour they were away is recorded as paused time');
    h.clearOoo();
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 11, 30), cfg);
    assert(h.repliesIn(t).filter(started).length === 1, 'back at work → reminders resume (19.5 h − 1 h paused = 18.5 h ≥ 18 h)');
  }

  banner('N7. Daily digest "Needs attention", cleanup on close, and the board as source of truth');
  {
    const h = setup();
    await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    h.mock.backdate(1, MON);
    const lines = await slaAttentionLines(h.github, at(2026, 11, 11, 10), cfg);
    assert(lines.length === 1 && lines[0].includes('#1') && lines[0].includes('not started') && lines[0].includes('dev-a'), '"Needs attention" lists the stuck issue with its assignee and reason');
    await h.github.updateIssueStatus(1, 'blocked');
    assert((await slaAttentionLines(h.github, at(2026, 11, 11, 10), cfg))[0].includes('blocked'), 'blocked issues are listed (without alerting)');
    const digest = await generateDailyDigest([], 0, [], lines);
    assert(digest.includes('🔔 *Needs attention:*') && digest.includes('#1'), 'the digest message contains the section');
    await runSlaCheck(h.github, h.slack.createPoster(), at(2026, 11, 11, 10), cfg);
    assert(store.getSlaState(1) !== null, 'SLA state is kept while the issue is open');
    h.mock.closeDirectly(1);
    await runSlaCheck(h.github, h.slack.createPoster(), at(2026, 11, 11, 11), cfg);
    assert(store.getSlaState(1) === null, 'closed issue → its SLA state is cleaned up');
  }
  {
    const h = boardHarness();
    const t = await h.slack.sendMessage({ ...REQ, text: '@bot please add a Loki dashboard for the queue' });
    await h.slack.react(t, 'eyes', B); // card → In Progress (no label on the issue)
    h.mock.backdate(1, MON);
    const poster = h.slack.createPoster();
    const repliesIn = (ts: string) => h.slack.capturedReplies.filter(r => r.threadTs === ts).map(r => r.text);
    const reminders = () => repliesIn(t).filter(x => x.includes('no update on') || started(x)).length;
    await runSlaCheck(h.github, poster, at(2026, 11, 11, 10), cfg);
    assert(reminders() === 0, 'the BOARD says In Progress → judged as in-progress (18 h of silence is fine), not as "not started"');
    await runSlaCheck(h.github, poster, at(2026, 11, 12, 10), cfg);
    assert(repliesIn(t).filter(x => x.includes('no update on')).length === 1, '27 working hours of silence on an in-progress card → "no update" nudge');
  }
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  testAvailabilityParsing();
  await testAvailabilityService();
  testChooseAssignee();
  await testOooInBotFlow();
  await testRequesterUpdates();
  await testEscalation();
  await testRepeatRequests();
  await testTimerPersistence();
  await testWeeklyReport();
  await testPriorityChange();
  await testBoardAndMarkers();
  await testFriendlyErrors();
  await testRealRequester();
  await testSla();
  console.log(`\n🎉 ALL ${passed} FEATURE CHECKS PASSED!\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Feature test failed:', err);
  process.exit(1);
});
