#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryFiles = [
  '.github/agents/ai-scientist.agent.md',
  '.github/prompts/ai-scientist-plan.prompt.md',
  '.github/prompts/ai-scientist-run.prompt.md',
  '.github/prompts/ai-scientist-solve.prompt.md',
];
const repositoryMcpTarget = '.github/copilot-ai-scientist/mcp';
const managedMcpFiles = [
  'index.js',
  'launcher.js',
  'src/core.js',
  'package.json',
  'package-lock.json',
];

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

function mcpConfig(launcherPath) {
  return {
    command: 'node',
    args: [launcherPath],
    type: 'stdio',
    tools: ['*'],
  };
}

function mergeMcpServer(configPath, server, force, alwaysWrapped = false) {
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  const { servers, wrapped } = mcpServers(config);
  const existingServer = servers['bfts-tools'];
  if (existingServer && !sameJson(existingServer, server) && !force) {
    throw new Error(`Refusing to replace customized bfts-tools configuration in ${configPath}. Re-run with --force.`);
  }
  const nextServers = { ...servers, 'bfts-tools': server };
  return alwaysWrapped || wrapped || !existsSync(configPath)
    ? { ...config, mcpServers: nextServers }
    : nextServers;
}

function copyMcpRuntime(targetMcp) {
  mkdirSync(targetMcp, { recursive: true });
  for (const path of ['index.js', 'launcher.js', 'src', 'package.json', 'package-lock.json']) {
    cpSync(join(packageRoot, 'mcp-servers/bfts-tools', path), join(targetMcp, path), {
      recursive: true,
      force: true,
    });
  }
}

function installDependencies(targetMcp) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: targetMcp,
    stdio: 'inherit',
  });
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function installUser({
  force = false,
  copilotHome = process.env.COPILOT_HOME || join(homedir(), '.copilot'),
  installRuntimeDependencies = true,
} = {}) {
  const home = resolve(copilotHome);
  const installRoot = join(home, 'copilot-ai-scientist');
  const targetMcp = join(installRoot, 'mcp');
  const sourceAgent = join(packageRoot, '.github/agents/ai-scientist.agent.md');
  const agentContent = readFileSync(sourceAgent, 'utf8');
  const agentPath = join(home, 'agents', 'ai-scientist.agent.md');
  const manifestPath = join(installRoot, 'manifest.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {};
  if (
    existsSync(agentPath)
    && readFileSync(agentPath, 'utf8') !== agentContent
    && manifest.agentHash !== hash(readFileSync(agentPath, 'utf8'))
    && !force
  ) {
    throw new Error(`Refusing to overwrite customized user agent: ${agentPath}. Re-run with --force.`);
  }
  const configPath = join(home, 'mcp-config.json');
  const nextConfig = mergeMcpServer(
    configPath,
    mcpConfig(join(targetMcp, 'launcher.js')),
    force,
    true,
  );

  mkdirSync(dirname(agentPath), { recursive: true });
  writeFileSync(agentPath, agentContent);
  copyMcpRuntime(targetMcp);

  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({
    agentHash: hash(agentContent),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  if (installRuntimeDependencies) installDependencies(targetMcp);
  return { agentPath, configPath, targetMcp };
}

export function installRepository(target, force = false, installRuntimeDependencies = true) {
  const root = projectRoot(target);
  const conflicts = repositoryFiles.filter((path) => {
    const destination = join(root, path);
    return existsSync(destination)
      && readFileSync(destination, 'utf8') !== readFileSync(join(packageRoot, path), 'utf8');
  });
  const targetMcp = join(root, repositoryMcpTarget);
  for (const path of managedMcpFiles) {
    const destination = join(targetMcp, path);
    const source = join(packageRoot, 'mcp-servers/bfts-tools', path);
    if (existsSync(destination) && readFileSync(destination, 'utf8') !== readFileSync(source, 'utf8')) {
      conflicts.push(join(repositoryMcpTarget, path));
    }
  }
  const configPath = join(root, '.mcp.json');
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  const { servers, wrapped } = mcpServers(config);
  const server = mcpConfig(`${repositoryMcpTarget}/launcher.js`);
  if (servers['bfts-tools'] && !sameJson(servers['bfts-tools'], server) && !force) {
    conflicts.push('.mcp.json (bfts-tools)');
  }
  const nextServers = { ...servers, 'bfts-tools': server };
  const nextConfig = wrapped || !existsSync(configPath)
    ? { ...config, mcpServers: nextServers }
    : nextServers;
  if (conflicts.length > 0 && !force) {
    throw new Error(`Refusing to overwrite customized files:\n- ${conflicts.join('\n- ')}\nRe-run with --force to replace them.`);
  }

  for (const path of repositoryFiles) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(packageRoot, path), destination);
  }
  copyMcpRuntime(targetMcp);
  writeFileSync(join(targetMcp, '.gitignore'), 'node_modules/\n');
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  if (installRuntimeDependencies) installDependencies(targetMcp);
  return { root, configPath, targetMcp };
}

function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'init') {
    fail('Usage: copilot-ai-scientist init [--force] [--repo]');
    return;
  }
  try {
    const force = args.includes('--force');
    if (args.includes('--repo')) {
      const result = installRepository(process.cwd(), force);
      console.log(`AI Scientist installed in repository ${result.root}`);
    } else {
      const result = installUser({ force });
      console.log(`AI Scientist installed for this user in ${dirname(result.agentPath)}`);
    }
    console.log('Start Copilot CLI, select /agent ai-scientist, and describe the issue to investigate.');
  } catch (error) {
    fail(error.message);
  }
}

let mainPath;
try {
  mainPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  mainPath = process.argv[1] ? resolve(process.argv[1]) : null;
}
if (mainPath === realpathSync(fileURLToPath(import.meta.url))) run();
