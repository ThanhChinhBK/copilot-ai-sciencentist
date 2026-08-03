import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installRepository, installUser } from '../cli.js';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

test('user installation leaves the investigated repository clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-scientist-project-'));
  const copilotHome = mkdtempSync(join(tmpdir(), 'ai-scientist-home-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial fixture');
  writeFileSync(join(copilotHome, 'mcp-config.json'), JSON.stringify({
    mcpServers: {
      existing: { command: 'existing-server', args: [] },
    },
  }));

  const installed = installUser({
    copilotHome,
    installRuntimeDependencies: false,
  });

  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(root, '.github')), false);
  assert.equal(existsSync(join(root, '.mcp.json')), false);
  assert.equal(existsSync(installed.agentPath), true);
  assert.equal(existsSync(join(installed.targetMcp, 'launcher.js')), true);
  const config = JSON.parse(readFileSync(installed.configPath, 'utf8'));
  assert.equal(config.mcpServers.existing.command, 'existing-server');
  assert.equal(
    config.mcpServers['bfts-tools'].args[0],
    join(installed.targetMcp, 'launcher.js'),
  );
});

test('user installation preserves customized agents unless forced', () => {
  const copilotHome = mkdtempSync(join(tmpdir(), 'ai-scientist-home-'));
  const installed = installUser({
    copilotHome,
    installRuntimeDependencies: false,
  });
  writeFileSync(installed.agentPath, 'customized\n');

  assert.throws(
    () => installUser({ copilotHome, installRuntimeDependencies: false }),
    /customized user agent/,
  );
  installUser({
    copilotHome,
    force: true,
    installRuntimeDependencies: false,
  });
  assert.notEqual(readFileSync(installed.agentPath, 'utf8'), 'customized\n');
});

test('user installation validates MCP conflicts before writing files', () => {
  const copilotHome = mkdtempSync(join(tmpdir(), 'ai-scientist-home-'));
  writeFileSync(join(copilotHome, 'mcp-config.json'), JSON.stringify({
    mcpServers: {
      'bfts-tools': { command: 'custom-server', args: [] },
    },
  }));

  assert.throws(
    () => installUser({ copilotHome, installRuntimeDependencies: false }),
    /customized bfts-tools configuration/,
  );
  assert.equal(existsSync(join(copilotHome, 'agents', 'ai-scientist.agent.md')), false);
  assert.equal(existsSync(join(copilotHome, 'copilot-ai-scientist')), false);
});

test('user installation wraps an existing empty MCP config', () => {
  const copilotHome = mkdtempSync(join(tmpdir(), 'ai-scientist-home-'));
  writeFileSync(join(copilotHome, 'mcp-config.json'), '{}\n');

  const installed = installUser({
    copilotHome,
    installRuntimeDependencies: false,
  });
  const config = JSON.parse(readFileSync(installed.configPath, 'utf8'));
  assert.equal(config.mcpServers['bfts-tools'].command, 'node');
});

test('forced repository install validates malformed MCP config before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-scientist-project-'));
  git(root, 'init', '-q');
  writeFileSync(join(root, '.mcp.json'), '{invalid\n');

  assert.throws(
    () => installRepository(root, true, false),
    /JSON/,
  );
  assert.equal(existsSync(join(root, '.github', 'agents', 'ai-scientist.agent.md')), false);
});
