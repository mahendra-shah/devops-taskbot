import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite persistence for everything that must survive a restart:
 *   - pending "no reply" timers
 *   - Slack thread ↔ GitHub issue links (+ requester, for closure updates)
 *   - P0 escalation watches
 *   - audit log
 *   - repeat-request topics
 *   - first-seen times of OOO markers (to apply the "no date = that day only" rule)
 *
 * Set STATE_DB_PATH=:memory: for tests.
 */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.STATE_DB_PATH || path.resolve(process.cwd(), 'data', 'devops-tracker.db');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_replies (
      message_ts   TEXT PRIMARY KEY,
      channel_id   TEXT NOT NULL,
      tagged_ids   TEXT NOT NULL,
      fire_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_links (
      issue_number    INTEGER PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      thread_ts       TEXT NOT NULL,
      requester_id    TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      closed_notified INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS p0_watch (
      issue_number  INTEGER PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL,
      assignee_id   TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      level         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      action        TEXT NOT NULL,
      actor         TEXT,
      issue_number  INTEGER,
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

    CREATE TABLE IF NOT EXISTS request_topics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic         TEXT NOT NULL,
      issue_number  INTEGER NOT NULL,
      requester_id  TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_topic ON request_topics(topic, created_at);

    CREATE TABLE IF NOT EXISTS topic_flags (
      topic       TEXT PRIMARY KEY,
      flagged_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ooo_seen (
      user_id       TEXT NOT NULL,
      signature     TEXT NOT NULL,
      first_seen_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, signature)
    );
  `);
  return db;
}

/** Test helper: close and forget the current connection. */
export function resetDbForTests(): void {
  if (db) db.close();
  db = null;
}

// ── Pending no-reply timers ────────────────────────────────────────────────

export interface PendingReplyRow {
  messageTs: string;
  channelId: string;
  taggedIds: string[];
  fireAt: number;
}

export function savePendingReply(row: PendingReplyRow): void {
  getDb()
    .prepare(
      `INSERT INTO pending_replies (message_ts, channel_id, tagged_ids, fire_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_ts) DO UPDATE SET channel_id=excluded.channel_id,
         tagged_ids=excluded.tagged_ids, fire_at=excluded.fire_at`
    )
    .run(row.messageTs, row.channelId, JSON.stringify(row.taggedIds), row.fireAt);
}

export function deletePendingReply(messageTs: string): void {
  getDb().prepare('DELETE FROM pending_replies WHERE message_ts = ?').run(messageTs);
}

export function listPendingReplies(): PendingReplyRow[] {
  const rows = getDb().prepare('SELECT * FROM pending_replies').all() as any[];
  return rows.map(r => ({
    messageTs: r.message_ts,
    channelId: r.channel_id,
    taggedIds: JSON.parse(r.tagged_ids),
    fireAt: r.fire_at,
  }));
}

// ── Issue ↔ Slack thread links ─────────────────────────────────────────────

export interface IssueLinkRow {
  issueNumber: number;
  channelId: string;
  threadTs: string;
  requesterId: string;
  createdAt: number;
  closedNotified: boolean;
}

function mapLink(r: any): IssueLinkRow {
  return {
    issueNumber: r.issue_number,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    requesterId: r.requester_id,
    createdAt: r.created_at,
    closedNotified: Boolean(r.closed_notified),
  };
}

export function saveIssueLink(link: Omit<IssueLinkRow, 'closedNotified'>): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO issue_links (issue_number, channel_id, thread_ts, requester_id, created_at, closed_notified)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(link.issueNumber, link.channelId, link.threadTs, link.requesterId, link.createdAt);
}

export function getIssueLink(issueNumber: number): IssueLinkRow | null {
  const r = getDb().prepare('SELECT * FROM issue_links WHERE issue_number = ?').get(issueNumber);
  return r ? mapLink(r) : null;
}

export function listIssueLinks(): IssueLinkRow[] {
  return (getDb().prepare('SELECT * FROM issue_links').all() as any[]).map(mapLink);
}

export function setClosedNotified(issueNumber: number, notified: boolean): void {
  getDb()
    .prepare('UPDATE issue_links SET closed_notified = ? WHERE issue_number = ?')
    .run(notified ? 1 : 0, issueNumber);
}

// ── P0 escalation watches ──────────────────────────────────────────────────

export interface P0WatchRow {
  issueNumber: number;
  channelId: string;
  threadTs: string;
  assigneeId: string;
  createdAt: number;
  level: number;
}

function mapWatch(r: any): P0WatchRow {
  return {
    issueNumber: r.issue_number,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    assigneeId: r.assignee_id,
    createdAt: r.created_at,
    level: r.level,
  };
}

export function addP0Watch(w: Omit<P0WatchRow, 'level'>): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO p0_watch (issue_number, channel_id, thread_ts, assignee_id, created_at, level)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(w.issueNumber, w.channelId, w.threadTs, w.assigneeId, w.createdAt);
}

export function listP0Watches(): P0WatchRow[] {
  return (getDb().prepare('SELECT * FROM p0_watch').all() as any[]).map(mapWatch);
}

export function setP0Level(issueNumber: number, level: number): void {
  getDb().prepare('UPDATE p0_watch SET level = ? WHERE issue_number = ?').run(level, issueNumber);
}

export function removeP0Watch(issueNumber: number): boolean {
  return getDb().prepare('DELETE FROM p0_watch WHERE issue_number = ?').run(issueNumber).changes > 0;
}

/** Removes any watch whose Slack thread is `threadTs`. Returns the removed issue numbers. */
export function removeP0WatchByThread(threadTs: string): number[] {
  const rows = getDb().prepare('SELECT issue_number FROM p0_watch WHERE thread_ts = ?').all(threadTs) as any[];
  if (rows.length === 0) return [];
  getDb().prepare('DELETE FROM p0_watch WHERE thread_ts = ?').run(threadTs);
  return rows.map(r => r.issue_number);
}

// ── Audit log ──────────────────────────────────────────────────────────────

export interface AuditRow {
  id: number;
  ts: number;
  action: string;
  actor: string | null;
  issueNumber: number | null;
  detail: string | null;
}

export function insertAudit(entry: {
  action: string;
  actor?: string | null;
  issueNumber?: number | null;
  detail?: string | null;
  ts?: number;
}): void {
  getDb()
    .prepare('INSERT INTO audit_log (ts, action, actor, issue_number, detail) VALUES (?, ?, ?, ?, ?)')
    .run(entry.ts ?? Date.now(), entry.action, entry.actor ?? null, entry.issueNumber ?? null, entry.detail ?? null);
}

export function listAuditSince(sinceMs: number, action?: string): AuditRow[] {
  const rows = (
    action
      ? getDb().prepare('SELECT * FROM audit_log WHERE ts >= ? AND action = ? ORDER BY ts').all(sinceMs, action)
      : getDb().prepare('SELECT * FROM audit_log WHERE ts >= ? ORDER BY ts').all(sinceMs)
  ) as any[];
  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    action: r.action,
    actor: r.actor,
    issueNumber: r.issue_number,
    detail: r.detail,
  }));
}

// ── Repeat-request topics ──────────────────────────────────────────────────

export interface TopicRow {
  topic: string;
  issueNumber: number;
  requesterId: string | null;
  createdAt: number;
}

export function insertTopic(t: TopicRow): void {
  getDb()
    .prepare('INSERT INTO request_topics (topic, issue_number, requester_id, created_at) VALUES (?, ?, ?, ?)')
    .run(t.topic, t.issueNumber, t.requesterId, t.createdAt);
}

export function listTopicsSince(sinceMs: number): TopicRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM request_topics WHERE created_at >= ? ORDER BY created_at')
    .all(sinceMs) as any[];
  return rows.map(r => ({
    topic: r.topic,
    issueNumber: r.issue_number,
    requesterId: r.requester_id,
    createdAt: r.created_at,
  }));
}

export function getTopicFlaggedAt(topic: string): number | null {
  const r = getDb().prepare('SELECT flagged_at FROM topic_flags WHERE topic = ?').get(topic) as any;
  return r ? r.flagged_at : null;
}

export function setTopicFlagged(topic: string, at: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO topic_flags (topic, flagged_at) VALUES (?, ?)')
    .run(topic, at);
}

// ── OOO first-seen tracking ────────────────────────────────────────────────

export function getOooFirstSeen(userId: string, signature: string): number | null {
  const r = getDb()
    .prepare('SELECT first_seen_ms FROM ooo_seen WHERE user_id = ? AND signature = ?')
    .get(userId, signature) as any;
  return r ? r.first_seen_ms : null;
}

export function setOooFirstSeen(userId: string, signature: string, ms: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO ooo_seen (user_id, signature, first_seen_ms) VALUES (?, ?, ?)')
    .run(userId, signature, ms);
}

/** Forget every observation for the user except the given (currently present) signatures. */
export function pruneOooSeen(userId: string, keepSignatures: string[]): void {
  if (keepSignatures.length === 0) {
    getDb().prepare('DELETE FROM ooo_seen WHERE user_id = ?').run(userId);
    return;
  }
  const placeholders = keepSignatures.map(() => '?').join(',');
  getDb()
    .prepare(`DELETE FROM ooo_seen WHERE user_id = ? AND signature NOT IN (${placeholders})`)
    .run(userId, ...keepSignatures);
}
