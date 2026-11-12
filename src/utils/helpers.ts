import type { ThreadMessage } from '../types.js';

/**
 * Formats a Slack-safe mrkdwn message for issue creation confirmation.
 */
export function formatIssueCreatedMessage(
  issueNumber: number,
  issueUrl: string,
  issueTitle: string,
  assigneeGithubUsername: string,
  priority: string,
  estimate: string,
  summary: string
): string {
  const priorityEmoji = priority === 'P0' ? '🚨' : priority === 'P1' ? '🔴' : '🟢';
  const effortEmoji = estimate === 'high' ? '🔴' : estimate === 'medium' ? '🟡' : '🟢';

  return (
    `${priorityEmoji} *New DevOps Task Created!*\n` +
    `*<${issueUrl}|#${issueNumber} — ${escapeSlack(issueTitle)}>*\n` +
    `📝 ${escapeSlack(summary)}\n` +
    `👤 Assigned to: *${assigneeGithubUsername}* | ` +
    `${priorityEmoji} Priority: *${priority}* | ` +
    `${effortEmoji} Effort: *${estimate}*\n\n` +
    `_React with 👀 to mark in-progress, ✅ when done, 🚫 if blocked._`
  );
}

/**
 * Formats the auto-reply when a P0 issue is detected.
 */
export function formatP0Alert(
  issueNumber: number,
  issueUrl: string,
  issueTitle: string,
  assigneeSlackId: string
): string {
  return (
    `🚨 *P0 ALERT — Critical DevOps Issue Detected!*\n` +
    `*<${issueUrl}|#${issueNumber} — ${escapeSlack(issueTitle)}>*\n` +
    `<@${assigneeSlackId}> you've been assigned as the primary responder. ` +
    `Please acknowledge by reacting with 👀 to this message.`
  );
}

/**
 * Formats the reply when a Slack message is classified as a question (not a task).
 */
export function formatQuestionReply(summary: string): string {
  return (
    `🤔 This looks like a *question* rather than an actionable task — no GitHub issue created.\n` +
    `_"${escapeSlack(summary)}"_\n\n` +
    `If this needs to be tracked as a task, please rephrase it as one (e.g., "Please investigate X" or "Fix Y in Z").`
  );
}

/**
 * Formats the emoji reaction → GitHub status update confirmation.
 */
export function formatStatusUpdateMessage(
  issueNumber: number,
  issueUrl: string,
  status: 'open' | 'in-progress' | 'done' | 'blocked',
  reactorSlackId: string
): string {
  const statusMap = {
    'open': { emoji: '📋', label: 'Open' },
    'in-progress': { emoji: '🔄', label: 'In Progress' },
    'done': { emoji: '✅', label: 'Done & Closed' },
    'blocked': { emoji: '🚫', label: 'Blocked' },
  };
  const { emoji, label } = statusMap[status];
  return `${emoji} <@${reactorSlackId}> marked <${issueUrl}|#${issueNumber}> as *${label}* on GitHub.`;
}

/**
 * Splits a long message at paragraph boundaries to stay under Slack's 4000-char limit.
 */
export function splitMessage(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const para of text.split('\n\n')) {
    if ((current + para).length > limit) {
      if (current.trim()) chunks.push(current.trim());
      current = para + '\n\n';
    } else {
      current += para + '\n\n';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Escapes characters that have special meaning in Slack mrkdwn.
 */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Strips Slack mention tags from a message text.
 * "<@U12345>" → ""
 */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/**
 * Extracts all Slack user IDs mentioned in a message.
 */
export function extractMentionedUserIds(text: string): string[] {
  const matches = text.match(/<@([A-Z0-9]+)>/g) || [];
  return matches.map(m => m.replace(/<@|>/g, ''));
}

/**
 * Who actually asked for the work?
 * Inside a thread, the person who wrote the thread's FIRST message is the requester — not whoever
 * later tagged the bot (often a teammate saying "@bot add this to github"). Otherwise it's the sender.
 */
export function resolveRequester(
  event: { userId: string; userName: string; text: string },
  threadHistory: ThreadMessage[],
  threadTs: string
): { id: string; name: string; text: string; fromThreadRoot: boolean } {
  const root = threadHistory.find(m => m.ts === threadTs && m.role === 'user' && m.senderId);
  if (root && root.senderId) {
    return { id: root.senderId, name: root.senderName, text: root.content, fromThreadRoot: true };
  }
  return { id: event.userId, name: event.userName, text: event.text, fromThreadRoot: false };
}

/** Slack markup → readable text for GitHub: <@U1> → @name, <url|label> → label (url). */
export function slackToPlain(text: string, nameOf?: (slackId: string) => string | undefined): string {
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_m, id: string) => `@${nameOf?.(id) ?? 'someone'}`)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
