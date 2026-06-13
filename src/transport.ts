import { execSync } from 'child_process';
import * as fs from 'fs';
import { Client } from 'ssh2';

// ═══ Interfaces ═══

export interface Transport {
  exec(cmd: string, timeoutMs?: number): string;
  deployFile(local: string, remote: string): void;
  pullFile(remote: string, local: string): void;
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
  try { execSync('which sshpass 2>/dev/null', { stdio: 'pipe' }); return true; } catch { return false; }
}

// ═══ SSH Transport ═══

class SshTransport implements Transport {
  constructor(private host: string, private user: string, private port: number, private password?: string) {}

  exec(cmd: string, timeoutMs = 15000): string {
    if (this.password && hasSshpass()) {
      return execSync(
        `SSHPASS='${esc(this.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`,
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
      );
    }
    if (this.password) return this.ssh2Exec(cmd, timeoutMs);
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
    );
  }

  execSafe(cmd: string, timeoutMs = 15000): string {
    const b64 = Buffer.from(cmd).toString('base64');
    return this.exec(`echo ${b64} | base64 -d | sh`, timeoutMs);
  }

  private ssh2Exec(cmd: string, timeoutMs: number): string {
    let result = '', error = '', done = false;
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err: any, stream: any) => {
        if (err) { error = err.message; done = true; return; }
        stream.on('data', (d: Buffer) => result += d.toString());
        stream.stderr.on('data', (d: Buffer) => error += d.toString());
        stream.on('close', () => { done = true; });
      });
    });
    conn.on('error', (e: Error) => { error = e.message; done = true; });
    conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
    const start = Date.now();
    while (!done && Date.now() - start < timeoutMs) {
      require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
    }
    try { conn.end(); } catch {}
    if (error && !result) throw new Error(error);
    return result;
  }

  deployFile(local: string, remote: string): void {
    if (this.password && hasSshpass()) {
      execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
      return;
    }
    if (this.password) {
      const content = fs.readFileSync(local);
      let error = '', done = false;
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) { error = err.message; done = true; return; }
          const ws = sftp.createWriteStream(remote);
          ws.on('close', () => { done = true; });
          ws.on('error', (e: Error) => { error = e.message; done = true; });
          ws.end(content);
        });
      });
      conn.on('error', (e: Error) => { error = e.message; done = true; });
      conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
      const start = Date.now();
      while (!done && Date.now() - start < 60000) {
        require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
      }
      try { conn.end(); } catch {}
      if (error) throw new Error(error);
      return;
    }
    execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
  }

  pullFile(remote: string, local: string): void {
    if (this.password && hasSshpass()) {
      execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} "${esc(this.user)}@${esc(this.host)}:${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
      return;
    }
    if (this.password) {
      const chunks: Buffer[] = [];
      let error = '', done = false;
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) { error = err.message; done = true; return; }
          const rs = sftp.createReadStream(remote);
          rs.on('data', (d: Buffer) => chunks.push(d));
          rs.on('end', () => { done = true; });
          rs.on('error', (e: Error) => { error = e.message; done = true; });
        });
      });
      conn.on('error', (e: Error) => { error = e.message; done = true; });
      conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
      const start = Date.now();
      while (!done && Date.now() - start < 60000) {
        require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
      }
      try { conn.end(); } catch {}
      if (error) throw new Error(`SCP pull: ${error}`);
      fs.writeFileSync(local, Buffer.concat(chunks));
      return;
    }
    execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(this.user)}@${esc(this.host)}:"${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
  }
}

// ═══ Local Transport ═══

class LocalTransport implements Transport {
  exec(cmd: string, timeoutMs = 15000): string {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, shell: '/bin/bash' });
  }

  execSafe(cmd: string, timeoutMs = 15000): string {
    return this.exec(cmd, timeoutMs);
  }

  deployFile(local: string, remote: string): void {
    fs.copyFileSync(local, remote);
  }

  pullFile(remote: string, local: string): void {
    fs.copyFileSync(remote, local);
  }
}

// ═══ Docker Transport ═══

class DockerTransport implements Transport {
  constructor(private container: string) {}

  exec(cmd: string, timeoutMs = 15000): string {
    const escCmd = cmd.replace(/"/g, '\\"');
    return execSync(`docker exec "${this.container}" sh -c "${escCmd}"`, {
      timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
    });
  }

  execSafe(cmd: string, timeoutMs = 15000): string {
    return this.exec(cmd, timeoutMs);
  }

  deployFile(local: string, remote: string): void {
    execSync(`docker cp "${local}" "${this.container}:${remote}"`, { timeout: 60000 });
  }

  pullFile(remote: string, local: string): void {
    execSync(`docker cp "${this.container}:${remote}" "${local}"`, { timeout: 60000 });
  }
}
