import { AsyncLocalStorage } from 'node:async_hooks';
import * as store from './store.js';
import {
  PRIORITIES,
  PRIORITY_NAMES,
  type GitHubIssue,
  type GitHubProvider,
  type IssueStatus,
  type ParsedTask,
  type Priority,
} from './types.js';
import { overlayIssue, type BoardSync } from './projectBoard.js';

/**
 * Audit trail + board sync, as a decorator around the GitHub provider.
 *
 * Every state change the bot makes is (a) written to the SQLite `audit_log`, (b) posted as a short comment
 * on the GitHub issue, and (c) pushed to the GitHub Projects board (Status / Priority / Effort fields).
 * Reads are overlaid with the board's values, so the board is the source of truth.
 *
 * "Who" and "via what" are carried in AsyncLocalStorage so no function signatures change:
 * bot.ts wraps each Slack event in runWithAudit({...}); this class reads it.
 */

export interface AuditContext {
  /** Who tagged the bot (the person acting right now). */
  actorId?: string;
  actorName?: string;
  /** e.g. "Slack message to @bot", "emoji reaction :eyes:", "GitHub (closed directly)" */
  via: string;
  /** Free-text reasoning set by the code that made a decision (e.g. why this assignee was picked). */
  assignmentNote?: string;
  /** Who originally ASKED for the work (the thread's first message), which can differ from the actor. */
  requesterId?: string;
  requesterName?: string;
  /** Estimated hours chosen when creating an issue (goes to the board's Estimate field). */
  estimateHours?: number;
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

/** Record who originally asked for the work (may differ from who tagged the bot). */
export function setRequester(id: string, name: string): void {
  const ctx = als.getStore();
  if (ctx) {
    ctx.requesterId = id;
    ctx.requesterName = name;
  }
}

export function setIssueExtras(extras: { estimateHours?: number }): void {
  const ctx = als.getStore();
  if (ctx && extras.estimateHours !== undefined) ctx.estimateHours = extras.estimateHours;
}

// Everything the bot does on GitHub is made with a human's token, so it shows up under that person's name.
// These markers make bot actions recognisable. (Legacy markers from before the "Taskbot" rename still count.)
export const AUDIT_MARKER = '🤖 **DevOps Taskbot — audit trail**';
const LEGACY_AUDIT_MARKERS = ['🤖 **DevOps Tracker — audit trail**'];
export const BOT_NOTE_MARKER = '🤖 _Posted by the DevOps Taskbot';
const LEGACY_NOTE_MARKERS = ['🤖 _Posted by the DevOps bot'];

export function isAuditComment(body: string): boolean {
  return [AUDIT_MARKER, ...LEGACY_AUDIT_MARKERS].some(m => body.startsWith(m));
}
export function isBotNote(body: string): boolean {
  return [BOT_NOTE_MARKER, ...LEGACY_NOTE_MARKERS].some(m => body.startsWith(m));
}

function actorLabel(ctx?: AuditContext): string {
  return ctx?.actorName || ctx?.actorId || 'a teammate';
}

function requesterLabel(ctx?: AuditContext): string {
  return ctx?.requesterName || ctx?.actorName || ctx?.actorId || 'a teammate';
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
  open: 'Todo (backlog / reopened)',
  'in-progress': 'In Progress',
  done: 'Done (closed)',
  blocked: 'Blocked',
};

const priorityOf = (issue: GitHubIssue | null): Priority | undefined => PRIORITIES.find(p => issue?.labels.includes(p));

export class AuditedGitHubProvider implements GitHubProvider {
  private warnedOverlay = false;

  constructor(
    private readonly inner: GitHubProvider,
    private readonly opts: { board?: BoardSync } = {}
  ) {}

  get isMock(): boolean {
    return this.inner.isMock;
  }

  /** The board, only when it's configured. */
  private get board(): BoardSync | undefined {
    return this.opts.board?.enabled ? this.opts.board : undefined;
  }

  /** Overlay the board's Status/Priority/Effort onto issues (board = source of truth); labels are the fallback. */
  private async overlay(issues: GitHubIssue[]): Promise<GitHubIssue[]> {
    const board = this.board;
    if (!board?.snapshot || issues.length === 0) return issues;
    try {
      const snap = await board.snapshot();
      return issues.map(i => overlayIssue(i, snap.items.get(i.number), snap.supportsBlocked));
    } catch (err) {
      if (!this.warnedOverlay) {
        this.warnedOverlay = true;
        console.warn(`⚠️ Could not read the project board — using labels instead: ${(err as Error).message}`);
      }
      return issues;
    }
  }

  private async overlayOne(issue: GitHubIssue | null): Promise<GitHubIssue | null> {
    if (!issue) return null;
    return (await this.overlay([issue]))[0];
  }

  ensureLabelsExist() { return this.inner.ensureLabelsExist(); }
  countClosedYesterday() { return this.inner.countClosedYesterday(); }
  addIssueLabel(n: number, l: string) { return this.inner.addIssueLabel(n, l); }
  async getIssueByNumber(n: number) { return this.overlayOne(await this.inner.getIssueByNumber(n)); }
  async getOpenIssuesForUser(u: string) { return this.overlay(await this.inner.getOpenIssuesForUser(u)); }
  async getAllOpenIssues() { return this.overlay(await this.inner.getAllOpenIssues()); }
  async findIssueBySlackTs(ts: string) { return this.overlayOne(await this.inner.findIssueBySlackTs(ts)); }
  async findSimilarOpenIssue(t: string) { return this.overlayOne(await this.inner.findSimilarOpenIssue(t)); }
  async getClosedSince(sinceIso: string) { return this.overlay(await this.inner.getClosedSince(sinceIso)); }

  async createIssue(
    task: Pick<ParsedTask, 'title' | 'body' | 'priority' | 'estimate'>,
    assigneeGithubUsername: string,
    slackMessageTs: string,
    slackChannelId: string
  ): Promise<GitHubIssue> {
    const ctx = als.getStore();
    const footer = `\n\n> 🤖 Created by the **DevOps Taskbot** at the request of **${requesterLabel(ctx)}** via Slack.`;
    let issue = await this.inner.createIssue({ ...task, body: task.body + footer }, assigneeGithubUsername, slackMessageTs, slackChannelId);

    logAudit('issue.created', {
      issueNumber: issue.number,
      detail: `assigned to ${assigneeGithubUsername}; ${PRIORITY_NAMES[task.priority]}/${task.estimate}; via ${ctx?.via ?? 'bot'}`,
    });
    const requesterIsActor = !ctx?.requesterId || ctx.requesterId === ctx.actorId;
    const lines = [
      `**Action:** created and assigned to **${assigneeGithubUsername}**`,
      requesterIsActor
        ? `**Requested by:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`
        : `**Requested by:** ${ctx!.requesterName} (Slack \`${ctx!.requesterId}\`) — original message in the thread`,
      ...(requesterIsActor ? [] : [`**Asked the bot to log it:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`]),
      `**Priority / effort:** ${PRIORITY_NAMES[task.priority]} / ${task.estimate}${ctx?.estimateHours !== undefined ? ` (~${ctx.estimateHours} h)` : ''}`,
    ];
    if (ctx?.assignmentNote) lines.push(`**Why this assignee:** ${ctx.assignmentNote}`);
    await postAuditComment(this.inner, issue.number, lines);

    const board = this.board;
    if (board) {
      const res = await board.apply(issue, {
        status: 'open',
        priority: task.priority,
        effort: task.estimate,
        estimateHours: ctx?.estimateHours,
      });
      if (!res.priority) {
        // Board couldn't take the priority → keep it visible as a label instead of losing it.
        await this.inner.addIssueLabel(issue.number, task.priority).catch(() => {});
        issue = { ...issue, labels: [...issue.labels, task.priority] };
      }
    }
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

    const board = this.board;
    if (!board) return updated;
    const res = await board.apply(updated, { status });
    if (!res.status && (status === 'in-progress' || status === 'blocked')) {
      // e.g. the board has no "Blocked" column, or the update failed → fall back to a label.
      await this.inner.addIssueLabel(issueNumber, status).catch(() => {});
      return { ...updated, labels: [...updated.labels, status] };
    }
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
    meta: { priority?: Priority; estimate?: 'low' | 'medium' | 'high' }
  ): Promise<GitHubIssue | null> {
    const before = await this.getIssueByNumber(issueNumber); // overlaid, so "before" reflects the board
    const updated = await this.inner.updateIssueMeta(issueNumber, meta);
    if (!updated) return null;
    const ctx = als.getStore();
    const lines: string[] = [];
    const beforePriority = priorityOf(before);
    if (meta.priority) lines.push(`**Priority:** ${beforePriority ? PRIORITY_NAMES[beforePriority] : 'none'} → **${PRIORITY_NAMES[meta.priority]}**`);
    const beforeEffort = before?.labels.find(l => l.startsWith('effort:'))?.replace('effort:', '') ?? 'none';
    if (meta.estimate) lines.push(`**Effort:** ${beforeEffort} → **${meta.estimate}**`);
    logAudit('issue.meta', { issueNumber, detail: `${lines.join('; ').replace(/\*/g, '')}; via ${ctx?.via ?? 'bot'}` });
    await postAuditComment(this.inner, issueNumber, [...lines, `**By:** ${who(ctx)}${ctx?.via ? ` — ${ctx.via}` : ''}`]);

    const board = this.board;
    if (!board) return updated;
    const res = await board.apply(updated, { priority: meta.priority, effort: meta.estimate });
    if (meta.priority && !res.priority) {
      await this.inner.addIssueLabel(issueNumber, meta.priority).catch(() => {});
      return { ...updated, labels: [...updated.labels, meta.priority] };
    }
    return updated;
  }

  async addIssueComment(issueNumber: number, comment: string): Promise<void> {
    if (isAuditComment(comment) || isBotNote(comment)) {
      await this.inner.addIssueComment(issueNumber, comment);
      return;
    }
    // A note the bot writes on someone's behalf: label it so it isn't mistaken for the person's own comment.
    const ctx = als.getStore();
    await this.inner.addIssueComment(issueNumber, `${BOT_NOTE_MARKER} on behalf of ${actorLabel(ctx)}_\n\n${comment}`);
    logAudit('issue.comment', { issueNumber, detail: comment.slice(0, 200) });
  }
}
