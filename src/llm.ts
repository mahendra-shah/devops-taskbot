import OpenAI from 'openai';
import { config } from './config.js';
import type {
  GitHubIssue,
  GitHubProvider,
  IncomingMessageEvent,
  IssueStatus,
  ThreadMessage,
} from './types.js';
import { fetchTeamWorkload, findTeamMember, isTeamMember, type TeamWorkload } from './utils/workload.js';
import { isAuditComment, setAssignmentNote, setIssueExtras } from './audit.js';
import { PRIORITIES, PRIORITY_NAMES, type Priority } from './types.js';
import { LlmUnavailableError, unknownMemberMessage, type ProviderFailure } from './errors.js';
import { resolveRequester, slackToPlain } from './utils/helpers.js';
import type { Availability } from './availability.js';
import { etaEndOfDayMs, setIssueEta } from './sla.js';

interface WorkloadContext {
  githubUsername: string;
  openIssues: GitHubIssue[];
}

export interface AgentResult {
  replyText: string | null;
  createdIssue: GitHubIssue | null;
  createdTaskPriority?: Priority;
  assignedGithubUsername?: string;
  /** Issue numbers the agent closed (status → done) during this run. */
  closedIssueNumbers?: number[];
  /** Priority changes the agent made on existing issues (drives P0 escalation start/stop). */
  priorityChanges?: { issueNumber: number; priority: Priority }[];
}

function isValidApiKey(key: string): boolean {
  if (!key) return false;
  const lower = key.toLowerCase().trim();
  return !lower.startsWith('your_') && !lower.includes('placeholder') && lower.length > 12;
}

const geminiClient = isValidApiKey(config.llm.gemini.apiKey)
  ? new OpenAI({
      apiKey: config.llm.gemini.apiKey,
      baseURL: config.llm.gemini.apiUrl,
      timeout: 30_000,
      maxRetries: 0,
    })
  : null;

const deepseekClient = isValidApiKey(config.llm.deepseek.apiKey)
  ? new OpenAI({
      apiKey: config.llm.deepseek.apiKey,
      baseURL: config.llm.deepseek.apiUrl,
      timeout: 30_000,
      maxRetries: 0,
    })
  : null;

function getProviderChain(): { client: OpenAI; model: string; name: string }[] {
  const chain: { client: OpenAI; model: string; name: string }[] = [];
  if (config.llm.provider === 'gemini') {
    if (geminiClient) chain.push({ client: geminiClient, model: config.llm.gemini.model, name: 'gemini' });
    if (deepseekClient) chain.push({ client: deepseekClient, model: config.llm.deepseek.model, name: 'deepseek' });
  } else {
    if (deepseekClient) chain.push({ client: deepseekClient, model: config.llm.deepseek.model, name: 'deepseek' });
    if (geminiClient) chain.push({ client: geminiClient, model: config.llm.gemini.model, name: 'gemini' });
  }
  if (chain.length === 0) {
    throw new Error('No LLM client configured. Check GEMINI_API_KEY / DEEPSEEK_API_KEY in .env');
  }
  return chain;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableError(err: any): boolean {
  const status = err?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function createChatCompletion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
  temperature = 0.2
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const chain = getProviderChain();
  const failures: ProviderFailure[] = [];

  for (let i = 0; i < chain.length; i++) {
    const { client, model, name } = chain[i];
    const retryDelays = [2000, 5000];

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        return await client.chat.completions.create({
          model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
          temperature,
        });
      } catch (err) {
        if (isRetryableError(err) && attempt < retryDelays.length) {
          const delay = retryDelays[attempt];
          console.warn(`⚠️ LLM provider "${name}" returned ${(err as any).status} — retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        failures.push({ provider: name, status: (err as any)?.status, message: (err as Error).message });
        break;
      }
    }

    if (i < chain.length - 1) {
      console.warn(`⚠️ LLM provider "${name}" failed (${failures[failures.length - 1]?.message}) — failing over to "${chain[i + 1].name}"...`);
    }
  }
  throw new LlmUnavailableError(failures);
}

/** Startup self-check: one tiny request per configured provider, so a bad key shows up at deploy time, not in Slack. */
export async function checkLlmProviders(): Promise<string[]> {
  let chain;
  try {
    chain = getProviderChain();
  } catch {
    return ['✗ No AI provider configured — set DEEPSEEK_API_KEY and/or GEMINI_API_KEY in .env'];
  }
  const out: string[] = [];
  for (const { client, model, name } of chain) {
    try {
      await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
      out.push(`✓ AI provider ${name} (${model}) is reachable`);
    } catch (err) {
      const st: number | undefined = (err as any)?.status;
      const why = st === 401 || st === 403 ? 'API key rejected — fix the key in .env' : st === 402 ? 'out of credit' : st === 429 ? 'rate-limited' : 'unreachable';
      out.push(`✗ AI provider ${name} FAILED${st ? ` (HTTP ${st})` : ''}: ${why}`);
    }
  }
  return out;
}

const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'check_duplicate_issue',
      description: 'Search open GitHub issues by keywords to see if a similar task already exists before creating a new one.',
      parameters: {
        type: 'object',
        properties: {
          title_keywords: {
            type: 'string',
            description: 'Short keywords describing the issue (e.g. "checkout 502 prod api").',
          },
        },
        required: ['title_keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_team_workload',
      description: 'Get the current open GitHub issues and workload score for every DevOps team member.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_github_issue',
      description: 'Create a new GitHub issue for an actionable DevOps task and assign it to a team member.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Concise, imperative GitHub issue title (< 80 chars).',
          },
          body: {
            type: 'string',
            description:
              'Structured Markdown with exactly these sections: "## Request" (what is being asked, 1-3 sentences), ' +
              '"## Context" (environment, services, errors, links or details from the message/thread), ' +
              '"## Definition of done" (a checklist of 1-3 "- [ ]" items). Do NOT include who requested it or the original message — the system appends those.',
          },
          priority: {
            type: 'string',
            enum: PRIORITIES,
            description: 'P0=Urgent (prod down/critical), P1=High (blocking/failing), P2=Medium (routine/normal), P3=Low (nice-to-have, no deadline).',
          },
          estimate: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'low=<1h, medium=1-4h, high=>4h.',
          },
          estimate_hours: {
            type: 'number',
            description: 'Your best estimate of the hours of work, e.g. 0.5, 2, 6. Always provide it, consistent with `estimate`.',
          },
          assignee_github_username: {
            type: 'string',
            description: 'Exact GitHub username from the configured team list, chosen by lowest workload unless explicitly requested.',
          },
        },
        required: ['title', 'body', 'priority', 'estimate', 'estimate_hours', 'assignee_github_username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_issue_details',
      description: 'Fetch live details, status, labels, assignees, and recent comments for a specific GitHub issue number.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'The GitHub issue number (e.g. 4).',
          },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_issue_status',
      description: 'Update the status of an existing GitHub issue.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'The GitHub issue number.',
          },
          status: {
            type: 'string',
            enum: ['open', 'in-progress', 'done', 'blocked'],
            description: 'Target status: open (reopen/backlog), in-progress, done (closes issue), or blocked.',
          },
        },
        required: ['issue_number', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reassign_issue',
      description: 'Reassign an existing GitHub issue to another team member.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'The GitHub issue number.',
          },
          assignee_github_username: {
            type: 'string',
            description: 'Exact GitHub username of the new assignee.',
          },
        },
        required: ['issue_number', 'assignee_github_username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_issue_priority_or_effort',
      description: 'Change the priority (P0/P1/P2/P3 = Urgent/High/Medium/Low) and/or effort estimate (low/medium/high) of an EXISTING GitHub issue. Only DevOps team members may do this. Raising an issue to P0 automatically starts P0 escalation.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The GitHub issue number.' },
          priority: { type: 'string', enum: PRIORITIES, description: 'New priority. P0=Urgent (prod down/critical), P1=High, P2=Medium, P3=Low. Omit to leave unchanged.' },
          estimate: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New effort: low=<1h, medium=1-4h, high=>4h. Omit to leave unchanged.' },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_issue_eta',
      description: 'Record WHEN an existing issue is expected to be finished (its ETA), e.g. when a teammate says "#1 will take till Friday". Reminders about the issue stay quiet until that day has passed. Only DevOps team members may do this.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The GitHub issue number.' },
          eta_date: { type: 'string', description: 'The date in YYYY-MM-DD, resolved from TODAY in the context (e.g. "Friday" → the coming Friday).' },
        },
        required: ['issue_number', 'eta_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_issue_comment',
      description: 'Add a note or progress summary comment to a GitHub issue.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'The GitHub issue number.',
          },
          comment: {
            type: 'string',
            description: 'Markdown comment body to post on the GitHub issue.',
          },
        },
        required: ['issue_number', 'comment'],
      },
    },
  },
];

/**
 * Main conversational DevOps agent.
 * Understands root tasks, thread follow-ups, status queries, status updates, and team workload.
 */
export async function runDevOpsAgent(params: {
  event: IncomingMessageEvent;
  threadHistory: ThreadMessage[];
  linkedIssue: GitHubIssue | null;
  github: GitHubProvider;
  /** Slack ID → availability (out-of-office detection). Missing entries mean "available". */
  availability?: Map<string, Availability>;
}): Promise<AgentResult> {
  const { event, threadHistory, linkedIssue, github } = params;
  const availability = params.availability ?? new Map<string, Availability>();
  const isInsideThread = Boolean(event.threadTs && event.threadTs !== event.ts);

  // Pre-fetch team workload & open issues once so the LLM can assign & check duplicates in Turn 1
  const [workloads, allOpenIssues] = await Promise.all([
    fetchTeamWorkload(github),
    github.getAllOpenIssues(),
  ]);

  const teamInfo = workloads
    .map(w => {
      const titles = w.openIssues.slice(0, 5).map(i => `#${i.number} "${i.title}" [${i.labels.join(',')}]`).join('; ');
      const a = availability.get(w.slackId);
      const avail = a && !a.available
        ? `OUT OF OFFICE until ${a.untilLabel ?? 'later'} (${a.reason ?? 'status'}) — DO NOT ASSIGN`
        : 'available';
      return `- Slack: <@${w.slackId}> (${w.slackId}) → GitHub: ${w.githubUsername} | Availability: ${avail} | Open: ${w.openIssues.length} | Load score: ${w.loadScore}${titles ? ` | Tasks: ${titles}` : ''}`;
    })
    .join('\n');

  const openIssuesSummary = allOpenIssues.length > 0
    ? allOpenIssues.slice(0, 25).map(i => `- #${i.number}: "${i.title}" (${i.labels.join(', ')}) [assignee: ${i.assignees.join(', ') || 'none'}] ${i.url}`).join('\n')
    : '- (No open issues)';

  const linkedIssueContext = linkedIssue
    ? `\nLINKED GITHUB ISSUE FOR THIS THREAD:\n- Issue #${linkedIssue.number}: "${linkedIssue.title}"\n- State: ${linkedIssue.state}\n- Labels: ${linkedIssue.labels.join(', ') || 'none'}\n- Assignees: ${linkedIssue.assignees.join(', ') || 'unassigned'}\n- URL: ${linkedIssue.url}`
    : '\nNo GitHub issue is currently linked to this thread.';

  const systemPrompt = `You are DevOps Taskbot in a Slack channel for a small 2-3 person DevOps team.
You manage DevOps tasks using GitHub Issues and keep everyone informed in Slack threads.

TEAM MEMBERS & CURRENT WORKLOAD:
${teamInfo}

CURRENT OPEN GITHUB ISSUES (for duplicate detection & status queries):
${openIssuesSummary}

CURRENT CONTEXT:
- TODAY: ${new Date().toLocaleDateString('en-GB', { timeZone: config.bot.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} (${new Date().toLocaleDateString('en-CA', { timeZone: config.bot.timezone })}, ${config.bot.timezone})
- Message location: ${isInsideThread ? 'INSIDE AN EXISTING SLACK THREAD' : 'NEW ROOT CHANNEL MESSAGE'}
- Bot explicitly tagged (@bot): ${event.isBotMentioned ? 'YES' : 'NO (a team member was tagged instead)'}
- Sender: ${event.userName} (${event.userId})${linkedIssueContext}

BEHAVIOR RULES:
1. **New actionable DevOps task** (e.g. infra issue, deploy needed, bug, access/DNS/CI request, alert):
   - Check CURRENT OPEN GITHUB ISSUES above first. If an open issue already covers this exact task, reply with that existing issue link and do NOT call \`create_github_issue\`.
   - Otherwise pick the AVAILABLE team member with the lowest Load score above (unless a specific available dev must own it and isn't overloaded) and call \`create_github_issue\` immediately.
   - NEVER assign to someone marked OUT OF OFFICE, even if they were tagged — pick an available dev instead. If everyone is out, pick the lowest load and say so. The system posts the out-of-office notice itself, so do not repeat it in your reply.
   - Reply concisely in Slack mrkdwn (*bold*, <url|label>) with: issue link & number, assigned person, priority, effort, and remind the team they can react with 👀 (in-progress), ✅ (done), or 🚫 (blocked).

2. **Questions, status checks, or commands** (especially inside a thread, or when @bot is asked directly):
   - If the user asks about "this task" inside a thread, use the LINKED GITHUB ISSUE number (or issue # mentioned in thread history). Call \`get_issue_details\` only if you need comments or full body; otherwise answer from the live issue state above.
   - If asked about team workload / who is doing what, answer directly from TEAM MEMBERS & CURRENT WORKLOAD above.
   - If asked to update status (e.g. "update this task status from in progress to done", "mark #4 blocked", "reopen this", "start working on this"), call \`update_issue_status\`.
   - If asked to reassign, call \`reassign_issue\`.
   - If asked to change an existing issue's priority/urgency or effort/estimate (e.g. "make this P0", "this is low priority", "bump to high effort"), call \`update_issue_priority_or_effort\`. Only DevOps team members may do this; if the tool refuses, explain that politely. Urgent=P0, High=P1, Medium=P2, Low=P3. Raising to P0 (Urgent) automatically starts escalation, so don't promise anything beyond that.
   - If asked to log/note findings on an issue, call \`add_issue_comment\`.
   - If a DevOps teammate says an issue will take until/for some date ("#1 will take till Friday", "ETA Monday"), convert it to YYYY-MM-DD using TODAY and call \`set_issue_eta\` — this silences reminders until then. Only team members may do this.

3. **FYIs or non-tasks**:
   - If \`isBotMentioned\` is YES and the message is just an FYI or casual greeting, reply briefly and politely without creating a GitHub issue.
   - If \`isBotMentioned\` is NO (only a team member was tagged) and the message is casual banter or not an actionable DevOps task (e.g. "hey @ravi good morning" or "thanks!"), output EXACTLY \`NO_REPLY\` and nothing else.

4. **Formatting**:
   - Use Slack mrkdwn: *bold* (single asterisks, NOT **double**), \`code\`, and <URL|text> for links.
   - Keep replies concise, clear, and friendly.`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Include thread history when replying inside a thread (excluding the current message if already present)
  if (isInsideThread && threadHistory.length > 0) {
    const priorHistory = threadHistory.filter(m => m.ts !== event.ts);
    for (const msg of priorHistory) {
      messages.push({
        role: msg.role,
        content: msg.role === 'user' ? `[${msg.senderName}]: ${msg.content}` : msg.content,
      });
    }
  }

  messages.push({
    role: 'user',
    content: `[${event.userName}]: ${event.text}`,
  });

  let createdIssue: GitHubIssue | null = null;
  let createdTaskPriority: Priority | undefined;
  let assignedGithubUsername: string | undefined;
  const closedIssueNumbers: number[] = [];
  const priorityChanges: { issueNumber: number; priority: Priority }[] = [];

  const MAX_TURNS = 6;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await createChatCompletion(messages, AGENT_TOOLS, 0.2);
    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const text = (choice.content || '').trim();
      if (!text || text === 'NO_REPLY') {
        return { replyText: null, createdIssue, createdTaskPriority, assignedGithubUsername, closedIssueNumbers, priorityChanges };
      }
      return { replyText: text, createdIssue, createdTaskPriority, assignedGithubUsername, closedIssueNumbers, priorityChanges };
    }

    // Append assistant's tool call request
    messages.push({
      role: 'assistant',
      content: choice.content || '',
      tool_calls: toolCalls,
    });

    // Execute every requested tool call
    for (const tc of toolCalls) {
      let args: Record<string, any> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      console.log(`   [Agent Tool] ${tc.function.name}(${JSON.stringify(args)})`);

      let toolOutput: string;
      try {
        switch (tc.function.name) {
          case 'check_duplicate_issue': {
            const dup = await github.findSimilarOpenIssue(String(args.title_keywords || ''));
            toolOutput = dup
              ? JSON.stringify({ duplicateFound: true, issue: { number: dup.number, title: dup.title, url: dup.url, assignees: dup.assignees, labels: dup.labels } })
              : JSON.stringify({ duplicateFound: false });
            break;
          }
          case 'get_team_workload': {
            const workloads = await fetchTeamWorkload(github);
            toolOutput = JSON.stringify(
              workloads.map(w => ({
                githubUsername: w.githubUsername,
                slackId: w.slackId,
                openCount: w.openIssues.length,
                loadScore: w.loadScore,
                openIssues: w.openIssues.map(i => ({
                  number: i.number,
                  title: i.title,
                  labels: i.labels,
                  url: i.url,
                })),
              }))
            );
            break;
          }
          case 'create_github_issue': {
            const priority = (PRIORITIES.includes(args.priority) ? args.priority : 'P2') as Priority;
            const estimate = (['low', 'medium', 'high'].includes(args.estimate) ? args.estimate : 'medium') as 'low' | 'medium' | 'high';
            const hoursRaw = Number(args.estimate_hours);
            const estimateHours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 500 ? Math.round(hoursRaw * 4) / 4 : undefined;

            // An explicitly requested person who isn't in TEAM_MEMBERS must NOT be silently swapped for someone else.
            const requestedAssignee = String(args.assignee_github_username || '').trim();
            if (requestedAssignee && !findTeamMember(requestedAssignee)) {
              toolOutput = JSON.stringify({
                error: `${unknownMemberMessage(requestedAssignee)} Tell the user this, and ask whether to assign to one of the known teammates instead. Do not create the issue until they answer.`,
              });
              break;
            }

            const choice = chooseAssignee(requestedAssignee, workloads, availability);
            const assignee = choice.assignee;
            setAssignmentNote(choice.note);
            setIssueExtras({ estimateHours });
            const threadRoot = event.threadTs || event.ts;
            const requester = resolveRequester(event, threadHistory, threadRoot);
            const nameOf = (id: string) => config.team.find(m => m.slackId === id)?.githubUsername;
            const issue = await github.createIssue(
              {
                title: String(args.title || event.text.slice(0, 75)),
                body: composeIssueBody(String(args.body || ''), {
                  requesterName: requester.name,
                  originalText: slackToPlain(requester.text, nameOf),
                  askedBy: requester.fromThreadRoot && requester.id !== event.userId ? { name: event.userName, text: slackToPlain(event.text, nameOf) } : undefined,
                  priority,
                  estimate,
                  estimateHours,
                }),
                priority,
                estimate,
              },
              assignee,
              event.threadTs || event.ts,
              event.channelId
            );
            createdIssue = issue;
            createdTaskPriority = priority;
            assignedGithubUsername = assignee;
            toolOutput = JSON.stringify({ created: true, issue });
            break;
          }
          case 'get_issue_details': {
            const num = Number(args.issue_number);
            const issue = await github.getIssueByNumber(num);
            toolOutput = issue ? JSON.stringify(issue) : JSON.stringify({ error: `Issue #${num} not found.` });
            break;
          }
          case 'update_issue_status': {
            const num = Number(args.issue_number);
            const status = args.status as IssueStatus;
            const updated = await github.updateIssueStatus(num, status);
            if (updated && status === 'done') closedIssueNumbers.push(updated.number);
            toolOutput = updated
              ? JSON.stringify({ updated: true, number: updated.number, state: updated.state, labels: updated.labels, url: updated.url })
              : JSON.stringify({ error: `Issue #${num} not found.` });
            break;
          }
          case 'reassign_issue': {
            const num = Number(args.issue_number);
            const target = findTeamMember(String(args.assignee_github_username || ''));
            if (!target) {
              toolOutput = JSON.stringify({
                error: `${unknownMemberMessage(String(args.assignee_github_username || '(nobody)'))} Tell the user this instead of reassigning.`,
              });
              break;
            }
            const assignee = target.githubUsername;
            const targetAvail = availability.get(target.slackId);
            if (targetAvail && !targetAvail.available) {
              toolOutput = JSON.stringify({
                error: `${assignee} is out of office until ${targetAvail.untilLabel ?? 'later'}. Tell the user and suggest an available teammate instead of reassigning.`,
              });
              break;
            }
            const updated = await github.reassignIssue(num, assignee);
            toolOutput = updated
              ? JSON.stringify({ reassigned: true, number: updated.number, assignees: updated.assignees, url: updated.url })
              : JSON.stringify({ error: `Issue #${num} not found.` });
            break;
          }
          case 'update_issue_priority_or_effort': {
            const num = Number(args.issue_number);
            if (!isTeamMember(event.userId)) {
              toolOutput = JSON.stringify({
                error: 'Only DevOps team members can change priority or effort. Tell the user a teammate needs to do it, and offer to add a comment on the issue noting the request instead.',
              });
              break;
            }
            const priority = PRIORITIES.includes(args.priority) ? (args.priority as Priority) : undefined;
            const estimate = ['low', 'medium', 'high'].includes(args.estimate) ? (args.estimate as 'low' | 'medium' | 'high') : undefined;
            if (!priority && !estimate) {
              toolOutput = JSON.stringify({ error: 'Provide a valid priority (P0/P1/P2/P3) and/or estimate (low/medium/high).' });
              break;
            }
            const updated = await github.updateIssueMeta(num, { priority, estimate });
            if (!updated) {
              toolOutput = JSON.stringify({ error: `Issue #${num} not found.` });
            } else {
              if (priority) priorityChanges.push({ issueNumber: num, priority });
              toolOutput = JSON.stringify({ updated: true, number: updated.number, labels: updated.labels, url: updated.url });
            }
            break;
          }
          case 'set_issue_eta': {
            const num = Number(args.issue_number);
            if (!isTeamMember(event.userId)) {
              toolOutput = JSON.stringify({ error: 'Only DevOps team members can set an ETA. Suggest a teammate sets it, or add a comment on the issue instead.' });
              break;
            }
            const etaMs = etaEndOfDayMs(String(args.eta_date || ''));
            if (etaMs === null) {
              toolOutput = JSON.stringify({ error: 'eta_date must be a real date in YYYY-MM-DD form.' });
              break;
            }
            if (etaMs < Date.now()) {
              toolOutput = JSON.stringify({ error: 'That date is already in the past. Ask the user for a future date.' });
              break;
            }
            const target = await github.getIssueByNumber(num);
            if (!target) {
              toolOutput = JSON.stringify({ error: `Issue #${num} not found.` });
              break;
            }
            const label = await setIssueEta(github, num, etaMs);
            toolOutput = JSON.stringify({ ok: true, number: num, eta: label });
            break;
          }
          case 'add_issue_comment': {
            const num = Number(args.issue_number);
            await github.addIssueComment(num, String(args.comment || ''));
            toolOutput = JSON.stringify({ commentAdded: true, issueNumber: num });
            break;
          }
          default:
            toolOutput = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
        }
      } catch (toolErr) {
        toolOutput = JSON.stringify({ error: (toolErr as Error).message });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolOutput,
      });
    }
  }

  return {
    replyText: createdIssue
      ? `✅ Created <${createdIssue.url}|#${createdIssue.number} — ${createdIssue.title}> and assigned to *${assignedGithubUsername}*.`
      : 'Done!',
    createdIssue,
    createdTaskPriority,
    assignedGithubUsername,
    closedIssueNumbers,
    priorityChanges,
  };
}

export interface IssueBodyContext {
  requesterName: string;
  /** The message that actually carries the request — the thread's first message when inside a thread. */
  originalText: string;
  /** Someone else (e.g. a teammate) tagged the bot to log it. */
  askedBy?: { name: string; text: string };
  priority?: Priority;
  estimate?: 'low' | 'medium' | 'high';
  estimateHours?: number;
}

const EFFORT_RANGE = { low: '< 1 h', medium: '1–4 h', high: '> 4 h' } as const;

const quote = (text: string) => text.trim().split('\n').map(l => `> ${l}`).join('\n');

/**
 * Guarantees every issue body starts with a one-line summary (priority, effort, requester) and ends with the
 * original Slack message(s), whatever the LLM wrote in between.
 */
export function composeIssueBody(body: string, ctx: IssueBodyContext): string {
  const summary: string[] = [];
  if (ctx.priority) summary.push(`**Priority:** ${PRIORITY_NAMES[ctx.priority]}`);
  if (ctx.estimate) {
    summary.push(
      `**Effort:** ${ctx.estimateHours !== undefined ? `~${ctx.estimateHours} h (${ctx.estimate})` : `${ctx.estimate} (${EFFORT_RANGE[ctx.estimate]})`}`
    );
  }
  summary.push(`**Requested by:** ${ctx.requesterName}`);

  const main = body.trim() || `## Request\n${ctx.originalText.trim()}`;
  let out = `> ${summary.join(' · ')}\n\n${main}`;
  out += `\n\n<details><summary>Original Slack message — ${ctx.requesterName}</summary>\n\n${quote(ctx.originalText)}\n\n</details>`;
  if (ctx.askedBy) {
    out += `\n\n<details><summary>Message to the bot — ${ctx.askedBy.name}</summary>\n\n${quote(ctx.askedBy.text)}\n\n</details>`;
  }
  return out;
}

export interface AssigneeChoice {
  assignee: string;
  note: string;
}

/**
 * Code-level guarantee that nobody who is out of office gets a new task, whatever the LLM asked for.
 * Also builds the human-readable "why this assignee" note for the audit trail.
 */
export function chooseAssignee(
  requested: string,
  workloads: TeamWorkload[],
  availability: Map<string, Availability>
): AssigneeChoice {
  const isAvailable = (w: TeamWorkload) => availability.get(w.slackId)?.available !== false;
  const loadTable = workloads
    .map(w => {
      const a = availability.get(w.slackId);
      return `${w.githubUsername}=${w.loadScore}${a && !a.available ? ` (out until ${a.untilLabel ?? 'later'})` : ''}`;
    })
    .join(', ');

  const requestedName = findTeamMember(requested)?.githubUsername ?? '';
  const requestedWl = workloads.find(w => w.githubUsername === requestedName);
  const available = workloads.filter(isAvailable);
  const lowest = (list: TeamWorkload[]) => [...list].sort((a, b) => a.loadScore - b.loadScore)[0];

  if (requestedWl && isAvailable(requestedWl)) {
    return { assignee: requestedName, note: `lowest-load available dev chosen by the bot. Load scores: ${loadTable}.` };
  }
  if (available.length > 0) {
    const pick = lowest(available);
    const why = requestedWl ? `${requestedName} is out of office, so ` : '';
    return { assignee: pick.githubUsername, note: `${why}picked the lowest-load available dev. Load scores: ${loadTable}.` };
  }
  const pick = lowest(workloads) ?? requestedWl;
  return {
    assignee: pick?.githubUsername ?? requestedName,
    note: `everyone is out of office — assigned the lowest-load dev anyway. Load scores: ${loadTable}.`,
  };
}

/** One short sentence telling the requester what was done, from the issue's human comments. */
export async function summarizeResolution(issue: GitHubIssue): Promise<string | null> {
  const human = (issue.comments || []).filter(c => !isAuditComment(c.body)).slice(-6);
  if (human.length === 0) return null;

  const completion = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          'You write one short plain sentence (max 30 words) telling a Slack requester what was done to resolve their DevOps request, based on the issue and its comments. No greeting, no markdown, no quotes. If unclear, say it was completed.',
      },
      {
        role: 'user',
        content: `Issue: ${issue.title}

Comments:
${human.map(c => `${c.author}: ${c.body.slice(0, 400)}`).join('\n')}`,
      },
    ],
    undefined,
    0.2
  );
  const text = completion.choices[0]?.message?.content?.trim().replace(/^["'“]|["'”]$/g, '');
  return text || null;
}

/**
 * Normalises a request into a short kebab-case topic ("vpn-access-reset"), reusing a known topic
 * when it describes the same kind of request.
 */
export async function classifyRequestTopic(title: string, body: string, knownTopics: string[]): Promise<string | null> {
  const completion = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          'You label DevOps requests with a topic slug: 2-4 lowercase words joined by hyphens that name the KIND of request, not the specific incident (e.g. vpn-access-reset, staging-restart, ssl-cert-renewal, github-access-request). ' +
          'If one of the KNOWN TOPICS describes the same kind of request, return it exactly. Reply with JSON only: {"topic":"..."}',
      },
      {
        role: 'user',
        content: `KNOWN TOPICS: ${knownTopics.length ? knownTopics.join(', ') : '(none)'}\n\nTitle: ${title}\nDetails: ${body.slice(0, 600)}`,
      },
    ],
    undefined,
    0
  );
  const raw = completion.choices[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const topic = String(JSON.parse(match[0]).topic || '').trim();
    return topic || null;
  } catch {
    return null;
  }
}

/**
 * Generates the auto-status reply when a team member is tagged but hasn't responded.
 */
export async function generateWorkloadReply(
  taggedMemberDisplay: string,
  openIssues: GitHubIssue[],
  timeoutMinutes: number
): Promise<string> {
  if (openIssues.length === 0) {
    return `Hey! 👋 ${taggedMemberDisplay} hasn't responded yet (${timeoutMinutes}m) — they may be away or in a meeting, though they have no open DevOps tasks right now. They'll get back to you soon!`;
  }

  const issueList = openIssues.slice(0, 5).map(i => {
    const status = i.labels.includes('in-progress') ? '🔄 In Progress' : i.labels.includes('blocked') ? '🚫 Blocked' : '📋 Open';
    const priority = i.labels.find(l => l.startsWith('P')) || 'P2';
    return `  ${status} [#${i.number}] ${i.title} (${priority})`;
  }).join('\n');

  const completion = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are the friendly DevOps Taskbot writing a brief auto-reply in Slack because ${taggedMemberDisplay} hasn't responded in ${timeoutMinutes} minutes. Explain politely what they are currently occupied with using their actual open task list below so the requester understands the delay. Use Slack mrkdwn (*bold*), keep it concise (max 4 sentences), and preserve the exact member mention ${taggedMemberDisplay}.`,
      },
      {
        role: 'user',
        content: `Team member: ${taggedMemberDisplay}\nTheir current open tasks:\n${issueList}`,
      },
    ],
    undefined,
    0.3
  );

  return completion.choices[0]?.message?.content?.trim() || `Hey! ${taggedMemberDisplay} is currently occupied with:\n${issueList}`;
}

/**
 * Formats a daily digest message summarizing the team's GitHub issues.
 */
export async function generateDailyDigest(
  workloads: WorkloadContext[],
  closedYesterday: number,
  outOfOffice: string[] = [],
  needsAttention: string[] = []
): Promise<string> {
  const totalOpen = workloads.reduce((sum, w) => sum + w.openIssues.length, 0);
  const totalInProgress = workloads.reduce(
    (sum, w) => sum + w.openIssues.filter(i => i.labels.includes('in-progress')).length,
    0
  );
  const p0Count = workloads.reduce(
    (sum, w) => sum + w.openIssues.filter(i => i.labels.includes('P0')).length,
    0
  );

  const perPersonLines = workloads.map(w => {
    const inP = w.openIssues.filter(i => i.labels.includes('in-progress')).length;
    const topTasks = w.openIssues.slice(0, 2).map(i => `\`#${i.number}\` ${i.title}`).join(', ');
    return `  • *${w.githubUsername}* — ${w.openIssues.length} open, ${inP} in-progress${topTasks ? `: ${topTasks}` : ''}`;
  }).join('\n');

  let digest = `📋 *DevOps Daily Standup — ${new Date().toLocaleDateString('en-GB', { timeZone: config.bot.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}*\n`;
  digest += `🔴 Open: *${totalOpen}* | 🔄 In Progress: *${totalInProgress}* | ✅ Closed yesterday: *${closedYesterday}*`;
  if (p0Count > 0) digest += ` | 🚨 P0 issues: *${p0Count}*`;
  digest += `\n\n*Team Breakdown:*\n${perPersonLines}`;
  if (needsAttention.length > 0) digest += `\n\n🔔 *Needs attention:*\n${needsAttention.map(l => `  • ${l}`).join('\n')}`;
  if (outOfOffice.length > 0) digest += `\n\n🌴 *Out of office today:*\n${outOfOffice.map(l => `  • ${l}`).join('\n')}`;
  digest += `\n\nTag me anytime with \`status\` or ask about any task!`;
  return digest;
}
