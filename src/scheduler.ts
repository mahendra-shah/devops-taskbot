import cron from 'node-cron';
import { config } from './config.js';
import { addIssueLabel } from './github.js';
import { fetchTeamWorkload, countClosedYesterday, getWorkloadForSlackUser } from './utils/workload.js';
import { generateDailyDigest, generateWorkloadReply } from './llm.js';
import { splitMessage } from './utils/helpers.js';
import * as store from './store.js';
import { availabilityService } from './availability.js';
import { logAudit } from './audit.js';

/** Map of Slack message TS → pending reply state (mirrored in SQLite so restarts don't lose timers) */
const pendingReplies = new Map<string, {
  taggedTeamMemberIds: string[];
  channelId: string;
  say: (payload: any) => Promise<any>;
  timerId: ReturnType<typeof setTimeout>;
  fireAt: number;
}>();

function scheduleReplyTimer(
  messageTs: string,
  channelId: string,
  taggedTeamMemberIds: string[],
  say: (payload: any) => Promise<any>,
  delayMs: number
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(async () => {
    const entry = pendingReplies.get(messageTs);
    if (!entry) return;

    console.log(`⏰ No reply timeout reached — sending auto-status for message ${messageTs}`);

    try {
      for (const slackId of taggedTeamMemberIds) {
        const availability = await availabilityService.get(slackId);
        let reply: string;
        if (!availability.available) {
          reply =
            `Hey! 👋 <@${slackId}> is out of office (until *${availability.untilLabel ?? 'later'}*), so a reply may be delayed. ` +
            `If this is urgent, please tag another DevOps teammate and mention *urgent*.`;
        } else {
          const openIssues = await getWorkloadForSlackUser(slackId);
          reply = await generateWorkloadReply(`<@${slackId}>`, openIssues, config.bot.noReplyTimeoutMinutes);
        }
        for (const chunk of splitMessage(reply, 3800)) {
          await say({
            channel: channelId,
            thread_ts: messageTs,
            text: chunk,
          });
        }
        logAudit('timer.auto_status', { actor: slackId, detail: `no reply after ${config.bot.noReplyTimeoutMinutes}m in thread ${messageTs}` });
      }
    } catch (err) {
      console.error(`❌ Failed to send auto-status reply for ${messageTs}:`, err);
    } finally {
      pendingReplies.delete(messageTs);
      store.deletePendingReply(messageTs);
    }
  }, delayMs);
  timer.unref?.();
  return timer;
}

function armTimer(
  messageTs: string,
  channelId: string,
  taggedTeamMemberIds: string[],
  say: (payload: any) => Promise<any>,
  delayMs: number
): void {
  const fireAt = Date.now() + delayMs;
  const timerId = scheduleReplyTimer(messageTs, channelId, taggedTeamMemberIds, say, delayMs);
  pendingReplies.set(messageTs, { taggedTeamMemberIds, channelId, say, timerId, fireAt });
  store.savePendingReply({ messageTs, channelId, taggedIds: taggedTeamMemberIds, fireAt });
}

/**
 * Tracks a message that tagged team members.
 * If none of them reply within the timeout, the bot fires an auto-status reply.
 */
export function trackPendingReply(
  messageTs: string,
  channelId: string,
  taggedTeamMemberIds: string[],
  say: (payload: any) => Promise<any>
): void {
  // Clear any existing timer for this message
  clearPendingReply(messageTs);

  armTimer(messageTs, channelId, taggedTeamMemberIds, say, config.bot.noReplyTimeoutMinutes * 60 * 1000);
  console.log(`⏱️ No-reply timer started for message ${messageTs} (${config.bot.noReplyTimeoutMinutes} min timeout)`);
}

/**
 * Marks a pending message as replied — cancels the auto-status timer.
 */
export function clearPendingReply(messageTs: string): void {
  const entry = pendingReplies.get(messageTs);
  if (entry) {
    clearTimeout(entry.timerId);
    pendingReplies.delete(messageTs);
    console.log(`✓ No-reply timer cleared for message ${messageTs}`);
  }
  store.deletePendingReply(messageTs);
}

/**
 * Snoozes the auto-reply timer for a specific message by 60 minutes.
 * Triggered when a team member reacts with 💤.
 */
export function snoozeReplyTimer(messageTs: string): boolean {
  const entry = pendingReplies.get(messageTs);
  if (!entry) return false;

  clearTimeout(entry.timerId);
  // "Snooze for another hour": push the reply back by 60 min from when it was due
  // (previously this reset to 60 min from now, which could make a fresh 90-min timer fire SOONER).
  const remainingMs = Math.max(0, entry.fireAt - Date.now());
  armTimer(messageTs, entry.channelId, entry.taggedTeamMemberIds, entry.say, remainingMs + 60 * 60 * 1000);
  console.log(`💤 Auto-reply snoozed for message ${messageTs} by another 60 min`);
  return true;
}

/**
 * Re-arms timers that were pending when the bot last stopped.
 * Timers that came due while the bot was down fire shortly after start-up
 * (unless they're more than 6h stale, in which case they're dropped).
 */
export function restorePendingReplies(say: (payload: any) => Promise<any>): number {
  const now = Date.now();
  let restored = 0;
  for (const row of store.listPendingReplies()) {
    if (row.fireAt < now - 6 * 60 * 60 * 1000) {
      store.deletePendingReply(row.messageTs);
      continue;
    }
    armTimer(row.messageTs, row.channelId, row.taggedIds, say, Math.max(5_000, row.fireAt - now));
    restored++;
  }
  if (restored > 0) console.log(`♻️ Restored ${restored} pending no-reply timer(s) from disk`);
  return restored;
}

/**
 * Starts the daily digest cron job.
 * Posts a standup summary to the devops channel every weekday morning.
 */
export function startDailyDigest(postToChannel: (text: string) => Promise<void>): void {
  const expr = config.bot.dailyDigestCron;
  if (!cron.validate(expr)) {
    console.warn(`⚠️ Invalid DAILY_DIGEST_CRON expression "${expr}" — daily digest disabled.`);
    return;
  }

  cron.schedule(expr, async () => {
    console.log('📋 Running daily devops digest...');
    try {
      const workloads = await fetchTeamWorkload();
      const closedYesterday = await countClosedYesterday();
      const away = await availabilityService.getMany(config.team.map(m => m.slackId));
      const outLines = config.team
        .filter(m => !away.get(m.slackId)?.available)
        .map(m => `<@${m.slackId}> (*${m.githubUsername}*) — out until ${away.get(m.slackId)?.untilLabel ?? 'later'}`);
      const digest = await generateDailyDigest(workloads, closedYesterday, outLines);
      await postToChannel(digest);
    } catch (err) {
      console.error('❌ Daily digest failed:', err);
    }
  });

  console.log(`✓ Daily digest scheduled: "${expr}"`);
}

/**
 * Starts the SLA breach checker.
 * Runs every hour and pings the assignee on Slack if an issue is overdue.
 */
export function startSLAChecker(
  postToChannel: (text: string) => Promise<void>
): void {
  cron.schedule('0 * * * *', async () => {
    console.log('🔍 Checking SLA breaches...');
    try {
      const workloads = await fetchTeamWorkload();
      const thresholdMs = config.bot.slaBreachHours * 60 * 60 * 1000;
      const now = Date.now();

      for (const w of workloads) {
        for (const issue of w.openIssues) {
          const ageMs = now - new Date(issue.createdAt).getTime();
          if (ageMs > thresholdMs && !issue.labels.includes('sla-breach-alerted')) {
            console.log(`⚠️ SLA breach: Issue #${issue.number} assigned to ${w.githubUsername} is overdue.`);
            await postToChannel(
              `⚠️ *SLA Breach Alert!*\n` +
              `Issue <${issue.url}|#${issue.number} ${issue.title}> assigned to <@${w.slackId}> (*${w.githubUsername}*) has been open for more than ${config.bot.slaBreachHours} hours.\n` +
              `Please update or escalate.`
            );
            await addIssueLabel(issue.number, 'sla-breach-alerted').catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('❌ SLA check failed:', err);
    }
  });

  console.log(`✓ SLA checker running (breach threshold: ${config.bot.slaBreachHours}h)`);
}
