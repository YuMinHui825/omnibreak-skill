import { execSync } from 'child_process';
import { Client } from 'ssh2';

export interface SshConfig {
  host: string;
  user: string;
  port: number;
  password?: string;
}

function esc(s: string): string { return s.replace(/'/g, "'\\''"); }

function hasSshpass(): boolean {
  try { execSync('which sshpass 2>/dev/null', { stdio: 'pipe' }); return true; } catch { return false; }
}

/** Run command on remote target. Uses sshpass if available, falls back to ssh2 library. */
export function sshExec(c: SshConfig, cmd: string): string {
  if (hasSshpass() && c.password) {
    return execSync(`sshpass -p '${esc(c.password)}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${esc(c.user)}@${esc(c.host)} ${cmd}`, { timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }
  if (c.password) return ssh2Exec(c, cmd);
  return execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${esc(c.user)}@${esc(c.host)} ${cmd}`, { timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function ssh2Exec(c: SshConfig, cmd: string): string {
  // Synchronous wrapper around async ssh2 library
  let result = '', error = '', done = false;
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(cmd, (err: any, stream: any) => {
      if (err) { error = err.message; done = true; return; }
      stream.on('data', (d: Buffer) => { result += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { error += d.toString(); });
      stream.on('close', () => { done = true; });
    });
  });
  conn.on('error', (e: Error) => { error = e.message; done = true; });
  conn.connect({ host: c.host, port: c.port, username: c.user, password: c.password, readyTimeout: 10000 });
  const start = Date.now();
  while (!done && Date.now() - start < 15000) {
    require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
  }
  try { conn.end(); } catch {}
  if (error && !result) throw new Error(error);
  return result;
}

/** SCP file to remote target */
export function scpDeploy(source: string, c: SshConfig, dest: string): void {
  if (hasSshpass() && c.password) {
    execSync(`sshpass -p '${esc(c.password)}' scp -o StrictHostKeyChecking=no -P ${c.port} ${esc(source)} ${esc(c.user)}@${esc(c.host)}:${esc(dest)}`, { timeout: 60000, encoding: 'utf8' });
    return;
  }
  if (c.password) {
    // ssh2 SCP fallback
    const content = require('fs').readFileSync(source);
    let error = '', done = false;
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err: any, sftp: any) => {
        if (err) { error = err.message; done = true; return; }
        const ws = sftp.createWriteStream(dest);
        ws.on('close', () => { done = true; });
        ws.on('error', (e: Error) => { error = e.message; done = true; });
        ws.end(content);
      });
    });
    conn.on('error', (e: Error) => { error = e.message; done = true; });
    conn.connect({ host: c.host, port: c.port, username: c.user, password: c.password, readyTimeout: 10000 });
    const start = Date.now();
    while (!done && Date.now() - start < 60000) {
      require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
    }
    try { conn.end(); } catch {}
    if (error) throw new Error(error);
    return;
  }
  execSync(`scp -o StrictHostKeyChecking=no -P ${c.port} ${esc(source)} ${esc(c.user)}@${esc(c.host)}:${esc(dest)}`, { timeout: 60000, encoding: 'utf8' });
}
