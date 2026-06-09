import { REMOTE, BINARIES, cli } from '../setup';
import { execSync } from 'child_process';
import { join } from 'path';

const T = REMOTE;
const B = BINARIES;

describe('Debug Lifecycle', () => {
  it('health check', () => {
    // Test both direct exec and cli() helper
    const direct = execSync(
      `node "${join(__dirname, '..', '..', 'out', 'cli.js')}" health 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' }
    );
    expect(direct).toContain('"ok"');

    const r = cli('health');
    expect(r.ok).toBe(true);
  });

  it('launch + break + continue returns status', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    expect(r.ok).toBe(true);

    r = cli('break --file multithread.c --line 17');
    expect(r.ok).toBe(true);
    expect(r.breakpoints[0].verified).toBe(true);

    r = cli('continue');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('stopped');
    expect(r.threads.length).toBeGreaterThanOrEqual(1);
    expect(r.frames[0].func).toBe('worker');

    cli('stop');
  });

  it('next auto-returns status', () => {
    cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    cli('break --file multithread.c --line 17');
    cli('continue');

    const r = cli('next');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('stopped');
    cli('stop');
  });

  it('watchpoint', () => {
    cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    cli('break --file multithread.c --line 17');
    cli('continue');

    const r = cli('watch --expr i --type write');
    expect(r.ok).toBe(true);
    expect(r.breakpoints[0].verified).toBe(true);
    cli('stop');
  });

  it('eval and gdb', () => {
    cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    cli('break --file multithread.c --line 17');
    cli('continue');

    expect(cli('eval i').ok).toBe(true);
    expect(cli('gdb -thread-info').ok).toBe(true);
    cli('stop');
  });

  it('crash backtrace', () => {
    cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    cli('break --file multithread.c --line 17');
    cli('continue');

    const r = cli('crash');
    expect(r.ok).toBe(true);
    expect(r.frames.length).toBeGreaterThan(0);
    cli('stop');
  });
});
