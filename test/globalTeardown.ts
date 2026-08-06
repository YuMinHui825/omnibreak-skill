import { execSync } from 'child_process';

/** Kill the daemon started by globalSetup after the integration suite finishes. */
export default function globalTeardown(): void {
  try { execSync('pkill -f "node.*daemon" 2>/dev/null || true', { stdio: 'pipe', shell: '/bin/bash' }); } catch {}
}
