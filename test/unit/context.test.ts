import * as fs from 'fs';
import { SourceLine } from '../../src/shared/types';

function readSourceContext(file: string, line: number, n: number = 5): SourceLine[] {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, line - n);
    const end = Math.min(lines.length, line + n);
    const result: SourceLine[] = [];
    for (let i = start; i <= end; i++) {
      result.push({ line: i, code: lines[i - 1] || '', isTarget: i === line });
    }
    return result;
  } catch { return []; }
}

describe('readSourceContext', () => {
  const testFile = '/tmp/omnibreak-context-test.c';
  const source = [
    '#include <stdio.h>',     // line 1
    '',                        // line 2
    'int main() {',            // line 3
    '    int x = 0;',          // line 4
    '    printf("hello");',    // line 5
    '    x += 1;',             // line 6
    '    x += 2;',             // line 7
    '    printf("x=%d", x);',  // line 8
    '    return 0;',           // line 9
    '}',                       // line 10
  ];

  beforeAll(() => { fs.writeFileSync(testFile, source.join('\n')); });
  afterAll(() => { try { fs.unlinkSync(testFile); } catch {} });

  it('returns N lines around target', () => {
    const ctx = readSourceContext(testFile, 5, 2);
    expect(ctx.length).toBe(5); // lines 3-7
    expect(ctx[0]).toEqual({ line: 3, code: 'int main() {', isTarget: false });
    expect(ctx[2]).toEqual({ line: 5, code: '    printf("hello");', isTarget: true });
  });

  it('marks exactly one target line', () => {
    const ctx = readSourceContext(testFile, 8, 3);
    expect(ctx.filter(l => l.isTarget).length).toBe(1);
    expect(ctx.find(l => l.isTarget)!.line).toBe(8);
  });

  it('clamps to file start', () => {
    const ctx = readSourceContext(testFile, 1, 5);
    expect(ctx[0].line).toBe(1);
    expect(ctx.length).toBe(6);
  });

  it('clamps to file end', () => {
    const ctx = readSourceContext(testFile, 9, 2);
    expect(ctx[ctx.length - 1].line).toBe(10);
  });

  it('returns empty array for missing file', () => {
    expect(readSourceContext('/tmp/nonexistent-xyz.abc', 1, 3)).toEqual([]);
  });
});
