import OpenAI from 'openai';
import { config } from './config.js';
import type {
  GitHubIssue,
  GitHubProvider,
  IncomingMessageEvent,
  IssueStatus,
  ThreadMessage,
} from './types.js';
import { fetchTeamWorkload, type TeamWorkload } from './utils/workload.js';
import { AUDIT_MARKER, setAssignmentNote } from './audit.js';
import type { Availability } from './availability.js';

interface WorkloadContext {
  githubUsername: string;
  openIssues: GitHubIssue[];
}

export interface AgentResult {
  replyText: string | null;
  createdIssue: GitHubIssue | null;
  createdTaskPriority?: 'P0' | 'P1' | 'P2';
  assignedGithubUsername?: string;
  /** Issue numbers the agent closed (status → done) during this run. */
  closedIssueNumbers?: number[];
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
  let lastError: unknown;

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
        lastError = err;
        if (isRetryableError(err) && attempt < retryDelays.length) {
          const delay = retryDelays[attempt];
          console.warn(`⚠️ LLM provider "${name}" returned ${(err as any).status} — retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    if (i < chain.length - 1) {
      console.warn(`⚠️ LLM provider "${name}" failed (${(lastError as Error).message}) — failing over to "${chain[i + 1].name}"...`);
    }
  }
  throw lastError;
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
            description: 'Markdown description covering context, impact, and steps/details.',
          },
          priority: {
            type: 'string',
            enum: ['P0', 'P1', 'P2'],
            description: 'P0=prod down/critical/urgent, P1=blocking/failing, P2=routine/normal.',
          },
          estimate: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'low=<1h, medium=1-4h, high=>4h.',
          },
          assignee_github_username: {
            type: 'string',
            description: 'Exact GitHub username from the configured team list, chosen by lowest workload unless explicitly requested.',
          },
        },
        required: ['title', 'body', 'priority', 'estimate', 'assignee_github_username'],
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

  const systemPrompt = `You are DevOps Tracker Bot in a Slack channel for a small 2-3 person DevOps team.
You manage DevOps tasks using GitHub Issues and keep everyone informed in Slack threads.

TEAM MEMBERS & CURRENT WORKLOAD:
${teamInfo}

CURRENT OPEN GITHUB ISSUES (for duplicate detection & status queries):
${openIssuesSummary}

CURRENT CONTEXT:
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
   - If asked to log/note findings on an issue, call \`add_issue_comment\`.

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
  let createdTaskPriority: 'P0' | 'P1' | 'P2' | undefined;
  let assignedGithubUsername: string | undefined;
  const closedIssueNumbers: number[] = [];

  const MAX_TURNS = 6;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await createChatCompletion(messages, AGENT_TOOLS, 0.2);
    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const text = (choice.content || '').trim();
      if (!text || text === 'NO_REPLY') {
        return { replyText: null, createdIssue, createdTaskPriority, assignedGithubUsername, closedIssueNumbers };
      }
      return { replyText: text, createdIssue, createdTaskPriority, assignedGithubUsername, closedIssueNumbers };
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
            const priority = (['P0', 'P1', 'P2'].includes(args.priority) ? args.priority : 'P2') as 'P0' | 'P1' | 'P2';
            const estimate = (['low', 'medium', 'high'].includes(args.estimate) ? args.estimate : 'medium') as 'low' | 'medium' | 'high';
            const choice = chooseAssignee(String(args.assignee_github_username || ''), workloads, availability);
            const assignee = choice.assignee;
            setAssignmentNote(choice.note);
            const issue = await github.createIssue(
              {
                title: String(args.title || event.text.slice(0, 75)),
                body: String(args.body || event.text),
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
            const assignee = validateAssignee(String(args.assignee_github_username || ''));
            const target = config.team.find(m => m.githubUsername === assignee);
            const targetAvail = target ? availability.get(target.slackId) : undefined;
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
  };
}

function validateAssignee(candidate: string): string {
  const cleaned = candidate.trim().replace(/^@/, '');
  const exact = config.team.find(m => m.githubUsername.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact.githubUsername;
  const bySlack = config.team.find(m => m.slackId === cleaned);
  if (bySlack) return bySlack.githubUsername;
  return config.team[0]?.githubUsername || cleaned;
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

  const requestedName = validateAssignee(requested);
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
  const human = (issue.comments || []).filter(c => !c.body.startsWith(AUDIT_MARKER)).slice(-6);
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
        content: `You are a friendly DevOps tracker bot writing a brief auto-reply in Slack because ${taggedMemberDisplay} hasn't responded in ${timeoutMinutes} minutes. Explain politely what they are currently occupied with using their actual open task list below so the requester understands the delay. Use Slack mrkdwn (*bold*), keep it concise (max 4 sentences), and preserve the exact member mention ${taggedMemberDisplay}.`,
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
  outOfOffice: string[] = []
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

  let digest = `📋 *DevOps Daily Standup — ${new Date().toDateString()}*\n`;
  digest += `🔴 Open: *${totalOpen}* | 🔄 In Progress: *${totalInProgress}* | ✅ Closed yesterday: *${closedYesterday}*`;
  if (p0Count > 0) digest += ` | 🚨 P0 issues: *${p0Count}*`;
  digest += `\n\n*Team Breakdown:*\n${perPersonLines}`;
  if (outOfOffice.length > 0) digest += `\n\n🌴 *Out of office today:*\n${outOfOffice.map(l => `  • ${l}`).join('\n')}`;
  digest += `\n\nTag me anytime with \`status\` or ask about any task!`;
  return digest;
}
