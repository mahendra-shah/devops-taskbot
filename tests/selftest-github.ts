process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:';

import { config } from '../src/config.js';
import { liveGitHubProvider } from '../src/github.js';
import { AuditedGitHubProvider, runWithAudit, setIssueExtras } from '../src/audit.js';
import { liveProjectBoard } from '../src/projectBoard.js';
import { createOctokit, describeGithubIdentity } from '../src/githubAuth.js';

/**
 * LIVE end-to-end self-test of the real code path against GitHub.
 * Creates ONE throwaway, UNASSIGNED issue ("[Taskbot self-test] …"), changes its status / priority / target date,
 * reads everything back, then closes it. Nobody is notified.
 *
 *   npm run selftest:github -- --yes
 */
const ok = (m: string) => console.log(`  ✓ ${m}`);
let failures = 0;
const bad = (m: string) => {
  console.log(`  ✗ ${m}`);
  failures++;
};

async function main() {
  console.log('\n' + describeGithubIdentity());
  if (!process.argv.includes('--yes')) {
    console.log(`\nThis creates ONE throwaway issue in ${config.github.owner}/${config.github.repo} (unassigned, closed at the end).\nRe-run with:  npm run selftest:github -- --yes\n`);
    return;
  }

  const { owner, repo } = config.github;
  const octokit = createOctokit();
  const github = new AuditedGitHubProvider(liveGitHubProvider, { board: liveProjectBoard });
  const ctx = { actorId: 'SELFTEST', actorName: 'Taskbot self-test', via: 'selftest script' };

  const readBack = async (n: number) => {
    const issue = (await octokit.rest.issues.get({ owner, repo, issue_number: n })).data;
    const values = (
      await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
        owner,
        repo,
        issue_number: n,
        headers: { 'X-GitHub-Api-Version': '2026-03-10' },
      })
    ).data as any[];
    const fv = (name: string) => values.find(v => v.issue_field_name === name);
    // a fresh board read (the board caches for a few seconds)
    (liveProjectBoard as any).snap = null;
    const board = (await liveProjectBoard.snapshot([n])).items.get(n) ?? {};
    return {
      issue,
      priority: fv('Priority')?.single_select_option?.name as string | undefined,
      effort: fv('Effort')?.single_select_option?.name as string | undefined,
      target: fv('Target date')?.value as string | undefined,
      board,
      labels: issue.labels.map((l: any) => (typeof l === 'string' ? l : l.name)) as string[],
    };
  };

  console.log('\n1) Create (priority Low, effort low, ~1 h)');
  const created = await runWithAudit(ctx, async () => {
    setIssueExtras({ estimateHours: 1 });
    return github.createIssue(
      {
        title: '[Taskbot self-test] safe to ignore — closes itself',
        body: 'Created by the Taskbot self-test (`npm run selftest:github`). It verifies identity, issue fields, the project board and cleanup, then closes.',
        priority: 'P3',
        estimate: 'low',
      },
      '',
      'selftest',
      'SELFTEST'
    );
  });
  const n = created.number;
  console.log(`   issue #${n}  ${created.url}`);
  let s = await readBack(n);
  s.issue.user?.type === 'Bot' ? ok(`author is ${s.issue.user.login} (a bot, not a person)`) : bad(`author is ${s.issue.user?.login} (${s.issue.user?.type}) — expected the App`);
  s.priority === 'Low' ? ok('Priority issue field = Low') : bad(`Priority issue field = ${s.priority}`);
  s.effort === 'Low' ? ok('Effort issue field = Low') : bad(`Effort issue field = ${s.effort}`);
  s.board.status === 'open' ? ok('project card Status = Todo') : bad(`project card Status = ${s.board.status}`);
  !s.labels.some(l => /^P[0-3]$/.test(l) || l === 'in-progress') ? ok(`no P*/in-progress labels (labels: ${s.labels.join(', ')})`) : bad(`unexpected labels: ${s.labels.join(', ')}`);

  console.log('\n2) 👀 → In Progress, then priority → Urgent, ETA → Target date');
  await runWithAudit(ctx, async () => {
    await github.updateIssueStatus(n, 'in-progress');
    await github.updateIssueMeta(n, { priority: 'P0' });
    await github.setTargetDate?.(n, '2026-12-31');
  });
  s = await readBack(n);
  s.board.status === 'in-progress' ? ok('project card Status = In Progress') : bad(`project card Status = ${s.board.status}`);
  s.priority === 'Urgent' ? ok('Priority issue field = Urgent') : bad(`Priority issue field = ${s.priority}`);
  s.target === '2026-12-31' ? ok('Target date issue field = 2026-12-31') : bad(`Target date = ${s.target}`);
  (await github.getIssueByNumber(n))!.labels.includes('in-progress') ? ok('the bot reads it back as in-progress (from the board)') : bad('overlay did not show in-progress');

  console.log('\n3) ✅ → Done and closed');
  await runWithAudit(ctx, () => github.updateIssueStatus(n, 'done'));
  s = await readBack(n);
  s.issue.state === 'closed' ? ok('issue is closed') : bad(`issue state = ${s.issue.state}`);
  s.board.status === 'done' ? ok('project card Status = Done') : bad(`project card Status = ${s.board.status}`);
  const comments = (await octokit.rest.issues.listComments({ owner, repo, issue_number: n })).data;
  comments.length > 0 && comments.every(c => c.user?.type === 'Bot') ? ok(`${comments.length} audit comments, all posted by ${comments[0].user?.login}`) : bad('some comments were not posted by the bot');

  console.log(failures === 0 ? `\n🎉 Live self-test passed — issue #${n} is closed.\n` : `\n❌ ${failures} check(s) failed — issue #${n} was left closed for inspection.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('\n✗ Self-test crashed:', err.message, '\n');
  process.exit(1);
});
