<p align="center"><img src="icon.png" width="128" alt="OmniBreak" /></p>

# OmniBreak Skill

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

```bash
git clone https://github.com/YuMinHui825/omnibreak-skill.git
cd omnibreak-skill
npm install && npm link
```

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
| `deploy` | SCP 文件到目标机（独立命令，无需 session） |
| `stop` | 结束会话并清理 |
| `health` | 检查 daemon 是否在运行 |

### Launch 选项

```
omnibreak launch --target <IP> --binary <PATH>
  --user <name>          SSH 用户（默认 root）
  --port <n>             gdbserver 端口（默认 2345）
  --pwd <pass>           SSH 密码（可选，推荐密钥认证）
  --deploy-source <path> 本地二进制，启动前自动 SCP
  --source-map <json>    编译路径 → 本地路径映射
```

### Attach 选项

```
omnibreak attach --target <IP> --process <name>|--pid <n>
  --binary <path>        .so 或二进制文件（用于加载调试符号）
  --solib-path <dir>     远程 .so 搜索路径
  --source-map <json>    源码路径映射
```

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

## Troubleshooting

| 问题 | 解决 |
|------|------|
| "Daemon not running" | `omnibreak daemon &` |
| "Connection timed out" | 检查目标机上 gdbserver 和防火墙端口 |
| "Process not found" | 进程名必须匹配（使用 `pgrep -f`） |
| "Operation not permitted"（attach 时） | `sudo sysctl -w kernel.yama.ptrace_scope=0` |
| 无调试符号 | 编译时加 `-g` 参数 |

## License

MIT

## 作者

[shibu](https://github.com/YuMinHui825/omnibreak-skill)
