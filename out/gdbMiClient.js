"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GdbMiClient = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const gdbMiParser_1 = require("./gdbMiParser");
class GdbMiClient extends events_1.EventEmitter {
    opts;
    process = null;
    parser;
    token = 0;
    pending = new Map();
    cmdQueue = [];
    processing = false;
    isAlive = false;
    constructor(opts) {
        super();
        this.opts = opts;
        this.parser = new gdbMiParser_1.GdbMiParser();
        this.parser.onResult((r) => this.handleResult(r));
        this.parser.onRecord((r) => this.handleRecord(r));
    }
    get alive() { return this.isAlive; }
    get proc() { return this.process; }
    async launch(extraArgs = []) {
        const args = ['--interpreter=mi3', '--quiet', ...extraArgs];
        // Determine: local or SSH?
        if (this.opts.sshRemote) {
            const r = this.opts.sshRemote;
            if (r.password) {
                const sshArgs = [
                    '-p', r.password, 'ssh',
                    '-o', 'StrictHostKeyChecking=no',
                    '-o', 'ServerAliveInterval=30',
                    ...(r.port ? ['-p', String(r.port)] : []),
                    `${r.user}@${r.host}`,
                    this.opts.gdbPath,
                    ...args,
                ];
                this.process = (0, child_process_1.spawn)('sshpass', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            }
            else {
                const sshArgs = [
                    '-o', 'StrictHostKeyChecking=no',
                    '-o', 'ServerAliveInterval=30',
                    ...(r.port ? ['-p', String(r.port)] : []),
                    `${r.user}@${r.host}`,
                    this.opts.gdbPath,
                    ...args,
                ];
                this.process = (0, child_process_1.spawn)('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            }
        }
        else {
            // log("info", `Launching GDB: ${this.opts.gdbPath} ${args.join(' ')}`);
            this.process = (0, child_process_1.spawn)(this.opts.gdbPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        }
        return new Promise((resolve, reject) => {
            this.process.stdout?.on('data', (chunk) => {
                this.parser.feed(chunk.toString());
            });
            this.process.stderr?.on('data', (chunk) => {
                this.emit('output', 'stderr', chunk.toString());
            });
            this.process.on('error', (err) => {
                // log("error", `GDB spawn error: ${err.message}`);
                this.isAlive = false;
                reject(err);
            });
            this.process.on('exit', (code, signal) => {
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
    sendCommand(cmd) {
        return new Promise((resolve, reject) => {
            this.cmdQueue.push({ cmd, resolve, reject });
            this.processQueue();
        });
    }
    async init() {
        await this.launch();
        await this.sendCommand('-gdb-set mi-async on');
        // log("info", 'GDB/MI async mode enabled');
    }
    async terminate() {
        if (!this.process)
            return;
        try {
            await this.sendCommand('-gdb-exit');
        }
        catch { /* ignore */ }
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (this.process && !this.process.killed)
                    this.process.kill('SIGKILL');
            }, 2000);
        }
    }
    processQueue() {
        if (this.processing || this.cmdQueue.length === 0 || !this.process)
            return;
        this.processing = true;
        const item = this.cmdQueue.shift();
        this.token++;
        const token = this.token;
        const fullCmd = `${token}${item.cmd}\n`;
        // // // `GDB << ${fullCmd.trim()}`);
        this.pending.set(token, item);
        this.process.stdin?.write(fullCmd);
        this.processing = false;
        if (this.cmdQueue.length > 0)
            setImmediate(() => this.processQueue());
    }
    handleResult(result) {
        const pending = this.pending.get(result.token);
        if (pending) {
            this.pending.delete(result.token);
            if (result.class === 'error') {
                const msgMatch = result.data.match(/msg="([^"]*)"/);
                pending.reject(new Error(msgMatch?.[1] || result.data));
            }
            else {
                pending.resolve(result);
            }
        }
    }
    handleRecord(record) {
        switch (record.type) {
            case 'exec':
                if (record.class === 'stopped')
                    this.emit('stopped', record.data);
                else if (record.class === 'running')
                    this.emit('running', record.data);
                break;
            case 'notify':
                if (record.class === 'thread-created')
                    this.emit('threadCreated', record.data);
                else if (record.class === 'thread-exited')
                    this.emit('threadExited', record.data);
                break;
            case 'console':
                this.emit('output', 'console', this.stripQuotes(record.data));
                break;
            case 'target':
                this.emit('output', 'target', this.stripQuotes(record.data));
                break;
            case 'log':
                this.emit('output', 'log', this.stripQuotes(record.data));
                break;
        }
    }
    stripQuotes(data) {
        const match = data.match(/^"([^]*)"$/);
        if (match)
            return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return data;
    }
}
exports.GdbMiClient = GdbMiClient;
