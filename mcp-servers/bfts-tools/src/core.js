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

function lockPath(root, runId) {
  return join(runDirectory(root, runId), 'state.lock');
}

function reportDirectory(root, runId) {
  return join(root, 'report', safeId(runId));
}

function loadState(root, runId) {
  const path = statePath(root, runId);
  if (!existsSync(path)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const stateVersion = state.stateVersion || 1;
  state.evaluationCriteria ||= [];
  state.baselineBenchmark ||= null;
  state.nextExpansionParentId ||= null;
  state.searchHistory ||= [];
  for (const node of state.nodes || []) {
    node.overallPlan ||= node.description;
    node.evaluation ||= null;
    node.expanded ||= false;
    if (stateVersion < 2 && node.evaluation) {
      if (Number.isFinite(node.evaluation.score)) node.evaluation.score /= 10;
      if (Number.isFinite(node.score)) node.score /= 10;
    }
    if (node.benchmark && node.benchmark.runs === undefined) {
      const execution = {
        run: 1,
        success: node.benchmark.success,
        exitCode: node.benchmark.exitCode,
        durationMs: node.benchmark.durationMs,
        stdout: node.benchmark.stdout,
        stderr: node.benchmark.stderr,
        timedOut: node.benchmark.timedOut,
        error: null,
      };
      node.benchmark.runs = 1;
      node.benchmark.passedRuns = node.benchmark.success ? 1 : 0;
      node.benchmark.medianDurationMs = node.benchmark.durationMs;
      node.benchmark.minDurationMs = node.benchmark.durationMs;
      node.benchmark.maxDurationMs = node.benchmark.durationMs;
      node.benchmark.executions = [execution];
    }
  }
  state.stateVersion = 2;
  return state;
}

function saveState(root, state) {
  const directory = runDirectory(root, state.runId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'state.json');
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

async function withStateLock(root, runId, callback) {
  const directory = runDirectory(root, runId);
  mkdirSync(directory, { recursive: true });
  const path = lockPath(root, runId);
  const holder = spawn(
    'flock',
    ['-x', '-w', '10', path, 'sh', '-c', "printf 'locked\\n'; cat >/dev/null"],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  holder.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolveLock, rejectLock) => {
    let output = '';
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('locked\n')) resolveLock();
    });
    holder.once('error', rejectLock);
    holder.once('exit', (code) => {
      if (!output.includes('locked\n')) {
        rejectLock(new Error(stderr.trim() || `Timed out waiting for run state lock: ${runId} (${code})`));
      }
    });
  });
  try {
    return await callback();
  } finally {
    holder.stdin.end();
    await new Promise((resolveExit) => holder.once('exit', resolveExit));
  }
}

function commitCandidate(node) {
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
  const remainingChanges = git(node.worktreePath, ['status', '--porcelain']);
  if (remainingChanges) {
    throw new Error(`Candidate worktree is not clean after commit: ${node.nodeId}`);
  }
  return git(node.worktreePath, ['rev-parse', 'HEAD']);
}

function hasTrustedBenchmark(node) {
  return Boolean(
    node.benchmark?.success
    && node.benchmark.integrityValid
    && node.benchmark.commitSha,
  );
}

function bestExpandableNode(state) {
  const parentIds = new Set(state.nodes.map((node) => node.parentId).filter(Boolean));
  return state.nodes
    .filter((node) => (
      node.status === 'done'
      && hasTrustedBenchmark(node)
      && node.evaluation
      && !node.expanded
      && !parentIds.has(node.nodeId)
    ))
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))[0] || null;
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

  const ignored = new Set(['.git', 'node_modules', '.ai-scientist', 'report', 'experiments']);
  const nestedCommands = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const nestedPackagePath = join(path, 'package.json');
      if (existsSync(nestedPackagePath)) {
        const packageJson = JSON.parse(readFileSync(nestedPackagePath, 'utf8'));
        for (const name of ['test', 'benchmark']) {
          if (packageJson.scripts?.[name]) {
            const prefix = relative(root, path).replaceAll(sep, '/');
            nestedCommands.push(`npm --prefix '${prefix.replaceAll("'", "'\\''")}' ${name === 'test' ? 'test' : `run ${name}`}`);
            break;
          }
        }
      }
      visit(path);
    }
  }

  visit(root);
  if (nestedCommands.length === 1) {
    return nestedCommands[0];
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

function appendHistory(state, event, details = {}) {
  state.searchHistory ||= [];
  state.searchHistory.push({
    sequence: state.searchHistory.length + 1,
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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
  const criteria = state.evaluationCriteria.length > 0
    ? state.evaluationCriteria
      .map((criterion) => `- **${criterion.name}** (weight ${criterion.weight}): ${criterion.description}`)
      .join('\n')
    : '- Not configured yet. Define shared criteria before proposing candidates.';
  const plan = `# Research Plan: ${state.issue}\n\n`
    + `- **Run ID:** \`${state.runId}\`\n`
    + `- **Project:** \`${state.projectPath}\`\n`
    + `- **Base commit:** \`${state.baseCommit}\`\n`
    + `- **Benchmark:** ${state.benchmarkCommand ? `\`${state.benchmarkCommand}\`` : 'not configured'}\n\n`
    + `## Readiness\n\n${checks}\n\n`
    + `## Evaluation Criteria\n\n${criteria}\n\n`
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
  writeFileSync(
    join(directory, 'problem.md'),
    `# Problem\n\n${state.issue}\n\n## Base Commit\n\n\`${state.baseCommit}\`\n`,
  );
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
    stateVersion: 2,
    runId,
    issue: input.issue.trim(),
    projectPath: scan.projectPath,
    baseCommit: scan.baseCommit,
    benchmarkCommand,
    baselineBenchmark: null,
    evaluationCriteria: [],
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
    nextExpansionParentId: null,
    nodes: [],
    searchHistory: [],
  };
  ensureLocalExcludes(scan.projectPath, runId);
  saveState(scan.projectPath, state);
  writePlan(scan.projectPath, state);
  return state;
}

export async function setEvaluationCriteria({ projectPath, runId, criteria }) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    if (state.nodes.some((node) => node.evaluation)) {
      throw new Error('Evaluation criteria cannot change after a candidate is evaluated.');
    }
    const names = criteria.map((criterion) => criterion.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      throw new Error('Evaluation criterion names must be unique.');
    }
    state.evaluationCriteria = criteria.map((criterion) => ({
      name: criterion.name.trim(),
      description: criterion.description.trim(),
      weight: criterion.weight,
    }));
    appendHistory(state, 'evaluation-criteria-set', {
      criteria: state.evaluationCriteria.map((criterion) => criterion.name),
    });
    saveState(root, state);
    writePlan(root, state);
    return { runId, evaluationCriteria: state.evaluationCriteria };
  });
}

export async function recheckRun({ projectPath, runId, benchmarkCommand }) {
  const root = projectRoot(projectPath);
  const initialState = loadState(root, runId);
  const scan = await scanProject({ projectPath: root, focus: initialState.issue });
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const nextBenchmarkCommand = benchmarkCommand || state.benchmarkCommand || scan.benchmarkCommand;
    const benchmarkChanged = nextBenchmarkCommand !== state.benchmarkCommand;
    const baseChanged = scan.baseCommit !== state.baseCommit;
    if (baseChanged && state.nodes.length > 0) {
      throw new Error('Repository HEAD changed after search began; create a new run to preserve a consistent baseline.');
    }
    if (benchmarkChanged && state.nodes.length > 0) {
      throw new Error('Benchmark command changed after candidates were proposed; create a new run for comparable evidence.');
    }
    state.benchmarkCommand = nextBenchmarkCommand;
    const checks = readinessChecks(scan, state.issue, nextBenchmarkCommand, runId);
    state.readiness = { ready: checks.every((check) => check.ready), checks };
    state.status = state.readiness.ready ? 'planned' : 'blocked';
    if (state.readiness.ready && baseChanged) {
      state.baseCommit = scan.baseCommit;
    }
    if (benchmarkChanged || baseChanged) {
      state.baselineBenchmark = null;
      appendHistory(state, 'baseline-invalidated', {
        benchmarkChanged,
        baseChanged,
      });
    }
    saveState(root, state);
    writePlan(root, state);
    return state;
  });
}

export async function proposeCandidates({ projectPath, runId, parentNodeId, candidates }) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    if (!state.readiness.ready) {
      throw new Error('Run is blocked by readiness checks; resolve them before proposing candidates.');
    }
    if (!state.baselineBenchmark) {
      throw new Error('Run the baseline benchmark before proposing candidates.');
    }
    if (state.evaluationCriteria.length < 2) {
      throw new Error('Define at least two shared evaluation criteria before proposing candidates.');
    }
    if (state.nodes.length > 0 && !parentNodeId) {
      throw new Error('Root candidates have already been registered for this run.');
    }
    if (!parentNodeId && candidates.length !== state.config.numDrafts) {
      throw new Error(`Root proposal requires exactly ${state.config.numDrafts} candidates.`);
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
    if (parent && state.nextExpansionParentId !== parentNodeId) {
      throw new Error(`Expand the best measured node selected by bftsSelectNextNode: ${state.nextExpansionParentId || 'none'}`);
    }
    const offset = state.nodes.length;
    const added = candidates.map((candidate, index) => ({
      nodeId: `${String(offset + index + 1).padStart(2, '0')}-${safeId(candidate.title) || 'candidate'}`,
      parentId: parentNodeId || null,
      title: candidate.title,
      description: candidate.description,
      rationale: candidate.rationale || '',
      overallPlan: parent
        ? `${parent.overallPlan}\nRefinement: ${candidate.description}`
        : candidate.description,
      status: 'pending',
      score: null,
      debugAttempts: 0,
      expanded: false,
      branchRef: null,
      worktreePath: null,
      benchmark: null,
      evaluation: null,
      notes: '',
    }));
    if (parent) {
      parent.expanded = true;
      state.nextExpansionParentId = null;
    }
    state.nodes.push(...added);
    state.status = 'searching';
    appendHistory(state, 'candidates-proposed', {
      parentNodeId: parentNodeId || null,
      nodeIds: added.map((node) => node.nodeId),
    });
    saveState(root, state);
    return { runId, nodes: added };
  });
}

export async function selectNextNodes({ projectPath, runId, numWorkers }) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const remaining = state.config.maxSteps - state.stepsUsed;
    if (remaining <= 0) {
      state.status = 'exhausted';
      saveState(root, state);
      return { runId, nodes: [], expansionParents: [], reason: 'maxSteps exhausted' };
    }
    const running = state.nodes.filter((node) => ['running', 'benchmarking'].includes(node.status)).length;
    const requestedWorkers = Math.min(numWorkers || state.config.numWorkers, state.config.numWorkers);
    const capacity = Math.max(0, requestedWorkers - running);
    if (capacity === 0) {
      return { runId, nodes: [], expansionParents: [], reason: 'all worker slots are busy' };
    }
    const count = Math.min(capacity, remaining);
    const selected = state.nodes
      .filter((node) => node.status === 'pending')
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .slice(0, count);
    for (const node of selected) {
      node.status = 'running';
    }
    state.stepsUsed += selected.length;
    if (selected.length > 0) {
      appendHistory(state, 'nodes-selected', {
        nodeIds: selected.map((node) => node.nodeId),
        stepsUsed: state.stepsUsed,
      });
      saveState(root, state);
      return {
        runId,
        nodes: selected,
        expansionParents: [],
        stepsUsed: state.stepsUsed,
        maxSteps: state.config.maxSteps,
      };
    }
    if (running > 0) {
      return { runId, nodes: [], expansionParents: [], reason: 'waiting for running nodes' };
    }
    const parent = bestExpandableNode(state);
    if (parent) {
      state.nextExpansionParentId = parent.nodeId;
      appendHistory(state, 'expansion-parent-selected', {
        nodeId: parent.nodeId,
        score: parent.score,
      });
      saveState(root, state);
      return {
        runId,
        nodes: [],
        expansionParents: [parent],
        reason: 'propose refinements for the highest-scoring measured leaf',
        stepsUsed: state.stepsUsed,
        maxSteps: state.config.maxSteps,
      };
    }
    state.status = 'exhausted';
    saveState(root, state);
    return { runId, nodes: [], expansionParents: [], reason: 'no pending or expandable nodes' };
  });
}

export async function applyCandidate({ projectPath, runId, nodeId }) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (node.status !== 'running') throw new Error(`Node must be running before applying: ${nodeId}`);
    if (!state.readiness.ready) throw new Error('Run readiness checks are not satisfied.');

    const parent = node.parentId
      ? state.nodes.find((candidate) => candidate.nodeId === node.parentId)
      : null;
    if (parent && (parent.status !== 'done' || !parent.branchRef || !hasTrustedBenchmark(parent))) {
      throw new Error(`Parent node is not ready for refinement: ${node.parentId}`);
    }
    const startPoint = parent?.benchmark.commitSha || state.baseCommit;
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
  });
}

async function executeBenchmark(command, cwd, timeoutSeconds, runs) {
  const executions = [];
  for (let run = 1; run <= runs; run += 1) {
  const started = performance.now();
  const execution = await new Promise((resolveExecution) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
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
    executions.push({
      run,
      success: execution.status === 0 && !execution.error && !execution.timedOut,
      exitCode: execution.status,
      durationMs: Math.round(performance.now() - started),
      stdout: execution.stdout,
      stderr: execution.stderr,
      timedOut: execution.timedOut,
      error: execution.error?.message || null,
    });
  }
  const durations = executions.map((execution) => execution.durationMs);
  return {
    command,
    success: executions.every((execution) => execution.success),
    runs,
    passedRuns: executions.filter((execution) => execution.success).length,
    medianDurationMs: Math.round(median(durations)),
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
    executions,
    measuredAt: new Date().toISOString(),
  };
}

export async function runBaseline({ projectPath, runId, timeoutSeconds = 900, runs = 1 }) {
  const root = projectRoot(projectPath);
  const initialState = loadState(root, runId);
  if (!initialState.benchmarkCommand) throw new Error('No benchmark command configured.');
  const worktreePath = join(
    root,
    WORKTREE_DIR,
    safeId(runId),
    `baseline-${initialState.baseCommit.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
  );
  assertSafeWorktreePath(root, worktreePath);
  mkdirSync(join(root, WORKTREE_DIR, safeId(runId)), { recursive: true });
  const created = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '--detach', worktreePath, initialState.baseCommit],
    { encoding: 'utf8' },
  );
  if (created.status !== 0) {
    throw new Error(created.stderr.trim() || 'Failed to create baseline worktree.');
  }
  const benchmark = await executeBenchmark(
    initialState.benchmarkCommand,
    worktreePath,
    timeoutSeconds,
    runs,
  );
  benchmark.worktreePath = worktreePath;
  benchmark.commitSha = initialState.baseCommit;
  benchmark.integrityValid = (
    git(worktreePath, ['rev-parse', 'HEAD']) === initialState.baseCommit
    && git(worktreePath, ['status', '--porcelain']).length === 0
  );
  if (!benchmark.integrityValid) {
    benchmark.success = false;
    benchmark.integrityError = 'Baseline worktree changed while the benchmark was executing.';
  }
  await withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    if (
      state.baseCommit !== initialState.baseCommit
      || state.benchmarkCommand !== initialState.benchmarkCommand
    ) {
      throw new Error('Run configuration changed while the baseline benchmark was executing.');
    }
    state.baselineBenchmark = benchmark;
    appendHistory(state, 'baseline-benchmarked', {
      success: benchmark.success,
      integrityValid: benchmark.integrityValid,
      passedRuns: benchmark.passedRuns,
      runs: benchmark.runs,
    });
    saveState(root, state);
  });
  return { runId, benchmark };
}

export async function runBenchmark({
  projectPath,
  runId,
  nodeId,
  timeoutSeconds = 900,
  runs = 1,
}) {
  const root = projectRoot(projectPath);
  const prepared = await withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node?.worktreePath) throw new Error(`Candidate worktree is not initialized: ${nodeId}`);
    const legacyRebenchmark = node.status === 'done' && !node.benchmark?.commitSha;
    if (node.status !== 'running' && !legacyRebenchmark) {
      throw new Error(`Node must be running before benchmarking: ${nodeId}`);
    }
    if (!state.benchmarkCommand) throw new Error('No benchmark command configured.');
    if (
      !state.baselineBenchmark
      || state.baselineBenchmark.command !== state.benchmarkCommand
      || !state.baselineBenchmark.integrityValid
    ) {
      throw new Error('Run the current shared benchmark against the baseline before benchmarking candidates.');
    }
    if (legacyRebenchmark) {
      node.evaluation = null;
      node.score = null;
      node.expanded = false;
    }
    const commitSha = commitCandidate(node);
    const benchmarkInvocationId = randomUUID();
    node.status = 'benchmarking';
    node.benchmarkInvocationId = benchmarkInvocationId;
    node.benchmark = null;
    appendHistory(state, 'candidate-benchmark-started', {
      nodeId,
      commitSha,
      command: state.benchmarkCommand,
    });
    saveState(root, state);
    return {
      benchmarkCommand: state.benchmarkCommand,
      benchmarkInvocationId,
      commitSha,
      worktreePath: node.worktreePath,
    };
  });

  const benchmark = await executeBenchmark(
    prepared.benchmarkCommand,
    prepared.worktreePath,
    timeoutSeconds,
    runs,
  );
  const lastExecution = benchmark.executions.at(-1);
  Object.assign(benchmark, {
    success: benchmark.success,
    exitCode: lastExecution.exitCode,
    durationMs: benchmark.medianDurationMs,
    stdout: lastExecution.stdout,
    stderr: lastExecution.stderr,
    timedOut: benchmark.executions.some((execution) => execution.timedOut),
    commitSha: prepared.commitSha,
  });
  const currentHead = git(prepared.worktreePath, ['rev-parse', 'HEAD']);
  const worktreeChanges = git(prepared.worktreePath, ['status', '--porcelain']);
  benchmark.integrityValid = currentHead === prepared.commitSha && worktreeChanges.length === 0;
  if (!benchmark.integrityValid) {
    benchmark.success = false;
    benchmark.integrityError = 'Candidate worktree changed while the benchmark was executing.';
  }
  const score = await withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const currentNode = state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!currentNode) throw new Error(`Node not found after benchmark: ${nodeId}`);
    if (
      currentNode.status !== 'benchmarking'
      || currentNode.benchmarkInvocationId !== prepared.benchmarkInvocationId
    ) {
      throw new Error(`Benchmark invocation is no longer current for node: ${nodeId}`);
    }
    currentNode.benchmark = benchmark;
    currentNode.status = 'running';
    delete currentNode.benchmarkInvocationId;
    if (!benchmark.success) currentNode.score = -100;
    appendHistory(state, 'candidate-benchmarked', {
      nodeId,
      commitSha: prepared.commitSha,
      integrityValid: benchmark.integrityValid,
      success: benchmark.success,
      passedRuns: benchmark.passedRuns,
      runs: benchmark.runs,
    });
    saveState(root, state);
    return currentNode.score;
  });
  return { runId, nodeId, score, benchmark };
}

export async function recordResult({
  projectPath,
  runId,
  nodeId,
  status,
  score,
  notes,
  debugAttempted,
  evaluation,
}) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => {
    const state = loadState(root, runId);
    const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const abandonUntrustedLegacy = (
      status === 'abandoned'
      && node.status === 'done'
      && !hasTrustedBenchmark(node)
    );
    if (status === 'done') {
      if (
        node.status !== 'running'
        || !node.worktreePath
        || !node.benchmark?.success
      ) {
        throw new Error('A node can be completed only after its applied worktree passes the benchmark.');
      }
      if (
        !node.benchmark.integrityValid
        || git(node.worktreePath, ['rev-parse', 'HEAD']) !== node.benchmark.commitSha
        || git(node.worktreePath, ['status', '--porcelain'])
      ) {
        throw new Error('Candidate worktree no longer matches the successfully benchmarked commit.');
      }
      if (!notes?.trim()) {
        throw new Error('A completed node requires evidence-based notes.');
      }
      const expected = state.evaluationCriteria;
      const supplied = evaluation || [];
      const byName = new Map(supplied.map((item) => [item.name.trim().toLowerCase(), item]));
      if (byName.size !== expected.length || supplied.length !== expected.length) {
        throw new Error('A completed node requires one evaluation for every shared criterion.');
      }
      const criteria = expected.map((criterion) => {
        const result = byName.get(criterion.name.toLowerCase());
        if (!result?.evidence?.trim()) {
          throw new Error(`Evaluation criterion requires evidence: ${criterion.name}`);
        }
        return {
          name: criterion.name,
          score: result.score,
          weight: criterion.weight,
          evidence: result.evidence.trim(),
        };
      });
      const totalWeight = criteria.reduce((total, criterion) => total + criterion.weight, 0);
      node.evaluation = {
        criteria,
        score: criteria.reduce(
          (total, criterion) => total + criterion.score * criterion.weight,
          0,
        ) / totalWeight,
      };
      node.score = node.evaluation.score;
    } else if (status === 'pending') {
      if (node.status !== 'running' || !debugAttempted) {
        throw new Error('Only a running node with a recorded debug attempt can return to pending.');
      }
    } else if (!['pending', 'running'].includes(node.status) && !abandonUntrustedLegacy) {
      throw new Error(`Cannot abandon node from status ${node.status}.`);
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
    if (status !== 'done' && score !== undefined) node.score = score;
    if (notes !== undefined) node.notes = notes;
    if (
      state.stepsUsed >= state.config.maxSteps
      && state.nodes.every((candidate) => candidate.status !== 'running')
    ) {
      state.status = 'exhausted';
    } else {
      state.status = 'searching';
    }
    appendHistory(state, 'result-recorded', {
      nodeId,
      status: node.status,
      score: node.score,
      benchmarkSuccess: node.benchmark?.success ?? null,
      debugAttempts: node.debugAttempts,
    });
    saveState(root, state);
    return { runId, node };
  });
}

export async function getRun({ projectPath, runId }) {
  return loadState(projectRoot(projectPath), runId);
}

export async function writeReport({ projectPath, runId, recommendation, conclusion }) {
  const root = projectRoot(projectPath);
  return withStateLock(root, runId, () => writeReportLocked({
    root,
    runId,
    recommendation,
    conclusion,
  }));
}

function writeReportLocked({ root, runId, recommendation, conclusion }) {
  const state = loadState(root, runId);
  const running = state.nodes.filter((node) => ['running', 'benchmarking'].includes(node.status));
  const pending = state.nodes.filter((node) => node.status === 'pending');
  const budgetRemaining = state.stepsUsed < state.config.maxSteps;
  const expandable = budgetRemaining ? bestExpandableNode(state) : null;
  const measured = state.nodes.filter((node) => node.benchmark);
  if (state.nodes.length === 0 || measured.length === 0) {
    throw new Error('Run has no measured candidate evidence to report.');
  }
  if (running.length > 0 || (pending.length > 0 && budgetRemaining) || expandable) {
    throw new Error('Run still has active or selectable nodes; finish or exhaust the search before writing the report.');
  }
  const directory = reportDirectory(root, runId);
  mkdirSync(directory, { recursive: true });
  const rows = state.nodes.map((node) => {
    const measured = node.benchmark
      ? `${node.benchmark.passedRuns}/${node.benchmark.runs} pass (median ${node.benchmark.medianDurationMs} ms)`
      : 'not executed';
    const evaluation = node.evaluation
      ? node.evaluation.criteria
        .map((criterion) => `${criterion.name}: ${criterion.score.toFixed(1)}/10`)
        .join('; ')
      : 'not evaluated';
    const score = Number.isFinite(node.score) ? node.score.toFixed(2) : 'not evaluated';
    return `| ${node.title} | ${node.status} | ${measured} | ${score} | ${evaluation} | ${node.notes || '—'} |`;
  }).join('\n');
  const completed = state.nodes.filter((node) => node.benchmark);
  const untrustedPassing = completed.filter((node) => (
    node.status === 'done'
    && node.benchmark.success
    && !hasTrustedBenchmark(node)
  ));
  if (untrustedPassing.length > 0) {
    throw new Error(
      `Passing candidates require commit-bound re-benchmarking: ${untrustedPassing.map((node) => node.nodeId).join(', ')}`,
    );
  }
  const unevaluatedPassing = completed.filter((node) => (
    node.status === 'done'
    && hasTrustedBenchmark(node)
    && !node.evaluation
  ));
  if (unevaluatedPassing.length > 0) {
    throw new Error(
      `Passing candidates require rubric evaluation before reporting: ${unevaluatedPassing.map((node) => node.nodeId).join(', ')}`,
    );
  }
  const passing = completed.filter((node) => (
    node.status === 'done'
    && hasTrustedBenchmark(node)
    && node.evaluation
  ));
  const best = passing.sort((a, b) => b.score - a.score)[0];
  const tiedBest = best
    ? passing.filter((node) => Math.abs(node.score - best.score) < 0.01)
    : [];
  const finalRecommendation = recommendation
    || (passing.length === 1
      ? `Prefer **${best.title}** because it passed the benchmark and achieved the strongest completed rubric evaluation.`
      : passing.length > 1 && tiedBest.length === 1
        ? `Prefer **${best.title}** because it has the highest weighted evaluation score (${best.score.toFixed(2)}).`
        : passing.length > 1
          ? 'The top candidates are tied under the shared rubric. Add a recommendation that explains the issue-specific tie-breaker.'
        : 'No recommendation: no candidate passed the benchmark.');
  const criteria = state.evaluationCriteria
    .map((criterion) => `- **${criterion.name}** (weight ${criterion.weight}): ${criterion.description}`)
    .join('\n');
  const baseline = state.baselineBenchmark
    ? `${state.baselineBenchmark.passedRuns}/${state.baselineBenchmark.runs} pass (median ${state.baselineBenchmark.medianDurationMs} ms)`
    : 'not measured';
  const evidence = state.nodes
    .filter((node) => node.evaluation)
    .map((node) => {
      const details = node.evaluation.criteria
        .map((criterion) => `- **${criterion.name} (${criterion.score.toFixed(1)}/10):** ${criterion.evidence}`)
        .join('\n');
      return `### ${node.title}\n\n${details}`;
    })
    .join('\n\n');
  const report = `# AI Scientist Report\n\n`
    + `## Issue\n\n${state.issue}\n\n`
    + `## Search Configuration\n\n`
    + `- Workers: ${state.config.numWorkers}\n`
    + `- Steps used: ${state.stepsUsed}/${state.config.maxSteps}\n`
    + `- Root drafts: ${state.config.numDrafts}\n`
    + `- Max debug attempts: ${state.config.maxDebugAttempts}\n`
    + `- Benchmark: ${state.benchmarkCommand ? `\`${state.benchmarkCommand}\`` : 'not configured'}\n\n`
    + `- Baseline: ${baseline}\n\n`
    + `## Evaluation Criteria\n\n${criteria}\n\n`
    + `## Candidate Results\n\n`
    + `| Candidate | Status | Benchmark | Score | Criterion Scores | Tradeoffs / Notes |\n`
    + `|---|---|---:|---:|---|---|\n${rows || '| None | not executed | not executed | 0 | not evaluated | No candidates registered |'}\n\n`
    + `## Evaluation Evidence\n\n${evidence || 'No completed candidate evaluations.'}\n\n`
    + `## Recommendation\n\n${finalRecommendation}\n\n`
    + `## Conclusion\n\n${conclusion || 'This report only treats persisted benchmark output as measured evidence. Unexecuted approaches are explicitly labeled.'}\n`;
  const path = join(directory, 'report.md');
  writeFileSync(path, report);
  const history = state.searchHistory
    .map((entry) => `- ${entry.timestamp} — **${entry.event}**: \`${JSON.stringify(entry)}\``)
    .join('\n');
  writeFileSync(
    join(directory, 'search-log.md'),
    `# Search Log\n\n${history || 'No search events were recorded.'}\n`,
  );
  state.status = 'reported';
  state.reportPath = path;
  saveState(root, state);
  return { runId, reportPath: path, recommendation: finalRecommendation };
}
