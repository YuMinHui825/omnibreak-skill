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
exports.traceCapture = traceCapture;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const ssh_1 = require("./ssh");
const types_1 = require("./types");
const REMOTE_TRACEBOX = '/tmp/omnibreak-tracebox';
const REMOTE_TRACE_FILE = '/tmp/omnibreak-trace.pftrace';
const REMOTE_TRACE_CFG = '/tmp/omnibreak-trace.cfg';
function escSh(s) { return s.replace(/'/g, "'\\''"); }
/** GPU ftrace event directories to probe. Key is the directory name, value is the primary event to enable. */
const GPU_PROBES = {
    i915: 'i915/i915_gem_request_submit',
    mali: 'mali/mali_job_slot_event',
    kgsl: 'kgsl/kgsl_pwrlevel',
    amdgpu: 'amdgpu/amdgpu_cs_ioctl',
    virtio_gpu: 'virtio_gpu/virtio_gpu_cmd_queue',
    v3d: 'v3d/v3d_submit_cl',
    panfrost: 'panfrost/panfrost_job_submit',
    etnaviv: 'etnaviv/etnaviv_submit',
    nouveau: 'nouveau/nouveau_fence_signaled',
    msm: 'msm/msm_gpu_submit',
    lima: 'lima/lima_submit',
    drm: 'drm/drm_vblank_event',
};
/** Detect available GPU ftrace events on the remote target */
function detectGpuEvents(c, sudo, sudoPwd) {
    const events = [];
    try {
        let cmd = `"ls /sys/kernel/tracing/events/ 2>/dev/null"`;
        if (sudo && sudoPwd) {
            cmd = `"echo '${escSh(sudoPwd)}' | sudo -S ls /sys/kernel/tracing/events/ 2>/dev/null"`;
        }
        else if (sudo) {
            cmd = `"sudo ls /sys/kernel/tracing/events/ 2>/dev/null"`;
        }
        const ls = (0, ssh_1.sshExec)(c, cmd);
        const dirs = ls.split('\n').map(s => s.trim()).filter(Boolean);
        for (const [dir, event] of Object.entries(GPU_PROBES)) {
            if (dirs.includes(dir)) {
                events.push(event);
                (0, types_1.log)('info', `Detected GPU: ${dir} (${event})`);
            }
        }
    }
    catch { }
    return events;
}
/** Build a Perfetto text config that includes ftrace + process snapshot */
function buildTraceConfig(durationSec, events) {
    const eventList = events.split(' ').filter(e => e).map(e => `      ftrace_events: "${e}"`).join('\n');
    return [
        'buffers { size_kb: 4096 }',
        'data_sources {',
        '  config {',
        '    name: "linux.ftrace"',
        '    ftrace_config {',
        eventList,
        '      buffer_size_kb: 2048',
        '    }',
        '  }',
        '}',
        'data_sources {',
        '  config {',
        '    name: "linux.perf"',
        '    perf_event_config {',
        '      all_cpus: true',
        '      sampling_frequency: 100',
        '    }',
        '  }',
        '}',
        'data_sources {',
        '  config {',
        '    name: "linux.process_stats"',
        '    process_stats_config {',
        '      scan_all_processes_on_start: true',
        '      proc_stats_poll_ms: 1000',
        '    }',
        '  }',
        '}',
        'data_sources {',
        '  config {',
        '    name: "linux.system_info"',
        '  }',
        '}',
        `duration_ms: ${durationSec * 1000}`,
    ].join('\n');
}
const SUMMARY_SQL = {
    top_cpu_threads: "SELECT name, SUM(dur)/1e6 AS cpu_ms FROM sched " +
        "JOIN thread USING (utid) " +
        "GROUP BY utid ORDER BY cpu_ms DESC LIMIT 10",
    thread_states: "SELECT name, end_state, SUM(dur)/1e6 AS dur_ms, COUNT(*) AS switches " +
        "FROM sched JOIN thread USING (utid) " +
        "GROUP BY utid, end_state ORDER BY dur_ms DESC LIMIT 20",
    io_wait: "SELECT name, SUM(dur)/1e6 AS io_wait_ms FROM sched " +
        "JOIN thread USING (utid) WHERE end_state='D' " +
        "GROUP BY utid ORDER BY io_wait_ms DESC LIMIT 10",
    scheduling_latency: "SELECT AVG(dur)/1e6 AS avg_slice_ms, MAX(dur)/1e6 AS max_slice_ms, " +
        "COUNT(*) AS total_switches FROM sched",
    process_rss: "SELECT name, MAX(CAST(value AS INT))/1024 AS peak_rss_mb " +
        "FROM counter JOIN process_counter_track ON counter.track_id = process_counter_track.id " +
        "JOIN process USING (upid) " +
        "WHERE process_counter_track.name='rss' GROUP BY upid ORDER BY peak_rss_mb DESC LIMIT 10",
    perf_top_functions: "SELECT name, COUNT(*) AS samples " +
        "FROM perf_sample JOIN stack_profile_callsite USING (callsite_id) " +
        "JOIN stack_profile_frame ON stack_profile_callsite.frame_id = stack_profile_frame.id " +
        "JOIN symbol_table ON stack_profile_frame.symbol_set_id = symbol_table.symbol_set_id " +
        "WHERE name IS NOT NULL GROUP BY name ORDER BY samples DESC LIMIT 10",
};
function ensureTraceProcessor() {
    const paths = [
        path.join(os.homedir(), '.cache', 'omnibreak', 'trace_processor'),
        '/tmp/trace_processor',
    ];
    for (const p of paths) {
        if (fs.existsSync(p))
            return p;
    }
    const dest = path.join(os.homedir(), '.cache', 'omnibreak', 'trace_processor');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    (0, types_1.log)('info', 'Downloading trace_processor...');
    (0, child_process_1.execSync)(`curl -fsSL -o "${dest}" https://get.perfetto.dev/trace_processor && chmod +x "${dest}"`, { timeout: 120000 });
    return dest;
}
function runTraceSummary(traceFile) {
    const summary = {};
    try {
        const tp = ensureTraceProcessor();
        for (const [key, sql] of Object.entries(SUMMARY_SQL)) {
            try {
                const b64 = Buffer.from(sql).toString('base64');
                const out = (0, child_process_1.execSync)(`echo ${b64} | base64 -d | ${tp} "${traceFile}" 2>/dev/null`, {
                    encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash',
                });
                const lines = out.trim().split('\n');
                let started = false;
                const rows = [];
                for (const line of lines) {
                    if (line.startsWith('Query executed') || line.startsWith('Error'))
                        continue;
                    if (!started && line.includes('---')) {
                        started = true;
                        continue;
                    }
                    if (started && line.trim())
                        rows.push(line.trim());
                }
                if (rows.length > 0)
                    summary[key] = rows;
            }
            catch {
                summary[key] = null;
            }
        }
    }
    catch (e) {
        (0, types_1.log)('info', `Trace summary skipped: ${e.message}`);
    }
    return summary;
}
/** sshExec but with configurable timeout for long operations (trace capture, downloads) */
function sshExecLong(c, cmd, timeoutMs) {
    if (c.password) {
        const hasSshpass = (() => { try {
            (0, child_process_1.execSync)('which sshpass 2>/dev/null', { stdio: 'pipe' });
            return true;
        }
        catch {
            return false;
        } })();
        if (hasSshpass) {
            return (0, child_process_1.execSync)(`SSHPASS='${escSh(c.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${c.port} ${escSh(c.user)}@${escSh(c.host)} ${cmd}`, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
        }
    }
    return (0, ssh_1.sshExec)(c, cmd);
}
/** SCP pull: download file from remote to local */
function scpPull(c, remote, local) {
    const hasSshpass = (() => { try {
        (0, child_process_1.execSync)('which sshpass 2>/dev/null', { stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    } })();
    if (hasSshpass && c.password) {
        (0, child_process_1.execSync)(`SSHPASS='${escSh(c.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${c.port} "${escSh(c.user)}@${escSh(c.host)}:${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
        return;
    }
    if (!c.password) {
        (0, child_process_1.execSync)(`scp -o StrictHostKeyChecking=no -P ${c.port} ${escSh(c.user)}@${escSh(c.host)}:"${remote}" "${local}"`, { timeout: 60000, encoding: 'utf8' });
        return;
    }
    // ssh2 SFTP fallback for password auth without sshpass
    const { Client } = require('ssh2');
    const chunks = [];
    let error = '', done = false;
    const conn = new Client();
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
        throw new Error(`SCP pull failed: ${error}`);
    fs.writeFileSync(local, Buffer.concat(chunks));
}
/** Capture a Perfetto trace from the remote target. Deploys tracebox if needed. */
function traceCapture(c, opts) {
    // Step 1: Ensure tracebox exists on remote
    let exists = false;
    try {
        const out = (0, ssh_1.sshExec)(c, `"test -x ${REMOTE_TRACEBOX} && echo yes || echo no"`);
        exists = out.includes('yes');
    }
    catch { }
    if (!exists) {
        (0, types_1.log)('info', 'Downloading tracebox on remote (first time, ~20MB)...');
        sshExecLong(c, `"curl -fsSL -o ${REMOTE_TRACEBOX} https://get.perfetto.dev/tracebox && chmod +x ${REMOTE_TRACEBOX}"`, 120000);
        (0, types_1.log)('info', 'tracebox downloaded on remote');
    }
    // Step 2: Auto-detect GPU events on remote
    let gpuEvents = [];
    if (!opts.events) {
        gpuEvents = detectGpuEvents(c, !!opts.sudo, opts.sudoPwd);
    }
    // Step 3: Write trace config to remote (via base64 to avoid shell escaping hell)
    let events = opts.events || 'sched/sched_switch sched/sched_waking sched/sched_process_exec sched/sched_process_fork sched/sched_process_exit sched/sched_wakeup_new';
    if (gpuEvents.length > 0) {
        events += ' ' + gpuEvents.join(' ');
        (0, types_1.log)('info', `Including GPU events: ${gpuEvents.join(' ')}`);
    }
    const config = buildTraceConfig(opts.durationSec, events);
    const configB64 = Buffer.from(config).toString('base64');
    (0, ssh_1.sshExec)(c, `"echo ${configB64} | base64 -d > ${REMOTE_TRACE_CFG}"`);
    // Step 4: Run trace capture with config file
    // Use --background so we can start the target command AFTER the trace begins.
    // This ensures process exec/fork events are captured.
    const maybeStartCmd = opts.startCmd
        ? `sleep 1 && ${opts.startCmd}`
        : '';
    let cmd = `${REMOTE_TRACEBOX} -c ${REMOTE_TRACE_CFG} --txt -o ${REMOTE_TRACE_FILE} --background`;
    // Build the full remote command: start trace in background, then optionally run startCmd
    let remoteCmd;
    if (maybeStartCmd) {
        remoteCmd = `${cmd} && ${maybeStartCmd} && sleep ${opts.durationSec}`;
    }
    else {
        remoteCmd = `${cmd} && sleep ${opts.durationSec}`;
    }
    if (opts.sudo && opts.sudoPwd) {
        remoteCmd = `echo '${escSh(opts.sudoPwd)}' | sudo -S sh -c '${remoteCmd.replace(/'/g, "'\\''")}'`;
    }
    else if (opts.sudo) {
        remoteCmd = `sudo sh -c '${remoteCmd.replace(/'/g, "'\\''")}'`;
    }
    (0, types_1.log)('info', `Capturing trace for ${opts.durationSec}s on ${c.host}...`);
    if (opts.startCmd) {
        (0, types_1.log)('info', `Running start command: ${opts.startCmd}`);
    }
    sshExecLong(c, `"${remoteCmd} 2>&1"`, (opts.durationSec + 60) * 1000);
    // If run with sudo, fix permissions so we can scp the file back
    if (opts.sudo) {
        const chownCmd = opts.sudoPwd
            ? `echo '${escSh(opts.sudoPwd)}' | sudo -S chmod 644 ${REMOTE_TRACE_FILE}`
            : `sudo chmod 644 ${REMOTE_TRACE_FILE}`;
        try {
            (0, ssh_1.sshExec)(c, `"${chownCmd}"`);
        }
        catch { }
    }
    (0, types_1.log)('info', 'Trace capture complete, fetching file...');
    // Step 5: Pull trace file from remote
    scpPull(c, REMOTE_TRACE_FILE, opts.outputPath);
    // Step 6: Clean up remote temp files
    const rmCmd = opts.sudo
        ? (opts.sudoPwd ? `echo '${escSh(opts.sudoPwd)}' | sudo -S rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}` : `sudo rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}`)
        : `rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}`;
    try {
        (0, ssh_1.sshExec)(c, `"${rmCmd}"`);
    }
    catch { }
    const sizeBytes = fs.statSync(opts.outputPath).size;
    (0, types_1.log)('info', `Trace saved: ${opts.outputPath} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    // Step 7: Run automated trace summary
    const summary = runTraceSummary(opts.outputPath);
    return {
        output: opts.outputPath,
        sizeBytes,
        remoteHost: c.host,
        durationSec: opts.durationSec,
        summary,
    };
}
