/** Shared test configuration */
export const REMOTE = { host: '192.168.64.2', user: 'ubuntu', password: '1234' };
export const BINARIES = {
  multithread: '/tmp/example/build/multithread',
  leakdemo: '/tmp/example/build/leakdemo',
  hello: '/tmp/example/build/hello',
  // C++ binaries (compile with: g++ -g -Og -pthread -o <name> <name>.cpp)
  multithreadCpp: '/tmp/example/build/multithread_cpp',
  leakdemoCpp: '/tmp/example/build/leakdemo_cpp',
};

import { execSync } from 'child_process';
import { join } from 'path';

const CLI = join(__dirname, '..', 'out', 'cli.js');

export function cli(args: string): any {
  const out = execSync(`node "${CLI}" ${args} 2>/dev/null`, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 100 * 1024 * 1024,
    shell: '/bin/bash',
  });
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return { ok: false, error: 'No valid JSON in CLI output' };
}

/** Daemon is started by the test script before Jest runs. This just verifies. */
export function ensureDaemon(): void {
  const r = cli('health');
  if (!r.ok) throw new Error('Daemon not running. Start with: npm run test:integration');
}
