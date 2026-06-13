import { parseTarget, createTransport } from '../../src/transport';

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
  it('creates local transport', () => {
    const t = createTransport({ type: 'local' });
    expect(t).toBeDefined();
    // Local transport exec works
    const out = t.exec('echo hello');
    expect(out).toContain('hello');
  });

  it('creates docker transport (without actual docker check)', () => {
    const t = createTransport({ type: 'docker', container: 'test' });
    expect(t).toBeDefined();
  });

  it('creates SSH transport', () => {
    const t = createTransport({ type: 'ssh', host: '0.0.0.0', user: 'root', port: 22 });
    expect(t).toBeDefined();
    // Won't actually connect
  });
});
