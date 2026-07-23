import * as fs from 'fs';
import { Client } from 'ssh2';

// ═══ Interfaces ═══

export interface Transport {
  exec(cmd: string, timeoutMs?: number): Promise<string>;
  execSafe?(cmd: string, timeoutMs?: number): Promise<string>;
  deployFile(local: string, remote: string): Promise<void>;
  pullFile(remote: string, local: string): Promise<void>;
}

export interface TransportConfig {
  type: 'ssh' | 'local' | 'docker';
  // SSH
  host?: string; user?: string; port?: number; password?: string;
  // Docker
  container?: string;
}

// ═══ Factory ═══

export function createTransport(cfg: TransportConfig): Transport {
  if (cfg.type === 'local') return new LocalTransport();
  if (cfg.type === 'docker') return new DockerTransport(cfg.container || '');
  return new SshTransport(cfg.host || '', cfg.user || 'root', cfg.port || 22, cfg.password);
}

/** Parse target string into TransportConfig. Backward compatible with "IP" format. */
export function parseTarget(target: string, user: string, password?: string, port?: number): TransportConfig {
  if (target === 'local') return { type: 'local' };
  if (target.startsWith('docker://')) return { type: 'docker', container: target.slice(9) };
  return { type: 'ssh', host: target, user, port: port || 22, password };
}

// ═══ Helpers ═══

function esc(s: string): string { return s.replace(/'/g, "'\\''"); }
function hasSshpass(): boolean {
  return !!process.env.SSHPASS || (() => {
    try {
      const { execSync } = require('child_process');
      execSync('which sshpass 2>/dev/null', { stdio: 'pipe' });
      return true;
    } catch { return false; }
  })();
}

// ═══ SSH Transport (fully async — zero busy-waiting) ═══

class SshTransport implements Transport {
  constructor(private host: string, private user: string, private port: number, private password?: string) {}

  async exec(cmd: string, timeoutMs = 15000): Promise<string> {
    // Fast path: sshpass available, use direct exec
    if (this.password && hasSshpass()) {
      const { execSync } = require('child_process');
      return execSync(
        `SSHPASS='${esc(this.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`,
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
      );
    }
    // Password but no sshpass: native ssh2 connection
    if (this.password) return this._ssh2Exec(cmd, timeoutMs);
    // No password: plain key-auth SSH
    const { execSync } = require('child_process');
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
  }

  async execSafe(cmd: string, timeoutMs = 15000): Promise<string> {
    const b64 = Buffer.from(cmd).toString('base64');
    return this.exec(`echo ${b64} | base64 -d | sh`, timeoutMs);
  }

  // ─── Native async ssh2 exec (Promise-based, zero polling) ───

  private _ssh2Exec(cmd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let result = '', stderr = '', settled = false;

      const finish = () => {
        if (settled) return; settled = true;
        try { conn.end(); } catch {}
      };

      const timer = setTimeout(() => { finish(); reject(new Error(`SSH exec timeout after ${timeoutMs}ms`)); }, timeoutMs);

      conn.on('ready', () => {
        conn.exec(cmd, (err: any, stream: any) => {
          if (err) { finish(); clearTimeout(timer); reject(new Error(err.message)); return; }
          stream.on('data', (d: Buffer) => result += d.toString());
          stream.stderr.on('data', (d: Buffer) => stderr += d.toString());
          stream.on('close', () => {
            finish(); clearTimeout(timer);
            // stderr that's just SSH noise is harmless; reject only when no stdout
            if (stderr && !result && !stderr.match(/^(Warning:|Permanently added|Authorized uses only)/)) {
              reject(new Error(stderr.trim()));
            } else {
              resolve(result);
            }
          });
        });
      });

      conn.on('error', (e: Error) => { finish(); clearTimeout(timer); reject(e); });

      conn.connect({
        host: this.host, port: this.port,
        username: this.user, password: this.password,
        readyTimeout: Math.min(timeoutMs, 10000),
      });
    });
  }

  // ─── Native async SFTP (Promise-based, zero polling) ───

  async deployFile(local: string, remote: string): Promise<void> {
    if (this.password && hasSshpass()) {
      const { execSync } = require('child_process');
      execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
      return;
    }
    if (this.password) return this._sftpPut(local, remote);
    const { execSync } = require('child_process');
    execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
  }

  private _sftpPut(local: string, remote: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const content = fs.readFileSync(local);
      const conn = new Client();
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { conn.end(); } catch {} reject(new Error('SFTP put timeout')); } }, 60000);

      conn.on('ready', () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(new Error(err.message)); return; }
          const ws = sftp.createWriteStream(remote);
          ws.on('close', () => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} resolve(); });
          ws.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(e); });
          ws.end(content);
        });
      });

      conn.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(e); });
      conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
    });
  }

  async pullFile(remote: string, local: string): Promise<void> {
    if (this.password && hasSshpass()) {
      const { execSync } = require('child_process');
      execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} "${esc(this.user)}@${esc(this.host)}:${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
      return;
    }
    if (this.password) return this._sftpGet(remote, local);
    const { execSync } = require('child_process');
    execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(this.user)}@${esc(this.host)}:"${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
  }

  private _sftpGet(remote: string, local: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const conn = new Client();
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { conn.end(); } catch {} reject(new Error('SFTP get timeout')); } }, 60000);

      conn.on('ready', () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(new Error(err.message)); return; }
          const rs = sftp.createReadStream(remote);
          rs.on('data', (d: Buffer) => chunks.push(d));
          rs.on('end', () => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} fs.writeFileSync(local, Buffer.concat(chunks)); resolve(); });
          rs.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(e); });
        });
      });

      conn.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} reject(e); });
      conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
    });
  }
}

// ═══ Local Transport ═══

class LocalTransport implements Transport {
  async exec(cmd: string, timeoutMs = 15000): Promise<string> {
    const { execSync } = require('child_process');
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, shell: '/bin/bash' });
  }
  async execSafe(cmd: string, timeoutMs = 15000): Promise<string> { return this.exec(cmd, timeoutMs); }
  async deployFile(local: string, remote: string): Promise<void> { fs.copyFileSync(local, remote); }
  async pullFile(remote: string, local: string): Promise<void> { fs.copyFileSync(remote, local); }
}

// ═══ Docker Transport ═══

class DockerTransport implements Transport {
  constructor(private container: string) {}

  async exec(cmd: string, timeoutMs = 15000): Promise<string> {
    const { execSync } = require('child_process');
    return execSync(`docker exec "${this.container}" sh -c "${cmd.replace(/"/g, '\\"')}"`, {
      timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
    });
  }
  async execSafe(cmd: string, timeoutMs = 15000): Promise<string> { return this.exec(cmd, timeoutMs); }
  async deployFile(local: string, remote: string): Promise<void> {
    const { execSync } = require('child_process');
    execSync(`docker cp "${local}" "${this.container}:${remote}"`, { timeout: 60000 });
  }
  async pullFile(remote: string, local: string): Promise<void> {
    const { execSync } = require('child_process');
    execSync(`docker cp "${this.container}:${remote}" "${local}"`, { timeout: 60000 });
  }
}
