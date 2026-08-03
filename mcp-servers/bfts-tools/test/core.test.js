import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  applyCandidate,
  getRun,
  planRun,
  proposeCandidates,
  recordResult,
  recheckRun,
  runBaseline,
  runBenchmark,
  selectNextNodes,
  setEvaluationCriteria,
  writeReport,
} from '../src/core.js';

const execFileAsync = promisify(execFile);

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function createProject() {
  const root = mkdtempSync(join(tmpdir(), 'bfts-tools-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial fixture');
  return root;
}

test('detects a benchmark in a single nested package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bfts-tools-nested-'));
  const packageDirectory = join(root, 'tools', 'runner');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial fixture');

  const plan = await planRun({
    projectPath: root,
    issue: 'Investigate the nested package',
    numWorkers: 1,
    maxSteps: 1,
    maxDebugAttempts: 1,
    numDrafts: 1,
  });

  assert.equal(plan.readiness.ready, true);
  assert.equal(plan.benchmarkCommand, "npm --prefix 'tools/runner' test");
});

test('invalidates the baseline when readiness inputs change', async () => {
  const root = createProject();
  const plan = await planRun({
    projectPath: root,
    issue: 'Investigate a readiness change',
    numWorkers: 1,
    maxSteps: 1,
    maxDebugAttempts: 1,
    numDrafts: 2,
  });
  const initialBaseline = await runBaseline({
    projectPath: root,
    runId: plan.runId,
    timeoutSeconds: 30,
  });

  const rechecked = await recheckRun({
    projectPath: root,
    runId: plan.runId,
    benchmarkCommand: 'npm run benchmark',
  });

  assert.equal(rechecked.baselineBenchmark, null);
  assert.match(rechecked.searchHistory.at(-1).event, /baseline-invalidated/);

  const replacementBaseline = await runBaseline({
    projectPath: root,
    runId: plan.runId,
    timeoutSeconds: 30,
  });
  assert.notEqual(
    replacementBaseline.benchmark.worktreePath,
    initialBaseline.benchmark.worktreePath,
  );
  writeFileSync(join(root, 'change.txt'), 'new baseline\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Change baseline');
  const commitRecheck = await recheckRun({ projectPath: root, runId: plan.runId });
  assert.equal(commitRecheck.baselineBenchmark, null);
  const rerun = await runBaseline({ projectPath: root, runId: plan.runId, timeoutSeconds: 30 });
  assert.equal(rerun.benchmark.runs, 1);
});

test('rejects baseline evidence that mutates the tested worktree', async () => {
  const root = createProject();
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'generated.txt\', \'changed\')"' },
  }));
  git(root, 'add', 'package.json');
  git(root, 'commit', '-qm', 'Add mutating benchmark');
  const plan = await planRun({
    projectPath: root,
    issue: 'Detect benchmark side effects',
    numWorkers: 1,
    maxSteps: 1,
    maxDebugAttempts: 1,
    numDrafts: 2,
  });
  const baseline = await runBaseline({
    projectPath: root,
    runId: plan.runId,
    timeoutSeconds: 30,
  });
  assert.equal(baseline.benchmark.integrityValid, false);
  assert.equal(baseline.benchmark.success, false);
  assert.match(baseline.benchmark.integrityError, /Baseline worktree changed/);
});

test('enforces root draft count and benchmarked commit integrity', async () => {
  const root = createProject();
  const plan = await planRun({
    projectPath: root,
    issue: 'Protect root exploration and benchmark evidence',
    numWorkers: 1,
    maxSteps: 1,
    maxDebugAttempts: 1,
    numDrafts: 2,
  });
  await runBaseline({ projectPath: root, runId: plan.runId, timeoutSeconds: 30 });
  await setEvaluationCriteria({
    projectPath: root,
    runId: plan.runId,
    criteria: [
      { name: 'Correctness', description: 'Preserves expected behavior.', weight: 1 },
      { name: 'Safety', description: 'Preserves trustworthy evidence.', weight: 1 },
    ],
  });
  await assert.rejects(
    proposeCandidates({
      projectPath: root,
      runId: plan.runId,
      candidates: [{ title: 'Only draft', description: 'Insufficient exploration.' }],
    }),
    /exactly 2 candidates/,
  );
  await proposeCandidates({
    projectPath: root,
    runId: plan.runId,
    candidates: [
      { title: 'First draft', description: 'First independent approach.' },
      { title: 'Second draft', description: 'Second independent approach.' },
    ],
  });
  await assert.rejects(
    recheckRun({
      projectPath: root,
      runId: plan.runId,
      benchmarkCommand: 'npm run replacement-benchmark',
    }),
    /after candidates were proposed/,
  );
  const selection = await selectNextNodes({ projectPath: root, runId: plan.runId });
  const candidate = await applyCandidate({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
  });
  writeFileSync(join(candidate.worktreePath, 'candidate.txt'), 'benchmarked\n');
  await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    timeoutSeconds: 30,
  });
  writeFileSync(join(candidate.worktreePath, 'candidate.txt'), 'changed afterward\n');
  await assert.rejects(
    recordResult({
      projectPath: root,
      runId: plan.runId,
      nodeId: selection.nodes[0].nodeId,
      status: 'done',
      notes: 'This evidence is stale.',
      evaluation: [
        { name: 'Correctness', score: 10, evidence: 'The old commit passed.' },
        { name: 'Safety', score: 10, evidence: 'The old commit passed.' },
      ],
    }),
    /no longer matches/,
  );
  const stateFile = join(root, '.ai-scientist', 'runs', plan.runId, 'state.json');
  const legacyState = JSON.parse(readFileSync(stateFile, 'utf8'));
  const legacyNode = legacyState.nodes.find((node) => node.nodeId === selection.nodes[0].nodeId);
  legacyNode.status = 'done';
  delete legacyNode.benchmark.commitSha;
  delete legacyNode.benchmark.integrityValid;
  writeFileSync(stateFile, `${JSON.stringify(legacyState, null, 2)}\n`);
  const abandoned = await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    status: 'abandoned',
    notes: 'Legacy worktree evidence is no longer recoverable.',
  });
  assert.equal(abandoned.node.status, 'abandoned');
});

test('serializes parallel worker state updates', async () => {
  const root = createProject();
  const plan = await planRun({
    projectPath: root,
    issue: 'Apply independent candidates concurrently',
    numWorkers: 2,
    maxSteps: 2,
    maxDebugAttempts: 1,
    numDrafts: 2,
  });
  await runBaseline({ projectPath: root, runId: plan.runId, timeoutSeconds: 30 });
  await setEvaluationCriteria({
    projectPath: root,
    runId: plan.runId,
    criteria: [
      { name: 'Correctness', description: 'Preserves expected behavior.', weight: 1 },
      { name: 'Safety', description: 'Preserves trustworthy evidence.', weight: 1 },
    ],
  });
  await proposeCandidates({
    projectPath: root,
    runId: plan.runId,
    candidates: [
      { title: 'Parallel one', description: 'First independent approach.' },
      { title: 'Parallel two', description: 'Second independent approach.' },
    ],
  });
  const selection = await selectNextNodes({ projectPath: root, runId: plan.runId });
  const moduleUrl = new URL('../src/core.js', import.meta.url).href;
  await Promise.all(selection.nodes.map((node) => execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { applyCandidate } from ${JSON.stringify(moduleUrl)}; await applyCandidate(${JSON.stringify({
        projectPath: root,
        runId: plan.runId,
        nodeId: node.nodeId,
      })});`,
    ],
  )));
  const state = await getRun({ projectPath: root, runId: plan.runId });
  assert.equal(state.nodes.filter((node) => node.worktreePath).length, 2);
  const first = state.nodes[0];
  writeFileSync(join(first.worktreePath, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "setTimeout(() => {}, 500)"' },
  }));
  const attempts = await Promise.allSettled([
    runBenchmark({
      projectPath: root,
      runId: plan.runId,
      nodeId: first.nodeId,
      timeoutSeconds: 30,
    }),
    runBenchmark({
      projectPath: root,
      runId: plan.runId,
      nodeId: first.nodeId,
      timeoutSeconds: 30,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.match(
    attempts.find((attempt) => attempt.status === 'rejected').reason.message,
    /must be running/,
  );
});

test('plans, searches, benchmarks, and reports an issue-driven run', async () => {
  const root = createProject();
  const plan = await planRun({
    projectPath: root,
    issue: 'Compare two ways to improve startup behavior',
    numWorkers: 2,
    maxSteps: 3,
    maxDebugAttempts: 1,
    numDrafts: 2,
  });

  assert.equal(plan.readiness.ready, true);
  assert.equal(plan.benchmarkCommand, 'npm test');
  assert.match(readFileSync(join(root, 'report', plan.runId, 'plan.md'), 'utf8'), /Readiness/);
  assert.match(readFileSync(join(root, 'report', plan.runId, 'problem.md'), 'utf8'), /startup behavior/);

  const baseline = await runBaseline({
    projectPath: root,
    runId: plan.runId,
    timeoutSeconds: 30,
    runs: 2,
  });
  assert.equal(baseline.benchmark.passedRuns, 2);

  await setEvaluationCriteria({
    projectPath: root,
    runId: plan.runId,
    criteria: [
      { name: 'Correctness', description: 'Fixes the issue without regressions.', weight: 2 },
      { name: 'Maintainability', description: 'Keeps the implementation easy to evolve.', weight: 1 },
    ],
  });

  await proposeCandidates({
    projectPath: root,
    runId: plan.runId,
    candidates: [
      { title: 'Lazy initialization', description: 'Initialize only when requested.' },
      { title: 'Eager cache', description: 'Build a cache during startup.' },
    ],
  });
  const selection = await selectNextNodes({ projectPath: root, runId: plan.runId });
  assert.deepEqual(selection.nodes.map((node) => node.title), ['Lazy initialization', 'Eager cache']);

  const candidate = await applyCandidate({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
  });
  writeFileSync(join(candidate.worktreePath, 'candidate.txt'), 'implemented\n');
  const benchmark = await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    timeoutSeconds: 30,
    runs: 2,
  });
  assert.equal(benchmark.benchmark.success, true);
  assert.equal(benchmark.benchmark.passedRuns, 2);

  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    status: 'done',
    notes: 'Simple implementation with passing tests.',
    debugAttempted: false,
    evaluation: [
      { name: 'Correctness', score: 9, evidence: 'The common benchmark passed twice.' },
      { name: 'Maintainability', score: 8, evidence: 'The change is isolated and small.' },
    ],
  });
  const completed = await getRun({ projectPath: root, runId: plan.runId });
  assert.equal(completed.nodes[0].score, 26 / 3);
  assert.equal(completed.nodes[0].benchmark.command, 'npm test');
  assert.equal(completed.nodes[0].benchmark.integrityValid, true);
  assert.equal(completed.nodes[0].benchmark.commitSha, git(candidate.worktreePath, 'rev-parse', 'HEAD'));
  const stateFile = join(root, '.ai-scientist', 'runs', plan.runId, 'state.json');
  const legacyState = JSON.parse(readFileSync(stateFile, 'utf8'));
  const legacyNode = legacyState.nodes.find((node) => node.nodeId === selection.nodes[0].nodeId);
  legacyState.stateVersion = 1;
  legacyNode.score *= 10;
  legacyNode.evaluation.score *= 10;
  writeFileSync(stateFile, `${JSON.stringify(legacyState, null, 2)}\n`);
  const migrated = await getRun({ projectPath: root, runId: plan.runId });
  assert.equal(migrated.nodes[0].score, 26 / 3);

  legacyNode.evaluation = null;
  delete legacyNode.benchmark.commitSha;
  delete legacyNode.benchmark.integrityValid;
  delete legacyNode.benchmark.runs;
  delete legacyNode.benchmark.passedRuns;
  delete legacyNode.benchmark.medianDurationMs;
  delete legacyNode.benchmark.minDurationMs;
  delete legacyNode.benchmark.maxDurationMs;
  delete legacyNode.benchmark.executions;
  writeFileSync(stateFile, `${JSON.stringify(legacyState, null, 2)}\n`);
  await assert.rejects(
    recordResult({
      projectPath: root,
      runId: plan.runId,
      nodeId: selection.nodes[0].nodeId,
      status: 'done',
      notes: 'Legacy evidence must not be accepted.',
      evaluation: [
        { name: 'Correctness', score: 9, evidence: 'The old benchmark passed.' },
        { name: 'Maintainability', score: 8, evidence: 'The old implementation was isolated.' },
      ],
    }),
    /only after its applied worktree passes/,
  );
  await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    timeoutSeconds: 30,
  });
  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    status: 'done',
    notes: 'Legacy result re-evaluated with the shared rubric.',
    debugAttempted: false,
    evaluation: [
      { name: 'Correctness', score: 9, evidence: 'The migrated benchmark passed.' },
      { name: 'Maintainability', score: 8, evidence: 'The implementation remains isolated.' },
    ],
  });
  const secondCandidate = await applyCandidate({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[1].nodeId,
  });
  writeFileSync(join(secondCandidate.worktreePath, 'candidate.txt'), 'alternative\n');
  await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[1].nodeId,
    timeoutSeconds: 30,
  });
  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[1].nodeId,
    status: 'done',
    notes: 'Passing alternative with weaker rubric evidence.',
    debugAttempted: false,
    evaluation: [
      { name: 'Correctness', score: 6, evidence: 'The common benchmark passed.' },
      { name: 'Maintainability', score: 5, evidence: 'The alternative is more invasive.' },
    ],
  });
  const expansion = await selectNextNodes({
    projectPath: root,
    runId: plan.runId,
    numWorkers: 1,
  });
  assert.equal(expansion.nodes.length, 0);
  assert.equal(expansion.expansionParents[0].nodeId, selection.nodes[0].nodeId);
  await proposeCandidates({
    projectPath: root,
    runId: plan.runId,
    parentNodeId: selection.nodes[0].nodeId,
    candidates: [
      { title: 'Lazy initialization with cache', description: 'Refine the passing parent.' },
      { title: 'Lazy initialization without cache', description: 'Test a simpler refinement.' },
    ],
  });
  const childSelection = await selectNextNodes({
    projectPath: root,
    runId: plan.runId,
    numWorkers: 1,
  });
  writeFileSync(join(candidate.worktreePath, 'candidate.txt'), 'unbenchmarked parent mutation\n');
  const child = await applyCandidate({
    projectPath: root,
    runId: plan.runId,
    nodeId: childSelection.nodes[0].nodeId,
  });
  assert.equal(readFileSync(join(child.worktreePath, 'candidate.txt'), 'utf8'), 'implemented\n');
  writeFileSync(join(child.worktreePath, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
  }));
  const timedOutBenchmark = await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: childSelection.nodes[0].nodeId,
    timeoutSeconds: 1,
  });
  assert.equal(timedOutBenchmark.benchmark.timedOut, true);
  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: childSelection.nodes[0].nodeId,
    status: 'abandoned',
    notes: 'Inheritance verified; refinement was not benchmarked.',
    debugAttempted: false,
  });
  const report = await writeReport({ projectPath: root, runId: plan.runId });
  assert.match(readFileSync(report.reportPath, 'utf8'), /Lazy initialization/);
  assert.match(readFileSync(report.reportPath, 'utf8'), /Correctness: 9\.0\/10/);
  assert.match(readFileSync(report.reportPath, 'utf8'), /The migrated benchmark passed/);
  assert.match(readFileSync(join(root, 'report', plan.runId, 'search-log.md'), 'utf8'), /baseline-benchmarked/);
  assert.equal((await getRun({ projectPath: root, runId: plan.runId })).status, 'reported');
});
