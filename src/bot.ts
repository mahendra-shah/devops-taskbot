import { config } from './config.js';
import { runDevOpsAgent, type AgentResult } from './llm.js';
import type {
  BotPlatformAdapter,
  GitHubIssue,
  GitHubProvider,
  IncomingMessageEvent,
  IssueStatus,
  PostMessageFn,
  Priority,
  ThreadMessage,
} from './types.js';
import {
  formatP0Alert,
  formatStatusUpdateMessage,
  resolveRequester,
  splitMessage,
  stripMentions,
} from './utils/helpers.js';
import { buildStatusMessage, findTeamMember, isTeamMember } from './utils/workload.js';
import { availabilityService, type Availability } from './availability.js';
import { logAudit, runWithAudit, setRequester } from './audit.js';
import { explainError, shouldAlertTeam, unknownMemberMessage, type FriendlyError } from './errors.js';
import { ackThread, watchP0 } from './escalation.js';
import { snoozeSla } from './sla.js';
import { notifyRequesterOfClosure } from './requesterUpdates.js';
import { recordRequestTopic, type TopicClassifier } from './topics.js';
import * as store from './store.js';

export type AgentRunner = (params: {
  event: IncomingMessageEvent;
  threadHistory: ThreadMessage[];
  linkedIssue: GitHubIssue | null;
  github: GitHubProvider;
  availability: Map<string, Availability>;
}) => Promise<AgentResult>;

const EMOJI_STATUS_MAP: Record<string, IssueStatus> = {
  'eyes': 'in-progress',
  'white_check_mark': 'done',
  'heavy_check_mark': 'done',
  'no_entry': 'blocked',
  'no_entry_sign': 'blocked',
};

/** Builds a PostMessageFn on top of a platform adapter (thread reply, or channel post when no thread). */
function postVia(adapter: BotPlatformAdapter): PostMessageFn {
  return async (channelId, threadTs, text) => {
    if (threadTs) return adapter.replyInThread(channelId, threadTs, text);
    if (adapter.postToChannel) return adapter.postToChannel(channelId, text);
    return adapter.replyInThread(channelId, channelId, text);
  };
}

export class DevOpsBot {
  private processedMessageTs = new Set<string>();
  /** Fire-and-forget work (topic classification). Tests await flushBackground(). */
  private background = new Set<Promise<unknown>>();

  constructor(
    private readonly github: GitHubProvider,
    private readonly agentRunner: AgentRunner = runDevOpsAgent,
    private readonly deps: { classifyTopic?: TopicClassifier } = {}
  ) {}

  private isDuplicate(ts: string): boolean {
    if (this.processedMessageTs.has(ts)) return true;
    this.processedMessageTs.add(ts);
    setTimeout(() => this.processedMessageTs.delete(ts), 60_000).unref();
    return false;
  }

  private runInBackground(label: string, work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch(err => console.warn(`⚠️ Background task "${label}" failed:`, (err as Error).message))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  public async flushBackground(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** User-facing text for an error; config problems also ping the team (at most once per 30 min per kind). */
  private friendlyText(err: unknown): string {
    const info: FriendlyError = explainError(err);
    let text = info.userMessage;
    if (info.notifyTeam && shouldAlertTeam(info.kind)) {
      text += `\n🔧 ${config.team.map(m => `<@${m.slackId}>`).join(' ')} — ${info.adminHint}`;
    }
    return text;
  }

  private async teamAvailability(): Promise<Map<string, Availability>> {
    return availabilityService.getMany(config.team.map(m => m.slackId));
  }

  /**
   * Processes an incoming message where either the bot or a team member was tagged.
   */
  public async handleMessage(
    event: IncomingMessageEvent,
    adapter: BotPlatformAdapter
  ): Promise<void> {
    if (this.isDuplicate(event.ts)) return;

    return runWithAudit(
      {
        actorId: event.userId,
        actorName: event.userName,
        via: event.isBotMentioned ? 'Slack message to @bot' : 'Slack message tagging a DevOps teammate',
      },
      () => this.processMessage(event, adapter)
    );
  }

  private async processMessage(event: IncomingMessageEvent, adapter: BotPlatformAdapter): Promise<void> {
    const threadTs = event.threadTs || event.ts;
    const isInsideThread = Boolean(event.threadTs && event.threadTs !== event.ts);
    const cleanText = stripMentions(event.text);
    if (!cleanText) return;

    // Fast-path: `@bot status`
    if (event.isBotMentioned && /^status$/i.test(cleanText)) {
      await adapter.addReaction(event.channelId, event.ts, 'eyes');
      try {
        const statusMsg = await buildStatusMessage(this.github);
        await adapter.replyInThread(event.channelId, threadTs, statusMsg);
      } finally {
        await adapter.removeReaction(event.channelId, event.ts, 'eyes').catch(() => {});
      }
      return;
    }

    // Fast-path: `@bot assign #123 to <githubUsername>`
    const assignMatch = event.isBotMentioned ? cleanText.match(/^assign\s+#(\d+)\s+to\s+(\S+)$/i) : null;
    if (assignMatch) {
      const issueNumber = parseInt(assignMatch[1], 10);
      const newGithubUser = assignMatch[2].trim().replace(/^@/, '');
      const member = findTeamMember(newGithubUser);
      if (!member) {
        await adapter.replyInThread(event.channelId, threadTs, `⚠️ ${unknownMemberMessage(newGithubUser)}`);
        return;
      }
      try {
        const updated = await this.github.reassignIssue(issueNumber, member.githubUsername);
        if (!updated) {
          await adapter.replyInThread(event.channelId, threadTs, `❌ Issue #${issueNumber} not found on GitHub.`);
        } else {
          let msg = `✓ Issue <${updated.url}|#${issueNumber}> has been reassigned to *${member.githubUsername}* on GitHub.`;
          const a = await availabilityService.get(member.slackId);
          if (!a.available) msg += `\n🌴 Heads up: <@${member.slackId}> is out of office until *${a.untilLabel ?? 'later'}*.`;
          await adapter.replyInThread(event.channelId, threadTs, msg);
        }
      } catch (err) {
        await adapter.replyInThread(event.channelId, threadTs, this.friendlyText(err));
      }
      return;
    }

    // Show typing reaction when bot was explicitly tagged (or processing a root task)
    await adapter.addReaction(event.channelId, event.ts, 'eyes');

    try {
      // 1. Fetch full thread history if inside a thread
      let threadHistory: ThreadMessage[] = [];
      if (isInsideThread) {
        threadHistory = await adapter.getThreadHistory(event.channelId, threadTs);
      }

      // 1b. Who actually asked? Inside a thread that's whoever wrote its first message — not whoever tagged the bot.
      const requester = resolveRequester(event, threadHistory, threadTs);
      setRequester(requester.id, requester.name);

      // 2. Resolve any GitHub issue linked to this thread + who is out of office
      const linkedIssue = await this.resolveLinkedIssue(threadTs, threadHistory);
      const availability = await this.teamAvailability();

      // 3. Run the conversational DevOps LLM agent
      const result = await this.agentRunner({
        event: { ...event, text: cleanText },
        threadHistory,
        linkedIssue,
        github: this.github,
        availability,
      });

      // 4. Send reply in the message's thread
      if (result.replyText) {
        const chunks = splitMessage(result.replyText, 3800);
        for (const chunk of chunks) {
          await adapter.replyInThread(event.channelId, threadTs, chunk);
        }
      }

      const assignedMember = result.assignedGithubUsername
        ? config.team.find(m => m.githubUsername === result.assignedGithubUsername)
        : undefined;

      // 5. Out-of-office notice for tagged devs who are away (only when the bot actually responded)
      if (result.replyText !== null || result.createdIssue) {
        await this.postOooNotice(event, adapter, threadTs, availability, result, assignedMember?.slackId);
      }

      // 6. Remember which Slack thread/requester this issue belongs to (for closure updates)
      if (result.createdIssue) {
        store.saveIssueLink({
          issueNumber: result.createdIssue.number,
          channelId: event.channelId,
          threadTs,
          requesterId: requester.id,
          createdAt: Date.now(),
        });
        // Repeat-request detection runs in the background — it must never delay the reply.
        this.runInBackground(
          'topic',
          recordRequestTopic(result.createdIssue, requester.id, event.channelId, postVia(adapter), {
            classifier: this.deps.classifyTopic,
          })
        );
      }

      // 7. P0: immediate alert + start escalation watch
      if (result.createdIssue && result.createdTaskPriority === 'P0' && assignedMember) {
        const p0Alert = formatP0Alert(
          result.createdIssue.number,
          result.createdIssue.url,
          result.createdIssue.title,
          assignedMember.slackId
        );
        await adapter.replyInThread(event.channelId, threadTs, p0Alert);
        watchP0({
          issueNumber: result.createdIssue.number,
          channelId: event.channelId,
          threadTs,
          assigneeSlackId: assignedMember.slackId,
        });
      }

      // 8. Issues the agent closed → tell the original requester
      for (const n of result.closedIssueNumbers ?? []) {
        await notifyRequesterOfClosure(n, this.github, postVia(adapter), { id: event.userId, name: event.userName });
      }

      // 8b. Priority changes: raising to P0 starts escalation, lowering stops it
      for (const pc of result.priorityChanges ?? []) {
        await this.applyPriorityChange(pc.issueNumber, pc.priority, event, adapter, threadTs);
      }

      // 9. Start the no-reply timer for tagged devs (or newly assigned dev) on root messages.
      //    Devs who are out of office can't reply, so they are not timed.
      if (!isInsideThread) {
        const trackIds = [...event.mentionedTeamMemberIds];
        if (assignedMember && !trackIds.includes(assignedMember.slackId)) {
          trackIds.push(assignedMember.slackId);
        }
        const reachable = trackIds.filter(id => availability.get(id)?.available !== false);
        if (reachable.length > 0 && (result.createdIssue || result.replyText !== null)) {
          adapter.trackPendingReply?.(threadTs, event.channelId, reachable);
        }
      }
    } catch (err) {
      await adapter.replyInThread(event.channelId, threadTs, this.friendlyText(err)).catch(() => {});
    } finally {
      await adapter.removeReaction(event.channelId, event.ts, 'eyes').catch(() => {});
    }
  }

  private async applyPriorityChange(
    issueNumber: number,
    priority: Priority,
    event: IncomingMessageEvent,
    adapter: BotPlatformAdapter,
    threadTs: string
  ): Promise<void> {
    if (priority !== 'P0') {
      if (store.removeP0Watch(issueNumber)) logAudit('p0.watch_cleared', { issueNumber, detail: `priority changed to ${priority}` });
      return;
    }
    const issue = await this.github.getIssueByNumber(issueNumber);
    const assignee = issue ? config.team.find(m => issue.assignees.includes(m.githubUsername)) : undefined;
    if (!issue || !assignee) return;

    // Escalate in the issue's original Slack thread when we know it, else in the current thread.
    const link = store.getIssueLink(issueNumber);
    const channelId = link?.channelId ?? event.channelId;
    const watchThread = link?.threadTs ?? threadTs;
    await adapter.replyInThread(event.channelId, threadTs, formatP0Alert(issue.number, issue.url, issue.title, assignee.slackId));
    watchP0({ issueNumber, channelId, threadTs: watchThread, assigneeSlackId: assignee.slackId });
  }

  /**
   * If someone tagged a dev who is out of office, say so right away and explain who took the task.
   */
  private async postOooNotice(
    event: IncomingMessageEvent,
    adapter: BotPlatformAdapter,
    threadTs: string,
    availability: Map<string, Availability>,
    result: AgentResult,
    assignedSlackId?: string
  ): Promise<void> {
    const awayTagged = event.mentionedTeamMemberIds.filter(id => availability.get(id)?.available === false);
    if (awayTagged.length === 0) return;

    const lines: string[] = [];
    for (const id of awayTagged) {
      const a = availability.get(id)!;
      const until = a.untilLabel ?? 'later';
      if (result.createdIssue && assignedSlackId && assignedSlackId !== id) {
        lines.push(`🌴 <@${id}> is out of office until *${until}*, so I assigned this to <@${assignedSlackId}> instead.`);
        logAudit('ooo.redirected', {
          issueNumber: result.createdIssue.number,
          actor: id,
          detail: `${id} out until ${until}; assigned to ${assignedSlackId}`,
        });
      } else if (result.createdIssue && assignedSlackId === id) {
        lines.push(
          `🌴 <@${id}> is out of office until *${until}* and nobody else on the team is available, so this is assigned to them for when they're back. ` +
          `If it's urgent, please ping the team directly.`
        );
        logAudit('ooo.no_one_available', { issueNumber: result.createdIssue.number, actor: id, detail: `all devs out; assigned to ${id}` });
      } else {
        lines.push(`🌴 <@${id}> is out of office until *${until}*, so a reply may be delayed.`);
      }
    }
    await adapter.replyInThread(event.channelId, threadTs, lines.join('\n'));
  }

  /**
   * Handles emoji reactions (status sync, timer clear, escalation ack, and snooze).
   */
  public async handleReaction(
    channelId: string,
    messageTs: string,
    reaction: string,
    userId: string,
    adapter: BotPlatformAdapter
  ): Promise<void> {
    const actorName = (await availabilityService.displayNameOf(userId)) ?? undefined;
    return runWithAudit(
      { actorId: userId, actorName, via: `emoji reaction :${reaction}:` },
      () => this.processReaction(channelId, messageTs, reaction, userId, adapter)
    );
  }

  private async processReaction(
    channelId: string,
    messageTs: string,
    reaction: string,
    userId: string,
    adapter: BotPlatformAdapter
  ): Promise<void> {
    const msgInfo = await adapter.getMessageText?.(channelId, messageTs);
    const replyThreadTs = msgInfo?.threadTs || messageTs;

    // Snooze reaction: 💤
    if (reaction === 'zzz') {
      if (isTeamMember(userId)) {
        const snoozed = adapter.snoozePendingReply?.(replyThreadTs) || adapter.snoozePendingReply?.(messageTs);
        if (snoozed) {
          await adapter.replyInThread(
            channelId,
            replyThreadTs,
            `💤 Auto-status reply snoozed for 60 minutes by <@${userId}>.`
          );
        } else {
          // Not a no-reply timer → maybe a reminder about the issue in this thread: snooze its SLA reminders.
          const link = store.getIssueLinkByThread(replyThreadTs);
          if (link) {
            const until = snoozeSla(link.issueNumber);
            await adapter.replyInThread(
              channelId,
              replyThreadTs,
              `💤 Reminders for #${link.issueNumber} snoozed until *${until}* by <@${userId}>.`
            );
          }
        }
      }
      return;
    }

    // Team member reacted -> cancel pending no-reply timer and stop any P0 escalation
    if (isTeamMember(userId)) {
      adapter.clearPendingReply?.(messageTs);
      ackThread(messageTs, userId);
      if (replyThreadTs !== messageTs) {
        adapter.clearPendingReply?.(replyThreadTs);
        ackThread(replyThreadTs, userId);
      }
    }

    const status = EMOJI_STATUS_MAP[reaction];
    if (!status) return;
    if (!isTeamMember(userId)) return;

    console.log(`🎭 Reaction "${reaction}" by ${userId} on ${messageTs} → GitHub status: ${status}`);

    try {
      let issue = await this.github.findIssueBySlackTs(messageTs);
      if (!issue && msgInfo?.threadTs) {
        issue = await this.github.findIssueBySlackTs(msgInfo.threadTs);
      }
      if (!issue && msgInfo?.text) {
        const numMatch = msgInfo.text.match(/#(\d+)/);
        if (numMatch) {
          issue = await this.github.getIssueByNumber(parseInt(numMatch[1], 10));
        }
      }

      if (!issue) {
        console.log(`  ℹ️ No GitHub issue linked to Slack message ${messageTs} — skipping.`);
        return;
      }

      await this.github.updateIssueStatus(issue.number, status);
      const confirmMsg = formatStatusUpdateMessage(issue.number, issue.url, status, userId);
      await adapter.replyInThread(channelId, replyThreadTs, confirmMsg);

      if (status === 'done') {
        await notifyRequesterOfClosure(issue.number, this.github, postVia(adapter), { id: userId });
      } else if (status === 'open') {
        store.setClosedNotified(issue.number, false);
      }
    } catch (err) {
      await adapter.replyInThread(channelId, replyThreadTs, this.friendlyText(err)).catch(() => {});
    }
  }

  private async resolveLinkedIssue(
    threadTs: string,
    threadHistory: ThreadMessage[]
  ): Promise<GitHubIssue | null> {
    const byTs = await this.github.findIssueBySlackTs(threadTs);
    if (byTs) return byTs;

    // Scan thread history (newest first) for an issue reference like #12
    for (let i = threadHistory.length - 1; i >= 0; i--) {
      const match = threadHistory[i].content.match(/#(\d+)/);
      if (match) {
        const found = await this.github.getIssueByNumber(parseInt(match[1], 10));
        if (found) return found;
      }
    }
    return null;
  }
}
