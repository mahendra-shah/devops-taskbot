import pkg from '@slack/bolt';
const { App } = pkg;
import { config } from './config.js';
import { liveGitHubProvider } from './github.js';
import { DevOpsBot } from './bot.js';
import type { BotPlatformAdapter, PostMessageFn, ThreadMessage } from './types.js';
import { isTeamMember, setDefaultGitHubProvider } from './utils/workload.js';
import {
  trackPendingReply,
  clearPendingReply,
  snoozeReplyTimer,
  restorePendingReplies,
  startDailyDigest,
} from './scheduler.js';
import { startSlaChecker } from './sla.js';
import { AuditedGitHubProvider } from './audit.js';
import { liveProjectBoard } from './projectBoard.js';
import { checkLlmProviders } from './llm.js';
import { availabilityService, describeAvailability, profileFromSlackUser } from './availability.js';
import { ackThread, startEscalationChecker } from './escalation.js';
import { startClosurePoller } from './requesterUpdates.js';
import { startWeeklyReport } from './report.js';
import { extractMentionedUserIds } from './utils/helpers.js';

let BOT_USER_ID = '';
const userNameCache = new Map<string, string>();

async function resolveUserName(client: any, userId: string): Promise<string> {
  if (!userId) return 'Someone';
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const userInfo = await client.users.info({ user: userId });
    const name = userInfo.user?.profile?.real_name || userInfo.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

function createSlackAdapter(client: any): BotPlatformAdapter {
  const sayViaClient = (payload: any) => client.chat.postMessage(payload);

  return {
    async replyInThread(channelId, threadTs, text) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });
    },

    async addReaction(channelId, ts, emoji) {
      await client.reactions.add({ name: emoji, channel: channelId, timestamp: ts }).catch(() => {});
    },

    async removeReaction(channelId, ts, emoji) {
      await client.reactions.remove({ name: emoji, channel: channelId, timestamp: ts }).catch(() => {});
    },

    async getThreadHistory(channelId, threadTs): Promise<ThreadMessage[]> {
      try {
        const res = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 30,
        });
        if (!res.messages) return [];

        const history: ThreadMessage[] = [];
        for (const msg of res.messages) {
          if (!msg.text) continue;
          const isBot = Boolean(msg.bot_id || (BOT_USER_ID && msg.user === BOT_USER_ID));
          const senderName = isBot ? 'DevOpsBot' : await resolveUserName(client, msg.user || '');
          history.push({
            role: isBot ? 'assistant' : 'user',
            senderName,
            senderId: msg.user,
            content: msg.text,
            ts: msg.ts,
          });
        }
        return history;
      } catch (err) {
        console.warn('⚠️ Failed to fetch Slack thread history:', (err as Error).message);
        return [];
      }
    },

    async getMessageText(channelId, ts) {
      try {
        const res = await client.conversations.replies({
          channel: channelId,
          ts,
          limit: 1,
          inclusive: true,
        });
        const msg = res.messages?.[0];
        if (!msg) return null;
        return { text: msg.text || '', threadTs: msg.thread_ts };
      } catch {
        return null;
      }
    },

    async postToChannel(channelId, text) {
      await client.chat.postMessage({ channel: channelId, text });
    },

    trackPendingReply(messageTs, channelId, taggedMemberIds) {
      trackPendingReply(messageTs, channelId, taggedMemberIds, sayViaClient);
    },

    clearPendingReply(messageTs) {
      clearPendingReply(messageTs);
    },

    snoozePendingReply(messageTs) {
      return snoozeReplyTimer(messageTs);
    },
  };
}

export async function startSlackBot(): Promise<void> {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  // Every create / status change / reassignment made through this provider is audited
  // (SQLite log + a comment on the GitHub issue).
  // Also keeps the GitHub Projects board (Status / Priority) in step with the labels.
  const github = new AuditedGitHubProvider(liveGitHubProvider, { board: liveProjectBoard });
  console.log(
    liveProjectBoard.enabled
      ? `✓ Project board sync ON (project #${config.github.project.number})`
      : 'ℹ️ Project board sync OFF — set GITHUB_PROJECT_NUMBER (token needs the `project` scope) to enable it.'
  );
  const bot = new DevOpsBot(github);

  // Out-of-office detection reads the Slack profile (status, display name, full name).
  let warnedMissingScope = false;
  availabilityService.setFetcher(async userId => {
    try {
      const res = await app.client.users.info({ token: config.slack.botToken, user: userId });
      return profileFromSlackUser(res.user);
    } catch (err: any) {
      if (err?.data?.error === 'missing_scope' && !warnedMissingScope) {
        warnedMissingScope = true;
        console.warn('⚠️ Slack scope "users:read" is missing — out-of-office detection is OFF until you add it and reinstall the app.');
      }
      throw err;
    }
  });

  app.error(async (error: any) => {
    console.warn('⚠️ Slack Bolt background error:', error.message || error);
  });

  try {
    const authResult = await app.client.auth.test({ token: config.slack.botToken });
    BOT_USER_ID = (authResult.user_id as string) || '';
    console.log(`✓ Bot user ID: ${BOT_USER_ID}`);
  } catch (err) {
    console.warn('⚠️ Could not fetch bot user ID:', err);
  }

  // EVENT: app_mention (when @bot is tagged, in root channel or inside any thread)
  app.event('app_mention', async ({ event, client }: any) => {
    if (event.channel !== config.slack.devopsChannelId) return;

    const mentionedIds = extractMentionedUserIds(event.text || '');
    const taggedTeamMembers = mentionedIds.filter(id => id !== BOT_USER_ID && isTeamMember(id));
    const userName = await resolveUserName(client, event.user);
    const adapter = createSlackAdapter(client);

    await bot.handleMessage(
      {
        channelId: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        userId: event.user,
        userName,
        text: event.text || '',
        isBotMentioned: true,
        mentionedTeamMemberIds: taggedTeamMembers,
      },
      adapter
    );
  });

  // EVENT: message (catches team-member tags without @bot, and clears timers when devs reply in threads)
  app.event('message', async ({ event, client }: any) => {
    if (event.channel !== config.slack.devopsChannelId) return;
    if (event.bot_id || event.subtype) return;
    if (!event.user) return;

    const rootTs = event.thread_ts || event.ts;

    // 1. If a DevOps team member replied in a thread, cancel the pending auto-reply timer
    if (isTeamMember(event.user) && event.thread_ts) {
      clearPendingReply(rootTs);
      ackThread(rootTs, event.user); // also stops any P0 escalation on this thread
    }

    // 2. If someone tagged any DevOps team member (without tagging @bot) in a root message, process it!
    const rawText: string = event.text || '';
    const mentionedIds = extractMentionedUserIds(rawText);
    const isBotMentioned = Boolean(BOT_USER_ID && mentionedIds.includes(BOT_USER_ID));
    const taggedTeamMembers = mentionedIds.filter(id => id !== BOT_USER_ID && isTeamMember(id));

    if (!isBotMentioned && !event.thread_ts && taggedTeamMembers.length > 0) {
      const userName = await resolveUserName(client, event.user);
      const adapter = createSlackAdapter(client);

      await bot.handleMessage(
        {
          channelId: event.channel,
          ts: event.ts,
          threadTs: event.thread_ts,
          userId: event.user,
          userName,
          text: rawText,
          isBotMentioned: false,
          mentionedTeamMemberIds: taggedTeamMembers,
        },
        adapter
      );
    }
  });

  // EVENT: reaction_added (emoji reactions update GitHub issue status or snooze timers)
  app.event('reaction_added', async ({ event, client }: any) => {
    const { reaction, item, user } = event;
    if (item.type !== 'message' || item.channel !== config.slack.devopsChannelId) return;

    const adapter = createSlackAdapter(client);
    await bot.handleReaction(item.channel, item.ts, reaction, user, adapter);
  });

  // EVENT: user_change (someone edited their status / display name → refresh out-of-office state)
  app.event('user_change', async ({ event }: any) => {
    const user = event.user;
    if (!user?.id || !isTeamMember(user.id)) return;
    availabilityService.invalidate(user.id, profileFromSlackUser(user));
    const a = await availabilityService.get(user.id);
    console.log(`👤 Profile changed for ${user.id}: ${describeAvailability(a)}${a.available ? '' : ` (${a.reason})`}`);
  });

  await app.start();
  console.log('⚡️ DevOps Taskbot is running in Socket Mode!');

  const postToChannel = async (text: string) => {
    await app.client.chat.postMessage({
      token: config.slack.botToken,
      channel: config.slack.devopsChannelId,
      text,
    });
  };

  const post: PostMessageFn = async (channelId, threadTs, text) => {
    await app.client.chat.postMessage({ token: config.slack.botToken, channel: channelId, thread_ts: threadTs, text });
  };

  // Digest, timers and `@bot status` must see the board's Status/Priority, so they use the same board-aware provider.
  setDefaultGitHubProvider(github);
  startDailyDigest(postToChannel, github);
  startSlaChecker(github, post);
  startEscalationChecker(github, post);
  startClosurePoller(github, post);
  startWeeklyReport(github, id => resolveUserName(app.client, id));
  restorePendingReplies(payload => app.client.chat.postMessage({ token: config.slack.botToken, ...payload }));

  // Startup self-check: a rejected API key should show up here, not in a Slack thread.
  checkLlmProviders()
    .then(lines => lines.forEach(l => console.log(l)))
    .catch(err => console.warn('⚠️ AI provider check failed to run:', (err as Error).message));

  // Startup visibility: who does the bot currently consider out of office?
  for (const member of config.team) {
    const a = await availabilityService.get(member.slackId);
    console.log(`   • ${member.githubUsername}: ${describeAvailability(a)}${a.available ? '' : ` — ${a.reason}`}`);
  }
}
