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
omnibreak daemon &          # Background daemon holds GDB connection
omnibreak launch ...        # All commands talk to daemon via Unix socket
omnibreak break ...
omnibreak continue ...
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
npm install && npm link
```

### Claude Code Integration

```bash
# Method 1: Add via skill command (recommended)
/skill add omnibreak https://github.com/YuMinHui825/omnibreak-skill.git

# Method 2: Manual registration
cp SKILL.md ~/.claude/skills/omnibreak.md
```

After installation, Claude can:

- `omnibreak launch --target <IP> --binary <PATH>` — deploy and start debugging
- `omnibreak break --file main.c --line 42` — set breakpoints
- `omnibreak continue` + `omnibreak status` — run and inspect
- `omnibreak crash` — capture crash backtraces

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
| `continue` / `c` | Resume execution |
| `next` / `n` | Step over |
| `step` / `s` | Step into |
| `finish` / `f` | Step out |
| `status` | Full debug state (threads, frames, vars) |
| `crash` | Crash backtrace (500 frames) |
| `eval` | Evaluate C expression |
| `gdb` | Raw GDB/MI command |
| `stats` | Process stats — CPU%, RSS, VSZ, thread count, state |
| `leaks` | Memory leak detection — heap tracking, risk escalation |
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

## Troubleshooting

| Problem | Solution |
|------|------|
| "Daemon not running" | `omnibreak daemon &` |
| "Connection timed out" | Check gdbserver on target, firewall allows port |
| "Process not found" | Process name must match (uses `pgrep -f`) |
| "Operation not permitted" (attach) | `sudo sysctl -w kernel.yama.ptrace_scope=0` |
| No debug symbols | Compile with `-g` flag |

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
