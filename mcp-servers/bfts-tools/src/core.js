import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATE_DIR = '.ai-scientist/runs';
const WORKTREE_DIR = '.ai-scientist/worktrees';

function git(projectPath, args) {
  return execFileSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function projectRoot(projectPath) {
  const requested = resolve(projectPath);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`Project path does not exist or is not a directory: ${requested}`);
  }
  const target = realpathSync(requested);
  try {
    return realpathSync(git(target, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error(`Project is not a git repository: ${target}`);
  }
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function runDirectory(root, runId) {
  return join(root, STATE_DIR, safeId(runId));
}

function statePath(root, runId) {
  return join(runDirectory(root, runId), 'state.json');
}

function reportDirectory(root, runId) {
  return join(root, 'report', safeId(runId));
}

function loadState(root, runId) {
  const path = statePath(root, runId);
  if (!existsSync(path)) {
    throw new Error(`Run not found: ${runId}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveState(root, state) {
  const directory = runDirectory(root, state.runId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'state.json');
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function detectBenchmarkCommand(root) {
  const packagePath = join(root, 'package.json');
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    for (const name of ['test', 'benchmark']) {
      if (packageJson.scripts?.[name]) {
        return name === 'test' ? 'npm test' : `npm run ${name}`;
      }
    }
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini'))) {
    return 'pytest';
  }
  if (existsSync(join(root, 'go.mod'))) {
    return 'go test ./...';
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    return 'cargo test';
  }
  if (existsSync(join(root, 'Makefile'))) {
    return 'make test';
  }
  return null;
}

function ensureLocalExcludes(root, runId) {
  const gitDirectory = resolve(root, git(root, ['rev-parse', '--git-dir']));
  const excludePath = join(gitDirectory, 'info', 'exclude');
  mkdirSync(join(gitDirectory, 'info'), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const entries = ['/.ai-scientist/', `/report/${safeId(runId)}/`];
  const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length > 0) {
    appendFileSync(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${missing.join('\n')}\n`);
  }
}

function readinessChecks(scan, issue, benchmarkCommand, runId) {
  return [
    { name: 'Git repository', ready: true, detail: scan.projectPath },
    {
      name: 'Clean baseline',
      ready: scan.cleanWorkingTree,
      detail: scan.cleanWorkingTree ? 'working tree is clean' : 'commit or stash changes before candidate worktrees are created',
    },
    {
      name: 'Benchmark command',
      ready: Boolean(benchmarkCommand),
      detail: benchmarkCommand || 'supply benchmarkCommand before execution',
    },
    { name: 'Report output', ready: true, detail: join(scan.projectPath, 'report', runId) },
    { name: 'Research issue', ready: Boolean(issue.trim()), detail: issue.trim() },
  ];
}

function validateWorktree(path, branchRef) {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing symlink at candidate worktree path: ${path}`);
  }
  let actualRoot;
  let actualBranch;
  try {
    actualRoot = git(path, ['rev-parse', '--show-toplevel']);
    actualBranch = git(path, ['branch', '--show-current']);
  } catch {
    throw new Error(`Existing candidate path is not a valid git worktree: ${path}`);
  }
  if (resolve(actualRoot) !== resolve(path) || actualBranch !== branchRef) {
    throw new Error(`Existing candidate path does not match expected branch ${branchRef}: ${path}`);
  }
}

function assertSafeWorktreePath(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || resolve(root, relativePath) !== resolve(path)) {
    throw new Error(`Candidate worktree path escapes the project: ${path}`);
  }
  let current = root;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symlink in candidate worktree path: ${current}`);
    }
  }
}

function countMarkers(root, limit = 500) {
  const ignored = new Set(['.git', 'node_modules', '.ai-scientist', 'report', 'experiments']);
  let count = 0;
  let filesVisited = 0;

  function visit(directory) {
    if (filesVisited >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name) || filesVisited >= limit) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && statSync(path).size <= 256_000) {
        filesVisited += 1;
        try {
          const text = readFileSync(path, 'utf8');
          count += (text.match(/\b(?:TODO|FIXME)\b/g) || []).length;
        } catch {
          // Binary or unreadable files are not research signals.
        }
      }
    }
  }

  visit(root);
  return { count, filesVisited };
}

function writePlan(root, state) {
  const directory = reportDirectory(root, state.runId);
  mkdirSync(directory, { recursive: true });
  const checks = state.readiness.checks
    .map((check) => `- [${check.ready ? 'x' : ' '}] ${check.name}: ${check.detail}`)
    .join('\n');
  const plan = `# Research Plan: ${state.issue}\n\n`
    + `- **Run ID:** \`${state.runId}\`\n`
    + `- **Project:** \`${state.projectPath}\`\n`
    + `- **Base commit:** \`${state.baseCommit}\`\n`
    + `- **Benchmark:** ${state.benchmarkCommand ? `\`${state.benchmarkCommand}\`` : 'not configured'}\n\n`
    + `## Readiness\n\n${checks}\n\n`
    + `## Procedure\n\n`
    + `1. Research the issue in the project and externally when useful.\n`
    + `2. Propose ${state.config.numDrafts} distinct candidate approaches with explicit tradeoffs.\n`
    + `3. Explore candidates using best-first selection with at most ${state.config.numWorkers} workers and ${state.config.maxSteps} total steps.\n`
    + `4. Implement candidates only in isolated git worktrees.\n`
    + `5. Run the same benchmark command for each candidate and persist measured output.\n`
    + `6. Write a final report comparing evidence, risks, and tradeoffs.\n\n`
    + `## Stop Conditions\n\n`
    + `Stop when the step budget is exhausted, no pending node remains, or evidence clearly favors one approach.\n`;
  writeFileSync(join(directory, 'plan.md'), plan);
}

export async function scanProject({ projectPath, focus }) {
  const root = projectRoot(projectPath);
  const markers = countMarkers(root);
  const status = git(root, ['status', '--porcelain']);
  return {
    projectPath: root,
    projectName: basename(root),
    focus: focus || null,
    branch: git(root, ['branch', '--show-current']),
    baseCommit: git(root, ['rev-parse', 'HEAD']),
    cleanWorkingTree: status.length === 0,
    benchmarkCommand: detectBenchmarkCommand(root),
    todoFixmeCount: markers.count,
    filesScanned: markers.filesVisited,
  };
}

export async function planRun(input) {
  const scan = await scanProject(input);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const benchmarkCommand = input.benchmarkCommand || scan.benchmarkCommand;
  const checks = readinessChecks(scan, input.issue, benchmarkCommand, runId);
  const state = {
    runId,
    issue: input.issue.trim(),
    projectPath: scan.projectPath,
    baseCommit: scan.baseCommit,
    benchmarkCommand,
    createdAt: new Date().toISOString(),
    status: checks.every((check) => check.ready) ? 'planned' : 'blocked',
    readiness: { ready: checks.every((check) => check.ready), checks },
    config: {
      numWorkers: input.numWorkers,
      maxSteps: input.maxSteps,
      maxDebugAttempts: input.maxDebugAttempts,
      numDrafts: input.numDrafts,
    },
    stepsUsed: 0,
    nodes: [],
  };
  ensureLocalExcludes(scan.projectPath, runId);
  saveState(scan.projectPath, state);
  writePlan(scan.projectPath, state);
  return state;
}

export async function recheckRun({ projectPath, runId, benchmarkCommand }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  const scan = await scanProject({ projectPath: root, focus: state.issue });
  state.benchmarkCommand = benchmarkCommand || state.benchmarkCommand || scan.benchmarkCommand;
  const checks = readinessChecks(scan, state.issue, state.benchmarkCommand, runId);
  state.readiness = { ready: checks.every((check) => check.ready), checks };
  state.status = state.readiness.ready ? 'planned' : 'blocked';
  if (state.readiness.ready && scan.baseCommit !== state.baseCommit) {
    if (state.nodes.length > 0) {
      throw new Error('Repository HEAD changed after search began; create a new run to preserve a consistent baseline.');
    }
    state.baseCommit = scan.baseCommit;
  }
  saveState(root, state);
  writePlan(root, state);
  return state;
}

export async function proposeCandidates({ projectPath, runId, parentNodeId, candidates }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  if (!state.readiness.ready) {
    throw new Error('Run is blocked by readiness checks; resolve them before proposing candidates.');
  }
  if (state.nodes.length > 0 && !parentNodeId) {
    throw new Error('Root candidates have already been registered for this run.');
  }
  const parent = parentNodeId
    ? state.nodes.find((node) => node.nodeId === parentNodeId)
    : null;
  if (parentNodeId && !parent) {
    throw new Error(`Parent node not found: ${parentNodeId}`);
  }
  if (parent && (parent.status !== 'done' || !parent.branchRef)) {
    throw new Error(`Parent node must be completed and committed before expansion: ${parentNodeId}`);
  }
  const offset = state.nodes.length;
  const added = candidates.map((candidate, index) => ({
    nodeId: `${String(offset + index + 1).padStart(2, '0')}-${safeId(candidate.title) || 'candidate'}`,
    parentId: parentNodeId || null,
    title: candidate.title,
    description: candidate.description,
    rationale: candidate.rationale || '',
    status: 'pending',
    score: candidate.initialScore ?? 0,
    debugAttempts: 0,
    branchRef: null,
    worktreePath: null,
    benchmark: null,
    notes: '',
  }));
  state.nodes.push(...added);
  state.status = 'searching';
  saveState(root, state);
  return { runId, nodes: added };
}

export async function selectNextNodes({ projectPath, runId, numWorkers }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  const remaining = state.config.maxSteps - state.stepsUsed;
  if (remaining <= 0) {
    state.status = 'exhausted';
    saveState(root, state);
    return { runId, nodes: [], reason: 'maxSteps exhausted' };
  }
  const running = state.nodes.filter((node) => node.status === 'running').length;
  const requestedWorkers = Math.min(numWorkers || state.config.numWorkers, state.config.numWorkers);
  const capacity = Math.max(0, requestedWorkers - running);
  if (capacity === 0) {
    return { runId, nodes: [], reason: 'all worker slots are busy' };
  }
  const count = Math.min(capacity, remaining);
  const selected = state.nodes
    .filter((node) => node.status === 'pending')
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
    .slice(0, count);
  for (const node of selected) {
    node.status = 'running';
  }
  state.stepsUsed += selected.length;
  if (selected.length === 0 && running === 0) state.status = 'exhausted';
  saveState(root, state);
  return { runId, nodes: selected, stepsUsed: state.stepsUsed, maxSteps: state.config.maxSteps };
}

export async function applyCandidate({ projectPath, runId, nodeId }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.status !== 'running') throw new Error(`Node must be running before applying: ${nodeId}`);
  if (!state.readiness.ready) throw new Error('Run readiness checks are not satisfied.');

  const parent = node.parentId
    ? state.nodes.find((candidate) => candidate.nodeId === node.parentId)
    : null;
  if (parent && (parent.status !== 'done' || !parent.branchRef)) {
    throw new Error(`Parent node is not ready for refinement: ${node.parentId}`);
  }
  const startPoint = parent?.branchRef || state.baseCommit;
  const branchRef = `ai-scientist/${safeId(runId)}/${safeId(nodeId)}`;
  const worktreePath = join(root, WORKTREE_DIR, safeId(runId), safeId(nodeId));
  assertSafeWorktreePath(root, worktreePath);
  mkdirSync(join(root, WORKTREE_DIR, safeId(runId)), { recursive: true });
  if (existsSync(worktreePath)) {
    validateWorktree(worktreePath, branchRef);
  } else {
    const branchExists = git(root, ['branch', '--list', branchRef]).length > 0;
    const created = spawnSync(
      'git',
      branchExists
        ? ['-C', root, 'worktree', 'add', worktreePath, branchRef]
        : ['-C', root, 'worktree', 'add', '-b', branchRef, worktreePath, startPoint],
      { encoding: 'utf8' },
    );
    if (created.status !== 0) {
      throw new Error(created.stderr.trim() || 'Failed to create candidate worktree.');
    }
  }
  node.branchRef = branchRef;
  node.worktreePath = worktreePath;
  saveState(root, state);
  return { runId, nodeId, branchRef, worktreePath };
}

export async function runBenchmark({ projectPath, runId, nodeId, command, timeoutSeconds }) {
  const root = projectRoot(projectPath);
  const initialState = loadState(root, runId);
  const node = initialState.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node?.worktreePath) throw new Error(`Candidate worktree is not initialized: ${nodeId}`);
  const benchmarkCommand = command || initialState.benchmarkCommand;
  if (!benchmarkCommand) throw new Error('No benchmark command configured.');

  const started = performance.now();
  const execution = await new Promise((resolveExecution) => {
    const child = spawn('/bin/sh', ['-lc', benchmarkCommand], {
      cwd: node.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKill;
    let finalTimeout;
    const append = (current, chunk) => `${current}${chunk}`.slice(-50_000);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveExecution(value);
    };
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        if (!child.killed) child.kill(signal);
      }
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      forceKill = setTimeout(() => killGroup('SIGKILL'), 2_000);
      finalTimeout = setTimeout(() => finish({
        status: null,
        stdout,
        stderr: append(stderr, '\nBenchmark did not exit after timeout termination.'),
        timedOut,
        error: null,
      }), 3_000);
      forceKill.unref();
      finalTimeout.unref();
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(finalTimeout);
      finish({ status: null, stdout, stderr, timedOut, error });
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(finalTimeout);
      finish({ status, stdout, stderr, timedOut, error: null });
    });
  });
  const durationMs = Math.round(performance.now() - started);
  const success = execution.status === 0 && !execution.error && !execution.timedOut;
  const benchmark = {
    command: benchmarkCommand,
    success,
    exitCode: execution.status,
    durationMs,
    stdout: execution.stdout,
    stderr: execution.stderr,
    timedOut: execution.timedOut,
    measuredAt: new Date().toISOString(),
  };
  const state = loadState(root, runId);
  const currentNode = state.nodes.find((candidate) => candidate.nodeId === nodeId);
  currentNode.benchmark = benchmark;
  currentNode.score = success ? 100 - Math.log10(durationMs + 1) : -100;
  saveState(root, state);
  return { runId, nodeId, score: currentNode.score, benchmark };
}

export async function recordResult({ projectPath, runId, nodeId, status, score, notes, debugAttempted }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (status === 'done') {
    if (node.status !== 'running' || !node.worktreePath || !node.benchmark?.success) {
      throw new Error('A node can be completed only after its applied worktree passes the benchmark.');
    }
  } else if (status === 'pending') {
    if (node.status !== 'running' || !debugAttempted) {
      throw new Error('Only a running node with a recorded debug attempt can return to pending.');
    }
  } else if (!['pending', 'running'].includes(node.status)) {
    throw new Error(`Cannot abandon node from status ${node.status}.`);
  }
  if (status === 'done' && node.worktreePath) {
    const changes = git(node.worktreePath, ['status', '--porcelain']);
    if (changes) {
      git(node.worktreePath, ['add', '-A']);
      execFileSync(
        'git',
        [
          '-C', node.worktreePath,
          '-c', 'user.name=AI Scientist',
          '-c', 'user.email=ai-scientist@localhost',
          'commit', '-m', `AI Scientist candidate: ${node.title}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }
  }
  if (debugAttempted) {
    node.debugAttempts += 1;
    if (node.debugAttempts > state.config.maxDebugAttempts) {
      node.status = 'abandoned';
      node.notes = `${notes || ''}\nAbandoned after exceeding maxDebugAttempts.`.trim();
      saveState(root, state);
      return { runId, node };
    }
  }
  node.status = status;
  if (score !== undefined) node.score = score;
  if (notes !== undefined) node.notes = notes;
  if (state.nodes.every((candidate) => ['done', 'abandoned'].includes(candidate.status))) {
    state.status = 'complete';
  } else if (
    state.stepsUsed >= state.config.maxSteps
    && state.nodes.every((candidate) => candidate.status !== 'running')
  ) {
    state.status = 'exhausted';
  }
  saveState(root, state);
  return { runId, node };
}

export async function getRun({ projectPath, runId }) {
  return loadState(projectRoot(projectPath), runId);
}

export async function writeReport({ projectPath, runId, recommendation, conclusion }) {
  const root = projectRoot(projectPath);
  const state = loadState(root, runId);
  const running = state.nodes.filter((node) => node.status === 'running');
  const pending = state.nodes.filter((node) => node.status === 'pending');
  const budgetRemaining = state.stepsUsed < state.config.maxSteps;
  const measured = state.nodes.filter((node) => node.benchmark);
  if (state.nodes.length === 0 || measured.length === 0) {
    throw new Error('Run has no measured candidate evidence to report.');
  }
  if (running.length > 0 || (pending.length > 0 && budgetRemaining)) {
    throw new Error('Run still has active or selectable nodes; finish or exhaust the search before writing the report.');
  }
  const directory = reportDirectory(root, runId);
  mkdirSync(directory, { recursive: true });
  const rows = state.nodes.map((node) => {
    const measured = node.benchmark
      ? `${node.benchmark.success ? 'pass' : 'fail'} (${node.benchmark.durationMs} ms)`
      : 'not executed';
    return `| ${node.title} | ${node.status} | ${measured} | ${node.score.toFixed(2)} | ${node.notes || '—'} |`;
  }).join('\n');
  const completed = state.nodes.filter((node) => node.benchmark);
  const passing = completed.filter((node) => node.benchmark.success);
  const best = passing.sort((a, b) => b.score - a.score)[0];
  const finalRecommendation = recommendation
    || (passing.length === 1
      ? `Prefer **${best.title}** because it is the only candidate that passed the benchmark.`
      : passing.length > 1
        ? 'Multiple candidates passed. Add an evidence-based recommendation that weighs maintainability and issue-specific tradeoffs, not runtime alone.'
        : 'No recommendation: no candidate passed the benchmark.');
  const report = `# AI Scientist Report\n\n`
    + `## Issue\n\n${state.issue}\n\n`
    + `## Search Configuration\n\n`
    + `- Workers: ${state.config.numWorkers}\n`
    + `- Steps used: ${state.stepsUsed}/${state.config.maxSteps}\n`
    + `- Max debug attempts: ${state.config.maxDebugAttempts}\n`
    + `- Benchmark: ${state.benchmarkCommand ? `\`${state.benchmarkCommand}\`` : 'not configured'}\n\n`
    + `## Candidate Results\n\n`
    + `| Candidate | Status | Benchmark | Score | Tradeoffs / Notes |\n`
    + `|---|---|---:|---:|---|\n${rows || '| None | not executed | not executed | 0 | No candidates registered |'}\n\n`
    + `## Recommendation\n\n${finalRecommendation}\n\n`
    + `## Conclusion\n\n${conclusion || 'This report only treats persisted benchmark output as measured evidence. Unexecuted approaches are explicitly labeled.'}\n`;
  const path = join(directory, 'report.md');
  writeFileSync(path, report);
  state.status = 'reported';
  state.reportPath = path;
  saveState(root, state);
  return { runId, reportPath: path, recommendation: finalRecommendation };
}
