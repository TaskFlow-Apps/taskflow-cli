#!/usr/bin/env node
/**
 * @taskflowapp/cli — terminal interface to TaskFlow.
 *
 *     npx @taskflowapp/cli login                     # paste your tfp_ token
 *     npx @taskflowapp/cli new "Fix login bug"        # smart routing
 *     npx @taskflowapp/cli list                      # tasks where I'm involved
 *     npx @taskflowapp/cli list --project TF         # all tasks of TF
 *     npx @taskflowapp/cli show TF-12
 *     npx @taskflowapp/cli move TF-12 in-review
 *     npx @taskflowapp/cli comment TF-12 "à tester"
 *     npx @taskflowapp/cli link-pr TF-12 <url>
 *     npx @taskflowapp/cli search "deploy"
 *
 * Tokens are stored in `~/.config/taskflow/config.json` (XDG-style).
 */
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { input, password, select } from '@inquirer/prompts';
import { TaskFlowClient, TaskFlowError, parseTaskRef } from '@taskflowapp/sdk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(
  process.env.TASKFLOW_CONFIG_DIR ?? join(homedir(), '.config', 'taskflow'),
  'config.json'
);

interface Config {
  apiUrl?: string;
  token?: string;
  defaultProjectKey?: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function getClient(): TaskFlowClient {
  const cfg = loadConfig();
  const apiUrl = process.env.TASKFLOW_API_URL ?? cfg.apiUrl ?? 'http://localhost:3000';
  const token = process.env.TASKFLOW_TOKEN ?? cfg.token;
  if (!token) {
    error('Not logged in. Run `taskflow login` first or set TASKFLOW_TOKEN.');
    process.exit(2);
  }
  return new TaskFlowClient({ apiUrl, token });
}

// ── Output helpers ─────────────────────────────────────────────────────────

const statusColors: Record<string, (s: string) => string> = {
  TODO: chalk.gray,
  IN_PROGRESS: chalk.cyan,
  IN_REVIEW: chalk.magenta,
  DONE: chalk.green,
  BLOCKED: chalk.red,
  CANCELLED: chalk.strikethrough.gray,
};

const priorityColors: Record<string, (s: string) => string> = {
  LOW: chalk.gray,
  MEDIUM: chalk.blue,
  HIGH: chalk.yellow,
  URGENT: chalk.bgRed.white,
};

function error(msg: string) {
  process.stderr.write(chalk.red('✗ ') + msg + '\n');
}

function ok(msg: string) {
  process.stdout.write(chalk.green('✓ ') + msg + '\n');
}

function formatTaskLine(t: any) {
  const ref = chalk.bold(`${t.project.key}-${t.number}`);
  const status = statusColors[t.status]?.(t.status.padEnd(11)) ?? t.status.padEnd(11);
  const prio = priorityColors[t.priority]?.(t.priority.padEnd(7)) ?? t.priority.padEnd(7);
  const due = t.dueDate ? chalk.dim(` (${new Date(t.dueDate).toLocaleDateString('fr-FR')})`) : '';
  return `${ref}  ${status} ${prio}  ${t.title}${due}`;
}

// ── Program ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name('taskflow')
  .description(chalk.bold('TaskFlow') + ' — drive your tasks from the terminal.')
  .version('0.2.0')
  .addOption(new Option('--json', 'Output machine-readable JSON').hideHelp());

// ── login ──────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Store your personal-access token locally')
  .option('--api-url <url>', 'Override the API URL')
  .action(async (opts) => {
    const cfg = loadConfig();
    const apiUrl = opts.apiUrl ?? process.env.TASKFLOW_API_URL ?? cfg.apiUrl ?? 'http://localhost:3000';

    process.stdout.write(chalk.bold('\nTaskFlow CLI\n\n'));
    process.stdout.write(
      `Generate a token at ${chalk.cyan(apiUrl + '/settings/api-tokens')} then paste it below.\n\n`
    );

    const tokenInput = await password({
      message: 'Token (starts with tfp_):',
      mask: '*',
      validate: (v) =>
        v.startsWith('tfp_') && v.length > 12 ? true : 'Token must start with `tfp_`',
    });

    const client = new TaskFlowClient({ apiUrl, token: tokenInput });
    try {
      const me = await client.whoami();
      ok(`Authenticated as ${chalk.bold(me.user.name ?? me.user.email)}`);
    } catch (e: any) {
      error(`Auth failed: ${e.message}`);
      process.exit(1);
    }

    saveConfig({ ...cfg, apiUrl, token: tokenInput });
    ok(`Saved config to ${chalk.dim(CONFIG_PATH)}`);
    ok('You can now run `taskflow list`, `taskflow new …`, etc.');
  });

// ── logout ─────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Forget the locally-stored token')
  .action(() => {
    if (existsSync(CONFIG_PATH)) {
      const cfg = loadConfig();
      delete cfg.token;
      saveConfig(cfg);
      ok('Logged out.');
    } else {
      ok('No config to remove.');
    }
  });

// ── whoami ─────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show the authenticated user')
  .action(async () => {
    const tf = getClient();
    try {
      const me = await tf.whoami();
      const u = me.user;
      const lines = [
        chalk.bold('User'),
        `  id       : ${chalk.dim(u.id)}`,
        `  name     : ${u.name ?? '—'}`,
        `  email    : ${u.email}`,
        `  username : ${u.username ? '@' + u.username : '—'}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── new ────────────────────────────────────────────────────────────────────

program
  .command('new <title...>')
  .alias('create')
  .description('Create a task. Title can be multiple words.')
  .option('-p, --project <keyOrId>', 'Project key (e.g. TF) or id. Default: defaultProjectKey from config.')
  .option('-d, --description <text>', 'Description (Markdown OK).')
  .option('--priority <level>', 'LOW | MEDIUM | HIGH | URGENT')
  .option('--type <type>', 'TASK | BUG | FEATURE | IMPROVEMENT | EPIC | STORY')
  .option('--assign <usernames...>', 'Usernames to assign, space-separated.')
  .option('--open', 'Open the new task in the browser')
  .action(async (titleParts: string[], opts) => {
    const tf = getClient();
    const title = titleParts.join(' ');
    if (!title) return error('Title is required');
    const cfg = loadConfig();
    const projectRef = opts.project ?? cfg.defaultProjectKey;
    if (!projectRef) {
      // Prompt
      const { projects } = await tf.listProjects();
      if (projects.length === 0) return error('No projects available for this user.');
      const chosen = await select({
        message: 'Choose a project',
        choices: projects.map((p) => ({ name: `${p.key} — ${p.name}`, value: p.key })),
      });
      return doCreate(tf, chosen, title, opts);
    }
    return doCreate(tf, projectRef, title, opts);
  });

async function doCreate(
  tf: TaskFlowClient,
  projectRef: string,
  title: string,
  opts: {
    description?: string;
    priority?: string;
    type?: string;
    assign?: string[];
    open?: boolean;
  }
) {
  try {
    const { id: projectId, project } = await tf.resolveProjectKeyAndId(projectRef);
    let assigneeIds: string[] | undefined;
    if (opts.assign?.length) {
      const results = await Promise.all(
        opts.assign.map(async (u) => {
          const r = await tf.search(u, 5);
          return r.users.find((x) => x.username?.toLowerCase() === u.toLowerCase())?.id;
        })
      );
      assigneeIds = results.filter((x): x is string => Boolean(x));
    }
    const { task } = await tf.createTask({
      projectId,
      title,
      description: opts.description,
      priority: opts.priority as any,
      type: opts.type as any,
      assigneeIds,
    });
    const ref = `${task.project.key}-${task.number}`;
    ok(`Created ${chalk.bold(ref)} — ${task.title}`);
    process.stdout.write(`  ${chalk.dim('id')}     ${task.id}\n`);
    process.stdout.write(`  ${chalk.dim('status')} ${task.status}\n`);
    if (opts.open) {
      const apiUrl = (tf as any).apiUrl.replace(/\/api$/, '');
      const url = `${apiUrl}/projects/${task.projectId}/tasks/${task.id}`;
      process.stdout.write(chalk.cyan(`  ${url}\n`));
    }
  } catch (e: any) {
    error(e.message);
    process.exit(1);
  }
}

// ── list ───────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List tasks. Default: tasks assigned to you across all projects.')
  .option('-p, --project <keyOrId>', 'Project key (e.g. TF)')
  .option('--status <status>', 'Filter by status')
  .option('--mine', 'Only projects where I am owner / member (Smart Inbox mode)')
  .option('--smart', 'Show the Smart Inbox (5 grouped sections)')
  .option('-n, --limit <n>', 'Max tasks', '20')
  .action(async (opts) => {
    const tf = getClient();
    try {
      if (opts.smart) {
        const inbox = await tf.smartInbox(opts.mine ? 'mine' : 'all');
        process.stdout.write(
          chalk.bold(
            `Smart Inbox (${inbox.scope === 'mine' ? 'mes projets' : 'tout'}) — ${inbox.counts.total} item(s)\n\n`
          )
        );
        for (const [key, rows] of Object.entries(inbox.groups) as Array<
          [keyof typeof inbox.groups, any[]]
        >) {
          if (!rows.length) continue;
          process.stdout.write(chalk.bold.cyan(`── ${key} (${rows.length}) ──\n`));
          for (const row of rows as any[]) {
            const t = row.task ?? row;
            process.stdout.write('  ' + formatTaskLine(t) + '\n');
          }
          process.stdout.write('\n');
        }
        return;
      }

      let tasks: any[];
      if (opts.project) {
        const { id: projectId } = await tf.resolveProjectKeyAndId(opts.project);
        const r = await tf.listTasks(projectId, {
          status: opts.status as any,
          limit: Number(opts.limit),
        });
        tasks = r.tasks;
      } else {
        const r = await tf.listMyAssignedTasks({
          status: opts.status as any,
          limit: Number(opts.limit),
        });
        tasks = r.tasks;
      }
      if (!tasks.length) {
        process.stdout.write(chalk.dim('Aucun résultat.\n'));
        return;
      }
      for (const t of tasks) process.stdout.write(formatTaskLine(t) + '\n');
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── show ───────────────────────────────────────────────────────────────────

program
  .command('show <ref>')
  .description('Show a task by id or short reference (TF-12)')
  .action(async (ref: string) => {
    const tf = getClient();
    try {
      const parsed = parseTaskRef(ref);
      const { task } = parsed
        ? await tf.resolveTaskRef(ref)
        : await tf.getTask(ref);
      printTaskDetail(task);
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

function printTaskDetail(t: any) {
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold(`${t.project.key}-${t.number}`) + '  ' + t.title);
  lines.push(chalk.dim('─'.repeat(Math.min(70, (t.title?.length ?? 0) + 16))));
  lines.push(`  status     : ${statusColors[t.status]?.(t.status) ?? t.status}`);
  lines.push(`  priority   : ${priorityColors[t.priority]?.(t.priority) ?? t.priority}`);
  if (t.type) lines.push(`  type       : ${t.type}`);
  if (t.storyPoints != null) lines.push(`  points     : ${t.storyPoints}`);
  if (t.estimateMinutes != null)
    lines.push(`  estimate   : ${Math.round(t.estimateMinutes / 6) / 10} h`);
  if (t.dueDate) lines.push(`  due        : ${new Date(t.dueDate).toLocaleDateString('fr-FR')}`);
  if (t.completedAt)
    lines.push(`  completed  : ${new Date(t.completedAt).toLocaleString('fr-FR')}`);
  lines.push(`  created    : ${new Date(t.createdAt).toLocaleString('fr-FR')}`);
  if (t.assignees?.length) {
    lines.push(
      `  assignees  : ${t.assignees
        .map((a: any) => a.user.username ? '@' + a.user.username : a.user.email)
        .join(', ')}`
    );
  }
  if (t.githubPrUrl) lines.push(`  PR         : ${chalk.cyan(t.githubPrUrl)}`);
  if (t.githubIssueUrl) lines.push(`  issue      : ${chalk.cyan(t.githubIssueUrl)}`);
  if (t.description) {
    lines.push('');
    lines.push(chalk.dim('Description'));
    lines.push('  ' + t.description.replace(/\n/g, '\n  '));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Resolve `ref` (either `TF-12` or a raw task id) to the task + its id,
 * hiding the difference between the two resolve paths so callers get a
 * uniform `{ taskId, task }` shape.
 */
async function resolveAnyTask(
  tf: TaskFlowClient,
  ref: string
): Promise<{ taskId: string; task: any }> {
  if (parseTaskRef(ref)) {
    const r = await tf.resolveTaskRef(ref);
    return { taskId: r.taskId, task: r.task };
  }
  const r = await tf.getTask(ref);
  return { taskId: r.task.id, task: r.task };
}

// ── move ───────────────────────────────────────────────────────────────────

program
  .command('move <ref> <status>')
  .description('Move a task to a new status')
  .addHelpText('after', 'Statuses: TODO IN_PROGRESS IN_REVIEW DONE BLOCKED CANCELLED')
  .action(async (ref: string, status: string) => {
    const tf = getClient();
    status = status.toUpperCase().replace('-', '_');
    if (!['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED'].includes(status)) {
      error(`Unknown status: ${status}`);
      process.exit(2);
    }
    try {
      const { task } = await resolveAnyTask(tf, ref);
      const before = task.status;
      const { task: updated } = await tf.moveTask(task.id, status as any);
      const color = statusColors[updated.status] ?? ((s: string) => s);
      ok(
        `${task.project.key}-${updated.number}: ${chalk.dim(before)} → ${color(updated.status)}`
      );
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── comment ────────────────────────────────────────────────────────────────

program
  .command('comment <ref> <content...>')
  .alias('c')
  .description('Post a comment on a task. @mentions work.')
  .action(async (ref: string, contentParts: string[]) => {
    const tf = getClient();
    const content = contentParts.join(' ');
    if (!content) return error('Comment content is required');
    try {
      const { taskId } = await resolveAnyTask(tf, ref);
      const { comment } = await tf.addComment(taskId, content);
      ok(`Comment posted · ${chalk.dim(comment.id.slice(0, 8))}`);
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── link-pr ────────────────────────────────────────────────────────────────

program
  .command('link-pr <ref> <prUrl>')
  .description('Attach a GitHub PR to a task')
  .action(async (ref: string, prUrl: string) => {
    const tf = getClient();
    if (!/^https?:\/\/(www\.)?github\.com\//.test(prUrl)) {
      error('PR URL must be on github.com');
      process.exit(2);
    }
    try {
      const { taskId, task } = await resolveAnyTask(tf, ref);
      await tf.linkPr(taskId, prUrl);
      ok(`Linked ${chalk.bold(`${task.project.key}-${task.number}`)} ↔ ${prUrl}`);
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── search ─────────────────────────────────────────────────────────────────

program
  .command('search <query...>')
  .description('Full-text search across projects, tasks, users')
  .option('-n, --limit <n>', 'Max per category', '5')
  .action(async (q: string[], opts) => {
    const tf = getClient();
    try {
      const r = await tf.search(q.join(' '), Number(opts.limit));
      if (r.projects.length) {
        process.stdout.write(chalk.bold('Projects\n'));
        for (const p of r.projects) process.stdout.write(`  ${chalk.bold(p.key)}  ${p.name}\n`);
      }
      if (r.tasks.length) {
        process.stdout.write('\n' + chalk.bold('Tasks\n'));
        for (const t of r.tasks) process.stdout.write('  ' + formatTaskLine(t) + '\n');
      }
      if (r.users.length) {
        process.stdout.write('\n' + chalk.bold('Users\n'));
        for (const u of r.users)
          process.stdout.write(`  ${u.username ? '@' + u.username : u.email}  ${u.name ?? ''}\n`);
      }
      if (!r.projects.length && !r.tasks.length && !r.users.length) {
        process.stdout.write(chalk.dim('Aucun résultat.\n'));
      }
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── inbox (smart inbox) ─────────────────────────────────────────────────────

program
  .command('inbox')
  .description('Show the Smart Inbox (5 grouped sections: review, mentions, active, recent, stale)')
  .option('--mine', 'Restrict to projects where I am owner / member')
  .action(async (opts) => {
    const tf = getClient();
    try {
      const inbox = await tf.smartInbox(opts.mine ? 'mine' : 'all');
      process.stdout.write(
        chalk.bold(
          `Smart Inbox (${inbox.scope === 'mine' ? 'mes projets' : 'tous les projets visibles'}) — ${inbox.counts.total} item(s)\n\n`
        )
      );
      const sections: Array<[string, Array<unknown>]> = [
        ['Awaiting review (assignée à moi, IN_REVIEW)', inbox.groups.awaitingReview],
        ['Mentioned (@username, non lu)', inbox.groups.mentioned],
        ['Active (assignée à moi, non terminée)', inbox.groups.assignedActive],
        ['Recently done (7 derniers jours)', inbox.groups.recentlyDone],
        ['Stale (14j+ sans activité)', inbox.groups.stale],
      ];
      for (const [title, rows] of sections) {
        if (!rows.length) continue;
        process.stdout.write(chalk.bold.cyan(`── ${title} (${rows.length}) ──\n`));
        for (const row of rows as any[]) {
          const t = row.task ?? row;
          process.stdout.write('  ' + formatTaskLine(t) + '\n');
        }
        process.stdout.write('\n');
      }
      if (inbox.counts.total === 0) {
        process.stdout.write(chalk.dim('Rien à signaler. Belle journée.\n'));
      }
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── recurrence ──────────────────────────────────────────────────────────────

program
  .command('recur <ref>')
  .description('Set a recurrence rule on a task (DAILY | WEEKLY | MONTHLY)')
  .option('--frequency <freq>', 'DAILY | WEEKLY | MONTHLY', 'WEEKLY')
  .option(
    '--by-day <days...>',
    'For WEEKLY: 0..6 (Sun..Sat). For MONTHLY: day-of-month (1..31).'
  )
  .option('--hour <h>', 'UTC hour-of-day (0..23). Default 9.', '9')
  .option('--ends-at <iso>', 'ISO datetime — stop spawning after this.')
  .option('--clear', 'Remove any existing recurrence rule on the task.')
  .action(async (ref: string, opts) => {
    const tf = getClient();
    try {
      const { taskId } = await resolveAnyTask(tf, ref);
      if (opts.clear) {
        await tf.removeRecurrence(taskId);
        ok(`Recurrence removed on ${ref}`);
        return;
      }
      const freq = String(opts.frequency).toUpperCase();
      if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
        error(`Unknown frequency: ${freq}`);
        process.exit(2);
      }
      const byDay = opts.byDay ? opts.byDay.map((d: string) => Number(d)).filter((n: number) => !Number.isNaN(n)) : undefined;
      const rule = await tf.setRecurrence(taskId, {
        frequency: freq as any,
        byDay,
        hourOfDay: Number(opts.hour),
        endsAt: opts.endsAt ?? null,
      });
      ok(`Recurrence set on ${ref} — ${freq} (next: ${rule.rule.nextSpawnAt})`);
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── dependencies ────────────────────────────────────────────────────────────

program
  .command('deps <ref> <action> <otherRef>')
  .description('Manage blockers: deps TF-12 add TF-10 | deps TF-12 remove TF-10')
  .action(async (ref: string, action: string, otherRef: string) => {
    const tf = getClient();
    const act = action.toLowerCase();
    if (act !== 'add' && act !== 'remove') {
      error(`Unknown action "${action}" — expected: add | remove`);
      process.exit(2);
    }
    try {
      const { taskId } = await resolveAnyTask(tf, ref);
      const { taskId: otherId } = await resolveAnyTask(tf, otherRef);
      if (act === 'add') {
        await tf.addDependency(taskId, otherId);
        ok(`${ref} is now blocked by ${otherRef}`);
      } else {
        await tf.removeDependency(taskId, otherId);
        ok(`Removed blocker ${otherRef} from ${ref}`);
      }
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── time tracking ───────────────────────────────────────────────────────────

/**
 * Parse "30m", "1h", "2h30m", "90" (treated as minutes) → minutes.
 */
function parseDurationToMinutes(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let matched = false;
  const re = /(\d+)(h|m)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    if (m[2] === 'h') total += n * 60;
    else total += n;
  }
  return matched ? total : null;
}

program
  .command('log-time <ref> <duration>')
  .alias('time')
  .description('Log time on a task. Duration: 30m, 1h, 2h30m, 90 (minutes).')
  .option('-m, --message <text>', 'What did you do?')
  .option('--at <iso>', 'When the work happened (ISO). Default: now.')
  .action(async (ref: string, duration: string, opts) => {
    const tf = getClient();
    const minutes = parseDurationToMinutes(duration);
    if (!minutes || minutes <= 0) {
      error(`Could not parse duration "${duration}" — try 30m, 1h, 2h30m, 90`);
      process.exit(2);
    }
    try {
      const { taskId, task } = await resolveAnyTask(tf, ref);
      const { entry } = await tf.logTime(taskId, {
        minutes,
        description: opts.message,
        startedAt: opts.at,
      });
      ok(
        `Logged ${chalk.bold(`${minutes}m`)} on ${chalk.bold(`${task.project.key}-${task.number}`)} ${chalk.dim('·')} ${chalk.dim(entry.id.slice(0, 8))}`
      );
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── share ───────────────────────────────────────────────────────────────────

program
  .command('share <ref>')
  .description('Create a public share link for a task (30 days, view-only).')
  .action(async (ref: string) => {
    const tf = getClient();
    try {
      const { taskId, task } = await resolveAnyTask(tf, ref);
      const s = await tf.shareTask(taskId);
      ok(`Share link for ${chalk.bold(`${task.project.key}-${task.number}`)} (expires in ${s.expiresInDays}d):`);
      process.stdout.write('  ' + chalk.cyan(s.url) + '\n');
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── bulk ────────────────────────────────────────────────────────────────────

program
  .command('bulk <action> <refs...>')
  .description('Bulk action on multiple tasks. action: setStatus | setPriority | delete')
  .option('--status <s>', 'For setStatus: TODO | IN_PROGRESS | IN_REVIEW | DONE | BLOCKED | CANCELLED')
  .option('--priority <p>', 'For setPriority: LOW | MEDIUM | HIGH | URGENT')
  .action(async (action: string, refs: string[], opts) => {
    const tf = getClient();
    const act = action;
    if (!['setStatus', 'setPriority', 'delete'].includes(act)) {
      error(`Unknown action "${act}" — expected: setStatus | setPriority | delete`);
      process.exit(2);
    }
    if (refs.length === 0) {
      error('Provide at least one task reference');
      process.exit(2);
    }
    try {
      const ids: string[] = [];
      for (const r of refs) {
        const { taskId } = await resolveAnyTask(tf, r);
        ids.push(taskId);
      }
      const payload: Record<string, string> = {};
      if (opts.status) payload.status = opts.status.toUpperCase().replace('-', '_');
      if (opts.priority) payload.priority = opts.priority.toUpperCase();
      const r = await tf.bulkUpdate({ taskIds: ids, action: act as any, payload });
      ok(
        `${act}: ${chalk.bold(`${r.processed} ok`)}${r.failed ? `, ${chalk.red(`${r.failed} failed`)}` : ''}`
      );
      for (const f of r.failures) {
        process.stdout.write(`  ${chalk.red('✗')} ${f.id}: ${f.error}\n`);
      }
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

// ── notifications ───────────────────────────────────────────────────────────

program
  .command('notifications')
  .alias('notif')
  .description('List your recent notifications')
  .option('--read-all', 'Mark every unread notification as read')
  .action(async (opts) => {
    const tf = getClient();
    try {
      if (opts.readAll) {
        await tf.markAllNotificationsRead();
        ok('All notifications marked read');
        return;
      }
      const r = await tf.listNotifications();
      if (!r.notifications.length) {
        process.stdout.write(chalk.dim('Aucune notification.\n'));
        return;
      }
      process.stdout.write(
        chalk.bold(`${r.unreadCount} unread / ${r.notifications.length} total\n\n`)
      );
      for (const n of r.notifications.slice(0, 25)) {
        const dot = n.readAt ? chalk.dim('○') : chalk.cyan('●');
        const age = chalk.dim(relativeTime(n.createdAt));
        process.stdout.write(`  ${dot} ${n.title}  ${age}\n`);
        if (n.body) process.stdout.write(`      ${chalk.dim(n.body)}\n`);
      }
    } catch (e: any) {
      error(e.message);
      process.exit(1);
    }
  });

/** Tiny relative-time formatter — no deps, no locale, good enough for CLI. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// ── Run ────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((e) => {
  if (e instanceof TaskFlowError) {
    error(`TaskFlow ${e.status}: ${e.message}`);
  } else {
    error(e?.message ?? String(e));
  }
  process.exit(1);
});
