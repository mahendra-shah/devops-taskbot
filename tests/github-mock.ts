import { config } from '../src/config.js';
import type { GitHubIssue, GitHubProvider, IssueStatus, ParsedTask } from '../src/types.js';

/**
 * In-memory GitHub Issues simulator used for testing and sandbox chat
 * without hitting or cluttering the real GitHub repository.
 */
export class MockGitHubProvider implements GitHubProvider {
  public readonly isMock = true;
  private issues: GitHubIssue[] = [];
  private tsToIssueNumber = new Map<string, number>();
  private nextNumber = 1;

  constructor(seedSampleIssues = true) {
    if (seedSampleIssues && config.team.length > 0) {
      const m0 = config.team[0]?.githubUsername || 'dev-1';
      const m1 = config.team[1]?.githubUsername || m0;

      // Seed 2 existing issues on first dev and 1 on second dev (leaving 3rd dev free)
      this.seedIssue(
        'Rotate expired staging TLS certificates',
        'Ingress cert-manager failed renewal on staging cluster.',
        ['devops', 'P1', 'effort:medium', 'in-progress'],
        m0
      );
      this.seedIssue(
        'Upgrade RDS Postgres minor version on QA',
        'Scheduled maintenance window upgrade from 15.3 to 15.7.',
        ['devops', 'P2', 'effort:high'],
        m0
      );
      if (config.team.length > 1) {
        this.seedIssue(
          'Add Prometheus alert for Redis memory > 85%',
          'Requested by backend team after last week cache eviction.',
          ['devops', 'P2', 'effort:low', 'in-progress'],
          m1
        );
      }
    }
  }

  private seedIssue(title: string, body: string, labels: string[], assignee: string): GitHubIssue {
    const num = this.nextNumber++;
    const now = new Date(Date.now() - 3600_000).toISOString();
    const issue: GitHubIssue = {
      number: num,
      title,
      body,
      url: `https://github.com/${config.github.owner || 'org'}/${config.github.repo || 'devops-tasks'}/issues/${num}`,
      state: 'open',
      labels,
      assignees: [assignee],
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  async ensureLabelsExist(): Promise<void> {
    console.log('✓ [MockGitHub] Labels verified (in-memory).');
  }

  async createIssue(
    task: Pick<ParsedTask, 'title' | 'body' | 'priority' | 'estimate'>,
    assigneeGithubUsername: string,
    slackMessageTs: string,
    slackChannelId: string
  ): Promise<GitHubIssue> {
    const num = this.nextNumber++;
    const now = new Date().toISOString();
    const issue: GitHubIssue = {
      number: num,
      title: task.title,
      body: `${task.body}\n\n---\n📎 **Slack thread:** channel=${slackChannelId} ts=${slackMessageTs}`,
      url: `https://github.com/${config.github.owner || 'org'}/${config.github.repo || 'devops-tasks'}/issues/${num}`,
      state: 'open',
      labels: ['devops', task.priority, `effort:${task.estimate}`],
      assignees: [assigneeGithubUsername],
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.issues.push(issue);
    this.tsToIssueNumber.set(slackMessageTs, num);
    this.tsToIssueNumber.set(slackMessageTs.replace('.', ''), num);
    console.log(`✓ [MockGitHub] Created Issue #${num}: "${task.title}" → @${assigneeGithubUsername} [${task.priority}, effort:${task.estimate}]`);
    return { ...issue };
  }

  async updateIssueStatus(issueNumber: number, status: IssueStatus): Promise<GitHubIssue | null> {
    const issue = this.issues.find(i => i.number === issueNumber);
    if (!issue) return null;

    issue.labels = issue.labels.filter(l => l !== 'in-progress' && l !== 'blocked');
    if (status === 'done') {
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
    } else {
      issue.state = 'open';
      issue.closedAt = undefined;
      if (status !== 'open') {
        issue.labels.push(status);
      }
    }
    issue.updatedAt = new Date().toISOString();
    console.log(`✓ [MockGitHub] Issue #${issueNumber} status → ${status} (state=${issue.state}, labels=${issue.labels.join(',')})`);
    return { ...issue };
  }

  async reassignIssue(issueNumber: number, newAssignee: string): Promise<GitHubIssue | null> {
    const issue = this.issues.find(i => i.number === issueNumber);
    if (!issue) return null;
    issue.assignees = [newAssignee];
    issue.updatedAt = new Date().toISOString();
    console.log(`✓ [MockGitHub] Issue #${issueNumber} reassigned → @${newAssignee}`);
    return { ...issue };
  }

  async addIssueComment(issueNumber: number, comment: string): Promise<void> {
    const issue = this.issues.find(i => i.number === issueNumber);
    if (!issue) return;
    issue.comments = issue.comments || [];
    issue.comments.push({
      author: 'devops-tracker-bot',
      body: comment,
      createdAt: new Date().toISOString(),
    });
    issue.updatedAt = new Date().toISOString();
    console.log(`✓ [MockGitHub] Comment added to Issue #${issueNumber}`);
  }

  async addIssueLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.issues.find(i => i.number === issueNumber);
    if (issue && !issue.labels.includes(label)) {
      issue.labels.push(label);
    }
  }

  async getIssueByNumber(issueNumber: number): Promise<GitHubIssue | null> {
    const issue = this.issues.find(i => i.number === issueNumber);
    return issue ? { ...issue } : null;
  }

  async getOpenIssuesForUser(githubUsername: string): Promise<GitHubIssue[]> {
    return this.issues
      .filter(i => i.state === 'open' && i.assignees.includes(githubUsername))
      .map(i => ({ ...i }));
  }

  async getAllOpenIssues(): Promise<GitHubIssue[]> {
    return this.issues.filter(i => i.state === 'open').map(i => ({ ...i }));
  }

  async findIssueBySlackTs(slackTs: string): Promise<GitHubIssue | null> {
    const num = this.tsToIssueNumber.get(slackTs) ?? this.tsToIssueNumber.get(slackTs.replace('.', ''));
    if (!num) return null;
    return this.getIssueByNumber(num);
  }

  async findSimilarOpenIssue(title: string): Promise<GitHubIssue | null> {
    const words = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);

    if (words.length === 0) return null;

    for (const issue of this.issues) {
      if (issue.state !== 'open') continue;
      const target = issue.title.toLowerCase();
      const matches = words.filter(w => target.includes(w));
      if (matches.length >= Math.min(2, words.length)) {
        return { ...issue };
      }
    }
    return null;
  }

  async countClosedYesterday(): Promise<number> {
    return this.issues.filter(i => i.state === 'closed').length;
  }

  async getClosedSince(sinceIso: string): Promise<GitHubIssue[]> {
    const since = new Date(sinceIso).getTime();
    return this.issues
      .filter(i => i.state === 'closed' && i.closedAt && new Date(i.closedAt).getTime() >= since)
      .map(i => ({ ...i }));
  }

  /** Test helper: close an issue "directly on GitHub" (bypassing the bot). */
  public closeDirectly(issueNumber: number): void {
    const issue = this.issues.find(i => i.number === issueNumber);
    if (issue) {
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
    }
  }

  public getAllIssuesSnapshot(): GitHubIssue[] {
    return this.issues.map(i => ({ ...i }));
  }
}
