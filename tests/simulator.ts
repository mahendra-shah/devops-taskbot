import { config } from '../src/config.js';
import type { DevOpsBot } from '../src/bot.js';
import { generateWorkloadReply } from '../src/llm.js';
import type {
  BotPlatformAdapter,
  GitHubProvider,
  IncomingMessageEvent,
  PostMessageFn,
  ThreadMessage,
} from '../src/types.js';
import { availabilityService, type SlackProfileInfo } from '../src/availability.js';
import { ackThread } from '../src/escalation.js';
import { extractMentionedUserIds } from '../src/utils/helpers.js';
import { getWorkloadForSlackUser, isTeamMember } from '../src/utils/workload.js';

export interface SimThread {
  rootTs: string;
  messages: ThreadMessage[];
  pendingTaggedMembers: string[];
  snoozed: boolean;
}

/**
 * In-memory Slack simulator that mimics Slack channels, threads, reactions,
 * and pending-reply timers without connecting to Slack.
 */
export class SimulatedSlackEnvironment {
  public readonly channelId = config.slack.devopsChannelId || 'C_SIM_DEVOPS';
  private threads = new Map<string, SimThread>();
  private messageToRoot = new Map<string, string>();
  private messageTextMap = new Map<string, { text: string; threadTs?: string }>();
  private counter = 1000;
  public readonly capturedReplies: { threadTs: string; text: string }[] = [];
  /** Simulated Slack profiles (status / display name / full name / timezone) per user. */
  private profiles = new Map<string, SlackProfileInfo>();

  constructor(
    private readonly bot: DevOpsBot,
    private readonly github: GitHubProvider,
    private readonly quietReactions = false
  ) {
    availabilityService.setFetcher(async userId => this.profileFor(userId));
  }

  private profileFor(userId: string): SlackProfileInfo | null {
    const existing = this.profiles.get(userId);
    if (existing) return existing;
    const member = config.team.find(m => m.slackId === userId);
    if (!member) return null;
    const profile: SlackProfileInfo = {
      userId,
      displayName: member.githubUsername,
      realName: member.githubUsername,
      tzOffset: 19800, // IST
    };
    this.profiles.set(userId, profile);
    return profile;
  }

  /** Edit a simulated Slack profile, as the person would in Slack (status, display name, full name…). */
  public setProfile(userId: string, patch: Partial<SlackProfileInfo>): void {
    const current = this.profileFor(userId) ?? { userId, displayName: userId, realName: userId, tzOffset: 19800 };
    const next = { ...current, ...patch, userId };
    this.profiles.set(userId, next);
    availabilityService.invalidate(userId, next); // what the `user_change` event does in production
  }

  /** PostMessageFn for escalation / closure-poll code, writing into the simulated channel. */
  public createPoster(): PostMessageFn {
    const adapter = this.createAdapter();
    return async (channelId, threadTs, text) => {
      if (threadTs) await adapter.replyInThread(channelId, threadTs, text);
      else await adapter.postToChannel!(channelId, text);
    };
  }

  private nextTs(): string {
    this.counter += 1;
    return `173130${this.counter}.000100`;
  }

  /**
   * Normalizes friendly CLI mentions like "@bot", "@devopsbot", or "@mahendra"
   * into Slack-style <@ID> tags while preserving existing <@U...> tags.
   */
  private normalizeMentions(rawText: string): {
    normalizedText: string;
    isBotMentioned: boolean;
    mentionedTeamMemberIds: string[];
  } {
    let text = rawText;
    let isBotMentioned = /@(devopsbot|bot)\b|<@BOT>/i.test(text);
    text = text.replace(/@(devopsbot|bot)\b/gi, '<@BOT>');

    // Convert @githubUsername or @slackId into <@slackId> (avoid double-wrapping <@ID>)
    for (const member of config.team) {
      const ghRegex = new RegExp(`(?<!<)@${member.githubUsername}\\b`, 'gi');
      text = text.replace(ghRegex, `<@${member.slackId}>`);
      const idRegex = new RegExp(`(?<!<)@${member.slackId}\\b`, 'gi');
      text = text.replace(idRegex, `<@${member.slackId}>`);
    }

    const mentionedIds = extractMentionedUserIds(text);
    if (mentionedIds.includes('BOT')) isBotMentioned = true;
    const mentionedTeamMemberIds = mentionedIds.filter(id => id !== 'BOT' && isTeamMember(id));

    return { normalizedText: text, isBotMentioned, mentionedTeamMemberIds };
  }

  public createAdapter(): BotPlatformAdapter {
    return {
      replyInThread: async (_channelId, threadTs, text) => {
        const botTs = this.nextTs();
        const thread = this.threads.get(threadTs);
        if (thread) {
          thread.messages.push({
            role: 'assistant',
            senderName: 'DevOpsBot',
            senderId: 'BOT',
            content: text,
            ts: botTs,
          });
        }
        this.messageToRoot.set(botTs, threadTs);
        this.messageTextMap.set(botTs, { text, threadTs });
        this.capturedReplies.push({ threadTs, text });
        console.log(`\n🤖 [Bot Reply in thread ${threadTs}]:\n${text}\n`);
      },

      addReaction: async (_channelId, _ts, emoji) => {
        if (!this.quietReactions) {
          console.log(`   [Slack UI] Bot added :${emoji}: reaction`);
        }
      },

      removeReaction: async (_channelId, _ts, emoji) => {
        if (!this.quietReactions) {
          console.log(`   [Slack UI] Bot removed :${emoji}: reaction`);
        }
      },

      getThreadHistory: async (_channelId, threadTs) => {
        const thread = this.threads.get(threadTs);
        return thread ? [...thread.messages] : [];
      },

      getMessageText: async (_channelId, ts) => {
        return this.messageTextMap.get(ts) || null;
      },

      postToChannel: async (_channelId, text) => {
        this.capturedReplies.push({ threadTs: 'CHANNEL', text });
        console.log(`\n🤖 [Bot post in channel]:\n${text}\n`);
      },

      trackPendingReply: (messageTs, _channelId, taggedMemberIds) => {
        const thread = this.threads.get(messageTs);
        if (thread) {
          thread.pendingTaggedMembers = [...taggedMemberIds];
          console.log(`   [Timer] No-reply timer armed (${config.bot.noReplyTimeoutMinutes}m) for: ${taggedMemberIds.join(', ')}`);
        }
      },

      clearPendingReply: (messageTs) => {
        const rootTs = this.messageToRoot.get(messageTs) || messageTs;
        const thread = this.threads.get(rootTs);
        if (thread && thread.pendingTaggedMembers.length > 0) {
          thread.pendingTaggedMembers = [];
          console.log(`   [Timer] No-reply timer cleared for thread ${rootTs}`);
        }
      },

      snoozePendingReply: (messageTs) => {
        const rootTs = this.messageToRoot.get(messageTs) || messageTs;
        const thread = this.threads.get(rootTs);
        if (thread && thread.pendingTaggedMembers.length > 0) {
          thread.snoozed = true;
          return true;
        }
        return false;
      },
    };
  }

  /**
   * Simulates a user posting a message in the channel or inside an existing thread.
   * Returns the root threadTs so callers can continue the same thread.
   */
  public async sendMessage(params: {
    userId: string;
    userName: string;
    text: string;
    threadTs?: string;
  }): Promise<string> {
    const ts = this.nextTs();
    const rootTs = params.threadTs || ts;
    if (!this.profiles.has(params.userId) && !isTeamMember(params.userId)) {
      this.profiles.set(params.userId, { userId: params.userId, displayName: params.userName, realName: params.userName, tzOffset: 19800 });
    }
    const { normalizedText, isBotMentioned, mentionedTeamMemberIds } = this.normalizeMentions(params.text);

    // Record in simulated thread store
    let thread = this.threads.get(rootTs);
    if (!thread) {
      thread = { rootTs, messages: [], pendingTaggedMembers: [], snoozed: false };
      this.threads.set(rootTs, thread);
    }

    thread.messages.push({
      role: 'user',
      senderName: params.userName,
      senderId: params.userId,
      content: normalizedText,
      ts,
    });
    this.messageToRoot.set(ts, rootTs);
    this.messageTextMap.set(ts, { text: normalizedText, threadTs: params.threadTs });

    const adapter = this.createAdapter();

    // If a team member replies in an existing thread, clear the pending timer
    if (params.threadTs && isTeamMember(params.userId)) {
      adapter.clearPendingReply?.(rootTs);
      ackThread(rootTs, params.userId);
    }

    // Only invoke bot if @bot was mentioned OR a team member was tagged in a root message
    const shouldProcess = isBotMentioned || (!params.threadTs && mentionedTeamMemberIds.length > 0);
    if (shouldProcess) {
      const event: IncomingMessageEvent = {
        channelId: this.channelId,
        ts,
        threadTs: params.threadTs,
        userId: params.userId,
        userName: params.userName,
        text: normalizedText,
        isBotMentioned,
        mentionedTeamMemberIds,
      };
      await this.bot.handleMessage(event, adapter);
    } else {
      console.log(`   [Slack UI] Recorded thread message from ${params.userName} (bot not tagged, staying quiet).`);
    }

    return rootTs;
  }

  /**
   * Simulates a Slack emoji reaction on a message (root message or bot reply).
   */
  public async react(ts: string, reaction: string, userId: string): Promise<void> {
    const adapter = this.createAdapter();
    await this.bot.handleReaction(this.channelId, ts, reaction, userId, adapter);
  }

  /**
   * Immediately fires the "no-reply after N minutes" auto-status reply for testing.
   */
  public async simulateNoReplyTimeout(threadTs: string): Promise<void> {
    const thread = this.threads.get(threadTs);
    if (!thread || thread.pendingTaggedMembers.length === 0) {
      console.log(`   [Timer] No pending tagged members awaiting reply on thread ${threadTs}.`);
      return;
    }

    const adapter = this.createAdapter();
    for (const slackId of thread.pendingTaggedMembers) {
      const openIssues = await getWorkloadForSlackUser(slackId, this.github);
      const reply = await generateWorkloadReply(`<@${slackId}>`, openIssues, config.bot.noReplyTimeoutMinutes);
      await adapter.replyInThread(this.channelId, threadTs, reply);
    }
    thread.pendingTaggedMembers = [];
  }

  public getThread(threadTs: string): SimThread | undefined {
    return this.threads.get(threadTs);
  }

  public listThreadIds(): string[] {
    return Array.from(this.threads.keys());
  }
}
