process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:';

import { config } from '../src/config.js';
import { createOctokit, describeGithubIdentity, githubAuthMode } from '../src/githubAuth.js';
import { liveProjectBoard } from '../src/projectBoard.js';

/**
 * Read-only: shows which GitHub identity the bot uses and whether it has what it needs. Writes nothing.
 *   npm run check:github
 */
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);

async function main() {
  console.log('\n' + describeGithubIdentity() + '\n');
  const mode = githubAuthMode();
  if (mode === 'none') process.exit(1);
  const octokit = createOctokit();
  const { owner, repo } = config.github;

  if (mode === 'app') {
    // App-level calls need a short-lived JWT (not the installation token)
    const jwt = (await octokit.auth({ type: 'app' })) as { token: string };
    const asApp = { headers: { authorization: `bearer ${jwt.token}` } };
    const app: any = (await octokit.request('GET /app', asApp)).data;
    ok(`App: "${app.name}" (slug ${app.slug}) — bot actions will appear as "${app.slug}[bot]"`);

    const inst: any = (await octokit.request('GET /app/installations/{installation_id}', { installation_id: config.github.app.installationId, ...asApp })).data;
    ok(`Installed on ${inst.account?.login} (${inst.repository_selection === 'all' ? 'all repositories' : 'selected repositories'})`);

    const perms: Record<string, string> = inst.permissions ?? {};
    const need: Array<[string, string, string]> = [
      ['issues', 'write', 'Repository → Issues: Read & write (create, label, assign, comment, close)'],
      ['organization_projects', 'write', 'Organization → Projects: Read & write (the project board)'],
    ];
    for (const [key, level, label] of need) {
      const have = perms[key];
      if (have === level || have === 'admin') ok(`Permission ${label}`);
      else bad(`Missing permission — ${label} (currently: ${have ?? 'none'})`);
    }

    const repos: any = (await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 })).data;
    const names: string[] = repos.repositories.map((r: any) => r.full_name);
    if (names.map(n => n.toLowerCase()).includes(`${owner}/${repo}`.toLowerCase())) ok(`Can access ${owner}/${repo}`);
    else bad(`The App is NOT installed on ${owner}/${repo} (it can see: ${names.join(', ') || 'nothing'})`);
  } else {
    const me = (await octokit.rest.users.getAuthenticated()).data;
    ok(`Token belongs to "${me.login}" — everything the bot does will show under that name`);
  }

  try {
    const { data } = await octokit.rest.issues.listForRepo({ owner, repo, state: 'open', per_page: 1 });
    ok(`Can read issues in ${owner}/${repo} (${data.length ? 'has open issues' : 'no open issues'})`);
  } catch (err) {
    bad(`Cannot read issues in ${owner}/${repo}: ${(err as Error).message}`);
  }

  if (liveProjectBoard.enabled) {
    try {
      console.log('');
      for (const line of await liveProjectBoard.diagnose()) console.log('  ' + line);
    } catch (err) {
      bad(`Project board not readable: ${(err as Error).message}`);
    }
  } else {
    console.log('\n  ℹ️ GITHUB_PROJECT_NUMBER not set — board sync is off.');
  }
  console.log('');
}

main().catch(err => {
  console.error('\n✗ Check failed:', err.message, '\n');
  process.exit(1);
});
