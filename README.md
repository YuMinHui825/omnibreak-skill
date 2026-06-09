<p align="center"><img src="icon.png" width="128" alt="OmniBreak" /></p>

# OmniBreak Skill

[:cn: 中文文档](README_CN.md)

CLI tool and Claude Code Skill for remote Linux debugging via GDB/gdbserver.  
Automate bug investigation — deploy, attach, breakpoints, crash capture.

## What is OmniBreak Skill?

A CLI wrapper around GDB/gdbserver that returns structured JSON output. Designed for:

- **Claude Code integration** — Claude can deploy, debug, and fix bugs autonomously
- **CI/CD pipelines** — capture crash backtraces in automated tests
- **Scripting** — shell scripts that need debugger access

Works with the same GDB/MI engine as [OmniBreak VSCode Extension](https://github.com/YuMinHui825/omnibreak).

## Architecture

```
omnibreak daemon &          # Background daemon holds GDB connection (TCP 127.0.0.1:49200)
omnibreak launch ...        # All commands talk to daemon via TCP
omnibreak break ...
omnibreak continue ...      # Returns full status: threads, frames, variables
omnibreak status ...        # Returns JSON: threads, frames, variables
omnibreak stop
```

## Prerequisites

### Your Machine
- Node.js 20+
- SSH access to remote Linux target

### Target Machine
```bash
sudo apt install -y gdbserver gdb-multiarch
```

## Install

### Standalone CLI

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install --production && npm link
```

Pre-compiled JavaScript is included — no TypeScript compilation needed.  
Dev setup (only for contributors who modify TypeScript): `npm install && npm run compile`.

### Claude Code Integration

```bash
mkdir -p ~/.claude/skills/omnibreak
cp SKILL.md ~/.claude/skills/omnibreak/SKILL.md
```

Restart Claude Code after first install.

After installation, Claude can **autonomously** complete the full debug cycle — no manual commands needed:

1. **Asks for missing info** — target IP, SSH password, binary path, source location, build command
2. **Compiles + deploys** — builds with `-g` debug symbols, SCPs to target
3. **Breakpoints + watchpoints** — sets breakpoints (file:line, conditional) and watchpoints (read/write/access)
4. **Auto state on continue** — continue/next/step automatically return threads, frames, and variables
5. **Auto crash analysis** — captures full 500-frame backtrace with exact file:line
6. **Memory leak detection** — heap tracking with risk escalation, plus Perfetto heapprofd native profiling
7. **Performance monitoring** — real-time CPU%, RSS, VSZ, thread count, remote log tailing
8. **System trace capture** — Perfetto with CPU sampling (flame graphs), GPU auto-detection, SQL auto-summary
9. **Fixes code** — analyzes root cause, edits source, rebuilds, redeploys, re-verifies
10. **Generates diagnostic reports** — summarizes problem, fix, and verification results

## Quick Start

```bash
# 1. Start daemon (once per session)
omnibreak daemon &

# 2. Launch binary on remote target
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root

# 3. Set breakpoint and run
omnibreak break --file main.c --line 42
omnibreak continue
# → {"ok":true,"status":"stopped","file":"main.c","line":42,"vars":[...]}

# 4. Inspect state
omnibreak status
# → threads, frames, variables

# 5. Cleanup
omnibreak stop
```

## All Commands

| Command | Description |
|------|------|
| `daemon` | Start background daemon (required before other commands) |
| `launch` | Deploy + start binary on target via gdbserver |
| `attach` | Attach to a running process |
| `break` | Set breakpoint (`--file`, `--line`, `--condition`) |
| `continue` / `c` | Resume execution (auto-returns status with threads/frames/vars) |
| `next` / `n` | Step over (auto-returns status) |
| `step` / `s` | Step into (auto-returns status) |
| `status` | Full debug state (threads, frames, vars) |
| `crash` | Crash backtrace (500 frames) |
| `eval` | Evaluate C expression |
| `gdb` | Raw GDB/MI command |
| `watch` | Set watchpoint (`--expr`, `--type read/write/access`) |
| `stats` | Process stats — CPU%, RSS, VSZ, thread count, state |
| `leaks` | Memory leak detection — heap tracking, risk escalation |
| `logs` | Read remote log file (`--path`, `--lines`) |
| `trace` | Capture Perfetto trace from remote target (system-wide + CPU sampling + auto-summary) |
| `deploy` | SCP file to target (standalone, no session needed) |
| `stop` | End session & cleanup |
| `health` | Check if daemon is running |

### Launch Options

```
omnibreak launch --target <IP> --binary <PATH>
  --user <name>          SSH user (default: root)
  --port <n>             gdbserver port (default: 2345)
  --pwd <pass>           SSH password (for scp, gdbserver, and GDB)
  --deploy-source <path> Local binary to SCP before launch
  --source-map <json>    Compile-path → local-path mapping
  --sudo                 Use sudo for gdbserver commands
  --skip-gdbserver       Skip starting gdbserver (if already running)
```

### Attach Options

```
omnibreak attach --target <IP> --process <name>|--pid <n>
  --binary <path>        .so or binary for debug symbols
  --solib-path <dir>     Remote .so search path
  --source-map <json>    Source path mapping
  --deploy-source <path> Local binary to SCP before attach
  --pwd <pass>           SSH password (for scp, gdbserver, and GDB)
  --sudo                 Use sudo for gdbserver commands
```

### Trace Options

```
omnibreak trace --target <IP>
  --user <name>           SSH user (default: root)
  --pwd <pass>            SSH password
  --duration <seconds>    Trace duration (default: 10)
  --output <path>         Local output path (default: ./trace.pftrace)
  --events <list>         Ftrace events (default: auto-detect sched + GPU + process events)
  --sudo                  Use sudo for ftrace access (required for kernel events)
  --sudo-pwd <pass>       Sudo password (defaults to SSH password)
  --start-cmd <cmd>       Command to run on remote AFTER trace starts
  --heap-profile <proc>   Enable heapprofd native heap profiling for process name
```

Uses [Perfetto tracebox](https://perfetto.dev) — deploys automatically on first use (~20MB one-time download).  
Returns a `.pftrace` file openable in [ui.perfetto.dev](https://ui.perfetto.dev), plus an auto-generated JSON summary:

```
summary:
  top_cpu_threads     ← top-10 CPU consumers with ms
  thread_states       ← per-thread end_state breakdown
  io_wait             ← threads stuck in D state
  scheduling_latency  ← avg/max scheduling slice duration
  process_rss         ← per-process peak RSS
  perf_top_functions  ← flame graph: top functions by CPU samples
```

**GPU auto-detection:** probes `/sys/kernel/tracing/events/` for GPU ftrace sources.  
**CPU sampling:** 100Hz `linux.perf` data source for flame graphs.  
**Security:** passwords passed via `SSHPASS` env variable, never in `ps` output.

## JSON Output

Every command returns JSON to stdout. Stderr is for human-readable logs.

Success:
```json
{
  "ok": true,
  "status": "stopped",
  "file": "main.c",
  "line": 42,
  "reason": "breakpoint-hit",
  "threads": [{"id":1,"name":"myapp","state":"stopped"}],
  "frames": [{"level":0,"func":"main","file":"main.c","line":42}],
  "vars": [{"name":"x","value":"10"},{"name":"y","value":"20"}]
}
```

Failure:
```json
{
  "ok": false,
  "error": "Connection refused",
  "code": "CONNECTION",
  "hint": "Check if gdbserver is running on target:2345"
}
```

## Typical Workflows

### Bug investigation loop

```bash
omnibreak daemon &
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root
omnibreak break --file handler.c --line 342
omnibreak continue
omnibreak status     # check variables
omnibreak next       # step
omnibreak status     # check again
omnibreak stop
```

### Crash capture

```bash
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root
omnibreak break --file handler.c --line 128
omnibreak continue
# ... crash occurs ...
omnibreak crash
# → full 500-frame backtrace with file:line
omnibreak stop
```

### Attach to running service

```bash
omnibreak attach --target 192.168.1.100 --process myservice --binary ./libservice.so
omnibreak status
omnibreak stop
```

### Memory leak detection

```bash
# Sample every ~5s, watch risk escalate
omnibreak leaks --pid 12345 --target 192.168.1.100 --user root
# → {heapKB:512, heapDeltaKB:384, risk:"high", sampleCount:30}
# risk: none → low → medium → high
```

### Process monitoring

```bash
omnibreak stats --pid 12345 --target 192.168.1.100 --user root
# → {cpuPercent:45.2, rssMB:18.5, vszMB:128, threadCount:4, state:"R"}
# state: R=running S=sleeping D=disk-wait T=tracing-stop Z=zombie
```

### System trace capture

```bash
# Capture system-wide trace (auto-detects GPU events)
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo

# Capture trace and run a specific command during the trace window
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --start-cmd "/app/myapp"

# Custom events override auto-detection
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --events "sched/sched_switch i915/i915_gem_request_submit"
```

The trace captures CPU scheduling + GPU events (auto-detected) + CPU callstack sampling of ALL processes, plus process snapshots and system info. Use the `--start-cmd` flag to ensure short-lived programs are captured.

### Watchpoint debugging

```bash
# Watch when variable 'x' is written to
omnibreak watch --expr "x" --type write

# Watch when expression is accessed (read or write)
omnibreak watch --expr "ptr->data" --type access

# Continue — stops when x changes, returns new value in vars
omnibreak continue
# → {"ok":true,"status":"stopped","file":"main.c","line":42,"vars":[{"name":"x","value":"100"}]}
```

### Remote log inspection

```bash
# Read last 100 lines of a remote log file
omnibreak logs --target 192.168.1.100 --path /var/log/myapp.log --lines 100 --user root

# Tail recent activity
omnibreak logs --target 192.168.1.100 --path /tmp/gdbserver-output.log --lines 50
# → {"path":"/var/log/myapp.log","lines":["2024-01-01 INFO ...","..."]}
```

### Native heap profiling (heapprofd)

```bash
# Capture trace with native heap profiling for myapp
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --heap-profile "myapp"

# Open trace in ui.perfetto.dev → Heap Dump Explorer → see per-function allocation flame graph
```

## Troubleshooting

| Problem | Solution |
|------|------|
| "Daemon not running" | `omnibreak daemon &` |
| "Connection timed out" | Check gdbserver on target, firewall allows port |
| "Process not found" | Process name must match (uses `pgrep -f`) |
| "Operation not permitted" (attach) | `sudo sysctl -w kernel.yama.ptrace_scope=0` |
| No debug symbols | Compile with `-g` flag |
| Trace is empty | Ensure `--sudo` is used (ftrace requires root) |
| Process not in trace | Use `--start-cmd` so trace starts before the process |
| No GPU events in trace | GPU events only fire when GPU is active (not in headless VMs). Check daemon stderr for `Detected GPU:` lines |

## License

MIT

## Author

[shibu](https://github.com/YuMinHui825)

---

<p align="center">
  <b>If you find OmniBreak useful, please give it a ⭐</b><br/><br/>
  <img src="IMG_9667.JPG" width="200" alt="Alipay" /><br/>
  <sub>Like this project? <b>Buy me a coffee ☕</b></sub><br/>
  <a href="https://github.com/YuMinHui825/omnibreak-skill">Star on GitHub</a>
</p>
