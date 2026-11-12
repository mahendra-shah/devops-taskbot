# DevOps Taskbot

> A Slack ↔ GitHub Issues bridge for small DevOps teams.
> Automatically creates GitHub issues from Slack mentions, assigns tasks intelligently using an LLM, and syncs status updates via emoji reactions or conversational thread commands.

---

## ✨ Features

> Full catalogue of what the bot can do, who can do what, and current limits: **[docs/bot-capabilities.md](docs/bot-capabilities.md)**

- **Tag → GitHub Issue**: Whenever someone tags your team or the bot in the devops Slack channel, the bot creates a GitHub issue automatically and replies in the message's thread.
- **Always Replies in Threads**: Every interaction stays strictly within the thread, keeping channel root clean.
- **Thread Context & Follow-up Actions**: Tag `@bot` inside any thread to:
  - Ask: *"what is the status of this task?"* or *"summarize what we found"*
  - Command: *"update this task status from in progress to done"* or *"mark #4 blocked"*
  - Comment: *"note on this issue: restarted nginx, monitoring now"*
- **Smart Silence on Casual Banter**: If someone tags a team member without tagging `@bot` for casual chat (e.g. *"wanna grab coffee?"*), the bot stays quiet and does not create an issue or arm the timer.
- **LLM-Powered Fair Assignment**: Pre-inspects each member's live workload and assigns new tasks to whoever is least loaded.
- **Emoji Status Sync**: React with 👀 (`in-progress`), ✅ (`done`), 🚫 (`blocked`), or 💤 (`snooze`) on either the original message or the bot's reply.
- **Auto-Status Reply**: If a tagged team member doesn't respond in 90 minutes, the bot replies with what they're currently occupied with.
- **Daily Standup Digest**: Morning summary at 9:30 AM weekdays, including a *Needs attention* list of stuck issues.
- **Smart SLA reminders**: alerts on *silence*, not age — in working time only (Mon–Fri 9–18). Not-started issues wait by priority (High 8 h · Medium 2 days · Low 5 days); in-progress issues only nudge after 3 days with no activity; blocked ones never alert; big tasks get double; the clock pauses while the assignee is out. Reminders go to the issue's thread, tagging the assignee, at most every 3 days. Devs can say `@bot #1 will take till Friday` (ETA) or react 💤 to snooze. See [docs/bot-capabilities.md](docs/bot-capabilities.md#5b-sla-reminders--is-anyone-moving-this).
- **Out-of-Office Aware**: Reads each dev's Slack **status, display name and full name**. Someone who is OOO is never assigned new work; if they're tagged, the bot says so in the thread and explains who took the task. See [Out-of-office rules](#-out-of-office-rules).
- **Requester Updates**: When a request is closed (✅, via `@bot`, or directly on GitHub) the bot replies in the original thread and tags the person who asked.
- **P0 Escalation**: An un-acknowledged P0 escalates at 30 / 60 / 120 min (assignee → every available dev → everyone + `@here`). Any 👀/reaction/thread reply or status change stops it.
- **Repeat-Request Detection**: The same kind of request 3× in 30 days → one note in the channel suggesting automation or a runbook.
- **Audit Trail**: Every create / status change / reassignment / escalation is logged in SQLite **and** commented on the GitHub issue (who, via what, and why this assignee).
- **Project board = source of truth**: Status (Todo / In Progress / Done), Priority (Urgent / High / Medium / Low) and Effort/Estimate are set on your GitHub Projects card — not as labels — and the bot reads the board back, so dragging a card is respected. Falls back to labels if the board can't take a value. Optional — see `GITHUB_PROJECT_NUMBER`.
- **Helpful errors**: plain-language explanations in the thread (never raw provider errors or key fragments); config problems ping the team once per 30 min; a startup check flags a rejected AI key.
- **Bot-vs-human markers**: Because the bot uses your GitHub token, its actions are marked: `bot-created` label, a "Created by the DevOps Taskbot at the request of …" footer, 🤖 audit comments, and "Posted by the DevOps Taskbot on behalf of …" on notes it writes. Anything without a marker was done by a person directly on GitHub.
- **Structured issues**: Every issue starts with *Priority · Effort (hours) · Requested by*, then Request / Context / Definition of done, and the original Slack message(s) collapsed. The requester is the thread's first author, not whoever tagged the bot.
- **Weekly Report by Email**: Friday 18:00 — completed/opened/open counts, per-dev handled work + average resolution time, top requesters, repeat topics. Sent with nodemailer (not posted to Slack).
- **Survives Restarts**: No-reply timers, thread↔issue links and escalation watches are stored in SQLite (`./data/devops-tracker.db`).
- **Terminal Simulator (No Slack Needed)**: Test everything interactively from your terminal with `npm run chat`!

---

## ⚙️ Setup

### 1. Install dependencies

```bash
cd devops-taskbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your tokens in .env
```

### 3. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From Scratch**
2. **Socket Mode**: Enable it under *Settings → Socket Mode* → generate an **App-Level Token** (`xapp-...`) with `connections:write` scope
3. **OAuth Scopes** (under *OAuth & Permissions → Bot Token Scopes*):
   - `app_mentions:read`, `channels:history`, `chat:write`, `reactions:read`, `users:read`, `users:read.email`
4. **Event Subscriptions** (under *Event Subscriptions → Subscribe to bot events*):
   - `app_mention` (when @bot is tagged)
   - `message.channels` (catches team member mentions without @bot & tracks thread replies)
   - `reaction_added` (syncs emoji reactions to GitHub)
   - `user_change` (refreshes out-of-office state the moment someone edits their status or name)
5. Install the app to your workspace and copy the **Bot Token** (`xoxb-...`)
6. Invite the bot to your devops channel: `/invite @devopsbot`

### 4. Create the GitHub Repo

Create a repository (e.g., `devops-tasks`) for issue tracking and generate a **Personal Access Token** with `repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens).

### 5. Build and run

```bash
npm run build
npm start
```

---

## 🧪 Testing & Chatting Without Slack

You don't need Slack to test or interact with the bot!

### Interactive Terminal Chat Simulator

Talk to the bot directly from your terminal:

```bash
# Safe sandbox mode (in-memory Mock GitHub)
npm run chat

# Or talk to the bot using your real GitHub repo (no Slack connection)
npm run chat:live
```

Inside the CLI chat:
- Tag `@bot` or `@<githubUsername>` to post messages
- `/new` to start a fresh root message
- `/thread <ts>` or `/threads` to switch threads
- `/as requester` or `/as <githubUsername>` to switch speaker identity
- `/react eyes` / `/react done` / `/react blocked` to test emoji reactions
- `/timeout` to trigger the 90-min "no reply" auto-status reply immediately
- `/issues` to inspect open GitHub issues
- `/ooo <dev> <text>`, `/dname <dev> <text>`, `/fname <dev> <text>` set a dev's Slack **status / display name / full name** (try `/ooo mahendra OOO till 15 Nov`, then tag them)
- `/back <dev>` clears it, `/who` shows who the bot thinks is out
- `/escalate <minutes>` fast-forwards the P0 escalation check; `/ghclose <#>` closes an issue "on GitHub" to test requester updates; `/audit` prints the audit log

### Automated Scenario Tests

```bash
# Fast offline test suite — original 8 scenarios + 91 feature checks, zero API quota
npm test

# Read-only check that the bot can see your GitHub Project board and how it maps Status/Priority/Effort
npm run check:board

# Print what a bot-created issue will look like (GitHub issue + board card + Slack messages), no real GitHub touched
npm run preview:issue

# Only the newer features (OOO, escalation, requester updates, audit, report, …)
npm run test:features

# Full live LLM scenario run (uses real Gemini/DeepSeek from .env + mock GitHub)
npm run test:scenarios
```

---

## 📋 Slack Usage Examples

### 1. Tagging a dev or bot with a new task

```
@devopsbot The staging deployment pipeline is broken, Jenkins is throwing a 403 on webhook delivery.
```
*Bot replies in thread:*
> 🟢 *New DevOps Task Created!*
> *#4 — The staging deployment pipeline is broken...*
> 👤 Assigned to: *mahendra-shah* | 🟢 Priority: *P2* | 🔴 Effort: *high*
> _React with 👀 to mark in-progress, ✅ when done, 🚫 if blocked._

### 2. Conversational thread follow-ups

Inside the thread created above:
```
@devopsbot what is the status of this task?
```
```
@devopsbot update this task status from in progress to done
```

### 3. Emoji reactions

React to the original message or the bot's reply:

| Emoji | Meaning | GitHub Action |
|---|---|---|
| 👀 `:eyes:` | In progress | Adds `in-progress` label |
| ✅ `:white_check_mark:` | Done | Closes GitHub issue |
| 🚫 `:no_entry:` | Blocked | Adds `blocked` label |
| 💤 `:zzz:` | Give me 60 more mins | Snoozes auto-reply timer |

### 4. Fast commands

```
@devopsbot status
@devopsbot assign #4 to ravi-gh
```

---

## 🌴 Out-of-office rules

The bot checks three places on each dev's Slack profile — **status** (text + emoji + Slack's "clear after"), **display name**, and **full name** — for a keyword (`OOO`, `out of office`, `on leave`, `leave`, `vacation`, `holiday`, `PTO`, `sick`, `🌴 🤒 ✈️ …`).

| What they set | Meaning |
|---|---|
| Keyword + dates — `OOO till 15 Nov`, `Leave 12-14 Nov`, `on leave until 20/11`, `OOO back Monday` | Away for those dates (day-first: `20/11` = 20 Nov) |
| Slack status with a **"clear after"** time | Away until it clears |
| Keyword with **no date** — just `OOO` | Away for **that day only** (counted from the day the bot first saw it, in their timezone) |
| `OOO tomorrow`, `OOO 15 Nov` | Away only on that day |
| `Working remotely`, `In a meeting`, `Out for lunch`, `Focusing` | Not OOO |

Relative words (`tomorrow`, `till friday`) are anchored to the day the marker was first seen, so a stale label never slides into the future. If Slack can't be read (e.g. missing `users:read`), the bot fails open and treats everyone as available. Planned future leave isn't supported yet (a Slack status takes effect immediately).

---

## 🗂️ Project Structure

```
devops-tracker/
├── src/
│   ├── index.ts           # Boot sequence (labels → Slack)
│   ├── bot.ts             # Core DevOpsBot brain (platform-independent)
│   ├── slack.ts           # Slack Bolt adapter (Socket Mode, events)
│   ├── github.ts          # Octokit GitHub provider (create/update/find)
│   ├── llm.ts             # Gemini/DeepSeek agent + daily digest + auto-reply
│   ├── scheduler.ts       # No-reply timers (persisted), daily standup cron, SLA alerts
│   ├── availability.ts    # Out-of-office detection (status / display name / full name)
│   ├── escalation.ts      # P0 escalation watches (30/60/120 min)
│   ├── requesterUpdates.ts# Tells the requester in their thread when an issue closes
│   ├── topics.ts          # Repeat-request detection
│   ├── audit.ts           # Audit trail: SQLite log + GitHub issue comments
│   ├── report.ts          # Weekly report (nodemailer email)
│   ├── store.ts           # SQLite persistence
│   ├── config.ts          # Env loader & team member map
│   ├── types.ts           # Core interfaces
│   └── utils/
│       ├── helpers.ts     # Slack mrkdwn formatters & mention utils
│       └── workload.ts    # Workload scores & status builder
├── tests/
│   ├── cli.ts             # Interactive terminal chat simulator
│   ├── simulator.ts       # SimulatedSlackEnvironment (channels, threads, timers)
│   ├── github-mock.ts     # In-memory MockGitHubProvider
│   ├── mock-agent.ts      # Deterministic stand-in for the LLM agent
│   ├── test-offline.ts    # Fast 8-scenario deterministic test suite (npm test)
│   ├── test-features.ts   # OOO, escalation, requester updates, audit, report… (npm run test:features)
│   └── test-scenarios.ts  # Live LLM scenario test suite (npm run test:scenarios)
├── tsconfig.json          # Compiles src/ -> dist/
├── tsconfig.tests.json    # Compiles src/ + tests/ -> dist-tests/
├── .env.example
├── package.json
└── README.md
```
