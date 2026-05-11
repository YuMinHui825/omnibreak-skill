import * as http from 'http';
import * as fs from 'fs';
import { GdbMiClient, GdbLaunchOptions } from './gdbMiClient';
import { parseThreadInfo, parseFrames, parseVariables, parseBreakpoint } from './gdbMiParser';
import { SourceMapper } from './sourceMapper';
import { CliOutput, ThreadInfo, FrameInfo, VarInfo, log } from './types';
import { SshConfig, sshExec } from './ssh';

const SOCK = '/tmp/omnibreak-daemon.sock';
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
    const sc = body.pwd
      ? `sshpass -p '${esc(body.pwd)}' scp -o StrictHostKeyChecking=no ${esc(body.deploySource)} ${esc(body.user)}@${esc(body.target)}:${esc(body.binary)}`
      : `scp -o StrictHostKeyChecking=no ${esc(body.deploySource)} ${esc(body.user)}@${esc(body.target)}:${esc(body.binary)}`;
    require('child_process').execSync(sc, { timeout: 60000 });
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
  if (body.deploySource) {
    const sc = body.pwd
      ? `sshpass -p '${esc(body.pwd)}' scp -o StrictHostKeyChecking=no ${esc(body.deploySource)} ${esc(body.user)}@${esc(body.target)}:${esc(body.binary)}`
      : `scp -o StrictHostKeyChecking=no ${esc(body.deploySource)} ${esc(body.user)}@${esc(body.target)}:${esc(body.binary)}`;
    require('child_process').execSync(sc, { timeout: 60000 });
  }

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

async function handleContinue(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  if (firstContinue) {
    firstContinue = false;
    await gdb.sendCommand('-exec-run');
    // Wait for stop
    await new Promise<void>(resolve => {
      const onStop = () => { resolve(); gdb?.removeListener('stopped', onStop); };
      gdb!.on('stopped', onStop);
      setTimeout(() => { gdb?.removeListener('stopped', onStop); resolve(); }, 5000);
    });
    await new Promise(r => setTimeout(r, 300));
    return await handleStatus();
  }
  await gdb.sendCommand('-exec-continue');
  return ok();
}

async function handleNext(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  await gdb.sendCommand('-exec-next');
  return ok();
}

async function handleStep(): Promise<CliOutput> {
  if (!gdb) return fail('No session', 'SESSION');
  await gdb.sendCommand('-exec-step');
  return ok();
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
          case 'health': result = ok({ result: 'daemon running' }); break;
        }
      } catch (e: any) { result = fail(e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  // Clean up stale socket
  try { fs.unlinkSync(SOCK); } catch {}
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, '666');
    log('info', `Daemon listening on ${SOCK}`);
  });
}
