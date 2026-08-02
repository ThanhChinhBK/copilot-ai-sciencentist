#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  applyCandidate,
  getRun,
  planRun,
  proposeCandidates,
  recordResult,
  recheckRun,
  runBenchmark,
  scanProject,
  selectNextNodes,
  writeReport,
} from './src/core.js';

const server = new McpServer({ name: 'bfts-tools', version: '0.2.0' });

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function register(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (input) => {
    try {
      return result(await handler(input));
    } catch (error) {
      return {
        content: [{ type: 'text', text: error.message }],
        isError: true,
      };
    }
  });
}

register(
  'bftsPlanRun',
  'Create an issue-driven research and execution plan, verify project readiness, and initialize a persistent run.',
  {
    projectPath: z.string(),
    issue: z.string().min(1),
    benchmarkCommand: z.string().optional(),
    numWorkers: z.number().int().min(1).max(4).default(2),
    maxSteps: z.number().int().min(1).max(20).default(8),
    maxDebugAttempts: z.number().int().min(0).max(5).default(2),
    numDrafts: z.number().int().min(2).max(6).default(3),
  },
  planRun,
);

register(
  'bftsRecheckRun',
  'Re-run readiness checks after blockers such as a dirty baseline or missing benchmark command are resolved.',
  {
    runId: z.string(),
    projectPath: z.string(),
    benchmarkCommand: z.string().optional(),
  },
  recheckRun,
);

register(
  'bftsScanProject',
  'Inspect a project and return repository, test-command, and TODO/FIXME signals for issue research.',
  {
    projectPath: z.string(),
    focus: z.string().optional(),
  },
  scanProject,
);

register(
  'bftsProposeCandidates',
  'Register candidate solution approaches as BFTS root nodes.',
  {
    runId: z.string(),
    projectPath: z.string(),
    parentNodeId: z.string().optional(),
    candidates: z.array(z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      rationale: z.string().optional(),
      initialScore: z.number().optional(),
    })).min(2).max(6),
  },
  proposeCandidates,
);

register(
  'bftsSelectNextNode',
  'Select and reserve the highest-scored pending BFTS nodes within the run budget.',
  {
    runId: z.string(),
    projectPath: z.string(),
    numWorkers: z.number().int().min(1).max(4).optional(),
  },
  selectNextNodes,
);

register(
  'bftsApplyCandidate',
  'Create an isolated git branch and worktree for a selected candidate node.',
  {
    runId: z.string(),
    projectPath: z.string(),
    nodeId: z.string(),
  },
  applyCandidate,
);

register(
  'bftsRunBenchmark',
  'Run the configured or supplied benchmark command in a candidate worktree and persist measured output.',
  {
    runId: z.string(),
    projectPath: z.string(),
    nodeId: z.string(),
    command: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).default(900),
  },
  runBenchmark,
);

register(
  'bftsRecordResult',
  'Record implementation notes and final status for a BFTS node.',
  {
    runId: z.string(),
    projectPath: z.string(),
    nodeId: z.string(),
    status: z.enum(['pending', 'done', 'abandoned']),
    score: z.number().optional(),
    notes: z.string().optional(),
    debugAttempted: z.boolean().default(false),
  },
  recordResult,
);

register(
  'bftsGetRun',
  'Read the persistent plan, readiness state, search nodes, and benchmark results for a run.',
  {
    runId: z.string(),
    projectPath: z.string(),
  },
  getRun,
);

register(
  'bftsWriteReport',
  'Write the final measured tradeoff report for a completed or exhausted run.',
  {
    runId: z.string(),
    projectPath: z.string(),
    recommendation: z.string().optional(),
    conclusion: z.string().optional(),
  },
  writeReport,
);

const transport = new StdioServerTransport();
await server.connect(transport);
