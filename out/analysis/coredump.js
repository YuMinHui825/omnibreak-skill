"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeCoredump = analyzeCoredump;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
// GDB batch mode does NOT echo `-ex` command text to stdout, so section-splitting on the
// command names ("info threads", "info registers", ...) never matched. Emit explicit echo
// markers between commands so each section is reliably extractable.
const SECTION_MARKERS = { THREADS: '@@THREADS@@', BT: '@@BT@@', REGISTERS: '@@REGISTERS@@', LIBS: '@@LIBS@@' };
/** Analyze a core dump file with GDB. Pure local operation, no daemon needed. */
function analyzeCoredump(binary, core, gdbPath) {
    if (!fs.existsSync(core))
        return { ok: false, error: `Core file not found: ${core}` };
    if (!fs.existsSync(binary))
        return { ok: false, error: `Binary not found: ${binary}` };
    const gdb = gdbPath || findGdb();
    try {
        const sections = [
            [SECTION_MARKERS.THREADS, 'info threads'],
            [SECTION_MARKERS.BT, 'thread apply all bt full'],
            [SECTION_MARKERS.REGISTERS, 'info registers'],
            [SECTION_MARKERS.LIBS, 'info sharedlibrary'],
        ];
        // -ex "echo \n@@NAME@@\n" → GDB echo interprets \n as newline, prints the marker on its own line.
        const exArgs = sections.flatMap(([marker, cmd]) => [
            `-ex "echo \\n${marker}\\n"`,
            `-ex "${cmd}"`,
        ]);
        const out = (0, child_process_1.execSync)(`${gdb} --batch -nx --core="${core}" "${binary}" ${exArgs.join(' ')} 2>/dev/null`, 
        // `thread apply all bt full` scales with thread count × stack depth — give it headroom.
        { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
        return parseGdbOutput(out);
    }
    catch (e) {
        // GDB may exit non-zero on real crashes, parse partial output
        if (e.stdout)
            return parseGdbOutput(String(e.stdout));
        return { ok: false, error: `GDB failed: ${e.message}` };
    }
}
function findGdb() {
    for (const g of ['gdb', 'gdb-multiarch', '/usr/bin/gdb', '/usr/bin/gdb-multiarch']) {
        try {
            (0, child_process_1.execSync)(`which ${g} 2>/dev/null`, { stdio: 'pipe' });
            return g;
        }
        catch { }
    }
    return 'gdb';
}
/** Extract the text GDB printed after a marker, up to the next marker (or end of output). */
function section(output, marker) {
    const re = new RegExp(`${marker}\\n([\\s\\S]*?)(?=@@[A-Z]+@@|$)`);
    const m = output.match(re);
    return m ? m[1] : '';
}
function parseGdbOutput(output) {
    const result = { ok: true };
    // Extract signal info (printed at core load, before any -ex output)
    const sigMatch = output.match(/signal\s+(\w+)/i);
    if (sigMatch)
        result.signal = sigMatch[1];
    const threadsSection = section(output, SECTION_MARKERS.THREADS);
    const btSection = section(output, SECTION_MARKERS.BT);
    const regSection = section(output, SECTION_MARKERS.REGISTERS);
    const libSection = section(output, SECTION_MARKERS.LIBS);
    // ── Thread list: "* 1    Thread 0x7ffff7fc1740 (LWP 999) "counter" 0x... in ..." ──
    // Thread ids are hex (0x…), so match word chars, not just digits.
    const threadList = [];
    for (const line of threadsSection.split('\n')) {
        const m = line.match(/^([\s\*]*)(\d+)\s+(Thread\s+[\w.]+)(?:\s+\(([^)]*)\))?/);
        if (!m)
            continue;
        const nameMatch = line.match(/"([^"]*)"/);
        threadList.push({ id: m[2], name: nameMatch ? nameMatch[1] : '', isCurrent: m[1].includes('*') });
    }
    // ── Backtraces per thread: "Thread 1 (Thread 0x… (LWP 999) "counter"):\n#0 …\n#1 …" ──
    const framesByThread = new Map();
    let btThreadId = null;
    for (const line of btSection.split('\n')) {
        const th = line.match(/^Thread\s+(\d+)\s+\(/);
        if (th) {
            btThreadId = th[1];
            if (!framesByThread.has(th[1]))
                framesByThread.set(th[1], []);
            continue;
        }
        const bt = line.match(/^#(\d+)\s+(?:0x[0-9a-f]+\s+in\s+)?(\S+)\s*(?:\(.*\))?\s*(?:at\s+(\S+):(\d+))?/);
        if (bt && btThreadId) {
            framesByThread.get(btThreadId).push({
                func: bt[2], file: bt[3] || '??', line: parseInt(bt[4]) || 0,
            });
        }
    }
    if (threadList.length > 0) {
        result.threads = threadList.map(t => ({ id: t.id, name: t.name, frames: framesByThread.get(t.id) || [] }));
        const current = threadList.find(t => t.isCurrent);
        result.crashingThread = (current || threadList[0]).id;
    }
    else if (framesByThread.size > 0) {
        // Fallback: no info-threads listing but backtraces present
        const first = framesByThread.entries().next().value;
        result.threads = [{ id: first[0], name: '', frames: first[1] }];
        result.crashingThread = first[0];
    }
    // ── Registers: "rax            0x0" / "rbx            0x7fffffffdc80" ──
    const regs = {};
    for (const line of regSection.split('\n')) {
        const m = line.match(/^(\w+)\s+(0x[0-9a-f]+)/);
        if (m)
            regs[m[1]] = m[2];
    }
    if (Object.keys(regs).length > 0)
        result.registers = regs;
    // ── Shared libraries: lines like "0x…  0x…  Yes (*)  /lib/…/libc.so.6" ──
    const libs = libSection.split('\n')
        .filter(l => l.includes('.so') && !/^\s*$/.test(l))
        .map(l => l.trim());
    if (libs.length > 0)
        result.sharedLibs = libs;
    return result;
}
