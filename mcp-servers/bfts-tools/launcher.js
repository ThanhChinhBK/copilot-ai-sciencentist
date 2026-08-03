#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--silent'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

await import('./index.js');
