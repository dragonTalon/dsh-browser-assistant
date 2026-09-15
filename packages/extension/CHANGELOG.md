# Changelog — `bridge-browser`

The Chrome MV3 extension (service worker + content script + side panel).
Released independently from the bridge plugin, so this version stream and
`bridge-dsh`'s do not line up.

Every entry is bilingual — 中文 first, then an italic English line. The topmost
version section is what the release pipeline publishes to GitHub verbatim (see
`scripts/release-notes.sh`), with a generated load-instructions footer appended.

## 0.2.0

### 新功能 · New features

- **斜杠命令与技能 · Slash commands & skills** — 输入 `/` 在输入区上方弹出可过滤、可键盘操作的菜单，列出**所绑定会话**解析到的两组斜杠词汇：**宿主命令**（`commands.list`：名称 + 宿主描述 + 宿主公布的参数提示）与**用户可调用技能**（`skills.list`：名称 + 描述，仅用户可调用的标注「仅用户」）。同名时命令优先（与宿主裁定一致）。选择只把 `/<name> ` 写回输入框，既不执行也不发送；`/` 开头但两组都不解析的文本（如 `/etc/hosts`）按普通消息发送。

  两组词汇的**调用方式不同**：命令走 `commands.execute`（整行透传，含参数），不建 turn、不产生用户消息、不开启「正在分析」指示器；技能没有执行端点，作为普通消息发送，由宿主注入技能正文。命令的一生只由持久事件 `command/run` / `command/done` 驱动渲染，因此实时与历史重放共用同一条渲染路径、天然一致。

  *Typing `/` opens a filtered, keyboard-navigable menu over the **bound session**'s two slash vocabularies: **host commands** (`commands.list`: name + host description + host-published argument hint) and **user-invocable skills** (`skills.list`: name + description, user-only skills marked). A name published by both resolves to the command, matching the host's own adjudication. Picking only writes `/<name> ` back into the composer — it neither executes nor sends; a `/`-prefixed draft naming nothing in either namespace (e.g. `/etc/hosts`) is sent as an ordinary message.*

  *The two vocabularies are **invoked differently**: a command goes through `commands.execute` (whole line, arguments included) and opens no turn, no user message and no "working" indicator; a skill has no execute endpoint and is sent as an ordinary message for the host to answer by injecting the skill body. A command's life is rendered only from the durable `command/run` / `command/done` events, so the live view and history replay share one path and agree by construction.*

- **会话选择 · Session picker** — 状态栏「会话」下拉，首项恒为「新会话」。候选来自只读的 `session.list`（排除空会话与子代理会话、按最近活动倒序、最多 50 项并说明截断），每项以 `[工作目录名]` 前缀 + 标题 + 运行中标记 + 相对时间呈现。选中历史会话即绑定并重放 `session.history`（先清空再按序重放）；**打开与重连都不创建会话**，因此在 dsh 里不再留下孤儿会话。

  *A "session" dropdown in the status bar, "new session" always first. Candidates come from the read-only `session.list` (blank and sub-agent sessions excluded, most-recent-first, capped at 50 with the cut-off marked), each showing a `[working-directory]` prefix, title, running marker and relative time. Picking a past session binds it and replays `session.history`; **opening or reconnecting never creates a session**, so the panel no longer leaves orphan sessions behind in dsh.*

- **远端 dsh 配置 · Remote dsh configuration** — 状态栏齿轮按钮打开「系统配置」，填 `dsh host` + `token`，保存前可点「测试连接」做一次**独立**握手（不顶替正在工作的连接），并分别报告失败阶段：地址畸形 / 不可达 / 可达但 token 被拒（`4002`）/ 可达但握手超时。地址接受四种写法；`host` 非空时**不再回落本机自动发现**——配错的远端地址必须表现为连不上，而不是悄悄连上本机。

  *A gear button opens **System config** for `dsh host` + `token`, with a **Test connection** that runs one isolated handshake (never evicting the working connection) and reports the failure stage separately: malformed address / unreachable / reachable but token rejected (`4002`) / reachable but handshake timed out. Four address forms are accepted; a non-empty `host` **never falls back to local discovery** — a wrong remote address must read as unreachable, not quietly connect to this machine.*

- **新品牌图形 · New brand mark** — 图标资产整体替换为橙色圆形人物 + 单片眼镜造型（透明背景、墨色描边），5 个位图尺寸由同一母版派生、构图一致；侧边栏状态图标改为以 1:1 尺寸引用 `icon16.png`，不再由浏览器二次降采样。
  *The icon set was replaced with an orange round-faced character wearing a monocle (transparent background, ink outline). All five bitmap sizes derive from one master with identical composition, and the sidebar status icon now references `icon16.png` at 1:1 instead of being downsampled by the browser.*

### 修复 · Fixes

- **输入法组字期间的 Enter 不再被菜单抢走 · An Enter pressed during IME composition is never consumed** — 该按键属于候选词上屏，不是选择条目。`isComposing` 与 `keyCode === 229` 都判，因为提交候选的那个 Enter 可能在 `compositionend` 之后才到达。
  *That key accepts the candidate rather than picking a row. Both `isComposing` and `keyCode === 229` are checked, because the committing Enter can arrive after `compositionend`.*

- **切会话不再被上一会话的在途请求吞掉 · A session switch is no longer swallowed by the previous session's in-flight request** — 目录请求的合流守卫改为按会话键判定，并加连接世代使迟到响应被丢弃。此前在新会话下唤出菜单会走到「命令目录不可用」，而**事实相反**：目录可用，只是请求被守卫吞了。
  *The catalog request guard is now keyed by session, with a connection generation so late responses are dropped. Previously, opening the menu after a switch reported "command list unavailable" when the opposite was true: the catalog was fine, the request had simply been swallowed.*

- **断开连接即清空目录缓存 · The catalog is cleared when the connection drops** — 缓存里的条目指向一个面板已经够不着的宿主，重连前唤出菜单会如实显示「命令目录不可用」，而不是旧宿主的命令。
  *Cached entries name a host the panel can no longer reach; before reconnecting, the menu now reports "command list unavailable" instead of showing the previous host's commands.*

- **描述缺失不再丢掉整条命令 · A missing description no longer costs the whole entry** — 目录条目改为只以**名称**为必需字段。此前宿主未公布描述会导致该条目被丢弃，于是手打该命令会**落回普通消息送给模型**，把命令行当提示词消耗。
  *A catalog entry now requires only its **name**. Previously an unpublished description dropped the entry entirely, so typing that command fell back to an ordinary message and spent the command line as a prompt.*

- **命令超时如实回报 · Command timeouts are reported honestly** — `commands.execute` 可能超出客户端等待预算（如 `/compact`）。面板只提示「未在时限内应答、可能仍在执行、结果以事件流为准」，不声称失败或已取消——命令的真实结论只由 `command/run` / `command/done` 给出。
  *A `commands.execute` can outlive the client's wait budget (e.g. `/compact`). The panel says only that it did not answer within the limit, may still be running, and that the event stream owns the outcome — never that it failed or was cancelled.*

- **选择条目不再无条件重刷目录 · Picking an entry no longer re-fetches the catalog** — 选择条目不可能改变会话，此前一次点击会发两个 RPC（且 `commands.list` 会 resume 会话）。刷新点收敛为「会话绑定 / 连接建立 / 首次唤出 / prompt 被受理」。
  *Picking cannot change the session, yet a click used to fire two RPCs (and `commands.list` resumes a session). Refresh points are now: session bind, connect, first menu open, and prompt accepted.*

- **菜单不再沉默 · The menu is never silent** — 「正在创建会话…」「正在加载命令…」「命令目录不可用，重连后重试」「没有匹配的命令」四种情形各有一条不可选中的说明行。技能目录失败只降级为「本次没有技能」，不牵连命令。
  *Four explanatory, non-selectable rows cover "starting a session…", "loading commands…", "command list unavailable — reconnect to retry" and "no matching command". A failed skill catalog degrades to "no skills this time" without taking the commands down.*

## 0.1.0

### 新功能 · New features

- **框选截图 · Region capture** — 面板拖拽框选页面区域 → 裁剪截图 + 选区内 DOM 元素清单打包进 prompt 发给视觉模型；非视觉模型自动降级为纯元素清单。
  *Drag-select a page region → cropped screenshot + intersecting DOM element list → vision-capable model; non-vision models degrade to the element list.*

- **模型选择 · Model selection** — 面板下拉列出模型目录并标注多模态能力（视觉/文本/未知），选定即经 `session.selectModel` 生效并同步会话实际选中。
  *Dropdown over the model catalog with a capability badge (vision/text/unknown); choosing calls `session.selectModel` and stays in sync with the session.*

- **Markdown 渲染 · Markdown rendering** — assistant 回复用 marked + DOMPurify 渲染为富文本（白名单消毒，防提示注入）。
  *Assistant replies render as rich text via marked + DOMPurify (allow-listed sanitization).*

### 修复 · Fixes

- **选区清单去重 · Region list dedupe** — 收紧元素入选判据（去掉「有 class 即描述」）、容器用直接文本而非整页 `textContent`、排除自注入 overlay/box、补齐文本语义标签。
  *Tightened inclusion criteria, direct-text summaries for containers, exclude self-injected overlay/box nodes, more text-semantic tags.*

- **预判降级 · Predictive degrade** — 已知纯文本模型直接发元素清单，省掉「先发图→失败→重发」往返。
  *Known text-only models skip the guaranteed image round-trip.*

- **重构 + 类型安全 · Refactor + type safety** — 抽出可复用 `common/`（tools + ui），面板拆成单一职责模块；新增 `tsc` 类型检查并修掉历史类型债。
  *Reusable `common/` (tools + ui), the panel split into single-responsibility modules, and `tsc` type-checking added with pre-existing type debt fixed.*

- **CI 修复 · CI fix** — marked/dompurify 声明为依赖并在构建时优先从 node_modules 解析（修复硬编码本地路径导致的 CI 构建失败）。
  *marked/dompurify are declared deps resolved from node_modules (fixes the hardcoded local-path build failure).*

<!-- Earlier versions (0.0.2 and before) predate this changelog; their notes live
     on the GitHub releases for their own tags. -->
