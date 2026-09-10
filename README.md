# pi-simple-subagent

面向 Pi 的后台子代理插件。每个子代理运行在独立的 `pi --mode rpc --no-session` 进程中，拥有独立上下文，不创建自己的 session 文件；进程存活期间可以继续接收 prompt 并复用上下文。

主代理负责拆分、协调、验收和汇总；子代理独立完成被委派的任务。主聊天区显示英文状态卡片，不显示子任务提示词、回复正文或日志。用户可以主动通过 `/agents` 进入子代理视图，查看并继续它自己的对话。

## 安装与升级

```bash
pi install git:github.com/CoderDoubleflower/pi-simple-subagent
```

临时使用：

```bash
pi -e git:github.com/CoderDoubleflower/pi-simple-subagent
```

已通过 Git 安装的用户定向更新：

```bash
pi update git:github.com/CoderDoubleflower/pi-simple-subagent
```

更新后重新启动 Pi，加载新工具定义与命令。固定 tag/commit 的安装需要调整对应 ref；本地目录安装需要同步该目录。本次无需更新 `pi-open-tui`：子代理不再挂载 spinner 下的面板，也不再发出该面板的布局事件。插件仍可与 `pi-open-tui` 一同使用。

运行环境：Node.js 22.19 或更高版本，以及支持 RPC 模型选择、`agent_settled` 和自定义工具渲染的 Pi。开发测试依赖 Pi 0.84.4 系列。

## 本次行为变化

- 显式配置的 Profile/顶层子代理模型优先于模型生成的 `spawn_agent.model`，避免主模型将自己的模型名称传入工具而覆盖用户设置。
- 提交子任务之前，通过 RPC 精确选择模型并回读实际模型。模型不存在、名称歧义或实际模型不一致时明确报错，不静默继承父模型。返回和状态卡片会显示实际模型。
- 子代理状态回到主聊天区，采用英文内联卡片。`wait_agent` 显示 `Waiting for subagents`；耗时和状态通过本地事件刷新，不产生额外模型轮询。
- `/agents` 可以进入正在运行或已完成但尚未关闭的子进程，使用它原有的上下文继续交互。不会创建第二份子会话，也不会将直接输入的 prompt 当成父会话用户消息发送。
- 保留任务归属、写入冲突检查、默认持续等待、按执行轮次去重的隐藏完成通知，以及空 Profile 回退。

## 模型选择与验证

模型工具的选择顺序：

```text
显式 profiles.<选中角色>.model
  > 显式顶层 model（包括 /subagent-config 保存的值）
  > spawn_agent.model（仅当以上两项都继承/未设置时）
  > 父代理当前模型
  > 子 Pi 自身默认模型（父模型也不可用时）
```

`inherit`、空白和未设置表示继续向下选择。Profile 的显式模型仍然优先于顶层设置；在配置面板中改变顶层模型不会清除 Profile 覆盖。配置文件的加载优先级也仍然生效，见下文。

建议使用完整且精确的 `provider/model`。仅提供模型 ID 时，必须在子进程可用模型列表中唯一匹配；不使用模糊名称替代明确配置。模型和认证必须在子 Pi 中可用。

启动时先获取可用模型，执行 RPC `set_model`，在其后设置 effort，再用 `get_state` 确认。收到 assistant 完整响应后还会记录响应声明的 provider/model；检测到与已验证模型不同会报告错误。子代理自己的模型设置不改写父会话或全局默认模型。如果其他子进程扩展在验证之后再次切换模型，应检查该扩展，而不是将状态卡片中的配置值误认为实际值。

**配置改变仅影响新创建的子代理。**已有子代理及其后续 `send_input`、`/agents` 对话保留创建时的模型与写入范围。需要切换时关闭并重新派发。

模型工具返回的 `requested_model`、`model`、`model_source` 和 `ignored_model_override` 用于诊断选择来源；实际模型同时显示在状态卡片与 `/agents` 中。effort 和工具的覆盖顺序仍为单次参数 > Profile > 顶层配置 > 父代理。

## 模型工具

### spawn_agent

启动后台子代理，等待 RPC prompt 被接受后返回，不等待整个任务完成。主模型应继续不重叠的工作；没有独立工作时调用一次 `wait_agent` 等待。

```json
{
  "task_name": "inspect_api",
  "message": "只读检查 src/api，指出接口设计问题并给出文件位置。",
  "agent_type": "explorer"
}
```

修改型任务：

```json
{
  "task_name": "fix_auth",
  "message": "修复鉴权逻辑并补充回归测试。报告修改文件和测试结果。",
  "agent_type": "worker",
  "write_scope": ["src/auth/**", "tests/auth/**"]
}
```

`task_name` 使用小写字母、数字和下划线，以字母或数字开头，最长 64 个字符；同一管理器内唯一，关闭后可复用。`message` 应包含完成任务所需的背景，子代理不会自动获得父对话全文。

`agent_type` 省略、空字符串或纯空格时采用 `defaultProfile`；非空未知名称明确报错。第一次请求模型前会动态列出当前实际 Profile。内置 `default` 用于通用任务，`explorer` 用于只读探索，`worker` 用于实现，`reviewer` 用于只读审查。

可选参数：`model`、`reasoning_effort`、`tools`、`cwd`。通常省略以继承配置；`tools: []` 禁用工具。模型参数受上文的用户配置优先规则约束。`cwd` 可以是绝对路径或相对父工作目录的路径。

#### write_scope

范围相对于解析后的子代理工作目录，可以是精确文件、已有目录，或以 `/`、`/**` 结尾的新目录范围。不支持 `src/*.ts` 一类任意 glob。路径规范化会解析已有祖先的符号链接；补丁同时检查原文件和 `Move to` 目标。

`worker` 必须提供非空范围，其他 Profile 可选，但修改型任务都应声明。范围在异步启动前预留，避免并行子任务冲突；主代理执行中的文件写入也会阻止重叠分配。

主代理的 `write`、`edit`、`MultiEdit`、`apply_patch` 若写入运行中子任务的范围，会被阻止。读取共享背景文件不受限制。子任务完成后允许验收和整合；提前接管应先 `close_agent`。

**这不是文件系统沙箱。**子代理自身范围主要通过提示词约束；任意 shell、第三方工具和外部副作用不在显式路径检查覆盖范围内。语义上的重复调查依赖协作规则；不会自动创建 Git worktree。

### send_input

```json
{"target":"inspect_api","message":"继续检查第二个问题。","interrupt":false}
```

已完成、失败或中断的代理开始下一轮 RPC prompt；运行中 `interrupt=false` 排队 follow-up，`interrupt=true` 发送 steer。继续已完成代理前重新检查原范围是否被占用。prompt 被拒绝时恢复上一轮状态和交付标记。

### wait_agent

```json
{"ids":["inspect_api","fix_auth"]}
```

等待任一目标产生尚未交付的新终态结果。省略 `timeout_ms` 或传 `0` 时持续等待；已经交付过的 A 不会使等待仍运行中的 B 立即返回。正数超时至少 1000ms，最多 `maxWaitTimeoutMs`；超时不会取消任务、释放归属或授权重复执行。

返回 `status`、本次领取的 `results`、`timed_out` 和 `all_finished`。未知目标返回 `not_found`，所有结果已交付且没有运行中目标时返回空 results。结果正文给父模型使用，不直接渲染到主聊天区。

没有等待者领取的完成结果，通过隐藏消息主动投递给父模型。同一执行轮次只交付一次；以 `agent_settled` 为完成边界，而非一条 assistant 文本。`list_agents` 不用于轮询进度或重复收集结果。

### close_agent / list_agents

`close_agent` 接收 `{"target":"inspect_api"}`，先发 RPC abort，再用 SIGTERM/SIGKILL 兜底，释放进程槽位和归属，不携带旧回复正文。已完成代理仍占用 `maxAgents`，直到关闭。

`list_agents` 接收空对象，仅返回 ID、任务名、Profile、状态、轮次、交付标记与范围，不包含提示词、回复或日志。

## 主聊天区渲染

```text
● Spawn agent (inspect_api)
  ⎿  explorer · inspect_api · Running · 42s · 6 tools · provider/child-model

● Waiting for subagents
  ⎿  explorer · inspect_api · Running · 42s · 6 tools · provider/child-model
  ⎿  Waiting for a new result…
```

状态和耗时本地刷新；完成后变为 `Completed`、出错为 `Failed`。只显示精简元数据，普通/展开模式都不显示子任务 Prompt、Response、原始工具参数或 stderr。旧会话中已经保存的敏感详情不会被本次升级从磁盘擦除，但新工具渲染不展示它们。

隐藏展示不等于删除父会话结果：父模型收到的最终结果和隐藏通知仍可能随父会话持久化。

## /agents：进入子代理上下文

```text
/agents
/agents inspect_api
/agents agent_0123456789abcdef
```

不带参数打开列表；带任务名或 ID 直接进入。界面展示子进程真实的用户/assistant 消息并流式刷新。工具记录仅展示名称与完成状态，不展开文件内容；思考块和原始日志不展示。长历史的显示缓存有限，**不会因此截断子模型的真实上下文**。

| 按键 | 行为 |
|---|---|
| 列表 ↑/↓、Enter | 选择并进入代理 |
| Enter | 发送 prompt |
| Shift+Enter | 换行（取决于终端键盘协议） |
| Tab | 切换 Queue follow-up / Steer current work |
| PgUp / PgDn | 滚动子对话 |
| Esc | 子对话返回列表；列表返回父界面 |
| Ctrl+G / Ctrl+C | 返回父界面，不关闭子代理 |

子代理运行中，Queue 把提示排到后续任务，Steer 在子代理可处理的工具边界重定向工作，不是立即杀死进程。子代理已完成时，发送 prompt 会在同一上下文开始下一轮。原模型和 write_scope 仍然适用。

打开视图期间，**主代理后续的工具调用边界会暂缓**，已经执行中的工具或模型流不强制中断。完成通知暂存到退出视图后投递，减少用户与主代理同时操作子任务的冲突。返回后主流程继续；子代理进程不会因为视图关闭而结束。

`/agents` 是现有 RPC 子进程的交互视图，不是第二个完整原生 Pi TUI，不支持子代理 slash command、图片输入或扩展交互弹窗。RPC/无头父进程不能打开该视图。父进程关闭、会话切换或取消任务仍会清理子代理，不能在父进程退出后恢复这份上下文。

## 唯一配置入口

```text
/subagent-config
```

模型、effort、工具与保存范围集中配置；`/agents` 是运行中交互入口，不是第二套配置界面。配置面板支持模型继承、已认证模型选择、手工 provider/model，以及工具继承/禁用/allowlist。

↑/↓ 移动，Enter 编辑，Space 切换工具，Tab 切换保存范围，S 保存，R 重置快捷字段为 inherit，Esc 返回。保存只修改选中配置层的 model、effort、tools，保留 process、Profile、超时和未知编辑器元数据。

## 配置文件

优先级从低到高：内置默认值 → `~/.pi/agent/pi-simple-subagent.json` → 受信任项目的 `.pi/pi-simple-subagent.json` → `PI_SIMPLE_SUBAGENT_CONFIG`。

未受信任项目的配置不读取，也不允许从面板写入。配置在入口重新加载，保存采用原子替换，在支持的平台设为 0600。显式配置文件仍会覆盖较低层的面板保存；已有子代理设置不会随配置重读改变。

完整示例见 [examples/pi-simple-subagent.json](examples/pi-simple-subagent.json)，Schema 见 [pi-simple-subagent.schema.json](pi-simple-subagent.schema.json)。兼容 `version: 1`，无需新建配置文件。

| 字段 | 作用 |
|---|---|
| `defaultProfile` | 省略/空 agent_type 的默认 Profile |
| `model` / `effort` / `tools` | 顶层子代理设置 |
| `profiles.*` | 每个角色的模型、effort、工具、提示词、cwd、CLI 参数与环境 |
| `maxAgents` | 未关闭代理上限，默认 4，范围 1–32 |
| `rpcStartupTimeoutMs` | 启动与 RPC 接收超时，默认 15000ms |
| `defaultWaitTimeoutMs` | 底层 AgentManager.wait 的兼容默认值，不决定模型工具 wait_agent 的持续等待 |
| `maxWaitTimeoutMs` | 显式正数等待上限，默认 120000ms |
| `killGraceMs` / `killForceMs` | SIGTERM / SIGKILL 后等待时间 |
| `output.maxFinalBytes` / `maxStderrBytes` / `maxActivityItems` | 内部结果、日志、活动存储上限 |
| 其余旧 `output.show*` / `collapsedActivityItems` | 保留配置兼容；内联卡片使用固定精简展示，不展开正文 |
| `process.command` / `extraArgs` / `env` | 子 Pi 可执行文件、额外参数、环境变量 |
| `process.inheritEnvironment` | 是否继承父环境 |
| `process.excludeTools` | 子代理工具排除列表 |
| `process.approveProject` | inherit / always / never，控制项目批准继承 |

子进程设置 `PI_SIMPLE_SUBAGENT_CHILD=1`，不再次注册编排工具或 `/agents`；默认 excludeTools 是另一层递归保护。非交互子进程的阻塞扩展 UI 请求自动取消，普通通知不会被误判为阻塞。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run check
```

测试包括配置覆盖、RPC 启停和错误恢复、模型精确选择与实际回读、任务归属、结果去重、持续等待、内联渲染隔离、独立上下文续聊、queue/steer、视图生命周期与按键、窄终端宽高约束、UTF-8 安全截断。RPC 集成测试使用模拟 Pi 子进程，不调用真实模型服务。

## License

MIT
