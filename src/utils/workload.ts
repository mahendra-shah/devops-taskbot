import { config } from '../config.js';
import { liveGitHubProvider, countClosedYesterday } from '../github.js';
import type { GitHubIssue, GitHubProvider } from '../types.js';
import { availabilityService } from '../availability.js';

export interface TeamWorkload {
  slackId: string;
  githubUsername: string;
  openIssues: GitHubIssue[];
  /** Simple numeric score: sum of effort weights + P0/in-progress bonuses */
  loadScore: number;
}

const EFFORT_WEIGHTS: Record<string, number> = {
  'effort:high': 3,
  'effort:medium': 2,
  'effort:low': 1,
};

export function computeLoadScore(issues: GitHubIssue[]): number {
  return issues.reduce((score, issue) => {
    const effortLabel = issue.labels.find(l => l.startsWith('effort:'));
    const weight = effortLabel ? (EFFORT_WEIGHTS[effortLabel] || 1) : 1;
    const p0Bonus = issue.labels.includes('P0') ? 2 : 0;
    const inProgressBonus = issue.labels.includes('in-progress') ? 1 : 0;
    return score + weight + p0Bonus + inProgressBonus;
  }, 0);
}

/**
 * Fetches the current workload for every team member.
 */
export async function fetchTeamWorkload(github: GitHubProvider = liveGitHubProvider): Promise<TeamWorkload[]> {
  return Promise.all(
    config.team.map(async member => {
      const openIssues = await github.getOpenIssuesForUser(member.githubUsername);
      return {
        slackId: member.slackId,
        githubUsername: member.githubUsername,
        openIssues,
        loadScore: computeLoadScore(openIssues),
      };
    })
  );
}

/**
 * Returns a formatted Slack mrkdwn string showing the current team workload.
 */
export async function buildStatusMessage(github: GitHubProvider = liveGitHubProvider): Promise<string> {
  const workloads = await fetchTeamWorkload(github);
  const availability = await availabilityService.getMany(workloads.map(w => w.slackId));
  const totalOpen = workloads.reduce((s, w) => s + w.openIssues.length, 0);

  const lines = workloads.map(w => {
    const inProgress = w.openIssues.filter(i => i.labels.includes('in-progress')).length;
    const p0 = w.openIssues.filter(i => i.labels.includes('P0')).length;
    const blocked = w.openIssues.filter(i => i.labels.includes('blocked')).length;

    const a = availability.get(w.slackId);
    const away = a && !a.available ? ` 🌴 _out until ${a.untilLabel ?? 'later'}_` : '';
    let line = `• *${w.githubUsername}*${away} — ${w.openIssues.length} open`;
    if (inProgress > 0) line += `, ${inProgress} 🔄 in-progress`;
    if (blocked > 0) line += `, ${blocked} 🚫 blocked`;
    if (p0 > 0) line += `, ${p0} 🚨 P0`;
    line += ` _(load score: ${w.loadScore})_`;

    if (w.openIssues.length > 0) {
      const issueSummaries = w.openIssues
        .slice(0, 3)
        .map(i => `    ◦ <${i.url}|#${i.number}> ${i.title}`)
        .join('\n');
      line += `\n${issueSummaries}`;
    }
    return line;
  });

  return `*📊 DevOps Workload Status*\n*Total open tasks: ${totalOpen}*\n\n${lines.join('\n')}`;
}

export async function getWorkloadForSlackUser(
  slackId: string,
  github: GitHubProvider = liveGitHubProvider
): Promise<GitHubIssue[]> {
  const member = config.team.find(m => m.slackId === slackId);
  if (!member) return [];
  return github.getOpenIssuesForUser(member.githubUsername);
}

export function githubUsernameForSlackId(slackId: string): string | null {
  return config.team.find(m => m.slackId === slackId)?.githubUsername ?? null;
}

export function slackIdForGithubUsername(githubUsername: string): string | null {
  return config.team.find(m => m.githubUsername === githubUsername)?.slackId ?? null;
}

export function isTeamMember(slackId: string): boolean {
  return config.team.some(m => m.slackId === slackId);
}

export { countClosedYesterday };
