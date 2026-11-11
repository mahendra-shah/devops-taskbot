process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:'; // tests never touch the real state DB

import nodemailer from 'nodemailer';
import { config } from '../src/config.js';
import { DevOpsBot, type AgentRunner } from '../src/bot.js';
import * as store from '../src/store.js';
import { AuditedGitHubProvider, AUDIT_MARKER, BOT_NOTE_MARKER, runWithAudit } from '../src/audit.js';
import { deriveBoardValues, matchOption, STATUS_PATTERNS, PRIORITY_PATTERNS, type BoardSync } from '../src/projectBoard.js';
import type { GitHubIssue } from '../src/types.js';
import {
  availabilityService,
  evaluateAvailability,
  parseDateRange,
  type SlackProfileInfo,
} from '../src/availability.js';
import { chooseAssignee, composeIssueBody } from '../src/llm.js';
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
  assert(Boolean(audit) && audit!.body.includes('P2 → **P0**') && audit!.body.includes('dev-b'), 'audit comment records P2 → P0 and who did it');

  await runEscalationCheck(github, slack.createPoster(), Date.now() + 31 * 60_000);
  assert(slack.capturedReplies.some(r => r.text.includes('P0 escalation 1/3')), 'the new P0 escalates like any other');

  await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot set priority P1', threadTs: t });
  assert(store.listP0Watches().length === 0 && (await labels()).includes('P1'), 'lowering to P1 stops escalation');

  await slack.sendMessage({ userId: B, userName: 'dev-b', text: '@bot set effort high', threadTs: t });
  l = await labels();
  assert(l.includes('effort:high') && l.filter(x => x.startsWith('effort:')).length === 1, 'effort swapped: exactly one effort label');
}

// ═══════════════════════════════════════════════════════════════════════════
// K. Project board sync, "bot did this" markers, structured issue body
// ═══════════════════════════════════════════════════════════════════════════
async function testBoardAndMarkers() {
  banner('K1. Board values + option matching adapt to whatever your board calls things');
  const opt = (...names: string[]) => names.map((name, i) => ({ id: `o${i}`, name }));
  const statusOf = (names: string[], v: 'open' | 'in-progress' | 'blocked' | 'done') => matchOption(opt(...names), STATUS_PATTERNS[v])?.name;
  const prioOf = (names: string[], v: 'P0' | 'P1' | 'P2') => matchOption(opt(...names), PRIORITY_PATTERNS[v])?.name;

  assert(deriveBoardValues({ state: 'open', labels: ['devops', 'in-progress', 'P1'] }).status === 'in-progress', 'in-progress label → board status in-progress');
  assert(deriveBoardValues({ state: 'closed', labels: ['in-progress'] }).status === 'done', 'closed issue → done (beats stale labels)');
  assert(deriveBoardValues({ state: 'open', labels: ['blocked', 'in-progress'] }).status === 'blocked', 'blocked wins over in-progress');
  assert(deriveBoardValues({ state: 'open', labels: ['devops'] }).priority === null, 'no priority label → nothing to set');

  const std = ['Todo', 'In Progress', 'Done'];
  assert(statusOf(std, 'open') === 'Todo' && statusOf(std, 'in-progress') === 'In Progress' && statusOf(std, 'done') === 'Done', 'standard "Todo / In Progress / Done" board maps correctly');
  const alt = ['Backlog', 'In review', 'Blocked', 'Shipped'];
  assert(statusOf(alt, 'open') === 'Backlog' && statusOf(alt, 'blocked') === 'Blocked' && statusOf(alt, 'done') === 'Shipped', 'custom column names ("Backlog", "Blocked", "Shipped") map too');
  assert(prioOf(['P0', 'P1', 'P2'], 'P0') === 'P0' && prioOf(['P0', 'P1', 'P2'], 'P2') === 'P2', 'priority options named P0/P1/P2');
  const words = ['Critical', 'High', 'Medium', 'Low'];
  assert(prioOf(words, 'P0') === 'Critical' && prioOf(words, 'P1') === 'High' && prioOf(words, 'P2') === 'Medium', 'priority options named Critical/High/Medium/Low');
  assert(statusOf(['Alpha', 'Beta'], 'done') === undefined, 'unrecognised options → no match (bot warns instead of guessing)');

  banner('K2. Every bot change is pushed to the board; comments are not');
  const synced: GitHubIssue[] = [];
  const board: BoardSync = { sync: async issue => void synced.push(issue) };
  store.resetDbForTests();
  const mock = new MockGitHubProvider(false);
  const github = new AuditedGitHubProvider(mock, { board });
  const bot = new DevOpsBot(github, mockAgentRunner, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });

  const t = await slack.sendMessage({ ...REQ, text: '@bot please add a Prometheus alert for pod restarts' });
  assert(synced.length === 1 && synced[0].labels.includes('P2'), 'issue creation → board synced (with its labels)');
  await slack.react(t, 'eyes', B);
  assert(synced.length === 2 && deriveBoardValues(synced[1]).status === 'in-progress', '👀 → board card moves to In Progress');
  await github.updateIssueMeta(1, { priority: 'P0' });
  assert(synced.length === 3 && deriveBoardValues(synced[2]).priority === 'P0', 'priority change → board Priority updated');
  await slack.react(t, 'white_check_mark', B);
  assert(deriveBoardValues(synced[synced.length - 1]).status === 'done', '✅ → board card moves to Done');
  const before = synced.length;
  await github.addIssueComment(1, 'just a note');
  assert(synced.length === before, 'a plain comment does not touch the board');

  banner('K3. "I did it" vs "the bot did it" is visible on the issue');
  const full = (await mock.getIssueByNumber(1))!;
  assert(full.labels.includes('bot-created'), 'issue carries the `bot-created` label');
  assert(full.body.includes('Created by the **DevOps bot** on behalf of **Ananya (Backend)**'), 'issue body footer says the bot created it, and for whom');
  assert(full.comments!.some(c => c.body.startsWith(AUDIT_MARKER)), 'bot status/assignment changes carry the 🤖 audit-trail comment');

  await runWithAudit({ actorId: B, actorName: 'dev-b', via: 'Slack message to @bot' }, () => github.addIssueComment(1, 'restarted nginx, monitoring'));
  const note = (await mock.getIssueByNumber(1))!.comments!.find(c => c.body.includes('restarted nginx'))!;
  assert(note.body.startsWith(BOT_NOTE_MARKER) && note.body.includes('on behalf of dev-b'), 'a note the bot writes for someone is labelled "posted by the DevOps bot on behalf of dev-b"');
  const prefixed = (await mock.getIssueByNumber(1))!.comments!.filter(c => c.body.includes(BOT_NOTE_MARKER)).length;
  await github.addIssueComment(1, `${AUDIT_MARKER}\n- already marked`);
  assert((await mock.getIssueByNumber(1))!.comments!.filter(c => c.body.includes(BOT_NOTE_MARKER)).length === prefixed, 'audit comments are not double-labelled');

  banner('K4. Issue body always has the requester and the original message');
  const ev = { userName: 'Ananya', text: 'prod deploy failed\nsee https://ci.example/123' };
  let body = composeIssueBody('## Request\nFix the deploy\n\n## Definition of done\n- [ ] green build', ev);
  assert(body.includes('**Requested by:** Ananya') && body.includes('> prod deploy failed') && body.includes('> see https://ci.example/123'), 'requester + quoted original message (all lines) appended');
  assert(body.includes('<details>') && body.includes('## Definition of done'), 'original message is collapsed; LLM sections are kept');
  body = composeIssueBody('Fix it.\n\nRequested by: Ananya', ev);
  assert((body.match(/requested by/gi) || []).length === 1, 'does not duplicate "Requested by" if the LLM already wrote it');
  body = composeIssueBody('', ev);
  assert(body.includes('## Request') && body.includes('prod deploy failed'), 'empty LLM body → falls back to the original message');
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
  console.log(`\n🎉 ALL ${passed} FEATURE CHECKS PASSED!\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Feature test failed:', err);
  process.exit(1);
});
