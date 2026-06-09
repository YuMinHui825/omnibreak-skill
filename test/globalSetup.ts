import { execSync } from 'child_process';

export default function globalSetup(): void {
  // Kill any existing daemon
  try { execSync('pkill -f "node.*daemon" 2>/dev/null || true', { stdio: 'pipe', shell: '/bin/bash' }); } catch {}
  execSync('sleep 0.5', { stdio: 'pipe' });

  // Start daemon
  const cmd = 'nohup node ' + __dirname + '/../out/daemon.js > /tmp/omnibreak-daemon-test.log 2>&1 & echo $!';
  const pid = execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();

  // Wait for daemon to be ready
  for (let i = 0; i < 40; i++) {
    try {
      const r = execSync(`node "${__dirname}/../out/cli.js" health 2>/dev/null`, {
        encoding: 'utf8', timeout: 1000, shell: '/bin/bash',
      });
      if (r.includes('"ok"')) {
        console.log(`[test] Daemon started (PID ${pid})`);
        return;
      }
    } catch {}
    execSync('sleep 0.5', { stdio: 'pipe' });
  }
  throw new Error('Daemon failed to start');
}
