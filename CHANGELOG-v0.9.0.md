# v0.9.0 — Autonomous Debug Engine Upgrade

**AI writes the code. OmniBreak makes it work.**

This release transforms OmniBreak from a GDB remote-controller into a full autonomous debugging engine. 8 major optimizations, 2 new commands, 13-dimension Perfetto AI narrative analysis, module restructure. **66 tests passing on ARM64 Linux target.**

---

## What's New

### Sanitizer Orchestration
- New `sanitize` command — parse ASan/UBSan/TSan output into structured findings with `file:line` + callstack
- Launch flags: `--asan`, `--ubsan`, `--tsan` — auto-inject sanitizer environment variables into gdbserver

### Diagnostic Report
- New `report` command — generate full markdown diagnostic report from active session
- Includes: crash location, backtrace, source context, variables, process stats, leak status, sanitizer findings
- Support `--save <path>` to write to file

### Diff Mode
- New `diff` command — capture two process metric snapshots and compute delta
- Quantifies fix impact: CPU%, RSS, VSZ, thread count before/after

### Source Context on Breakpoint
- Every `continue`/`next`/`step`/`crash` returns `context` field — ±5 lines of source code around the breakpoint
- `isTarget: true` marks the exact line, falls back to remote SSH read when source not local

### heapprofd Leak Attribution
- Trace narrative now includes heap allocation callstacks — which function allocated how much, called by whom
- `Heap Leak Traces` section: `alloc_func ← caller_func: 2.3MB`

### AI Narrative Trace Summary
- 13 SQL queries (up from 7) → natural language `narrative` field
- New dimensions: flame graph per-function CPU%, memory timeline with trend, CPU frequency, top syscalls, wakeup latency

---

## Performance

- **SSH fully async** — transport.ts Promise-based ssh2, zero `execSync` busy-waiting
- **Port-precise cleanup** — `fuser -k <port>` replaces `pkill -x gdbserver` (no more killing all gdbservers)
- **Port readiness polling** — `waitForPort()` replaces fixed 1.5s sleep after gdbserver startup

---

## Bug Fixes

- Fix `omnibreak daemon` command (spawn detached child process)
- Fix `base64 --decode` for macOS compatibility
- Fix `handleAttach` to use `waitForPort` instead of fixed sleep
- Fix local gdbserver: add `nohup` + output redirection
- Fix `report --save` error handling
- Fix sanitizer env var ordering (before `stdbuf`, not between)

---

## Project Structure

```
src/
├── cli.ts
├── server/daemon.ts
├── transport/transport.ts
├── debug/          ← client, parser, mapper
├── trace/trace.ts
├── analysis/coredump.ts
└── shared/         ← types, ssh
```

Reorganized from flat 11 files to 6 functional modules. Zero logic changes.

---

## Tests

| Suite | Tests | Target |
|-------|-------|--------|
| Unit (5 suites) | 35 | Local |
| Integration (6 suites) | 31 | ARM64 Linux (192.168.64.2) |
| **Total** | **66** | **All passing** |

New: `test/unit/context.test.ts`, `test/integration/optimize.test.ts`

---

**Full Changelog:** [v0.8.0 → v0.9.0](https://github.com/YuMinHui825/omnibreak-skill/compare/0baa6f9..2fbe0a2)
