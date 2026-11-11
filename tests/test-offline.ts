process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:'; // tests never touch the real state DB

import { config } from '../src/config.js';
import { DevOpsBot } from '../src/bot.js';
import { mockAgentRunner } from './mock-agent.js';
import { MockGitHubProvider } from './github-mock.js';
import { SimulatedSlackEnvironment } from './simulator.js';

function banner(title: string) {
  console.log('\n' + '═'.repeat(72));
  console.log(`🧪 ${title}`);
  console.log('═'.repeat(72));
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`   ✅ PASS: ${message}`);
}

async function runOfflineTests() {
  const github = new MockGitHubProvider(true);
  const bot = new DevOpsBot(github, mockAgentRunner, { classifyTopic: async () => null });
  const slack = new SimulatedSlackEnvironment(bot, github, false);

  const dev0 = config.team[0];
  const requesterId = 'U_REQUESTER_99';
  const initialCount = github.getAllIssuesSnapshot().length;

  // 1. Root message tagging dev without @bot
  banner('Scenario 1: Root message tagging a dev (no @bot) -> P0 task created + timer armed');
  const thread1 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: `Hey @${dev0.githubUsername} URGENT prod checkout API is returning 502 errors!`,
  });
  const created1 = github.getAllIssuesSnapshot().slice(-1)[0];
  assert(github.getAllIssuesSnapshot().length === initialCount + 1, `Created Issue #${created1.number}`);
  assert(created1.labels.includes('P0'), 'Labeled P0');
  assert(Boolean(slack.getThread(thread1)?.pendingTaggedMembers.length), 'No-reply timer armed');

  // 2. Casual chatter tagging dev without @bot -> silent + NO timer
  banner('Scenario 2: Casual banter tagging a dev (no @bot) -> bot stays silent, no timer');
  const repliesBefore = slack.capturedReplies.length;
  const thread2 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: `Hey @${dev0.githubUsername} thanks for yesterday, wanna grab coffee?`,
  });
  assert(slack.capturedReplies.length === repliesBefore, 'Bot stayed silent');
  assert(github.getAllIssuesSnapshot().length === initialCount + 1, 'No issue created');
  assert((slack.getThread(thread2)?.pendingTaggedMembers.length || 0) === 0, 'No-reply timer NOT armed on casual chat');

  // 3. Duplicate detection
  banner('Scenario 3: Duplicate task posted with @bot -> warns without creating duplicate');
  await slack.sendMessage({
    userId: 'U_REQUESTER_88',
    userName: 'Karan (QA)',
    text: '@bot prod checkout API still returning 502 errors',
  });
  assert(github.getAllIssuesSnapshot().length === initialCount + 1, 'Duplicate issue prevented');

  // 4. Thread reply + context-aware status query
  banner('Scenario 4: Human thread message clears timer, @bot reads full thread context');
  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: 'Checked pods — nginx ingress OOMKilled twice, bumping memory limits.',
    threadTs: thread1,
  });
  assert((slack.getThread(thread1)?.pendingTaggedMembers.length || 0) === 0, 'No-reply timer cleared when dev replied');

  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: '@bot what is the current status of this task and what did we find?',
    threadTs: thread1,
  });
  const reply4 = slack.capturedReplies.slice(-1)[0]?.text || '';
  assert(reply4.includes(`#${created1.number}`) && reply4.includes('nginx ingress'), 'Bot answered using GitHub + full thread history');

  // 5. Natural-language status update inside thread
  banner('Scenario 5: Dev asks @bot in thread to update status to in-progress, then done');
  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: '@bot mark this task as in progress',
    threadTs: thread1,
  });
  assert(Boolean((await github.getIssueByNumber(created1.number))?.labels.includes('in-progress')), 'Updated to in-progress');

  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: '@bot update this task status from in progress to done',
    threadTs: thread1,
  });
  assert((await github.getIssueByNumber(created1.number))?.state === 'closed', 'Closed (done) via natural language');

  // 6. Emoji reactions on root OR bot reply
  banner('Scenario 6: New task + Emoji reactions (👀 -> in-progress, ✅ -> done)');
  const thread6 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: '@bot please set up a new S3 bucket for staging backups',
  });
  const created6 = github.getAllIssuesSnapshot().slice(-1)[0];
  await slack.react(thread6, 'eyes', dev0.slackId);
  assert(Boolean((await github.getIssueByNumber(created6.number))?.labels.includes('in-progress')), '👀 marked in-progress');
  await slack.react(thread6, 'white_check_mark', dev0.slackId);
  assert((await github.getIssueByNumber(created6.number))?.state === 'closed', '✅ closed the issue');

  // 7. `@bot status` fast-path
  banner('Scenario 7: `@bot status` fast command');
  await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: '@bot status',
  });
  assert(slack.capturedReplies.slice(-1)[0]?.text.includes('DevOps Workload Status'), 'Returned team workload summary');

  // 8. `@bot assign #1 to <user>` fast-path
  banner('Scenario 8: `@bot assign #1 to <user>` fast command');
  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: `@bot assign #1 to ${dev0.githubUsername}`,
  });
  assert(slack.capturedReplies.slice(-1)[0]?.text.includes('reassigned'), 'Reassigned issue via fast command');

  console.log('\n🎉 ALL 8 OFFLINE TESTS PASSED!\n');
}

runOfflineTests().catch(err => {
  console.error('\n❌ Offline test failed:', err);
  process.exit(1);
});
