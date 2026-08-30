import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SshConfig, sshExec, sshExecSafe, scpDeploy } from '../shared/ssh';
import { log, TraceCaptureResult } from '../shared/types';

const REMOTE_TRACEBOX = '/tmp/omnibreak-tracebox';
const REMOTE_TRACE_FILE = '/tmp/omnibreak-trace.pftrace';
const REMOTE_TRACE_CFG = '/tmp/omnibreak-trace.cfg';

function escSh(s: string): string { return s.replace(/'/g, "'\\''"); }

/** GPU ftrace event directories to probe. Key is the directory name, value is the primary event to enable. */
const GPU_PROBES: Record<string, string> = {
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

/**
 * Probe which `subsystem/event` ftrace tracepoints exist on the target kernel in a single
 * SSH round-trip. Used to enable only the I/O/GPU events the kernel actually supports.
 */
function probeAvailableEvents(c: SshConfig, sudo: boolean, sudoPwd?: string): Set<string> {
  const present = new Set<string>();
  // Raw `sshExec` would let the LOCAL shell (execSync → /bin/sh) re-expand `${d%/}`,
  // `"$s/$e"` etc. from the script before it ever reaches ssh — silently emptying the
  // variable expressions and returning garbage. `sshExecSafe` base64-encodes the whole
  // command end-to-end, so the script is decoded verbatim on the target. Run through
  // `sudo -S` only when asked (tracefs event listing usually works unprivileged).
  const script =
    'for d in /sys/kernel/tracing/events/*/; do s=${d%/}; s=${s##*/}; ' +
    'for e in "${d}"*/; do e=${e%/}; e=${e##*/}; echo "$s/$e"; done; done';
  const cmd = sudo
    ? `echo '${sudoPwd ? escSh(sudoPwd) : ''}' | sudo -S sh -c '${script}' 2>/dev/null`
    : script;
  try {
    const out = sshExecSafe(c, cmd);
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (t) present.add(t);
    }
  } catch (err) {
    log('info', `Event probe failed: ${(err as Error).message}`);
  }
  return present;
}

/** Detect available GPU ftrace events on the remote target */
function detectGpuEvents(present: Set<string>): string[] {
  const events: string[] = [];
  for (const [dir, event] of Object.entries(GPU_PROBES)) {
    if (present.has(dir) || present.has(event)) {
      events.push(event);
      log('info', `Detected GPU: ${dir} (${event})`);
    }
  }
  return events;
}

/** Default ftrace events: scheduling + process lifecycle. `sched_blocked_reason` (populates
 * `thread_state.blocked_function`) and the I/O events are probed for availability and appended
 * at capture time — some kernels (e.g. 5.15) lack sched_blocked_reason or name the page-cache
 * event `mm_filemap_add_to_page_cache` instead of `filemap_add_to_page_cache`. */
const DEFAULT_EVENTS =
  'sched/sched_switch sched/sched_waking sched/sched_wakeup sched/sched_process_exec ' +
  'sched/sched_process_fork sched/sched_process_exit sched/sched_wakeup_new ' +
  'power/cpu_frequency power/cpu_idle';

/** Optional I/O-analysis events — enabled only when present on the target kernel. */
const IO_EVENT_CANDIDATES = [
  'sched/sched_blocked_reason',                                   // D-state cause (blocked_function)
  'block/block_rq_issue',                                         // block request size / mix
  'filemap/filemap_add_to_page_cache', 'filemap/mm_filemap_add_to_page_cache', // file behind I/O
];

/** Build a Perfetto text config that includes ftrace + process snapshot */
function buildTraceConfig(durationSec: number, events: string, heapProfile?: string): string {
  const eventList = events.split(' ').filter(e => e).map(e => `      ftrace_events: "${e}"`).join('\n');
  // RING_BUFFER + 64MB so 100Hz perf sampling + ftrace don't overflow during long captures.
  const parts = [
    'buffers { size_kb: 65536 fill_policy: RING_BUFFER }',
    'data_sources {',
    '  config {',
    '    name: "linux.ftrace"',
    '    ftrace_config {',
    eventList,
    '      buffer_size_kb: 4096',
    '    }',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "linux.perf"',
    '    perf_event_config {',
    '      timebase { frequency: 100 }',
    '      callstack_sampling { scope { } }',
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
    parts.push(
      'data_sources {',
      '  config {',
      '    name: "android.heapprofd"',
      '    heapprofd_config {',
      `      process_cmdline: "${heapProfile}"`,
      '      sampling_interval_bytes: 4096',
      '      block_client: true',
      '    }',
      '  }',
      '}',
    );
  }
  parts.push(
    'data_sources {',
    '  config {',
    '    name: "linux.system_info"',
    '  }',
    '}',
    `duration_ms: ${durationSec * 1000}`,
  );
  return parts.join('\n');
}

const SUMMARY_SQL: Record<string, string> = {
  top_cpu_threads:
    "SELECT name, SUM(dur)/1e6 AS cpu_ms FROM sched " +
    "JOIN thread USING (utid) " +
    "GROUP BY utid ORDER BY cpu_ms DESC LIMIT 10",
  thread_states:
    "SELECT name, end_state, SUM(dur)/1e6 AS dur_ms, COUNT(*) AS switches " +
    "FROM sched JOIN thread USING (utid) " +
    "GROUP BY utid, end_state ORDER BY dur_ms DESC LIMIT 20",
  io_wait:
    "SELECT name, SUM(dur)/1e6 AS io_wait_ms FROM sched " +
    "JOIN thread USING (utid) WHERE end_state='D' " +
    "GROUP BY utid ORDER BY io_wait_ms DESC LIMIT 10",
  scheduling_latency:
    "SELECT AVG(dur)/1e6 AS avg_slice_ms, MAX(dur)/1e6 AS max_slice_ms, " +
    "COUNT(*) AS total_switches FROM sched",
  process_rss:
    "SELECT name, MAX(CAST(value AS INT))/1024 AS peak_rss_mb " +
    "FROM counter JOIN process_counter_track ON counter.track_id = process_counter_track.id " +
    "JOIN process USING (upid) " +
    "WHERE process_counter_track.name='rss' GROUP BY upid ORDER BY peak_rss_mb DESC LIMIT 10",
  perf_stats:
    "SELECT COUNT(*) AS total_samples, " +
    "COUNT(DISTINCT callsite_id) AS unique_stacks " +
    "FROM perf_sample WHERE callsite_id IS NOT NULL",
  perf_top_frames:
    "SELECT id, name FROM stack_profile_frame LIMIT 10",
  // heapprofd: allocation hotspots by size (native heap profiling)
  heap_alloc_size:
    "SELECT f.name, SUM(a.size) AS total_bytes, COUNT(*) AS alloc_count " +
    "FROM heap_profile_allocation a " +
    "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
    "JOIN stack_profile_frame f ON c.frame_id = f.id " +
    "WHERE f.name IS NOT NULL GROUP BY f.name " +
    "ORDER BY total_bytes DESC LIMIT 15",
  heap_alloc_count:
    "SELECT f.name, COUNT(*) AS alloc_count, SUM(a.size) AS total_bytes " +
    "FROM heap_profile_allocation a " +
    "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
    "JOIN stack_profile_frame f ON c.frame_id = f.id " +
    "WHERE f.name IS NOT NULL GROUP BY f.name " +
    "ORDER BY alloc_count DESC LIMIT 15",
  heap_top_stacks:
    "SELECT f.name, spf_row.name AS caller, SUM(a.size) AS total_bytes " +
    "FROM heap_profile_allocation a " +
    "JOIN stack_profile_callsite c ON a.callsite_id = c.id " +
    "JOIN stack_profile_frame f ON c.frame_id = f.id " +
    "LEFT JOIN stack_profile_callsite pc ON c.parent_id = pc.id " +
    "LEFT JOIN stack_profile_frame spf_row ON pc.frame_id = spf_row.id " +
    "WHERE f.name IS NOT NULL GROUP BY f.name, spf_row.name " +
    "ORDER BY total_bytes DESC LIMIT 20",
  // Detailed: per-function CPU samples (flame graph data)
  flame_functions:
    "SELECT f.name, COUNT(*) AS samples " +
    "FROM perf_sample p " +
    "JOIN stack_profile_callsite c ON p.callsite_id = c.id " +
    "JOIN stack_profile_frame f ON c.frame_id = f.id " +
    "WHERE f.name IS NOT NULL " +
    "GROUP BY f.name ORDER BY samples DESC LIMIT 20",
  // Memory timeline: RSS at 1s intervals
  memory_timeline:
    "SELECT p.name, CAST(c.ts/1e9 AS INT) AS sec, MAX(CAST(c.value AS INT))/1024 AS rss_kb " +
    "FROM counter c " +
    "JOIN process_counter_track t ON c.track_id = t.id " +
    "JOIN process p USING (upid) " +
    "WHERE t.name='rss' " +
    "GROUP BY p.upid, CAST(c.ts/1e9 AS INT) " +
    "ORDER BY sec LIMIT 60",
  // CPU frequency distribution
  cpu_freq:
    "SELECT CAST(freq/1000 AS INT) AS freq_mhz, COUNT(*) AS samples, " +
    "SUM(dur)/1e6 AS total_ms " +
    "FROM actual_freq " +
    "GROUP BY freq_mhz ORDER BY total_ms DESC LIMIT 10",
  // Syscall analysis
  syscalls:
    "SELECT name, COUNT(*) AS count, SUM(dur)/1e6 AS total_ms " +
    "FROM raw " +
    "JOIN thread USING (utid) " +
    "WHERE name LIKE 'sys_%' " +
    "GROUP BY name ORDER BY count DESC LIMIT 15",
  // Wakeup latency
  wakeup_latency:
    "SELECT name, AVG(waker_dur)/1e3 AS avg_wakeup_us, COUNT(*) AS wakeups " +
    "FROM sched JOIN thread ON sched.waker_utid = thread.utid " +
    "WHERE waker_dur > 0 " +
    "GROUP BY sched.waker_utid ORDER BY avg_wakeup_us DESC LIMIT 10",
  // I/O cause analysis: D-state (uninterruptible sleep) grouped by the kernel function the
  // thread was blocked in (populated by the sched_blocked_reason ftrace event).
  blocked_function:
    "SELECT thread.name, thread_state.blocked_function, " +
    "SUM(thread_state.dur)/1e6 AS blocked_ms, COUNT(*) AS count " +
    "FROM thread_state JOIN thread USING (utid) " +
    "WHERE thread_state.state = 'D' AND thread_state.blocked_function IS NOT NULL " +
    "GROUP BY thread_state.utid, thread_state.blocked_function " +
    "ORDER BY blocked_ms DESC LIMIT 15",
  // Page-fault driven I/O contention (cold-start indicator): blocked on do_page_fault.
  page_fault:
    "SELECT thread.name, SUM(thread_state.dur)/1e6 AS pf_ms, COUNT(*) AS count " +
    "FROM thread_state JOIN thread USING (utid) " +
    "WHERE thread_state.state = 'D' AND ( " +
    "  thread_state.blocked_function GLOB 'do_page_fault*' OR " +
    "  thread_state.blocked_function GLOB 'handle_mm_fault*') " +
    "GROUP BY thread_state.utid ORDER BY pf_ms DESC LIMIT 10",
  // Block-layer I/O requests by operation type and size (from block_rq_issue ftrace).
  block_io_issue:
    "SELECT EXTRACT_ARG(raw.arg_set_id, 'rwbs') AS op, COUNT(*) AS count, " +
    "SUM(EXTRACT_ARG(raw.arg_set_id, 'bytes'))/1048576 AS total_mb, " +
    "AVG(EXTRACT_ARG(raw.arg_set_id, 'nr_sector')) AS avg_sectors " +
    "FROM raw WHERE raw.name = 'block_rq_issue' " +
    "GROUP BY op ORDER BY count DESC LIMIT 10",
  // Page-cache additions by inode — pinpoints the file causing I/O pressure.
  // GLOB matches both the modern `filemap_add_to_page_cache` and the older
  // `mm_filemap_add_to_page_cache` event name (kernel ≤ 5.x).
  file_io_cache:
    "SELECT EXTRACT_ARG(raw.arg_set_id, 's_dev') AS dev, " +
    "EXTRACT_ARG(raw.arg_set_id, 'inode') AS inode, COUNT(*) AS count " +
    "FROM raw WHERE raw.name GLOB '*filemap_add_to_page_cache*' " +
    "GROUP BY dev, inode ORDER BY count DESC LIMIT 12",
};

function ensureTraceProcessor(): string {
  const paths = [
    path.join(os.homedir(), '.cache', 'omnibreak', 'trace_processor'),
    '/tmp/trace_processor',
  ];
  for (const p of paths) { if (fs.existsSync(p)) return p; }

  const dest = path.join(os.homedir(), '.cache', 'omnibreak', 'trace_processor');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log('info', 'Downloading trace_processor...');
  execSync(`curl -fsSL -o "${dest}" https://get.perfetto.dev/trace_processor && chmod +x "${dest}"`, { timeout: 120000 });
  return dest;
}

/** Helper: parse "name a b c ..." style result rows into a list of values, joining the
 * (possibly space-containing) leading name token. */
function rowValues(row: string): string[] {
  return row.trim().split(/\s+/).filter(Boolean);
}
function rowName(parts: string[], valueCount: number): string {
  return parts.slice(0, -valueCount).join(' ') || '?';
}

/**
 * Detect actionable I/O problems from the trace summary and produce concrete
 * recommendations (mirrors the "hints" model of Google's Perfetto profiler skill):
 * a specific signal → what it means → what to change in your code.
 */
function computeHints(summary: Record<string, any>): string[] {
  const hints: string[] = [];

  // 1. D-state with a disk-I/O blocked_function → synchronous read advice.
  const bf = summary.blocked_function;
  if (Array.isArray(bf) && bf.length > 0) {
    const diskSignals = ['page_cache_readahead', 'wait_on_page_bit', 'filemap', 'submit_bio', 'blk_', '_read', '_write'];
    for (const row of bf.slice(0, 5)) {
      const p = rowValues(row);
      if (p.length < 3) continue;
      const fn = p[p.length - 3];
      const ms = parseFloat(p[p.length - 2]) || 0;
      if (ms > 50 && diskSignals.some(k => fn.includes(k))) {
        hints.push(`线程「${rowName(p, 3)}」在 D 状态（不可中断睡眠）阻塞 ${fmtMs(ms)}，blocked_function=${fn} —— 疑似磁盘同步读。建议：避免关键线程同步读文件，加大读取 buffer，或将读取移到后台线程。`);
      }
    }
  }

  // 2. Heavy page-fault blocking → cold-start / I/O contention.
  const pf = summary.page_fault;
  if (Array.isArray(pf) && pf.length > 0) {
    const p = rowValues(pf[0]);
    if (p.length >= 2) {
      const ms = parseFloat(p[p.length - 2]) || 0;
      if (ms > 200) {
        hints.push(`执行路径缺页等待 ${fmtMs(ms)} —— 代码页/文件页不在内存（冷启动特征）。建议：减少启动路径上的文件访问、大文件扫描和延迟加载不必要模块。`);
      }
    }
  }

  // 3. Block I/O dominated by small requests → fragmented reads.
  const bio = summary.block_io_issue;
  if (Array.isArray(bio) && bio.length > 0) {
    for (const row of bio.slice(0, 3)) {
      const p = rowValues(row);
      if (p.length < 4) continue;
      const count = parseInt(p[1]) || 0;
      const avgSectors = parseFloat(p[3]) || 0;
      if (avgSectors > 0 && avgSectors < 16 && count > 100) {
        hints.push(`检测到 ${count} 次小块 I/O（平均 ${avgSectors} 扇区 ≈ ${(avgSectors * 512 / 1024).toFixed(0)}KB，op=${p[0]}）—— 小缓冲碎读会把 I/O 打满。建议：加大读取 buffer 或用大块顺序读。`);
      }
    }
  }

  // 4. D-state present but blocked_function missing → recording gap.
  const ioWait = summary.io_wait;
  if (Array.isArray(ioWait) && ioWait.length > 0 && (!Array.isArray(bf) || bf.length === 0)) {
    hints.push('检测到 D 状态但未捕获 blocked_function —— 本次 trace 可能缺少 sched/sched_blocked_reason 事件，无法判断阻塞类型。建议补录该事件后重试。');
  }

  return hints;
}

/**
 * Ensure a WORKING tracebox binary exists on the remote target. `get.perfetto.dev/tracebox`
 * returns a small python launcher that downloads the real binary from Google's storage on
 * first run — which fails on targets that can't reach that CDN. So after grabbing the
 * launcher we force the real download, and fall back to the GitHub release (reachable on
 * most networks) when the official CDN is blocked.
 */
function ensureTracebox(c: SshConfig): void {
  // Already a real binary? (--version returns something like "tracebox v58.2 ...").
  try {
    const out = sshExec(c, `"${REMOTE_TRACEBOX} --version 2>&1 | tail -1"`);
    if (/v?\d+\.\d+/.test(out) || out.toLowerCase().includes('tracebox')) return;
  } catch {}

  try {
    log('info', 'Downloading tracebox (get.perfetto.dev)...');
    sshExec(c, `"curl -fsSL -o ${REMOTE_TRACEBOX} https://get.perfetto.dev/tracebox && chmod +x ${REMOTE_TRACEBOX}"`);
    // Force the launcher to fetch the real binary; allow a long first-run download.
    sshExecLong(c, `"${REMOTE_TRACEBOX} --version"`, 240000);
    return;
  } catch {}

  log('info', 'Official tracebox download failed — falling back to GitHub release...');
  const arch = `$(uname -m | grep -q aarch64 && echo arm64 || echo amd64)`;
  const cmd =
    `cd /tmp && rm -f perfetto-rel.zip && ` +
    `curl -fsSL --retry 2 -o perfetto-rel.zip https://github.com/google/perfetto/releases/download/v58.2/linux-${arch}.zip && ` +
    `(unzip -o -q perfetto-rel.zip -d perfetto-rel 2>/dev/null || python3 -c "import zipfile;zipfile.ZipFile('perfetto-rel.zip').extractall('perfetto-rel')") && ` +
    `find perfetto-rel -name tracebox -exec cp {} ${REMOTE_TRACEBOX} \\; && chmod +x ${REMOTE_TRACEBOX} && ` +
    `rm -rf perfetto-rel perfetto-rel.zip`;
  sshExecLong(c, `"${cmd}"`, 300000);
}

/** Parse the tabular stdout of a trace_processor query into trimmed rows (skip header/blank). */
function parseQueryRows(out: string): string[] {
  const rows: string[] = [];
  let started = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('Query executed') || line.startsWith('Error')) continue;
    if (!started && line.includes('---')) { started = true; continue; }
    if (started && line.trim()) rows.push(line.trim());
  }
  return rows;
}

/** Render trace summary into AI-friendly natural language text */
function renderTraceNarrative(summary: Record<string, any>): string {
  const lines: string[] = [];

  if (summary.top_cpu_threads && Array.isArray(summary.top_cpu_threads)) {
    const rows = summary.top_cpu_threads as string[];
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
    const rows = summary.thread_states as string[];
    if (rows.length > 0) {
      lines.push('\n=== Thread Activity ===');
      const stateLabel: Record<string, string> = { R: 'Running', S: 'Sleeping', D: 'Blocked(IO)', Z: 'Zombie', T: 'Stopped' };
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

  if (summary.io_wait && Array.isArray(summary.io_wait) && (summary.io_wait as string[]).length > 0) {
    lines.push('\n=== IO Bottlenecks ===');
    (summary.io_wait as string[]).slice(0, 5).forEach(r => {
      const parts = r.trim().split(/\s+/);
      lines.push(`  ${parts.slice(0, -1).join(' ')}: ${parseFloat(parts[parts.length - 1]).toFixed(0)}ms IO wait`);
    });
  } else {
    lines.push('\n=== IO Bottlenecks ===\n  None detected');
  }

  if (summary.scheduling_latency && Array.isArray(summary.scheduling_latency)) {
    const row = (summary.scheduling_latency as string[])[0];
    if (row) {
      const parts = row.trim().split(/\s+/);
      if (parts.length >= 3) {
        lines.push(`\n=== Scheduling ===\n  Avg slice: ${parseFloat(parts[0]).toFixed(2)}ms, Max: ${parseFloat(parts[1]).toFixed(2)}ms, Switches: ${parts[2]}`);
      }
    }
  }

  if (summary.process_rss && Array.isArray(summary.process_rss)) {
    const rows = summary.process_rss as string[];
    if (rows.length > 0) {
      lines.push('\n=== Memory (Peak RSS) ===');
      rows.slice(0, 5).forEach(r => {
        const parts = r.trim().split(/\s+/);
        lines.push(`  ${parts.slice(0, -1).join(' ')}: ${parts[parts.length - 1]}MB`);
      });
    }
  }

  if (summary.perf_stats && Array.isArray(summary.perf_stats)) {
    const row = (summary.perf_stats as string[])[0];
    if (row) {
      const parts = row.trim().split(/\s+/);
      if (parts.length >= 2) {
        lines.push(`\n=== CPU Sampling ===\n  ${parts[0]} samples, ${parts[1]} unique call stacks`);
      }
    }
  }

  // Heap profiling (heapprofd): allocation hotspots with callstacks
  if (summary.heap_alloc_size && Array.isArray(summary.heap_alloc_size) && (summary.heap_alloc_size as string[]).length > 0) {
    lines.push('\n=== Heap Allocations (by size) ===');
    (summary.heap_alloc_size as string[]).slice(0, 8).forEach((r, i) => {
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
  if (summary.heap_top_stacks && Array.isArray(summary.heap_top_stacks) && (summary.heap_top_stacks as string[]).length > 0) {
    lines.push('\n=== Heap Leak Traces ===');
    const stacks = summary.heap_top_stacks as string[];
    const seen = new Set<string>();
    let shown = 0;
    stacks.forEach(r => {
      if (shown >= 5) return;
      const parts = r.trim().split(/\s+/);
      if (parts.length >= 3) {
        const func = parts[0];
        if (seen.has(func)) return;
        seen.add(func); shown++;
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
    const rows = summary.flame_functions as string[];
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
    const rows = summary.memory_timeline as string[];
    if (rows.length >= 2) {
      lines.push('\n=== Memory Timeline (RSS over time) ===');
      // Group by process
      const byProcess: Record<string, number[]> = {};
      rows.forEach(r => {
        const parts = r.trim().split(/\s+/);
        if (parts.length >= 3) {
          const proc = parts[0];
          const rss = parseInt(parts[parts.length - 1]) || 0;
          if (!byProcess[proc]) byProcess[proc] = [];
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
    const rows = summary.cpu_freq as string[];
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
    const rows = summary.syscalls as string[];
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
    const rows = summary.wakeup_latency as string[];
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

  // Blocked-function breakdown — WHY threads sat in D state (disk? page fault? other).
  if (summary.blocked_function && Array.isArray(summary.blocked_function)) {
    const rows = summary.blocked_function as string[];
    if (rows.length > 0) {
      lines.push('\n=== D-state Blocked On ===');
      rows.slice(0, 8).forEach(r => {
        const p = rowValues(r);
        if (p.length >= 3) {
          const fn = p[p.length - 3];
          const ms = parseFloat(p[p.length - 2]) || 0;
          const count = p[p.length - 1];
          const name = rowName(p, 3);
          const label = fn.includes('do_page_fault') ? 'page-fault (cold start)' : fn;
          lines.push(`  ${name}: ${fmtMs(ms)} in ${count} blocks @ ${label}`);
        }
      });
    }
  }

  // Page-fault driven I/O contention.
  if (summary.page_fault && Array.isArray(summary.page_fault)) {
    const rows = summary.page_fault as string[];
    if (rows.length > 0) {
      lines.push('\n=== Page-Fault I/O ===');
      rows.slice(0, 5).forEach(r => {
        const p = rowValues(r);
        if (p.length >= 2) {
          lines.push(`  ${rowName(p, 2)}: ${fmtMs(parseFloat(p[p.length - 2]) || 0)} page-fault wait (${p[p.length - 1]} events)`);
        }
      });
    }
  }

  // Block-layer request mix — operation type, total bytes, average size.
  if (summary.block_io_issue && Array.isArray(summary.block_io_issue)) {
    const rows = summary.block_io_issue as string[];
    if (rows.length > 0) {
      lines.push('\n=== Block I/O Requests ===');
      rows.slice(0, 6).forEach(r => {
        const p = rowValues(r);
        if (p.length >= 4) {
          const op = p[0], count = p[1], mb = parseFloat(p[2]) || 0, avg = parseFloat(p[3]) || 0;
          lines.push(`  ${op}: ${count} reqs, ${mb.toFixed(1)}MB total, avg ${(avg * 512 / 1024).toFixed(0)}KB`);
        }
      });
    }
  }

  // Page-cache additions by inode — which file is being read into memory.
  if (summary.file_io_cache && Array.isArray(summary.file_io_cache)) {
    const rows = summary.file_io_cache as string[];
    if (rows.length > 0) {
      lines.push('\n=== Files Entering Page Cache ===');
      rows.slice(0, 6).forEach(r => {
        const p = rowValues(r);
        if (p.length >= 3) {
          lines.push(`  dev=${p[0]} inode=${p[1]}: ${p[2]} page-cache additions`);
        }
      });
    }
  }

  // Actionable hints (computed last so all sections above are available).
  const hints = computeHints(summary);
  if (hints.length > 0) {
    lines.push('\n=== Recommendations ===');
    hints.forEach(h => lines.push(`  ▸ ${h}`));
  }

  return lines.join('\n') || 'No significant findings in this trace.';
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

function runTraceSummary(traceFile: string): Record<string, any> {
  const summary: Record<string, any> = {};
  try {
    const tp = ensureTraceProcessor();
    // Prefer a shared background session (parses the trace once, then every query is fast)
    // — supported by trace_processor ≥ v58 (server unix). Fall back to per-query parsing.
    const sessionName = `omnibreak_${path.basename(traceFile).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    let session = false;
    try {
      execSync(`"${tp}" server unix --name "${sessionName}" --daemonize "${traceFile}"`, { stdio: 'ignore', timeout: 60000 });
      session = true;
    } catch {}
    try {
      for (const [key, sql] of Object.entries(SUMMARY_SQL)) {
        try {
          const b64 = Buffer.from(sql).toString('base64');
          // base64 --decode works on both Linux and macOS (base64 -d is Linux-only)
          const q = session
            ? `echo ${b64} | base64 --decode | "${tp}" query --remote "${sessionName}" 2>/dev/null`
            : `echo ${b64} | base64 --decode | "${tp}" "${traceFile}" 2>/dev/null`;
          const out = execSync(q, { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' });
          const rows = parseQueryRows(out);
          if (rows.length > 0) summary[key] = rows;
        } catch { summary[key] = null; }
      }
    } finally {
      if (session) {
        try { execSync(`"${tp}" server kill "${sessionName}"`, { stdio: 'ignore', timeout: 15000 }); } catch {}
      }
    }
  } catch (e: any) {
    log('info', `Trace summary skipped: ${e.message}`);
  }
  return summary;
}

/** sshExec but with configurable timeout for long operations (trace capture, downloads) */
function sshExecLong(c: SshConfig, cmd: string, timeoutMs: number): string {
  if (c.password) {
    const hasSshpass = (() => { try { execSync('which sshpass 2>/dev/null', { stdio: 'pipe' }); return true; } catch { return false; } })();
    if (hasSshpass) {
      return execSync(
        `SSHPASS='${escSh(c.password)}' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${c.port} ${escSh(c.user)}@${escSh(c.host)} ${cmd}`,
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
      );
    }
  }
  return sshExec(c, cmd);
}

/** SCP pull: download file from remote to local */
function scpPull(c: SshConfig, remote: string, local: string): void {
  const hasSshpass = (() => { try { execSync('which sshpass 2>/dev/null', { stdio: 'pipe' }); return true; } catch { return false; } })();
  if (hasSshpass && c.password) {
    execSync(
      `SSHPASS='${escSh(c.password)}' sshpass -e scp -o StrictHostKeyChecking=no -P ${c.port} "${escSh(c.user)}@${escSh(c.host)}:${remote}" "${local}"`,
      { timeout: 60000, encoding: 'utf8' },
    );
    return;
  }
  if (!c.password) {
    execSync(
      `scp -o StrictHostKeyChecking=no -P ${c.port} ${escSh(c.user)}@${escSh(c.host)}:"${remote}" "${local}"`,
      { timeout: 60000, encoding: 'utf8' },
    );
    return;
  }
  // ssh2 SFTP fallback for password auth without sshpass
  const { Client } = require('ssh2');
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
  conn.connect({ host: c.host, port: c.port, username: c.user, password: c.password, readyTimeout: 10000 });
  const start = Date.now();
  while (!done && Date.now() - start < 60000) {
    require('child_process').execSync('sleep 0.1', { stdio: 'ignore' });
  }
  try { conn.end(); } catch {}
  if (error) throw new Error(`SCP pull failed: ${error}`);
  fs.writeFileSync(local, Buffer.concat(chunks));
}

export interface TraceCaptureOptions {
  durationSec: number;
  outputPath: string;
  events?: string;
  sudo?: boolean;
  sudoPwd?: string;
  startCmd?: string;
  heapProfile?: string;
}

/** Capture a Perfetto trace from the remote target. Deploys tracebox if needed. */
export function traceCapture(c: SshConfig, opts: TraceCaptureOptions): TraceCaptureResult {
  // Step 1: Ensure a working tracebox exists on remote (official CDN → GitHub fallback)
  ensureTracebox(c);

  // Step 2: Probe which events the kernel supports, then assemble the event list
  // (base scheduling events always; GPU + I/O-analysis events only when present).
  let events = opts.events || DEFAULT_EVENTS;
  if (!opts.events) {
    const present = probeAvailableEvents(c, !!opts.sudo, opts.sudoPwd);
    const extra = [
      ...detectGpuEvents(present),
      ...IO_EVENT_CANDIDATES.filter(e => present.has(e)),
    ];
    if (extra.length > 0) {
      events += ' ' + extra.join(' ');
      log('info', `Including kernel events: ${extra.join(' ')}`);
    }
    if (!present.has('sched/sched_blocked_reason')) {
      log('info', 'Kernel lacks sched_blocked_reason — D-state cause (blocked_function) will be unavailable.');
    }
  }

  // Step 3: Write trace config to remote (via base64 to avoid shell escaping hell)
  const config = buildTraceConfig(opts.durationSec, events, opts.heapProfile);
  const configB64 = Buffer.from(config).toString('base64');
  sshExec(c, `"echo ${configB64} | base64 -d > ${REMOTE_TRACE_CFG}"`);

  // Step 4: Run trace capture with config file
  // Use --background so we can start the target command AFTER the trace begins.
  // This ensures process exec/fork events are captured.
  const maybeStartCmd = opts.startCmd
    ? `sleep 1 && ${opts.startCmd}`
    : '';
  let cmd = `${REMOTE_TRACEBOX} -c ${REMOTE_TRACE_CFG} --txt -o ${REMOTE_TRACE_FILE} --background`;

  // Build the full remote command: start trace in background, then optionally run startCmd
  let remoteCmd: string;
  if (maybeStartCmd) {
    remoteCmd = `${cmd} && ${maybeStartCmd} && sleep ${opts.durationSec}`;
  } else {
    remoteCmd = `${cmd} && sleep ${opts.durationSec}`;
  }

  if (opts.sudo && opts.sudoPwd) {
    remoteCmd = `echo '${escSh(opts.sudoPwd)}' | sudo -S sh -c '${remoteCmd.replace(/'/g, "'\\''")}'`;
  } else if (opts.sudo) {
    remoteCmd = `sudo sh -c '${remoteCmd.replace(/'/g, "'\\''")}'`;
  }

  log('info', `Capturing trace for ${opts.durationSec}s on ${c.host}...`);
  if (opts.startCmd) {
    log('info', `Running start command: ${opts.startCmd}`);
  }
  sshExecLong(c, `"${remoteCmd} 2>&1"`, (opts.durationSec + 60) * 1000);

  // If run with sudo, fix permissions so we can scp the file back
  if (opts.sudo) {
    const chownCmd = opts.sudoPwd
      ? `echo '${escSh(opts.sudoPwd)}' | sudo -S chmod 644 ${REMOTE_TRACE_FILE}`
      : `sudo chmod 644 ${REMOTE_TRACE_FILE}`;
    try { sshExec(c, `"${chownCmd}"`); } catch {}
  }

  log('info', 'Trace capture complete, fetching file...');

  // Step 5: Pull trace file from remote
  scpPull(c, REMOTE_TRACE_FILE, opts.outputPath);

  // Step 6: Clean up remote temp files
  const rmCmd = opts.sudo
    ? (opts.sudoPwd ? `echo '${escSh(opts.sudoPwd)}' | sudo -S rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}` : `sudo rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}`)
    : `rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}`;
  try { sshExec(c, `"${rmCmd}"`); } catch {}

  const sizeBytes = fs.statSync(opts.outputPath).size;
  log('info', `Trace saved: ${opts.outputPath} (${(sizeBytes / 1024).toFixed(1)} KB)`);

  // Step 7: Run automated trace summary + narrative + actionable hints
  const summary = runTraceSummary(opts.outputPath);
  const narrative = renderTraceNarrative(summary);
  const hints = computeHints(summary);
  log('info', `\n${narrative}`);

  return {
    output: opts.outputPath,
    sizeBytes,
    remoteHost: c.host,
    durationSec: opts.durationSec,
    summary,
    narrative,
    hints,
  };
}
