import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { GdbMiParser } from './gdbMiParser';
import { MiResult, MiAsyncRecord } from './types';

export declare interface GdbMiClient {
  on(event: 'stopped', listener: (data: string) => void): this;
  on(event: 'running', listener: (data: string) => void): this;
  on(event: 'threadCreated', listener: (data: string) => void): this;
  on(event: 'threadExited', listener: (data: string) => void): this;
  on(event: 'output', listener: (category: string, text: string) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
}

export interface GdbLaunchOptions {
  gdbPath: string;
  /** If set, run GDB on remote host via SSH */
  sshRemote?: { host: string; user: string; port?: number };
  /** If set, connect GDB to this host:port (local or remote) */
  connectTarget?: { host: string; port: number };
}

export class GdbMiClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private parser: GdbMiParser;
  private token = 0;
  private pending = new Map<number, { resolve: (r: MiResult) => void; reject: (e: Error) => void }>();
  private cmdQueue: Array<{ cmd: string; resolve: (r: MiResult) => void; reject: (e: Error) => void }> = [];
  private processing = false;
  private isAlive = false;

  constructor(private opts: GdbLaunchOptions) {
    super();
    this.parser = new GdbMiParser();
    this.parser.onResult((r) => this.handleResult(r));
    this.parser.onRecord((r) => this.handleRecord(r));
  }

  get alive(): boolean { return this.isAlive; }
  get proc(): ChildProcess | null { return this.process; }

  async launch(extraArgs: string[] = []): Promise<void> {
    const args = ['--interpreter=mi3', '--quiet', ...extraArgs];

    // Determine: local or SSH?
    if (this.opts.sshRemote) {
      const r = this.opts.sshRemote;
      const sshArgs = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        ...(r.port ? ['-p', String(r.port)] : []),
        `${r.user}@${r.host}`,
        this.opts.gdbPath,
        ...args,
      ];
      // log("info", `Launching GDB via SSH: ssh ${sshArgs.join(' ')}`);
      this.process = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      // log("info", `Launching GDB: ${this.opts.gdbPath} ${args.join(' ')}`);
      this.process = spawn(this.opts.gdbPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    return new Promise((resolve, reject) => {
      this.process!.stdout?.on('data', (chunk: Buffer) => {
        this.parser.feed(chunk.toString());
      });

      this.process!.stderr?.on('data', (chunk: Buffer) => {
        this.emit('output', 'stderr', chunk.toString());
      });

      this.process!.on('error', (err) => {
        // log("error", `GDB spawn error: ${err.message}`);
        this.isAlive = false;
        reject(err);
      });

      this.process!.on('exit', (code, signal) => {
        // log("info", `GDB exited: code=${code}, signal=${signal}`);
        this.isAlive = false;
        this.emit('exit', code, signal);
        for (const [, p] of this.pending) {
          p.reject(new Error(`GDB exited with code ${code}`));
        }
        this.pending.clear();
        this.cmdQueue = [];
      });

      setTimeout(() => { this.isAlive = true; resolve(); }, 300);
    });
  }

  sendCommand(cmd: string): Promise<MiResult> {
    return new Promise((resolve, reject) => {
      this.cmdQueue.push({ cmd, resolve, reject });
      this.processQueue();
    });
  }

  async init(): Promise<void> {
    await this.launch();
    await this.sendCommand('-gdb-set mi-async on');
    // log("info", 'GDB/MI async mode enabled');
  }

  async terminate(): Promise<void> {
    if (!this.process) return;
    try { await this.sendCommand('-gdb-exit'); } catch { /* ignore */ }
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 2000);
    }
  }

  private processQueue(): void {
    if (this.processing || this.cmdQueue.length === 0 || !this.process) return;
    this.processing = true;
    const item = this.cmdQueue.shift()!;
    this.token++;
    const token = this.token;
    const fullCmd = `${token}${item.cmd}\n`;
    // // // `GDB << ${fullCmd.trim()}`);
    this.pending.set(token, item);
    this.process.stdin?.write(fullCmd);
    this.processing = false;
    if (this.cmdQueue.length > 0) setImmediate(() => this.processQueue());
  }

  private handleResult(result: MiResult): void {
    const pending = this.pending.get(result.token);
    if (pending) {
      this.pending.delete(result.token);
      if (result.class === 'error') {
        const msgMatch = result.data.match(/msg="([^"]*)"/);
        pending.reject(new Error(msgMatch?.[1] || result.data));
      } else {
        pending.resolve(result);
      }
    }
  }

  private handleRecord(record: MiAsyncRecord): void {
    switch (record.type) {
      case 'exec':
        if (record.class === 'stopped') this.emit('stopped', record.data);
        else if (record.class === 'running') this.emit('running', record.data);
        break;
      case 'notify':
        if (record.class === 'thread-created') this.emit('threadCreated', record.data);
        else if (record.class === 'thread-exited') this.emit('threadExited', record.data);
        break;
      case 'console': this.emit('output', 'console', this.stripQuotes(record.data)); break;
      case 'target': this.emit('output', 'target', this.stripQuotes(record.data)); break;
      case 'log': this.emit('output', 'log', this.stripQuotes(record.data)); break;
    }
  }

  private stripQuotes(data: string): string {
    const match = data.match(/^"([^]*)"$/);
    if (match) return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return data;
  }
}
