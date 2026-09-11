# pi-simple-subagent

面向 Pi 的后台子代理插件。每个子代理运行在独立的 `pi --mode rpc --no-session` 进程中，拥有独立上下文，不创建自己的 session 文件；进程存活期间可以通过主代理的 `send_input` 工具继续任务并复用上下文。

主代理负责拆分、协调、验收和汇总；子代理在后台独立完成被委派的任务。主聊天区只显示英文派发与等待状态，不显示子任务提示词、思考、回复正文或日志。子任务最终结果仍交给主代理，由主代理汇总给用户。

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

更新后重新启动 Pi，卸载旧命令与事件处理器，并创建新的子代理。固定 tag/commit 的安装需要调整对应 ref；本地目录安装需要同步该目录。本次无需更新 `pi-open-tui`，无需新增配置文件，也不会恢复 spinner 下的子代理面板。

运行环境：Node.js 22.19 或更高版本，以及支持 RPC 模型/思考强度选择、`agent_settled` 和自定义工具渲染的 Pi。开发测试依赖 Pi 0.84.4 系列。

## 0.3.3：仅保留后台运行

- 移除 `/agents` 命令及子代理交互视图，不再提供进入子上下文查看或直接发送 prompt 的界面。
- 删除交互视图使用的对话镜像、流式重建缓存、私有消息订阅和历史读取接口，不再为查看子会话维护这些状态。
- 移除进入子视图时暂停主代理工具、暂存完成通知的逻辑。完成结果由后台协调器直接按原来的去重规则交付；任务归属和写入冲突检查仍然有效。
- 保留五个模型工具、`/subagent-config` 统一配置入口、Profile 模型/effort 优先级及实际 RPC 回读校验。
- 保留 0.3.2 的单行 `Spawn agent` 与精简 `wait_agent` 展示。删除界面中指向已移除命令的提示。

## 模型与思考强度选择

模型工具的选择顺序：

```text
显式 profiles.<选中角色>.model
  > 显式顶层 model（包括 /subagent-config 保存的值）
  > spawn_agent.model（仅当以上两项都继承/未设置时）
  > 父代理当前模型
  > 子 Pi 自身默认模型（父模型也不可用时）
```

思考强度使用相同的配置优先原则：

```text
显式 profiles.<选中角色>.effort
  > 显式顶层 effort
  > spawn_agent.reasoning_effort
  > 父代理当前 effort
  > 子 Pi 自身默认 effort
```

`inherit` 或未设置表示继续向下选择。模型配置中的空白也视为未指定。Profile 的显式设置优先于顶层设置；在 `/subagent-config` 改变顶层模型或 effort，不会清除 Profile 覆盖。`off` 是明确关闭思考，例如 Profile 为 `off`、模型工具传 `high`，最终仍采用 `off`。

建议使用完整且精确的 `provider/model`。仅提供模型 ID 时，必须在子进程可用模型列表中唯一匹配；不使用模糊名称替代明确配置。模型和认证必须在子 Pi 中可用。

启动时先获取可用模型，执行 RPC `set_model`，在其后设置 effort，再用 `get_state` 确认实际模型与思考强度。如果 Pi 因模型能力或子扩展将强度改成其他值，插件会报告 `Subagent reasoning effort mismatch` 并拒绝提交任务；应修改为该模型支持的配置，而不是静默换成父代理强度。这里验证的是 Pi 实际报告的配置，不代表能验证远端服务内部如何执行推理。

收到 assistant 完整响应后，还会记录响应声明的 provider/model；与已验证模型不同时报告错误。子代理自己的模型和 effort 设置不改写父会话或全局默认值。

**配置改变仅影响新创建的子代理。**已有子代理及其后续 `send_input` 保留创建时的模型、effort 和写入范围。继续一个已完成子代理时，会重新设置并核验它原来的模型和 effort。需要更换时关闭并重新派发。

模型工具返回 `requested_model`、`model`、`model_source`、`ignored_model_override`；思考强度对应 `requested_effort`、`reasoning_effort`、`effort_source`、`ignored_effort_override`，用于诊断选择来源与被忽略的模型参数。工具 allowlist 的覆盖顺序不变：单次参数 > Profile > 顶层配置 > 父代理。

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

`agent_type` 省略、空字符串或纯空格时采用 `defaultProfile`；非空未知名称明确报错。第一次请求模型前会动态列出实际 Profile，以及对应的模型和 effort 配置。内置 `default` 用于通用任务，`explorer` 用于只读探索，`worker` 用于实现，`reviewer` 用于只读审查。

可选参数：`model`、`reasoning_effort`、`tools`、`cwd`。通常省略以使用配置；`tools: []` 禁用工具。模型与 effort 参数受上文的配置优先规则约束。`cwd` 可以是绝对路径或相对父工作目录的路径。

#### write_scope

范围相对于解析后的子代理工作目录，可以是精确文件、已有目录，或以 `/`、`/**` 结尾的新目录范围。不支持 `src/*.ts` 一类任意 glob。路径规范化会解析已有祖先的符号链接；补丁同时检查原文件和 `Move to` 目标。

`worker` 必须提供非空范围，其他 Profile 可选，但修改型任务都应声明。范围在异步启动前预留，避免并行子任务冲突；主代理执行中的文件写入也会阻止重叠分配。

主代理的 `write`、`edit`、`MultiEdit`、`apply_patch` 若写入运行中子任务的范围，会被阻止。读取共享背景文件不受限制。子任务完成后允许验收和整合；提前接管应先 `close_agent`。

**这不是文件系统沙箱。**子代理自身范围主要通过提示词约束；任意 shell、第三方工具和外部副作用不在显式路径检查覆盖范围内。语义上的重复调查依赖协作规则；不会自动创建 Git worktree。

### send_input

```json
{"target":"inspect_api","message":"继续检查第二个问题。","interrupt":false}
```

这是主代理调用的编排工具，不是用户进入子代理的交互命令。已完成、失败或中断的代理开始下一轮 RPC prompt；运行中 `interrupt=false` 排队 follow-up，`interrupt=true` 发送 steer。继续已完成代理前重新检查原范围是否被占用。prompt 被拒绝时恢复上一轮状态和交付标记。

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
● Spawn agent (explorer · pi_plugin_sources · sub2api/gpt-5.6-luna max)

● Waiting for subagents
  ⎿  explorer · pi_plugin_sources · Running · 42s
  ⎿  Waiting for a new result…
```

`Spawn agent` 的信息全部放在单行括号内，不再有 `⎿` 子行；正常标题只包含 Profile、任务名、实际模型和 effort。完成时圆点变为成功颜色，启动失败或任务失败仍显示英文错误提示。旧历史没有保存 effort 时省略该字段，不借用主代理传入的参数。窄屏标题按终端宽度截断。

`wait_agent` 只保留 Profile、任务名、状态和耗时，不显示工具数、provider/model 或 effort。状态和耗时本地刷新，不产生额外模型轮询；等待期间、完成和显式超时分别保留相应英文提示。`send_input`、`close_agent`、`list_agents` 的展示不变，超出可见数量时仅提示剩余条数。

普通/展开模式都不显示子任务 Prompt、Response、思考、原始工具参数或 stderr。旧会话已经保存的详情不会被升级从磁盘擦除，但主工具渲染不展示它们。隐藏展示不等于删除父会话结果：父模型收到的最终结果和隐藏通知仍可能随父会话持久化。

后台运行不等于脱离父进程常驻：父 Pi 关闭、会话切换或取消任务仍会清理子代理；父进程退出后不能恢复这份子上下文。

## 唯一配置入口

```text
/subagent-config
```

模型、effort、工具与保存范围集中配置。配置面板支持模型继承、已认证模型选择、手工 provider/model，以及工具继承/禁用/allowlist。

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
| 其余旧 `output.show*` / `collapsedActivityItems` | 保留配置兼容；主界面内联卡片使用固定精简展示 |
| `process.command` / `extraArgs` / `env` | 子 Pi 可执行文件、额外参数、环境变量 |
| `process.inheritEnvironment` | 是否继承父环境 |
| `process.excludeTools` | 子代理工具排除列表 |
| `process.approveProject` | inherit / always / never，控制项目批准继承 |

子进程设置 `PI_SIMPLE_SUBAGENT_CHILD=1`，不再次注册编排工具或配置命令；默认 excludeTools 是另一层递归保护。非交互子进程的阻塞扩展 UI 请求自动取消，普通通知不会被误判为阻塞。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run check
```

测试包括后台命令与模块清理、模型/effort 配置优先级与实际 RPC 回读、`off` 保护、拒绝不一致配置下提交任务、旧代理续聊与新配置隔离、无对话镜像时的 RPC 最终结果提取、任务归属、结果去重、无需轮询的完成通知、持续等待、取消与会话切换清理、主聊天区隔离、程序化 queue/steer、单行派发与精简等待渲染、控制字符和 UTF-8 处理。RPC 集成测试使用模拟 Pi 子进程，不调用真实模型服务。

## License

MIT
