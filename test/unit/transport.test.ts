import { parseTarget, createTransport, Transport } from '../../src/transport/transport';

describe('parseTarget', () => {
  it('parses SSH target', () => {
    const cfg = parseTarget('192.168.1.100', 'root', 'pass', 22);
    expect(cfg.type).toBe('ssh');
    expect(cfg.host).toBe('192.168.1.100');
    expect(cfg.user).toBe('root');
    expect(cfg.password).toBe('pass');
    expect(cfg.port).toBe(22);
  });

  it('parses local target', () => {
    const cfg = parseTarget('local', 'root', 'pass');
    expect(cfg.type).toBe('local');
  });

  it('parses docker target', () => {
    const cfg = parseTarget('docker://myapp', 'root', 'pass');
    expect(cfg.type).toBe('docker');
    expect(cfg.container).toBe('myapp');
  });

  it('parses docker target with path', () => {
    const cfg = parseTarget('docker://ubuntu-container', 'user');
    expect(cfg.type).toBe('docker');
    expect(cfg.container).toBe('ubuntu-container');
  });
});

describe('createTransport', () => {
  it('creates local transport', async () => {
    const t: Transport = createTransport({ type: 'local' });
    expect(t).toBeDefined();
    const out = await t.exec('echo hello');
    expect(out).toContain('hello');
  });

  it('local transport execSafe works', async () => {
    const t: any = createTransport({ type: 'local' });
    const out = await t.execSafe('echo safe');
    expect(out).toContain('safe');
  });

  it('local transport deploy + pull roundtrip', async () => {
    const t = createTransport({ type: 'local' });
    const src = '/tmp/omnibreak-test-src.txt';
    const dst = '/tmp/omnibreak-test-dst.txt';
    require('fs').writeFileSync(src, 'hello-local-transport');
    await t.deployFile(src, dst);
    expect(require('fs').existsSync(dst)).toBe(true);
    await t.pullFile(dst, src + '.pulled');
    expect(require('fs').readFileSync(src + '.pulled', 'utf8')).toBe('hello-local-transport');
    [src, dst, src + '.pulled'].forEach(f => { try { require('fs').unlinkSync(f); } catch {} });
  });

  it('creates docker transport (without actual docker check)', () => {
    const t = createTransport({ type: 'docker', container: 'test' });
    expect(t).toBeDefined();
  });

  it('creates SSH transport', () => {
    const t = createTransport({ type: 'ssh', host: '0.0.0.0', user: 'root', port: 22 });
    expect(t).toBeDefined();
  });

  it('exec timeout rejects with proper error', async () => {
    const t = createTransport({ type: 'ssh', host: '10.255.255.1', user: 'nobody', port: 22, password: 'x' });
    await expect(t.exec('echo hi', 2000)).rejects.toThrow();
  }, 10000);
});

describe('LocalTransport async', () => {
  const t = createTransport({ type: 'local' });

  it('exec returns Promise<string>', async () => {
    const p = t.exec('echo async-test');
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toContain('async-test');
  });

  it('deployFile returns Promise<void>', async () => {
    const src = '/tmp/omnibreak-deploy-test.txt';
    require('fs').writeFileSync(src, 'test');
    const p = t.deployFile(src, '/tmp/omnibreak-deploy-out.txt');
    expect(p).toBeInstanceOf(Promise);
    await p;
    try { require('fs').unlinkSync('/tmp/omnibreak-deploy-out.txt'); } catch {}
    try { require('fs').unlinkSync(src); } catch {}
  });

  it('pullFile returns Promise<void>', async () => {
    const src = '/tmp/omnibreak-pull-test.txt';
    const dst = '/tmp/omnibreak-pull-out.txt';
    require('fs').writeFileSync(src, 'pull-me');
    await t.deployFile(src, dst);
    await t.pullFile(dst, dst + '.copy');
    expect(require('fs').readFileSync(dst + '.copy', 'utf8')).toBe('pull-me');
    [src, dst, dst + '.copy'].forEach(f => { try { require('fs').unlinkSync(f); } catch {} });
  });
});
