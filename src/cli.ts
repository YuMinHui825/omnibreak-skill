#!/usr/bin/env node
import { Command } from 'commander';
import { request } from 'http';

const SOCK = '/tmp/omnibreak-daemon.sock';
const PORT = 49200;

function daemonCall(cmd: string, data?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const opts = {
      socketPath: SOCK,
      path: '/' + cmd,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    };
    const req = request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: out }); } });
    });
    req.on('error', () => resolve({ ok: false, error: 'Daemon not running. Start with: omnibreak daemon &' }));
    req.write(body);
    req.end();
  });
}

const prog = new Command();
prog.name('omnibreak').description('Remote Linux debugger CLI').version('0.1.0');

// Daemon management
prog.command('daemon').description('Start the session daemon (run in background: omnibreak daemon &)')
  .action(() => { require('./daemon'); });

// Debug commands (all via daemon)
prog.command('launch').description('Start a debug session')
  .requiredOption('--target <host>', 'Target Linux IP')
  .requiredOption('--binary <path>', 'Remote binary path')
  .option('--user <name>', 'SSH user', 'root')
  .option('--port <n>', 'gdbserver port', '2345')
  .option('--pwd <pass>', 'SSH password')
  .option('--source-map <json>', 'Source path mapping')
  .option('--deploy-source <path>', 'Local binary to SCP')
  .option('--sudo', 'Use sudo for gdbserver commands')
  .option('--skip-gdbserver', 'Skip starting gdbserver (already running)')
  .action(o => daemonCall('launch', { ...o, line: undefined }).then(console.log));

prog.command('attach').description('Attach to running process')
  .requiredOption('--target <host>', 'Target Linux IP')
  .option('--user <name>', 'SSH user', 'root')
  .option('--port <n>', 'gdbserver port', '2345')
  .option('--pwd <pass>', 'SSH password')
  .option('--process <name>', 'Process name')
  .option('--pid <n>', 'Process ID')
  .option('--binary <path>', '.so or binary for symbols')
  .option('--solib-path <dir>', '.so search path')
  .option('--source-map <json>', 'Source path mapping')
  .option('--deploy-source <path>', 'Local binary to SCP before attach')
  .option('--sudo', 'Use sudo for gdbserver commands')
  .action(o => daemonCall('attach', { ...o, processName: o.process }).then(console.log));

prog.command('break').description('Set breakpoint')
  .requiredOption('--file <path>', 'Source file')
  .requiredOption('--line <n>', 'Line number')
  .option('--condition <expr>', 'Condition')
  .action(o => daemonCall('break', o).then(console.log));

prog.command('continue').alias('c').description('Continue execution').action(() => daemonCall('continue').then(console.log));
prog.command('next').alias('n').description('Step over').action(() => daemonCall('next').then(console.log));
prog.command('step').alias('s').description('Step into').action(() => daemonCall('step').then(console.log));
prog.command('status').description('Get debug state').action(() => daemonCall('status').then(console.log));
prog.command('crash').description('Crash backtrace').action(() => daemonCall('crash').then(console.log));
prog.command('eval').description('Evaluate expression').argument('<expr>').action(e => daemonCall('eval', { expr: e }).then(console.log));
prog.command('gdb').description('Raw GDB/MI command (e.g. gdb -break-delete 1)').allowUnknownOption().argument('<cmd...>').action((_cmd: string, _opts: any, cmdObj: any) => { const all = cmdObj.args.join(' '); daemonCall('gdb', { cmd: all }).then(console.log); });
prog.command('stop').description('End session').action(() => daemonCall('stop').then(console.log));
prog.command('health').description('Check daemon').action(() => daemonCall('health').then(console.log));
prog.command('stats').description('Process stats (CPU/RSS/VSZ/threads/state)')
  .requiredOption('--pid <n>', 'Process ID')
  .requiredOption('--target <host>', 'Target Linux IP')
  .option('--user <name>', 'SSH user', 'root')
  .option('--pwd <pass>', 'SSH password')
  .action(o => daemonCall('stats', o).then(console.log));
prog.command('leaks').description('Memory leak detection')
  .requiredOption('--pid <n>', 'Process ID')
  .requiredOption('--target <host>', 'Target Linux IP')
  .option('--user <name>', 'SSH user', 'root')
  .option('--pwd <pass>', 'SSH password')
  .action(o => daemonCall('leaks', o).then(console.log));

// Standalone deploy
prog.command('deploy').description('SCP file to target')
  .requiredOption('--source <path>', 'Local file')
  .requiredOption('--target <host>', 'Target IP')
  .requiredOption('--dest <path>', 'Remote destination')
  .option('--user <name>', 'SSH user', 'root')
  .option('--pwd <pass>', 'SSH password')
  .action(o => {
    const esc = (s: string) => s.replace(/'/g, "'\\''");
    const sc = o.pwd
      ? `sshpass -p '${esc(o.pwd)}' scp -o StrictHostKeyChecking=no ${esc(o.source)} ${esc(o.user)}@${esc(o.target)}:${esc(o.dest)}`
      : `scp -o StrictHostKeyChecking=no ${esc(o.source)} ${esc(o.user)}@${esc(o.target)}:${esc(o.dest)}`;
    require('child_process').execSync(sc, { timeout: 60000 });
    console.log(JSON.stringify({ ok: true, result: `Deployed ${o.source} → ${o.target}:${o.dest}` }));
  });

prog.parse();
