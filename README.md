# @taskflowapp/cli

Terminal interface for TaskFlow. Drive your tasks from anywhere — local scripts, CI, Git hooks, the editor terminal.

## Install

```bash
# No install — just use npx
npx @taskflowapp/cli login
npx @taskflowapp/cli new "Investigate webhook timeout"
```

If you prefer a real binary:

```bash
pnpm global add @taskflowapp/cli
taskflow login
```

## Setup

Generate a personal-access token at `https://<your-taskflow-host>/settings/api-tokens`.

Then:

```bash
npx @taskflowapp/cli login
# Enter your API URL (default http://localhost:3000) and paste the tfp_… token.
```

Config lives at `~/.config/taskflow/config.json` (XDG-style), mode `0600`.

You can also set env vars instead:

```bash
export TASKFLOW_API_URL=https://api.taskflow.app
export TASKFLOW_TOKEN=tfp_xxxxxxxxxxxx
```

## Commands

```text
taskflow login        Store the API token
taskflow logout       Forget the stored token
taskflow whoami       Show the authenticated user

taskflow new "title"  Create a task
  -p, --project <k>       Project key (e.g. TF). Default = config.defaultProjectKey
  -d, --description <t>   Markdown description
      --priority <level>   LOW | MEDIUM | HIGH | URGENT
      --type <type>        TASK | BUG | FEATURE | IMPROVEMENT | EPIC | STORY
      --assign <usernames> Space-separated usernames
      --open               Print the URL after creation

taskflow list         Tasks assigned to me (or all in a project with -p)
      --project <k>        Filter by project key/id
      --status <status>    Filter by status
      --mine               Smart Inbox mode "Mes projets"
      --smart              Show 5 grouped sections (awaiting review, mentions, …)
  -n, --limit <n>          Max results (default 20)

taskflow show TF-12   Show task detail (id or TF-12 reference)

taskflow move TF-12 in-review      Move a task to a new status
  Statuses: TODO IN_PROGRESS IN_REVIEW DONE BLOCKED CANCELLED

taskflow comment TF-12 "à tester" Post a comment (supports @mentions)

taskflow link-pr TF-12 https://github.com/owner/repo/pull/123

taskflow search "deploy"  Full-text search across projects/tasks/users
```

Everything short-references tasks as `TF-12` — the project key + task number. If you only have a task id, paste it; both forms work.

## Examples

```bash
# Start your day
taskflow list --smart

# Create + comment in one go from CI:
taskflow new "Deploy $TAG" -p WEB -d "Auto from CI" --priority URGENT
taskflow comment "WEB-42" "Smoke OK ✅"

# Move stuff along from a Git hook:
taskflow move "WEB-$(git rev-parse --short HEAD)" in-review
```

## License

MIT
