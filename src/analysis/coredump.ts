import { execSync } from 'child_process';
import * as fs from 'fs';

export interface CoredumpResult {
  ok: boolean;
  error?: string;
  signal?: string;
  faultAddr?: string;
  crashingThread?: string;
  threads?: { id: string; name: string; frames: { func: string; file: string; line: number }[] }[];
  registers?: Record<string, string>;
  sharedLibs?: string[];
}

/** Analyze a core dump file with GDB. Pure local operation, no daemon needed. */
export function analyzeCoredump(binary: string, core: string, gdbPath?: string): CoredumpResult {
  if (!fs.existsSync(core)) return { ok: false, error: `Core file not found: ${core}` };
  if (!fs.existsSync(binary)) return { ok: false, error: `Binary not found: ${binary}` };

  const gdb = gdbPath || findGdb();
  try {
    const out = execSync(
      `${gdb} --batch -nx --core="${core}" "${binary}" -ex "info threads" -ex "bt full" -ex "info registers" -ex "info sharedlibrary" 2>/dev/null`,
      { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseGdbOutput(out);
  } catch (e: any) {
    // GDB may exit non-zero on real crashes, parse partial output
    if (e.stdout) return parseGdbOutput(String(e.stdout));
    return { ok: false, error: `GDB failed: ${e.message}` };
  }
}

function findGdb(): string {
  for (const g of ['gdb', 'gdb-multiarch', '/usr/bin/gdb', '/usr/bin/gdb-multiarch']) {
    try { execSync(`which ${g} 2>/dev/null`, { stdio: 'pipe' }); return g; } catch {}
  }
  return 'gdb';
}

function parseGdbOutput(output: string): CoredumpResult {
  const result: CoredumpResult = { ok: true };
  const lines = output.split('\n');

  // Extract signal info
  for (const line of lines) {
    const sigMatch = line.match(/signal\s+(\w+)/i);
    if (sigMatch) { result.signal = sigMatch[1]; break; }
  }

  // Extract threads and backtraces
  const threads: CoredumpResult['threads'] = [];
  let currentThread: string | null = null;
  let currentFrames: { func: string; file: string; line: number }[] = [];
  let inBt = false;

  for (const line of lines) {
    // Thread marker: "  Id   Target Id         Frame" or "* 1    Thread ..."
    const threadStart = line.match(/^[\s\*]*(\d+)\s+(Thread\s+[\d.]+)\s/);
    if (threadStart && !inBt) {
      if (currentThread && currentFrames.length > 0) {
        threads.push({ id: currentThread, name: threadStart[2], frames: currentFrames });
      }
      currentThread = threadStart[1];
      currentFrames = [];
      continue;
    }

    // Backtrace frame: "#0  func (args...) at file:line" or "#0  0xaddr in func ()"
    const btLine = line.match(/^#(\d+)\s+(?:0x[0-9a-f]+\s+in\s+)?(\S+)\s*(?:\(.*\))?\s*(?:at\s+(\S+):(\d+))?/);
    if (btLine) {
      inBt = true;
      currentFrames.push({
        func: btLine[2],
        file: btLine[3] || '??',
        line: parseInt(btLine[4]) || 0,
      });
      continue;
    }

    // End of backtrace (blank line or next thread)
    if (inBt && line.trim() === '') {
      inBt = false;
    }
  }
  // Save last thread
  if (currentThread && currentFrames.length > 0) {
    threads.push({ id: currentThread, name: '', frames: currentFrames });
  }
  if (threads.length > 0) {
    result.threads = threads;
    result.crashingThread = threads[0].id;
  }

  // Extract registers
  const regSection = output.match(/info registers\n([\s\S]*?)(?:\n\n|\n$)/);
  if (regSection) {
    const regs: Record<string, string> = {};
    for (const line of regSection[1].split('\n')) {
      const m = line.match(/^(\w+)\s+(0x[0-9a-f]+)/);
      if (m) regs[m[1]] = m[2];
    }
    if (Object.keys(regs).length > 0) result.registers = regs;
  }

  // Extract shared libraries
  const libSection = output.match(/info sharedlibrary\n([\s\S]*?)(?:\n\n|\n$)/);
  if (libSection) {
    result.sharedLibs = libSection[1].split('\n')
      .filter(l => l.trim() && !l.startsWith('From') && !l.startsWith('No'))
      .map(l => l.trim());
  }

  return result;
}
