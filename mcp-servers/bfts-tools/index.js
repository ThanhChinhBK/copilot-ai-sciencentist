#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'bfts-tools', version: '0.1.0' });

function notImplemented(toolName) {
  return async () => ({
    content: [{ type: 'text', text: `${toolName} is not implemented yet.` }],
    isError: true,
  });
}

server.registerTool(
  'bftsScanProject',
  {
    description: 'Scan a project to identify a concrete, scoped problem to solve.',
    inputSchema: {
      projectPath: z.string(),
      focus: z.string().optional(),
    },
  },
  notImplemented('bftsScanProject'),
);

server.registerTool(
  'bftsProposeCandidates',
  {
    description: 'Register 2-4 candidate solution approaches as BFTS root nodes.',
    inputSchema: {
      runId: z.string(),
      candidates: z.array(z.object({ description: z.string() })),
    },
  },
  notImplemented('bftsProposeCandidates'),
);

server.registerTool(
  'bftsSelectNextNode',
  {
    description: 'Select the next pending node(s) to explore via best-first search.',
    inputSchema: {
      runId: z.string(),
      numWorkers: z.number().int().positive().default(1),
    },
  },
  notImplemented('bftsSelectNextNode'),
);

server.registerTool(
  'bftsApplyCandidate',
  {
    description: 'Apply a candidate node on an isolated git branch/worktree.',
    inputSchema: {
      runId: z.string(),
      nodeId: z.string(),
    },
  },
  notImplemented('bftsApplyCandidate'),
);

server.registerTool(
  'bftsRunBenchmark',
  {
    description: 'Run the project benchmark/test command against a candidate branch.',
    inputSchema: {
      runId: z.string(),
      nodeId: z.string(),
      command: z.string().optional(),
    },
  },
  notImplemented('bftsRunBenchmark'),
);

server.registerTool(
  'bftsRecordResult',
  {
    description: 'Record a node result (status, score, benchmark output) in the state store.',
    inputSchema: {
      runId: z.string(),
      nodeId: z.string(),
      status: z.enum(['done', 'abandoned']),
      score: z.number().optional(),
      notes: z.string().optional(),
    },
  },
  notImplemented('bftsRecordResult'),
);

const transport = new StdioServerTransport();
await server.connect(transport);
