import cron from 'node-cron';
import { config } from './config.js';
import * as store from './store.js';
import { availabilityService } from './availability.js';
import { auditIssueEvent, logAudit } from './audit.js';
import type { GitHubProvider, PostMessageFn } from './types.js';

/**
 * P0 escalation.
 *
 * When a P0 issue is created, a "watch" is stored. If nobody on the team acknowledges it
 * (👀/✅/🚫 or any reaction, a thread reply, or a status change on GitHub) the bot escalates:
 *
 *   level 1 (default 30 min)  → remind the assignee (or, if they're out, the other available devs)
 *   level 2 (default 60 min)  → tag every available dev
 *   level 3 (default 120 min) → tag every available dev + @here
 *
 * Minutes are configurable with ESCALATION_MINUTES="30,60,120". Out-of-office devs are skipped.
 */

export function watchP0(params: {
  issueNumber: number;
  channelId: string;
  threadTs: string;
  assigneeSlackId: string;
}): void {
  store.addP0Watch({
    issueNumber: params.issueNumber,
    channelId: params.channelId,
    threadTs: params.threadTs,
    assigneeId: params.assigneeSlackId,
    createdAt: Date.now(),
  });
  logAudit('p0.watch_started', {
    issueNumber: params.issueNumber,
    detail: `escalation at ${config.bot.escalationMinutes.join('/')} min if unacknowledged`,
  });
}

/** A team member reacted/replied in this Slack thread → stop escalating. */
export function ackThread(threadTs: string, actorId?: string): number[] {
  const removed = store.removeP0WatchByThread(threadTs);
  for (const n of removed) {
    logAudit('p0.acked', { issueNumber: n, actor: actorId, detail: 'acknowledged in Slack' });
    console.log(`✓ P0 #${n} acknowledged — escalation stopped.`);
  }
  return removed;
}

async function availableTeamIds(): Promise<string[]> {
  const ids = config.team.map(m => m.slackId);
  const avail = await availabilityService.getMany(ids);
  return ids.filter(id => avail.get(id)?.available !== false);
}

/** Who gets pinged at escalation step `index` (0-based). */
async function pickTargets(assigneeId: string, index: number, total: number): Promise<{ ids: string[]; here: boolean }> {
  const available = await availableTeamIds();

  if (available.length === 0) return { ids: [], here: true };

  if (index === 0) {
    if (available.includes(assigneeId)) return { ids: [assigneeId], here: false };
    return { ids: available, here: false }; // assignee is out → straight to whoever is around
  }

  const isFinal = index >= 2 && index === total - 1;
  return { ids: available, here: isFinal };
}

/**
 * One pass over all open watches. Exported for tests (inject `nowMs`).
 */
export async function runEscalationCheck(
  github: GitHubProvider,
  post: PostMessageFn,
  nowMs = Date.now()
): Promise<void> {
  const watches = store.listP0Watches();
  if (watches.length === 0) return;

  const levels = config.bot.escalationMinutes;
  const open = await github.getAllOpenIssues();
  const byNumber = new Map(open.map(i => [i.number, i]));

  for (const w of watches) {
    const issue = byNumber.get(w.issueNumber);

    if (!issue) {
      store.removeP0Watch(w.issueNumber);
      logAudit('p0.resolved', { issueNumber: w.issueNumber, detail: 'issue closed' });
      continue;
    }
    if (issue.labels.includes('in-progress') || issue.labels.includes('blocked')) {
      store.removeP0Watch(w.issueNumber);
      logAudit('p0.acked', { issueNumber: w.issueNumber, detail: 'status moved on GitHub/Slack' });
      continue;
    }

    const elapsedMs = nowMs - w.createdAt;
    let next = w.level;
    if (next >= levels.length) continue; // every level already fired
    if (elapsedMs < levels[next] * 60_000) continue;
    // Bot was down / checks were late: jump to the highest level that is already due (no burst of messages).
    while (next + 1 < levels.length && elapsedMs >= levels[next + 1] * 60_000) next++;

    const { ids, here } = await pickTargets(w.assigneeId, next, levels.length);
    const mentions = [here ? '<!here>' : '', ...ids.map(id => `<@${id}>`)].filter(Boolean).join(' ');
    const minutes = Math.floor(elapsedMs / 60_000);

    const text =
      `🚨 *P0 escalation ${next + 1}/${levels.length}* — <${issue.url}|#${issue.number} ${issue.title}> ` +
      `has had no acknowledgement for *${minutes} min*.\n` +
      `${mentions || ''} please react 👀 here (or reply in this thread) to take it.`;

    try {
      await post(w.channelId, w.threadTs, text);
      store.setP0Level(w.issueNumber, next + 1);
      await auditIssueEvent(
        github,
        w.issueNumber,
        'p0.escalated',
        `P0 escalation ${next + 1}/${levels.length} — no acknowledgement after ${minutes} min`,
        [`**Pinged:** ${ids.length > 0 ? ids.map(id => `\`${id}\``).join(', ') : 'nobody available'}${here ? ' + @here' : ''}`]
      );
      console.log(`🚨 P0 #${w.issueNumber} escalated (level ${next + 1}/${levels.length}).`);
    } catch (err) {
      console.error(`❌ Failed to escalate P0 #${w.issueNumber}:`, err);
    }
  }
}

export function startEscalationChecker(github: GitHubProvider, post: PostMessageFn): void {
  cron.schedule('* * * * *', () => {
    runEscalationCheck(github, post).catch(err => console.error('❌ Escalation check failed:', err));
  });
  console.log(`✓ P0 escalation checker running (levels: ${config.bot.escalationMinutes.join(', ')} min)`);
}
