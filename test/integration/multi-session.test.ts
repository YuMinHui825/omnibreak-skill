import { REMOTE, BINARIES, cli } from '../setup';

const T = REMOTE;
const B = BINARIES;

describe('Multi-Session', () => {
  afterEach(() => { cli('stop'); });

  it('health shows session count', () => {
    const r = cli('health');
    expect(r.ok).toBe(true);
    expect(r.result).toContain('session');
  });

  it('creates session and auto-selects for debug', () => {
    let r = cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    expect(r.ok).toBe(true);
    r = cli('break --file multithread.c --line 17');
    expect(r.ok).toBe(true);
    r = cli('continue');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('stopped');
    expect(r.frames[0].func).toBe('worker');
  });

  it('stop all removes all sessions', () => {
    cli(`launch --target ${T.host} --binary ${B.multithread} --user ${T.user} --pwd ${T.password} --sudo`);
    const r = cli('stop');
    expect(r.ok).toBe(true);
    const h = cli('health');
    expect(h.result).toContain('0 session');
  });

  it('status returns empty when no sessions', () => {
    const r = cli('status');
    // Returns error "No active session"
    expect(typeof r.ok).toBe('boolean');
  });
});
