/**
 * Regression test for multi-threaded breakpoint re-triggering.
 *
 * Verifies (with the standalone validator, bypassing the daemon) that:
 *  - a conditional breakpoint (`i == 2`) on a line INSIDE the loop body re-triggers once per
 *    thread (3 stops) — the scenario that was once misdiagnosed as a GDB multi-threading
 *    limitation (it was actually a loop-header/loop-back-edge line artifact);
 *  - an unconditional breakpoint on the same line re-triggers on every pass (24 stops).
 *  - the pathological loop-header line (17) still fires only once per thread, guarding the
 *    documented "break inside the loop body" rule of thumb.
 *
 * Uses GdbMiClient directly (no daemon, no HTTP) — see src/tools/nonstop-validate.ts.
 */
import { REMOTE, BINARIES } from '../setup';
import { execSync } from 'child_process';
import { validateNonStop, ValidateOptions } from '../../src/tools/nonstop-validate';

const T = REMOTE;
const B = BINARIES;

function buildFixtureIfMissing(): void {
  try {
    execSync(
      `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "test -f ${B.multithread} && echo present"`,
      { encoding: 'utf8', timeout: 20000, shell: '/bin/bash' },
    ).trim();
  } catch {
    execSync(
      `SSHPASS='${T.password}' sshpass -e scp -o StrictHostKeyChecking=no test/fixtures/multithread.c ${T.user}@${T.host}:/tmp/example/src/multithread.c`,
      { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' },
    );
    execSync(
      `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "mkdir -p /tmp/example/build && gcc -O0 -g -ggdb3 -o ${B.multithread} /tmp/example/src/multithread.c -lpthread"`,
      { encoding: 'utf8', timeout: 60000, shell: '/bin/bash' },
    );
  }
}

function opts(mode: 'conditional' | 'unconditional', line: number): ValidateOptions {
  return {
    target: T.host,
    user: T.user,
    pwd: T.password,
    binary: B.multithread,
    port: 2347, // dedicated port, avoids colliding with daemon sessions on 2345
    gdbPath: '/usr/bin/gdb-multiarch',
    sudo: false,
    mode,
    nonStop: false,
    condition: mode === 'conditional' ? 'i == 2' : undefined,
    sourceFile: 'multithread.c',
    sourceLine: line,
    timeoutMs: 45000,
  };
}

describe('Multi-threaded breakpoint re-trigger (loop-body line)', () => {
  beforeAll(() => buildFixtureIfMissing(), 60000);

  it('conditional `i == 2` on line 18 stops each thread exactly once (3 hits)', async () => {
    const r = await validateNonStop(opts('conditional', 18));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/got 3/);
    expect(r.count).toBe(3);
    expect(r.distinctThreads).toBe(3);
    expect(r.pass).toBe(true);
  });

  it('unconditional breakpoint on line 18 re-triggers every pass (24 hits, 4/8/12)', async () => {
    const r = await validateNonStop(opts('unconditional', 18));
    expect(r.ok).toBe(true);
    expect(r.count).toBe(24);
    expect(r.distinctThreads).toBe(3);
    expect(r.perThread['2']).toBe(4);
    expect(r.perThread['3']).toBe(8);
    expect(r.perThread['4']).toBe(12);
    expect(r.pass).toBe(true);
  });

  it('loop-header line 17 still fires once per thread (guards documented rule of thumb)', async () => {
    const r = await validateNonStop(opts('unconditional', 17));
    expect(r.ok).toBe(true);
    // This is the pathological case: 3 (once per thread), NOT 24.
    expect(r.count).toBe(3);
    expect(r.pass).toBe(false);
  });
});
