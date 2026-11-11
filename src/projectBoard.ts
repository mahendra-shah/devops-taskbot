import { Octokit } from '@octokit/rest';
import { config } from './config.js';
import type { GitHubIssue } from './types.js';

/**
 * GitHub Projects (v2) board sync.
 *
 * Labels (`in-progress`, `P0`, …) and the project board's own fields (Status, Priority) are two
 * separate things on GitHub — setting a label does NOT move the card. This keeps the board in step:
 * after every change the bot makes, the issue's card gets the matching Status and Priority.
 *
 * Needs: GITHUB_PROJECT_NUMBER, and a token with the `project` scope.
 * Option names are discovered from your board (Todo / In Progress / Done …); nothing is hard-coded.
 * Best effort: a failure here is logged and never breaks the Slack flow.
 */

export interface BoardSync {
  sync(issue: GitHubIssue): Promise<void>;
}

export type BoardStatus = 'open' | 'in-progress' | 'blocked' | 'done';
export type BoardPriority = 'P0' | 'P1' | 'P2';

export function deriveBoardValues(issue: Pick<GitHubIssue, 'state' | 'labels'>): {
  status: BoardStatus;
  priority: BoardPriority | null;
} {
  const status: BoardStatus =
    issue.state === 'closed'
      ? 'done'
      : issue.labels.includes('blocked')
        ? 'blocked'
        : issue.labels.includes('in-progress')
          ? 'in-progress'
          : 'open';
  const priority = (['P0', 'P1', 'P2'] as const).find(p => issue.labels.includes(p)) ?? null;
  return { status, priority };
}

const STATUS_PATTERNS: Record<BoardStatus, RegExp> = {
  open: /^(todo|to do|to-do|backlog|open|new|triage|ready)/i,
  'in-progress': /(progress|doing|started|active|wip)/i,
  blocked: /block|hold|waiting/i,
  done: /(done|complete|closed|shipped|resolved)/i,
};

const PRIORITY_PATTERNS: Record<BoardPriority, RegExp> = {
  P0: /\bp0\b|critical|urgent|highest|blocker/i,
  P1: /\bp1\b|^high$/i,
  P2: /\bp2\b|^(medium|normal|med)$/i,
};

export interface FieldOption {
  id: string;
  name: string;
}

export function matchOption(options: FieldOption[], pattern: RegExp): FieldOption | null {
  return options.find(o => pattern.test(o.name.trim())) ?? null;
}

export { STATUS_PATTERNS, PRIORITY_PATTERNS };

interface SelectField {
  id: string;
  name: string;
  options: FieldOption[];
}

interface ProjectMeta {
  projectId: string;
  status: SelectField | null;
  priority: SelectField | null;
  loadedAt: number;
}

const META_TTL_MS = 10 * 60 * 1000;

const FIELDS_FRAGMENT = `
  id
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }`;

export class ProjectBoard implements BoardSync {
  private octokit = new Octokit({ auth: config.github.token });
  private meta: ProjectMeta | null = null;
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

    const fields: SelectField[] = (project.fields.nodes as any[])
      .filter(n => n && n.options)
      .map(n => ({ id: n.id, name: n.name, options: n.options }));
    const byName = (name: string) => fields.find(f => f.name.toLowerCase() === name) ?? null;

    this.meta = { projectId: project.id, status: byName('status'), priority: byName('priority'), loadedAt: Date.now() };
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

  private async setField(projectId: string, itemId: string, field: SelectField, option: FieldOption): Promise<void> {
    await this.octokit.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
         updateProjectV2ItemFieldValue(input: {
           projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
         }) { projectV2Item { id } }
       }`,
      { projectId, itemId, fieldId: field.id, optionId: option.id }
    );
  }

  /** Read-only: shows what the bot found on your board and how it would map each status/priority. */
  async diagnose(): Promise<string[]> {
    const out: string[] = [];
    if (!this.enabled) return ['GITHUB_PROJECT_NUMBER is not set — board sync is OFF.'];
    const meta = await this.loadMeta();
    out.push(`✓ Found project #${config.github.project.number} for "${config.github.owner}"`);

    if (!meta.status) out.push('✗ No single-select field named "Status" — status will NOT sync.');
    else {
      out.push(`Status field options: ${meta.status.options.map(o => o.name).join(' | ')}`);
      for (const s of Object.keys(STATUS_PATTERNS) as BoardStatus[]) {
        const m = matchOption(meta.status.options, STATUS_PATTERNS[s]);
        out.push(`  ${s.padEnd(12)} → ${m ? `"${m.name}"` : '✗ no matching option'}`);
      }
    }
    if (!meta.priority) out.push('✗ No single-select field named "Priority" — priority will NOT sync.');
    else {
      out.push(`Priority field options: ${meta.priority.options.map(o => o.name).join(' | ')}`);
      for (const p of Object.keys(PRIORITY_PATTERNS) as BoardPriority[]) {
        const m = matchOption(meta.priority.options, PRIORITY_PATTERNS[p]);
        out.push(`  ${p.padEnd(12)} → ${m ? `"${m.name}"` : '✗ no matching option'}`);
      }
    }
    return out;
  }

  async sync(issue: GitHubIssue): Promise<void> {
    if (!this.enabled) return;
    try {
      const meta = await this.loadMeta();
      const itemId = await this.ensureItem(issue.number, meta.projectId);
      const { status, priority } = deriveBoardValues(issue);

      if (meta.status) {
        const option = matchOption(meta.status.options, STATUS_PATTERNS[status]);
        if (option) await this.setField(meta.projectId, itemId, meta.status, option);
        else this.warnOnce(`status:${status}`, `no "Status" option matches "${status}" (options: ${meta.status.options.map(o => o.name).join(', ')})`);
      } else {
        this.warnOnce('status-field', 'the board has no single-select "Status" field');
      }

      if (priority) {
        if (meta.priority) {
          const option = matchOption(meta.priority.options, PRIORITY_PATTERNS[priority]);
          if (option) await this.setField(meta.projectId, itemId, meta.priority, option);
          else this.warnOnce(`priority:${priority}`, `no "Priority" option matches ${priority} (options: ${meta.priority.options.map(o => o.name).join(', ')})`);
        } else {
          this.warnOnce('priority-field', 'the board has no single-select "Priority" field');
        }
      }
    } catch (err) {
      this.meta = null; // refetch next time (field/option may have been renamed)
      console.warn(`⚠️ Project board sync failed for #${issue.number}: ${(err as Error).message}`);
    }
  }
}

export const liveProjectBoard = new ProjectBoard();
