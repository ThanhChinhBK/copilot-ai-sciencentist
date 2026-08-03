import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
      { title: 'Lazy initialization', description: 'Initialize only when requested.', initialScore: 5 },
      { title: 'Eager cache', description: 'Build a cache during startup.', initialScore: 2 },
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
  const stateFile = join(root, '.ai-scientist', 'runs', plan.runId, 'state.json');
  const legacyState = JSON.parse(readFileSync(stateFile, 'utf8'));
  const legacyNode = legacyState.nodes.find((node) => node.nodeId === selection.nodes[0].nodeId);
  legacyNode.evaluation = null;
  delete legacyNode.benchmark.runs;
  delete legacyNode.benchmark.passedRuns;
  delete legacyNode.benchmark.medianDurationMs;
  delete legacyNode.benchmark.minDurationMs;
  delete legacyNode.benchmark.maxDurationMs;
  delete legacyNode.benchmark.executions;
  writeFileSync(stateFile, `${JSON.stringify(legacyState, null, 2)}\n`);
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
  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[1].nodeId,
    status: 'abandoned',
    notes: 'Not executed within the validation run.',
    debugAttempted: false,
  });
  await proposeCandidates({
    projectPath: root,
    runId: plan.runId,
    parentNodeId: selection.nodes[0].nodeId,
    candidates: [
      { title: 'Lazy initialization with cache', description: 'Refine the passing parent.', initialScore: 10 },
      { title: 'Lazy initialization without cache', description: 'Test a simpler refinement.', initialScore: 8 },
    ],
  });
  const childSelection = await selectNextNodes({
    projectPath: root,
    runId: plan.runId,
    numWorkers: 1,
  });
  const child = await applyCandidate({
    projectPath: root,
    runId: plan.runId,
    nodeId: childSelection.nodes[0].nodeId,
  });
  assert.equal(readFileSync(join(child.worktreePath, 'candidate.txt'), 'utf8'), 'implemented\n');
  const timedOutBenchmark = await runBenchmark({
    projectPath: root,
    runId: plan.runId,
    nodeId: childSelection.nodes[0].nodeId,
    command: 'node -e "setInterval(() => {}, 1000)"',
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
