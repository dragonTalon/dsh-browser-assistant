> [English](../en/bridge-plugin.md) | [中文](../zh/bridge-plugin.md)

# dsh bridge 插件（packages/bridge-dsh）

一个 **Cordis 插件**，运行在 dsh 进程内。它不修改 dsh 核心，只有出现在 profile 的 bundle 列表里才生效（opt-in）。作用是两件事：**挂 WebSocket 桥** + **注册 `browser_*` 工具**。

## 模块职责

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口：`inject` 声明依赖、解析配置、注册路由/工具、dsh 版本探测、模型服务探测 |
| `protocol.ts` → [`@dsh-browser/protocol`](protocol.md) | 帧类型+解析器（与扩展共享，唯一真相源） |
| `model-catalog.ts` | 模型目录组装：`llm`/`agentDefaultModel` 的结构化窄接口 + 逐 provider 故障隔离 |
| `server.ts` | WebSocket 服务器：鉴权、单连接、RPC 透传、工具分发、事件泵 |
| `remote-host-api.ts` | **纯 Host 适配层**：把 Typert Gateway + Connection 翻译成 `BrowserHostApi` 与传输原语（`host-streams.ts`），不承载业务逻辑 |
| `host-api.ts` | 窄接口 `BrowserHostApi`（call/events/respond），隔离 dsh 版本差异 |
| `host-streams.ts` | 四个传输原语接口（`SessionFollowSource`/`RemoteEventSource`/`HostInvoker`/`EventResultSender`）：按业务所需的最小流语义定义，与 dsh 0.1.2 线形状无关 |
| `event-generation.ts` | host 无关的事件代业务：session/follow 生命周期、断连回补、跨代游标、waterfall 归属、`AsyncEventQueue`；对 fake transport 可单测 |
| `history-expand.ts` | chunkrow 压缩行展开纯函数（0.1.2 快照 → 标量事件模型） |
| `session-grouping.ts` | host 无关的 workspace 分组：注册/重试/解析，依赖 `HostInvoker` |
| `tools.ts` | 12 个 `browser_*` 工具定义（模型视角的契约）；工具名与语义分类取自协议包注册表（见下） |
| `token.ts` | bearer token 生成/持久化/恒定时间校验 |
| `extension-sessions.ts` | 记录扩展创建的会话，决定 `ask_user_question` 归谁答 |
| `cordis.patch.yml` | 注册进 profile 时应用的 patch（`insert` 本插件 + 默认配置） |

## 与 dsh 的接口

插件声明 `inject = ['webServer', 'typertGateway', 'connection', 'tools']`，只依赖这四个服务：

- `webServer`：`registerUpgrade`（挂 `/ext/bridge`）+ `register`（挂 `/ext/bridge-config`）+ `port`
- `typertGateway`：`invoke`（一元调用）+ `wireStream.open`（长流：`session/follow`、`$events`）
- `connection`：`createSharedFetchHandler('/api')`（回传 `$events/result` 应答）
- `tools`：`ctx.tools.register`（注册模型可调的工具）

`remote-host-api.ts` 把这三者收敛成 `BrowserHostApi`，并实现 `host-streams.ts` 定义的传输原语（快照+增量的 follow、ready+事件的远程流、一元调用、结果回执）。事件代、分组等业务逻辑只消费这些原语，与 dsh 线形状解耦——**dsh 版本演进只重写适配层的形状翻译，业务模块零改动**（回补/去重/跟随替换由 `pnpm check:adapter-seam` 用 fake transport 离线校验）。

此外还有一组**探测式可选服务**（不进 `inject`，用 `ctx.get` 探测，缺失仅让 `model.catalog` 降级不立即使插件不可用）：

- `llm`：`listProviders` / `listModels`——进程内唯一可达 `inputModalities`（多模态权威）的通道，dsh 的 `@Remote` 面都不含它
- `agentDefaultModel`：`currentSelection`——部署默认模型选择

### bridge 自定义 RPC

- `session.history` / `workspace.list`：gateway `wireStream` 上的一层组装（快照展开 / baseline 取值）。
- `model.catalog`：**纯进程内**读取 `llm`+`agentDefaultModel`，返回 `{ default, groups, failures }`；每个 provider 的目录查询独立 try/catch 进 `failures`，不拖垮其余；服务未探测到时返回 `llm-unavailable`，连接与其他 RPC 不受影响。
- `skills.list`：把扩展的技能目录请求转发到网关的 `skills/list`（`args: { request: { sessionId } }`）。**技能是与命令平行的另一个命名空间**：它没有执行端点，调用方式是发一条普通 `session.prompt`，由宿主 pre-step 边界的手势识别注入技能正文。与 `commands.list` 不同，它经 `sessionQuery` 观察会话来定 scope，**不会 resume 未激活的会话**；请求失败时面板降级为「本次没有技能」，不牵连命令目录。
- `commands.list` / `commands.execute`：把扩展的斜杠命令请求转发到网关的 `commands/list` 与 `commands/execute`。载荷中的 `sessionId` 由网关的 `agentId` 查找解析成活体 Agent——该查找器被会话控制器覆盖为「没有活体就 resume」，因此**对未激活的历史会话也能解析，代价是把它真正复活**（面板唤起菜单即会触发）。`commands.execute` 的载荷必须同时携带 `sessionId`（见下方按会话串行化），且 `submittedAttachments` 显式送空数组：面板命令从不携带附件，固定线上形状好过依赖端点的可选参数默认值。缺失或空的 `sessionId`、空的 `line` 一律 `bad-request`。

## 核心机制

| 机制 | 实现 |
|---|---|
| **鉴权** | 路由在 `/api` 信任边界之外，自带 bearer token：首帧 `hello` 5s 内必须带对 token（恒定时间比较）；失败关连接 |
| **回环免密** | 回环连接免 token，但要求 `chrome-extension://` Origin（页面伪造不了该头）；非回环必须带 token |
| **特权隔离** | `settings.*`/`credentials.*`/`host.open*` 等对非回环来源**即使有 token 也拒绝**（防御 `--host 0.0.0.0` 部署） |
| **单连接** | 同一时刻只允许一个扩展连接，新连接顶替旧的（旧 socket 收 4000，in-flight 工具以 `bridge-closed` 结算） |
| **RPC 透传** | 扩展的 `rpc` 帧按方法名路由到网关；`session.prompt`/`session.cancel`/`commands.execute` 按会话串行化保证顺序——斜杠命令改的是下一条 prompt 所处的会话状态（`/plan off` 就是例子），所以「先敲命令再发消息」必须按用户的操作顺序抵达宿主 |
| **保序 RPC 的有界等待** | 按会话串行化意味着一次调用在它结束前一直占着该会话的队列槽位，而宿主命令执行端点的应答要等 handler 结束才产生（如 `/compact` 压缩大量对话）。因此 ordered RPC 另有一道 120s 的有界等待：超时后桥接中止该调用自身的 signal、以 `rpc.result` 失败收尾（错误码 `timeout`），并**释放队列槽位**，使该会话后续的 prompt/cancel/execute 不被一条长命令无限期挡住。两类保证强度不同：**释放槽位是硬保证**（由调用 settle 驱动），**中止宿主是尽力而为**——宿主的 `withAbort` 只包装 Promise，已在运行的 handler 不会因此停下，是否响应取消由各命令自己决定（实测：`/compact` 会停并自行补一条 `command/done`；`/goal`、`/permission`、`/feedback`、`/export` 不会）。所以超时文案只说「未在时限内应答、可能仍在执行、结果以事件流为准」，**绝不声称命令已取消** |
| **工具分发** | `tool.call` 帧携带 `expiresAt`，超时/取消发 `tool.cancel` 撤回；结果经 `tool.result` 归一为 `{text}` |
| **事件泵** | 连接建立即开 `$events` 流；首个 `session.prompt` 时开 `session/follow` 跟随该会话，把增量事件转成 `event` 帧 |
| **断代续订** | 换代（重连）后新事件代自动重开最近会话的 `session/follow`；按跨代 seq 游标把断连窗口错过的事件从快照回补推送（先于任何 `session.history` 应答入队，与面板重渲染天然去重）；恢复失败静默降级，不拖垮新连接 |
| **提问转发** | `$events` 里的 `user-questions/request` waterfall，若归属扩展会话则转发为 `question/requested`，否则 `next()` 交给 dsh 原生 UI |

## 工具注册表（工具语义的唯一事实来源）

12 个工具的名称与语义分类（动作类别 read/observe/mutate/navigate、是否附带页面 delta、是否为导航候选）由 `@dsh-browser/protocol` 的 `browser-tools.ts` 注册表**唯一**声明。档位闸门的分类、扩展的审批判定/delta 附带/导航快照策略全部从注册表派生，任何消费方不得维护本地分类表——一个工具只加进一张表而漏掉另一张，正是写操作失去档位闸门的路径。

- **未注册名 fail-closed**：桥接层对注册表无法识别的工具名以稳定错误码 `unknown-tool` 失败该调用，且**不产生 `tool.call` 帧**——动作不得到达扩展或页面，也不产生审批请求。
- **漂移防护**：`pnpm check:tool-registry` 打包真实源码断言全部消费点派生结果与注册表一致、`unknown-tool` 拒绝路径零帧（用缺失一条注册项的协议 shim 模拟漂移构建），并 grep 断言源码中不再出现本地分类表字面量。

## 权限档位闸门

浏览器写操作的授权按会话权限档位判定，判定发生在桥接侧，扩展只消费结论。

**真相源是会话自身的旋钮事件**。dsh 把档位写成三个普通会话事件——`permission/preset`（用户选定的预设）、`sandbox/mode`、`approval/policy`——桥接折叠这三者得到当前档位。`permissions` 投影由同一批事件导出，但读取它要穿过注册表查询、cell 物化与 schema 校验三层，每层都可能失败，且失败与「这个部署没有档位数据」在调用点完全同形。折叠则是对会话日志的纯函数，同一份日志必得同一结果。

投影仍会被读，但只用于两件事：**得知部署公布了哪些预设名**，以及与折叠结果做**交叉核对**。两者都不取代折叠作为闸门输入。

### 求解结果是三态，互不折算

| 结果 | 含义 | 闸门行为 |
|---|---|---|
| **已求解** | 折叠出预设名，或旋钮不匹配任何预设时为 `custom` | 按档位判定 |
| **无档位能力** | 可证明该部署不提供档位数据（未公布任何预设表） | 省略帧内策略，扩展按 tier 之前的读写两态运行 |
| **求解失败** | 会话存在但档位无法求解 | 以稳定错误码 `permission-tier-unresolved` 显式失败，**不产生审批请求**，也 MUST NOT 按任何档位放行 |

求解失败**不会**回退到部署默认档位。用猜出来的档位继续执行，等于发明一个用户从未选择过的授权；这正是「完全权限下仍然弹确认框」这类故障的来源。失败详情含会话标识与失败环节（`session-unreadable` / `malformed-knob-event` / `no-knob-events` / `preset-bundle-unknown`）。

模型可见的失败文案刻意**不**表述为档位拒绝（否则模型会改找另一个能做同样动作的工具），而是说明档位无法确定并给出重试路径。

### 档位名以部署公布的预设表为准

预设名本身不含语义，因此桥接在挂载期（一次性，非每次调用）探测可选的 `permissionPresets` 宿主服务，把每个预设名解析成 `{sandbox, approval}`，构成完整 bundle 表；取不到的名字回落投影声明，再回落 dsh 内建三档。服务缺失时插件照常启动，无法解释的预设名以 `preset-bundle-unknown` 显式失败而不是被猜成某一档。

会话记录的预设名**不必**出现在当前公布的列表里：部署可能收窄了预设表，而会话日志才是该会话实际运行状态的权威。

`custom`（旋钮不匹配任何预设）按最严档位 `read-only` 判定——那不是「读不出来」，而是「确实不匹配」。

### 交叉核对与档位收紧

折叠是对 dsh 推导的**镜像**，而镜像可能算错，不只是取不到。dsh 由同一批事件导出投影，因此在健康的部署里两者必然一致；不一致时桥接**留痕（含会话标识）并以两者中更严的一方参与判定**——同一权威的两种读法互相矛盾时，不应朝着授权更多的方向消解。投影读取失败不参与收紧，折叠结果照常生效。

档位变动经 `session/event` 追加流驱动：只有真实变化才推送 `session/permission` 事件并（在下降时）用 `tool.cancel` 撤回该会话在途调用。扩展收到的档位始终是闸门实际使用的那一个。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | string | 自动生成 | 固定 bearer token；缺省时首启生成并持久化到 `~/.dsh/ext-bridge-token`（0600） |
| `toolTimeoutMs` | number | 90000 | 单次工具调用预算（覆盖扩展 60s 审批窗口） |
| `snapshotMaxChars` | number | 32000 | 单次快照字符上限（最小 500，经 `hello.ok` 协商给扩展） |
| `maxInteractiveItems` | number | 60 | 快照交互清单条目上限 |
| `sessionWorkspace` | string | 未启用 | 扩展创建的会话归入哪个工作区：填一个**已存在**的绝对目录路径；缺省、空串或纯空白时不启用 |

### 会话工作区分组（`sessionWorkspace`）

配置后，桥接层转发扩展发起的 `session.create` 时会先**幂等**地把该目录注册为 dsh 工作区，再把解析出的 `workspaceId` 注入请求，使新会话成为该工作区成员——在 dsh GUI 侧边栏里按目录 basename 分组显示，而不是堆在「未分组」。

注意分组判定只认工作区的**成员账本**（`sessionIds`），不比对 `cwd`；因此只给会话补一个 `cwd` 是不会产生分组的，必须给到 `workspaceId`。

- **只影响新建会话**：dsh 唯一的「收养」入口要求会话 header 的 `cwd` 等于工作区 path，历史会话 cwd 不同，无法迁移；存量会话需在 GUI 侧自行处理。
- **显式位置优先**：请求自带 `workspaceId` 或 `cwd` 时不注入，调用方的选择原样透传。
- **失败不连累会话创建**：目录不存在或注册被拒时会话照常创建（仅落回「未分组」），并输出一行含配置路径的诊断日志。注册失败分两类处理：**瞬时**原因（网关暂不可用、调用超时、应答丢失）会在**同一次** `session.create` 内重试一次，因此在工作区尚未建出的部署上，首个会话也会先建工作区再开会话；**永久**原因（路径不存在、请求被拒）不做无意义重试，直接退回未分组。失败**不会被永久缓存**，目录恢复后下次会话自动重新注册。
- **配置为权威**：若在 GUI 中删除了该工作区，下一次扩展创建会话会按配置重新登记它。要停用请移除本配置项，而不是删除工作区。
- **不建目录**：插件不创建目录（避免掩盖路径拼写错误），目录存在性由部署保证。

### 排查：会话没有进分组

分组点只发生在**扩展发起 `session.create` 的那一刻**——那是桥接唯一能注入 `workspaceId` 的时机。所以「会话在 dsh 里，但不在分组下」只可能是三件事之一，且都能从日志与注册表读出来：

1. **配置未生效**：插件挂载时会打印 `会话分组已启用，扩展创建的会话将归入工作区 <路径>`。没有这一行，就是该 dsh 进程没读到 `sessionWorkspace`（配置写进了别的 profile，或改完没重启）。
2. **注册没成功**：每次解析都会留痕——`正在把 <路径> 注册为 dsh 工作区…`，随后是 `工作区已解析 workspaceId=…`（成功，后续会话复用该身份）或 `sessionWorkspace … 注册失败（<code>: <message>）…`（失败，本次会话不分组；失败不固化，下次重试）。调用方自己取消时留下 `session.create 到达时调用方已取消…`。
3. **那次会话早于分组能力**：注册发生之前创建的会话不会被追溯分组。用下面的脚本对照「注册表成员」与「该目录下真实存在的会话文件」，差集就是没分组的那些：

```sh
pnpm check:grouping:status                     # 默认检查 packages/bridge-dsh
node scripts/check-grouping-status.mjs <dir>   # 指定配置目录
```

存量会话无法由桥接迁移（见上条），要让它出现在分组下只能由 GUI 侧处理或新建会话；脚本存在的意义是让这件事**可判定**，而不是靠猜。

> 机器相关的绝对路径**不要**写进随包发布的 `cordis.patch.yml`，而应写进 profile 覆盖层（该文件后于所有 bundle 层应用，且随 profile 热加载）：
>
> ```yaml
> - id: bridge-dsh
>   config:
>     sessionWorkspace: /absolute/path/to/your/project
> ```

## 工具清单

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 结构化文本快照（标题/URL/正文/编号清单/表单）；`delta:true` 只返回变化 |
| `browser_click` / `browser_type` / `browser_press` | 按稳定编号点击 / 输入（React/Vue 兼容）/ 按键 |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` | 滚动 / 导航 / 新标签页 |
| `browser_back` / `browser_forward` / `browser_reload` | 历史前进后退 / 刷新 |
| `browser_get_text` / `browser_wait` | 读指定区域文本 / 等页面稳定 |

所有工具产出单一 `{text}`，`browser_snapshot` 的编号即其余工具的寻址空间；工具名即 wire action 名（桥与扩展共用）。
