import { Octokit } from '@octokit/rest';
import { config } from './config.js';
import type { GitHubIssue, GitHubProvider, IssueStatus, ParsedTask } from './types.js';

export type { GitHubIssue, ParsedTask } from './types.js';

const octokit = new Octokit({ auth: config.github.token });
const { owner, repo } = config.github;

function mapOctokitIssue(issue: any): GitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    url: issue.html_url,
    state: issue.state as 'open' | 'closed',
    labels: (issue.labels as any[]).map(l => (typeof l === 'string' ? l : l.name || '')),
    assignees: (issue.assignees || []).map((a: any) => a.login),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at || undefined,
  };
}

function buildLabels(task: Pick<ParsedTask, 'priority' | 'estimate'>): string[] {
  return ['devops', task.priority, `effort:${task.estimate}`];
}

export async function createIssue(
  task: Pick<ParsedTask, 'title' | 'body' | 'priority' | 'estimate'>,
  assigneeGithubUsername: string,
  slackMessageTs: string,
  slackChannelId: string
): Promise<GitHubIssue> {
  const labels = buildLabels(task);
  const slackLink = `https://slack.com/app_redirect?channel=${slackChannelId}&message_ts=${slackMessageTs.replace('.', '')}`;
  const bodyWithSource = `${task.body}\n\n---\n📎 **Slack thread:** [View original message](${slackLink})`;

  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title: task.title,
    body: bodyWithSource,
    assignees: [assigneeGithubUsername],
    labels,
  });

  console.log(`✓ GitHub Issue #${data.number} created → ${data.html_url}`);
  return mapOctokitIssue(data);
}

export async function updateIssueStatus(
  issueNumber: number,
  status: IssueStatus
): Promise<GitHubIssue | null> {
  const statusLabels = ['in-progress', 'blocked'];
  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const currentLabels = (issue.labels as any[]).map(l => (typeof l === 'string' ? l : l.name || ''));
  const cleanedLabels = currentLabels.filter(l => !statusLabels.includes(l));

  if (status === 'done') {
    const { data: updated } = await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed',
      labels: cleanedLabels,
    });
    console.log(`✓ Issue #${issueNumber} closed (done).`);
    return mapOctokitIssue(updated);
  }

  if (status !== 'open') {
    cleanedLabels.push(status);
  }

  const { data: updated } = await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'open',
    labels: cleanedLabels,
  });
  console.log(`✓ Issue #${issueNumber} updated → status: ${status}`);
  return mapOctokitIssue(updated);
}

export async function reassignIssue(issueNumber: number, newAssignee: string): Promise<GitHubIssue | null> {
  const { data } = await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    assignees: [newAssignee],
  });
  console.log(`✓ Issue #${issueNumber} reassigned to ${newAssignee}`);
  return mapOctokitIssue(data);
}

export async function addIssueComment(issueNumber: number, comment: string): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: comment,
  });
  console.log(`✓ Comment added to Issue #${issueNumber}`);
}

export async function getOpenIssuesForUser(githubUsername: string): Promise<GitHubIssue[]> {
  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    assignee: githubUsername,
    per_page: 50,
  });
  return data.map(mapOctokitIssue);
}

export async function getAllOpenIssues(): Promise<GitHubIssue[]> {
  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return data.map(mapOctokitIssue);
}

export async function findIssueBySlackTs(slackTs: string): Promise<GitHubIssue | null> {
  const tsFragment = slackTs.replace('.', '');
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue ${tsFragment}`,
    per_page: 1,
  });

  if (data.items.length === 0) return null;
  return mapOctokitIssue(data.items[0]);
}

export async function ensureLabelsExist(): Promise<void> {
  const requiredLabels = [
    { name: 'in-progress', color: 'fbca04', description: 'Work has started on this task' },
    { name: 'blocked', color: 'd93f0b', description: 'Task is blocked on external dependency' },
    { name: 'P0', color: 'e11d48', description: 'Critical / production issue' },
    { name: 'P1', color: 'f97316', description: 'High priority' },
    { name: 'P2', color: '84cc16', description: 'Normal priority' },
    { name: 'effort:low', color: 'bbf7d0', description: 'Estimated < 1 hour' },
    { name: 'effort:medium', color: 'fef08a', description: 'Estimated 1-4 hours' },
    { name: 'effort:high', color: 'fecaca', description: 'Estimated > 4 hours' },
    { name: 'devops', color: '6366f1', description: 'DevOps task' },
    { name: 'sla-breach-alerted', color: 'b60205', description: 'SLA breach notification already sent' },
  ];

  const { data: existingLabels } = await octokit.rest.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
  const existingNames = new Set(existingLabels.map(l => l.name));

  for (const label of requiredLabels) {
    if (!existingNames.has(label.name)) {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, ...label });
        console.log(`  ✓ Created GitHub label: ${label.name}`);
      } catch {
        // Ignore race conditions
      }
    }
  }
}

export async function findSimilarOpenIssue(title: string): Promise<GitHubIssue | null> {
  const keywords = title
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5)
    .join(' ');

  if (!keywords) return null;

  try {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:issue is:open ${keywords}`,
      per_page: 1,
    });
    if (data.items.length === 0) return null;
    return mapOctokitIssue(data.items[0]);
  } catch {
    return null;
  }
}

export async function countClosedYesterday(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'closed',
    since,
    per_page: 100,
  });
  return data.length;
}

export async function getClosedSince(sinceIso: string): Promise<GitHubIssue[]> {
  const out: GitHubIssue[] = [];
  for (let page = 1; page <= 5; page++) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'closed',
      since: sinceIso,
      per_page: 100,
      page,
    });
    for (const i of data) {
      if ((i as any).pull_request) continue;
      if (i.closed_at && new Date(i.closed_at) >= new Date(sinceIso)) out.push(mapOctokitIssue(i));
    }
    if (data.length < 100) break;
  }
  return out;
}

export async function getIssueByNumber(issueNumber: number): Promise<GitHubIssue | null> {
  try {
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    const issue = mapOctokitIssue(data);
    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 10,
      });
      issue.comments = comments.map(c => ({
        author: c.user?.login || 'unknown',
        body: c.body || '',
        createdAt: c.created_at,
      }));
    } catch {
      issue.comments = [];
    }
    return issue;
  } catch {
    return null;
  }
}

export async function addIssueLabel(issueNumber: number, label: string): Promise<void> {
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [label],
  });
}

export const liveGitHubProvider: GitHubProvider = {
  isMock: false,
  ensureLabelsExist,
  createIssue,
  updateIssueStatus,
  reassignIssue,
  addIssueComment,
  addIssueLabel,
  getIssueByNumber,
  getOpenIssuesForUser,
  getAllOpenIssues,
  findIssueBySlackTs,
  findSimilarOpenIssue,
  countClosedYesterday,
  getClosedSince,
};
