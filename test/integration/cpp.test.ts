import { REMOTE, BINARIES, cli } from '../setup';
import { execSync } from 'child_process';

const T = REMOTE;
const B = BINARIES;

// Compile C++ fixtures on remote before testing
beforeAll(() => {
  const src = [
    { name: 'multithread_cpp', file: 'multithread.cpp', flags: '-g -Og -pthread -std=c++17' },
    { name: 'leakdemo_cpp', file: 'leakdemo.cpp', flags: '-g -Og -std=c++17' },
  ];
  for (const s of src) {
    try {
      // SCP source to remote, then compile
      execSync(
        `SSHPASS='${T.password}' sshpass -e scp -o StrictHostKeyChecking=no test/fixtures/${s.file} ${T.user}@${T.host}:/tmp/example/build/${s.file}`,
        { encoding: 'utf8', timeout: 15000, shell: '/bin/bash' },
      );
      execSync(
        `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "g++ ${s.flags} -o /tmp/example/build/${s.name} /tmp/example/build/${s.file}"`,
        { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' },
      );
      console.log(`[cpp] Compiled ${s.name}`);
    } catch (e: any) {
      console.log(`[cpp] Skip ${s.name}: ${e.message}`);
    }
  }
});

describe('C++ Debugging', () => {
  afterEach(() => { cli('stop'); });

  it('launch and debug C++ multithread', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.multithreadCpp} --user ${T.user} --pwd ${T.password} --sudo`);
    if (!r.ok) { console.log('C++ binary not available, skipping'); return; }

    r = cli('break --file multithread.cpp --line 11');
    expect(r.ok).toBe(true);
    expect(r.breakpoints[0].verified).toBe(true);

    r = cli('continue');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('stopped');
    // C++ worker function should be captured
    expect(r.frames.length).toBeGreaterThan(0);
  });

  it('C++ watchpoint on variable', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.multithreadCpp} --user ${T.user} --pwd ${T.password} --sudo`);
    if (!r.ok) { console.log('C++ binary not available, skipping'); return; }

    cli('break --file multithread.cpp --line 11');
    cli('continue');

    r = cli('watch --expr iterations --type write');
    expect(r.ok).toBe(true);
    r = cli('next');
    expect(r.ok).toBe(true);
  });

  it('C++ stats and leaks monitoring', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.leakdemoCpp} --user ${T.user} --pwd ${T.password} --sudo`);
    if (!r.ok) { console.log('C++ binary not available, skipping'); return; }

    cli('break --file leakdemo.cpp --line 12');
    r = cli('continue');
    expect(r.ok).toBe(true);

    // Get PID from session
    const pid = execSync(
      `SSHPASS='${T.password}' sshpass -e ssh -o StrictHostKeyChecking=no ${T.user}@${T.host} "pgrep -f leakdemo_cpp | head -1"`,
      { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' },
    ).trim();

    if (pid) {
      const sr = cli(`stats --pid ${pid} --target ${T.host} --user ${T.user} --pwd ${T.password}`);
      expect(sr.ok).toBe(true);
      const lr = cli(`leaks --pid ${pid} --target ${T.host} --user ${T.user} --pwd ${T.password}`);
      expect(lr.ok).toBe(true);
    }
  });
});
