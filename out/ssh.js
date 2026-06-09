"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sshExec = sshExec;
exports.scpDeploy = scpDeploy;
const child_process_1 = require("child_process");
const ssh2_1 = require("ssh2");
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
/** Run command on remote target. Uses sshpass if available, falls back to ssh2 library. */
function sshExec(c, cmd) {
    if (hasSshpass() && c.password) {
        return (0, child_process_1.execSync)(`SSHPASS='${esc(c.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${esc(c.user)}@${esc(c.host)} ${cmd}`, { timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    }
    if (c.password)
        return ssh2Exec(c, cmd);
    return (0, child_process_1.execSync)(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${esc(c.user)}@${esc(c.host)} ${cmd}`, { timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}
function ssh2Exec(c, cmd) {
    // Synchronous wrapper around async ssh2 library
    let result = '', error = '', done = false;
    const conn = new ssh2_1.Client();
    conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
            if (err) {
                error = err.message;
                done = true;
                return;
            }
            stream.on('data', (d) => { result += d.toString(); });
            stream.stderr.on('data', (d) => { error += d.toString(); });
            stream.on('close', () => { done = true; });
        });
    });
    conn.on('error', (e) => { error = e.message; done = true; });
    conn.connect({ host: c.host, port: c.port, username: c.user, password: c.password, readyTimeout: 10000 });
    const start = Date.now();
    while (!done && Date.now() - start < 15000) {
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
/** SCP file to remote target */
function scpDeploy(source, c, dest) {
    if (hasSshpass() && c.password) {
        (0, child_process_1.execSync)(`SSHPASS='${esc(c.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${c.port} ${esc(source)} ${esc(c.user)}@${esc(c.host)}:${esc(dest)}`, { timeout: 60000, encoding: 'utf8' });
        return;
    }
    if (c.password) {
        // ssh2 SCP fallback
        const content = require('fs').readFileSync(source);
        let error = '', done = false;
        const conn = new ssh2_1.Client();
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) {
                    error = err.message;
                    done = true;
                    return;
                }
                const ws = sftp.createWriteStream(dest);
                ws.on('close', () => { done = true; });
                ws.on('error', (e) => { error = e.message; done = true; });
                ws.end(content);
            });
        });
        conn.on('error', (e) => { error = e.message; done = true; });
        conn.connect({ host: c.host, port: c.port, username: c.user, password: c.password, readyTimeout: 10000 });
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
    (0, child_process_1.execSync)(`scp -o StrictHostKeyChecking=no -P ${c.port} ${esc(source)} ${esc(c.user)}@${esc(c.host)}:${esc(dest)}`, { timeout: 60000, encoding: 'utf8' });
}
