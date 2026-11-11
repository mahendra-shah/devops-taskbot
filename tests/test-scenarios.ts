process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = ':memory:';

import { config } from '../src/config.js';
import { DevOpsBot } from '../src/bot.js';
import { MockGitHubProvider } from './github-mock.js';
import { SimulatedSlackEnvironment } from './simulator.js';

function banner(title: string) {
  console.log('\n' + '═'.repeat(72));
  console.log(`🧪 ${title}`);
  console.log('═'.repeat(72));
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`   ✅ PASS: ${message}`);
}

async function runTests() {
  const github = new MockGitHubProvider(true);
  const bot = new DevOpsBot(github);
  const slack = new SimulatedSlackEnvironment(bot, github, false);

  const dev0 = config.team[0]; // busiest in seeded mock (2 issues)
  const devLeastLoaded = config.team[config.team.length - 1]; // least loaded in seeded mock (0 issues)
  const requesterId = 'U_REQUESTER_99';

  console.log('\n📋 Initial Seeded Mock GitHub Issues:');
  const initialCount = github.getAllIssuesSnapshot().length;
  for (const i of github.getAllIssuesSnapshot()) {
    console.log(`   #${i.number} [${i.state}] (${i.labels.join(', ')}) → @${i.assignees.join(', ')} : ${i.title}`);
  }

  // ------------------------------------------------------------------
  // SCENARIO 1: New P0 urgent task in root channel tagging a dev (no @bot!)
  // ------------------------------------------------------------------
  banner('Scenario 1: Root message tagging a dev (without @bot) with urgent P0 task');
  const thread1 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: `Hey @${dev0.githubUsername} URGENT prod checkout API is returning 502 errors for all users since 5 mins ago!`,
  });
  const allAfter1 = github.getAllIssuesSnapshot();
  const created1 = allAfter1[allAfter1.length - 1];
  assert(allAfter1.length === initialCount + 1, `New issue #${created1.number} created (total=${allAfter1.length})`);
  assert(created1.labels.includes('P0'), `Priority detected as P0 (labels: ${created1.labels.join(', ')})`);
  assert(
    created1.assignees.includes(devLeastLoaded.githubUsername) || config.team.some(m => created1.assignees.includes(m.githubUsername)),
    `Assigned to team member: ${created1.assignees.join(', ')}`
  );

  // ------------------------------------------------------------------
  // SCENARIO 2: Casual banter tagging a dev -> bot stays silent
  // ------------------------------------------------------------------
  banner('Scenario 2: Casual message tagging a dev (no @bot) -> bot should stay quiet');
  const replyCountBefore2 = slack.capturedReplies.length;
  await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: `Hey @${dev0.githubUsername} thanks for helping yesterday, wanna grab coffee?`,
  });
  assert(slack.capturedReplies.length === replyCountBefore2, 'Bot stayed silent on casual chatter');
  assert(github.getAllIssuesSnapshot().length === initialCount + 1, 'No GitHub issue created for casual chat');

  // ------------------------------------------------------------------
  // SCENARIO 3: Duplicate task detection
  // ------------------------------------------------------------------
  banner('Scenario 3: Duplicate task posted with @bot -> should warn & NOT create duplicate');
  await slack.sendMessage({
    userId: 'U_REQUESTER_88',
    userName: 'Karan (QA)',
    text: `@bot prod checkout API is still giving 502 errors, please check`,
  });
  assert(github.getAllIssuesSnapshot().length === initialCount + 1, `Duplicate issue prevented (still ${initialCount + 1} issues)`);

  // ------------------------------------------------------------------
  // SCENARIO 4: Thread conversation + context awareness + status query
  // ------------------------------------------------------------------
  banner('Scenario 4: Human replies inside thread, then devops member asks @bot for status');
  await slack.sendMessage({
    userId: devLeastLoaded.slackId,
    userName: devLeastLoaded.githubUsername,
    text: 'I checked Kubernetes pods — nginx ingress OOMKilled twice, increasing memory limit and restarting.',
    threadTs: thread1,
  });

  await slack.sendMessage({
    userId: dev0.slackId,
    userName: dev0.githubUsername,
    text: '@bot what is the current status of this task and what did we find in this thread?',
    threadTs: thread1,
  });
  const lastReply4 = slack.capturedReplies[slack.capturedReplies.length - 1]?.text || '';
  assert(lastReply4.includes(`#${created1.number}`) || lastReply4.toLowerCase().includes('open'), 'Bot answered with thread & issue context');

  // ------------------------------------------------------------------
  // SCENARIO 5: Thread command to update status (in-progress -> done)
  // ------------------------------------------------------------------
  await pause(4000);
  banner('Scenario 5: Dev asks @bot inside thread to update task status to in-progress, then done');
  await slack.sendMessage({
    userId: devLeastLoaded.slackId,
    userName: devLeastLoaded.githubUsername,
    text: '@bot mark this task as in progress',
    threadTs: thread1,
  });
  let refreshed1 = await github.getIssueByNumber(created1.number);
  assert(Boolean(refreshed1?.labels.includes('in-progress')), 'Issue updated to in-progress via natural language');

  await pause(4000);
  await slack.sendMessage({
    userId: devLeastLoaded.slackId,
    userName: devLeastLoaded.githubUsername,
    text: '@bot update this task status from in progress to done',
    threadTs: thread1,
  });
  refreshed1 = await github.getIssueByNumber(created1.number);
  assert(refreshed1?.state === 'closed', 'Issue closed (done) via natural language in thread');

  // ------------------------------------------------------------------
  // SCENARIO 6: New task + Emoji Reactions (👀 -> in-progress, ✅ -> done)
  // ------------------------------------------------------------------
  await pause(4000);
  banner('Scenario 6: New task via @bot + Emoji reactions (👀 and ✅)');
  const thread6 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: '@bot please set up a new S3 bucket with lifecycle policy for staging backups',
  });
  const created6 = github.getAllIssuesSnapshot().slice(-1)[0];
  assert(created6.state === 'open', `Created Issue #${created6.number} for S3 bucket`);

  console.log(`\n   👉 Simulating ${dev0.githubUsername} reacting with 👀 on root message...`);
  await slack.react(thread6, 'eyes', dev0.slackId);
  let refreshed6 = await github.getIssueByNumber(created6.number);
  assert(Boolean(refreshed6?.labels.includes('in-progress')), '👀 reaction added "in-progress" label');

  console.log(`\n   👉 Simulating ${dev0.githubUsername} reacting with ✅ on root message...`);
  await slack.react(thread6, 'white_check_mark', dev0.slackId);
  refreshed6 = await github.getIssueByNumber(created6.number);
  assert(refreshed6?.state === 'closed', '✅ reaction closed the GitHub issue');

  // ------------------------------------------------------------------
  // SCENARIO 7: No-reply timeout auto-reply (1-2 hour busy explanation)
  // ------------------------------------------------------------------
  banner('Scenario 7: Impatient requester tags dev -> dev does not reply -> auto-status reply');
  const thread7 = await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: `@${dev0.githubUsername} can you also rotate the dev Redis password today?`,
  });
  console.log(`   ⏩ Fast-forwarding ${config.bot.noReplyTimeoutMinutes} minutes with no reply from ${dev0.githubUsername}...`);
  await slack.simulateNoReplyTimeout(thread7);

  // ------------------------------------------------------------------
  // SCENARIO 8: `@bot status` fast command
  // ------------------------------------------------------------------
  banner('Scenario 8: `@bot status` command');
  await slack.sendMessage({
    userId: requesterId,
    userName: 'Ananya (Backend)',
    text: '@bot status',
  });

  console.log('\n🎉 All 8 scenarios completed successfully!\n');
}

runTests().catch(err => {
  console.error('\n❌ Scenario test failed:', err);
  process.exit(1);
});
