> [English](../en/protocol.md) | [中文](../zh/protocol.md)

# 线协议（packages/protocol）

本项目的两半——dsh 桥插件（Node）与 Chrome MV3 扩展（浏览器）——不共享任何运行时。它们共享的是**这个包**：一条 WebSocket 消息一个 JSON 对象，以 `t` 字段判别，类型与校验只写一次。两端 import 同一份 `protocol.ts`，所以**帧结构不可能漂移**——只在一边做的改动编译不过，而不是运行时才炸。

该包**零依赖**（只有类型、常量与纯函数），以源码 alias 的形式进入两端构建，自身不带来任何依赖。

## 模块地图

| 文件 | 职责 |
|---|---|
| `protocol.ts` | 帧、常量、`parseBridgeFrame` 解析器与 `isServerFrame`/`isClientFrame` 类型守卫——**唯一真相源** |
| `endpoint.ts` | 用户输入的地址（`10.0.0.7:3080`、`wss://…`）如何变成桥的 WebSocket URL |
| `prompt.ts` | 框选截图 prompt 的组装 + 每条 `session.prompt` 前置的页面上下文前缀 |
| `index.ts` | barrel 再导出（`export *`），因此移动模块不会牵动 importer |

## 传输

| 方面 | 取值 |
|---|---|
| 桥路由 | `BRIDGE_PATH` = `/ext/bridge`——一条 WebSocket 升级路由，挂在 dsh `/api` 信任栅栏**之外**，自带 bearer token |
| 发现 | `BRIDGE_CONFIG_PATH` = `/ext/bridge-config`——返回 `{ wsUrl }`，这是零配置本机发现成立的原因 |
| 分帧 | 一条 WebSocket 消息一个 JSON 对象，以字符串字段 `t` 判别 |
| 关联 | `id` 由请求方铸造、由应答方回显；它是**不透明字符串**，从不被解析 |
| 握手期限 | `HELLO_TIMEOUT_MS` = 5s——首帧必须是 `hello` |
| 存活 | `PING_INTERVAL_MS` = 30s 服务端 ping；客户端答 `pong` |

## 握手

```
   扩展                                        bridge 插件
       │                                            │
       │  hello { token, caps }                     │  ← 必须在 5s 内到达
       ├───────────────────────────────────────────▶│
       │                                            │  恒定时间比较 token
       │  hello.ok { caps }                         │
       │◀───────────────────────────────────────────┤
       │                                            │
       └─ 失败时：error { code, message }，随后关闭 socket
```

`caps` 即 `BridgeCaps`：`textOnly: true`（字面量类型——模型工具链路永不携带截图）、`snapshotMaxChars`（配置的快照预算，最小 500）与 `maxInteractiveItems`。客户端在 `hello` 里声明自己的看法；服务端在 `hello.ok` 里给出**生效**的边界，快照预算实际就是在这里谈定的。

两个关闭码携带面板会如实呈现的含义：`4002`——token 被拒绝；`4000`——本连接被更新的连接顶替（桥同一时刻只服务一个扩展连接）。

## 帧清单

### 客户端 → 服务端（`ClientFrame`）

| `t` | 字段 | 含义 |
|---|---|---|
| `hello` | `token`、`caps` | 首帧，socket 打开后 5s 内 |
| `rpc` | `id`、`method`、`payload` | 一元调用，由当前 Host 适配层投射 |
| `respond` | `id`、`rpcId`、`result` | 应答或取消一个待决的宿主交互（如 `ask_user_question`） |
| `tool.result` | `id`、`ok: true`、`result`——或——`id`、`ok: false`、`error` | 先前派发的工具调用的结果 |
| `pong` | — | 存活应答 |

### 服务端 → 客户端（`ServerFrame`）

| `t` | 字段 | 含义 |
|---|---|---|
| `hello.ok` | `caps` | 合法 `hello` 之后被接受 |
| `rpc.result` | `id`、`ok: true`、`result`——或——`id`、`ok: false`、`error: { code, message }` | 对 `rpc` 帧的应答 |
| `respond.result` | `id`、`ok`、`result` / `error` | `respond` 帧的回执（通常为 `{ accepted: boolean }`） |
| `event` | `frame: { rpcId, method, payload }` | 一个桥自有的事件信封，由 Remote 流与 waterfall 投射而来 |
| `tool.call` | `id`、`name`、`args`、`expiresAt`、`sessionId?` | 模型请求的浏览器操作，在用户受控标签页里执行 |
| `tool.cancel` | `id` | 撤回一个已超时或其调用方被取消的工具调用 |
| `ping` | — | 存活探测 |
| `error` | `code`、`message` | 致命连接错误；客户端应重新鉴权 |

## 类型守卫与解析器

- `isServerFrame(frame)` / `isClientFrame(frame)` 在类型层面按方向收窄，因此**服务端消费方绝不会拿自己的请求词汇去分发**，客户端也一样。
- `parseBridgeFrame(text)` 是入站文本的唯一入口。凡不是合法帧的输入——JSON 畸形、不是对象、`t` 缺失或非字符串、`t` 未知、或已知 `t` 但必填字段不对——它一律返回 `undefined`，**从不抛异常**。消费方把 `undefined` 当作「丢弃这条消息」。
- 解析器对它认识的形状是严格的：例如 `tool.call` 要求 `expiresAt` 是有限正数，并拒绝纯空白的 `sessionId`；而缺失的 `sessionId` 会保持缺失。

## RPC 方法

`rpc` 帧按方法名路由，分两族。

**桥自有**——由插件组装，不转发：

| 方法 | 用途 |
|---|---|
| `session.history` / `workspace.list` | 网关 `wireStream` 上的一层组装（快照展开 / baseline 取值） |
| `model.catalog` | **纯进程内**读取 `llm` + `agentDefaultModel` |
| `skills.list` | 某个会话的用户可调用技能 |
| `commands.list` / `commands.execute` | 某个会话的斜杠命令，以及执行一条命令行 |
| `bridge.injectBrowserSnapshot` | 内部：显式交接标签页后，为 Agent 的下一步播种快照 |
| `bridge.session.purge` | 内部：永久删除某个会话的持久存储 |

**透传**——其余一切按方法名转发给 dsh 网关（`session.*`、`settings.*`、`credentials.*`、`host.*` …），受两条协议层约束：

- **特权隔离**：`settings.*`、`credentials.*`、`host.open*` 对非回环来源**即使 token 合法也拒绝**。
- **按会话保序**：`session.prompt`、`session.cancel`、`commands.execute` 按会话串行化——斜杠命令改的是下一条 prompt 所处的会话状态。保序调用另有一道 120s 有界等待：超时后桥接中止该调用自身的 signal、以 `rpc.result` 失败收尾（错误码 `timeout`）并**释放队列槽位**。详见 [bridge-plugin.md](bridge-plugin.md)。

## 斜杠词汇的契约

三条斜杠 RPC 是本包中唯一载荷被类型化（而非以 `unknown` 贯穿）的 RPC。它们**纯类型**——零运行时开销、不改帧结构——存在的意义是让宿主侧的字段改名变成编译错误，而不是面板里静默消失的一列。

| 类型 | 角色 |
|---|---|
| `CommandsListRequest` | `commands.list` 的请求体：`{ sessionId }` |
| `CommandDescriptorWire` | 一条命令：`name`、`description`、可选 `input.hint` |
| `CommandInputDescriptorWire` | 可选的自由形式参数提示 |
| `SkillsListRequest` | `skills.list` 的请求体：`{ sessionId }` |
| `SkillSummaryWire` | 一个技能：`name`、`description`、可选 `whenToUse`、`modelInvocable` |
| `SkillsListValueWire` | `{ skills: [...] }` 信封 |
| `CommandExecuteRequest` | `{ sessionId, line }`——`line` 是整条命令行（含参数）；`sessionId` 是为桥的保序而存在，不是给宿主的 |
| `CommandExecuteResult` | `{ commandId, result }`，其中 `result` 为 `{ kind: 'success', text?, sourceEventSeq? }` 或 `{ kind: 'error', text }` |

宿主自己的描述符才是真相源，上述字段名与它逐一对应。这些类型描述的是**良构**载荷长什么样，而不是承诺它一定会到达——面板仍然防御式解析。

## 常量

| 常量 | 取值 | 含义 |
|---|---|---|
| `BRIDGE_PATH` | `/ext/bridge` | WebSocket 升级路由 |
| `BRIDGE_CONFIG_PATH` | `/ext/bridge-config` | 发现端点 |
| `HELLO_TIMEOUT_MS` | `5000` | 首帧期限 |
| `PING_INTERVAL_MS` | `30000` | 服务端 ping 节奏 |
| `DEFAULT_TOKEN_BYTES` | `32` | 自动生成的 256 位 bearer token |
| `DEFAULT_SNAPSHOT_MAX_CHARS` | `32000` | 默认快照预算 |
| `MIN_SNAPSHOT_MAX_CHARS` | `500` | 能同时容纳两道信任边界与页面文本的最小预算 |
| `MAX_SCREENSHOT_BYTES` | `2000000` | 单张框选截图的编码字节上限（base64 膨胀之前） |
| `MAX_REGION_ELEMENTS` | `30` | 单次框选描述的交集元素上限 |

## 错误词汇

`ToolErrorCode` 是**开放集合**——消费方必须容忍自己不认识的状态码：

| 状态码 | 含义 |
|---|---|
| `no-active-tab` | 没有可控标签页 |
| `content-unavailable` | 该 frame 内 content script 不可达 |
| `action-failed` | 页面操作本身失败 |
| `timeout` | 调用未在其预算内 settle（也是保序 RPC 的 deadline 错误码） |
| `bridge-closed` | 调用进行中桥消失 |
| `bad-args` | 工具调用的参数被拒 |
| `internal` | 桥侧意外失败 |

`ToolError` 把这样一个状态码与给模型看的人类可读文本配成一对。

## Prompt 组装

`prompt.ts` 承载构造 `session.prompt` 的词汇，放在这里是为了让两半对分段标签保持一致：

- `PromptImagePart`——面板可追加的一个图片部分：`type: 'image'`、取自 `PromptImageMediaType` 的 `mediaType`、规范 base64 的 `data`，以及可选的 `name`（永远不是文件系统路径）。
- `buildPageContext(title, url)`——每条 prompt 前置的页面上下文前缀。
- `buildRegionScreenshotText(elementList)` / `buildRegionQuestionText(intent)`——框选截图 prompt 的固定分段布局；用户只框选未写文字时以 `EMPTY_INTENT` 占位。

## 铁律

以下规则让两半始终是一个系统：

1. **`protocol.ts` 是唯一真相源。** 绝不在任何一端重新声明帧、常量或方法名。
2. **新增帧变体是两端改动。** 在这里加、在两端处理，并重建两个产物（`lib/index.js` 与 `dist/`）——扩展 bundle 引用的是这份源码，重建才算真正落地。
3. **方法名是常量**，不是散落各处的字符串字面量。
4. **关联 id 不透明**，必须原样回显。
5. **错误码是开放集合**；未知状态码被容忍，绝不致命。
6. **方向由类型守卫强制**，因此任何一端都无法拿对方的词汇去分发。
