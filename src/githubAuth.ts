import fs from 'node:fs';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { config } from './config.js';

/**
 * Which GitHub identity does the bot act as?
 *
 *   app    → an organisation-owned GitHub App. Everything the bot does shows up as "<app-name>[bot]".
 *            (Tokens are minted from the App's private key and refreshed automatically — nothing to rotate by hand.)
 *   token  → a personal access token (everything shows up under that person's name). Kept as a fallback.
 *
 * People who act directly on GitHub are unaffected — they always appear as themselves.
 */

export type GithubAuthMode = 'app' | 'token' | 'none';

export function isAppConfigured(): boolean {
  const a = config.github.app;
  return Boolean(a.appId && a.installationId && (a.privateKey || a.privateKeyPath));
}

export function githubAuthMode(): GithubAuthMode {
  if (isAppConfigured()) return 'app';
  return config.github.token ? 'token' : 'none';
}

/** The PEM, from GITHUB_APP_PRIVATE_KEY (with \n escapes) or from the file named by GITHUB_APP_PRIVATE_KEY_PATH. */
export function loadPrivateKey(): string {
  const a = config.github.app;
  if (a.privateKey) return a.privateKey.replace(/\\n/g, '\n');
  if (a.privateKeyPath) {
    try {
      return fs.readFileSync(a.privateKeyPath, 'utf8');
    } catch (err) {
      throw new Error(`Could not read the GitHub App private key at ${a.privateKeyPath}: ${(err as Error).message}`);
    }
  }
  throw new Error('GitHub App private key is not configured (set GITHUB_APP_PRIVATE_KEY_PATH).');
}

/** One Octokit for the whole bot; with an App it mints/refreshes installation tokens on its own. */
export function createOctokit(): Octokit {
  if (isAppConfigured()) {
    const a = config.github.app;
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: a.appId, privateKey: loadPrivateKey(), installationId: a.installationId },
    });
  }
  return new Octokit({ auth: config.github.token });
}

export function describeGithubIdentity(): string {
  switch (githubAuthMode()) {
    case 'app':
      return `✓ GitHub identity: GitHub App #${config.github.app.appId} (installation ${config.github.app.installationId}) — bot actions appear as "<app>[bot]"`;
    case 'token':
      return '⚠️ GitHub identity: personal access token — bot actions appear under that person\'s name. Configure a GitHub App to fix this (docs/github-app-setup.md).';
    default:
      return '✗ GitHub identity: nothing configured (set GITHUB_APP_* or GITHUB_TOKEN)';
  }
}

/** True for logins like "navg-taskbot[bot]". */
export const isBotLogin = (login: string | undefined | null): boolean => Boolean(login && login.endsWith('[bot]'));
