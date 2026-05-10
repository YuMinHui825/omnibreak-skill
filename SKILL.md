# OmniBreak — Remote Linux Debugger

Remote Linux debugger (ARM64/x86) via GDB/gdbserver. Claude can deploy binaries, attach to processes, set breakpoints, inspect variables, capture crash backtraces — all autonomously.

## Install

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install && npm link
```

Then register this skill in Claude Code:

```
/skill add omnibreak https://github.com/YuMinHui825/omnibreak-skill.git
```

Or manually: copy `SKILL.md` to `~/.claude/skills/omnibreak.md`

## Prerequisites (on target machine)

```bash
sudo apt install -y gdbserver gdb-multiarch
```

## Architecture

OmniBreak uses a **daemon** to maintain persistent GDB connections. Start it once, then all commands share the same session:

```bash
omnibreak daemon &           # Start background daemon
omnibreak launch ...         # All subsequent commands talk to daemon
omnibreak status ...
omnibreak stop               # End session
```

## Commands

### Session
```
omnibreak daemon              Start daemon (required first step)
omnibreak stop                End session & cleanup
omnibreak health              Check if daemon is alive
```

### Debug Lifecycle
```
omnibreak launch  --target <IP> --binary <PATH> [--user root] [--port 2345]
                  [--deploy-source <LOCAL>] [--source-map '{".":"/work"}']

omnibreak attach  --target <IP> --process <NAME>|--pid <N>
                  [--binary <PATH>] [--solib-path <DIR>]

omnibreak break   --file <PATH> --line <N> [--condition "x>100"]
omnibreak continue | c        Resume
omnibreak next    | n         Step over
omnibreak step    | s         Step into
omnibreak finish  | f         Step out
```

### Inspection
```
omnibreak status              Threads, frames, variables, current file:line
omnibreak crash               Full 500-frame crash backtrace
omnibreak eval    <expr>      Evaluate C expression
omnibreak gdb     <MI cmd>    Raw GDB/MI command
```

### Utility
```
omnibreak deploy  --source <LOCAL> --target <IP> --dest <PATH>
```

## Output Format

Every command returns JSON to stdout. Claude parses this directly:

```json
{"ok":true,"status":"stopped","file":"main.c","line":42,"threads":[...],"vars":[...]}
{"ok":false,"error":"Connection refused","code":"CONNECTION","hint":"Check gdbserver"}
```

## Workflow: Claude's Bug-Fixing Loop

When investigating a crash or bug, Claude follows this pattern:

```bash
# 1. Ensure daemon is running
omnibreak health || omnibreak daemon &

# 2. Deploy and start
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root \
  --deploy-source ./build_arm64/myapp

# 3. Set breakpoint at suspected location
omnibreak break --file src/handler.c --line 342

# 4. Run until breakpoint
omnibreak continue

# 5. Inspect state (parse JSON, check variables)
omnibreak status
# → {"ok":true,"status":"stopped","file":"handler.c","line":342,"vars":[{"name":"buf","value":"0x0"}]}

# 6. Step through
omnibreak next
omnibreak eval "buf[0]"

# 7. If crash, capture full backtrace
omnibreak crash
# → 500 frames with file:line for each

# 8. Fix the code, redeploy, repeat
omnibreak stop
# ... edit source, rebuild ...
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root --deploy-source ./build_arm64/myapp
```

## Workflow: Attach to Running Service

```bash
# Service is running (started by systemd/etc)
omnibreak attach --target 192.168.1.100 --process myservice --binary ./libservice.so
omnibreak status
# ... inspect ...
omnibreak stop
```

## Output Properties

| Field | Type | Meaning |
|------|------|------|
| `ok` | boolean | Command succeeded |
| `status` | string | `stopped` / `running` / `exited` |
| `reason` | string | `breakpoint-hit` / `end-stepping-range` / `signal-received` |
| `file` | string | Current source file |
| `line` | number | Current line number |
| `threads` | array | All threads with id, name, state |
| `frames` | array | Stack frames with level, func, file, line |
| `vars` | array | Local variables with name, value |
| `error` | string | Error message (when `ok` is false) |
| `code` | string | Error code: CONNECTION / AUTH / TIMEOUT / BINARY / SESSION / PTRACE |
| `hint` | string | Suggested fix for the error |
