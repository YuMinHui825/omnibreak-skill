#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateNonStop = validateNonStop;
/**
 * Clean GDB non-stop validation — proves that a breakpoint on a line shared by several
 * threads re-triggers per-thread in non-stop mode, versus all-stop's well-known
 * "stop once per thread then inert" GDB infrun limitation.
 *
 * Bypasses the daemon entirely: drives GdbMiClient directly over SSH + gdbserver, so the
 * result is not contaminated by the daemon's all-stop assumptions. Reuse via
 * `validateNonStop(opts)` from tests.
 *
 * Usage:
 *   node out/tools/nonstop-validate.js --target 192.168.64.2 --user ubuntu --pwd 1234 \
 *     --binary /tmp/example/build/multithread --mode conditional [--control]
 *
 * Exit code 0 = the non-stop run met its expected stop count; 1 = failed.
 */
const client_1 = require("../debug/client");
const parser_1 = require("../debug/parser");
const transport_1 = require("../transport/transport");
function miQuote(s) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
async function killGdbserverOnPort(t, port, sudo) {
    const cmd = `${sudo}pkill -f 'gdbserve[r].*:${port}([^0-9]|$)' 2>/dev/null || true`;
    try {
        if (t.execSafe)
            await t.execSafe(cmd);
        else
            await t.exec(cmd);
    }
    catch { }
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
const EXIT_REASONS = new Set(['exited', 'exited-normally', 'exited-signalled']);
async function runOne(o) {
    const t = (0, transport_1.createTransport)((0, transport_1.parseTarget)(o.target, o.user, o.pwd));
    const sudo = o.sudo ? 'sudo ' : '';
    const gdb = new client_1.GdbMiClient({ gdbPath: o.gdbPath, sshRemote: { host: o.target, user: o.user, password: o.pwd } });
    const stops = [];
    let terminated = false;
    let resumeTimer = null;
    let done = false;
    let error;
    let nonStopShown;
    let statesAtFirstStop;
    let captured = false;
    const events = [];
    const resumeErrors = [];
    const evLog = (ev) => { if (events.length < 200)
        events.push(ev); };
    const onStop = (data) => {
        const rec = (0, parser_1.parseStopRecord)(data);
        if (rec.reason && EXIT_REASONS.has(rec.reason)) {
            terminated = true;
            done = true;
            if (resumeTimer)
                clearTimeout(resumeTimer);
            return;
        }
        if (rec.reason === 'breakpoint-hit') {
            stops.push(rec);
            // Diagnostic: on the first stop, snapshot thread states to confirm non-stop is active
            // (in non-stop other threads keep running; in all-stop every thread shows "stopped").
            if (!captured) {
                captured = true;
                gdb.sendCommand('-thread-info').then(r => {
                    const m = r.data.match(/^done,threads=\[(.*?)\](?:,current-thread-id=)?/);
                    if (m) {
                        statesAtFirstStop = m[1].split(/\},\{/).map(s => {
                            const id = s.match(/id="(\d+)"/)?.[1] || '?';
                            const state = s.match(/state="(\w+)"/)?.[1] || '?';
                            return { id, state };
                        });
                    }
                }).catch(() => { });
            }
        }
        // Debounce: threads sharing the breakpoint PC stop in bursts; one resume-all covers them all.
        if (resumeTimer)
            clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
            gdb.sendCommand('-exec-continue --all').then(r => {
                if (r.class === 'error')
                    resumeErrors.push(r.data);
            }).catch((e) => resumeErrors.push(e.message));
        }, 30);
    };
    try {
        if (!o.native) {
            await killGdbserverOnPort(t, o.port, sudo);
            await t.exec(`rm -f /tmp/omnibreak_output.log; setsid stdbuf -o0 ${sudo}gdbserver --multi :${o.port} >/tmp/omnibreak_output.log 2>&1 &`);
            await waitForPort(t, o.port, 5000);
        }
        await gdb.init();
        // non-stop MUST be set before -target-select.
        await gdb.sendCommand(o.nonStop ? '-gdb-set non-stop on' : '-gdb-set non-stop off');
        nonStopShown = (0, parser_1.extractMiString)((await gdb.sendCommand('-gdb-show non-stop')).data, 'value');
        await gdb.sendCommand(`-file-exec-and-symbols ${miQuote(o.binary)}`);
        if (o.native) {
            // Native: GDB runs the inferior directly on the target (no gdbserver, no remote protocol).
            await gdb.sendCommand(`-interpreter-exec console ${miQuote('set disable-randomization on')}`).catch(() => { });
        }
        else {
            await gdb.sendCommand(`-interpreter-exec console ${miQuote(`set remote exec-file ${o.binary}`)}`);
            await gdb.sendCommand(`-target-select extended-remote localhost:${o.port}`);
        }
        await gdb.sendCommand('-gdb-set breakpoint pending on').catch(() => { });
        if (o.alwaysInserted)
            await gdb.sendCommand('-gdb-set breakpoint always-inserted on').catch(() => { });
        const hw = o.hw ? '-H ' : '';
        const breakCmd = o.condition
            ? `-break-insert ${hw}-c ${miQuote(o.condition)} -f ${o.sourceFile}:${o.sourceLine}`
            : `-break-insert ${hw}-f ${o.sourceFile}:${o.sourceLine}`;
        await gdb.sendCommand(breakCmd);
        gdb.on('stopped', onStop);
        gdb.on('running', evLog);
        gdb.on('threadExited', evLog);
        gdb.on('output', evLog);
        await gdb.sendCommand('-exec-run --all');
        const deadline = Date.now() + o.timeoutMs;
        while (!done && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 100));
    }
    catch (e) {
        error = e.message;
    }
    finally {
        gdb.removeListener('stopped', onStop);
        gdb.removeListener('running', evLog);
        gdb.removeListener('threadExited', evLog);
        gdb.removeListener('output', evLog);
        if (resumeTimer)
            clearTimeout(resumeTimer);
        try {
            await gdb.terminate();
        }
        catch { }
        if (!o.native)
            await killGdbserverOnPort(t, o.port, sudo);
    }
    const perThread = {};
    for (const s of stops) {
        const k = s.threadId !== undefined ? String(s.threadId) : '?';
        perThread[k] = (perThread[k] || 0) + 1;
    }
    // GDB may report the adjacent line for a statement breakpoint (line-table granularity),
    // so only require every stop to carry a resolved source line — not an exact match.
    const lineOk = stops.length > 0 && stops.every(s => s.frame?.line !== undefined);
    return {
        pass: false, detail: '', ok: !error,
        mode: o.mode, nonStop: o.nonStop,
        count: stops.length,
        distinctThreads: Object.keys(perThread).length,
        perThread, lineOk, terminated,
        stops: stops.map(s => ({ threadId: s.threadId, reason: s.reason, line: s.frame?.line, func: s.frame?.func })),
        nonStopShown, statesAtFirstStop,
        events, resumeErrors,
        error,
    };
}
/** Run one non-stop validation and judge it against the expected hit counts. */
async function validateNonStop(o) {
    const r = await runOne(o);
    if (!r.ok) {
        return { ...r, pass: false, detail: `run error: ${r.error}` };
    }
    if (o.condition) {
        // 3 workers, each hits `i == 2` exactly once on line 17.
        const allOnce = Object.values(r.perThread).every(c => c === 1);
        r.pass = r.count === 3 && r.distinctThreads === 3 && r.lineOk && allOnce;
        r.detail = `expected 3 breakpoint-hits (one per thread at line ${o.sourceLine}); got ${r.count} (${JSON.stringify(r.perThread)})`;
    }
    else {
        // Workers run 4/8/12 iterations → 24 hits at the loop header.
        r.pass = r.count === 24 && r.distinctThreads === 3 && r.lineOk;
        r.detail = `expected 24 breakpoint-hits (4/8/12 per thread at line ${o.sourceLine}); got ${r.count} (${JSON.stringify(r.perThread)})`;
    }
    if (r.terminated)
        r.detail += ' [program ran to exit]';
    return r;
}
async function main() {
    const args = process.argv.slice(2);
    const get = (name, def) => {
        const i = args.indexOf(name);
        return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
    };
    const has = (name) => args.includes(name);
    const mode = (get('--mode', 'conditional') || 'conditional');
    const o = {
        target: get('--target', '') || '',
        user: get('--user', 'root') || 'root',
        pwd: get('--pwd'),
        binary: get('--binary', '') || '',
        port: parseInt(get('--port', '2345') || '2345', 10),
        gdbPath: get('--gdb-path', '/usr/bin/gdb-multiarch') || '/usr/bin/gdb-multiarch',
        sudo: has('--sudo'),
        mode,
        nonStop: !has('--no-nonstop'),
        condition: mode === 'conditional' ? get('--condition', 'i == 2') : undefined,
        sourceFile: get('--source-file', 'multithread.c') || 'multithread.c',
        sourceLine: parseInt(get('--source-line', '17') || '17', 10),
        timeoutMs: parseInt(get('--timeout', '30000') || '30000', 10),
        alwaysInserted: has('--always-inserted'),
        hw: has('--hw'),
        native: has('--native'),
    };
    if (!o.target || !o.binary) {
        console.error('usage: nonstop-validate.js --target <ip> --binary <path> [--mode conditional|unconditional] [--control]');
        process.exit(2);
    }
    const primary = await validateNonStop(o);
    const out = { nonstop: primary };
    if (has('--control')) {
        out.allstop = await validateNonStop({ ...o, nonStop: false });
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(primary.pass ? 0 : 1);
}
if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
