import {
  EFFORT_PATTERNS,
  PRIORITY_PATTERNS,
  STATUS_PATTERNS,
  effortFromName,
  priorityFromName,
  statusFromName,
  type BoardApplyResult,
  type BoardDesired,
  type BoardFields,
  type BoardSnapshot,
  type BoardSync,
} from '../src/projectBoard.js';
import type { GitHubIssue } from '../src/types.js';

interface Card {
  status?: string;
  priority?: string;
  effort?: string;
  hours?: number;
}

/**
 * In-memory stand-in for a GitHub Projects board, configured like the real "DevOps queries" board:
 * Status = Todo / In Progress / Done (no Blocked column), Priority = Urgent / High / Medium / Low.
 */
export class FakeBoard implements BoardSync {
  enabled = true;
  statusOptions = ['Todo', 'In Progress', 'Done'];
  priorityOptions = ['Urgent', 'High', 'Medium', 'Low'];
  hasEstimateField = true;
  /** Simulates the GitHub API being down / token missing the `project` scope. */
  failing = false;
  cards = new Map<number, Card>();
  applyCalls: { issue: number; desired: BoardDesired }[] = [];

  async apply(issue: GitHubIssue, desired: BoardDesired): Promise<BoardApplyResult> {
    this.applyCalls.push({ issue: issue.number, desired });
    const res: BoardApplyResult = { ok: false, status: false, priority: false, effort: false, hours: false };
    if (this.failing) return res;

    const card = this.cards.get(issue.number) ?? {};
    if (desired.status) {
      const o = this.statusOptions.find(n => STATUS_PATTERNS[desired.status!].test(n));
      if (o) {
        card.status = o;
        res.status = true;
      }
    }
    if (desired.priority) {
      const o = this.priorityOptions.find(n => PRIORITY_PATTERNS[desired.priority!].test(n));
      if (o) {
        card.priority = o;
        res.priority = true;
      }
    }
    if (desired.effort && EFFORT_PATTERNS[desired.effort]) {
      card.effort = desired.effort;
      res.effort = true;
    }
    if (desired.estimateHours !== undefined && this.hasEstimateField) {
      card.hours = desired.estimateHours;
      res.hours = true;
    }
    this.cards.set(issue.number, card);
    res.ok = true;
    return res;
  }

  async snapshot(): Promise<BoardSnapshot> {
    if (this.failing) throw new Error('board unavailable');
    const items = new Map<number, BoardFields>();
    for (const [n, c] of this.cards) {
      items.set(n, {
        status: c.status ? statusFromName(c.status) : undefined,
        priority: c.priority ? priorityFromName(c.priority) : undefined,
        effort: c.effort ? effortFromName(c.effort) : undefined,
        estimateHours: c.hours,
      });
    }
    return { items, supportsBlocked: this.statusOptions.some(o => STATUS_PATTERNS.blocked.test(o)) };
  }

  /** A human drags the card / edits a field directly on the board. */
  humanSet(issueNumber: number, patch: Card): void {
    this.cards.set(issueNumber, { ...(this.cards.get(issueNumber) ?? {}), ...patch });
  }
}
