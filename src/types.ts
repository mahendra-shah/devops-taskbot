export type IssueStatus = 'open' | 'in-progress' | 'done' | 'blocked';

export interface GitHubComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  comments?: GitHubComment[];
}

export interface ParsedTask {
  title: string;
  body: string;
  estimate: 'low' | 'medium' | 'high';
  priority: 'P0' | 'P1' | 'P2';
  type: 'task' | 'question' | 'fyi';
  summary: string;
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  senderName: string;
  senderId?: string;
  content: string;
  ts: string;
}

export interface IncomingMessageEvent {
  channelId: string;
  ts: string;
  /** Defined if this message is inside an existing thread; undefined for root channel messages. */
  threadTs?: string;
  userId: string;
  userName: string;
  text: string;
  isBotMentioned: boolean;
  mentionedTeamMemberIds: string[];
}

export interface BotPlatformAdapter {
  replyInThread(channelId: string, threadTs: string, text: string): Promise<void>;
  addReaction(channelId: string, ts: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, ts: string, emoji: string): Promise<void>;
  getThreadHistory(channelId: string, threadTs: string): Promise<ThreadMessage[]>;
  getMessageText?(channelId: string, ts: string): Promise<{ text: string; threadTs?: string } | null>;
  trackPendingReply?(messageTs: string, channelId: string, taggedMemberIds: string[]): void;
  clearPendingReply?(messageTs: string): void;
  snoozePendingReply?(messageTs: string): boolean;
  /** Post a top-level (non-threaded) message to the devops channel. */
  postToChannel?(channelId: string, text: string): Promise<void>;
}

export interface GitHubProvider {
  readonly isMock: boolean;
  ensureLabelsExist(): Promise<void>;
  createIssue(
    task: Pick<ParsedTask, 'title' | 'body' | 'priority' | 'estimate'>,
    assigneeGithubUsername: string,
    slackMessageTs: string,
    slackChannelId: string
  ): Promise<GitHubIssue>;
  updateIssueStatus(issueNumber: number, status: IssueStatus): Promise<GitHubIssue | null>;
  reassignIssue(issueNumber: number, newAssignee: string): Promise<GitHubIssue | null>;
  /** Change the P0/P1/P2 and/or effort:* label of an existing issue (replaces the old one). */
  updateIssueMeta(
    issueNumber: number,
    meta: { priority?: 'P0' | 'P1' | 'P2'; estimate?: 'low' | 'medium' | 'high' }
  ): Promise<GitHubIssue | null>;
  addIssueComment(issueNumber: number, comment: string): Promise<void>;
  addIssueLabel(issueNumber: number, label: string): Promise<void>;
  getIssueByNumber(issueNumber: number): Promise<GitHubIssue | null>;
  getOpenIssuesForUser(githubUsername: string): Promise<GitHubIssue[]>;
  getAllOpenIssues(): Promise<GitHubIssue[]>;
  findIssueBySlackTs(slackTs: string): Promise<GitHubIssue | null>;
  findSimilarOpenIssue(title: string): Promise<GitHubIssue | null>;
  countClosedYesterday(): Promise<number>;
  /** Issues closed at or after `sinceIso` (used by the weekly report). */
  getClosedSince(sinceIso: string): Promise<GitHubIssue[]>;
}

/** Posts a Slack message; `threadTs` undefined = top-level channel message. */
export type PostMessageFn = (channelId: string, threadTs: string | undefined, text: string) => Promise<void>;
