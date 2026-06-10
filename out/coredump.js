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
/** Analyze a core dump file with GDB. Pure local operation, no daemon needed. */
function analyzeCoredump(binary, core, gdbPath) {
    if (!fs.existsSync(core))
        return { ok: false, error: `Core file not found: ${core}` };
    if (!fs.existsSync(binary))
        return { ok: false, error: `Binary not found: ${binary}` };
    const gdb = gdbPath || findGdb();
    try {
        const out = (0, child_process_1.execSync)(`${gdb} --batch -nx --core="${core}" "${binary}" -ex "info threads" -ex "bt full" -ex "info registers" -ex "info sharedlibrary" 2>/dev/null`, { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
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
function parseGdbOutput(output) {
    const result = { ok: true };
    const lines = output.split('\n');
    // Extract signal info
    for (const line of lines) {
        const sigMatch = line.match(/signal\s+(\w+)/i);
        if (sigMatch) {
            result.signal = sigMatch[1];
            break;
        }
    }
    // Extract threads and backtraces
    const threads = [];
    let currentThread = null;
    let currentFrames = [];
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
        const regs = {};
        for (const line of regSection[1].split('\n')) {
            const m = line.match(/^(\w+)\s+(0x[0-9a-f]+)/);
            if (m)
                regs[m[1]] = m[2];
        }
        if (Object.keys(regs).length > 0)
            result.registers = regs;
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
