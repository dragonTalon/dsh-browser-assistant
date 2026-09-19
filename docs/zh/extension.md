> [English](../en/extension.md) | [中文](../zh/extension.md)

# Chrome 扩展（packages/extension）

MV3 扩展，三段式：**service worker（控制中心）+ content script（碰 DOM 的唯一部分）+ side panel（对话 UI）**。它不直接连 dsh 的会话，只经后台统一转发。

## 三部分职责

| 部分 | 职责 | 关键文件 |
|---|---|---|
| **background/** | 桥客户端（发现/重连/心跳）、RPC 转发与帧编解码、工具分发、审批协调、当前页追踪、日志 | `index.ts`(装配)、`bridge.ts`、`frames.ts`、`types.ts`、`rpc.ts`、`tools.ts`、`authorization.ts`、`approval-coordinator.ts`、`navigation.ts`、`region.ts` |
| **content/** | 页面→文本快照、执行点击/输入/滚动/导航、稳定编号、敏感遮蔽、框选区域 | `index.ts`、`snapshot.ts`、`extract.ts`、`actions.ts`、`ids.ts`、`privacy.ts`、`region.ts` |
| **panel/** | 对话、会话选择、斜杠命令与技能、模型选择、框选截图、Markdown 渲染、日志、审批框、问答框、系统配置 | `main.ts`(组装根) + `transport`/`conversation`/`session-selector`/`slash-command`/`slash-command-text`/`model-selector`/`region`/`question`/`approval`/`status`/`settings`/`errors`/`log` + 共享 `common/`（`tools/` + `ui/` + `slash-catalog` + `session-list` + `session-events` + `connection-state` + `region`）；`index.html` |

## 核心机制

### 连接与存活
- **发现**：`host` 留空时探测端口 → `fetch /ext/bridge-config` → `WebSocket` → `hello` 握手。帧结构与握手过程见 [protocol.md](protocol.md)。
- **远端 dsh**：状态栏齿轮按钮打开「系统配置」弹窗，填 `dsh host` 与 `token`。地址接受 `10.0.0.7:3080`、`localhost:3080`、`wss://dsh.example.com`、完整 `ws://host:port/ext/bridge` 四种写法——不带 scheme 时补 `ws://` 与 `/ext/bridge`，带 scheme 时保留（`http`/`https` 映射为 `ws`/`wss`），带子路径时原样保留（反代挂在子路径的场景）。`host` 非空时**不再回落本机自动发现**：配错的远端地址必须表现为连不上，而不是悄悄连上本机。
- **配置即可验证**：输入时实时显示生效地址（纯本地计算，不发请求）；`测试连接` 用**独立的一次性连接**做完整 `hello` 握手（不顶替正在工作的连接），失败按阶段分开报：地址格式无效 / 地址不可达 / 地址可达但 token 被拒绝（`4002`）/ 地址可达但握手超时；`保存并重连` 等真实重连结果，失败时弹窗保持打开并保留输入。
- **token**：远端连接必须填（服务端对非回环来源强制校验，无例外）。本机可用 `cat ~/.dsh/ext-bridge-token` 获取；粘贴内容的**首尾空白会被自动去掉**——token 文件以换行结尾，而服务端按字节全等比较，不去掉就会稳定得到 `4002`。
- **重连**：指数退避（500ms→10s 封顶+抖动）；`4000` 视为「被顶替」直接停，不互相挤。
- **抗 SW 挂起**：面板 20s 心跳 + 30s alarm，双保险避免空闲挂起掐断 WebSocket；断开时清「正在分析」，重连后拉 `session.history` 恢复遗漏的最终输出。

### 工具分发与审批
- 收到 `tool.call` → 解析受控标签页 → 生成审批提示（`authorization.ts` 纯函数）→ 需审批则走 `approval-coordinator`（60s 窗口）→ 派发到 content script → `tool.result`。
- **读默认 auto**（`browser_snapshot`/`get_text`）；**写一律 fail-closed 审批**；无面板则超时拒绝。
- **工具语义分类单一事实来源**：工具名与语义分类（读/观察/修改/导航、delta 附带、导航候选）由共享注册表（protocol 包 `browser-tools.ts`）声明；`authorization.ts` 的审批判定与 `tools.ts` 的 delta/导航策略全部派生自注册表，扩展不维护本地分类表（漂移防护见 [bridge-plugin.md](bridge-plugin.md) 的工具注册表一节）。`background/types.ts` 收拢 `ToolCall`/`ToolAnswer`/`ContentBudget`/`TabFrame`，`BridgeState`/`RegionElement`/`RegionRect` 下沉 `common/`——面板不依赖 background 运行时模块、background 不依赖 content 模块取类型。
- 派发前做「目标是否仍有效」校验（文档 ID 匹配），避免审批期间页面变了误操作。

### 页面快照（文本优先）
- **稳定编号**：`WeakMap<Element,number>` 一次性分配 + `data-dsh-el`，跨快照不漂移。
- **命名**：aria-label → label → aria-labelledby → 可见文本 → placeholder（`extract.ts` 的 ARIA 优先级链）。
- **正文提取**：「readability-lite」——`<main>`→单篇 `<article>`→含 ≥2 段落的最大文本块打分。
- **delta 快照**：只返回变化/移除/重编号，省 token。
- **iframes**：`webNavigation.getAllFrames` 发现，主帧 80% 预算、子帧均分剩余，`(frame,index)` 寻址。
- **沉降检测**：`MutationObserver`+`readystatechange`，按动作类型分层（点击/输入/滚动各自策略），稳定页秒回、持续动画有硬上限。

### 隐私
- 密码/卡号/CVV 按 `type=password`、`autocomplete=cc-*`、id/name/aria-label 正则判定，掩码 `••••`，永不回传。
- 页面文本包一层随机 nonce 的「不可信内容」边界，防提示注入（防御纵深，审批才是强制边界）。

### 当前页感知
- `tabs.onActivated`/`onUpdated`/`windows.onFocusChanged` 追踪活动标签页（URL+标题），面板实时显示，并在 `session.prompt` 时注入 `[网页描述]：<title> (<url>)`，让模型有上下文。

### 对话与交互
- **简单对话**：会话身份由「会话选择」决定；首次发送时才 `session.create` → `session.prompt` → 订阅 `event` 流渲染；「正在分析」指示覆盖「思考→调工具→执行→输出」全程（严格跟随 turn：`turn/start` 显示、`turn/end` 清除，中间文本/工具事件不清除）。
- **会话选择**：状态栏「会话」下拉，首项恒为「新会话」且默认选中。候选来自只读的 `session.list`：排除空会话与子代理会话、按最近活动倒序、最多 50 项（超出时末尾以不可选项说明），每项以 `[工作目录名]` 方括号前缀开头（工作目录未知时省略），随后是标题（无标题回退会话标识前 8 位）、运行中标记与相对时间。**打开与重连都不创建会话**——创建发生在首次发送、首次为本会话选模型，或**在「新会话」状态下唤出斜杠命令菜单**（命令目录是会话级的，菜单需要会话才能解析，见下条）。因此仅仅打开面板不会留下孤儿会话，但在「新会话」下敲一次 `/` 会创建一个。选中历史会话即绑定并读 `session.history` 重放（先清空再按序重放，`hasMore` 时顶部提示「更早消息未显示」）；**不走 `session.create { sessionId }`**——那条路会被注入桥配置的 `sessionWorkspace`，cwd 不匹配时 dsh 直接 `session/conflict`，且会把会话改挂到该工作区；冷会话由 dsh 在首次 prompt 时自行 resume。事件按 `sessionId` 隔离（切换瞬间的旧会话残留帧被丢弃），重放期间到达的实时帧按 `seq` 缓冲、重放后补齐，切换会话不取消原会话的进行中 turn，切回时依赖桥接的按会话游标回补。dsh 提问与浏览器操作审批**刻意不按会话过滤**：被切走的会话上仍有待答交互时，面板是唯一应答者。
- **模型选择与能力标记**：输入区**右侧**的丸状下拉（靠右对齐，与 dsh GUI 同款观感）每次 connected 后重拉 `model.catalog`（只读）。当前选中的确定次序：会话历史 `projections.values.modelSelection` 的 `next` → `lastUsed` → 目录 `default`；同步通道三条——`session.selectModel` 成功乐观更新、事件流里的 `model/selection` 即时对齐、重连 `session.history` 投影兜底。多模态标记三元态：候选/当前模型 `inputModalities` 含 `image`→「视觉」、公布且不含→「文本」、未公布或目录查无此项→「能力未知」（不臆断），当前模型的能力另以小 badge 紧随下拉。下拉选定即调 `session.selectModel`；**该 dsh 行为会同时改写部署默认模型**（`agentDefaultModel.saveSelection`），以便在选择器 tooltip 常驻如实提示。目录拉取失败时选择器显示「模型不可用」并在对话里给出含错误码的失败行，不阻断消息收发。
- **权限档位与页面分享（两条正交的轴）**：输入区**左侧**（紧接框选按钮）的丸状下拉是**会话权限档位**（能力轴），标签与 dsh 界面一致（`仅可查看`/`工作区内修改`/`完全权限`）。当前值与候选全部来自会话历史 `projections.values.permissions` 的 `currentValue` 与 `options`——**候选不硬编码**，部署自定义的 preset 名按其公布名称显示，桥接不认识的档位如实呈现为「自定义」且不可选。切换经桥接 RPC（`permission.set` → dsh 的 `/permission <preset>`）执行；**成功与否以投影回流为唯一判据**，不靠写入调用的返回值，因此「写入成功但档位没变」不会显示成切换成功。切到 `完全权限` 前必过一次风险确认（勾选式，**每次重新确认、不记住选择**），文案同时说明「浏览器操作不再需要确认」与「该档位同时放开 dsh 侧的文件与命令权限」。
  **「新会话」状态下也能先配档位**：此时没有绑定会话，但部署的档位表是从 `session.list` 里任一会话的投影读到的（只读、不创建会话），所以控件照常列出候选并可选；选定后才创建会话并提交切换——与「首次选模型」同样的惰性创建，仅打开面板不会留下孤儿会话。系统配置弹框里的**页面分享**是隐私轴（`自动`/`每次询问`/`关闭`），只决定页面内容能否被读取并送给模型，与档位互不影响；它应用在 change 事件上而非「保存并重连」，因为偏好下一次工具调用即生效。该控件让审批弹框里的「总是允许读取」所写入的偏好**可见且可撤销**（此前面板没有任何入口能读到它）。
  档位同步有三条通道：会话历史投影是基线、桥接在档位**实际变化**时推送的 `session/permission` 事件是增量、面板切换时的乐观更新是即时反馈——冲突时以投影为准。断开期间的变化不推送，面板在下次打开会话或重连拉历史时经投影基线追上（档位是当前值快照，没有需要回补的中间态）。
- **dsh 提问**（`ask_user_question`）：`question/requested` 弹问题框（选项/自定义输入），作答经 `respond` 回传。- **斜杠命令与技能**：输入以 `/` 开头时在输入区上方弹出浮层，列出**当前绑定会话**解析到的两组斜杠词汇——**宿主命令**（`commands.list`：名称 + 宿主描述 + 宿主公布的参数提示）与**用户可调用技能**（`skills.list`：名称 + 描述，仅用户可调用的标注「仅用户」）。按 `/` 之后的文本做包含过滤，↑↓ 在条目间移动、Enter 选择、Esc 关闭（草稿保留）、点击条目选择、点击菜单外关闭；选择只把 `/<name> ` 写回输入框，**不执行也不发送**。**同名时命令优先**（与宿主的裁定一致）。目录在会话绑定、连接建立、每次发送成功以及首次唤出菜单时刷新。命令与技能都是会话级的（宿主按会话解析），所以「新会话」状态下敲 `/` 会**即时创建并绑定一个会话**再按它取目录——面板不会拿某个用户没选择过的已有会话来解析。注意：命令目录经 `agentId` 查找会 resume 未激活的会话（技能目录不会，它按 `sessionQuery` 观察会话），因此**唤起菜单即会激活所绑定的历史会话**。菜单给不出条目时不会沉默，「正在创建会话…/正在加载命令…/命令目录不可用，重连后重试/没有匹配的命令」四种情形各有一条不可选中的说明。
  - **两组词汇的调用方式不同**：**命令**走 `commands.execute`（整行透传），**不建 turn、不产生用户消息、不开启「正在分析」指示器**（该指示器严格跟随 turn 生命周期，而命令没有 turn）；**技能没有执行端点**——面板把 `/name` 作为**普通消息**发送，由宿主 pre-step 边界的手势识别注入技能正文（`source.kind === 'user'` 的 prompt 正是它期望的载荷），因此技能会正常产生一轮对话与回复。
  - **可用性与参数**：目录里的条目**全部**可选可执行，面板不做任何本地能力判定——宿主是每条命令自身语法的唯一权威。命令行**允许携带参数**，面板把整行原样交给宿主（`/goal clear`、`/permission workspace-write`、`/plan off`、`/feedback <text>` 都是各自文档化的正常形态）。初版曾内置一份「无参数才有用」的白名单并把其余标成「暂不支持」，那是错的：面板本就是纯文本框，而本部署 6 条宿主命令里有 4 条的正常用法都带参数——禁用它们等于废掉这个功能。菜单条目会把参数提示与描述一并呈现。
  - **输入法与目录生命周期**：**输入法组字期间的 Enter 不会被菜单消费**——它属于候选词上屏，不是选择条目（`isComposing` 与 `keyCode === 229` 都判，因为提交候选的那个 Enter 可能在 `compositionend` 之后到达）。目录缓存在**连接断开时清空**：缓存里的条目指向一个面板已经够不着的宿主，重连前唤出菜单会如实显示「命令目录不可用」而不是旧宿主的命令。
  - **命令超时如实回报**：命令执行请求（`commands.execute`）可能超出客户端等待预算（如 `/compact` 压缩大量对话）。超时后面板**只提示「未在时限内应答、可能仍在执行、结果以事件流为准」**，不声称命令已失败或被取消——命令的真实结论只由 `command/run`/`command/done` 事件给出。桥接侧对按会话保序的调用另有一道更宽的有界等待（120s，远大于客户端的 30s），超时会释放该会话的队列槽位，使后续消息不被一条长命令无限期挡住；桥接**不保证**中止宿主的命令处理器（是否响应取消由各命令自己决定）。
  - **技能目录失败不牵连命令**：技能目录读不到（或部署未挂技能注册表、会话无 cwd）时降级为「本次没有技能」，命令照常可用；只有**命令**目录失败才显示「命令目录不可用」。
  - **提交路由**：命中条目 → 按命名空间分流（命令 `commands.execute` / 技能普通 prompt）；目录读取失败 → 提示原因且**不发送**、保留草稿（条目可能存在，只是确认不了）；以 `/` 开头但名字两组都不解析（如 `/etc/hosts`）→ 按普通消息发送，与 dsh Web GUI 的未命中行为一致。有待发选区时选区发送优先，菜单不会吞掉选区意图。
  - **生命周期呈现**：命令行渲染**只**由 `command/run`（建「执行中…」行）与 `command/done`（按 `commandId` 定稿为 ✓/✕ 并显示结果文本）两条持久事件驱动，不看 RPC 回执。因此实时与历史重放共用同一条渲染路径、天然一致；结果事件先于开始事件到达（历史被截断）时就地建行，不丢弃。命令的 RPC 超时只记诊断日志、不算失败（结果以事件流为准），其余准入失败（不会有生命周期事件来解释）才显示提示。命令名、参数、宿主描述与结果文本一律按纯文本渲染，绝不进入 `innerHTML`。
- **状态/日志**：顶部状态条（连接态+地址+重连次数+当前页）+ 可折叠日志面板（info/warn/error 分色，环形缓冲回放）。

## 安全模型

| 边界 | 机制 |
|---|---|
| 桥鉴权 | bearer token（5s hello、恒定时间）；远端连接必须提供 |
| 回环免密 | 仅限 `chrome-extension://` Origin |
| 特权方法 | 非回环拒绝 `settings.*`/`credentials.*`/`host.openPath`/`host.pickDirectory`——**远端连接下这些功能不可用**，面板把该失败如实说明为「仅本机可用」，不显示原始错误码 |
| 连接目标 | `connect-src` 允许任意 `ws://`/`wss://`（远端部署需要）；放宽的只是连接目标，token 校验、档位闸门、审批与回环闸均不变 |
| 页面数据 | 文本-only 无截图；敏感字段掩码；不可信内容包裹 |
| 动作（能力轴） | 按**会话权限档位**分级：`仅可查看` 一律拒绝改页面与开网站（`tool.call` 根本不出网）；`工作区内修改` fail-closed 人工审批（无应答＝拒绝，60s 超时＝拒绝）；`完全权限` 直接执行且不产生审批请求 |
| 档位来源 | 桥接从 dsh 会话的 `permissions` 投影独立求解，随 `tool.call` 下发；扩展**不参与求解**、不从本地配置推导，上报的任何「已确认」声明不构成授权 |
| 页面分享（隐私轴） | 与档位**正交**的本地偏好：`自动` 放行页面读取、`每次询问` 逐次确认、`关闭` 一律拒绝。任一档位下读取强度只由它决定；档位放开的是「能做什么」，不放开「什么数据可以离开页面」 |
| 不可动内核 | 档位判定不可由扩展影响 —— 授权来源不可伪造。这是「写操作一律审批」被档位化之后仍然成立的那条不变式 |

### TLS 反代部署示例（远端场景推荐）

远端连接若走明文 `ws://`，页面文本快照、prompt 与 token 都会明文过网。推荐在 dsh 前放一层终止 TLS 的反向代理，用 `wss://` 接入：

```nginx
# dsh web 监听 127.0.0.1:3080，反代对外只暴露 wss
server {
  listen 443 ssl;
  server_name dsh.example.com;
  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

  location /ext/ {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # /ext/bridge 是 WebSocket 升级
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                    # 桥靠 ping 保活，别让空闲超时掐断
  }
}
```

配置弹窗里填 `wss://dsh.example.com` 即可（扩展自动补 `/ext/bridge`）；反代挂在子路径时填全路径（如 `wss://dsh.example.com/dsh/ext/bridge`）。token 仍是 `远端机器上的 ~/.dsh/ext-bridge-token`。
