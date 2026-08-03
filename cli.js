#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const managedFiles = [
  '.github/agents/ai-scientist.agent.md',
  '.github/prompts/ai-scientist-plan.prompt.md',
  '.github/prompts/ai-scientist-run.prompt.md',
  '.github/prompts/ai-scientist-solve.prompt.md',
];
const mcpTarget = '.github/copilot-ai-scientist/mcp';
const managedMcpFiles = [
  'index.js',
  'launcher.js',
  'src/core.js',
  'package.json',
  'package-lock.json',
];
const mcpConfig = {
  command: 'node',
  args: [`${mcpTarget}/launcher.js`],
  type: 'stdio',
  tools: ['*'],
};

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function projectRoot(directory) {
  try {
    return realpathSync(execFileSync(
      'git',
      ['-C', directory, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim());
  } catch {
    throw new Error(`Not a Git repository: ${resolve(directory)}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mcpServers(config) {
  if (Object.hasOwn(config, 'mcpServers')) {
    return { servers: config.mcpServers || {}, wrapped: true };
  }
  return { servers: config, wrapped: false };
}

function install(target, force) {
  const root = projectRoot(target);
  const conflicts = managedFiles.filter((path) => {
    const destination = join(root, path);
    return existsSync(destination)
      && readFileSync(destination, 'utf8') !== readFileSync(join(packageRoot, path), 'utf8');
  });
  const targetMcp = join(root, mcpTarget);
  for (const path of managedMcpFiles) {
    const destination = join(targetMcp, path);
    const source = join(packageRoot, 'mcp-servers/bfts-tools', path);
    if (existsSync(destination) && readFileSync(destination, 'utf8') !== readFileSync(source, 'utf8')) {
      conflicts.push(join(mcpTarget, path));
    }
  }

  const configPath = join(root, '.mcp.json');
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  const { servers, wrapped } = mcpServers(config);
  const existingServer = servers['bfts-tools'];
  if (existingServer && !sameJson(existingServer, mcpConfig) && !force) {
    conflicts.push('.mcp.json (bfts-tools)');
  }
  if (conflicts.length > 0 && !force) {
    throw new Error(`Refusing to overwrite customized files:\n- ${conflicts.join('\n- ')}\nRe-run with --force to replace them.`);
  }

  for (const path of managedFiles) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(packageRoot, path), destination);
  }

  mkdirSync(targetMcp, { recursive: true });
  for (const path of ['index.js', 'launcher.js', 'src', 'package.json', 'package-lock.json']) {
    cpSync(join(packageRoot, 'mcp-servers/bfts-tools', path), join(targetMcp, path), {
      recursive: true,
      force: true,
    });
  }
  writeFileSync(join(targetMcp, '.gitignore'), 'node_modules/\n');

  const nextServers = { ...servers, 'bfts-tools': mcpConfig };
  const nextConfig = wrapped || !existsSync(configPath)
    ? { ...config, mcpServers: nextServers }
    : nextServers;
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: targetMcp,
    stdio: 'inherit',
  });

  console.log(`AI Scientist installed in ${root}`);
  console.log('Start Copilot CLI, select /agent ai-scientist, then run /ai-scientist-plan <issue>.');
}

const [command, ...args] = process.argv.slice(2);
if (command === 'init') {
  try {
    install(process.cwd(), args.includes('--force'));
  } catch (error) {
    fail(error.message);
  }
} else {
  fail('Usage: copilot-ai-scientist init [--force]');
}
