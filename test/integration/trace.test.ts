import { REMOTE, BINARIES, cli } from '../setup';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const T = REMOTE;
const B = BINARIES;

beforeAll(() => { if (!cli('health').ok) throw new Error('Daemon not running'); });

describe('Trace Capture', () => {
  it('captures system trace with summary', () => {
    const outFile = join(os.tmpdir(), `omnibreak-test-trace-${Date.now()}.pftrace`);
    const r = cli(`trace --target ${T.host} --user ${T.user} --pwd ${T.password} --duration 3 --output ${outFile} --sudo`);
    expect(r.ok).toBe(true);
    const result = JSON.parse(r.result);
    expect(result.sizeBytes).toBeGreaterThan(5000);
    expect(result.summary).toBeDefined();
    expect(fs.existsSync(outFile)).toBe(true);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  });

  it('captures trace with start-cmd', () => {
    const outFile = join(os.tmpdir(), `omnibreak-test-trace2-${Date.now()}.pftrace`);
    const r = cli(`trace --target ${T.host} --user ${T.user} --pwd ${T.password} --duration 5 --output ${outFile} --sudo --start-cmd "${B.multithread}"`);
    expect(r.ok).toBe(true);
    const result = JSON.parse(r.result);
    expect(result.sizeBytes).toBeGreaterThan(5000);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  });
});
