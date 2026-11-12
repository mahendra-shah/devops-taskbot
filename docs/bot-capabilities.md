# What the DevOps Taskbot can do

A Slack ↔ GitHub bridge for the DevOps team. People ask for things in the devops channel; the bot turns those into tracked GitHub issues, assigns them fairly, keeps everyone updated, and nags (politely) when something is stuck.

- **Who this is for:** the DevOps team (how to work with it) and anyone who requests DevOps work (what to expect).
- **Where it lives:** the devops Slack channel. It always replies **inside the message's thread**.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Ask DevOps for something | Post in the channel and tag `@bot` or a DevOps teammate |
| See who is doing what | `@bot status` |
| Ask about a task | In its thread: `@bot what's the status of this?` |
| Start work on a task | React 👀 on the task message |
| Finish a task | React ✅ |
| Mark a task blocked | React 🚫 |
| Ask the bot to wait before it nudges | React 💤 (adds 60 min; on a reminder, snoozes it 3 days) |
| Say a task will take a while | `@bot #1 will take till Friday` — no reminders until then (team only) |
| Change priority / effort | In the thread: `@bot make this urgent` / `@bot set priority to low` / `@bot set effort to high` (team only) |
| Reassign | `@bot assign #12 to <github-username>` |
| Say I'm away | Put `OOO` (with dates if you like) in your Slack **status**, **display name** or **full name** |

---

## 1. For anyone requesting work

**Create a task.** Tag `@bot` (or a DevOps teammate) with what you need, e.g. *"@bot please add an alert for Redis memory > 85%"*. The bot:

1. Checks open issues for a **duplicate** — if one exists it links it instead of creating another.
2. Creates a **GitHub issue** with a structured body: a summary line (**Priority · estimated effort in hours · requested by**), then Request, Context and Definition of done, and the original Slack message(s) collapsed at the bottom.
3. **Assigns the least-loaded available teammate** (never someone who is out of office).
4. Puts **Status** and **Priority** (Urgent / High / Medium / Low) and the **effort estimate** on the project board card.
5. Replies in your thread with the issue link, assignee, priority and effort.

**Who counts as the requester.** In a thread, it's whoever wrote the thread's *first* message — so if Renuka asks in a thread and a teammate says "@bot add this to GitHub", **Renuka** is the requester (she's the one who gets the "resolved" message). The teammate who tagged the bot is recorded separately.

**Urgent things.** Words like *"prod down"*, *"URGENT"*, *"502"* make it **Urgent (P0)** — see [Urgent (P0) handling](#4-urgent-p0-handling). Routine work is Medium; nice-to-haves are Low.

**Follow up in the thread.** Tag `@bot` inside the thread to ask *"what's the status?"* or *"what did we find?"*. It reads up to 30 messages of the thread plus the live GitHub issue, so you don't need to repeat context.

**Casual chat is ignored.** If you tag a teammate for banter ("thanks, coffee?"), the bot stays quiet.

**You'll be told when it's done.** When the issue is closed — by ✅, through the bot, or directly on GitHub — the bot replies in your original thread and tags you with a one-line summary and who closed it. It stays quiet when you closed your own request, or asked for the work for yourself.

**If your teammate is away.** Tag someone who is out of office and the bot says so, and tells you who picked it up instead.

**If nobody replies.** Tagged teammates who haven't responded after **90 minutes** trigger an automatic message showing what they're currently working on — so you know why it's slow.

---

## 2. For the DevOps team

### Emoji (on the task message **or** the bot's reply)

| Emoji | Effect |
|---|---|
| 👀 | Issue → **in progress** |
| ✅ | Issue → **done** (closed) and the requester is notified |
| 🚫 | Issue → **blocked** |
| 💤 | Snooze the "no reply" nudge by another 60 minutes |

Any reaction from a teammate also **stops the no-reply timer and P0 escalation**. Reactions from non-team members are ignored.

### Talk to it in plain English (tag `@bot`, usually inside the task's thread)

- *"mark this in progress"* / *"update this from in progress to done"* / *"reopen #7"*
- *"make this urgent"* / *"set priority to low"* / *"make this P0"* / *"bump to high effort"* — **team only** (Urgent = P0, High = P1, Medium = P2, Low = P3)
- *"note on this issue: restarted nginx, monitoring"* — adds a GitHub comment
- *"who's busiest right now?"* / *"what's on Ravi's plate?"*
- *"reassign this to priya-gh"* — refuses if that person is out of office, and says so plainly if the name isn't a known teammate

### Fast commands

- `@bot status` — workload table: open / in-progress / blocked / P0 per person, with 🌴 next to anyone out
- `@bot assign #12 to <github-user>` — reassigns (and warns if they're out)

### Marking yourself out of office

The bot reads three places on your Slack profile: **status** (text, emoji, "clear after"), **display name**, **full name**.

| You set | Meaning |
|---|---|
| `OOO till 15 Nov`, `Leave 12-14 Nov`, `on leave until 20/11`, `OOO back Monday` | Away for those dates (day-first: `20/11` = 20 Nov) |
| A Slack status with a **"clear after"** time | Away until it clears |
| Just `OOO` / `🌴` — no date | Away **that day only** |
| `OOO tomorrow` / `OOO 15 Nov` | Away only that day |
| *Working remotely*, *In a meeting*, *Out for lunch* | Not OOO |

While you're away you get **no new assignments**, aren't timed for replies, and aren't escalated to first. Changes apply within seconds (when the `user_change` Slack event is subscribed) or within 5 minutes otherwise. Planned *future* leave isn't supported yet — a Slack status takes effect immediately.

---

## 3. The project board is the source of truth

Status, Priority and Effort live on your GitHub Projects board (**DevOps queries**), **not** in labels:

| In Slack / bot | On the board |
|---|---|
| New issue | Status **Todo**, Priority from the request (Urgent / High / Medium / Low), Effort, and **Estimate** (hours) if the board has a number field called *Estimate* |
| 👀 | Status **In Progress** |
| ✅ | Status **Done** (and the issue is closed) |
| `@bot make this urgent` | Priority **Urgent** |

- **It works both ways.** If someone drags a card on the board, the bot sees it — load scores, `@bot status`, the digest and P0 escalation all follow the board.
- **No `in-progress` / `P1` label clutter.** Labels left on an issue are only `devops`, `bot-created` and `effort:*`.
- **Fallback to labels** — only if the board can't take a value (e.g. a **Blocked** column doesn't exist, the token lacks the `project` scope, or GitHub is down). Then the bot adds a `blocked` / priority label so nothing is lost. *Tip: add a "Blocked" column to the board if you want 🚫 to show there.*
- Check how the bot reads your board with `npm run check:board` (read-only).

---

## 3b. Fair assignment

Each person has a **load score** from their open issues (effort low/medium/high = 1/2/3, +2 for P0, +1 if in progress). New work goes to the **lowest score among people who are available**. This is enforced in code, so the AI can't override it. The reason is written on the issue ("picked the lowest-load available dev. Load scores: …").

---

## 4. Urgent (P0) handling

When something is P0 — created that way, or raised later with *"make this P0"* — the bot posts a 🚨 alert tagging the assignee and starts a watch. If **nobody acknowledges** it:

| After | What happens |
|---|---|
| 30 min | Reminds the assignee (or the available devs, if the assignee is out) |
| 60 min | Tags every available dev |
| 120 min | Tags everyone and `@here` |

**Acknowledge** with any reaction (👀 is the natural one), a reply in the thread, or by moving the issue to in-progress / closing it. Times are configurable (`ESCALATION_MINUTES`). If the bot was down for hours it sends **one** message at the highest due level, not a burst.

---

## 5. Things the bot does on its own

| What | When |
|---|---|
| **Daily standup digest** — open / in-progress / closed yesterday, per person, who's out | Weekdays 9:30 (`DAILY_DIGEST_CRON`, in `BOT_TIMEZONE`) |
| **SLA reminder** — a nudge to the assignee (in the issue's Slack thread) when nobody is moving an issue. See [Reminders](#5b-sla-reminders--is-anyone-moving-this) | Checked hourly, **working hours only** |
| **Needs attention** list in the daily digest — stuck, ETA-missed and blocked issues | With the daily digest |
| **Repeat-request note** — same kind of request **3×** in 30 days → one channel message suggesting automation or a runbook | When the 3rd lands |
| **Requester update** for issues closed directly on GitHub | Checked every 2 min |
| **Weekly report by email** — completed / opened / still open, work per person + average resolution time, top requesters, repeat topics, P0s and escalations | Fridays 18:00 (needs SMTP set up; **email only, never Slack**) |
| **Project board sync** — keeps the GitHub Projects card's Status and Priority in step with the labels | After every bot change (optional: `GITHUB_PROJECT_NUMBER`) |

---

## 5b. SLA reminders — "is anyone moving this?"

The bot no longer nags just because an issue is old. It reminds people when an issue is **sitting untouched**. Everything is measured in **working time** (Mon–Fri, 9:00–18:00 in `BOT_TIMEZONE`), so nights and weekends never count.

| Situation | Rule (defaults) |
|---|---|
| **Not started** (Todo) | **High** after 8 working hours · **Medium** (or no priority) after 2 working days · **Low** after 5 working days |
| **Urgent (P0)** | Not handled here — [P0 escalation](#4-urgent-p0-handling) covers it |
| **In progress** | No alert for age. Only if there's **no activity for 3 working days** — a comment, a status change, or moving the card on the board all count |
| **Blocked** | Never alerts. Listed under **Needs attention** in the daily digest |
| **Big tasks** (`effort:high`) | Double the time in every rule above |
| **Assignee is out of office** | The clock pauses for the time they're away |

**How reminders are sent**
- As a reply **in the issue's Slack thread**, tagging **only the assignee** — not the whole channel.
- Only during working hours, and **at most once every 3 days** per issue.
- The **3rd** reminder goes to the channel **once** ("still no movement after 2 reminders — reassign or re-scope?"), and then the bot stops.
- Anything stuck also shows in the **Needs attention** section of the daily digest.

**Controls — so the bot never nags about something expected**
- `@bot #1 will take till Friday` (team only) records an **ETA**. No reminders until that day has passed; then one "the ETA has passed — done, or set a new one?" nudge. The ETA is also written on the issue as an audit comment.
- React 💤 on the thread (team only) to snooze that issue's reminders for **3 days**.
- Moving the card or posting an update resets the silence clock.

**Tuning:** all numbers are settings (`SLA_HIGH_HOURS`, `SLA_MEDIUM_DAYS`, `SLA_LOW_DAYS`, `SLA_STALE_DAYS`, `SLA_WORK_START/END/DAYS`, `SLA_REPEAT_DAYS`, `SLA_SNOOZE_DAYS`). The old `SLA_BREACH_HOURS` and the `sla-breach-alerted` label are gone — reminder state lives in SQLite.

---

## 6. Transparency and safety

- **Audit trail.** Every create, status change, priority/effort change, reassignment and escalation is written to a SQLite log *and* as a 🤖 comment on the GitHub issue: who asked, via what (message / reaction), and why.
- **Bot vs. human.** The bot uses a teammate's GitHub token, so its actions appear under that person's name. They're marked: `bot-created` label, a "Created by the DevOps Taskbot at the request of …" footer, 🤖 audit comments (who asked, via what, why), and "Posted by the DevOps Taskbot on behalf of …" on notes it writes. **Anything without a marker was done by a person on GitHub.**
- **Survives restarts.** Timers, thread↔issue links and escalation watches are stored in `data/devops-tracker.db`.
- **Fails safe.** If Slack profiles can't be read, everyone counts as available. If the project board can't be read or written, the bot falls back to labels and Slack carries on.
- **Helpful errors.** Failures are explained in plain language in the thread — never raw provider text or key fragments. Setup problems (AI key rejected, no AI credit, bad GitHub token) also ping the team once per 30 minutes with what to check; every error has a short `ref` that matches the server log. Asking for a person who isn't in `TEAM_MEMBERS` gets a clear "I don't know X — here's who I can assign to" instead of a silent substitution.
- **Startup check.** On boot the bot makes one tiny call to each AI provider and logs `✓ reachable` / `✗ API key rejected`, so a bad key shows up at deploy time, not in a Slack thread.

---

## 7. Current limits and ideas

**Known limits**
- Planned future leave can't be set in advance (status is immediate).
- Natural-language **status** changes via `@bot` aren't restricted to the team (emoji and priority/effort changes are). Easy to tighten.
- Only people in `TEAM_MEMBERS` can be assigned. The bot can't see other GitHub users.
- A Google Calendar "Out of Office" event synced into Slack status counts as OOO.
- Actions appear under one person's GitHub account until a separate bot account/App is set up.
- Timers are stored on the machine the bot runs on; moving servers starts with an empty database.

**Ideas not built yet**
- Ask one clarifying question before creating an issue from a vague request.
- Mirror GitHub comments back into the Slack thread.
- Planned-leave command (`@bot ooo 20 Nov to 25 Nov`) or Google Calendar sync.
- Separate GitHub bot account / GitHub App.
- Issue types (Task / Bug) and milestones set automatically.
- Letting the bot learn GitHub users that aren't in `TEAM_MEMBERS` yet.

---

## 8. Setup and testing pointers

- Settings live in `.env` (see `.env.example`): timeouts, escalation minutes, timezone, SMTP, project board.
- Try everything **without Slack**: `npm run chat` (sandbox with a mock GitHub). Useful commands: `/ooo`, `/dname`, `/fname`, `/escalate`, `/ghclose`, `/audit`.
- Tests: `npm test` (no API quota needed). Board check: `npm run check:board` (read-only).
- Slack app needs scopes `app_mentions:read`, `channels:history`, `chat:write`, `reactions:read`, `users:read` and events `app_mention`, `message.channels`, `reaction_added`, `user_change`.
