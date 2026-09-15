> [English](../en/bridge-plugin.md) | [中文](../zh/bridge-plugin.md)

# dsh bridge 插件（packages/bridge-dsh）

一个 **Cordis 插件**，运行在 dsh 进程内。它不修改 dsh 核心，只有出现在 profile 的 bundle 列表里才生效（opt-in）。作用是两件事：**挂 WebSocket 桥** + **注册 `browser_*` 工具**。

## 模块职责

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口：`inject` 声明依赖、解析配置、注册路由/工具、dsh 版本探测、模型服务探测 |
| `protocol.ts` → `@dsh-browser/protocol` | 帧类型+解析器（与扩展共享，唯一真相源） |
| `model-catalog.ts` | 模型目录组装：`llm`/`agentDefaultModel` 的结构化窄接口 + 逐 provider 故障隔离 |
| `server.ts` | WebSocket 服务器：鉴权、单连接、RPC 透传、工具分发、事件泵 |
| `remote-host-api.ts` | **Host 适配层**：把 Typert Gateway + Connection 包装成 `BrowserHostApi` |
| `host-api.ts` | 窄接口 `BrowserHostApi`（call/events/respond），隔离 dsh 版本差异 |
| `tools.ts` | 12 个 `browser_*` 工具定义（模型视角的契约） |
| `token.ts` | bearer token 生成/持久化/恒定时间校验 |
| `extension-sessions.ts` | 记录扩展创建的会话，决定 `ask_user_question` 归谁答 |
| `cordis.patch.yml` | 注册进 profile 时应用的 patch（`insert` 本插件 + 默认配置） |

## 与 dsh 的接口

插件声明 `inject = ['webServer', 'typertGateway', 'connection', 'tools']`，只依赖这四个服务：

- `webServer`：`registerUpgrade`（挂 `/ext/bridge`）+ `register`（挂 `/ext/bridge-config`）+ `port`
- `typertGateway`：`invoke`（一元调用）+ `wireStream.open`（长流：`session/follow`、`$events`）
- `connection`：`createSharedFetchHandler('/api')`（回传 `$events/result` 应答）
- `tools`：`ctx.tools.register`（注册模型可调的工具）

`remote-host-api.ts` 把这三者收敛成 `BrowserHostApi`，所以 dsh 版本演进只改这一处适配，不影响桥服务器和扩展。

此外还有一组**探测式可选服务**（不进 `inject`，用 `ctx.get` 探测，缺失仅让 `model.catalog` 降级不立即使插件不可用）：

- `llm`：`listProviders` / `listModels`——进程内唯一可达 `inputModalities`（多模态权威）的通道，dsh 的 `@Remote` 面都不含它
- `agentDefaultModel`：`currentSelection`——部署默认模型选择

### bridge 自定义 RPC

- `session.history` / `workspace.list`：gateway `wireStream` 上的一层组装（快照展开 / baseline 取值）。
- `model.catalog`：**纯进程内**读取 `llm`+`agentDefaultModel`，返回 `{ default, groups, failures }`；每个 provider 的目录查询独立 try/catch 进 `failures`，不拖垮其余；服务未探测到时返回 `llm-unavailable`，连接与其他 RPC 不受影响。

## 核心机制

| 机制 | 实现 |
|---|---|
| **鉴权** | 路由在 `/api` 信任边界之外，自带 bearer token：首帧 `hello` 5s 内必须带对 token（恒定时间比较）；失败关连接 |
| **回环免密** | 回环连接免 token，但要求 `chrome-extension://` Origin（页面伪造不了该头）；非回环必须带 token |
| **特权隔离** | `settings.*`/`credentials.*`/`host.open*` 等对非回环来源**即使有 token 也拒绝**（防御 `--host 0.0.0.0` 部署） |
| **单连接** | 同一时刻只允许一个扩展连接，新连接顶替旧的（旧 socket 收 4000，in-flight 工具以 `bridge-closed` 结算） |
| **RPC 透传** | 扩展的 `rpc` 帧按方法名路由到网关；`session.prompt`/`session.cancel` 按会话串行化保证顺序 |
| **工具分发** | `tool.call` 帧携带 `expiresAt`，超时/取消发 `tool.cancel` 撤回；结果经 `tool.result` 归一为 `{text}` |
| **事件泵** | 连接建立即开 `$events` 流；首个 `session.prompt` 时开 `session/follow` 跟随该会话，把增量事件转成 `event` 帧 |
| **断代续订** | 换代（重连）后新事件代自动重开最近会话的 `session/follow`；按跨代 seq 游标把断连窗口错过的事件从快照回补推送（先于任何 `session.history` 应答入队，与面板重渲染天然去重）；恢复失败静默降级，不拖垮新连接 |
| **提问转发** | `$events` 里的 `user-questions/request` waterfall，若归属扩展会话则转发为 `question/requested`，否则 `next()` 交给 dsh 原生 UI |

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
- **失败不连累会话创建**：目录不存在或注册被拒时会话照常创建（仅落回「未分组」），并输出一行含配置路径的诊断日志；失败**不会被永久缓存**，目录恢复后下次会话自动重新注册。
- **配置为权威**：若在 GUI 中删除了该工作区，下一次扩展创建会话会按配置重新登记它。要停用请移除本配置项，而不是删除工作区。
- **不建目录**：插件不创建目录（避免掩盖路径拼写错误），目录存在性由部署保证。

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
