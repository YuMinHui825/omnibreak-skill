---
name: omnibreak-skill
description: Give your vibe coder a debugger — deploy, breakpoint, inspect, crash, memory leak, CPU flame graph, GPU trace. Real Linux. Real fixes. Autonomous agent loop.
---

# OmniBreak — Give Your AI a Debugger

**AI writes the code. OmniBreak makes it work.**

You are the debugging half of the agent loop. Your AI partner writes code — you deploy it to real Linux hardware, run it, break it, find the bug, and feed the exact `file:line` + variable state + crash backtrace back so they can fix it. Then you verify the fix. Over and over, until it works.

This is the autonomous agent loop: `deploy → break → fix → loop`.

## The Loop

When the user says "there's a bug" or "this crashes" or "why is it slow", you run this:

```
1. DISCOVER: ask for target IP, binary path, source files, build command
2. BUILD:   compile with -g (must have debug symbols)
3. DEPLOY:  omnibreak deploy or --deploy-source in launch
4. LAUNCH:  omnibreak daemon & ; omnibreak launch ...
5. BREAK:   set breakpoints at suspicious locations
6. RUN:     omnibreak continue → auto-returns threads, frames, variables
7. INSPECT: omnibreak status / eval / crash
8. ANALYZE: map crash/status output to source code, identify root cause
9. FIX:     edit source files with exact file:line fix
10. LOOP:   rebuild → redeploy → re-verify
11. REPORT: what was wrong, what you changed, what the result is
```

## Discovery

Before starting, ask the user for anything missing:

1. **Remote target**: IP address, SSH user/password, architecture (auto-detected)
2. **Binary**: Remote binary path, or local source to compile
3. **Source code**: Which files to read before debugging
4. **Problem**: Crash? Wrong output? Memory leak? Performance?
5. **Build**: How to compile? (`cmake .. && make`, `gcc -g foo.c -o foo`)
6. **Start command**: How to run (may differ from binary path)
7. **Logs**: Remote log file paths for tailing during debug

## Install

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install --production && npm link
```

Pre-compiled — no build step needed.

## Architecture

OmniBreak uses a **daemon** for persistent GDB sessions. Start once:

```bash
omnibreak daemon &           # Background daemon (TCP 127.0.0.1:49200)
omnibreak launch ...         # Deploy + start debugging
omnibreak break ...          # Set breakpoints
omnibreak continue           # Run — returns threads, frames, variables
omnibreak stop               # End session
```

## Quick Reference

### Session
```
omnibreak daemon              Start daemon (run in background)
omnibreak stop [--session ID] End session(s)
omnibreak health              Daemon status + active session count
```

### Debug Lifecycle
```
omnibreak launch  --target <IP|local|docker://ctr> --binary <PATH>
                  [--user root] [--port 2345] [--pwd <pass>]
                  [--deploy-source <LOCAL>] [--sudo] [--skip-gdbserver]

omnibreak attach  --target <IP> --process <NAME>|--pid <N>
                  [--binary <PATH>] [--pwd <pass>] [--sudo]

omnibreak break   --file <PATH> --line <N> [--condition "x>100"] [--session ID]
omnibreak watch   --expr <VAR> [--type write|read|access] [--session ID]
omnibreak continue | c        Resume — auto-returns status [--session ID]
omnibreak next    | n         Step over — auto-returns status [--session ID]
omnibreak step    | s         Step into — auto-returns status [--session ID]
```

### Inspection
```
omnibreak status [--session ID]    Threads, frames, variables
omnibreak crash [--session ID]     500-frame crash backtrace
omnibreak eval  <expr> [--session] C expression value
omnibreak gdb   <MI cmd> [--session] Raw GDB/MI
omnibreak logs  --target <IP> --path <FILE> [--lines N] [--tail]
```

### Post-Mortem (no daemon needed)
```
omnibreak coredump --binary <PATH> --core <CORE>
    Returns: {signal, crashingThread, threads, registers, sharedLibs}
```

### Runtime Monitoring
```
omnibreak stats --pid <N> --target <IP> [--user root] [--pwd <pass>]
    → {pid, cpuPercent, rssMB, vszMB, threadCount, state}
    State: R=running S=sleeping D=disk-wait T=stopped Z=zombie

omnibreak leaks --pid <N> --target <IP> [--user root] [--pwd <pass>]
    → {heapKB, stackKB, heapDeltaKB, risk, sampleCount}
    Risk: none → low → medium → high (leak confirmed)
```

### System Trace (Perfetto)
```
omnibreak trace --target <IP> [--duration 10] [--sudo] [--pwd <pass>]
                [--start-cmd <cmd>] [--heap-profile <proc>]
    → {output: "./trace.pftrace", sizeBytes, summary: {top_cpu_threads,
       thread_states, io_wait, scheduling_latency, perf_top_functions}}
    Auto-detects GPU events. 100Hz CPU flame graphs. Opens in ui.perfetto.dev.
```

### Utility
```
omnibreak deploy --source <LOCAL> --target <IP> --dest <PATH>
```

## Key Patterns

### The Fix Loop
```
Launch → break → continue → inspect vars → fix source → rebuild → redeploy → continue → verify
```
Every debug command (`continue`, `next`, `step`) auto-returns status with threads, frames, and variables. No separate `status` call needed.

### Memory Leak
```
Launch → continue → leaks every 5s → track risk escalation
When HIGH: crash → break on malloc → count call site frequency → fix the top allocator
```

### Performance
```
Launch → stats loop → high CPU%? trace --sudo → summary.top_cpu_threads → fix
                     → growing RSS? leaks → fix
                     → state=D? io_wait in trace summary → fix
```

### Multi-Process
```
launch --port 2345 --binary /app/svc1
launch --port 2346 --binary /app/svc2
health → "N session(s) active"
break --file svc1.c --line 42 --session 1
continue --session 2
```

## Output Format

All commands return JSON. Parse `ok` field first:

```json
{"ok":true,"status":"stopped","file":"main.c","line":42,"threads":[...],"vars":[...]}
{"ok":true,"heapKB":512,"heapDeltaKB":384,"risk":"high","sampleCount":30}
{"ok":true,"result":"{\"output\":\"./trace.pftrace\",\"summary\":{...}}"}
{"ok":false,"error":"Connection refused","code":"CONNECTION","hint":"Check gdbserver"}
```

Error codes: `CONNECTION` `AUTH` `TIMEOUT` `BINARY` `SESSION` `PTRACE`

## Diagnostic Report

Always summarize after a debug session:
```
=== OmniBreak Diagnostic Report ===
Target:       <IP> (arch)
Binary:       <path>
Root Cause:   <file:line> — <description>
Fix Applied:  <what changed>
Stats:        CPU=<X>% RSS=<Y>MB Threads=<Z> Leak=<risk>
Status:       ✅ Resolved / ⚠️ Needs Investigation
```
