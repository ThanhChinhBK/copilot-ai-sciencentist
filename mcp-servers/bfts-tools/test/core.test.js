import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyCandidate,
  getRun,
  planRun,
  proposeCandidates,
  recordResult,
  runBenchmark,
  selectNextNodes,
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
  });
  assert.equal(benchmark.benchmark.success, true);

  await recordResult({
    projectPath: root,
    runId: plan.runId,
    nodeId: selection.nodes[0].nodeId,
    status: 'done',
    notes: 'Simple implementation with passing tests.',
    debugAttempted: false,
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
  assert.equal((await getRun({ projectPath: root, runId: plan.runId })).status, 'reported');
});
