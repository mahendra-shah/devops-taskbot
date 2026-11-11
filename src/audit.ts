import { AsyncLocalStorage } from 'node:async_hooks';
import * as store from './store.js';
import type { GitHubIssue, GitHubProvider, IssueStatus, ParsedTask } from './types.js';
import type { BoardSync } from './projectBoard.js';

/**
 * Audit trail.
 *
 * Every state change the bot makes is (a) written to the SQLite `audit_log` and
 * (b) posted as a short comment on the GitHub issue, so anyone opening the issue can see
 * who/what changed it and why.
 *
 * "Who" and "via what" are carried in AsyncLocalStorage so no function signatures change:
 * bot.ts wraps each Slack event in runWithAudit({...}); the AuditedGitHubProvider reads it.
 */

export interface AuditContext {
  actorId?: string;
  actorName?: string;
  /** e.g. "Slack message to @bot", "emoji reaction :eyes:", "GitHub (closed directly)" */
  via: string;
  /** Free-text reasoning set by the code that made a decision (e.g. why this assignee was picked). */
  assignmentNote?: string;
}

const als = new AsyncLocalStorage<AuditContext>();

export function runWithAudit<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...ctx }, fn);
}

export function currentAudit(): AuditContext | undefined {
  return als.getStore();
}

/** Record why an assignee was chosen; picked up when the issue is created. */
export function setAssignmentNote(note: string): void {
  const ctx = als.getStore();
  if (ctx) ctx.assignmentNote = note;
}

export const AUDIT_MARKER = '🤖 **DevOps Tracker — audit trail**';

/**
 * Everything the bot does on GitHub is made with a human's token, so it shows up under that person's name.
 * These markers make bot actions recognisable: audit comments, "posted by the bot" comments, the body footer
 * and the `bot-created` label. Anything WITHOUT a marker was done by a human directly on GitHub.
 */
export const BOT_NOTE_MARKER = '🤖 _Posted by the DevOps bot';

function actorLabel(ctx?: AuditContext): string {
  return ctx?.actorName || ctx?.actorId || 'a teammate';
}

function who(ctx?: AuditContext): string {
  if (!ctx?.actorId && !ctx?.actorName) return 'the bot (automatic)';
  const name = ctx.actorName || ctx.actorId;
  return ctx.actorId && ctx.actorName ? `${name} (Slack \`${ctx.actorId}\`)` : String(name);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** DB-only audit record. */
export function logAudit(action: string, opts: { issueNumber?: number; actor?: string; detail?: string } = {}): void {
  try {
    const ctx = als.getStore();
    store.insertAudit({
      action,
      actor: opts.actor ?? ctx?.actorId ?? null,
      issueNumber: opts.issueNumber ?? null,
      detail: opts.detail ?? null,
    });
  } catch (err) {
    console.warn('⚠️ Failed to write audit log:', (err as Error).message);
  }
}

/** Audit comment on a GitHub issue (best effort — never throws). */
export async function postAuditComment(github: GitHubProvider, issueNumber: number, lines: string[]): Promise<void> {
  const body = [AUDIT_MARKER, ...lines.map(l => `- ${l}`), `- **Time:** ${timestamp()}`].join('\n');
  try {
    await github.addIssueComment(issueNumber, body);
  } catch (err) {
    console.warn(`⚠️ Could not post audit comment on #${issueNumber}:`, (err as Error).message);
  }
}

/** DB record + GitHub comment in one go (used by escalation, closure updates, repeat detection, …). */
export async function auditIssueEvent(
  github: GitHubProvider,
  issueNumber: number,
  action: string,
  summary: string,
  extraLines: string[] = []
): Promise<void> {
  logAudit(action, { issueNumber, detail: summary });
  await postAuditComment(github, issueNumber, [`**Action:** ${summary}`, ...extraLines]);
}

const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'open (backlog / reopened)',
  'in-progress': 'in progress',
  done: 'done (closed)',
  blocked: 'blocked',
};

/**
 * Decorator: delegates to the real provider and audits every mutation.
 */
export class AuditedGitHubProvider implements GitHubProvider {
  constructor(
    private readonly inner: GitHubProvider,
    private readonly opts: { board?: BoardSync } = {}
  ) {}

  private async syncBoard(issue: GitHubIssue | null): Promise<void> {
    if (!issue || !this.opts.board) return;
    await this.opts.board.sync(issue); // best effort; the board implementation never throws
  }

  get isMock(): boolean {
    return this.inner.isMock;
  }

  ensureLabelsExist() { return this.inner.ensureLabelsExist(); }
  getIssueByNumber(n: number) { return this.inner.getIssueByNumber(n); }
  getOpenIssuesForUser(u: string) { return this.inner.getOpenIssuesForUser(u); }
  getAllOpenIssues() { return this.inner.getAllOpenIssues(); }
  findIssueBySlackTs(ts: string) { return this.inner.findIssueBySlackTs(ts); }
  findSimilarOpenIssue(t: string) { return this.inner.findSimilarOpenIssue(t); }
  countClosedYesterday() { return this.inner.countClosedYesterday(); }
  getClosedSince(sinceIso: string) { return this.inner.getClosedSince(sinceIso); }
  addIssueLabel(n: number, l: string) { return this.inner.addIssueLabel(n, l); }

  async createIssue(
    task: Pick<ParsedTask, 'title' | 'body' | 'priority' | 'estimate'>,
    assigneeGithubUsername: string,
    slackMessageTs: string,
    slackChannelId: string
  ): Promise<GitHubIssue> {
    const ctxForBody = als.getStore();
    const footer = `\n\n> 🤖 Created by the **DevOps bot** on behalf of **${actorLabel(ctxForBody)}** via Slack.`;
    const issue = await this.inner.createIssue({ ...task, body: task.body + footer }, assigneeGithubUsername, slackMessageTs, slackChannelId);
    const ctx = als.getStore();
    logAudit('issue.created', {
      issueNumber: issue.number,
      detail: `assigned to ${assigneeGithubUsername}; ${task.priority}/${task.estimate}; via ${ctx?.via ?? 'bot'}`,
    });
    const lines = [
      `**Action:** created and assigned to **${assigneeGithubUsername}**`,
      `**Requested by:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`,
      `**Priority / effort:** ${task.priority} / ${task.estimate}`,
    ];
    if (ctx?.assignmentNote) lines.push(`**Why this assignee:** ${ctx.assignmentNote}`);
    await postAuditComment(this.inner, issue.number, lines);
    await this.syncBoard(issue);
    return issue;
  }

  async updateIssueStatus(issueNumber: number, status: IssueStatus): Promise<GitHubIssue | null> {
    const updated = await this.inner.updateIssueStatus(issueNumber, status);
    if (!updated) return null;
    const ctx = als.getStore();
    logAudit('issue.status', { issueNumber, detail: `${status}; via ${ctx?.via ?? 'bot'}` });
    await postAuditComment(this.inner, issueNumber, [
      `**Action:** status → **${STATUS_LABEL[status]}**`,
      `**By:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`,
    ]);
    await this.syncBoard(updated);
    return updated;
  }

  async reassignIssue(issueNumber: number, newAssignee: string): Promise<GitHubIssue | null> {
    const before = await this.inner.getIssueByNumber(issueNumber);
    const updated = await this.inner.reassignIssue(issueNumber, newAssignee);
    if (!updated) return null;
    const ctx = als.getStore();
    const prev = before?.assignees.join(', ') || 'unassigned';
    logAudit('issue.reassigned', { issueNumber, detail: `${prev} → ${newAssignee}; via ${ctx?.via ?? 'bot'}` });
    await postAuditComment(this.inner, issueNumber, [
      `**Action:** reassigned **${prev}** → **${newAssignee}**`,
      `**By:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`,
    ]);
    return updated;
  }

  async updateIssueMeta(
    issueNumber: number,
    meta: { priority?: 'P0' | 'P1' | 'P2'; estimate?: 'low' | 'medium' | 'high' }
  ): Promise<GitHubIssue | null> {
    const before = await this.inner.getIssueByNumber(issueNumber);
    const updated = await this.inner.updateIssueMeta(issueNumber, meta);
    if (!updated) return null;
    const ctx = als.getStore();
    const pick = (i: GitHubIssue | null, test: (l: string) => boolean) => i?.labels.find(test) ?? 'none';
    const lines: string[] = [];
    if (meta.priority) lines.push(`**Priority:** ${pick(before, l => /^P[012]$/.test(l))} → **${meta.priority}**`);
    if (meta.estimate) lines.push(`**Effort:** ${pick(before, l => l.startsWith('effort:')).replace('effort:', '')} → **${meta.estimate}**`);
    logAudit('issue.meta', { issueNumber, detail: `${lines.join('; ').replace(/\*/g, '')}; via ${ctx?.via ?? 'bot'}` });
    await postAuditComment(this.inner, issueNumber, [...lines, `**By:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`]);
    await this.syncBoard(updated);
    return updated;
  }

  async addIssueComment(issueNumber: number, comment: string): Promise<void> {
    if (comment.startsWith(AUDIT_MARKER) || comment.startsWith(BOT_NOTE_MARKER)) {
      await this.inner.addIssueComment(issueNumber, comment);
      return;
    }
    // A note the bot writes on someone's behalf: label it so it isn't mistaken for the person's own comment.
    const ctx = als.getStore();
    await this.inner.addIssueComment(issueNumber, `${BOT_NOTE_MARKER} on behalf of ${actorLabel(ctx)}_\n\n${comment}`);
    logAudit('issue.comment', { issueNumber, detail: comment.slice(0, 200) });
  }
}
