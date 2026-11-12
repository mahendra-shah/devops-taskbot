process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:';

import { config } from '../src/config.js';
import { DevOpsBot, type AgentRunner } from '../src/bot.js';
import { AuditedGitHubProvider, runWithAudit, setAssignmentNote, setIssueExtras } from '../src/audit.js';
import { composeIssueBody } from '../src/llm.js';
import { resolveRequester, slackToPlain } from '../src/utils/helpers.js';
import { PRIORITY_NAMES } from '../src/types.js';
import { MockGitHubProvider } from './github-mock.js';
import { FakeBoard } from './fake-board.js';
import { SimulatedSlackEnvironment } from './simulator.js';

/**
 * Prints what a bot-created issue will look like — the GitHub issue, the board card, and the Slack messages —
 * using a mock GitHub and a fake board set up like "DevOps queries" (Todo / In Progress / Done; Urgent / High / Medium / Low).
 * Nothing real is touched.   npm run preview:issue
 */
config.team.splice(0, config.team.length, { slackId: 'UMAHENDRA1', githubUsername: 'mahendra-shah' }, { slackId: 'UKOMAL0001', githubUsername: 'komal-gh' });

const LLM_BODY = `## Request
Grant Renuka Chouhan's AWS user write/upload access (\`s3:PutObject\`, \`s3:GetObject\`, \`s3:ListBucket\`) on the \`navgurukul-ears-clips\` S3 bucket.

## Context
- The deployed Audio Evaluation Platform reads audio from \`navgurukul-ears-clips\`, but Renuka originally uploaded files to \`navgurukul-ears-raw\`.
- She will frequently update \`manifest.json\` and add samples under \`clips/\` while testing new TTS model iterations.

## Definition of done
- [ ] IAM policy grants PutObject / GetObject / ListBucket on the bucket (and \`clips/*\`)
- [ ] Renuka confirms she can upload a sample and update \`manifest.json\``;

const runner: AgentRunner = async ({ event, threadHistory, github }) => {
  const threadRoot = event.threadTs || event.ts;
  const requester = resolveRequester(event, threadHistory, threadRoot);
  const nameOf = (id: string) => config.team.find(m => m.slackId === id)?.githubUsername;
  setAssignmentNote('picked the lowest-load available dev. Load scores: mahendra-shah=0, komal-gh=0.');
  setIssueExtras({ estimateHours: 1 });
  const issue = await github.createIssue(
    {
      title: 'Grant S3 write permissions to Renuka Chouhan for navgurukul-ears-clips bucket',
      body: composeIssueBody(LLM_BODY, {
        requesterName: requester.name,
        originalText: slackToPlain(requester.text, nameOf),
        askedBy: requester.fromThreadRoot && requester.id !== event.userId ? { name: event.userName, text: slackToPlain(event.text, nameOf) } : undefined,
        priority: 'P1',
        estimate: 'low',
        estimateHours: 1,
      }),
      priority: 'P1',
      estimate: 'low',
    },
    'mahendra-shah',
    threadRoot,
    event.channelId
  );
  return {
    replyText: `I've created issue <${issue.url}|#${issue.number}>: *${issue.title}* — *${PRIORITY_NAMES.P1}* priority, ~1 h, assigned to *mahendra-shah*.`,
    createdIssue: issue,
    createdTaskPriority: 'P1',
    assignedGithubUsername: 'mahendra-shah',
  };
};

const line = (t: string) => console.log('\n' + '━'.repeat(8) + ' ' + t + ' ' + '━'.repeat(Math.max(2, 60 - t.length)));

async function main() {
  const mock = new MockGitHubProvider(false, { boardMode: true });
  const board = new FakeBoard();
  const github = new AuditedGitHubProvider(mock, { board });
  const bot = new DevOpsBot(github, runner, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, true);
  for (const m of config.team) slack.setProfile(m.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: m.githubUsername, realName: m.githubUsername });

  const originalLog = console.log;
  const quiet = async <T>(fn: () => Promise<T>) => {
    console.log = () => {};
    try { return await fn(); } finally { console.log = originalLog; }
  };

  const t = await quiet(async () => {
    const root = await slack.sendMessage({ userId: 'URENUKA01', userName: 'Renuka Chouhan', text: 'Could you please grant my AWS user write/upload permissions for the navgurukul-ears-clips bucket? I will be updating manifest.json and clips/ often while testing new TTS models.' });
    await slack.sendMessage({ userId: 'UMAHENDRA1', userName: 'Mahendra', text: '@bot could you add this to github and assign it to me?', threadTs: root });
    return root;
  });

  const render = async (title: string) => {
    const raw = mock.getAllIssuesSnapshot()[0];
    const card = board.cards.get(1)!;
    line(title);
    console.log(`Title:     ${raw.title}  #${raw.number}   [${raw.state}]`);
    console.log(`Assignee:  ${raw.assignees.join(', ')}`);
    console.log(`Labels:    ${raw.labels.join(', ')}`);
    console.log(`Board:     Status = ${card.status} | Priority = ${card.priority} | Effort = ${card.effort} | Estimate = ${card.hours ?? '—'} h`);
  };

  await render('1. Issue as created');
  line('Issue body (what people read on GitHub)');
  console.log(mock.getAllIssuesSnapshot()[0].body.replace(/\n\n---\n📎.*$/s, '').trim());
  line('Comments on the issue');
  for (const c of (await mock.getIssueByNumber(1))!.comments!) console.log(c.body + '\n');
  line('Slack thread (bot replies)');
  for (const r of slack.capturedReplies.filter(r => r.threadTs === t)) console.log(`NavG: ${r.text}\n`);

  await quiet(() => slack.react(t, 'eyes', 'UMAHENDRA1'));
  await render('2. After 👀  (card moves, NO in-progress label)');

  await quiet(() => runWithAudit({ actorId: 'UMAHENDRA1', actorName: 'Mahendra', via: 'Slack message to @bot' }, () => github.updateIssueMeta(1, { priority: 'P0' })));
  await render('3. After "make this urgent"');

  const before = slack.capturedReplies.length;
  await quiet(() => slack.react(t, 'white_check_mark', 'UKOMAL0001'));
  await render('4. After ✅ by komal-gh');
  line('Slack: requester is told (Renuka, not Mahendra)');
  for (const r of slack.capturedReplies.slice(before)) console.log(`NavG: ${r.text}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
