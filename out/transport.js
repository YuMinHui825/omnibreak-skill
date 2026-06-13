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
const child_process_1 = require("child_process");
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
    try {
        (0, child_process_1.execSync)('which sshpass 2>/dev/null', { stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    }
}
// ═══ SSH Transport ═══
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
    exec(cmd, timeoutMs = 15000) {
        if (this.password && hasSshpass()) {
            return (0, child_process_1.execSync)(`SSHPASS='${esc(this.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
        }
        if (this.password)
            return this.ssh2Exec(cmd, timeoutMs);
        return (0, child_process_1.execSync)(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.port} ${esc(this.user)}@${esc(this.host)} "${cmd}"`, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    }
    execSafe(cmd, timeoutMs = 15000) {
        const b64 = Buffer.from(cmd).toString('base64');
        return this.exec(`echo ${b64} | base64 -d | sh`, timeoutMs);
    }
    ssh2Exec(cmd, timeoutMs) {
        let result = '', error = '', done = false;
        const conn = new ssh2_1.Client();
        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) {
                    error = err.message;
                    done = true;
                    return;
                }
                stream.on('data', (d) => result += d.toString());
                stream.stderr.on('data', (d) => error += d.toString());
                stream.on('close', () => { done = true; });
            });
        });
        conn.on('error', (e) => { error = e.message; done = true; });
        conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
        const start = Date.now();
        while (!done && Date.now() - start < timeoutMs) {
            require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
        }
        try {
            conn.end();
        }
        catch { }
        if (error && !result)
            throw new Error(error);
        return result;
    }
    deployFile(local, remote) {
        if (this.password && hasSshpass()) {
            (0, child_process_1.execSync)(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
            return;
        }
        if (this.password) {
            const content = fs.readFileSync(local);
            let error = '', done = false;
            const conn = new ssh2_1.Client();
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        error = err.message;
                        done = true;
                        return;
                    }
                    const ws = sftp.createWriteStream(remote);
                    ws.on('close', () => { done = true; });
                    ws.on('error', (e) => { error = e.message; done = true; });
                    ws.end(content);
                });
            });
            conn.on('error', (e) => { error = e.message; done = true; });
            conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
            const start = Date.now();
            while (!done && Date.now() - start < 60000) {
                require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
            }
            try {
                conn.end();
            }
            catch { }
            if (error)
                throw new Error(error);
            return;
        }
        (0, child_process_1.execSync)(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(local)} ${esc(this.user)}@${esc(this.host)}:${esc(remote)}`, { timeout: 60000, encoding: 'utf8' });
    }
    pullFile(remote, local) {
        if (this.password && hasSshpass()) {
            (0, child_process_1.execSync)(`SSHPASS='${esc(this.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${this.port} "${esc(this.user)}@${esc(this.host)}:${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
            return;
        }
        if (this.password) {
            const chunks = [];
            let error = '', done = false;
            const conn = new ssh2_1.Client();
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        error = err.message;
                        done = true;
                        return;
                    }
                    const rs = sftp.createReadStream(remote);
                    rs.on('data', (d) => chunks.push(d));
                    rs.on('end', () => { done = true; });
                    rs.on('error', (e) => { error = e.message; done = true; });
                });
            });
            conn.on('error', (e) => { error = e.message; done = true; });
            conn.connect({ host: this.host, port: this.port, username: this.user, password: this.password, readyTimeout: 10000 });
            const start = Date.now();
            while (!done && Date.now() - start < 60000) {
                require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
            }
            try {
                conn.end();
            }
            catch { }
            if (error)
                throw new Error(`SCP pull: ${error}`);
            fs.writeFileSync(local, Buffer.concat(chunks));
            return;
        }
        (0, child_process_1.execSync)(`scp -o StrictHostKeyChecking=no -P ${this.port} ${esc(this.user)}@${esc(this.host)}:"${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
    }
}
// ═══ Local Transport ═══
class LocalTransport {
    exec(cmd, timeoutMs = 15000) {
        return (0, child_process_1.execSync)(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, shell: '/bin/bash' });
    }
    execSafe(cmd, timeoutMs = 15000) {
        return this.exec(cmd, timeoutMs);
    }
    deployFile(local, remote) {
        fs.copyFileSync(local, remote);
    }
    pullFile(remote, local) {
        fs.copyFileSync(remote, local);
    }
}
// ═══ Docker Transport ═══
class DockerTransport {
    container;
    constructor(container) {
        this.container = container;
    }
    exec(cmd, timeoutMs = 15000) {
        const escCmd = cmd.replace(/"/g, '\\"');
        return (0, child_process_1.execSync)(`docker exec "${this.container}" sh -c "${escCmd}"`, {
            timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
        });
    }
    execSafe(cmd, timeoutMs = 15000) {
        return this.exec(cmd, timeoutMs);
    }
    deployFile(local, remote) {
        (0, child_process_1.execSync)(`docker cp "${local}" "${this.container}:${remote}"`, { timeout: 60000 });
    }
    pullFile(remote, local) {
        (0, child_process_1.execSync)(`docker cp "${this.container}:${remote}" "${local}"`, { timeout: 60000 });
    }
}
