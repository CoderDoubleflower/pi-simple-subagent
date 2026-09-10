# pi-simple-subagent

面向 Pi 的轻量级后台子代理插件。每个子代理运行在独立的 `pi --mode rpc --no-session` 进程中，拥有独立上下文，不创建自己的 session 文件；进程存活期间可以继续接收消息并复用上下文。

主代理负责拆分、协调、验收和汇总；子代理负责独立完成被委派的任务。界面只显示子代理状态，不显示子任务提示词、内部活动正文、回复或日志。最终结果仍会交给主模型使用。

## 安装与升级

```bash
pi install git:github.com/CoderDoubleflower/pi-simple-subagent
```

临时使用：

```bash
pi -e git:github.com/CoderDoubleflower/pi-simple-subagent
```

已通过 Git 安装的用户可以定向更新：

```bash
pi update git:github.com/CoderDoubleflower/pi-simple-subagent
pi update git:github.com/CoderDoubleflower/pi-open-tui
```

第二条用于已经安装 `pi-open-tui` 的用户。两个插件都更新后，重新启动 Pi，以加载新工具定义、协作提示词和布局联动。固定 tag/commit 的安装需要先调整安装源的 ref；本地目录安装需要自行同步该目录。

运行环境要求 Node.js 22.19 或更高版本。

## 本次行为变化

- 成功派发后建立任务归属。主模型会收到明确的“不重复执行子任务”协作规则，运行中任务的归属也会在请求上下文中补充；变化中的状态不写进系统提示词。
- 实现型 `worker` 必须提供 `write_scope`。插件阻止重叠的子任务分配，并检查主代理具有明确目标路径的写入工具。
- `wait_agent` 默认持续等待新结果，而不是每 10 秒结束一次等待。未被等待领取的完成结果会通过隐藏消息主动交付；同一执行轮次只交付一次。
- `spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`list_agents` 在聊天区均为零行渲染，展开和历史详情也不会重新显示子任务正文。
- 子代理状态在独立的编辑器上方区域刷新。搭配更新后的 `pi-open-tui`，固定顺序为 spinner → 子代理 → Todo → 输入框。
- 第一次请求模型前就列出实际配置中的 Profile 和用途。`agent_type` 省略、空字符串或纯空格均回退到 `defaultProfile`；非空的未知名称仍明确报错。

## 模型工具

### spawn_agent

启动后台子代理，等待子 Pi 接受 RPC prompt 后立即返回，不等待子任务完成。主模型应该继续独立、不重叠的工作；没有这样的工作时，调用一次 `wait_agent` 等待。

只读探索：

```json
{
  "task_name": "inspect_api",
  "message": "只读检查 src/api，指出接口设计问题并给出文件位置。",
  "agent_type": "explorer"
}
```

实现任务：

```json
{
  "task_name": "fix_auth",
  "message": "修复鉴权逻辑并补充回归测试。完成后报告修改文件和测试结果。",
  "agent_type": "worker",
  "write_scope": ["src/auth/**", "tests/auth/**"]
}
```

`task_name` 只包含小写字母、数字和下划线，以字母或数字开头，最长 64 个字符；同一管理器内必须唯一，关闭后可复用名称。`message` 应包含完成任务所需的背景和预期交付物，子代理不会自动获得父对话全文。

可选覆盖项：`model`（provider/model）、`reasoning_effort`、`tools` 和 `cwd`。通常省略以继承配置；`tools: []` 禁用全部工具。`cwd` 可以是绝对路径或相对父工作目录的路径。

返回包含 `agent_id`、`nickname`、实际采用的 `agent_type`、状态和归属元数据，不包含子任务正文。

#### write_scope 的含义

范围相对于解析后的子代理工作目录，可以是精确文件、已有目录，或以 `/`、`/**` 结尾的新目录范围。不支持 `src/*.ts` 一类任意 glob。路径会规范化并解析已有祖先目录的符号链接，检查补丁时同时检查原文件和 `Move to` 目标。

`worker` 必须提供非空范围；其他 Profile 可选，但任何修改型任务都应声明范围。范围在异步启动前预留，避免两个并行 spawn 同时领取同一区域。主代理已经在执行的文件写入也会阻止重叠分配。

主代理的 `write`、`edit`、`MultiEdit`、`apply_patch` 若写入运行中子任务的范围，会收到冲突错误。读取共享背景文件不受限制。任务完成后释放写入归属；主代理此时可以验收、整合和修正。要提前接管，必须先 `close_agent` 关闭原任务。

**这不是文件系统沙箱。**子代理自身的范围主要通过任务提示词约束；任意 shell 命令、第三方工具和外部副作用不在显式路径检查覆盖范围内。语义上的重复调查依靠协作规则，不能等同于操作系统级强制隔离。不会自动创建 Git worktree。

### send_input

```json
{
  "target": "inspect_api",
  "message": "继续检查第二个问题，并给出最小修复建议。",
  "interrupt": false
}
```

已完成、失败或已中断的代理会收到新的 RPC prompt；运行中的代理在 `interrupt=false` 时排队 follow-up，在 `interrupt=true` 时接收 steer。已完成代理启动下一轮时会重新检查原写入范围是否被其他任务占用。

新一轮 prompt 被拒绝时，恢复上一轮状态和结果交付标记，不把拒绝误判为新的完成结果。原 `write_scope` 在后续对话中保持不变；需要改变范围时关闭并重新派发。返回 `submission_id`、agent ID 和状态。

### wait_agent

推荐省略超时：

```json
{
  "ids": ["inspect_api", "fix_auth"]
}
```

等待任一目标产生尚未交付的新终态结果。省略 `timeout_ms` 或传 `0` 时持续等待，直到产生结果、目标全部结束或等待被取消。已经交付过结果的 A，不会让仍需等待 B 的 `[A, B]` 立即返回。

正整数 `timeout_ms` 是显式等待期限，至少 1000ms，最多 `maxWaitTimeoutMs`。等待超时不取消任务、不释放归属，也不允许主模型因此重复执行子任务。没有独立工作时不应使用短超时轮询；`list_agents` 也不用于轮询。

返回结构示例：

```json
{
  "status": {"inspect_api": "completed", "fix_auth": "running"},
  "results": [{"agent_id": "agent_abc", "task_name": "inspect_api", "round": 1, "status": "completed", "output": "最终结论"}],
  "timed_out": false,
  "all_finished": false
}
```

`results` 只包含本次领取的新结果。找不到的目标返回 `not_found`；全部结果已交付且没有运行中目标时立即返回空 `results`，不重复发送正文。错误或中断结果使用 `error` 而非 `output`。

#### 主动完成通知

没有正在等待领取的目标，其结果会作为 `display: false` 的自定义消息交付给父模型：运行时在工具边界送入，空闲时可触发继续处理。同一会话管理器内按 agent ID 和执行轮次去重，主动通知与等待领取不会重复交付。关闭、取消和会话清理会抑制未发送的迟到通知。

完成判断沿用子 Pi 的 `agent_settled`，不会仅因为收到一条 assistant 文本就宣布整个任务完成。非终态的流式正文和原始工具结果不会作为完成通知回传。

### close_agent

```json
{"target": "inspect_api"}
```

先发送 RPC abort，再按配置以 SIGTERM / SIGKILL 兜底，释放并发槽位和归属。返回 `{"status":"closed"}` 或 `{"status":"not_found"}`，不再携带关闭前的回复正文。需要结果时先等待或使用已交付结果。

完成的代理在关闭前仍可复用，也仍占用 `maxAgents` 槽位。

### list_agents

仅供诊断。返回当前代理的 ID、任务名、Profile、状态、执行轮次、结果是否交付及写入范围，不包含提示词、回复正文或 stderr。结果收集应使用完成通知或 `wait_agent`。

## 固定状态区

状态区直接订阅本地管理器事件，不依赖模型调用 wait/list，也不会为刷新耗时而调用模型。只展示任务名称、Profile、状态、可选耗时和工具调用次数，不展示工具参数、命令、文件内容或回复摘要。

```text
✻ 主代理正在处理其他工作…

  子代理 · 2 个运行中 · 1 个已结束
  ├─ explorer · inspect_api · 运行中 · 42s
  ├─ worker · fix_auth · 运行中 · 1m 16s
  └─ reviewer · review_tests · 已完成 · 28s

  Todo
  …
```

运行中任务优先显示，最多显示 4 条代理行，其余用数量汇总，避免挤满终端。完成记录保留到关闭；没有代理时区域为空。组件在关闭和重载时清理计时器与监听器。

未安装 `pi-open-tui` 也能独立使用，面板位于编辑器上方。与 `pi-open-tui` 的联动通过版本化布局事件实现，不硬依赖其源码或导入其内部组件。主代理进入空闲或压缩不会主动清除正在运行的子代理区域。

**隐藏渲染不等于删除父会话中的结果。**主模型收到的工具结果和隐藏通知仍可能随父会话持久化。旧版已经保存的详情不会被本次更新从磁盘擦除，但新渲染器不会展开它们。

## 唯一配置入口

```text
/subagent-config
```

模型、effort、工具和保存范围集中在一个 TUI，不额外注册分散命令。模型可以继承父代理、选择当前/Scoped/已认证可用模型，或手工输入 provider/model；工具可以继承、全部禁用或从已注册工具中选择。

```text
↑/↓    移动
Enter  编辑、选择或确认
Space  在工具列表中切换
Tab    切换保存范围
S      保存
R      将 model、effort、tools 重置为 inherit
Esc    返回或取消
```

保存只修改所选配置层的 model、effort、tools。process、并发、超时、输出、Profile 和未知编辑器元数据保持原样。存在 `PI_SIMPLE_SUBAGENT_CONFIG` 时可选择该显式配置层保存；否则它仍会覆盖低优先级的保存结果。

## 配置文件

优先级从低到高：内置默认值 → `~/.pi/agent/pi-simple-subagent.json` → 受信任项目的 `.pi/pi-simple-subagent.json` → `PI_SIMPLE_SUBAGENT_CONFIG`。

未受信任的项目配置不会读取，也不能从 TUI 写入。配置在用户/工具入口重新加载，无需为了手工 JSON 编辑反复重载。保存采用同目录临时文件加原子重命名，在支持的平台设置为 0600 权限。

完整 JSON 示例见 [examples/pi-simple-subagent.json](examples/pi-simple-subagent.json)，字段 Schema 见 [pi-simple-subagent.schema.json](pi-simple-subagent.schema.json)。兼容旧配置的 `version: 1`，无需新增配置即可启用本次修复。

| 字段 | 作用 |
|---|---|
| `defaultProfile` | 省略、空或纯空格 agent_type 的默认 Profile |
| `model` / `effort` / `tools` | 顶层子代理默认模型、思考等级和工具 |
| `maxAgents` | 未关闭代理数上限，1–32，默认 4 |
| `rpcStartupTimeoutMs` | 启动和 RPC 命令接收超时，默认 15000ms |
| `defaultWaitTimeoutMs` | 仅保留给底层 AgentManager.wait 的兼容参数；不再决定模型工具 wait_agent 的默认等待时间 |
| `maxWaitTimeoutMs` | 模型显式正数等待期限上限，默认 120000ms；不截断默认持续等待 |
| `killGraceMs` / `killForceMs` | SIGTERM / SIGKILL 后的等待时间 |
| `output.maxFinalBytes` / `maxStderrBytes` / `maxActivityItems` | 内部结果、错误输出和活动记录的存储上限 |
| `output.showElapsed` | 固定面板是否显示耗时 |
| `output.showToolActivity` | 固定面板是否显示工具调用次数，不展示活动参数 |
| `output.collapsedActivityItems` / `showUsage` / `showExpandHint` | 兼容旧配置保留；不再启用聊天区活动、token 或展开详情 |
| `process.command` | 子 Pi 命令，默认 pi |
| `process.extraArgs` | 子 Pi 附加参数，保留顺序和重复项 |
| `process.env` / `inheritEnvironment` | 注入环境变量及是否继承父环境 |
| `process.excludeTools` | 无论 allowlist 如何均排除的子代理工具 |
| `process.approveProject` | inherit / always / never，对应项目 trust 的继承或明确覆盖 |
| `profiles.*` | 各 Profile 的 description、systemPrompt、model、effort、tools、cwd、extraArgs、env |

模型、effort 和工具优先级为：单次 spawn 参数 → Profile → 顶层默认值 → 父代理当前设置。`inherit` 继续向下继承；`none` 或空工具数组转换为 `--no-tools`，最终还会应用 excludeTools。

内置 Profile：`default` 用于通用任务；`explorer` 与 `reviewer` 默认只开放 read/grep/find/ls；`worker` 用于限定范围的实现。自定义 Profile 的名称、用途和默认值也会在首次模型请求前被列出，未知非空名称不会静默改成其他角色。

## 进程与生命周期

底层仍使用常驻 RPC 子 Pi：固定 `--mode rpc --no-session`，按解析结果传递 model、thinking、tools、exclude-tools、approve/no-approve 和临时 append-system-prompt 文件。固定传输与会话参数放在自定义额外参数之后，避免早先的冲突参数覆盖它们。

`PI_SIMPLE_SUBAGENT_CHILD=1` 阻止本插件在子 Pi 再次注册编排工具，默认 excludeTools 再排除编排工具。标准输出和错误输出都走管道，不继承主终端。非交互子 Pi 的 select/confirm/input/editor 请求自动取消，notify 等单向通知不误判为阻塞。

父代理被中断、会话切换/树导航、重载或退出时会清理所属子代理和待发送通知。启动期取消会先中止并等待启动清理，再允许派发新的任务，避免取消与同名重启发生竞态。父进程退出后不会恢复子进程上下文。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run check
pi -e "$(pwd)"
```

测试包括配置归一化/覆盖/trust/原子保存、统一配置面板、RPC 子进程启动与复用、错误与重试、UTF-8/JSONL 解码、容量限制、空 Profile、动态 Profile 提示、任务归属、符号链接和补丁重命名、无默认轮询的等待、每轮结果去重、取消及启动清理、隐藏渲染和固定面板生命周期。

RPC 集成测试使用真实启动的模拟 Pi 子进程；自动化测试不等于已验证某个线上模型的全部协作行为或所有终端环境。

## License

MIT
