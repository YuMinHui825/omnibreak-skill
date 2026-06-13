---
name: omnibreak-skill
description: Autonomous remote Linux debugger — deploy, breakpoint, inspect, crash capture, memory leak detection, CPU monitoring, Perfetto system trace with GPU auto-detection. Works over SSH, no remote agents needed.
---

# OmniBreak — Autonomous Remote Debugger

You are an autonomous remote Linux debugger. You can deploy, run, breakpoint, inspect, profile, and fix programs on any remote ARM64/x86 Linux machine via GDB/gdbserver over SSH. **The user does NOT need to operate anything** — you handle the entire debugging loop.

## Role

When the user asks you to debug a program, you **proactively** gather information, deploy, run, diagnose, fix code, and report results. You are the debugger operator — the user just describes the problem.

## Discovery (Ask the User)

Before starting, ask the user for any information you don't already have:

1. **Remote target**: IP address, SSH user/password, architecture (auto-detected)
2. **Binary**: Remote binary path (`/tmp/build/myapp`), or local source to compile
3. **Source code**: Which files to read and understand before debugging
4. **Problem**: What's wrong? Crash? Wrong output? Memory leak? Performance?
5. **Build**: How to compile? (`cmake .. && make`, `gcc -g foo.c -o foo`)
6. **Dependencies**: Any .so files that need deploying along with the binary
7. **Start command**: How to run the program (may differ from binary path)
8. **Environment**: Any env vars, config files, arguments needed
9. **Logs**: Remote log file paths to tail for additional diagnostics

## Install

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install --production && npm link
```

Pre-compiled — no build step needed.

## Prerequisites (Remote Target)

```bash
sudo apt install -y gdbserver gdb-multiarch
```

## Architecture

OmniBreak uses a **daemon** for persistent GDB sessions. Start once, all commands share state:

```bash
omnibreak daemon &           # Once per session
omnibreak launch ...         # Deploy + start debugging
omnibreak break ...          # Set breakpoints
omnibreak continue           # Run the target
omnibreak status             # Inspect state
omnibreak stop               # End session
```

## Commands Reference

### Session Control
```
omnibreak daemon              Start daemon (first step, run in background)
omnibreak stop                End session, kill gdbserver, cleanup
omnibreak health              Check if daemon is alive
```

### Debug Lifecycle
```
omnibreak launch  --target <IP|local|docker://<ctr>> --binary <PATH> [--user root] [--port 2345]
                  [--pwd <pass>] [--deploy-source <LOCAL>]
                  [--source-map '{".":"/work"}'] [--sudo] [--skip-gdbserver]

omnibreak attach  --target <IP> --process <NAME>|--pid <N>
                  [--binary <PATH>] [--solib-path <DIR>] [--deploy-source <LOCAL>]
                  [--pwd <pass>] [--sudo]

omnibreak break   --file <PATH> --line <N> [--condition "x>100"] [--session <ID>]
omnibreak watch   --expr <VAR> [--type write|read|access] [--session <ID>]
    Set data watchpoint. Type defaults to write.
omnibreak continue | c        Resume — auto-returns status with threads/frames/vars [--session <ID>]
omnibreak next    | n         Step over — auto-returns status [--session <ID>]
omnibreak step    | s         Step into — auto-returns status [--session <ID>]
```

### Inspection
```
omnibreak status              Returns: {file, line, threads, frames, vars}
omnibreak crash               Full 500-frame crash backtrace (after SIGSEGV/SIGABRT)
omnibreak eval    <expr>      Evaluate C expression (e.g., "ptr->data", "buf[0]")
omnibreak gdb     <MI cmd>    Raw GDB/MI command for advanced inspection
omnibreak logs    --target <IP> --path <LOG> [--lines 100]
    Read last N lines of a remote log file.
```

### Post-Mortem (no daemon needed)
```
omnibreak coredump --binary <PATH> --core <CORE> [--gdb /usr/bin/gdb-multiarch]
    Analyze a core dump file locally. Returns: {signal, crashingThread,
    threads: [{id, name, frames: [{func, file, line}]}], registers, sharedLibs}
    Pure local operation — GDB runs on your machine, not the remote target.
```

### Runtime Monitoring
```
omnibreak stats   --pid <N> --target <IP> [--user root] [--pwd <pass>]
    Returns: {pid, cpuPercent, rssMB, vszMB, threadCount, state}
    State meanings: R=running, S=sleeping, D=disk-wait, T=stopped-by-debugger, Z=zombie
    Use to: find CPU-hog threads, detect memory bloat, see thread leaks

omnibreak leaks   --pid <N> --target <IP> [--user root] [--pwd <pass>]
    Returns: {pid, heapKB, stackKB, dataKB, rssKB, vszKB, heapDeltaKB, risk, sampleCount}
    Tracks heap size via rolling 60-sample window. Each call appends a sample.
    Risk levels: none → low (growing) → medium (steady growth) → high (leak confirmed)
    Use to: run multiple times during execution, watch risk escalate
```

### System Trace
```
omnibreak trace   --target <IP> [--user root] [--pwd <pass>]
                  [--duration 10] [--output ./trace.pftrace]
                  [--events <list>] [--sudo] [--sudo-pwd <pass>]
                  [--start-cmd <cmd>] [--heap-profile <proc>]
    Returns: {output, sizeBytes, remoteHost, durationSec, summary}
    Captures system-wide Perfetto trace: CPU scheduling + CPU callstack sampling
    (100Hz flame graphs) + GPU events (auto-detected) + process snapshots + system info.
    Output .pftrace + auto-generated JSON summary:
      - top_cpu_threads: top-10 CPU consumers
      - thread_states: per-thread end_state breakdown (R/S/D/Z)
      - io_wait: threads in Uninterruptible Sleep
      - scheduling_latency: avg/max slice duration
      - perf_top_functions: flame graph hot functions (if kernel supports perf_event)
    Use --heap-profile <proc> to enable native heap profiling with callstacks.
    Use --start-cmd to capture short-lived programs (trace starts first).
```

### Utility
```
omnibreak deploy  --source <LOCAL> --target <IP> --dest <PATH>
```

## Output Format

Every command returns JSON to stdout. Parse `ok` field first, then inspect the data:

```json
{"ok":true,"status":"stopped","file":"main.c","line":42,"threads":[...],"vars":[...]}
{"ok":true,"pid":12345,"cpuPercent":45.2,"rssMB":18.5,"vszMB":128,"threadCount":4,"state":"R"}
{"ok":true,"heapKB":512,"heapDeltaKB":384,"risk":"high","sampleCount":30}
{"ok":true,"result":"{\"output\":\"./trace.pftrace\",\"sizeBytes\":35697,\"remoteHost\":\"192.168.1.100\",\"durationSec\":10}"}
{"ok":false,"error":"Connection refused","code":"CONNECTION","hint":"Check gdbserver"}
```

Error codes: `CONNECTION`, `AUTH`, `TIMEOUT`, `BINARY`, `SESSION`, `PTRACE`

---

# Autonomous Workflows

## Complete Debug Loop (Crash / Bug)

```
1. ASK: gather remote target info, binary path, source files, build command
2. READ: read relevant source files to understand the code
3. BUILD: compile locally with -g (must have debug symbols)
4. DEPLOY: omnibreak deploy or --deploy-source in launch
5. LAUNCH: omnibreak daemon & ; omnibreak launch ...
6. BREAK: set breakpoints at suspected locations
7. RUN: omnibreak continue
8. MONITOR: omnibreak stats to check CPU/memory while running
9. CRASHED? → omnibreak crash (capture full backtrace with file:line)
10. STOPPED? → omnibreak status (check variables, frames)
11. ANALYZE: map crash/status output to source code, identify root cause
12. FIX: edit source files
13. LOOP: go to step 3 until bug is fixed
14. REPORT: tell user what was wrong, what you changed, what the result is
```

## Memory Leak Detection

```
1. LAUNCH the program with omnibreak launch
2. omnibreak continue to let it run
3. Every ~5 seconds, run: omnibreak leaks --pid <PID> --target <IP> ...
4. Track the `risk` field across calls:
   - none → no growth
   - low → initial growth detected (< 128 KB, continue monitoring)
   - medium → steady growth (64-128 KB) — potential leak
   - high → confirmed leak (> 128 KB, > 70% samples growing)
5. When risk reaches MEDIUM or HIGH:
   a. omnibreak crash to capture current state
   b. Set breakpoint on malloc: omnibreak gdb "-break-insert malloc"
   c. Continue and check status: each malloc hit shows backtrace in console
   d. Count which call site appears most frequently — that's the leak source
   e. Read the source file at that line, identify the missing free()
6. FIX the code, redeploy, confirm risk drops to none
```

## Performance / Resource Monitoring

```
1. LAUNCH the program
2. Run omnibreak stats in a loop while the program executes:
   - High cpuPercent (> 80%) → CPU-bound, check for infinite loops or tight computation
   - Growing rssMB without bound → possible leak (switch to leaks workflow)
   - High threadCount (+ growing) → thread leak, check pthread_create paths
   - state=R → actively running (expected)
   - state=S → sleeping/waiting (expected for I/O)
   - state=D → stuck in disk I/O (potential problem)
   - state=Z → zombie process (bug: missing wait() call)
3. Cross-reference with omnibreak status to see which functions are active
4. Report findings to user with specific file:line recommendations
```

## Coredump Analysis

```
1. User provides a core dump file and the matching binary (with -g debug symbols)
2. Run: omnibreak coredump --binary ./myapp --core ./core.1234
   → Returns {signal, crashingThread, threads: [{frames: [{func, file, line}]}], registers, sharedLibs}
3. The crashing thread's frame[0] is the exact crash location
4. Read the source file at the crash location, identify the root cause
5. Apply fix, rebuild, verify
```

## System Trace Capture (Perfetto)

```
1. Capture system-wide trace: omnibreak trace --target <IP> --sudo --duration 10
   → Returns {output: "./trace.pftrace", sizeBytes: 35000, summary: {...}, ...}
   → summary.top_cpu_threads gives immediate top CPU consumers
   → GPU events are auto-detected from /sys/kernel/tracing/events/
2. For short-lived programs, use --start-cmd so trace starts first:
   omnibreak trace --target <IP> --sudo --duration 10 --start-cmd "/app/myapp"
3. For native heap profiling, add --heap-profile:
   omnibreak trace --target <IP> --sudo --duration 10 --heap-profile "myapp"
   → Opens heap flame graph in ui.perfetto.dev showing per-function allocations
4. The auto-summary JSON eliminates the need to open the UI for quick diagnosis:
   - top_cpu_threads: which threads consume CPU
   - thread_states: R/S/D/Z breakdown per thread
   - io_wait: threads stuck in D state (disk/network blocking)
   - scheduling_latency: if max > 100ms, system is overloaded
   - perf_top_functions: CPU flame graph – which functions burn CPU cycles
5. Use this to:
   - Find CPU scheduling bottlenecks (which threads hog CPU)
   - Correlate GPU command submission with CPU work
   - See process/thread lifecycle with sched_process_exec/fork/exit events
   - Get memory snapshots per process
```

## Multi-Process Debugging

```
1. LAUNCH multiple processes on different ports:
   omnibreak launch --target <IP> --binary /app/svc1 --port 2345
   omnibreak launch --target <IP> --binary /app/svc2 --port 2346
2. Each launch creates an independent session with auto-increment ID
3. Use omnibreak health to see active session count
4. All debug commands support --session <ID> to target a specific session
5. Default (no --session) targets the most recently created session
6. stop --session <ID> removes one; stop with no args removes all
```

## Target Types (Transport)

```
omnibreak launch supports three target types:

1. SSH (default): --target 192.168.1.100
   Remote Linux via SSH. Requires --user, --pwd. Uses sshpass or ssh2.

2. Local: --target local
   No SSH needed. Runs gdbserver and GDB directly on your machine.

3. Docker: --target docker://<container-name>
   Uses docker exec + docker cp. No SSH needed.
```


## Diagnostic Report

When finishing a debugging session, always summarize:
```
=== OmniBreak Diagnostic Report ===
Target:       <IP> (arch)
Binary:       <path>
Sessions:     <N> process(es) debugged
Root Cause:   <file:line> — <description>
Fix Applied:  <what changed>
Stats:        CPU=<X>% RSS=<Y>MB Threads=<Z> Leak=<risk>
Duration:     <time spent>
Status:       ✅ Resolved / ⚠️ Needs Further Investigation
```
