import * as http from 'http';
import { GdbMiClient, GdbLaunchOptions } from './gdbMiClient';
import { parseThreadInfo, parseFrames, parseVariables, parseBreakpoint } from './gdbMiParser';
import { SourceMapper } from './sourceMapper';
import { CliOutput, ThreadInfo, FrameInfo, VarInfo, StatsResult, LeakResult, TraceCaptureResult, log } from './types';
import { SshConfig, sshExec, scpDeploy } from './ssh';
import { traceCapture } from './trace';

const PORT = 49200;

let gdb: GdbMiClient | null = null;
let mapper: SourceMapper = new SourceMapper({});
let sessionStarted = false;
let firstContinue = false;

function esc(s: string): string { return s.replace(/'/g, "'\\''"); }

function ok(data?: Partial<CliOutput>): CliOutput { return { ok: true, ...data }; }
function fail(msg: string, code?: CliOutput['code'], hint?: string): CliOutput {
  return { ok: false, error: msg, code, hint };
}

async function handleLaunch(body: any): Promise<CliOutput> {
  if (gdb) await gdb.terminate();
  mapper = new SourceMapper(body.sourceMap || {});
  const c: SshConfig = { host: body.target, user: body.user || 'root', port: 22, password: body.pwd };

  // Deploy
  if (body.deploySource) {
    log('info', `Deploying ${body.deploySource} → ${body.target}:${body.binary}`);
    scpDeploy(body.deploySource, c, body.binary);
  }

  // Start gdbserver
  const sudo = body.sudo ? 'sudo ' : '';
  try { sshExec(c, `"${sudo}pkill -x gdbserver 2>/dev/null || true"`); } catch {}
  if (!body.skipGdbserver) {
    sshExec(c, `"rm -f /tmp/omnibreak_output.log; setsid stdbuf -o0 ${sudo}gdbserver --multi :${body.port || 2345} >/tmp/omnibreak_output.log 2>&1 &"`);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Start GDB
  gdb = new GdbMiClient({ gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch', sshRemote: { host: body.target, user: body.user || 'root', port: 22, password: body.pwd } });
  await gdb.init();
  await gdb.sendCommand(body.nonStop ? '-gdb-set non-stop on' : '-gdb-set non-stop off');
  await gdb.sendCommand(`-file-exec-and-symbols ${body.binary}`);
  await gdb.sendCommand(`-interpreter-exec console "set remote exec-file ${body.binary}"`);
  await gdb.sendCommand(`-target-select extended-remote localhost:${body.port || 2345}`);
  firstContinue = true; // Program will start on first continue (breakpoint-hit or _start)
  await new Promise<void>(resolve => {
    const onStop = (data: string) => {
      if (data.includes('exited-normally')) { resolve(); return; }
      resolve();
      gdb?.removeListener('stopped', onStop);
    };
    gdb!.on('stopped', onStop);
    // Timeout fallback after 5s
    setTimeout(() => { gdb?.removeListener('stopped', onStop); resolve(); }, 5000);
  });
  await new Promise(r => setTimeout(r, 300));

  sessionStarted = true;
  return await handleStatus();
}

async function handleAttach(body: any): Promise<CliOutput> {
  if (gdb) await gdb.terminate();
  mapper = new SourceMapper(body.sourceMap || {});
  const c: SshConfig = { host: body.target, user: body.user || 'root', port: 22, password: body.pwd };
  const port = body.port || 2345;

  // Resolve PID
  let pid = String(body.pid || '');
  if (!pid && body.processName) {
    pid = sshExec(c, `"pgrep -f '${esc(body.processName)}' | head -1"`).trim();
  }
  if (!pid) return fail(`Process not found`, 'SESSION');

  // Deploy before attach
  if (body.deploySource) scpDeploy(body.deploySource, c, body.binary);

  const sudo = body.sudo ? 'sudo ' : '';
  try { sshExec(c, `"${sudo}pkill -x gdbserver 2>/dev/null || true"`); } catch {}
  sshExec(c, `"setsid stdbuf -o0 ${sudo}gdbserver --attach :${port} ${pid} >/tmp/omnibreak_output.log 2>&1 &"`);
  await new Promise(r => setTimeout(r, 1500));

  gdb = new GdbMiClient({ gdbPath: body.gdbPath || '/usr/bin/gdb-multiarch', sshRemote: { host: body.target, user: body.user || 'root', port: 22, password: body.pwd } });
  await gdb.init();
  if (body.solibPath) await gdb.sendCommand(`-interpreter-exec console "set solib-search-path ${body.solibPath}"`);
  if (body.binary) await gdb.sendCommand(`-file-exec-and-symbols ${body.binary}`);
  await gdb.sendCommand(`-target-select extended-remote localhost:${port}`);

  sessionStarted = true;
  return await handleStatus();
}

async function handleStop(): Promise<CliOutput> {
  if (gdb) { await gdb.terminate(); gdb = null; }
  sessionStarted = false;
  return ok();
}

async function handleBreak(file: string, line: number, condition?: string): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  try {
    await gdb.sendCommand('-gdb-set breakpoint pending on').catch(() => {});
    const loc = `-f ${file}:${line}`;
    const cmd = condition ? `-break-insert ${loc} -c "${condition}"` : `-break-insert ${loc}`;
    const result = await gdb.sendCommand(cmd);
    const info = parseBreakpoint(result.data);
    return ok({ breakpoints: [{ id: parseInt(info.number||'0'), file, line, verified: true }] });
  } catch (e: any) { return fail(`Breakpoint failed: ${e.message}`); }
}

function waitForStop(timeoutMs = 10000): Promise<void> {
  return new Promise<void>(resolve => {
    const onStop = () => { resolve(); gdb?.removeListener('stopped', onStop); };
    gdb!.on('stopped', onStop);
    setTimeout(() => { gdb?.removeListener('stopped', onStop); resolve(); }, timeoutMs);
  });
}

async function handleContinue(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  if (firstContinue) {
    firstContinue = false;
    await gdb.sendCommand('-exec-run');
    await waitForStop();
    await new Promise(r => setTimeout(r, 300));
    return await handleStatus();
  }
  await gdb.sendCommand('-exec-continue');
  await waitForStop();
  await new Promise(r => setTimeout(r, 300));
  return await handleStatus();
}

async function handleNext(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  await gdb.sendCommand('-exec-next');
  await waitForStop();
  await new Promise(r => setTimeout(r, 300));
  return await handleStatus();
}

async function handleStep(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  await gdb.sendCommand('-exec-step');
  await waitForStop();
  await new Promise(r => setTimeout(r, 300));
  return await handleStatus();
}

async function handleWatch(expr: string, type?: string): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  try {
    let cmd = '-break-watch';
    if (type === 'read') cmd += ' -r';
    else if (type === 'access') cmd += ' -a';
    const result = await gdb.sendCommand(`${cmd} ${expr}`);
    const info = parseBreakpoint(result.data);
    return ok({ breakpoints: [{ id: parseInt(info.number || '0'), file: expr, line: 0, verified: true }] });
  } catch (e: any) { return fail(`Watchpoint failed: ${e.message}`); }
}

async function handleLogs(data: any): Promise<CliOutput> {
  const c: SshConfig = { host: data.target, user: data.user || 'root', port: 22, password: data.pwd };
  const path = data.path;
  if (!path) return fail('Log path required', 'SESSION');
  try {
    const lines = parseInt(data.lines) || 100;
    const out = sshExec(c, `"tail -n ${lines} ${path} 2>/dev/null || echo 'LOG_NOT_FOUND'"`);
    if (out.includes('LOG_NOT_FOUND')) return fail(`Log file not found: ${path}`);
    return ok({ result: JSON.stringify({ path, lines: out.trim().split('\n') }) });
  } catch (e: any) { return fail(`Logs failed: ${e.message}`); }
}

async function handleGdb(cmd: string): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  const result = await gdb.sendCommand(cmd);
  return ok({ result: result.data });
}

async function handleStatus(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  try {
    const out: CliOutput = { ok: true, status: 'stopped' };
    const threads = await gdb.sendCommand('-thread-info');
    const tinfo: ThreadInfo[] = parseThreadInfo(threads.data).map(t => ({
      id: parseInt(t.id), name: t.name, state: t.state
    }));
    out.threads = tinfo;
    if (tinfo.length > 0) out.threadId = tinfo[0].id;

    try {
      const frames = await gdb.sendCommand('-stack-list-frames 0 20');
      const finfo: FrameInfo[] = parseFrames(frames.data).map(f => ({
        level: parseInt(f['level']||'0'), func: f['func']||'??',
        file: mapper.compileToLocal(f['fullname']||f['file']||''),
        line: parseInt(f['line']||'0')
      }));
      out.frames = finfo;
      if (finfo.length > 0) { out.file = finfo[0].file; out.line = finfo[0].line; }
    } catch {}

    try {
      const vars = await gdb.sendCommand('-stack-list-variables --simple-values');
      out.vars = parseVariables(vars.data).map(v => ({ name: v['name']||'??', value: v['value']||'' }));
    } catch {}

    return out;
  } catch (e: any) { return fail(`Status: ${e.message}`); }
}

async function handleCrash(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  const frames = await gdb.sendCommand('-stack-list-frames 0 500');
  const finfo: FrameInfo[] = parseFrames(frames.data).map(f => ({
    level: parseInt(f['level']||'0'), func: f['func']||'??',
    file: mapper.compileToLocal(f['fullname']||f['file']||''),
    line: parseInt(f['line']||'0')
  }));
  return ok({ status:'stopped', reason:'signal-received', frames: finfo });
}

async function handleEval(expr: string): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  const result = await gdb.sendCommand(`-data-evaluate-expression "${expr}"`);
  const m = result.data.match(/done,value="([^"]*)"/);
  return ok({ result: m ? m[1] : result.data });
}

async function handleTraceCapture(data: any): Promise<CliOutput> {
  const c: SshConfig = { host: data.target, user: data.user || 'root', port: 22, password: data.pwd };
  const durationSec = parseInt(data.duration) || 10;
  const outputPath = data.output || './trace.pftrace';

  if (!data.target) return fail('Target host required', 'CONNECTION');

  try {
    const result: TraceCaptureResult = traceCapture(c, {
      durationSec,
      outputPath,
      events: data.events || undefined,
      sudo: !!data.sudo,
      sudoPwd: data.sudoPwd || data.pwd,
      startCmd: data.startCmd,
      heapProfile: data.heapProfile,
    });
    return ok({ result: JSON.stringify(result) });
  } catch (e: any) { return fail(`Trace capture failed: ${e.message}`); }
}

async function handleStats(data: any): Promise<CliOutput> {
  const c: SshConfig = { host: data.target, user: data.user || 'root', port: 22, password: data.pwd };
  const pid = parseInt(data.pid) || 0;
  if (!pid) return fail('PID required', 'SESSION');
  try {
    const out = sshExec(c, `"ps -p ${pid} -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo '0 0 0 0 ?'"`).trim();
    const vals = out.split(/\s+/);
    const rssKB = parseInt(vals[1]) || 0;
    const result: StatsResult = {
      pid,
      cpuPercent: parseFloat(vals[0]) || 0,
      rssMB: Math.round(rssKB / 1024 * 10) / 10,
      vszMB: Math.round((parseInt(vals[2]) || 0) / 1024),
      threadCount: parseInt(vals[3]) || 0,
      state: vals[4] || '?',
    };
    return ok({ result: JSON.stringify(result) });
  } catch (e: any) { return fail(`Stats failed: ${e.message}`); }
}

async function handleLeaks(data: any): Promise<CliOutput> {
  const c: SshConfig = { host: data.target, user: data.user || 'root', port: 22, password: data.pwd };
  const pid = parseInt(data.pid) || 0;
  if (!pid) return fail('PID required', 'SESSION');
  try {
    // Read smaps for heap/stack/data
    const smaps = sshExec(c, `"cat /proc/${pid}/smaps 2>/dev/null"`);
    const status = sshExec(c, `"grep -E '^(Vm|Rss)' /proc/${pid}/status 2>/dev/null"`);
    const st: Record<string,number> = {};
    status.split('\n').forEach(line => {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if(m) st[m[1].toLowerCase()] = parseInt(m[2]);
    });
    let heapKB=0, stackKB=0, curAddr='', curSize=0;
    smaps.split('\n').forEach(line => {
      const am = line.match(/^([0-9a-f]+)-/);
      if(am){if(curAddr.includes('[heap]'))heapKB+=curSize;if(curAddr.includes('[stack]'))stackKB+=curSize;curAddr=line;curSize=0}
      const sm = line.match(/^Size:\s+(\d+)/); if(sm)curSize=parseInt(sm[1]);
    });
    if(curAddr.includes('[heap]'))heapKB+=curSize;
    if(curAddr.includes('[stack]'))stackKB+=curSize;
    // Rolling samples via remote file
    const sampleFile = `/tmp/omnibreak-leak-${pid}.json`;
    let samples: number[] = [];
    try { samples = JSON.parse(sshExec(c, `"cat ${sampleFile} 2>/dev/null || echo '[]'"`).trim()); } catch {}
    if(!Array.isArray(samples)) samples = [];
    samples.push(heapKB);
    if(samples.length > 60) samples = samples.slice(-60);
    const sampleJson = JSON.stringify(samples);
    sshExec(c, `"printf '%s' '${sampleJson.replace(/'/g, "'\\''")}' > ${sampleFile}"`);
    // Risk detection
    let risk: LeakResult['risk'] = 'none';
    if(samples.length >= 10) {
      const n = samples.length;
      const firstQ = samples.slice(0, Math.floor(n/4)).reduce((a,b)=>a+b,0) / Math.floor(n/4);
      const lastQ = samples.slice(-Math.floor(n/4)).reduce((a,b)=>a+b,0) / Math.floor(n/4);
      const growth = lastQ - firstQ;
      let growing = 0;
      for(let i=1;i<n;i++) if(samples[i] > samples[0]) growing++;
      const growthRatio = growing / (n-1);
      if(growth > 128 && growthRatio > 0.7) risk = 'high';
      else if(growth > 64 && growthRatio > 0.5) risk = 'medium';
      else if(growth > 0 && growthRatio > 0.4) risk = 'low';
    }
    const result: LeakResult = {
      pid,
      heapKB, stackKB,
      dataKB: (st.vmdata || 0),
      rssKB: (st.vmrss || 0),
      vszKB: (st.vmsize || 0),
      heapDeltaKB: samples.length > 1 ? heapKB - samples[0] : 0,
      risk,
      sampleCount: samples.length,
    };
    return ok({ result: JSON.stringify(result) });
  } catch (e: any) { return fail(`Leak scan failed: ${e.message}`); }
}

// ═══ HTTP SERVER ═══
if (require.main === module) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let result: CliOutput = { ok: false, error: 'Unknown command' };
      try {
        const url = new URL(req.url || '/', `http://localhost:${PORT}`);
        const cmd = url.pathname.replace(/^\//, '');
        const data = body ? JSON.parse(body) : {};
        if (data.file) data.file = String(data.file);  // TypeScript string coercion

        switch (cmd) {
          case 'launch': result = await handleLaunch(data); break;
          case 'attach': result = await handleAttach(data); break;
          case 'stop': result = await handleStop(); break;
          case 'break': result = await handleBreak(String(data.file), parseInt(data.line), data.condition); break;
          case 'continue': result = await handleContinue(); break;
          case 'next': result = await handleNext(); break;
          case 'step': result = await handleStep(); break;
          case 'status': result = await handleStatus(); break;
          case 'crash': result = await handleCrash(); break;
          case 'eval': result = await handleEval(String(data.expr)); break;
          case 'gdb': result = await handleGdb(String(data.cmd)); break;
          case 'watch': result = await handleWatch(String(data.expr), String(data.type || '')); break;
          case 'logs': result = await handleLogs(data); break;
          case 'stats': result = await handleStats(data); break;
          case 'leaks': result = await handleLeaks(data); break;
          case 'trace-capture': result = await handleTraceCapture(data); break;
          case 'health': result = ok({ result: 'daemon running' }); break;
        }
      } catch (e: any) { result = fail(e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('info', `Daemon listening on 127.0.0.1:${PORT}`);
  });
}
