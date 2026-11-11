import cron from 'node-cron';
import * as store from './store.js';
import { logAudit, AUDIT_MARKER } from './audit.js';
import { summarizeResolution } from './llm.js';
import type { GitHubIssue, GitHubProvider, PostMessageFn } from './types.js';

/**
 * Requester updates.
 *
 * When an issue linked to a Slack request is closed — via ✅, via @bot, or directly on GitHub —
 * the bot replies in the ORIGINAL Slack thread and tags the person who asked.
 *
 * Closures from Slack call notifyRequesterOfClosure() right away. Closures made directly on GitHub
 * are picked up by a short poll (no public webhook URL is needed with Socket Mode).
 * `closed_notified` in SQLite guarantees one message per closure; reopening resets it.
 */

const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;

function fallbackSummary(issue: GitHubIssue): string {
  const humanComments = (issue.comments || []).filter(c => !c.body.startsWith(AUDIT_MARKER));
  const last = humanComments[humanComments.length - 1];
  if (last) return last.body.replace(/\s+/g, ' ').slice(0, 220);
  return 'Marked as done.';
}

export async function notifyRequesterOfClosure(
  issueNumber: number,
  github: GitHubProvider,
  post: PostMessageFn,
  closedBy?: { id?: string; name?: string }
): Promise<boolean> {
  const link = store.getIssueLink(issueNumber);
  if (!link || link.closedNotified) return false;

  // Re-read with comments so the summary reflects what was actually done.
  const issue = await github.getIssueByNumber(issueNumber);
  if (!issue || issue.state !== 'closed') return false;

  // Claim it first so two concurrent paths (reaction + poll) can't both announce.
  store.setClosedNotified(issueNumber, true);

  if (closedBy?.id && closedBy.id === link.requesterId) return false; // they closed their own request

  let summary: string;
  try {
    summary = (await summarizeResolution(issue)) || fallbackSummary(issue);
  } catch {
    summary = fallbackSummary(issue);
  }

  const assignee = issue.assignees[0];
  const by = closedBy?.id ? ` by <@${closedBy.id}>` : assignee ? ` (handled by *${assignee}*)` : '';
  const text =
    `✅ <@${link.requesterId}> your request is resolved — <${issue.url}|#${issue.number} ${issue.title}> was closed${by}.\n` +
    `_${summary}_`;

  try {
    await post(link.channelId, link.threadTs, text);
    logAudit('requester.notified', {
      issueNumber,
      actor: closedBy?.id,
      detail: `told ${link.requesterId} in thread ${link.threadTs}`,
    });
    return true;
  } catch (err) {
    store.setClosedNotified(issueNumber, false); // retry on the next poll
    console.error(`❌ Could not notify requester for #${issueNumber}:`, err);
    return false;
  }
}

/** One poll pass: catches closures made directly on GitHub, and resets the flag on reopen. */
export async function runClosurePoll(github: GitHubProvider, post: PostMessageFn, nowMs = Date.now()): Promise<void> {
  const links = store.listIssueLinks();
  if (links.length === 0) return;

  const open = new Set((await github.getAllOpenIssues()).map(i => i.number));

  for (const link of links) {
    if (open.has(link.issueNumber)) {
      if (link.closedNotified) store.setClosedNotified(link.issueNumber, false); // reopened
      continue;
    }
    if (link.closedNotified) continue;

    const issue = await github.getIssueByNumber(link.issueNumber);
    if (!issue || issue.state !== 'closed') continue;

    // Closed long ago (e.g. bot was off): don't announce stale news.
    const closedAt = issue.closedAt ? new Date(issue.closedAt).getTime() : nowMs;
    if (nowMs - closedAt > MAX_STALE_MS) {
      store.setClosedNotified(link.issueNumber, true);
      continue;
    }
    await notifyRequesterOfClosure(link.issueNumber, github, post);
  }
}

export function startClosurePoller(github: GitHubProvider, post: PostMessageFn): void {
  cron.schedule('*/2 * * * *', () => {
    runClosurePoll(github, post).catch(err => console.error('❌ Closure poll failed:', err));
  });
  console.log('✓ Requester closure poller running (every 2 min)');
}
