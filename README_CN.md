<p align="center"><img src="icon.png" width="128" alt="OmniBreak" /></p>

# OmniBreak Skill

[English](README.md)

远程 Linux 调试 CLI 工具 + Claude Code Skill。  
通过 GDB/gdbserver 自动化 bug 排查——部署、attach、断点、崩溃捕获。

## 是什么？

OmniBreak Skill 是一个 CLI 工具，封装 GDB/gdbserver，输出结构化 JSON。用于：

- **Claude Code 集成** — Claude 自主部署、调试、修 bug
- **CI/CD 流水线** — 自动化测试中捕获崩溃堆栈
- **脚本编程** — 需要调试器的 shell 脚本

与 [OmniBreak VSCode 插件](https://github.com/YuMinHui825/omnibreak) 共享同一套 GDB/MI 引擎。

## 架构

```
omnibreak daemon &          # 后台 daemon 保持 GDB 连接
omnibreak launch ...        # 所有命令通过 Unix socket 与 daemon 通信
omnibreak break ...
omnibreak continue ...
omnibreak status ...        # 返回 JSON：线程、栈帧、变量
omnibreak stop
```

## 准备条件

### 你的机器
- Node.js 20+
- SSH 可访问远程 Linux 目标

### 目标机
```bash
sudo apt install -y gdbserver gdb-multiarch
```

## 安装

### 独立 CLI

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install --production && npm link
```

已包含预编译的 JavaScript，无需 TypeScript 编译。  
开发环境（仅修改 TypeScript 的贡献者需要）：`npm install && npm run compile`。

### Claude Code 集成

```bash
mkdir -p ~/.claude/skills/omnibreak
cp SKILL.md ~/.claude/skills/omnibreak/SKILL.md
```

首次安装后需重启 Claude Code。

安装后，Claude 可以自主完成整个调试闭环——不需要你手动操作任何命令：

1. **主动询问缺失信息** — 目标 IP、SSH 密码、二进制路径、源码位置、构建命令等
2. **编译 + 部署** — 自动编译带 `-g` 调试符号，SCP 到远程
3. **断点 + 执行** — 设断点、启动、单步、查看变量
4. **崩溃自动分析** — 捕获完整调用栈，定位 `file:line`
5. **内存泄漏检测** — 持续采样堆内存，自动判断风险等级
6. **性能监控** — CPU%、RSS、VSZ、线程数实时查看
7. **修复代码** — 分析根因，修改源码，重新编译部署验证
8. **生成诊断报告** — 汇总问题、修复方案、验证结果

## 快速开始

```bash
# 1. 启动 daemon（一次）
omnibreak daemon &

# 2. 在远程目标上启动程序
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root

# 3. 设断点并运行
omnibreak break --file main.c --line 42
omnibreak continue
# → {"ok":true,"status":"stopped","file":"main.c","line":42,"vars":[...]}

# 4. 查看状态
omnibreak status
# → 线程、栈帧、变量

# 5. 清理
omnibreak stop
```

## 所有命令

| 命令 | 说明 |
|------|------|
| `daemon` | 启动后台 daemon（其他命令的前置条件） |
| `launch` | 部署 + 在目标机上启动程序 |
| `attach` | 附到运行中进程 |
| `break` | 设断点（`--file`、`--line`、`--condition`） |
| `continue` / `c` | 继续执行 |
| `next` / `n` | 单步跳过 |
| `step` / `s` | 单步进入 |
| `finish` / `f` | 执行完当前函数 |
| `status` | 完整调试状态（线程、栈帧、变量） |
| `crash` | 崩溃堆栈（500 帧） |
| `eval` | 求值 C 表达式 |
| `gdb` | 原始 GDB/MI 命令 |
| `stats` | 进程统计 — CPU%、RSS、VSZ、线程数、状态 |
| `leaks` | 内存泄漏检测 — 堆内存追踪，风险等级评估 |
| `trace` | 采集 Perfetto 系统级 trace（全系统） |
| `deploy` | SCP 文件到目标机（独立命令，无需 session） |
| `stop` | 结束会话并清理 |
| `health` | 检查 daemon 是否在运行 |

### Launch 选项

```
omnibreak launch --target <IP> --binary <PATH>
  --user <name>          SSH 用户（默认 root）
  --port <n>             gdbserver 端口（默认 2345）
  --pwd <pass>           SSH 密码（scp、gdbserver、GDB 通用）
  --deploy-source <path> 本地二进制，启动前自动 SCP
  --source-map <json>    编译路径 → 本地路径映射
  --sudo                 使用 sudo 执行 gdbserver 命令
  --skip-gdbserver       跳过 gdbserver 启动（已运行时）
```

### Attach 选项

```
omnibreak attach --target <IP> --process <name>|--pid <n>
  --binary <path>        .so 或二进制文件（用于加载调试符号）
  --solib-path <dir>     远程 .so 搜索路径
  --source-map <json>    源码路径映射
  --deploy-source <path> 本地二进制，attach 前自动 SCP
  --pwd <pass>           SSH 密码（scp、gdbserver、GDB 通用）
  --sudo                 使用 sudo 执行 gdbserver 命令
```

### Trace 选项

```
omnibreak trace --target <IP>
  --user <name>           SSH 用户（默认 root）
  --pwd <pass>            SSH 密码
  --duration <seconds>    Trace 采集时长（默认 10）
  --output <path>         本地输出路径（默认 ./trace.pftrace）
  --events <list>         Ftrace 事件（默认：自动检测 调度 + GPU + 进程事件）
  --sudo                  使用 sudo 执行（ftrace 需要 root 权限）
  --sudo-pwd <pass>       Sudo 密码（默认同 SSH 密码）
  --start-cmd <cmd>       Trace 启动后在远程执行的命令
```

基于 [Perfetto tracebox](https://perfetto.dev) — 首次自动部署（约 20MB 一次性下载）。  
输出 `.pftrace` 文件，拖入 [ui.perfetto.dev](https://ui.perfetto.dev) 即可可视化查看。

**GPU 自动检测：** 首次采集时自动探测远程 `/sys/kernel/tracing/events/` 中的 GPU ftrace 源（i915、mali、kgsl、amdgpu、virtio_gpu、drm 等）并自动加入。核显 + 独显双卡环境完整支持。

## JSON 输出

所有命令向 stdout 输出 JSON。stderr 是人类可读日志。

成功：
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

失败：
```json
{
  "ok": false,
  "error": "Connection refused",
  "code": "CONNECTION",
  "hint": "Check if gdbserver is running on target:2345"
}
```

## 典型工作流

### Bug 排查循环

```bash
omnibreak daemon &
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root
omnibreak break --file handler.c --line 342
omnibreak continue
omnibreak status     # 查看变量
omnibreak next       # 单步
omnibreak status     # 再次查看
omnibreak stop
```

### 崩溃捕获

```bash
omnibreak launch --target 192.168.1.100 --binary /app/myapp --user root
omnibreak break --file handler.c --line 128
omnibreak continue
# ... 崩溃发生 ...
omnibreak crash
# → 完整 500 帧堆栈，带文件:行号
omnibreak stop
```

### 附到运行中服务

```bash
omnibreak attach --target 192.168.1.100 --process myservice --binary ./libservice.so
omnibreak status
omnibreak stop
```

### 内存泄漏检测

```bash
# 每 5 秒采样一次，观察 risk 变化
omnibreak leaks --pid 12345 --target 192.168.1.100 --user root
# → {heapKB:512, heapDeltaKB:384, risk:"high", sampleCount:30}
# risk: none → low → medium → high 逐级上升
```

### 进程性能监控

```bash
omnibreak stats --pid 12345 --target 192.168.1.100 --user root
# → {cpuPercent:45.2, rssMB:18.5, vszMB:128, threadCount:4, state:"R"}
# state: R=运行 S=睡眠 D=磁盘等待 T=调试暂停 Z=僵尸
```

### 系统级 Trace 采集

```bash
# 采集全系统 trace（自动检测 GPU 事件）
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo

# 采集 trace 并在期间运行指定命令
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --start-cmd "/app/myapp"

# 自定义事件（覆盖自动检测）
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --events "sched/sched_switch i915/i915_gem_request_submit"
```

Trace 捕获目标机上**所有进程**的 CPU 调度 + GPU 事件（自动检测）、进程快照和系统信息。对于短时运行的程序，用 `--start-cmd` 让 trace 先启动、再执行命令，确保进程的完整生命周期被捕获。

## Troubleshooting

| 问题 | 解决 |
|------|------|
| "Daemon not running" | `omnibreak daemon &` |
| "Connection timed out" | 检查目标机上 gdbserver 和防火墙端口 |
| "Process not found" | 进程名必须匹配（使用 `pgrep -f`） |
| "Operation not permitted"（attach 时） | `sudo sysctl -w kernel.yama.ptrace_scope=0` |
| 无调试符号 | 编译时加 `-g` 参数 |
| Trace 采集为空 | 确保使用 `--sudo`（ftrace 需要 root 权限） |
| 进程不在 trace 中 | 使用 `--start-cmd` 让 trace 先启动再执行目标命令 |
| Trace 中无 GPU 事件 | GPU 事件仅在 GPU 活跃时触发（无头 VM 中不会产生）。查看 daemon stderr 中的 `Detected GPU:` 日志确认 |

## License

MIT

## 作者

[shibu](https://github.com/YuMinHui825)

---

<p align="center">
  <b>如果觉得有用，点个 ⭐ 支持一下</b><br/><br/>
  <img src="IMG_9667.JPG" width="200" alt="支付宝" /><br/>
  <sub>感兴趣可以打赏 <b>请喝杯咖啡 ☕</b></sub><br/>
  <a href="https://github.com/YuMinHui825/omnibreak-skill">去 GitHub 点 Star</a>
</p>
