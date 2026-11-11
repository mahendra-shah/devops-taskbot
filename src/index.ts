import { config } from './config.js';
import { ensureLabelsExist } from './github.js';
import { startSlackBot } from './slack.js';

(async () => {
  console.log('🚀 DevOps Tracker Bot starting...');
  console.log(`   Provider: ${config.llm.provider.toUpperCase()}`);
  console.log(`   GitHub: ${config.github.owner}/${config.github.repo}`);
  console.log(`   Devops Channel: ${config.slack.devopsChannelId}`);
  console.log(`   Team: ${config.team.map(m => `${m.slackId}→${m.githubUsername}`).join(', ')}`);

  // 1. Ensure all required GitHub labels exist in the repo
  console.log('\n📌 Ensuring GitHub labels are set up...');
  await ensureLabelsExist();

  // 2. Start the Slack bot (Socket Mode WebSocket connection)
  console.log('\n🔌 Connecting to Slack...');
  await startSlackBot();

  console.log('\n✅ All systems go! Monitoring Slack devops channel for tasks.\n');
})();

// ============================================================
//  Graceful shutdown
// ============================================================
async function shutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down DevOps Tracker Bot...`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err);
  if (err.message?.includes('socket-mode') || err.message?.includes('Unhandled event')) {
    console.warn('⚠️ Slack Socket Mode transient error — continuing.');
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 Unhandled Promise Rejection:', reason);
});
