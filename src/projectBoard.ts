import { config } from './config.js';
import { createOctokit } from './githubAuth.js';
import { PRIORITIES, type GitHubIssue, type Priority } from './types.js';

/**
 * GitHub is the source of truth for Status, Priority, Effort and the target date.
 *
 *   • Status            → the Projects (v2) board's "Status" column (Todo / In Progress / Done).
 *   • Priority, Effort  → the organisation's ISSUE FIELDS "Priority" (Urgent/High/Medium/Low) and "Effort" — the ones
 *                         shown under "Fields" on an issue. (A project-level field of the same name is used if the org
 *                         has no issue field.)
 *   • Target date       → the issue field "Target date" — set from an ETA ("@bot #1 will take till Friday").
 *
 *   WRITES: after every change the bot makes. No `in-progress` / `P1` labels are needed.
 *   READS:  the bot reads these back (cached), so a card dragged on the board or a field edited on GitHub is respected
 *           by the bot, the digest, `@bot status`, escalation, etc.
 *   FALLBACK: if a value can't be written (no matching option such as a "Blocked" column, missing permission, API
 *           error) the bot falls back to a label so nothing is lost.
 *
 * Needs GITHUB_PROJECT_NUMBER. With a GitHub App: Issues (write), Organization Projects (write) and, for issue
 * fields, Organization Issue fields (write). Names are discovered, nothing is hard-coded.
 */

export type BoardStatus = 'open' | 'in-progress' | 'blocked' | 'done';
export type Effort = 'low' | 'medium' | 'high';

export interface BoardDesired {
  status?: BoardStatus;
  priority?: Priority;
  effort?: Effort;
  estimateHours?: number;
  /** ISO date "YYYY-MM-DD" for the Target date issue field. */
  targetDate?: string;
}

/** Which of the requested values were actually written. */
export interface BoardApplyResult {
  ok: boolean;
  status: boolean;
  priority: boolean;
  effort: boolean;
  hours: boolean;
  targetDate: boolean;
}

export interface BoardFields {
  status?: BoardStatus;
  priority?: Priority;
  effort?: Effort;
  estimateHours?: number;
  targetDate?: string;
}

export interface BoardSnapshot {
  items: Map<number, BoardFields>;
  /** True when the board has a column that can represent "blocked". */
  supportsBlocked: boolean;
}

export interface BoardSync {
  readonly enabled: boolean;
  apply(issue: GitHubIssue, desired: BoardDesired): Promise<BoardApplyResult>;
  /** `issueNumbers` = the issues the caller cares about (their issue-field values are fetched too). */
  snapshot?(issueNumbers?: number[]): Promise<BoardSnapshot>;
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
const PRIORITY_FIELD_RE = /^priority$/i;
const TARGET_DATE_FIELD_RE = /^(target date|due date|due|deadline)$/i;
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

// ── GitHub implementation ──────────────────────────────────────────────────

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

/** An organisation issue field (the "Fields" section on an issue). */
interface IssueFieldDef {
  id: number;
  name: string;
  dataType: string;
  options: FieldOption[];
}

interface IssueFieldsMeta {
  priority: IssueFieldDef | null;
  effort: IssueFieldDef | null;
  targetDate: IssueFieldDef | null;
  loadedAt: number;
}

const META_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_TTL_MS = 20 * 1000;
const ISSUE_FIELD_VALUES_TTL_MS = 60 * 1000;
/** Issue fields use a newer REST API version than the rest of Octokit's route table. */
const ISSUE_FIELDS_HEADERS = { 'X-GitHub-Api-Version': '2026-03-10' };

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
  private octokit = createOctokit();
  private meta: ProjectMeta | null = null;
  private issueFields: IssueFieldsMeta | null = null;
  private snap: { at: number; value: BoardSnapshot } | null = null;
  private fieldValueCache = new Map<number, { at: number; fields: BoardFields }>();
  private warned = new Set<string>();

  get enabled(): boolean {
    return config.github.project.number > 0;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`⚠️ Project board: ${message}`);
  }

  // ── Projects v2 (Status column, optional project-level fields) ──

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
      throw new Error(`project #${number} not found for "${owner}" (${(lastErr as Error)?.message ?? 'check GITHUB_PROJECT_NUMBER and that the App/token can access the project'})`);
    }

    const nodes = (project.fields.nodes as any[]).filter(Boolean);
    const selects: SelectField[] = nodes.filter(n => n.options).map(n => ({ id: n.id, name: n.name, options: n.options }));
    const numbers = nodes.filter(n => n.dataType === 'NUMBER').map(n => ({ id: n.id, name: n.name as string }));

    this.meta = {
      projectId: project.id,
      status: selects.find(f => f.name.toLowerCase() === 'status') ?? null,
      priority: selects.find(f => PRIORITY_FIELD_RE.test(f.name)) ?? null,
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

  // ── Issue fields (Priority / Effort / Target date on the issue itself) ──

  private async loadIssueFields(): Promise<IssueFieldsMeta> {
    if (this.issueFields && Date.now() - this.issueFields.loadedAt < META_TTL_MS) return this.issueFields;

    let defs: any[] = [];
    try {
      const res = await this.octokit.request('GET /orgs/{org}/issue-fields', { org: config.github.owner, headers: ISSUE_FIELDS_HEADERS });
      defs = (res.data as any[]) ?? [];
    } catch (err: any) {
      if (err?.status === 404) defs = []; // not an org / feature not enabled
      else if (err?.status === 403) {
        this.warnOnce('issue-fields-403', 'no permission to read organisation issue fields (App needs "Issue fields: Read" under Organization permissions) — using project fields/labels instead');
        defs = [];
      } else throw err;
    }

    const toDef = (f: any): IssueFieldDef => ({
      id: f.id,
      name: f.name,
      dataType: f.data_type,
      options: (f.options ?? []).map((o: any) => ({ id: String(o.id), name: o.name })),
    });
    const all = defs.map(toDef);
    this.issueFields = {
      priority: all.find(f => f.dataType === 'single_select' && PRIORITY_FIELD_RE.test(f.name)) ?? null,
      effort: all.find(f => f.dataType === 'single_select' && EFFORT_FIELD_RE.test(f.name)) ?? null,
      targetDate: all.find(f => f.dataType === 'date' && TARGET_DATE_FIELD_RE.test(f.name)) ?? null,
      loadedAt: Date.now(),
    };
    return this.issueFields;
  }

  private async setIssueFieldValues(issueNumber: number, values: { field_id: number; value: string | number }[]): Promise<void> {
    await this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
      owner: config.github.owner,
      repo: config.github.repo,
      issue_number: issueNumber,
      issue_field_values: values,
      headers: ISSUE_FIELDS_HEADERS,
    });
  }

  private async readIssueFieldValues(issueNumber: number, ifm: IssueFieldsMeta): Promise<BoardFields> {
    const cached = this.fieldValueCache.get(issueNumber);
    if (cached && Date.now() - cached.at < ISSUE_FIELD_VALUES_TTL_MS) return cached.fields;

    const res = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
      owner: config.github.owner,
      repo: config.github.repo,
      issue_number: issueNumber,
      per_page: 100,
      headers: ISSUE_FIELDS_HEADERS,
    });
    const fields: BoardFields = {};
    for (const v of (res.data as any[]) ?? []) {
      if (v.issue_field_id === ifm.priority?.id && v.single_select_option?.name) fields.priority = priorityFromName(v.single_select_option.name);
      else if (v.issue_field_id === ifm.effort?.id && v.single_select_option?.name) fields.effort = effortFromName(v.single_select_option.name);
      else if (v.issue_field_id === ifm.targetDate?.id && typeof v.value === 'string') fields.targetDate = v.value.slice(0, 10);
    }
    this.fieldValueCache.set(issueNumber, { at: Date.now(), fields });
    return fields;
  }

  // ── Writing ──

  async apply(issue: GitHubIssue, desired: BoardDesired): Promise<BoardApplyResult> {
    const result: BoardApplyResult = { ok: false, status: false, priority: false, effort: false, hours: false, targetDate: false };
    if (!this.enabled) return result;
    let ok = true;

    // 1) Issue fields: Priority, Effort, Target date (on the issue itself)
    let ifm: IssueFieldsMeta | null = null;
    try {
      ifm = await this.loadIssueFields();
    } catch (err) {
      ok = false;
      console.warn(`⚠️ Could not read issue fields: ${(err as Error).message}`);
    }
    const issueFieldValues: { field_id: number; value: string | number }[] = [];
    const pending: Array<'priority' | 'effort' | 'targetDate'> = [];
    if (ifm) {
      if (desired.priority && ifm.priority) {
        const o = matchOption(ifm.priority.options, PRIORITY_PATTERNS[desired.priority]);
        if (o) {
          issueFieldValues.push({ field_id: ifm.priority.id, value: o.name });
          pending.push('priority');
        } else this.warnOnce(`if-priority:${desired.priority}`, `the Priority issue field has no option matching ${desired.priority} (options: ${ifm.priority.options.map(x => x.name).join(', ')})`);
      }
      if (desired.effort && ifm.effort) {
        const o = matchOption(ifm.effort.options, EFFORT_PATTERNS[desired.effort]);
        if (o) {
          issueFieldValues.push({ field_id: ifm.effort.id, value: o.name });
          pending.push('effort');
        }
      }
      if (desired.targetDate && ifm.targetDate) {
        issueFieldValues.push({ field_id: ifm.targetDate.id, value: desired.targetDate });
        pending.push('targetDate');
      }
    }
    if (issueFieldValues.length > 0) {
      try {
        await this.setIssueFieldValues(issue.number, issueFieldValues);
        for (const k of pending) result[k] = true;
        this.fieldValueCache.delete(issue.number);
      } catch (err) {
        ok = false;
        this.issueFields = null;
        console.warn(`⚠️ Could not write issue fields for #${issue.number}: ${(err as Error).message}`);
      }
    }

    // 2) Project board: Status column (+ project-level Priority/Effort/Estimate only when not handled above)
    try {
      const meta = await this.loadMeta();
      const needsItem = Boolean(desired.status) || (desired.priority && !result.priority) || (desired.effort && !result.effort) || desired.estimateHours !== undefined;
      const itemId = needsItem ? await this.ensureItem(issue.number, meta.projectId) : '';

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

      if (desired.priority && !result.priority) {
        const option = meta.priority ? matchOption(meta.priority.options, PRIORITY_PATTERNS[desired.priority]) : null;
        if (option) {
          await this.setSelect(meta.projectId, itemId, meta.priority!.id, option.id);
          result.priority = true;
        } else {
          this.warnOnce('priority-missing', 'no Priority issue field or project field could take the priority — using a label instead');
        }
      }

      if (desired.effort && !result.effort && meta.effort) {
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
    } catch (err) {
      ok = false;
      this.meta = null; // refetch next time (a field/option may have been renamed)
      console.warn(`⚠️ Project board update failed for #${issue.number}: ${(err as Error).message}`);
    }

    result.ok = ok;
    this.snap = null; // our own write — next read should be fresh
    return result;
  }

  // ── Reading ──

  /** Status/etc. from the project's cards, cached ~20 s. Throws on API failure (callers fall back to labels). */
  private async projectSnapshot(): Promise<BoardSnapshot> {
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
            else if (PRIORITY_FIELD_RE.test(fname)) fields.priority = priorityFromName(fv.name);
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

  /** Board status + issue-field values for the given issues (issue fields win over project-level ones). */
  async snapshot(issueNumbers?: number[]): Promise<BoardSnapshot> {
    if (!this.enabled) return { items: new Map(), supportsBlocked: false };
    const base = await this.projectSnapshot();
    if (!issueNumbers || issueNumbers.length === 0) return base;

    let ifm: IssueFieldsMeta | null = null;
    try {
      ifm = await this.loadIssueFields();
    } catch {
      return base;
    }
    if (!ifm.priority && !ifm.effort && !ifm.targetDate) return base;

    const items = new Map<number, BoardFields>(base.items);
    const queue = [...new Set(issueNumbers)];
    const worker = async () => {
      for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
        try {
          const vals = await this.readIssueFieldValues(n, ifm!);
          items.set(n, { ...(items.get(n) ?? {}), ...Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== undefined)) });
        } catch {
          /* keep whatever the project gave us for this issue */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return { items, supportsBlocked: base.supportsBlocked };
  }

  /** Read-only: shows what the bot found on GitHub and how it would map each value. */
  async diagnose(): Promise<string[]> {
    const out: string[] = [];
    if (!this.enabled) return ['GITHUB_PROJECT_NUMBER is not set — board sync is OFF.'];
    const meta = await this.loadMeta();
    out.push(`✓ Found project #${config.github.project.number} for "${config.github.owner}"`);

    const show = (title: string, field: { name: string; options: FieldOption[] } | null, keys: string[], pattern: (k: any) => RegExp, missing: string) => {
      if (!field) return out.push(`✗ ${missing}`);
      out.push(`${title} "${field.name}" options: ${field.options.map(o => o.name).join(' | ')}`);
      for (const k of keys) {
        const m = matchOption(field.options, pattern(k));
        out.push(`  ${String(k).padEnd(12)} → ${m ? `"${m.name}"` : '✗ no matching option (a label is used instead)'}`);
      }
    };
    show('Project Status field', meta.status, Object.keys(STATUS_PATTERNS), k => STATUS_PATTERNS[k as BoardStatus], 'No single-select field named "Status" on the project — status will use labels.');

    let ifm: IssueFieldsMeta | null = null;
    try {
      ifm = await this.loadIssueFields();
    } catch (err) {
      out.push(`✗ Could not read organisation issue fields: ${(err as Error).message}`);
    }
    if (ifm?.priority) show('Issue field', ifm.priority, PRIORITIES, k => PRIORITY_PATTERNS[k as Priority], '');
    else show('Project Priority field', meta.priority, PRIORITIES, k => PRIORITY_PATTERNS[k as Priority], 'No "Priority" issue field or project field — priority will use labels.');
    if (ifm?.effort) show('Issue field', ifm.effort, ['low', 'medium', 'high'], k => EFFORT_PATTERNS[k as Effort], '');
    else if (meta.effort) show('Project Effort field', meta.effort, ['low', 'medium', 'high'], k => EFFORT_PATTERNS[k as Effort], '');
    else out.push('ℹ No Effort field — effort stays as the effort:* label.');
    out.push(ifm?.targetDate ? `✓ ETAs ("@bot #1 will take till Friday") are written to the issue field "${ifm.targetDate.name}"` : 'ℹ No "Target date" issue field — ETAs are kept inside the bot only.');
    out.push(meta.hours ? `✓ Estimated hours go to the number field "${meta.hours.name}"` : 'ℹ No number field named "Estimate" (optional) — add one to show estimated hours on the card.');
    return out;
  }
}

export const liveProjectBoard = new ProjectBoard();
