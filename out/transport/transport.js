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
exports.createTransport = createTransport;
exports.parseTarget = parseTarget;
const fs = __importStar(require("fs"));
const ssh2_1 = require("ssh2");
// ═══ Factory ═══
function createTransport(cfg) {
    if (cfg.type === 'local')
        return new LocalTransport();
    if (cfg.type === 'docker')
        return new DockerTransport(cfg.container || '');
    return new SshTransport(cfg.host || '', cfg.user || 'root', cfg.port || 22, cfg.password);
}
/** Parse target string into TransportConfig. Backward compatible with "IP" format. */
function parseTarget(target, user, password, port) {
    if (target === 'local')
        return { type: 'local' };
    if (target.startsWith('docker://'))
        return { type: 'docker', container: target.slice(9) };
    return { type: 'ssh', host: target, user, port: port || 22, password };
}
// ═══ Helpers ═══
function esc(s) { return s.replace(/'/g, "'\\''"); }
function hasSshpass() {
    return !!process.env.SSHPASS || (() => {
        try {
            const { execSync } = require('child_process');
            execSync('which sshpass 2>/dev/null', { stdio: 'pipe' });
            return true;
        }
        catch {
            return false;
        }
    })();
}
// ═══ SSH Transport (fully async — zero busy-waiting) ═══
class SshTransport {
    host;
    user;
    port;
    password;
    constructor(host, user, port, password) {
        this.host = host;
        this.user = user;
        this.port = port;
        this.password = password;
    }
    async exec(cmd, timeoutMs = 15000) {
        // Fast path: sshpass available, use direct exec
        if (this.password && hasSshpass()) {
            const { execSync } = require('child_process');
            return execSync(`SSHPASS='${esc(this.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
        }
        // Password but no sshpass: native ssh2 connection
        if (this.password)
            return this._ssh2Exec(cmd, timeoutMs);
        // No password: plain key-auth SSH
        const { execSync } = require('child_process');
        return execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    }
    async execSafe(cmd, timeoutMs = 15000) {
        const b64 = Buffer.from(cmd).toString('base64');
        return this.exec(`echo ${b64} | base64 -d | sh`, timeoutMs);
    }
    // ─── Native async ssh2 exec (Promise-based, zero polling) ───
    _ssh2Exec(cmd, timeoutMs) {
        return new Promise((resolve, reject) => {
            const conn = new ssh2_1.Client();
            let result = '', stderr = '', settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                try {
                    conn.end();
                }
                catch { }
            };
            const timer = setTimeout(() => { finish(); reject(new Error(`SSH exec timeout after ${timeoutMs}ms`)); }, timeoutMs);
            conn.on('ready', () => {
                conn.exec(cmd, (err, stream) => {
                    if (err) {
                        finish();
                        clearTimeout(timer);
                        reject(new Error(err.message));
                        return;
                    }
                    stream.on('data', (d) => result += d.toString());
                    stream.stderr.on('data', (d) => stderr += d.toString());
                    stream.on('close', () => {
                        finish();
                        clearTimeout(timer);
                        // stderr that's just SSH noise is harmless; reject only when no stdout
                        if (stderr && !result && !stderr.match(/^(Warning:|Permanently added|Authorized uses only)/)) {
                            reject(new Error(stderr.trim()));
                        }
                        else {
                            resolve(result);
                        }
                    });
                });
            });
            conn.on('error', (e) => { finish(); clearTimeout(timer); reject(e); });
            conn.connect({
                host: this.host, port: this.port,
                username: this.user, password: this.password,
                readyTimeout: Math.min(timeoutMs, 10000),
            });
        });
    }
    // ─── Native async SFTP (Promise-based, zero polling) ───
    async deployFile(local, remote) {
        if (this.password && hasSshpass()) {
            const { execSync } = require('child_process');
            execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
            return;
        }
        if (this.password)
            return this._sftpPut(local, remote);
        const { execSync } = require('child_process');
        execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
    }
    _sftpPut(local, remote) {
        return new Promise((resolve, reject) => {
            const content = fs.readFileSync(local);
            const conn = new ssh2_1.Client();
            let settled = false;
            const timer = setTimeout(() => { if (!settled) {
                settled = true;
                try {
                    conn.end();
                }
                catch { }
                reject(new Error('SFTP put timeout'));
            } }, 60000);
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        try {
                            conn.end();
                        }
                        catch { }
                        reject(new Error(err.message));
                        return;
                    }
                    const ws = sftp.createWriteStream(remote);
                    ws.on('close', () => { if (settled)
                        return; settled = true; clearTimeout(timer); try {
                        conn.end();
                    }
                    catch { } resolve(); });
                    ws.on('error', (e) => { if (settled)
                        return; settled = true; clearTimeout(timer); try {
                        conn.end();
                    }
                    catch { } reject(e); });
                    ws.end(content);
                });
            });
            conn.on('error', (e) => { if (settled)
                return; settled = true; clearTimeout(timer); try {
                conn.end();
            }
            catch { } reject(e); });
            conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
        });
    }
    async pullFile(remote, local) {
        if (this.password && hasSshpass()) {
            const { execSync } = require('child_process');
            execSync(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} "${esc(this.user)}@${esc(this.host)}:${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
            return;
        }
        if (this.password)
            return this._sftpGet(remote, local);
        const { execSync } = require('child_process');
        execSync(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(this.user)}@${esc(this.host)}:"${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
    }
    _sftpGet(remote, local) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const conn = new ssh2_1.Client();
            let settled = false;
            const timer = setTimeout(() => { if (!settled) {
                settled = true;
                try {
                    conn.end();
                }
                catch { }
                reject(new Error('SFTP get timeout'));
            } }, 60000);
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        try {
                            conn.end();
                        }
                        catch { }
                        reject(new Error(err.message));
                        return;
                    }
                    const rs = sftp.createReadStream(remote);
                    rs.on('data', (d) => chunks.push(d));
                    rs.on('end', () => { if (settled)
                        return; settled = true; clearTimeout(timer); try {
                        conn.end();
                    }
                    catch { } fs.writeFileSync(local, Buffer.concat(chunks)); resolve(); });
                    rs.on('error', (e) => { if (settled)
                        return; settled = true; clearTimeout(timer); try {
                        conn.end();
                    }
                    catch { } reject(e); });
                });
            });
            conn.on('error', (e) => { if (settled)
                return; settled = true; clearTimeout(timer); try {
                conn.end();
            }
            catch { } reject(e); });
            conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
        });
    }
}
// ═══ Local Transport ═══
class LocalTransport {
    async exec(cmd, timeoutMs = 15000) {
        const { execSync } = require('child_process');
        return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, shell: '/bin/bash' });
    }
    async execSafe(cmd, timeoutMs = 15000) { return this.exec(cmd, timeoutMs); }
    async deployFile(local, remote) { fs.copyFileSync(local, remote); }
    async pullFile(remote, local) { fs.copyFileSync(remote, local); }
}
// ═══ Docker Transport ═══
class DockerTransport {
    container;
    constructor(container) {
        this.container = container;
    }
    async exec(cmd, timeoutMs = 15000) {
        const { execSync } = require('child_process');
        return execSync(`docker exec "${this.container}" sh -c "${cmd.replace(/"/g, '\\"')}"`, {
            timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
        });
    }
    async execSafe(cmd, timeoutMs = 15000) { return this.exec(cmd, timeoutMs); }
    async deployFile(local, remote) {
        const { execSync } = require('child_process');
        execSync(`docker cp "${local}" "${this.container}:${remote}"`, { timeout: 60000 });
    }
    async pullFile(remote, local) {
        const { execSync } = require('child_process');
        execSync(`docker cp "${this.container}:${remote}" "${local}"`, { timeout: 60000 });
    }
}
