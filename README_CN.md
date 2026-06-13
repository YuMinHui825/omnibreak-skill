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
omnibreak daemon &          # 后台 daemon 保持 GDB 连接（TCP 127.0.0.1:49200）
omnibreak launch ...        # 所有命令通过 TCP 与 daemon 通信
omnibreak break ...
omnibreak continue ...      # 自动返回完整状态：线程、栈帧、变量
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

### 运行测试

```bash
# 单元测试（纯逻辑，不需要远程 VM）
npm run test:unit

# 集成测试（需要远程目标 + 运行中的 daemon）
nohup node out/daemon.js > /dev/null 2>&1 &
npm run test:integration      # daemon 自动管理生命周期

# 全部测试
npm test
```

集成测试默认连接 `ubuntu@192.168.64.2:1234`，可在 `test/setup.ts` 中修改。

### AI Agent 集成

**最简单的方式** — 直接把这段发给你的 Agent，让它自己安装：

> 从 https://github.com/YuMinHui825/omnibreak-skill 安装 OmniBreak 并完成配置

Agent 会自动读取仓库、执行 `npm install --production && npm link` 并配置 skill。

#### Claude Code

```bash
mkdir -p ~/.claude/skills/omnibreak
cp SKILL.md ~/.claude/skills/omnibreak/SKILL.md
```

首次安装后需重启 Claude Code。也可以在 Claude Code 中用 `/skill add` 指向仓库地址。

#### Codex / Cursor / 其他 Agent

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill && npm install --production && npm link
```

然后告诉 Agent：*"使用 `omnibreak` CLI 进行远程 Linux 调试。命令：daemon、launch、break、continue、status、stop、trace、coredump、stats、leaks、logs、deploy、watch。全部返回 JSON。"*

安装后，Agent 可以自主完成整个调试闭环——不需要你手动操作任何命令：

1. **主动询问缺失信息** — 目标 IP、SSH 密码、二进制路径、源码位置、构建命令等
2. **编译 + 部署** — 自动编译带 `-g` 调试符号，SCP 到远程
3. **断点 + 监视点** — 设断点（file:line、条件）和监视点（读/写/访问）
4. **continue 自动返回状态** — continue/next/step 自动返回线程、栈帧、变量
5. **崩溃自动分析** — 捕获完整调用栈，定位 `file:line`
6. **内存泄漏检测** — 堆采样 + 风险等级 + Perfetto heapprofd 原生堆剖析
7. **性能监控** — CPU%、RSS、VSZ、线程数 + 远程日志查看
8. **系统 Trace 采集** — Perfetto + CPU 采样火焰图 + GPU 自动检测 + SQL 自动摘要
9. **修复代码** — 分析根因，修改源码，重新编译部署验证
10. **生成诊断报告** — 汇总问题、修复方案、验证结果

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
| `launch` | 部署 + 启动程序（`--target IP\|local\|docker://<容器>`） |
| `attach` | 附到运行中进程 |
| `break` | 设断点（`--file`、`--line`、`--condition`、`--session`） |
| `continue` / `c` | 继续执行（自动返回状态，`--session`） |
| `next` / `n` | 单步跳过（自动返回状态，`--session`） |
| `step` / `s` | 单步进入（自动返回状态，`--session`） |
| `status` | 完整调试状态（线程、栈帧、变量） |
| `crash` | 崩溃堆栈（500 帧） |
| `eval` | 求值 C 表达式 |
| `gdb` | 原始 GDB/MI 命令 |
| `watch` | 设监视点（`--expr`、`--type read/write/access`） |
| `stats` | 进程统计 — CPU%、RSS、VSZ、线程数、状态 |
| `leaks` | 内存泄漏检测 — 堆内存追踪，风险等级评估 |
| `logs` | 读取远程日志文件（`--path`、`--lines`） |
| `trace` | 采集 Perfetto 系统级 trace（CPU 采样 + 自动摘要） |
| `coredump` | 本地 GDB 分析 core dump（无需 daemon） |
| `deploy` | SCP 文件到目标机（独立命令，无需 session） |
| `stop` | 结束会话并清理 |
| `health` | 检查 daemon 是否在运行 |

### Launch 选项

```
omnibreak launch --target <IP|local|docker://<容器>> --binary <PATH>
  --user <name>          SSH 用户（默认 root）— local/docker 忽略
  --port <n>             gdbserver 端口（默认 2345）
  --pwd <pass>           SSH 密码 — 仅 SSH 目标需要
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
  --heap-profile <proc>   启用 heapprofd 原生堆剖析，指定进程名
```

基于 [Perfetto tracebox](https://perfetto.dev) — 首次自动部署（约 20MB 一次性下载）。  
返回 `.pftrace` 文件，拖入 [ui.perfetto.dev](https://ui.perfetto.dev) 可视化查看，同时返回自动生成的 JSON 摘要：

```
summary:
  top_cpu_threads     ← CPU 占用 Top-10 线程及毫秒数
  thread_states       ← 线程状态分布（R/S/D/Z）
  io_wait             ← D 状态（IO 阻塞）线程
  scheduling_latency  ← 调度延迟均值/最大值
  process_rss         ← 进程 RSS 峰值
  perf_top_functions  ← CPU 采样火焰图：热点函数 Top-10
```

**GPU 自动检测**：探 `/sys/kernel/tracing/events/` 中的 GPU ftrace 源。  
**CPU 采样**：100Hz `linux.perf` 数据源生成火焰图。  
**安全**：密码通过 `SSHPASS` 环境变量传递，不出现在 `ps` 输出中。

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

Trace 捕获目标机上所有进程的 CPU 调度 + GPU 事件（自动检测）+ CPU 调用栈采样 + 进程快照和系统信息。短时运行程序用 `--start-cmd` 确保生命周期完整捕获。

### 监视点调试

```bash
# 监视变量写入
omnibreak watch --expr "x" --type write

# 监视表达式读写
omnibreak watch --expr "ptr->data" --type access

# 继续执行 — x 变化时自动停下来，返回新值
omnibreak continue
# → {"ok":true,"status":"stopped","file":"main.c","line":42,"vars":[{"name":"x","value":"100"}]}
```

### 远程日志查看

```bash
# 读取远程日志最后 100 行
omnibreak logs --target 192.168.1.100 --path /var/log/myapp.log --lines 100 --user root
# → {"path":"/var/log/myapp.log","lines":["2024-01-01 INFO ...","..."]}
```

### 原生堆剖析 (heapprofd)

```bash
# 采集 trace 时对 myapp 做原生堆剖析
omnibreak trace --target 192.168.1.100 --user root --duration 10 --sudo \
  --heap-profile "myapp"

# 打开 trace → Heap Dump Explorer → 查看每个函数的分配火焰图
```

### Core dump 事后分析

```bash
# 分析 core dump，定位崩溃位置
omnibreak coredump --binary ./myapp --core ./core.1234
# → {signal:"SIGSEGV", crashingThread:"1",
#    threads:[{id:"1", frames:[{func:"main", file:"main.c", line:42}]}],
#    registers:{pc:"0x...", sp:"0x..."}}
```

纯本地操作，无需 daemon、无需 SSH。

### 多进程并行调试

```bash
# 启动两个独立 session（不同端口）
omnibreak launch --target 192.168.1.100 --binary /app/service1 --port 2345
omnibreak launch --target 192.168.1.100 --binary /app/service2 --port 2346

# health 显示 session 数量
omnibreak health  # → "daemon running, 2 session(s) active"

# --session 指定操作哪个
omnibreak break --file handler.cpp --line 42 --session 1
omnibreak continue --session 2

# 停止单个或全部
omnibreak stop --session 1
omnibreak stop              # 停止全部
```

### 本地 & Docker 目标（无需 SSH）

```bash
# 直接调试本地二进制
omnibreak launch --target local --binary /tmp/myapp

# 调试 Docker 容器内程序
omnibreak launch --target docker://mycontainer --binary /app/myapp
```

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
