import { config } from './config.js';
import * as store from './store.js';
import { logAudit } from './audit.js';
import { classifyRequestTopic } from './llm.js';
import type { GitHubIssue, PostMessageFn } from './types.js';

/**
 * Repeat-request detection.
 *
 * Every created issue is normalised into a short topic slug (e.g. "vpn-access-reset").
 * When the same topic shows up REPEAT_REQUEST_THRESHOLD times (default 3) within
 * REPEAT_REQUEST_WINDOW_DAYS (default 30), the bot posts ONE note in the devops channel
 * suggesting it be automated or documented. A topic is flagged at most once per window.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'please', 'need', 'needs', 'help',
  'issue', 'problem', 'request', 'urgent', 'again', 'still', 'into', 'have', 'has',
]);

/** Deterministic fallback when the LLM is unavailable: first significant words, sorted. */
export function fallbackTopic(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 4).sort();
  return unique.length > 0 ? unique.join('-') : 'misc';
}

export function sanitizeTopic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export type TopicClassifier = (title: string, body: string, knownTopics: string[]) => Promise<string | null>;

export async function recordRequestTopic(
  issue: Pick<GitHubIssue, 'number' | 'title' | 'body' | 'url'>,
  requesterId: string | null,
  channelId: string,
  post: PostMessageFn,
  opts: { nowMs?: number; classifier?: TopicClassifier } = {}
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  const classifier = opts.classifier ?? classifyRequestTopic;
  const windowMs = config.bot.repeatWindowDays * 24 * 60 * 60 * 1000;
  const since = nowMs - windowMs;

  const known = [...new Set(store.listTopicsSince(since).map(t => t.topic))];

  let topic: string | null = null;
  try {
    const raw = await classifier(issue.title, issue.body, known);
    topic = raw ? sanitizeTopic(raw) : null;
  } catch {
    topic = null;
  }
  if (!topic) topic = fallbackTopic(issue.title);

  store.insertTopic({ topic, issueNumber: issue.number, requesterId, createdAt: nowMs });
  logAudit('topic.recorded', { issueNumber: issue.number, detail: topic });

  const matches = store.listTopicsSince(since).filter(t => t.topic === topic);
  const distinctIssues = [...new Set(matches.map(m => m.issueNumber))];
  if (distinctIssues.length < config.bot.repeatThreshold) return;

  const flaggedAt = store.getTopicFlaggedAt(topic);
  if (flaggedAt !== null && flaggedAt > since) return; // already flagged this window

  store.setTopicFlagged(topic, nowMs);
  const requesters = [...new Set(matches.map(m => m.requesterId).filter(Boolean))];
  const text =
    `🔁 *Repeat request spotted* — “${topic.replace(/-/g, ' ')}” has come in *${distinctIssues.length} times* in the last ${config.bot.repeatWindowDays} days ` +
    `(${distinctIssues.map(n => `#${n}`).join(', ')}${requesters.length > 1 ? `, from ${requesters.length} different people` : ''}).\n` +
    `Worth automating or writing a short runbook so it stops coming in as tickets.`;

  await post(channelId, undefined, text);
  logAudit('topic.repeat_flagged', { detail: `${topic}: ${distinctIssues.join(',')}` });
  console.log(`🔁 Repeat topic flagged: ${topic} (${distinctIssues.length}x)`);
}
