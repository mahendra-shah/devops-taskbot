import { Octokit } from '@octokit/rest';
import { config } from './config.js';
import { PRIORITIES, type GitHubIssue, type Priority } from './types.js';

/**
 * GitHub Projects (v2) board = source of truth for Status, Priority and Effort.
 *
 *   • WRITES: after every change the bot makes, the issue's card gets the matching Status / Priority /
 *     Effort field (no `in-progress` / `P1` labels are needed — they stay off the issue).
 *   • READS:  the bot reads the cards back (cached ~20 s), so a card dragged to "In Progress" on the board
 *     is respected by the bot, the digest, `@bot status`, escalation, etc.
 *   • FALLBACK: if a value can't be written (no matching column such as "Blocked", missing token scope,
 *     API error) the bot falls back to a label so nothing is lost.
 *
 * Needs GITHUB_PROJECT_NUMBER and a token with the `project` scope. Option names are discovered from your
 * board (Todo / In Progress / Done, Urgent / High / Medium / Low …) — nothing is hard-coded.
 */

export type BoardStatus = 'open' | 'in-progress' | 'blocked' | 'done';
export type Effort = 'low' | 'medium' | 'high';

export interface BoardDesired {
  status?: BoardStatus;
  priority?: Priority;
  effort?: Effort;
  estimateHours?: number;
}

/** Which of the requested values were actually written to the board. */
export interface BoardApplyResult {
  ok: boolean;
  status: boolean;
  priority: boolean;
  effort: boolean;
  hours: boolean;
}

export interface BoardFields {
  status?: BoardStatus;
  priority?: Priority;
  effort?: Effort;
  estimateHours?: number;
}

export interface BoardSnapshot {
  items: Map<number, BoardFields>;
  /** True when the board has a column that can represent "blocked". */
  supportsBlocked: boolean;
}

export interface BoardSync {
  readonly enabled: boolean;
  apply(issue: GitHubIssue, desired: BoardDesired): Promise<BoardApplyResult>;
  snapshot?(): Promise<BoardSnapshot>;
}

// ── name ⇄ value matching ──────────────────────────────────────────────────

export const STATUS_PATTERNS: Record<BoardStatus, RegExp> = {
  open: /^(todo|to do|to-do|backlog|open|new|triage|ready)/i,
  'in-progress': /(progress|doing|started|active|wip)/i,
  blocked: /block|hold|waiting/i,
  done: /(done|complete|closed|shipped|resolved)/i,
};

export const PRIORITY_PATTERNS: Record<Priority, RegExp> = {
  P0: /\bp0\b|critical|urgent|highest|blocker/i,
  P1: /\bp1\b|^high$/i,
  P2: /\bp2\b|^(medium|normal|med)$/i,
  P3: /\bp3\b|^low$|minor|trivial/i,
};

export const EFFORT_PATTERNS: Record<Effort, RegExp> = {
  low: /^(low|small|xs|s|easy|quick)\b/i,
  medium: /^(medium|med|m)\b/i,
  high: /^(high|large|big|l|xl|hard)\b/i,
};

export interface FieldOption {
  id: string;
  name: string;
}

export function matchOption(options: FieldOption[], pattern: RegExp): FieldOption | null {
  return options.find(o => pattern.test(o.name.trim())) ?? null;
}

const STATUS_ORDER: BoardStatus[] = ['blocked', 'in-progress', 'done', 'open'];

export function statusFromName(name: string): BoardStatus | undefined {
  return STATUS_ORDER.find(s => STATUS_PATTERNS[s].test(name.trim()));
}
export function priorityFromName(name: string): Priority | undefined {
  return PRIORITIES.find(p => PRIORITY_PATTERNS[p].test(name.trim()));
}
export function effortFromName(name: string): Effort | undefined {
  return (['low', 'medium', 'high'] as Effort[]).find(e => EFFORT_PATTERNS[e].test(name.trim()));
}

const EFFORT_FIELD_RE = /^(effort|size|complexity)$/i;
const HOURS_FIELD_RE = /^(estimate|estimated hours|hours|estimate \(?hours?\)?|effort \(?hours?\)?|time estimate)$/i;

/**
 * Applies board values on top of an issue's labels so the rest of the bot (which reasons about labels)
 * sees the board's truth. Labels stay as the fallback where the board has no value.
 */
export function overlayIssue(issue: GitHubIssue, fields: BoardFields | undefined, supportsBlocked: boolean): GitHubIssue {
  if (!fields) return issue;
  let labels = [...issue.labels];
  if (fields.status) {
    labels = labels.filter(l => l !== 'in-progress' && !(supportsBlocked && l === 'blocked'));
    if (fields.status === 'in-progress') labels.push('in-progress');
    if (fields.status === 'blocked' && !labels.includes('blocked')) labels.push('blocked');
  }
  if (fields.priority) {
    labels = labels.filter(l => !PRIORITIES.includes(l as Priority));
    labels.push(fields.priority);
  }
  if (fields.effort) {
    labels = labels.filter(l => !l.startsWith('effort:'));
    labels.push(`effort:${fields.effort}`);
  }
  return { ...issue, labels };
}

// ── GitHub GraphQL implementation ──────────────────────────────────────────

interface SelectField {
  id: string;
  name: string;
  options: FieldOption[];
}

interface ProjectMeta {
  projectId: string;
  status: SelectField | null;
  priority: SelectField | null;
  effort: SelectField | null;
  hours: { id: string; name: string } | null;
  loadedAt: number;
}

const META_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_TTL_MS = 20 * 1000;

const FIELDS_FRAGMENT = `
  id
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name dataType }
    }
  }`;

export class ProjectBoard implements BoardSync {
  private octokit = new Octokit({ auth: config.github.token });
  private meta: ProjectMeta | null = null;
  private snap: { at: number; value: BoardSnapshot } | null = null;
  private warned = new Set<string>();

  get enabled(): boolean {
    return config.github.project.number > 0;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`⚠️ Project board: ${message}`);
  }

  private async loadMeta(): Promise<ProjectMeta> {
    if (this.meta && Date.now() - this.meta.loadedAt < META_TTL_MS) return this.meta;

    const owner = config.github.owner;
    const number = config.github.project.number;
    const types: string[] = config.github.project.ownerType ? [config.github.project.ownerType] : ['organization', 'user'];

    let project: any = null;
    let lastErr: unknown;
    for (const type of types) {
      try {
        const res: any = await this.octokit.graphql(
          `query($owner: String!, $number: Int!) { ${type}(login: $owner) { projectV2(number: $number) { ${FIELDS_FRAGMENT} } } }`,
          { owner, number }
        );
        project = res?.[type]?.projectV2;
        if (project) break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!project) {
      throw new Error(`project #${number} not found for "${owner}" (${(lastErr as Error)?.message ?? 'check GITHUB_PROJECT_NUMBER and that the token has the `project` scope'})`);
    }

    const nodes = (project.fields.nodes as any[]).filter(Boolean);
    const selects: SelectField[] = nodes.filter(n => n.options).map(n => ({ id: n.id, name: n.name, options: n.options }));
    const numbers = nodes.filter(n => n.dataType === 'NUMBER').map(n => ({ id: n.id, name: n.name as string }));

    this.meta = {
      projectId: project.id,
      status: selects.find(f => f.name.toLowerCase() === 'status') ?? null,
      priority: selects.find(f => f.name.toLowerCase() === 'priority') ?? null,
      effort: selects.find(f => EFFORT_FIELD_RE.test(f.name)) ?? null,
      hours: numbers.find(f => HOURS_FIELD_RE.test(f.name)) ?? null,
      loadedAt: Date.now(),
    };
    return this.meta;
  }

  /** The issue's card on the board; adds the issue to the board if automation hasn't yet. */
  private async ensureItem(issueNumber: number, projectId: string): Promise<string> {
    const res: any = await this.octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!) {
         repository(owner: $owner, name: $repo) {
           issue(number: $number) { id projectItems(first: 20) { nodes { id project { id } } } }
         }
       }`,
      { owner: config.github.owner, repo: config.github.repo, number: issueNumber }
    );
    const issue = res.repository.issue;
    const existing = (issue.projectItems.nodes as any[]).find(n => n.project.id === projectId);
    if (existing) return existing.id;

    const added: any = await this.octokit.graphql(
      `mutation($projectId: ID!, $contentId: ID!) {
         addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
       }`,
      { projectId, contentId: issue.id }
    );
    return added.addProjectV2ItemById.item.id;
  }

  private async setSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await this.octokit.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
         updateProjectV2ItemFieldValue(input: {
           projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
         }) { projectV2Item { id } }
       }`,
      { projectId, itemId, fieldId, optionId }
    );
  }

  private async setNumber(projectId: string, itemId: string, fieldId: string, value: number): Promise<void> {
    await this.octokit.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
         updateProjectV2ItemFieldValue(input: {
           projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { number: $value }
         }) { projectV2Item { id } }
       }`,
      { projectId, itemId, fieldId, value }
    );
  }

  async apply(issue: GitHubIssue, desired: BoardDesired): Promise<BoardApplyResult> {
    const result: BoardApplyResult = { ok: false, status: false, priority: false, effort: false, hours: false };
    if (!this.enabled) return result;
    try {
      const meta = await this.loadMeta();
      const itemId = await this.ensureItem(issue.number, meta.projectId);

      if (desired.status) {
        const option = meta.status ? matchOption(meta.status.options, STATUS_PATTERNS[desired.status]) : null;
        if (option) {
          await this.setSelect(meta.projectId, itemId, meta.status!.id, option.id);
          result.status = true;
        } else if (!meta.status) {
          this.warnOnce('status-field', 'the board has no single-select "Status" field — using labels for status instead');
        } else {
          this.warnOnce(`status:${desired.status}`, `no "Status" column matches "${desired.status}" (columns: ${meta.status.options.map(o => o.name).join(', ')}) — using a label for it instead`);
        }
      }

      if (desired.priority) {
        const option = meta.priority ? matchOption(meta.priority.options, PRIORITY_PATTERNS[desired.priority]) : null;
        if (option) {
          await this.setSelect(meta.projectId, itemId, meta.priority!.id, option.id);
          result.priority = true;
        } else if (!meta.priority) {
          this.warnOnce('priority-field', 'the board has no single-select "Priority" field — using labels for priority instead');
        } else {
          this.warnOnce(`priority:${desired.priority}`, `no "Priority" option matches ${desired.priority} (options: ${meta.priority.options.map(o => o.name).join(', ')}) — using a label instead`);
        }
      }

      if (desired.effort && meta.effort) {
        const option = matchOption(meta.effort.options, EFFORT_PATTERNS[desired.effort]);
        if (option) {
          await this.setSelect(meta.projectId, itemId, meta.effort.id, option.id);
          result.effort = true;
        }
      }

      if (desired.estimateHours !== undefined) {
        if (meta.hours) {
          await this.setNumber(meta.projectId, itemId, meta.hours.id, desired.estimateHours);
          result.hours = true;
        } else {
          this.warnOnce('hours-field', 'add a Number field named "Estimate" to the board to show estimated hours on the card (they\'re always in the issue body)');
        }
      }

      result.ok = true;
      this.snap = null; // our own write — next read should be fresh
    } catch (err) {
      this.meta = null; // refetch next time (a field/option may have been renamed)
      console.warn(`⚠️ Project board update failed for #${issue.number}: ${(err as Error).message}`);
    }
    return result;
  }

  /** All cards' Status/Priority/Effort, cached for ~20 s. Throws on API failure (callers fall back to labels). */
  async snapshot(): Promise<BoardSnapshot> {
    if (!this.enabled) return { items: new Map(), supportsBlocked: false };
    if (this.snap && Date.now() - this.snap.at < SNAPSHOT_TTL_MS) return this.snap.value;

    const meta = await this.loadMeta();
    const repoFull = `${config.github.owner}/${config.github.repo}`.toLowerCase();
    const items = new Map<number, BoardFields>();
    let cursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const res: any = await this.octokit.graphql(
        `query($id: ID!, $cursor: String) {
           node(id: $id) {
             ... on ProjectV2 {
               items(first: 100, after: $cursor) {
                 pageInfo { hasNextPage endCursor }
                 nodes {
                   content { ... on Issue { number repository { nameWithOwner } } }
                   fieldValues(first: 20) {
                     nodes {
                       __typename
                       ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                       ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                     }
                   }
                 }
               }
             }
           }
         }`,
        { id: meta.projectId, cursor }
      );
      const conn = res.node.items;
      for (const node of conn.nodes as any[]) {
        const issue = node?.content;
        if (!issue?.number || String(issue.repository?.nameWithOwner ?? '').toLowerCase() !== repoFull) continue;
        const fields: BoardFields = {};
        for (const fv of (node.fieldValues?.nodes ?? []) as any[]) {
          const fname = String(fv?.field?.name ?? '');
          if (!fname) continue;
          if (typeof fv.name === 'string') {
            if (fname.toLowerCase() === 'status') fields.status = statusFromName(fv.name);
            else if (fname.toLowerCase() === 'priority') fields.priority = priorityFromName(fv.name);
            else if (EFFORT_FIELD_RE.test(fname)) fields.effort = effortFromName(fv.name);
          } else if (typeof fv.number === 'number' && HOURS_FIELD_RE.test(fname)) {
            fields.estimateHours = fv.number;
          }
        }
        items.set(issue.number, fields);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    const supportsBlocked = Boolean(meta.status?.options.some(o => STATUS_PATTERNS.blocked.test(o.name)));
    const value = { items, supportsBlocked };
    this.snap = { at: Date.now(), value };
    return value;
  }

  /** Read-only: shows what the bot found on your board and how it would map each value. */
  async diagnose(): Promise<string[]> {
    const out: string[] = [];
    if (!this.enabled) return ['GITHUB_PROJECT_NUMBER is not set — board sync is OFF.'];
    const meta = await this.loadMeta();
    out.push(`✓ Found project #${config.github.project.number} for "${config.github.owner}"`);

    const show = (title: string, field: SelectField | null, keys: string[], pattern: (k: any) => RegExp, missing: string) => {
      if (!field) return out.push(`✗ ${missing}`);
      out.push(`${title} field "${field.name}" options: ${field.options.map(o => o.name).join(' | ')}`);
      for (const k of keys) {
        const m = matchOption(field.options, pattern(k));
        out.push(`  ${String(k).padEnd(12)} → ${m ? `"${m.name}"` : '✗ no matching option (a label is used instead)'}`);
      }
    };
    show('Status', meta.status, Object.keys(STATUS_PATTERNS), k => STATUS_PATTERNS[k as BoardStatus], 'No single-select field named "Status" — status will use labels.');
    show('Priority', meta.priority, PRIORITIES, k => PRIORITY_PATTERNS[k as Priority], 'No single-select field named "Priority" — priority will use labels.');
    if (meta.effort) show('Effort', meta.effort, ['low', 'medium', 'high'], k => EFFORT_PATTERNS[k as Effort], '');
    else out.push('ℹ No "Effort"/"Size" single-select field (optional) — effort stays as the effort:* label.');
    out.push(meta.hours ? `✓ Estimated hours go to the number field "${meta.hours.name}"` : 'ℹ No number field named "Estimate" (optional) — add one to show estimated hours on the card.');
    return out;
  }
}

export const liveProjectBoard = new ProjectBoard();
