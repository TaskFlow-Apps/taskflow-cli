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
  .version('0.1.0')
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

// ── Run ────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((e) => {
  if (e instanceof TaskFlowError) {
    error(`TaskFlow ${e.status}: ${e.message}`);
  } else {
    error(e?.message ?? String(e));
  }
  process.exit(1);
});
