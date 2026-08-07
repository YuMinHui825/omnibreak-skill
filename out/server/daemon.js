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
const http = __importStar(require("http"));
const client_1 = require("../debug/client");
const parser_1 = require("../debug/parser");
const mapper_1 = require("../debug/mapper");
const types_1 = require("../shared/types");
const transport_1 = require("../transport/transport");
const trace_1 = require("../trace/trace");
const PORT = 49200;
let sessionCounter = 0;
const sessions = new Map();
let lastId = null;
function esc(s) { return s.replace(/'/g, "'\\''"); }
function ok(data) { return { ok: true, ...data }; }
function fail(msg, code, hint) {
    return { ok: false, error: msg, code, hint };
}
function getSession(id) {
    if (id)
        return sessions.get(id) || null;
    if (lastId)
        return sessions.get(lastId) || null;
    return null;
}
/** Build transport from target string. Default: SSH transport (backward compatible). */
function getTransport(data) {
    const sshPort = data.sshPort ? parseInt(data.sshPort) : 22;
    const cfg = (0, transport_1.parseTarget)(data.target || 'local', data.user || 'root', data.pwd, sshPort);
    return (0, transport_1.createTransport)(cfg);
}
async function waitForPort(t, port, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const out = await t.exec(`ss -tlnp 2>/dev/null | grep ':${port}' || netstat -tlnp 2>/dev/null | grep ':${port}' || echo ''`);
            if (out.trim())
                return;
        }
        catch { }
        await new Promise(r => setTimeout(r, 200));
    }
}
/** Quote a string as a GDB/MI c-string literal. */
function miQuote(s) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/**
 * Kill the gdbserver bound to `port` on the target. Uses `pkill` (procps, ships with `ps`
 * on every distro) instead of `fuser -k` (psmisc), which is absent on minimal targets.
 * Runs via execSafe (base64) so `$()` / `$` aren't re-expanded by the SSH shell wrapper,
 * and the `[r]` self-match guard stops pkill from killing this shell's own command line.
 */
async function killGdbserverOnPort(t, port, sudo) {
    const p = typeof port === 'number' ? port : parseInt(String(port)) || 2345;
    const cmd = `${sudo}pkill -f 'gdbserve[r].*:${p}([^0-9]|$)' 2>/dev/null || true`;
    try {
        if (t.execSafe)
            await t.execSafe(cmd);
        else
            await t.exec(cmd);
    }
    catch { }
}
async function handleLaunch(body) {
    const t = getTransport(body);
    const port = body.port || 2345;
    if (body.deploySource) {
        (0, types_1.log)('info', `Deploying ${body.deploySource} → ${body.target}:${body.binary}`);
        await t.deployFile(body.deploySource, body.binary);
    }
    // Start gdbserver — kill only our own port, not all gdbservers
    const isLocal = body.target === 'local';
    const sudo = body.sudo ? 'sudo ' : '';
    const gdbserverBin = body.gdbserverPath || 'gdbserver';
    await killGdbserverOnPort(t, port, sudo);
    // Build sanitizer env vars
    const sanitizeEnv = [];
    if (body.asan)
        sanitizeEnv.push('ASAN_OPTIONS=halt_on_error=0:abort_on_error=1:log_path=/tmp/omnibreak_asan');
    if (body.ubsan)
        sanitizeEnv.push('UBSAN_OPTIONS=halt_on_error=0:print_stacktrace=1:log_path=/tmp/omnibreak_ubsan');
    if (body.tsan)
        sanitizeEnv.push('TSAN_OPTIONS=halt_on_error=0:history_size=7:log_path=/tmp/omnibreak_tsan');
    const sanEnv = sanitizeEnv.length > 0 ? sanitizeEnv.join(' ') + ' ' : '';
    if (!body.skipGdbserver) {
        if (isLocal) {
            await t.exec(`rm -f /tmp/omnibreak_output.log; ${sanEnv}nohup ${sudo}${gdbserverBin} --multi :${port} >/tmp/omnibreak_output.log 2>&1 &`);
        }
        else {
            // env vars go before setsid+stdbuf, not between stdbuf and gdbserver
            await t.exec(`rm -f /tmp/omnibreak_output.log; ${sanEnv}setsid stdbuf -o0 ${sudo}${gdbserverBin} --multi :${port} >/tmp/omnibreak_output.log 2>&1 &`);
        }
        // Poll for port readiness instead of fixed 1.5s sleep
        await waitForPort(t, port, 5000);
    }
    // GDB still uses SSH for remote targets; local targets spawn GDB directly
    const id = String(++sessionCounter);
    const mapper = new mapper_1.SourceMapper(body.sourceMap || {});
    const gdb = new client_1.GdbMiClient({
        gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch',
        sshRemote: body.target === 'local' ? undefined : { host: body.target, user: body.user || 'root', port: 22, password: body.pwd },
    });
    await gdb.init();
    await gdb.sendCommand(body.nonStop ? '-gdb-set non-stop on' : '-gdb-set non-stop off');
    await gdb.sendCommand(`-file-exec-and-symbols ${miQuote(body.binary)}`);
    await gdb.sendCommand(`-interpreter-exec console ${miQuote(`set remote exec-file ${body.binary}`)}`);
    await gdb.sendCommand(`-target-select extended-remote localhost:${port}`);
    // Env vars + argv — set before the inferior starts (applies on the first -exec-run)
    for (const envVar of body.env || []) {
        const eq = String(envVar).indexOf('=');
        if (eq <= 0)
            continue;
        const setEnv = `set environment ${String(envVar).substring(0, eq)} ${String(envVar).substring(eq + 1)}`;
        await gdb.sendCommand(`-interpreter-exec console ${miQuote(setEnv)}`).catch(() => { });
    }
    if (body.args && body.args.length > 0) {
        await gdb.sendCommand(`-exec-arguments ${body.args.map((a) => miQuote(a)).join(' ')}`).catch(() => { });
    }
    const session = { id, gdb, mapper, firstContinue: true, target: body.target, binary: body.binary, transport: t, port, sudo: !!body.sudo, startedGdbserver: !body.skipGdbserver };
    sessions.set(id, session);
    lastId = id;
    await new Promise(resolve => {
        const onStop = (_data) => { resolve(); gdb.removeListener('stopped', onStop); };
        gdb.on('stopped', onStop);
        setTimeout(() => { gdb.removeListener('stopped', onStop); resolve(); }, 5000);
    });
    await new Promise(r => setTimeout(r, 300));
    return await handleStatusById(session);
}
async function handleAttach(body) {
    const t = getTransport(body);
    const port = body.port || 2345;
    let pid = String(body.pid || '');
    if (!pid && body.processName) {
        pid = (await t.exec(`pgrep -f '${esc(body.processName)}' | head -1`)).trim();
    }
    if (!pid)
        return fail('Process not found', 'SESSION');
    if (body.deploySource)
        await t.deployFile(body.deploySource, body.binary);
    const isLocal = body.target === 'local';
    const sudo = body.sudo ? 'sudo ' : '';
    const gdbserverBin = body.gdbserverPath || 'gdbserver';
    await killGdbserverOnPort(t, port, sudo);
    if (isLocal) {
        await t.exec(`${sudo}${gdbserverBin} --attach :${port} ${pid} &`);
    }
    else {
        await t.exec(`setsid stdbuf -o0 ${sudo}${gdbserverBin} --attach :${port} ${pid} >/tmp/omnibreak_output.log 2>&1 &`);
    }
    // Poll for port readiness instead of fixed sleep
    await waitForPort(t, port, 5000);
    const id = String(++sessionCounter);
    const mapper = new mapper_1.SourceMapper(body.sourceMap || {});
    const gdb = new client_1.GdbMiClient({
        gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch',
        sshRemote: body.target === 'local' ? undefined : { host: body.target, user: body.user || 'root', port: 22, password: body.pwd },
    });
    await gdb.init();
    if (body.solibPath)
        await gdb.sendCommand(`-interpreter-exec console ${miQuote(`set solib-search-path ${body.solibPath}`)}`);
    if (body.binary)
        await gdb.sendCommand(`-file-exec-and-symbols ${miQuote(body.binary)}`);
    await gdb.sendCommand(`-target-select extended-remote localhost:${port}`);
    const session = { id, gdb, mapper, firstContinue: false, target: body.target, binary: body.binary || '', transport: t, port, sudo: !!body.sudo, startedGdbserver: true };
    sessions.set(id, session);
    lastId = id;
    return await handleStatusById(session);
}
async function handleStop(sessionId) {
    // stop previously left the target-side gdbserver running, so the port stayed bound and
    // consecutive launch/stop cycles collided. Kill the gdbserver we started for this session.
    const killGdbserver = async (s) => {
        if (!s.startedGdbserver)
            return;
        const sudo = s.sudo ? 'sudo ' : '';
        await killGdbserverOnPort(s.transport, s.port, sudo);
    };
    if (sessionId) {
        const s = sessions.get(sessionId);
        if (s) {
            await s.gdb.terminate();
            await killGdbserver(s);
            sessions.delete(sessionId);
        }
        if (lastId === sessionId)
            lastId = null;
        return ok();
    }
    for (const [id, s] of sessions) {
        try {
            await s.gdb.terminate();
        }
        catch { }
        await killGdbserver(s);
        sessions.delete(id);
    }
    lastId = null;
    return ok();
}
function requireSession(sid) {
    const s = getSession(sid);
    if (!s)
        throw new Error('No active session. Use launch or attach first.');
    return s;
}
async function handleBreak(sid, file, line, condition) {
    const s = requireSession(sid);
    try {
        await s.gdb.sendCommand('-gdb-set breakpoint pending on').catch(() => { });
        const loc = `-f ${file}:${line}`;
        // GDB/MI requires `-c condition` BEFORE the location; the old order made GDB report
        // "Garbage following <location>". The condition must be a proper MI c-string.
        const cmd = condition ? `-break-insert -c ${miQuote(condition)} ${loc}` : `-break-insert ${loc}`;
        const result = await s.gdb.sendCommand(cmd);
        const info = (0, parser_1.parseBreakpoint)(result.data);
        return ok({ breakpoints: [{ id: parseInt(info.number || '0'), file, line, verified: true }] });
    }
    catch (e) {
        return fail(`Breakpoint failed: ${e.message}`);
    }
}
function waitForStop(s, timeoutMs = 10000) {
    return new Promise(resolve => {
        const onStop = () => { resolve(); s.gdb.removeListener('stopped', onStop); };
        s.gdb.on('stopped', onStop);
        setTimeout(() => { s.gdb.removeListener('stopped', onStop); resolve(); }, timeoutMs);
    });
}
async function handleContinue(sid) {
    const s = requireSession(sid);
    if (s.firstContinue) {
        s.firstContinue = false;
        await s.gdb.sendCommand('-exec-run');
        await waitForStop(s);
        await new Promise(r => setTimeout(r, 300));
        return await handleStatusById(s);
    }
    await s.gdb.sendCommand('-exec-continue');
    await waitForStop(s);
    await new Promise(r => setTimeout(r, 300));
    return await handleStatusById(s);
}
async function handleNext(sid) {
    const s = requireSession(sid);
    await s.gdb.sendCommand('-exec-next');
    await waitForStop(s);
    await new Promise(r => setTimeout(r, 300));
    return await handleStatusById(s);
}
async function handleStep(sid) {
    const s = requireSession(sid);
    await s.gdb.sendCommand('-exec-step');
    await waitForStop(s);
    await new Promise(r => setTimeout(r, 300));
    return await handleStatusById(s);
}
async function handleWatch(sid, expr, type) {
    const s = requireSession(sid);
    try {
        let cmd = '-break-watch';
        if (type === 'read')
            cmd += ' -r';
        else if (type === 'access')
            cmd += ' -a';
        // -break-watch takes exactly ONE expression argument — quote it so expressions with
        // spaces (e.g. `i + 1`) survive MI tokenization instead of failing with "Unknown argument".
        const result = await s.gdb.sendCommand(`${cmd} ${miQuote(expr)}`);
        // -break-watch replies with `wpt={...}` (number/exp/type), not `bkpt={...}`
        const info = (0, parser_1.parseWatchpoint)(result.data);
        const watchType = type === 'read' ? 'read' : type === 'access' ? 'access' : 'write';
        // Only claim verified when GDB actually returned a watchpoint number — otherwise id falls
        // back to 0 and we'd reproduce the "fake success" the old handler emitted.
        return ok({ watchpoints: [{ id: parseInt(info.number || '0'), expr: info.exp || expr, type: watchType, verified: !!info.number }] });
    }
    catch (e) {
        return fail(`Watchpoint failed: ${e.message}`);
    }
}
/** Read N lines of source context around a target line. Tries local fs first, falls back to remote. */
async function readSourceContext(file, line, n = 5, t) {
    // Try local file first
    try {
        const content = require('fs').readFileSync(file, 'utf8');
        return parseContext(content, file, line, n);
    }
    catch { }
    // Fall back to remote via transport
    if (t && t.execSafe && file) {
        try {
            const content = await t.execSafe(`cat '${file.replace(/'/g, "'\\''")}' 2>/dev/null || echo ''`);
            if (content.trim())
                return parseContext(content, file, line, n);
        }
        catch { }
    }
    return [];
}
function parseContext(content, _file, line, n) {
    const lines = content.split('\n');
    const start = Math.max(1, line - n);
    const end = Math.min(lines.length, line + n);
    const result = [];
    for (let i = start; i <= end; i++) {
        result.push({ line: i, code: lines[i - 1] || '', isTarget: i === line });
    }
    return result;
}
async function handleStatusById(s) {
    try {
        const out = { ok: true, status: 'stopped' };
        const threads = await s.gdb.sendCommand('-thread-info');
        const tinfo = (0, parser_1.parseThreadInfo)(threads.data).map(t => ({
            id: parseInt(t.id), name: t.name, state: t.state
        }));
        out.threads = tinfo;
        if (tinfo.length > 0)
            out.threadId = tinfo[0].id;
        try {
            const frames = await s.gdb.sendCommand('-stack-list-frames 0 20');
            const finfo = (0, parser_1.parseFrames)(frames.data).map(f => ({
                level: parseInt(f['level'] || '0'), func: f['func'] || '??',
                file: s.mapper.compileToLocal(f['fullname'] || f['file'] || ''),
                line: parseInt(f['line'] || '0')
            }));
            out.frames = finfo;
            if (finfo.length > 0) {
                out.file = finfo[0].file;
                out.line = finfo[0].line;
                out.context = await readSourceContext(finfo[0].file, finfo[0].line, 5, s.transport);
            }
        }
        catch { }
        try {
            const vars = await s.gdb.sendCommand('-stack-list-variables --simple-values');
            out.vars = (0, parser_1.parseVariables)(vars.data).map(v => ({ name: v['name'] || '??', value: v['value'] || '' }));
        }
        catch { }
        return out;
    }
    catch (e) {
        return fail(`Status: ${e.message}`);
    }
}
async function handleStatus(sid) {
    const s = getSession(sid);
    if (!s) {
        if (sessions.size === 0)
            return fail('No active session', 'SESSION');
        const list = Array.from(sessions.values()).map(s => ({
            id: s.id, target: s.target, binary: s.binary,
        }));
        return ok({ result: JSON.stringify({ sessions: list, activeCount: sessions.size }) });
    }
    return await handleStatusById(s);
}
async function handleCrash(sid) {
    const s = requireSession(sid);
    const frames = await s.gdb.sendCommand('-stack-list-frames 0 500');
    const finfo = (0, parser_1.parseFrames)(frames.data).map(f => ({
        level: parseInt(f['level'] || '0'), func: f['func'] || '??',
        file: s.mapper.compileToLocal(f['fullname'] || f['file'] || ''),
        line: parseInt(f['line'] || '0')
    }));
    const top = finfo[0];
    return ok({ status: 'stopped', reason: 'signal-received', frames: finfo,
        file: top?.file, line: top?.line,
        context: top ? await readSourceContext(top.file, top.line, 5, s.transport) : undefined });
}
async function handleEval(sid, expr) {
    const s = requireSession(sid);
    const result = await s.gdb.sendCommand(`-data-evaluate-expression ${miQuote(expr)}`);
    const value = (0, parser_1.extractMiString)(result.data, 'value');
    return ok({ result: value !== undefined ? value : result.data });
}
async function handleGdbRaw(sid, cmd) {
    const s = requireSession(sid);
    const result = await s.gdb.sendCommand(cmd);
    return ok({ result: result.data });
}
// ═══ Transport-backed handlers (logs, stats, leaks, trace) ═══
async function handleLogs(data) {
    const t = getTransport(data);
    const path = data.path;
    if (!path)
        return fail('Log path required', 'SESSION');
    try {
        const lines = data.tail ? 50 : (parseInt(data.lines) || 100);
        const out = await t.exec(`tail -n ${lines} '${esc(path)}' 2>/dev/null || echo LOG_NOT_FOUND`);
        if (out.includes('LOG_NOT_FOUND'))
            return fail(`Log file not found: ${path}`);
        const logLines = out.trim().split('\n');
        // If --tail mode, also include active session info for correlation
        const activeList = Array.from(sessions.values()).map(s => ({
            id: s.id, target: s.target, binary: s.binary,
        }));
        return ok({ result: JSON.stringify({ path, lines: logLines, activeSessions: activeList }) });
    }
    catch (e) {
        return fail(`Logs failed: ${e.message}`);
    }
}
async function handleTraceCapture(data) {
    // trace capture only works with SSH transport (needs SCP + remote tracebox)
    if (data.target === 'local')
        return fail('Trace capture requires SSH target', 'CONNECTION');
    // traceCapture expects SshConfig from ssh.ts — pass compatible config
    const c = { host: data.target, user: data.user || 'root', port: 22, password: data.pwd };
    const durationSec = parseInt(data.duration) || 10;
    const outputPath = data.output || './trace.pftrace';
    if (!data.target)
        return fail('Target host required', 'CONNECTION');
    try {
        const result = (0, trace_1.traceCapture)(c, {
            durationSec, outputPath,
            events: data.events || undefined,
            sudo: !!data.sudo,
            sudoPwd: data.sudoPwd || data.pwd,
            startCmd: data.startCmd,
            heapProfile: data.heapProfile,
        });
        return ok({ result: JSON.stringify(result) });
    }
    catch (e) {
        return fail(`Trace capture failed: ${e.message}`);
    }
}
async function handleStats(data) {
    const t = getTransport(data);
    const pid = parseInt(data.pid) || 0;
    if (!pid)
        return fail('PID required', 'SESSION');
    try {
        const out = (await t.exec(`ps -p ${pid} -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo '0 0 0 0 ?'`)).trim();
        const vals = out.split(/\s+/);
        const rssKB = parseInt(vals[1]) || 0;
        const result = {
            pid, cpuPercent: parseFloat(vals[0]) || 0,
            rssMB: Math.round(rssKB / 1024 * 10) / 10,
            vszMB: Math.round((parseInt(vals[2]) || 0) / 1024),
            threadCount: parseInt(vals[3]) || 0,
            state: vals[4] || '?',
        };
        return ok({ result: JSON.stringify(result) });
    }
    catch (e) {
        return fail(`Stats failed: ${e.message}`);
    }
}
async function handleLeaks(data) {
    const t = getTransport(data);
    const pid = parseInt(data.pid) || 0;
    if (!pid)
        return fail('PID required', 'SESSION');
    try {
        const smaps = await t.exec(`cat /proc/${pid}/smaps 2>/dev/null`);
        const status = await t.exec(`grep -E '^(Vm|Rss)' /proc/${pid}/status 2>/dev/null`);
        const st = {};
        status.split('\n').forEach(line => {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (m)
                st[m[1].toLowerCase()] = parseInt(m[2]);
        });
        let heapKB = 0, stackKB = 0, curAddr = '', curSize = 0;
        smaps.split('\n').forEach(line => {
            const am = line.match(/^([0-9a-f]+)-/);
            if (am) {
                if (curAddr.includes('[heap]'))
                    heapKB += curSize;
                if (curAddr.includes('[stack]'))
                    stackKB += curSize;
                curAddr = line;
                curSize = 0;
            }
            const sm = line.match(/^Size:\s+(\d+)/);
            if (sm)
                curSize = parseInt(sm[1]);
        });
        if (curAddr.includes('[heap]'))
            heapKB += curSize;
        if (curAddr.includes('[stack]'))
            stackKB += curSize;
        const sampleFile = `/tmp/omnibreak-leak-${pid}.json`;
        let samples = [];
        try {
            samples = JSON.parse((await t.exec(`cat ${sampleFile} 2>/dev/null || echo '[]'`)).trim());
        }
        catch { }
        if (!Array.isArray(samples))
            samples = [];
        samples.push(heapKB);
        if (samples.length > 60)
            samples = samples.slice(-60);
        await t.exec(`printf '%s' '${JSON.stringify(samples).replace(/'/g, "'\\''")}' > ${sampleFile}`);
        let risk = 'none';
        if (samples.length >= 10) {
            const n = samples.length;
            const firstQ = samples.slice(0, Math.floor(n / 4)).reduce((a, b) => a + b, 0) / Math.floor(n / 4);
            const lastQ = samples.slice(-Math.floor(n / 4)).reduce((a, b) => a + b, 0) / Math.floor(n / 4);
            const growth = lastQ - firstQ;
            let growing = 0;
            for (let i = 1; i < n; i++)
                if (samples[i] > samples[0])
                    growing++;
            const growthRatio = growing / (n - 1);
            if (growth > 128 && growthRatio > 0.7)
                risk = 'high';
            else if (growth > 64 && growthRatio > 0.5)
                risk = 'medium';
            else if (growth > 0 && growthRatio > 0.4)
                risk = 'low';
        }
        const result = {
            pid, heapKB, stackKB,
            dataKB: (st.vmdata || 0), rssKB: (st.vmrss || 0), vszKB: (st.vmsize || 0),
            heapDeltaKB: samples.length > 1 ? heapKB - samples[0] : 0,
            risk, sampleCount: samples.length,
        };
        return ok({ result: JSON.stringify(result) });
    }
    catch (e) {
        return fail(`Leak scan failed: ${e.message}`);
    }
}
async function takeSnapshot(t, pid) {
    const out = (await t.exec(`ps -p ${pid} -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo '0 0 0 0 ?'`)).trim();
    const vals = out.split(/\s+/);
    const rssKB = parseInt(vals[1]) || 0;
    return {
        timestamp: Date.now(),
        cpuPercent: parseFloat(vals[0]) || 0,
        rssMB: Math.round(rssKB / 1024 * 10) / 10,
        vszMB: Math.round((parseInt(vals[2]) || 0) / 1024),
        threadCount: parseInt(vals[3]) || 0,
        state: vals[4] || '?',
    };
}
function parseSanitizerOutput(log) {
    const findings = [];
    const lines = log.split('\n');
    let current = null;
    let tool = '';
    for (const l of lines) {
        // Detect sanitizer type
        if (l.includes('AddressSanitizer') || l.includes('LeakSanitizer'))
            tool = 'asan';
        else if (l.includes('UndefinedBehaviorSanitizer'))
            tool = 'ubsan';
        else if (l.includes('ThreadSanitizer'))
            tool = 'tsan';
        // Start of error
        const errMatch = l.match(/==\d+==(ERROR|WARNING):\s*(.+)/);
        if (errMatch) {
            if (current)
                findings.push(current);
            current = { type: errMatch[1], tool, message: errMatch[2], frames: [] };
            continue;
        }
        // Stack frame
        const frameMatch = l.match(/^\s*#(\d+)\s+0x[0-9a-f]+\s+in\s+(\S+)\s*(.+)?/);
        if (frameMatch && current) {
            const loc = (frameMatch[3] || '').trim();
            const fileMatch = loc.match(/(.+):(\d+)/);
            if (fileMatch && !current.file) {
                current.file = fileMatch[1];
                current.line = parseInt(fileMatch[2]);
                current.func = frameMatch[2];
            }
            current.frames.push(`${frameMatch[2]} ${loc}`.trim());
            continue;
        }
        // Summary line with location
        if (current && !current.file) {
            const sm = l.match(/SUMMARY:.*in\s+(\S+)\s+(.+):(\d+)/);
            if (sm) {
                current.func = sm[1];
                current.file = sm[2];
                current.line = parseInt(sm[3]);
            }
        }
    }
    if (current)
        findings.push(current);
    return findings;
}
async function handleSanitize(data) {
    const sid = data.session;
    // Read remote gdbserver output log + any sanitizer log files
    try {
        let log = '';
        if (data.target) {
            const rt = getTransport(data);
            log = await rt.exec('cat /tmp/omnibreak_output.log 2>/dev/null || echo ""');
            // Also read ASan/UBSan/TSan log files
            for (const prefix of ['omnibreak_asan', 'omnibreak_ubsan', 'omnibreak_tsan']) {
                try {
                    log += '\n' + await rt.exec(`cat /tmp/${prefix}.* 2>/dev/null || echo ""`);
                }
                catch { }
            }
        }
        else if (sid) {
            const s = getSession(sid);
            if (s && s.transport && s.transport.exec) {
                log = await s.transport.exec('cat /tmp/omnibreak_output.log 2>/dev/null || echo ""');
                for (const prefix of ['omnibreak_asan', 'omnibreak_ubsan', 'omnibreak_tsan']) {
                    try {
                        log += '\n' + await s.transport.exec(`cat /tmp/${prefix}.* 2>/dev/null || echo ""`);
                    }
                    catch { }
                }
            }
        }
        if (!log.trim())
            return ok({ result: JSON.stringify({ findings: [], hint: 'No sanitizer output found. Compile with -fsanitize=address,undefined,thread and re-run.' }) });
        const findings = parseSanitizerOutput(log);
        return ok({ result: JSON.stringify({ findings, count: findings.length }) });
    }
    catch (e) {
        return fail(`Sanitizer check failed: ${e.message}`);
    }
}
async function handleDiff(data) {
    const t = getTransport(data);
    const pid = parseInt(data.pid) || 0;
    if (!pid)
        return fail('PID required', 'SESSION');
    try {
        const before = await takeSnapshot(t, pid);
        const waitMs = parseInt(data.wait) || 5000;
        await new Promise(r => setTimeout(r, waitMs));
        const after = await takeSnapshot(t, pid);
        const result = {
            elapsedMs: waitMs,
            before, after,
            delta: {
                cpuPercent: Math.round((after.cpuPercent - before.cpuPercent) * 10) / 10,
                rssMB: Math.round((after.rssMB - before.rssMB) * 10) / 10,
                vszMB: after.vszMB - before.vszMB,
                threadCount: after.threadCount - before.threadCount,
            },
        };
        return ok({ result: JSON.stringify(result) });
    }
    catch (e) {
        return fail(`Diff failed: ${e.message}`);
    }
}
async function handleReport(data) {
    const sid = data.session;
    const s = getSession(sid);
    if (!s)
        return fail('No active session. Use launch or attach first.', 'SESSION');
    let status = { ok: true };
    try {
        status = await handleStatusById(s);
    }
    catch { }
    // Gather metrics if target is remote
    let statsBefore = null, leaksResult = null;
    if (s.transport && s.target !== 'local') {
        try {
            // Try to get process stats (use ps to find the binary)
            const pgrep = await s.transport.exec(`pgrep -f '${s.binary.replace(/'/g, "'\\''")}' 2>/dev/null | head -1 || echo '0'`);
            const pid = parseInt(pgrep.trim());
            if (pid > 0) {
                const statsOut = await s.transport.exec(`ps -p ${pid} -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo '0 0 0 0 ?'`);
                const v = statsOut.trim().split(/\s+/);
                statsBefore = {
                    cpuPercent: parseFloat(v[0]) || 0,
                    rssMB: Math.round((parseInt(v[1]) || 0) / 1024 * 10) / 10,
                    vszMB: Math.round((parseInt(v[2]) || 0) / 1024),
                    threadCount: parseInt(v[3]) || 0,
                    state: v[4] || '?',
                };
                // Also check for leaks
                try {
                    const leakOut = await s.transport.exec(`cat /tmp/omnibreak-leak-${pid}.json 2>/dev/null || echo '[]'`);
                    const samples = JSON.parse(leakOut.trim() || '[]');
                    if (Array.isArray(samples) && samples.length > 1) {
                        const last = samples[samples.length - 1];
                        const first = samples[0];
                        leaksResult = {
                            heapKBLatest: last / 1024,
                            heapDeltaMB: Math.round((last - first) / 1024 * 10) / 10,
                            sampleCount: samples.length,
                            risk: last > first * 1.5 ? 'high' : last > first * 1.2 ? 'medium' : last > first ? 'low' : 'none',
                        };
                    }
                }
                catch { }
            }
        }
        catch { }
    }
    const report = {
        generatedAt: new Date().toISOString(),
        session: { id: s.id, target: s.target, binary: s.binary },
        crash: {
            file: status.file, line: status.line,
            frames: (status.frames || []).slice(0, 5),
            context: status.context,
        },
        stats: statsBefore,
        leaks: leaksResult,
        vars: status.vars,
        diagnostics: {
            sanitizer: null,
        },
    };
    // Try to get sanitizer findings
    try {
        if (s.transport && s.transport.execSafe && s.target !== 'local') {
            const sanLog = await s.transport.execSafe('cat /tmp/omnibreak_output.log 2>/dev/null || echo ""');
            if (sanLog.includes('Sanitizer') || sanLog.includes('ERROR')) {
                report.diagnostics.sanitizer = parseSanitizerOutput(sanLog);
            }
        }
    }
    catch { }
    // Generate markdown report
    const md = formatDiagnosticReport(report);
    return ok({ result: JSON.stringify({ ...report, markdown: md }) });
}
function formatDiagnosticReport(r) {
    const lines = [
        '=== OmniBreak Diagnostic Report ===',
        `Generated: ${r.generatedAt}`,
        `Target: ${r.session.target} | Binary: ${r.session.binary} | Session: ${r.session.id}`,
        '',
    ];
    if (r.crash.file) {
        lines.push(`**Crash Location:** ${r.crash.file}:${r.crash.line}`);
        lines.push('');
        if (r.crash.frames && r.crash.frames.length > 0) {
            lines.push('**Backtrace:**');
            r.crash.frames.forEach((f) => lines.push(`  #${f.level} ${f.func} at ${f.file}:${f.line}`));
            lines.push('');
        }
        if (r.crash.context && r.crash.context.length > 0) {
            lines.push('**Source Context:**');
            lines.push('```c');
            r.crash.context.forEach((l) => lines.push(`${l.isTarget ? '> ' : '  '}${l.line}: ${l.code}`));
            lines.push('```');
            lines.push('');
        }
    }
    if (r.vars && r.vars.length > 0) {
        lines.push('**Variables:**');
        r.vars.forEach((v) => lines.push(`  ${v.name} = ${v.value}`));
        lines.push('');
    }
    if (r.stats) {
        lines.push(`**Process Stats:** CPU ${r.stats.cpuPercent}% | RSS ${r.stats.rssMB}MB | VSZ ${r.stats.vszMB}MB | Threads ${r.stats.threadCount} | State ${r.stats.state}`);
        lines.push('');
    }
    if (r.leaks) {
        lines.push(`**Memory Leak:** ${r.leaks.risk.toUpperCase()} risk | Heap ${r.leaks.heapKBLatest}KB | Delta ${r.leaks.heapDeltaMB}MB over ${r.leaks.sampleCount} samples`);
        lines.push('');
    }
    if (r.diagnostics.sanitizer && r.diagnostics.sanitizer.length > 0) {
        lines.push('**Sanitizer Findings:**');
        r.diagnostics.sanitizer.forEach((f) => {
            lines.push(`  [${f.tool.toUpperCase()}] ${f.type}: ${f.message}`);
            if (f.file)
                lines.push(`    at ${f.func} (${f.file}:${f.line})`);
        });
        lines.push('');
    }
    lines.push('**Status:** 🐛 Needs Investigation');
    lines.push('');
    lines.push('---');
    lines.push('Generated by OmniBreak Skill — AI writes the code. OmniBreak makes it work.');
    return lines.join('\n');
}
// ═══ HTTP SERVER ═══
if (require.main === module) {
    const server = http.createServer(async (req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let result = { ok: false, error: 'Unknown command' };
            try {
                const url = new URL(req.url || '/', `http://localhost:${PORT}`);
                const cmd = url.pathname.replace(/^\//, '');
                const data = body ? JSON.parse(body) : {};
                if (data.file)
                    data.file = String(data.file);
                const sid = data.session;
                switch (cmd) {
                    case 'launch':
                        result = await handleLaunch(data);
                        break;
                    case 'attach':
                        result = await handleAttach(data);
                        break;
                    case 'stop':
                        result = await handleStop(sid);
                        break;
                    case 'break':
                        result = await handleBreak(sid, String(data.file), parseInt(data.line), data.condition);
                        break;
                    case 'continue':
                        result = await handleContinue(sid);
                        break;
                    case 'next':
                        result = await handleNext(sid);
                        break;
                    case 'step':
                        result = await handleStep(sid);
                        break;
                    case 'status':
                        result = await handleStatus(sid);
                        break;
                    case 'crash':
                        result = await handleCrash(sid);
                        break;
                    case 'eval':
                        result = await handleEval(sid, String(data.expr));
                        break;
                    case 'gdb':
                        result = await handleGdbRaw(sid, String(data.cmd));
                        break;
                    case 'watch':
                        result = await handleWatch(sid, String(data.expr), String(data.type || ''));
                        break;
                    case 'logs':
                        result = await handleLogs(data);
                        break;
                    case 'stats':
                        result = await handleStats(data);
                        break;
                    case 'leaks':
                        result = await handleLeaks(data);
                        break;
                    case 'trace-capture':
                        result = await handleTraceCapture(data);
                        break;
                    case 'diff':
                        result = await handleDiff(data);
                        break;
                    case 'sanitize':
                        result = await handleSanitize(data);
                        break;
                    case 'report':
                        result = await handleReport(data);
                        break;
                    case 'health':
                        result = ok({ result: `daemon running, ${sessions.size} session(s) active` });
                        break;
                }
            }
            catch (e) {
                result = fail(e.message);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        });
    });
    server.listen(PORT, '127.0.0.1', () => {
        (0, types_1.log)('info', `Daemon listening on 127.0.0.1:${PORT}`);
    });
}
