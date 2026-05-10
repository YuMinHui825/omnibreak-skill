# OmniBreak

Remote Linux debugger (ARM64/x86) via GDB/gdbserver. Launch binaries, attach to processes, set breakpoints, inspect state, capture crash backtraces — all via CLI.

## Prerequisites

- Node.js 20+
- Remote Linux target with gdbserver + gdb-multiarch installed
- SSH key or password access to target

## Install

```bash
cd omnibreak-skill && npm install && npm link
```

## Architecture

OmniBreak uses a **daemon** to maintain persistent GDB connections:

```bash
omnibreak daemon &           # Start background daemon (once)
omnibreak launch ...         # All commands talk to daemon
omnibreak break ...
omnibreak status ...
omnibreak stop               # End session
```

## Commands

```
omnibreak launch  --target <IP> --binary <PATH> [--user <U>] [--port <P>]
                  [--deploy-source <LOCAL>] [--source-map <JSON>]

omnibreak attach  --target <IP> --process <NAME>|--pid <N>
                  [--binary <PATH>] [--solib-path <DIR>]

omnibreak break   --file <PATH> --line <N> [--condition <EXPR>]
omnibreak continue | c
omnibreak next    | n
omnibreak step    | s
omnibreak status
omnibreak crash
omnibreak eval    <expression>
omnibreak gdb     <MI command>    # Raw GDB/MI
omnibreak deploy  --source <LOCAL> --target <IP> --dest <PATH>
omnibreak stop
omnibreak health
```

## Output

All commands return JSON to stdout:

```json
{"ok":true,"status":"stopped","file":"main.c","line":42,"vars":[...],"frames":[...]}
{"ok":false,"error":"Connection refused","code":"CONNECTION","hint":"Check gdbserver"}
```

## Workflows

### Debug a crash

```bash
omnibreak daemon &
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root
omnibreak break --file handler.c --line 342
omnibreak continue
# ... crash hits ... 
omnibreak crash   # full backtrace
omnibreak stop
```

### Attach to running service

```bash
omnibreak daemon &
omnibreak attach --target 192.168.1.100 --process myservice --binary ./lib.so
omnibreak status
omnibreak stop
```
