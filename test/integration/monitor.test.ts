import { REMOTE, BINARIES, cli } from '../setup';
import { execSync } from 'child_process';

const T = REMOTE;
const B = BINARIES;

beforeAll(() => { if (!cli('health').ok) throw new Error('Daemon not running'); });

describe('Process Monitoring', () => {
  it('stats returns process metrics', () => {
    const r = cli(`stats --pid 1 --target ${T.host} --user ${T.user} --pwd ${T.password}`);
    expect(r.ok).toBe(true);
    const stats = JSON.parse(r.result);
    expect(typeof stats.cpuPercent).toBe('number');
  });

  it('logs reads remote log file', () => {
    const r = cli(`logs --target ${T.host} --user ${T.user} --pwd ${T.password} --path /var/log/syslog --lines 2`);
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.result);
    expect(data.path).toBe('/var/log/syslog');
    expect(data.lines.length).toBe(2);
  });

  it('deploy copies file to remote', () => {
    execSync('touch /tmp/omnibreak-test-deploy.txt');
    const r = cli(`deploy --source /tmp/omnibreak-test-deploy.txt --target ${T.host} --dest /tmp/omnibreak-test-deploy.txt --user ${T.user} --pwd ${T.password}`);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('Deployed');
  });
});
