# Run the bot as a GitHub App

**Goal:** when the bot creates, labels, comments on or closes an issue, GitHub shows **`<app-name>[bot]`**. When a person does something directly on GitHub, it still shows **that person**.

| Who did it | Shows on GitHub as |
|---|---|
| The bot (from Slack: new task, 👀 ✅ 🚫, "make this urgent", ETA, reminders…) | `<app-name>[bot]` |
| A teammate, directly on github.com | the teammate |
| *(today, with a personal token)* the bot | the teammate whose token it uses ❌ |

You need to be an **owner of the GitHub organisation** (navgurukul). It takes about 10 minutes.

---

## Step 1 — Create the App

1. Open **https://github.com/organizations/navgurukul/settings/apps/new**
2. Fill in:
   - **GitHub App name:** e.g. `NavG DevOps Taskbot` — this becomes the bot's name (`navg-devops-taskbot[bot]`). It must be unique across GitHub.
   - **Homepage URL:** anything valid, e.g. the repo URL.
   - **Webhook → Active:** **untick it** (the bot doesn't need webhooks).
3. **Permissions**
   - *Repository permissions* → **Issues: Read and write**. (Metadata: Read-only is added automatically.)
   - *Organization permissions* → **Projects: Read and write** (needed to move cards on the project board) and, if your org uses GitHub **issue fields** (Priority / Effort / Target date), **Issue fields: Read and write**.
4. **Where can this GitHub App be installed?** → **Only on this account**.
5. Click **Create GitHub App**.

## Step 2 — Collect the App ID and a private key

On the App's settings page:
1. Copy the **App ID** (a number near the top).
2. Scroll to **Private keys → Generate a private key**. A `.pem` file downloads. **Treat it like a password.**
3. *(Optional)* Upload a logo under **Display information** — it becomes the bot's avatar on GitHub.

## Step 3 — Install the App on the issues repo

1. In the App's left menu choose **Install App** → **navgurukul** → **Install**.
2. Choose **Only select repositories** → pick **devops-tasks** (your issues repo) → **Install**.
3. Look at the browser address bar: `…/settings/installations/12345678` — that number is the **Installation ID**.
4. If GitHub says the App is *requesting organisation permissions* (Projects), an owner must **accept** that request on the installation page.

> The project board must belong to the **organisation** (`github.com/orgs/navgurukul/projects/N`). GitHub Apps can't access projects owned by a personal account.

## Step 4 — Put the key and IDs on the server (EC2)

From your Mac:
```bash
scp ~/Downloads/<the-downloaded-file>.pem ubuntu@<EC2-IP>:~/devops-taskbot/secrets/github-app.pem
```
(If the `secrets` folder doesn't exist yet, create it on EC2 first.)

On EC2:
```bash
mkdir -p ~/devops-taskbot/secrets && chmod 700 ~/devops-taskbot/secrets
chmod 600 ~/devops-taskbot/secrets/github-app.pem
nano ~/devops-taskbot/.env
```
Add to `.env` (keep `GITHUB_TOKEN` for now — the App is used automatically as soon as these three are set):
```
GITHUB_APP_ID=1234567
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=/home/ubuntu/devops-taskbot/secrets/github-app.pem
```
The `secrets/` folder and `*.pem` files are git-ignored. Don't paste the key into Slack or commit it.

## Step 5 — Check it (read-only, changes nothing)

```bash
cd ~/devops-taskbot && npm ci && npm run build   # picks up the new code
npm run check:github
```
You want to see all `✓`:
```
✓ GitHub identity: GitHub App #1234567 … — bot actions appear as "<app>[bot]"
✓ App: "NavG DevOps Taskbot" (slug navg-devops-taskbot) — bot actions will appear as "navg-devops-taskbot[bot]"
✓ Installed on navgurukul (selected repositories)
✓ Permission Repository → Issues: Read & write …
✓ Permission Organization → Projects: Read & write …
✓ Can access navgurukul/devops-tasks
✓ Can read issues …
(+ your board's Status / Priority mapping)
```
A `✗` tells you exactly what's missing (a permission, or the App not installed on the repo).

**Optional full live test** — creates ONE throwaway, unassigned issue, changes its status / priority / target date through the bot's real code, checks everything on GitHub, then closes it (nobody is notified):
```bash
npm run selftest:github -- --yes
```

## Step 6 — Restart and test

```bash
nvm use 24.16.0 && pm2 restart devops-taskbot --update-env && pm2 logs devops-taskbot --lines 30
```
The startup log shows `GitHub identity: GitHub App #…`. Then in Slack ask the bot to create a test task:
- the issue's author on GitHub is **`<app>[bot]`**;
- react ✅ → "closed by `<app>[bot]`"; the 🤖 audit comment still says *who* asked (e.g. "✅ by Komal");
- close or edit an issue yourself on github.com → it shows **your** name.

## Step 7 — Clean up (after a day or two of stable running)

1. Remove `GITHUB_TOKEN` from `.env` and restart.
2. Revoke the old personal token at **github.com/settings/tokens**.

---

## Good to know

- **Assignees stay people.** A GitHub App can't be an assignee, and doesn't need to be: the bot still assigns issues to teammates. They must be collaborators on the repo, and their GitHub username in `TEAM_MEMBERS` must match exactly.
- **"Who asked" is still recorded.** Because the bot is now the GitHub author, the 🤖 audit comments (who asked, via what, why this assignee), the `bot-created` label and the "Created by the DevOps Taskbot at the request of …" footer matter even more — they link every bot action to the human who triggered it in Slack.
- **No more token expiry.** The App signs short-lived tokens from its private key and refreshes them itself.
- **Rotating the key:** generate a new key on the App page, replace the `.pem` on the server, restart, then delete the old key on GitHub.
- **Rolling back:** unset the three `GITHUB_APP_*` lines (and keep `GITHUB_TOKEN`) and restart — it goes back to the personal token.
- **Nothing is attributed per person.** GitHub can't show "Komal via the bot" as one identity; per-person attribution would require every teammate to authorise the bot with their own GitHub login, which isn't worth the complexity here.
