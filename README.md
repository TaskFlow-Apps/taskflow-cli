# @trovyhq/cli

Terminal interface for Trovy. Drive your tasks from anywhere — local scripts, CI, Git hooks, the editor terminal.

## Install

```bash
# No install — just use npx
npx @trovyhq/cli login
npx @trovyhq/cli new "Investigate webhook timeout"
```

If you prefer a real binary:

```bash
pnpm global add @trovyhq/cli
trovy login
```

## Setup

Generate a personal-access token at `https://<your-trovy-host>/settings/api-tokens`.

Then:

```bash
npx @trovyhq/cli login
# Enter your API URL (default http://localhost:3000) and paste the tfp_… token.
```

Config lives at `~/.config/trovy/config.json` (XDG-style), mode `0600`.

You can also set env vars instead:

```bash
export TROVY_API_URL=https://trovy.app
export TROVY_TOKEN=tfp_xxxxxxxxxxxx
```

## Commands

```text
trovy login        Store the API token
trovy logout       Forget the stored token
trovy whoami       Show the authenticated user

trovy new "title"  Create a task
  -p, --project <k>       Project key (e.g. TF). Default = config.defaultProjectKey
  -d, --description <t>   Markdown description
      --priority <level>   LOW | MEDIUM | HIGH | URGENT
      --type <type>        TASK | BUG | FEATURE | IMPROVEMENT | EPIC | STORY
      --assign <usernames> Space-separated usernames
      --open               Print the URL after creation

trovy list         Tasks assigned to me (or all in a project with -p)
      --project <k>        Filter by project key/id
      --status <status>    Filter by status
      --mine               Smart Inbox mode "Mes projets"
      --smart              Show 5 grouped sections (awaiting review, mentions, …)
  -n, --limit <n>          Max results (default 20)

trovy show TF-12   Show task detail (id or TF-12 reference)

trovy move TF-12 in-review      Move a task to a new status
  Statuses: TODO IN_PROGRESS IN_REVIEW DONE BLOCKED CANCELLED

trovy comment TF-12 "à tester" Post a comment (supports @mentions)

trovy link-pr TF-12 https://github.com/owner/repo/pull/123

trovy search "deploy"  Full-text search across projects/tasks/users
```

Everything short-references tasks as `TF-12` — the project key + task number. If you only have a task id, paste it; both forms work.

## Examples

```bash
# Start your day
trovy list --smart

# Create + comment in one go from CI:
trovy new "Deploy $TAG" -p WEB -d "Auto from CI" --priority URGENT
trovy comment "WEB-42" "Smoke OK ✅"

# Move stuff along from a Git hook:
trovy move "WEB-$(git rev-parse --short HEAD)" in-review
```

## License

MIT
