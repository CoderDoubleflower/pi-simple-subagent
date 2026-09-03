# pi-simple-subagent

一个面向 Pi 的轻量级后台 Subagent 插件。每个子代理运行在独立的：

```bash
pi --mode rpc --no-session
```

进程中，因此拥有隔离的上下文窗口，不创建独立 session 文件，同时能在进程存活期间继续接收消息、复用上下文并并行工作。

## 主要能力

- Codex 风格工具：`spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`list_agents`
- 子代理默认继承父代理当前的模型、reasoning effort、可用工具和项目 trust 状态
- 顶层配置、Profile 与单次 `spawn_agent` 参数均可覆盖模型、effort 和工具
- **唯一快捷配置入口 `/subagent-config`**：模型、effort、工具与保存范围集中在同一个 TUI 中
- 用户级、项目级和显式配置文件三级覆盖；JSON 配置可设置全部运行参数
- 通过带版本的结构化 `details` 协议向独立渲染插件暴露状态、活动、统计与最终结果
- 后台并行执行、后续对话、排队 follow-up、即时 steer、等待和关闭
- 并发槽位、启动失败清理、父进程退出清理和协作式终止
- 严格 LF JSONL 解码，正确处理拆分的 UTF-8、U+2028 和 U+2029
- 输出按 UTF-8 字节安全截断，不产生半个字符或替换符
- 子进程默认禁用 Subagent 编排工具，避免无界递归生成

## 安装

```bash
pi install git:github.com/CoderDoubleflower/pi-simple-subagent
```

临时试用：

```bash
pi -e git:github.com/CoderDoubleflower/pi-simple-subagent
```

本地开发：

```bash
npm install
npm run check
pi -e "$(pwd)"
```

运行环境要求 Node.js 22.19 或更高版本。

本插件不再注册 `renderCall` / `renderResult`。需要 Claude Code 风格的 Subagent 展示时，同时安装 [`pi-open-tui`](https://github.com/CoderDoubleflower/pi-open-tui)；未安装渲染插件时，Pi 会使用默认工具结果视图，编排和 RPC 能力不受影响。

## 模型可调用工具

### `spawn_agent`

启动后台子代理。插件等待子 Pi 接受 RPC `prompt` 后立即返回，不等待任务完成。

```json
{
  "task_name": "inspect_api",
  "message": "只读检查 src/api，指出接口设计问题并给出文件位置。",
  "agent_type": "explorer"
}
```

可选的单次覆盖字段：

```json
{
  "task_name": "fast_scan",
  "message": "快速定位最可能的回归来源。",
  "agent_type": "explorer",
  "model": "openai/your-model",
  "reasoning_effort": "medium",
  "tools": ["read", "grep", "find", "ls"],
  "cwd": "."
}
```

返回：

```json
{
  "agent_id": "agent_0123456789abcdef",
  "nickname": "inspect_api"
}
```

`task_name` 只能包含小写字母、数字和下划线，最长 64 个字符；同一父进程内必须唯一。

### `send_input`

复用已有子代理的进程与上下文：

```json
{
  "target": "inspect_api",
  "message": "继续检查第二个问题，并给出最小修复建议。",
  "interrupt": false
}
```

行为取决于代理状态：

- 已完成、失败或已中断：发送新的 RPC `prompt`，开始下一轮；
- 正在执行且 `interrupt=false`：发送 `follow_up`，排队追加任务；
- 正在执行且 `interrupt=true`：发送 `steer`，尽快重定向当前工作。

若新一轮 `prompt` 被子进程拒绝，插件会恢复上一轮已完成的状态和结果。

### `wait_agent`

```json
{
  "ids": ["inspect_api", "review_tests"],
  "timeout_ms": 10000
}
```

等待任意目标代理进入终态。超时只返回当前状态，不会关闭仍在运行的代理。等待可以通过父工具调用的 `AbortSignal` 中断。

### `close_agent`

```json
{
  "target": "inspect_api"
}
```

先发送 RPC `abort`，再按配置执行 `SIGTERM` / `SIGKILL` 兜底，最终释放并发槽位。返回关闭前的状态；目标不存在时返回 `not_found`。

完成的代理在关闭前仍可通过 `send_input` 复用，也仍占用并发槽位。

### `list_agents`

列出当前父 Pi 创建的全部代理、状态、模型、effort 和工具调用统计。

## 统一 TUI 配置

在 Pi 中执行唯一的配置命令：

```text
/subagent-config
```

同一个界面内可完成：

- **Model**：继承父代理、选择当前/Scoped/已认证可用模型，或手工输入 `provider/model`；
- **Effort**：`inherit`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；
- **Tools**：继承父代理、禁用全部工具，或从 Pi 当前全部已注册工具中勾选明确 allowlist；
- **Save scope**：用户级、受信任项目级，或 `PI_SIMPLE_SUBAGENT_CONFIG` 指向的显式配置层；
- **Reset**：仅把 model、effort、tools 恢复为 `inherit`。

按键：

```text
↑/↓    移动
Enter  编辑、选择或确认
Space  在工具列表中切换
Tab    切换保存范围
S      保存
R      重置快捷设置
Esc    返回或取消
```

插件不会为 model、effort、tools 分别注册零散命令。TUI 保存时只修改所选配置层中的这三个快捷字段，`process`、并发、超时、输出保留限制、Profile 以及未知的编辑器元数据均原样保留。

## 配置文件

加载顺序从低到高：

1. 内置默认值；
2. 用户配置：`~/.pi/agent/pi-simple-subagent.json`；
3. 受信任项目配置：`<项目>/.pi/pi-simple-subagent.json`；
4. `PI_SIMPLE_SUBAGENT_CONFIG` 指向的显式配置文件。

项目未受信任时，项目配置不会读取，也不能从 TUI 写入。保存采用同目录临时文件加原子重命名；在支持 POSIX 权限的平台上，配置文件权限设置为 `0600`。

完整示例见 [`examples/pi-simple-subagent.json`](examples/pi-simple-subagent.json)，JSON Schema 见 [`pi-simple-subagent.schema.json`](pi-simple-subagent.schema.json)。

### 完整配置示例

```json
{
  "$schema": "./pi-simple-subagent.schema.json",
  "version": 1,
  "defaultProfile": "default",
  "model": "inherit",
  "effort": "inherit",
  "tools": "inherit",
  "maxAgents": 4,
  "rpcStartupTimeoutMs": 15000,
  "defaultWaitTimeoutMs": 10000,
  "maxWaitTimeoutMs": 120000,
  "killGraceMs": 1500,
  "killForceMs": 3000,
  "output": {
    "maxFinalBytes": 49152,
    "maxStderrBytes": 16384,
    "maxActivityItems": 200
  },
  "process": {
    "command": "pi",
    "extraArgs": [],
    "env": {},
    "inheritEnvironment": true,
    "excludeTools": [
      "spawn_agent",
      "send_input",
      "wait_agent",
      "close_agent",
      "list_agents",
      "subagent"
    ],
    "approveProject": "inherit"
  },
  "profiles": {
    "default": {
      "description": "General-purpose subagent"
    },
    "explorer": {
      "description": "Read-only exploration",
      "systemPrompt": "Inspect and report. Do not modify files.",
      "model": "inherit",
      "effort": "inherit",
      "tools": ["read", "grep", "find", "ls"],
      "cwd": ".",
      "extraArgs": [],
      "env": {}
    }
  }
}
```

### 字段说明

| 字段 | 作用 |
|---|---|
| `defaultProfile` | `spawn_agent.agent_type` 省略时采用的 Profile |
| `model` | `inherit` 或 `provider/model` |
| `effort` | `inherit` 或 Pi 支持的 thinking level |
| `tools` | `inherit`、`none` 或工具名 allowlist |
| `maxAgents` | 未关闭子代理的最大数量，范围 1–32 |
| `rpcStartupTimeoutMs` | 子进程启动及 RPC 命令接收超时 |
| `defaultWaitTimeoutMs` | `wait_agent` 未传超时时的默认值 |
| `maxWaitTimeoutMs` | 单次等待允许的上限 |
| `killGraceMs` | `SIGTERM` 后的宽限时间 |
| `killForceMs` | `SIGKILL` 后的最终等待时间 |
| `output.*` | 最终回复、stderr 与活动记录的进程内保留/截断上限；不控制渲染 |
| `process.command` | 子 Pi 可执行文件，默认 `pi` |
| `process.extraArgs` | 追加到每个子 Pi 的 CLI 参数；保留顺序和重复项 |
| `process.env` | 注入所有子代理的环境变量 |
| `process.inheritEnvironment` | 是否继承父进程环境变量 |
| `process.excludeTools` | 无论 allowlist 如何都从子代理排除的工具 |
| `process.approveProject` | `inherit`、`always` 或 `never`，控制 `--approve` / `--no-approve` |
| `profiles.*` | 每个角色的描述、提示词、模型、effort、工具、cwd、CLI 参数和环境变量 |

### 覆盖优先级

单个子代理最终设置按以下优先级解析：

```text
spawn_agent 单次参数
  > agent_type 对应 Profile
  > 顶层 model / effort / tools
  > 父代理当前设置
```

`"inherit"` 表示继续向下继承；`tools: "none"` 或空工具数组会向子 Pi 传递 `--no-tools`；工具数组会转换为 `--tools a,b,c`。最终还会应用 `process.excludeTools`。

内置 Profile：

- `default`：通用、边界明确的任务；
- `explorer`：只开放 `read`、`grep`、`find`、`ls`；
- `worker`：适合限定写入范围的实现任务；
- `reviewer`：只开放读取类工具，按严重程度报告问题。

## 渲染职责与数据协议

`pi-simple-subagent` 只负责 Subagent 编排、RPC 生命周期以及结构化结果，不再拥有任何 TUI 渲染代码。五个工具返回的 `details` 使用稳定标识：

```json
{
  "kind": "pi-simple-subagent",
  "version": 1,
  "action": "wait",
  "snapshots": []
}
```

其中 `snapshots` 提供代理状态、最近活动、工具调用、token usage、耗时、错误与最终回复等原始数据。`pi-open-tui` 识别该协议并负责 Claude Code 风格的折叠/展开展示；视觉密度等设置也归 `pi-open-tui` 管理。

为支持滚动升级，建议先合并并更新 `pi-open-tui`，再更新本插件。新版 `pi-open-tui` 同时兼容迁移前未携带 `kind` / `version` 的旧结果；新版 `pi-simple-subagent` 在没有 `pi-open-tui` 时仍能正常工作，只是使用 Pi 默认工具视图。

## 进程与安全边界

每个代理实际启动一个常驻 RPC 子进程：

```bash
pi --mode rpc --no-session \
  --model <resolved-model> \
  --thinking <resolved-effort> \
  --tools <resolved-tools> \
  --exclude-tools <configured-denylist> \
  --approve|--no-approve \
  --append-system-prompt <temporary-file>
```

`PI_SIMPLE_SUBAGENT_CHILD=1` 会阻止本插件在子 Pi 中再次注册编排工具；默认 denylist 提供第二层保护。

多个代理默认共享项目目录。并行写入时，父模型必须分配互不重叠的文件范围；当前版本不会自动创建 Git worktree。

非交互子 Pi 无法处理真实终端弹窗。收到 `select`、`confirm`、`input` 或 `editor` 请求时，插件会自动返回取消，避免后台进程永久阻塞；`notify` 等无需回复的请求不会被误判为阻塞请求。

## 开发与验证

```bash
npm run typecheck  # 使用已安装的 Pi 类型声明进行严格类型检查
npm test       # Node 内置测试 + 模拟 Pi RPC 子进程
npm run check  # typecheck + test
```

测试覆盖：

- 扩展入口仅注册一个统一配置命令、没有渲染 hooks，并在子 Pi 中阻止递归注册；
- 配置归一化、三级覆盖、项目 trust、显式配置、原子写入；
- TUI 快捷字段更新时保留高级字段和未知元数据；
- CLI 重复参数顺序、模型/effort/tools/Profile/单次覆盖优先级；
- RPC 启动、等待、复用、follow-up 拒绝恢复、重试、模型错误和异常退出；
- 并发限制、启动失败清理、已中断启动清理、快速关闭和 `not_found`；
- 阻塞 UI 自动取消、通知忽略、stderr 限制、UTF-8 安全截断；
- LF JSONL、拆分 UTF-8、U+2028/U+2029 和无末尾换行。

## 设计边界

- 子代理不会自动继承父对话全文；`message` 应当自包含完成任务所需的上下文；
- 子代理状态保存在当前父 Pi 进程内，父进程退出后不会恢复；
- 完成结果不会主动插入父模型上下文，父模型通过 `wait_agent` 或 `list_agents` 获取；
- 该插件提供进程级上下文隔离，不提供文件系统或 Git 分支隔离。

## License

MIT
