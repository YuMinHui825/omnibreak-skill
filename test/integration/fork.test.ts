/**
 * Multi-process (fork) debugging: verifies that `--follow-fork-mode child` +
 * `--detach-on-fork off` makes GDB follow the forked child and keep both
 * processes under the debugger, so a breakpoint inside the child's code path
 * stops there (fork() returned 0 ⇒ we are in the child) and re-triggers as the
 * child's loop advances.
 */
import { REMOTE, BINARIES, cli } from '../setup';
import { execSync } from 'child_process';

const T = REMOTE;
const B = BINARIES;

function buildForkIfMissing(): void {
  try {
    execSync(
      `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "test -f ${B.fork} && echo present"`,
      { encoding: 'utf8', timeout: 20000, shell: '/bin/bash' },
    ).trim();
  } catch {
    execSync(
      `SSHPASS='${T.password}' sshpass -e scp -o StrictHostKeyChecking=no test/fixtures/fork.c ${T.user}@${T.host}:/tmp/example/src/fork.c`,
      { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' },
    );
    execSync(
      `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "mkdir -p /tmp/example/build && gcc -O0 -g -ggdb3 -o ${B.fork} /tmp/example/src/fork.c"`,
      { encoding: 'utf8', timeout: 60000, shell: '/bin/bash' },
    );
  }
}

describe('Multi-process fork debugging', () => {
  beforeAll(() => buildForkIfMissing(), 60000);

  it('follows the forked child and re-triggers inside its loop', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.fork} --user ${T.user} --pwd ${T.password} --follow-fork-mode child --detach-on-fork off`);
    expect(r.ok).toBe(true);

    r = cli('break --file fork.c --line 12');
    expect(r.ok).toBe(true);
    expect(r.breakpoints[0].verified).toBe(true);

    r = cli('continue');
    expect(r.ok).toBe(true);
    expect(r.frames[0].func).toBe('main');

    // We are in the child: fork() returned 0 there.
    const pidEval = cli('eval pid');
    expect(pidEval.ok).toBe(true);
    expect(String(pidEval.result).trim()).toBe('0');

    // The child-loop breakpoint re-triggers: i advances on each continue.
    const i1 = parseInt(String(cli('eval i').result));
    r = cli('continue');
    expect(r.ok).toBe(true);
    const i2 = parseInt(String(cli('eval i').result));
    expect(i2).toBeGreaterThan(i1);

    cli('stop');
  });
});
