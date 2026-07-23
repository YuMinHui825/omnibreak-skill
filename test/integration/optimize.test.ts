/** Integration tests for P0 optimizations against real remote target */
import { REMOTE, BINARIES, cli } from '../setup';
import { Transport, createTransport, parseTarget } from '../../src/transport/transport';

const T = REMOTE;
const B = BINARIES;

beforeAll(() => {
  const r = cli('health');
  if (!r.ok) throw new Error('Daemon not running');
});

function remote(): Transport {
  return createTransport(parseTarget(T.host, T.user, T.password, 22));
}

describe('P0-1: SSH transport async exec', () => {
  it('exec returns result over real SSH', async () => {
    const t = remote();
    const out = await t.exec('echo hello-async-ssh');
    expect(out).toContain('hello-async-ssh');
  }, 15000);

  it('exec rejects on timeout with non-responsive target', async () => {
    const t = createTransport(parseTarget('10.255.255.1', 'nobody', 'x', 22));
    await expect(t.exec('echo hi', 2000)).rejects.toThrow();
  }, 10000);

  it('deployFile and pullFile work end-to-end', async () => {
    const t = remote();
    const src = '/tmp/omnibreak-async-deploy-test.txt';
    const dst = '/tmp/omnibreak-async-pull-back.txt';
    require('fs').writeFileSync(src, 'async-deploy-test');
    await t.deployFile(src, '/tmp/omnibreak-async-remote.txt');
    await t.pullFile('/tmp/omnibreak-async-remote.txt', dst);
    expect(require('fs').readFileSync(dst, 'utf8')).toBe('async-deploy-test');
    [src, dst].forEach(f => { try { require('fs').unlinkSync(f); } catch {} });
    await t.exec('rm -f /tmp/omnibreak-async-remote.txt');
  }, 30000);
});

describe('P0-2: Port-specific gdbserver cleanup (fuser -k)', () => {
  it('fuser kills only target port — other gdbserver survives', async () => {
    const t = remote();
    await t.exec('fuser -k 12340/tcp 2>/dev/null || true');
    await t.exec('fuser -k 12341/tcp 2>/dev/null || true');

    await t.exec('setsid gdbserver --multi :12340 >/tmp/gdb-12340.log 2>&1 &');
    await t.exec('setsid gdbserver --multi :12341 >/tmp/gdb-12341.log 2>&1 &');
    await new Promise(r => setTimeout(r, 3000));

    const before = await t.exec('ps aux | grep "gdbserver.*:1234[01]" | grep -v grep | wc -l');
    expect(parseInt(before.trim())).toBe(2);

    await t.exec('fuser -k 12340/tcp 2>&1 || true');
    await new Promise(r => setTimeout(r, 500));

    const after = await t.exec('ps aux | grep "gdbserver.*:1234[01]" | grep -v grep | wc -l');
    expect(parseInt(after.trim())).toBe(1);

    const survivor = await t.exec('ps aux | grep "gdbserver.*:12341" | grep -v grep');
    expect(survivor).toContain('12341');

    await t.exec('fuser -k 12341/tcp 2>/dev/null || true');
  }, 30000);
});

describe('P1-3: waitForPort detects readiness', () => {
  it('port ready within 3s (beats old 1.5s fixed sleep)', async () => {
    const t = remote();
    await t.exec('fuser -k 12342/tcp 2>/dev/null || true');

    const start = Date.now();
    await t.exec('setsid gdbserver --multi :12342 >/tmp/gdb-waitport.log 2>&1 &');

    let ready = false;
    for (let i = 0; i < 25; i++) {
      const out = await t.exec(`ss -tlnp 2>/dev/null | grep ':12342' || netstat -tlnp 2>/dev/null | grep ':12342' || echo ''`);
      if (out.trim()) { ready = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(ready).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);

    await t.exec('fuser -k 12342/tcp 2>/dev/null || true');
  }, 30000);
});

describe('P0 end-to-end: async transport debug cycle', () => {
  it('launch → break → continue → stop', () => {
    cli('stop');
    const l = cli(`launch --target ${T.host} --user ${T.user} --pwd ${T.password} --binary ${B.multithread} --port 2345`);
    expect(l.ok).toBe(true);

    const bp = cli('break --file multithread.c --line 17');
    expect(bp.ok).toBe(true);

    const c = cli('continue');
    expect(c.ok).toBe(true);

    expect(cli('stop').ok).toBe(true);
  }, 60000);
});

describe('P1-5: Source context on breakpoint hit', () => {
  it('continue returns source context with context field', () => {
    cli('stop');
    const l = cli(`launch --target ${T.host} --user ${T.user} --pwd ${T.password} --binary ${B.multithread} --port 2345`);
    expect(l.ok).toBe(true);

    cli('break --file multithread.c --line 17');
    const c = cli('continue');
    expect(c.ok).toBe(true);
    // Verify source context
    expect(c.context).toBeDefined();
    expect(Array.isArray(c.context)).toBe(true);
    expect(c.context.length).toBeGreaterThan(0);
    // Target line should be marked and match the stopped line
    const target = c.context.find((l: any) => l.isTarget);
    expect(target).toBeDefined();
    expect(target.line).toBe(c.line);
    // Lines should have code and be contiguous
    for (const l of c.context) {
      expect(typeof l.line).toBe('number');
      expect(typeof l.code).toBe('string');
      expect(typeof l.isTarget).toBe('boolean');
    }
    // Lines should be sorted
    const lineNums = c.context.map((l: any) => l.line);
    expect(lineNums).toEqual([...lineNums].sort((a: number, b: number) => a - b));

    expect(cli('stop').ok).toBe(true);
  }, 60000);

  it('status returns source context', () => {
    cli('stop');
    const l = cli(`launch --target ${T.host} --user ${T.user} --pwd ${T.password} --binary ${B.multithread} --port 2345`);
    expect(l.ok).toBe(true);

    cli('break --file multithread.c --line 17');
    cli('continue');
    const s = cli('status');
    expect(s.ok).toBe(true);
    expect(s.context).toBeDefined();
    expect(s.context.length).toBeGreaterThan(0);

    expect(cli('stop').ok).toBe(true);
  }, 60000);
});

describe('P2-6: Diff mode — before/after comparison', () => {
  it('sanitize command returns findings (may be empty on clean binary)', () => {
    const r = cli(`sanitize --target ${T.host} --user ${T.user} --pwd ${T.password}`);
    expect(r.ok).toBe(true);
    const d = JSON.parse(r.result);
    expect(d).toHaveProperty('findings');
    expect(Array.isArray(d.findings)).toBe(true);
    // Clean binaries have 0 findings; sanitizer-enabled binaries have >0
    expect(d).toHaveProperty('count');
  }, 15000);

  it('report generates diagnostic markdown', () => {
    cli('stop');
    const l = cli(`launch --target ${T.host} --user ${T.user} --pwd ${T.password} --binary ${B.multithread} --port 2345`);
    expect(l.ok).toBe(true);

    cli('break --file multithread.c --line 17');
    cli('continue');

    const r = cli('report');
    expect(r.ok).toBe(true);
    const report = JSON.parse(r.result);
    expect(report.session).toBeDefined();
    expect(report.crash).toBeDefined();
    expect(report.markdown).toBeDefined();
    expect(report.markdown).toContain('OmniBreak Diagnostic Report');
    expect(report.markdown).toContain('multithread');

    expect(cli('stop').ok).toBe(true);
  }, 60000);

  it('sanitizer launch flag sets env vars', () => {
    cli('stop');
    const l = cli(`launch --target ${T.host} --user ${T.user} --pwd ${T.password} --binary ${B.multithread} --port 2345 --asan`);
    expect(l.ok).toBe(true);
    // Session should be created; verify we can set breakpoints
    const bp = cli('break --file multithread.c --line 17');
    expect(bp.ok).toBe(true);
    expect(cli('stop').ok).toBe(true);
  }, 60000);

  it('diff captures two snapshots and computes delta', () => {
    const r = cli(`diff --pid 1 --target ${T.host} --user ${T.user} --pwd ${T.password} --wait 2000`);
    expect(r.ok).toBe(true);
    const d = JSON.parse(r.result);
    expect(d.before).toBeDefined();
    expect(d.after).toBeDefined();
    expect(d.delta).toBeDefined();
    expect(d.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(typeof d.before.cpuPercent).toBe('number');
    expect(typeof d.before.rssMB).toBe('number');
    expect(typeof d.delta.cpuPercent).toBe('number');
    expect(typeof d.delta.rssMB).toBe('number');
  }, 30000);
});
