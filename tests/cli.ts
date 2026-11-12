process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.STATE_DB_PATH = process.env.STATE_DB_PATH || ':memory:'; // simulator never touches the real state DB

import readline from 'readline';
import { config } from '../src/config.js';
import { DevOpsBot } from '../src/bot.js';
import { liveGitHubProvider } from '../src/github.js';
import { MockGitHubProvider } from './github-mock.js';
import { SimulatedSlackEnvironment } from './simulator.js';
import type { GitHubProvider } from '../src/types.js';
import { runEscalationCheck } from '../src/escalation.js';
import { runClosurePoll } from '../src/requesterUpdates.js';
import { availabilityService, describeAvailability } from '../src/availability.js';
import { listAuditSince } from '../src/store.js';

const isLiveGitHub = process.argv.includes('--live');

async function main() {
  const github: GitHubProvider = isLiveGitHub ? liveGitHubProvider : new MockGitHubProvider(true);
  if (isLiveGitHub) {
    console.log('⚠️  LIVE GITHUB MODE: Real issues will be created/updated in ' + `${config.github.owner}/${config.github.repo}`);
  } else {
    console.log('🧪 SANDBOX MODE (Mock GitHub): Safe testing — no real GitHub issues will be modified. Pass --live to use real GitHub.');
  }

  const bot = new DevOpsBot(github);
  const slack = new SimulatedSlackEnvironment(bot, github, false);

  let currentThreadTs: string | undefined;
  let currentUserId = config.team[0]?.slackId || 'U_DEV_1';
  let currentUserName = config.team[0]?.githubUsername || 'DevOps Member';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function printHelp() {
    console.log(`
Commands:
  /new                     Start a new root Slack channel message (exit current thread)
  /threads                 List all active threads in this session
  /thread <ts>             Switch into a specific thread
  /as <name|requester>     Switch who is talking (e.g. /as requester or /as ${config.team[0]?.githubUsername || 'dev'})
  /react <emoji>           React to current thread: eyes (👀), done (✅), blocked (🚫), zzz (💤)
  /timeout                 Trigger the "no-reply after ${config.bot.noReplyTimeoutMinutes}m" auto-status reply now
  /issues                  List open GitHub issues
  /ooo <dev> <text>        Set a dev's Slack STATUS text, e.g. /ooo ${config.team[0]?.githubUsername || 'dev'} OOO till 15 Nov   (no date = today only)
  /dname <dev> <text>      Set a dev's Slack DISPLAY NAME, e.g. /dname ${config.team[0]?.githubUsername || 'dev'} ${config.team[0]?.githubUsername || 'dev'} [Leave 12-14 Nov]
  /fname <dev> <text>      Set a dev's FULL NAME the same way
  /back <dev>              Clear a dev's status / restore names
  /who                     Show who the bot thinks is out of office
  /escalate <minutes>      Fast-forward the P0 escalation check by N minutes
  /ghclose <issue#>        Close an issue directly on GitHub, then run the requester-update poll
  /audit                   Show the audit log
  /help                    Show this help
  /exit                    Quit

Tips:
  • Tag "@bot" (e.g. "@bot prod db is slow") or tag a teammate ("@${config.team[0]?.githubUsername || 'dev'} check staging")
  • Inside a thread, messages WITHOUT "@bot" simulate normal team chat (bot stays quiet & remembers context!)
  • Tag "@bot" inside a thread to ask "what is the status of this task?" or "update status to done"
`);
  }

  function promptStr(): string {
    const loc = currentThreadTs ? `thread:${currentThreadTs.slice(-6)}` : 'channel-root';
    return `[${currentUserName} @ ${loc}]> `;
  }

  console.log('\n💬 DevOps Taskbot Interactive Simulator (No Slack Needed)');
  console.log(`   Team: ${config.team.map(m => m.githubUsername).join(', ')}`);
  printHelp();

  const ask = () => {
    rl.question(promptStr(), async (line) => {
      const input = line.trim();
      if (!input) {
        ask();
        return;
      }

      if (input === '/exit' || input === '/quit') {
        rl.close();
        process.exit(0);
      }

      if (input === '/help') {
        printHelp();
        ask();
        return;
      }

      if (input === '/new') {
        currentThreadTs = undefined;
        console.log('📌 Switched to channel root (next message starts a new thread).');
        ask();
        return;
      }

      if (input === '/threads') {
        const ids = slack.listThreadIds();
        if (ids.length === 0) {
          console.log('No threads yet.');
        } else {
          for (const id of ids) {
            const t = slack.getThread(id);
            const first = t?.messages[0]?.content || '';
            const marker = id === currentThreadTs ? ' ← current' : '';
            console.log(`  • ${id}: "${first.slice(0, 60)}" (${t?.messages.length || 0} msgs)${marker}`);
          }
        }
        ask();
        return;
      }

      if (input.startsWith('/thread ')) {
        const target = input.slice('/thread '.length).trim();
        const match = slack.listThreadIds().find(id => id === target || id.endsWith(target));
        if (!match) {
          console.log(`❌ Thread "${target}" not found. Use /threads to list.`);
        } else {
          currentThreadTs = match;
          console.log(`📌 Switched to thread ${match}.`);
        }
        ask();
        return;
      }

      if (input.startsWith('/as ')) {
        const who = input.slice('/as '.length).trim().toLowerCase();
        if (who === 'requester' || who === 'user') {
          currentUserId = 'U_EXTERNAL_USER';
          currentUserName = 'Requester (Product/Backend)';
          console.log(`👤 Now speaking as: ${currentUserName}`);
        } else {
          const member = config.team.find(
            m => m.githubUsername.toLowerCase().includes(who) || m.slackId.toLowerCase() === who
          );
          if (member) {
            currentUserId = member.slackId;
            currentUserName = member.githubUsername;
            console.log(`👤 Now speaking as team member: ${currentUserName} (${currentUserId})`);
          } else {
            console.log(`❌ Unknown user "${who}". Try "requester" or one of: ${config.team.map(m => m.githubUsername).join(', ')}`);
          }
        }
        ask();
        return;
      }

      if (input.startsWith('/react ')) {
        if (!currentThreadTs) {
          console.log('❌ No active thread to react to. Send a message first or /thread <ts>.');
          ask();
          return;
        }
        const rawEmoji = input.slice('/react '.length).trim().toLowerCase();
        const emojiAlias: Record<string, string> = {
          '👀': 'eyes',
          'eyes': 'eyes',
          'in-progress': 'eyes',
          '✅': 'white_check_mark',
          'done': 'white_check_mark',
          'white_check_mark': 'white_check_mark',
          '🚫': 'no_entry',
          'blocked': 'no_entry',
          'no_entry': 'no_entry',
          '💤': 'zzz',
          'zzz': 'zzz',
          'snooze': 'zzz',
        };
        const reaction = emojiAlias[rawEmoji] || rawEmoji.replace(/:/g, '');
        await slack.react(currentThreadTs, reaction, currentUserId);
        ask();
        return;
      }

      if (input === '/timeout') {
        if (!currentThreadTs) {
          console.log('❌ No active thread.');
        } else {
          await slack.simulateNoReplyTimeout(currentThreadTs);
        }
        ask();
        return;
      }

      const findDev = (q: string) => config.team.find(m => m.githubUsername.toLowerCase().includes(q.toLowerCase()) || m.slackId.toLowerCase() === q.toLowerCase());

      if (input.startsWith('/ooo ') || input.startsWith('/dname ') || input.startsWith('/fname ')) {
        const [cmd, who, ...rest] = input.split(/\s+/);
        const dev = findDev(who || '');
        if (!dev) {
          console.log(`❌ Unknown dev "${who}". Try one of: ${config.team.map(m => m.githubUsername).join(', ')}`);
        } else {
          const text = rest.join(' ');
          if (cmd === '/ooo') slack.setProfile(dev.slackId, { statusText: text, statusEmoji: '' });
          if (cmd === '/dname') slack.setProfile(dev.slackId, { displayName: text });
          if (cmd === '/fname') slack.setProfile(dev.slackId, { realName: text });
          console.log(`✓ ${dev.githubUsername}: ${describeAvailability(await availabilityService.get(dev.slackId))}`);
        }
        ask();
        return;
      }

      if (input.startsWith('/back ')) {
        const dev = findDev(input.slice('/back '.length).trim());
        if (dev) {
          slack.setProfile(dev.slackId, { statusText: '', statusEmoji: '', statusExpiration: 0, displayName: dev.githubUsername, realName: dev.githubUsername });
          console.log(`✓ ${dev.githubUsername} is back.`);
        } else console.log('❌ Unknown dev.');
        ask();
        return;
      }

      if (input === '/who') {
        for (const m of config.team) {
          const a = await availabilityService.get(m.slackId);
          console.log(`  • ${m.githubUsername}: ${describeAvailability(a)}${a.available ? '' : ` — ${a.reason}`}`);
        }
        ask();
        return;
      }

      if (input.startsWith('/escalate ')) {
        const mins = parseInt(input.slice('/escalate '.length), 10) || 30;
        await runEscalationCheck(github, slack.createPoster(), Date.now() + mins * 60_000);
        ask();
        return;
      }

      if (input.startsWith('/ghclose ')) {
        const n = parseInt(input.slice('/ghclose '.length), 10);
        if (github instanceof MockGitHubProvider) github.closeDirectly(n);
        await runClosurePoll(github, slack.createPoster());
        ask();
        return;
      }

      if (input === '/audit') {
        for (const r of listAuditSince(0)) {
          console.log(`  ${new Date(r.ts).toISOString().slice(11, 19)} ${r.action}${r.issueNumber ? ` #${r.issueNumber}` : ''} ${r.detail ?? ''}`);
        }
        ask();
        return;
      }

      if (input === '/issues') {
        const issues = github instanceof MockGitHubProvider
          ? github.getAllIssuesSnapshot()
          : await github.getAllOpenIssues();
        if (issues.length === 0) {
          console.log('No issues found.');
        } else {
          for (const i of issues) {
            console.log(`  #${i.number} [${i.state}] (${i.labels.join(', ')}) @${i.assignees.join(', ')} — ${i.title}`);
          }
        }
        ask();
        return;
      }

      try {
        const threadTs = await slack.sendMessage({
          userId: currentUserId,
          userName: currentUserName,
          text: input,
          threadTs: currentThreadTs,
        });
        if (!currentThreadTs) {
          currentThreadTs = threadTs;
          console.log(`   (Now inside thread ${currentThreadTs} — type /new to start a fresh channel message)`);
        }
      } catch (err) {
        console.error('❌ Error:', err);
      }

      ask();
    });
  };

  ask();
}

main().catch(err => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
