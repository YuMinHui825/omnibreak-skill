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
    // Retry up to 2 times — remote tracebox may need first-run download
    let r: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = cli(`trace --target ${T.host} --user ${T.user} --pwd ${T.password} --duration 3 --output ${outFile} --sudo --sudo-pwd ${T.password}`);
      if (r.ok) {
        const result = JSON.parse(r.result);
        if (result.sizeBytes > 5000) break;
      }
      if (attempt < 1) execSync('sleep 2');
    }
    expect(r.ok).toBe(true);
    const result = JSON.parse(r.result);
    expect(result.sizeBytes).toBeGreaterThan(5000);
    expect(result.summary).toBeDefined();
    expect(result.narrative).toBeDefined();
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(50);
    expect(fs.existsSync(outFile)).toBe(true);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }, 120000);

  it('captures trace with start-cmd', () => {
    const outFile = join(os.tmpdir(), `omnibreak-test-trace2-${Date.now()}.pftrace`);
    let r: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = cli(`trace --target ${T.host} --user ${T.user} --pwd ${T.password} --duration 5 --output ${outFile} --sudo --sudo-pwd ${T.password} --start-cmd "${B.multithread}"`);
      if (r.ok) {
        const result = JSON.parse(r.result);
        if (result.sizeBytes > 5000) break;
      }
      if (attempt < 1) execSync('sleep 2');
    }
    expect(r.ok).toBe(true);
    const result = JSON.parse(r.result);
    expect(result.sizeBytes).toBeGreaterThan(5000);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }, 120000);
});
