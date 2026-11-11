import type { AgentRunner } from '../src/bot.js';
import { chooseAssignee } from '../src/llm.js';
import { setAssignmentNote } from '../src/audit.js';
import { fetchTeamWorkload } from '../src/utils/workload.js';
import { formatIssueCreatedMessage } from '../src/utils/helpers.js';

/**
 * Deterministic mock agent runner so we can verify every bot workflow,
 * thread-context rule, GitHub integration, and emoji reaction in <1s without API quota.
 */
export const mockAgentRunner: AgentRunner = async ({ event, threadHistory, linkedIssue, github, availability }) => {
  const lower = event.text.toLowerCase();
  const isInsideThread = Boolean(event.threadTs && event.threadTs !== event.ts);

  // Casual chatter without @bot
  if (!event.isBotMentioned && /coffee|morning|thanks/i.test(lower)) {
    return { replyText: null, createdIssue: null };
  }

  // Inside a thread: status query
  if (isInsideThread && /status.*\?|what is the current status|what did we find/i.test(lower)) {
    if (!linkedIssue) return { replyText: 'No linked issue found in this thread.', createdIssue: null };
    const latest = await github.getIssueByNumber(linkedIssue.number);
    const threadNotes = threadHistory.slice(-3).map(m => `${m.senderName}: ${m.content.slice(0, 80)}`).join(' | ');
    return {
      replyText:
        `📌 *<${latest?.url}|#${latest?.number} — ${latest?.title}>* is currently *${latest?.state}* ` +
        `(labels: \`${latest?.labels.join(', ')}\`, assignee: *${latest?.assignees.join(', ')}*).\n` +
        `📝 Recent thread context (${threadHistory.length} msgs): ${threadNotes}`,
      createdIssue: null,
    };
  }

  // Inside a thread: status update command
  if (isInsideThread && /(mark|update|move|set)/i.test(lower) && linkedIssue) {
    if (/\bdone\b|\bclose\b/i.test(lower)) {
      const updated = await github.updateIssueStatus(linkedIssue.number, 'done');
      return { replyText: `✅ Marked <${updated?.url}|#${linkedIssue.number}> as *Done & Closed* on GitHub.`, createdIssue: null };
    }
    if (/in[\s-]?progress/i.test(lower)) {
      const updated = await github.updateIssueStatus(linkedIssue.number, 'in-progress');
      return { replyText: `🔄 Marked <${updated?.url}|#${linkedIssue.number}> as *In Progress* on GitHub.`, createdIssue: null };
    }
    if (/blocked/i.test(lower)) {
      const updated = await github.updateIssueStatus(linkedIssue.number, 'blocked');
      return { replyText: `🚫 Marked <${updated?.url}|#${linkedIssue.number}> as *Blocked* on GitHub.`, createdIssue: null };
    }
  }

  // Duplicate check on root task
  const dup = await github.findSimilarOpenIssue(event.text);
  if (dup) {
    return {
      replyText: `🔄 Similar open issue already exists: *<${dup.url}|#${dup.number} — ${dup.title}>*. No duplicate created.`,
      createdIssue: null,
    };
  }

  // Create new GitHub issue assigned to lowest-load member
  const workloads = await fetchTeamWorkload(github);
  workloads.sort((a, b) => a.loadScore - b.loadScore);
  // Same code-level guarantee the real agent has: never assign to someone who is out of office.
  const choice = chooseAssignee(workloads[0].githubUsername, workloads, availability);
  const assignee = choice.assignee;
  setAssignmentNote(choice.note);
  const priority = /urgent|prod|502|down|critical/i.test(lower) ? 'P0' : 'P2';
  const estimate = /bucket|pipeline|502/i.test(lower) ? 'high' : 'low';
  const title = event.text.slice(0, 65);

  const issue = await github.createIssue(
    { title, body: event.text, priority, estimate },
    assignee,
    event.threadTs || event.ts,
    event.channelId
  );

  return {
    replyText: formatIssueCreatedMessage(issue.number, issue.url, issue.title, assignee, priority, estimate, title),
    createdIssue: issue,
    createdTaskPriority: priority,
    assignedGithubUsername: assignee,
  };
};

