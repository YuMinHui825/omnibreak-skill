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
const gdbMiClient_1 = require("./gdbMiClient");
const gdbMiParser_1 = require("./gdbMiParser");
const sourceMapper_1 = require("./sourceMapper");
const types_1 = require("./types");
const transport_1 = require("./transport");
const trace_1 = require("./trace");
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
async function handleLaunch(body) {
    const t = getTransport(body);
    const port = body.port || 2345;
    if (body.deploySource) {
        (0, types_1.log)('info', `Deploying ${body.deploySource} → ${body.target}:${body.binary}`);
        t.deployFile(body.deploySource, body.binary);
    }
    // Start gdbserver — different commands for local vs remote
    const isLocal = body.target === 'local';
    const sudo = body.sudo ? 'sudo ' : '';
    try {
        t.exec(`${sudo}pkill -x gdbserver 2>/dev/null || true`);
    }
    catch { }
    if (!body.skipGdbserver) {
        if (isLocal) {
            // Local: simple background gdbserver, no setsid needed
            t.exec(`${sudo}gdbserver --multi :${port} &`);
        }
        else {
            t.exec(`rm -f /tmp/omnibreak_output.log; setsid stdbuf -o0 ${sudo}gdbserver --multi :${port} >/tmp/omnibreak_output.log 2>&1 &`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    // GDB still uses SSH for remote targets; local targets spawn GDB directly
    const id = String(++sessionCounter);
    const mapper = new sourceMapper_1.SourceMapper(body.sourceMap || {});
    const gdb = new gdbMiClient_1.GdbMiClient({
        gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch',
        sshRemote: body.target === 'local' ? undefined : { host: body.target, user: body.user || 'root', port: 22, password: body.pwd },
    });
    await gdb.init();
    await gdb.sendCommand(body.nonStop ? '-gdb-set non-stop on' : '-gdb-set non-stop off');
    await gdb.sendCommand(`-file-exec-and-symbols ${body.binary}`);
    await gdb.sendCommand(`-interpreter-exec console "set remote exec-file ${body.binary}"`);
    await gdb.sendCommand(`-target-select extended-remote localhost:${port}`);
    const session = { id, gdb, mapper, firstContinue: true, target: body.target, binary: body.binary };
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
        pid = t.exec(`pgrep -f '${esc(body.processName)}' | head -1`).trim();
    }
    if (!pid)
        return fail('Process not found', 'SESSION');
    if (body.deploySource)
        t.deployFile(body.deploySource, body.binary);
    const isLocal = body.target === 'local';
    const sudo = body.sudo ? 'sudo ' : '';
    try {
        t.exec(`${sudo}pkill -x gdbserver 2>/dev/null || true`);
    }
    catch { }
    if (isLocal) {
        t.exec(`${sudo}gdbserver --attach :${port} ${pid} &`);
    }
    else {
        t.exec(`setsid stdbuf -o0 ${sudo}gdbserver --attach :${port} ${pid} >/tmp/omnibreak_output.log 2>&1 &`);
    }
    await new Promise(r => setTimeout(r, 1500));
    const id = String(++sessionCounter);
    const mapper = new sourceMapper_1.SourceMapper(body.sourceMap || {});
    const gdb = new gdbMiClient_1.GdbMiClient({
        gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch',
        sshRemote: body.target === 'local' ? undefined : { host: body.target, user: body.user || 'root', port: 22, password: body.pwd },
    });
    await gdb.init();
    if (body.solibPath)
        await gdb.sendCommand(`-interpreter-exec console "set solib-search-path ${body.solibPath}"`);
    if (body.binary)
        await gdb.sendCommand(`-file-exec-and-symbols ${body.binary}`);
    await gdb.sendCommand(`-target-select extended-remote localhost:${port}`);
    const session = { id, gdb, mapper, firstContinue: false, target: body.target, binary: body.binary || '' };
    sessions.set(id, session);
    lastId = id;
    return await handleStatusById(session);
}
async function handleStop(sessionId) {
    if (sessionId) {
        const s = sessions.get(sessionId);
        if (s) {
            await s.gdb.terminate();
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
        const cmd = condition ? `-break-insert ${loc} -c "${condition}"` : `-break-insert ${loc}`;
        const result = await s.gdb.sendCommand(cmd);
        const info = (0, gdbMiParser_1.parseBreakpoint)(result.data);
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
        const result = await s.gdb.sendCommand(`${cmd} ${expr}`);
        const info = (0, gdbMiParser_1.parseBreakpoint)(result.data);
        return ok({ breakpoints: [{ id: parseInt(info.number || '0'), file: expr, line: 0, verified: true }] });
    }
    catch (e) {
        return fail(`Watchpoint failed: ${e.message}`);
    }
}
async function handleStatusById(s) {
    try {
        const out = { ok: true, status: 'stopped' };
        const threads = await s.gdb.sendCommand('-thread-info');
        const tinfo = (0, gdbMiParser_1.parseThreadInfo)(threads.data).map(t => ({
            id: parseInt(t.id), name: t.name, state: t.state
        }));
        out.threads = tinfo;
        if (tinfo.length > 0)
            out.threadId = tinfo[0].id;
        try {
            const frames = await s.gdb.sendCommand('-stack-list-frames 0 20');
            const finfo = (0, gdbMiParser_1.parseFrames)(frames.data).map(f => ({
                level: parseInt(f['level'] || '0'), func: f['func'] || '??',
                file: s.mapper.compileToLocal(f['fullname'] || f['file'] || ''),
                line: parseInt(f['line'] || '0')
            }));
            out.frames = finfo;
            if (finfo.length > 0) {
                out.file = finfo[0].file;
                out.line = finfo[0].line;
            }
        }
        catch { }
        try {
            const vars = await s.gdb.sendCommand('-stack-list-variables --simple-values');
            out.vars = (0, gdbMiParser_1.parseVariables)(vars.data).map(v => ({ name: v['name'] || '??', value: v['value'] || '' }));
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
    const finfo = (0, gdbMiParser_1.parseFrames)(frames.data).map(f => ({
        level: parseInt(f['level'] || '0'), func: f['func'] || '??',
        file: s.mapper.compileToLocal(f['fullname'] || f['file'] || ''),
        line: parseInt(f['line'] || '0')
    }));
    return ok({ status: 'stopped', reason: 'signal-received', frames: finfo });
}
async function handleEval(sid, expr) {
    const s = requireSession(sid);
    const result = await s.gdb.sendCommand(`-data-evaluate-expression "${expr}"`);
    const m = result.data.match(/done,value="([^"]*)"/);
    return ok({ result: m ? m[1] : result.data });
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
        const out = t.exec(`tail -n ${lines} '${esc(path)}' 2>/dev/null || echo LOG_NOT_FOUND`);
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
        const out = t.exec(`ps -p ${pid} -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo '0 0 0 0 ?'`).trim();
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
        const smaps = t.exec(`cat /proc/${pid}/smaps 2>/dev/null`);
        const status = t.exec(`grep -E '^(Vm|Rss)' /proc/${pid}/status 2>/dev/null`);
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
            samples = JSON.parse(t.exec(`cat ${sampleFile} 2>/dev/null || echo '[]'`).trim());
        }
        catch { }
        if (!Array.isArray(samples))
            samples = [];
        samples.push(heapKB);
        if (samples.length > 60)
            samples = samples.slice(-60);
        t.exec(`printf '%s' '${JSON.stringify(samples).replace(/'/g, "'\\''")}' > ${sampleFile}`);
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
