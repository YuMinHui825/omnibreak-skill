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
function buildTraceConfig(durationSec, events, heapProfile) {
    const eventList = events.split(' ').filter(e => e).map(e => `      ftrace_events: "${e}"`).join('\n');
    const parts = [
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
    ];
    if (heapProfile) {
        parts.push('data_sources {', '  config {', '    name: "android.heapprofd"', '    heapprofd_config {', `      process_cmdline: "${heapProfile}"`, '      sampling_interval_bytes: 4096', '      block_client: true', '    }', '  }', '}');
    }
    parts.push('data_sources {', '  config {', '    name: "linux.system_info"', '  }', '}', `duration_ms: ${durationSec * 1000}`);
    return parts.join('\n');
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
    perf_stats: "SELECT COUNT(*) AS total_samples, " +
        "COUNT(DISTINCT callsite_id) AS unique_stacks " +
        "FROM perf_sample WHERE callsite_id IS NOT NULL",
    perf_top_frames: "SELECT id, name FROM stack_profile_frame LIMIT 10",
    // heapprofd: allocation hotspots by size (native heap profiling)
    heap_alloc_size: "SELECT f.name, SUM(a.size) AS total_bytes, COUNT(*) AS alloc_count " +
        "FROM heap_profile_allocation a " +
        "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
        "JOIN stack_profile_frame f ON c.frame_id = f.id " +
        "WHERE f.name IS NOT NULL GROUP BY f.name " +
        "ORDER BY total_bytes DESC LIMIT 15",
    heap_alloc_count: "SELECT f.name, COUNT(*) AS alloc_count, SUM(a.size) AS total_bytes " +
        "FROM heap_profile_allocation a " +
        "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
        "JOIN stack_profile_frame f ON c.frame_id = f.id " +
        "WHERE f.name IS NOT NULL GROUP BY f.name " +
        "ORDER BY alloc_count DESC LIMIT 15",
    heap_top_stacks: "SELECT f.name, spf_row.name AS caller, SUM(a.size) AS total_bytes " +
        "FROM heap_profile_allocation a " +
        "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
        "JOIN stack_profile_frame f ON c.frame_id = f.id " +
        "LEFT JOIN stack_profile_callsite pc ON c.parent_id = pc.id " +
        "LEFT JOIN stack_profile_frame spf_row ON pc.frame_id = spf_row.id " +
        "WHERE f.name IS NOT NULL GROUP BY f.name, spf_row.name " +
        "ORDER BY total_bytes DESC LIMIT 20",
    // Detailed: per-function CPU samples (flame graph data)
    flame_functions: "SELECT f.name, COUNT(*) AS samples " +
        "FROM perf_sample p " +
        "JOIN stack_profile_callsite c ON p.callsite_id = c.id " +
        "JOIN stack_profile_frame f ON c.frame_id = f.id " +
        "WHERE f.name IS NOT NULL " +
        "GROUP BY f.name ORDER BY samples DESC LIMIT 20",
    // Memory timeline: RSS at 1s intervals
    memory_timeline: "SELECT p.name, CAST(c.ts/1e9 AS INT) AS sec, MAX(CAST(c.value AS INT))/1024 AS rss_kb " +
        "FROM counter c " +
        "JOIN process_counter_track t ON c.track_id = t.id " +
        "JOIN process p USING (upid) " +
        "WHERE t.name='rss' " +
        "GROUP BY p.upid, CAST(c.ts/1e9 AS INT) " +
        "ORDER BY sec LIMIT 60",
    // CPU frequency distribution
    cpu_freq: "SELECT CAST(freq/1000 AS INT) AS freq_mhz, COUNT(*) AS samples, " +
        "SUM(dur)/1e6 AS total_ms " +
        "FROM actual_freq " +
        "GROUP BY freq_mhz ORDER BY total_ms DESC LIMIT 10",
    // Syscall analysis
    syscalls: "SELECT name, COUNT(*) AS count, SUM(dur)/1e6 AS total_ms " +
        "FROM raw " +
        "JOIN thread USING (utid) " +
        "WHERE name LIKE 'sys_%' " +
        "GROUP BY name ORDER BY count DESC LIMIT 15",
    // Wakeup latency
    wakeup_latency: "SELECT name, AVG(waker_dur)/1e3 AS avg_wakeup_us, COUNT(*) AS wakeups " +
        "FROM sched JOIN thread ON sched.waker_utid = thread.utid " +
        "WHERE waker_dur > 0 " +
        "GROUP BY sched.waker_utid ORDER BY avg_wakeup_us DESC LIMIT 10",
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
/** Render trace summary into AI-friendly natural language text */
function renderTraceNarrative(summary) {
    const lines = [];
    if (summary.top_cpu_threads && Array.isArray(summary.top_cpu_threads)) {
        const rows = summary.top_cpu_threads;
        if (rows.length > 0) {
            lines.push('=== CPU Hotspots ===');
            rows.slice(0, 5).forEach((r, i) => {
                const parts = r.trim().split(/\s+/);
                const cpu = parts[parts.length - 1];
                const name = parts.slice(0, -1).join(' ');
                lines.push(`  ${i + 1}. ${name}: ${parseFloat(cpu).toFixed(0)}ms CPU`);
            });
        }
    }
    if (summary.thread_states && Array.isArray(summary.thread_states)) {
        const rows = summary.thread_states;
        if (rows.length > 0) {
            lines.push('\n=== Thread Activity ===');
            const stateLabel = { R: 'Running', S: 'Sleeping', D: 'Blocked(IO)', Z: 'Zombie', T: 'Stopped' };
            rows.slice(0, 8).forEach(r => {
                const parts = r.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const dur = parts[parts.length - 2];
                    const state = parts[parts.length - 3];
                    const name = parts.slice(0, -3).join(' ');
                    lines.push(`  ${name}: ${parseFloat(dur).toFixed(0)}ms ${stateLabel[state] || state}`);
                }
            });
        }
    }
    if (summary.io_wait && Array.isArray(summary.io_wait) && summary.io_wait.length > 0) {
        lines.push('\n=== IO Bottlenecks ===');
        summary.io_wait.slice(0, 5).forEach(r => {
            const parts = r.trim().split(/\s+/);
            lines.push(`  ${parts.slice(0, -1).join(' ')}: ${parseFloat(parts[parts.length - 1]).toFixed(0)}ms IO wait`);
        });
    }
    else {
        lines.push('\n=== IO Bottlenecks ===\n  None detected');
    }
    if (summary.scheduling_latency && Array.isArray(summary.scheduling_latency)) {
        const row = summary.scheduling_latency[0];
        if (row) {
            const parts = row.trim().split(/\s+/);
            if (parts.length >= 3) {
                lines.push(`\n=== Scheduling ===\n  Avg slice: ${parseFloat(parts[0]).toFixed(2)}ms, Max: ${parseFloat(parts[1]).toFixed(2)}ms, Switches: ${parts[2]}`);
            }
        }
    }
    if (summary.process_rss && Array.isArray(summary.process_rss)) {
        const rows = summary.process_rss;
        if (rows.length > 0) {
            lines.push('\n=== Memory (Peak RSS) ===');
            rows.slice(0, 5).forEach(r => {
                const parts = r.trim().split(/\s+/);
                lines.push(`  ${parts.slice(0, -1).join(' ')}: ${parts[parts.length - 1]}MB`);
            });
        }
    }
    if (summary.perf_stats && Array.isArray(summary.perf_stats)) {
        const row = summary.perf_stats[0];
        if (row) {
            const parts = row.trim().split(/\s+/);
            if (parts.length >= 2) {
                lines.push(`\n=== CPU Sampling ===\n  ${parts[0]} samples, ${parts[1]} unique call stacks`);
            }
        }
    }
    // Heap profiling (heapprofd): allocation hotspots with callstacks
    if (summary.heap_alloc_size && Array.isArray(summary.heap_alloc_size) && summary.heap_alloc_size.length > 0) {
        lines.push('\n=== Heap Allocations (by size) ===');
        summary.heap_alloc_size.slice(0, 8).forEach((r, i) => {
            const parts = r.trim().split(/\s+/);
            if (parts.length >= 3) {
                const bytes = parts[parts.length - 2];
                const count = parts[parts.length - 1];
                const func = parts.slice(0, -2).join(' ');
                const fmt = (parseInt(bytes) >= 1048576) ? `${(parseInt(bytes) / 1048576).toFixed(1)}MB`
                    : (parseInt(bytes) >= 1024) ? `${(parseInt(bytes) / 1024).toFixed(0)}KB` : `${bytes}B`;
                lines.push(`  ${i + 1}. ${func}: ${fmt} in ${count} allocs`);
            }
        });
    }
    if (summary.heap_top_stacks && Array.isArray(summary.heap_top_stacks) && summary.heap_top_stacks.length > 0) {
        lines.push('\n=== Heap Leak Traces ===');
        const stacks = summary.heap_top_stacks;
        const seen = new Set();
        let shown = 0;
        stacks.forEach(r => {
            if (shown >= 5)
                return;
            const parts = r.trim().split(/\s+/);
            if (parts.length >= 3) {
                const func = parts[0];
                if (seen.has(func))
                    return;
                seen.add(func);
                shown++;
                const bytes = parts[parts.length - 1];
                const caller = parts.length > 3 ? parts.slice(1, -1).join(' ') : '(root)';
                const fmt = (parseInt(bytes) >= 1048576) ? `${(parseInt(bytes) / 1048576).toFixed(1)}MB`
                    : (parseInt(bytes) >= 1024) ? `${(parseInt(bytes) / 1024).toFixed(0)}KB` : `${bytes}B`;
                lines.push(`  ${func} ← ${caller}: ${fmt}`);
            }
        });
    }
    // Detailed flame graph: per-function CPU samples
    if (summary.flame_functions && Array.isArray(summary.flame_functions)) {
        const rows = summary.flame_functions;
        if (rows.length > 0) {
            const total = rows.reduce((sum, r) => { const v = parseInt(r.trim().split(/\s+/).pop() || '0'); return sum + v; }, 0);
            lines.push('\n=== Flame Graph (CPU samples per function) ===');
            rows.slice(0, 10).forEach((r, i) => {
                const parts = r.trim().split(/\s+/);
                const samples = parseInt(parts[parts.length - 1]) || 0;
                const func = parts.slice(0, -1).join(' ');
                const pct = total > 0 ? ((samples / total) * 100).toFixed(1) : '0';
                lines.push(`  ${i + 1}. ${func}: ${samples} samples (${pct}%)`);
            });
        }
    }
    // Memory timeline
    if (summary.memory_timeline && Array.isArray(summary.memory_timeline)) {
        const rows = summary.memory_timeline;
        if (rows.length >= 2) {
            lines.push('\n=== Memory Timeline (RSS over time) ===');
            // Group by process
            const byProcess = {};
            rows.forEach(r => {
                const parts = r.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const proc = parts[0];
                    const rss = parseInt(parts[parts.length - 1]) || 0;
                    if (!byProcess[proc])
                        byProcess[proc] = [];
                    byProcess[proc].push(rss);
                }
            });
            for (const [proc, vals] of Object.entries(byProcess)) {
                const min = Math.min(...vals) / 1024;
                const max = Math.max(...vals) / 1024;
                const avg = vals.reduce((a, b) => a + b, 0) / vals.length / 1024;
                const trend = vals[vals.length - 1] > vals[0] * 1.05 ? '↑ growing' : vals[vals.length - 1] < vals[0] * 0.95 ? '↓ shrinking' : '→ stable';
                lines.push(`  ${proc}: min ${min.toFixed(0)}MB, avg ${avg.toFixed(0)}MB, max ${max.toFixed(0)}MB [${trend}]`);
            }
        }
    }
    // CPU frequency
    if (summary.cpu_freq && Array.isArray(summary.cpu_freq)) {
        const rows = summary.cpu_freq;
        if (rows.length > 0) {
            lines.push('\n=== CPU Frequency ===');
            rows.slice(0, 5).forEach(r => {
                const parts = r.trim().split(/\s+/);
                if (parts.length >= 3) {
                    lines.push(`  ${parts[0]}MHz: ${parseFloat(parts[2]).toFixed(0)}ms (${parts[1]} samples)`);
                }
            });
        }
    }
    // Syscall analysis
    if (summary.syscalls && Array.isArray(summary.syscalls)) {
        const rows = summary.syscalls;
        if (rows.length > 0) {
            lines.push('\n=== Top Syscalls ===');
            rows.slice(0, 8).forEach((r, i) => {
                const parts = r.trim().split(/\s+/);
                if (parts.length >= 3) {
                    const count = parts[parts.length - 2];
                    const ms = parts[parts.length - 1];
                    const name = parts.slice(0, -2).join(' ');
                    lines.push(`  ${i + 1}. ${name}: ${count} calls, ${parseFloat(ms).toFixed(1)}ms`);
                }
            });
        }
    }
    // Wakeup latency
    if (summary.wakeup_latency && Array.isArray(summary.wakeup_latency)) {
        const rows = summary.wakeup_latency;
        if (rows.length > 0) {
            lines.push('\n=== Wakeup Latency ===');
            rows.slice(0, 5).forEach(r => {
                const parts = r.trim().split(/\s+/);
                if (parts.length >= 3) {
                    lines.push(`  ${parts.slice(0, -2).join(' ')}: avg ${parseFloat(parts[parts.length - 2]).toFixed(0)}us, ${parts[parts.length - 1]} wakeups`);
                }
            });
        }
    }
    return lines.join('\n') || 'No significant findings in this trace.';
}
function runTraceSummary(traceFile) {
    const summary = {};
    try {
        const tp = ensureTraceProcessor();
        for (const [key, sql] of Object.entries(SUMMARY_SQL)) {
            try {
                const b64 = Buffer.from(sql).toString('base64');
                // base64 --decode works on both Linux and macOS (base64 -d is Linux-only)
                const out = (0, child_process_1.execSync)(`echo ${b64} | base64 --decode | ${tp} "${traceFile}" 2>/dev/null`, {
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
    const config = buildTraceConfig(opts.durationSec, events, opts.heapProfile);
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
    // Step 7: Run automated trace summary + narrative
    const summary = runTraceSummary(opts.outputPath);
    const narrative = renderTraceNarrative(summary);
    (0, types_1.log)('info', `\n${narrative}`);
    return {
        output: opts.outputPath,
        sizeBytes,
        remoteHost: c.host,
        durationSec: opts.durationSec,
        summary,
        narrative,
    };
}
