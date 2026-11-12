import dotenv from 'dotenv';
dotenv.config();

/**
 * Parse the TEAM_MEMBERS env var into a usable map.
 * Format: "SLACK_ID:github_username,SLACK_ID:github_username"
 */
function parseTeamMembers(): { slackId: string; githubUsername: string }[] {
  const raw = process.env.TEAM_MEMBERS || '';
  if (!raw.trim()) return [];
  return raw.split(',').map(pair => {
    const [slackId, githubUsername] = pair.trim().split(':');
    return { slackId: slackId.trim(), githubUsername: githubUsername.trim() };
  });
}

function parseIntList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw || !raw.trim()) return fallback;
  const nums = raw.split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? nums.sort((a, b) => a - b) : fallback;
}

function numEnv(name: string, fallback: number): number {
  const n = parseFloat(process.env[name] || '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "1-5" or "1,2,3,4,5" → ISO weekdays (1 = Mon … 7 = Sun). */
function parseWorkDays(raw: string | undefined, fallback: number[]): number[] {
  if (!raw || !raw.trim()) return fallback;
  const range = /^(\d)-(\d)$/.exec(raw.trim());
  if (range) {
    const out: number[] = [];
    for (let d = +range[1]; d <= +range[2]; d++) out.push(d);
    return out.length ? out : fallback;
  }
  const list = raw.split(',').map(x => parseInt(x.trim(), 10)).filter(n => n >= 1 && n <= 7);
  return list.length ? list : fallback;
}

function cleanDeepSeekUrl(url?: string): string {
  if (!url) return 'https://api.deepseek.com';
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === 'https://api.deepseek.com/v1') return 'https://api.deepseek.com';
  return trimmed;
}

/** All schedules (daily digest, weekly report) run in this timezone, regardless of the server's clock (EC2 = UTC). */
const BOT_TIMEZONE = process.env.BOT_TIMEZONE || process.env.REPORT_TIMEZONE || 'Asia/Kolkata';

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    devopsChannelId: process.env.SLACK_DEVOPS_CHANNEL_ID || '',
  },

  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    /** GitHub Projects v2 board to keep in sync (Status + Priority fields). 0 = disabled. */
    project: {
      number: parseInt(process.env.GITHUB_PROJECT_NUMBER || '0', 10) || 0,
      /** 'organization' | 'user' — leave empty to auto-detect. */
      ownerType: ({ org: 'organization', organization: 'organization', user: 'user' } as Record<string, string>)[
        (process.env.GITHUB_PROJECT_OWNER_TYPE || '').toLowerCase()
      ] || '',
    },
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'deepseek').toLowerCase() as 'gemini' | 'deepseek',
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      apiUrl: cleanDeepSeekUrl(process.env.DEEPSEEK_API_URL),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
  },

  team: parseTeamMembers(),

  bot: {
    noReplyTimeoutMinutes: parseInt(process.env.NO_REPLY_TIMEOUT_MINUTES || '90', 10),
    dailyDigestCron: process.env.DAILY_DIGEST_CRON || '30 9 * * 1-5',
    showDevMetadata: process.env.SHOW_DEV_METADATA === 'true',
    timezone: BOT_TIMEZONE,
    /** Minutes after a P0 is created at which un-acknowledged P0s escalate (level 1, 2, 3…). */
    escalationMinutes: parseIntList(process.env.ESCALATION_MINUTES, [30, 60, 120]),
    /** Same topic requested this many times within the window → flag it as an automation candidate. */
    repeatThreshold: parseInt(process.env.REPEAT_REQUEST_THRESHOLD || '3', 10),
    repeatWindowDays: parseInt(process.env.REPEAT_REQUEST_WINDOW_DAYS || '30', 10),
  },

  /** SLA = "is anyone moving this?" — see src/sla.ts. Times are WORKING time in BOT_TIMEZONE. */
  sla: {
    highHours: numEnv('SLA_HIGH_HOURS', 8), // High: not started after this many working hours
    mediumDays: numEnv('SLA_MEDIUM_DAYS', 2), // Medium (or no priority)
    lowDays: numEnv('SLA_LOW_DAYS', 5),
    staleDays: numEnv('SLA_STALE_DAYS', 3), // in progress: no activity for this many working days
    workStart: numEnv('SLA_WORK_START', 9),
    workEnd: numEnv('SLA_WORK_END', 18),
    workDays: parseWorkDays(process.env.SLA_WORK_DAYS, [1, 2, 3, 4, 5]),
    repeatDays: numEnv('SLA_REPEAT_DAYS', 3), // at most one reminder per issue per this many days
    snoozeDays: numEnv('SLA_SNOOZE_DAYS', 3), // 💤 on a reminder
    bigTaskFactor: 2, // effort:high gets double the time
  },

  report: {
    cron: process.env.WEEKLY_REPORT_CRON || '0 18 * * 5', // Friday 18:00
    timezone: BOT_TIMEZONE,
    from: process.env.REPORT_FROM || process.env.SMTP_USER || '',
    to: (process.env.REPORT_TO || '').split(',').map(s => s.trim()).filter(Boolean),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
};

// Startup validation
const skipSlack = process.env.SKIP_SLACK_VALIDATION === 'true';
const skipGithub = process.env.SKIP_GITHUB_VALIDATION === 'true';

const errors: string[] = [];
if (!skipSlack) {
  if (!config.slack.botToken) errors.push('SLACK_BOT_TOKEN');
  if (!config.slack.appToken) errors.push('SLACK_APP_TOKEN');
  if (!config.slack.devopsChannelId) errors.push('SLACK_DEVOPS_CHANNEL_ID');
}
if (!skipGithub) {
  if (!config.github.token) errors.push('GITHUB_TOKEN');
  if (!config.github.owner) errors.push('GITHUB_OWNER');
  if (!config.github.repo) errors.push('GITHUB_REPO');
}
if (config.llm.provider === 'gemini' && !config.llm.gemini.apiKey) errors.push('GEMINI_API_KEY');
if (config.llm.provider === 'deepseek' && !config.llm.deepseek.apiKey) errors.push('DEEPSEEK_API_KEY');
if (config.team.length === 0) errors.push('TEAM_MEMBERS (must have at least one entry)');

if (errors.length > 0) {
  throw new Error(`❌ Missing required environment variables:\n  ${errors.join('\n  ')}\n\nCopy .env.example → .env and fill in the values.`);
}

console.log(`✓ Config loaded. Team: ${config.team.map(m => m.githubUsername).join(', ')} | LLM: ${config.llm.provider.toUpperCase()} | Channel: ${config.slack.devopsChannelId || 'SIMULATOR'}`);
