import { config } from './config.js';

/**
 * Turns raw exceptions into messages a Slack user can act on.
 *
 * Why: provider errors used to be pasted straight into Slack ("401 Authentication Fails, Your api key:
 * ****b882 is invalid …") — confusing for requesters and it leaks part of a secret. Now the user sees a
 * plain explanation, the full error goes to the logs with a short reference id, and config problems
 * (bad key, no credit, bad GitHub token) additionally ping the DevOps team once in a while.
 */

export interface ProviderFailure {
  provider: string;
  status?: number;
  message: string;
}

/** Thrown when every configured AI provider failed. */
export class LlmUnavailableError extends Error {
  constructor(public readonly failures: ProviderFailure[]) {
    super(`All LLM providers failed: ${failures.map(f => `${f.provider}${f.status ? ` (${f.status})` : ''}`).join(', ')}`);
    this.name = 'LlmUnavailableError';
  }
}

/** Thrown when someone asks for a person the bot doesn't know (not in TEAM_MEMBERS). */
export class UnknownTeamMemberError extends Error {
  constructor(public readonly requested: string) {
    super(`Unknown team member: ${requested}`);
    this.name = 'UnknownTeamMemberError';
  }
}

export type ErrorKind =
  | 'llm_auth'
  | 'llm_quota'
  | 'llm_rate'
  | 'llm_down'
  | 'github_auth'
  | 'github_forbidden'
  | 'github_not_found'
  | 'github_assignee'
  | 'github_validation'
  | 'slack'
  | 'unknown_member'
  | 'unknown';

export interface FriendlyError {
  kind: ErrorKind;
  /** Safe to post in Slack. */
  userMessage: string;
  /** For the DevOps team: what to check. Never contains secrets. */
  adminHint: string;
  /** Config problems the team must fix → ping them. */
  notifyTeam: boolean;
  /** Short id that ties the Slack message to the full log entry. */
  ref: string;
}

export function teamListText(): string {
  return config.team.map(m => `*${m.githubUsername}*`).join(', ') || '(nobody configured)';
}

export function unknownMemberMessage(requested: string): string {
  return (
    `I don't know “${requested}”. The DevOps teammates I can assign to are: ${teamListText()}.\n` +
    `If ${requested} should be on the list, an admin needs to add their Slack ID and GitHub username to \`TEAM_MEMBERS\` in the bot's settings.`
  );
}

function newRef(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function explainError(err: unknown, opts: { log?: boolean } = {}): FriendlyError {
  const ref = newRef();
  if (opts.log !== false) console.error(`❌ [ref ${ref}]`, err);
  const make = (kind: ErrorKind, userMessage: string, adminHint: string, notifyTeam = false): FriendlyError => ({
    kind,
    userMessage: `⚠️ ${userMessage}`,
    adminHint,
    notifyTeam,
    ref,
  });
  const retry = 'Your request wasn’t lost — please try again in a few minutes, or ask a teammate to handle it directly.';

  if (err instanceof UnknownTeamMemberError) {
    return make('unknown_member', unknownMemberMessage(err.requested), 'Add the person to TEAM_MEMBERS.');
  }

  if (err instanceof LlmUnavailableError) {
    const statuses = err.failures.map(f => f.status);
    const which = err.failures.map(f => f.provider).join(' / ');
    if (statuses.some(s => s === 401 || s === 403)) {
      return make(
        'llm_auth',
        `I can’t think right now — my AI provider (${which}) is rejecting the bot’s API key. That’s a setup problem on our side, not something you did. I’ve flagged it for the DevOps team. ${retry}`,
        `${which} rejected the API key (HTTP 401/403). Check the key in the bot's .env (no quotes/spaces), then restart the bot.`,
        true
      );
    }
    if (statuses.some(s => s === 402)) {
      return make(
        'llm_quota',
        `I can’t think right now — the AI provider account (${which}) is out of credit. I’ve flagged it for the DevOps team. ${retry}`,
        `${which} reports insufficient balance/quota (HTTP 402). Top up or switch LLM_PROVIDER.`,
        true
      );
    }
    if (statuses.some(s => s === 429)) {
      return make('llm_rate', `My AI provider (${which}) is rate-limiting me right now. Please try again in a minute.`, `${which} returned HTTP 429.`);
    }
    return make('llm_down', `My AI provider (${which}) isn’t responding right now. ${retry}`, `${which} unavailable: ${err.failures.map(f => f.status ?? 'timeout/network').join(', ')}.`);
  }

  const status: number | undefined = (err as any)?.status;
  const message = String((err as any)?.message ?? '');

  // Octokit (GitHub) errors carry an HTTP status and a `response`
  if (typeof status === 'number' && String((err as any)?.response?.url ?? '').includes('github')) {
    if (status === 401) {
      return make('github_auth', `GitHub rejected the bot’s access token, so I couldn’t update the issue. I’ve flagged it for the DevOps team. ${retry}`, 'GITHUB_TOKEN is invalid/expired (HTTP 401).', true);
    }
    if (status === 403) {
      return make('github_forbidden', 'GitHub refused that action (permissions or rate limit). Please try again shortly.', 'GitHub returned 403 — check token scopes (repo, project) and rate limits.');
    }
    if (status === 404) {
      return make('github_not_found', 'I couldn’t find that on GitHub — the issue number may be wrong, or the bot can’t see that repo.', 'GitHub returned 404 — check the issue number, GITHUB_OWNER/GITHUB_REPO and token access.');
    }
    if (status === 422) {
      if (/assignee/i.test(message) || /assignee/i.test(JSON.stringify((err as any)?.response?.data ?? ''))) {
        return make(
          'github_assignee',
          'GitHub won’t accept that assignee — they need to be a collaborator on the issues repo, and the GitHub username in `TEAM_MEMBERS` must match exactly.',
          'GitHub 422 on assignee: add the user as a repo collaborator / fix the username in TEAM_MEMBERS.'
        );
      }
      return make('github_validation', 'GitHub rejected that change as invalid. I’ve logged the details for the team.', 'GitHub returned 422 — see logs for the validation message.');
    }
  }

  if (typeof (err as any)?.data?.error === 'string') {
    const code: string = (err as any).data.error;
    return make('slack', `Slack didn’t let me do that (${code.replace(/_/g, ' ')}).`, `Slack API error: ${code}.`, code === 'missing_scope' || code === 'invalid_auth');
  }

  return make('unknown', `Something unexpected went wrong on my side. I’ve logged it — if it keeps happening, tell the DevOps team and mention ref \`${ref}\`.`, `Unexpected error (ref ${ref}) — see logs.`);
}

// Don't ping the team about the same config problem more than once per 30 minutes.
const lastAlert = new Map<ErrorKind, number>();
export function shouldAlertTeam(kind: ErrorKind, nowMs = Date.now()): boolean {
  const last = lastAlert.get(kind) ?? 0;
  if (nowMs - last < 30 * 60_000) return false;
  lastAlert.set(kind, nowMs);
  return true;
}
export function resetAlertsForTests(): void {
  lastAlert.clear();
}
