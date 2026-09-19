# Changelog — `bridge-dsh`

The dsh-side bridge plugin (Cordis). Released independently from the Chrome
extension, so this version stream and `bridge-browser`'s do not line up.

Every entry is bilingual — 中文 first, then an italic English line. The release
pipeline publishes the section whose `## <version>` heading matches the tag
verbatim (see `scripts/release-notes.sh`), so `## Unreleased` is never published
and an unpublished pending section stays at the top.

## 0.3.0

### 新功能 · New features

- **会话权限档位闸门 · Session permission-tier gate** — 浏览器写操作的授权不再是「一律人工审批」，而是**会话级权限档位**：桥接从会话自身的持久旋钮事件（`permission/preset` + `sandbox/mode` + `approval/policy`）折叠出当前档位，并在**工具调用到达扩展之前**闸门每次调用——`仅可查看` 直接拒绝改页面与开网站且不发帧，`工作区内修改` 放行并下发 `ask`（无应答即拒绝、超时即拒绝），`完全权限` 放行并下发 `auto`（不产生审批请求）。新增 `permission.set` RPC（经 dsh 的 `/permission <preset>` 切换）与 `session/permission` 事件（**仅在档位实际变化时**推送）；档位下降时桥接用 `tool.cancel` 撤回该会话在途的浏览器调用，含正等待确认的那些。求解结果是互不折算的三态：**已求解** / **无档位能力**（部署未公布预设表，退化为档位之前的读写两态）/ **求解失败**（以 `permission-tier-unresolved` 显式失败，不产生审批请求，也 MUST NOT 回退到任何档位）。档位名以部署公布的预设表为准（不硬编码白名单），`custom` 按最严档位处理；投影只用于获知预设表并与折叠结果交叉核对，分歧时以更严一方判定并留痕。授权不可伪造：扩展上报的任何「已确认」声明不参与判定。
  *Browser write authorization is no longer a flat "always confirm" — it is a **session-level permission tier**. The bridge folds the session's own durable knob events (`permission/preset` + `sandbox/mode` + `approval/policy`) into the current tier and gates every call **before it reaches the extension**: `read-only` refuses page mutation and navigation outright and writes no frame, `workspace-write` passes the call with `ask` (no answer, or a timeout, means refusal), `danger-full-access` passes it with `auto` (no approval request at all). New `permission.set` RPC (switching via dsh's `/permission <preset>`) and `session/permission` event (emitted only on a **real** change); on a downgrade the bridge withdraws that session's in-flight browser calls with `tool.cancel`, including ones already waiting on a confirmation. Solving yields three mutually non-collapsing outcomes: **solved** / **no tier capability** (the deployment publishes no preset table; the pre-tier read/write behavior applies) / **solve failed** (fails explicitly with `permission-tier-unresolved`, produces no approval request, and MUST NOT fall back to any tier). Tier names come from the deployment's advertised preset table (never a hardcoded whitelist), `custom` is treated as the strictest tier, and the projection is read only for the preset table plus a cross-check against the fold — a disagreement gates on the stricter side and leaves a trace. Authorization cannot be forged: nothing the extension claims participates in the decision.*

- **浏览器工具注册表：工具语义的唯一事实来源 · Shared browser-tool registry: one source of truth for tool semantics** — `@dsh-browser/protocol` 新增 `browser-tools.ts`：12 个工具的名称与语义分类（read/observe/mutate/navigate、是否附带页面 delta、是否导航候选）由这一份注册表唯一声明，桥接档位闸门与扩展的审批判定、delta 附带、导航快照策略全部从它派生。注册表无法识别的工具名在桥接层以稳定错误码 `unknown-tool` 失败，且**不产生 `tool.call` 帧**——动作不得到达扩展或页面，也不产生审批请求。`pnpm check:tool-registry` 断言全部消费点与注册表一致，并用「删掉一条注册项」的协议 shim 复现漂移构建，证明拒绝发生在任何帧之前。
  *`@dsh-browser/protocol` gained `browser-tools.ts`: the 12 tools' names and semantic classifications (read/observe/mutate/navigate, page-delta attachment, navigation candidacy) are declared in exactly one registry, and the bridge's tier gate plus the extension's approval judgement, delta attachment and navigation snapshot policy all derive from it. A name the registry does not recognize fails at the bridge with the stable code `unknown-tool` and **writes no `tool.call` frame** — the action never reaches the extension or the page and produces no approval request. `pnpm check:tool-registry` asserts that every consumer agrees with the registry and re-bundles with a protocol shim missing one descriptor to prove the refusal happens before any frame.*

- **适配层只做形状翻译，业务逻辑与 dsh 版本解耦 · The adapter only translates shapes; business logic is decoupled from the dsh version** — 新增 `host-streams.ts` 定义四个传输原语，并把事件代（`event-generation.ts`）、历史压缩行展开（`history-expand.ts`）、工作区分组（`session-grouping.ts` 含瞬时失败重试）从 `remote-host-api.ts` 中拆出。dsh 版本演进现在只重写适配层的形状翻译，跨代游标、断连回补、waterfall 归属、分组注册等业务模块零改动，并能对 fake transport 离线断言（`pnpm check:adapter-seam`，16 项）。
  *New `host-streams.ts` defines four transport primitives, and event generation (`event-generation.ts`), compacted-history expansion (`history-expand.ts`) and workspace grouping (`session-grouping.ts`, including the transient-failure retry) were extracted out of `remote-host-api.ts`. A dsh version change now rewrites only the adapter's shape translation, leaving cross-generation cursors, disconnect backfill, waterfall ownership and grouping registration untouched — and those modules are asserted offline against a fake transport (16 assertions in `pnpm check:adapter-seam`).*

- **一条命令的离线套件 + 拒绝在失败时打 tag 的发布门禁 · A one-command offline suite plus a release gate that refuses to tag on failure** — 新增 `scripts/run-tests.mjs` 作为唯一入口：`pnpm test` = typecheck + 9 个离线行为校验，`pnpm test:e2e` 追加两条实机检查；`scripts/tag-release.sh` 先核对版本号与对应包的 `package.json`（扩展还要核对 `manifest.json`）一致，跑完门禁才创建并推送 tag，任何一步失败都不留下 tag。同时清除仓库里的机器相关绝对路径：`tsconfig.base.json` 的 `typeRoots` 与两个 `build.sh` 的 deepseek-harness 回退分支全部删除，dsh 宿主类型改由 `scripts/link-dsh-types.sh` 软链进包内；依赖一律来自 workspace 安装（`pnpm install --frozen-lockfile --offline` 走本地 store 即可恢复）。`pnpm check:permission`（43 项）与 `pnpm check:tool-registry` 把档位规则与注册表漂移钉住。离线校验本身也不再依赖本机环境：打包时把只在 dsh 安装里存在的 `@deepseek-ai/*` 宿主包替换为 stub，构建产物断言仅在产物存在时执行（干净 checkout 上如实 SKIP 而不是失败），`ws` 声明为根 devDependency——干净 checkout 与 CI 上 `pnpm test` 都能跑完全部 9 项。
  *New `scripts/run-tests.mjs` is the single entry point: `pnpm test` = typecheck + 9 offline behavioral checks, `pnpm test:e2e` appends the two live checks. `scripts/tag-release.sh` verifies the version against the package's `package.json` (and the extension's `manifest.json`), runs the gate, and only then creates and pushes the tag — a failing step leaves no tag behind. Machine-specific absolute paths are gone from the repo: the `typeRoots` entry in `tsconfig.base.json` and the deepseek-harness fallbacks in both `build.sh` scripts were deleted, dsh host types are linked into the package by `scripts/link-dsh-types.sh`, and dependencies come from the workspace install (`pnpm install --frozen-lockfile --offline` restores them from the local store). `pnpm check:permission` (43 assertions) and `pnpm check:tool-registry` pin the tier rules and the registry drift. The offline checks no longer depend on this machine either: the `@deepseek-ai/*` host packages, which exist only inside a dsh installation, are replaced by stubs at bundle time, the built-artifact assertions run only when an artifact is present (a clean checkout reports an honest SKIP instead of failing), and `ws` is declared as a root devDependency — so all 9 checks run on a clean checkout and on CI.*

### 排查能力 · Diagnostics

- **分组的每一步都有痕迹 · Every grouping decision leaves a trace** — 会话分组是「静默增强」：注册失败只让会话落回「未分组」，此前除了一行 warn 之外看不出桥接是否尝试过注册、是否复用了缓存身份、或是否根本没走到这一步。现在启用分组时会打印一行 `会话分组已启用…`，之后每次 `session.create` 都有一条轨迹：`正在把 <路径> 注册为 dsh 工作区…` → `工作区已解析 workspaceId=…`（成功）或 `sessionWorkspace … 注册失败（<code>: <message>）`（失败）；自带 `workspaceId`/`cwd` 的请求报告「原样转发」，调用方已取消的请求报告「跳过注册、不会分组」。离线契约校验从 16 项扩到 24 项，把「轨迹必须能区分这三种结局」也钉住。
  *Session grouping is a silent enhancement: a failed registration only drops the Session into "Ungrouped", and beyond a single warn line nothing showed whether the bridge tried to register, reused a cached identity, or never reached that code at all. Enabling grouping now logs `会话分组已启用…` at mount, and every `session.create` leaves a trace: `正在把 <path> 注册为 dsh 工作区…` → `工作区已解析 workspaceId=…` (success) or `sessionWorkspace … 注册失败（<code>: <message>）` (failure); a request carrying its own `workspaceId`/`cwd` reports that it was forwarded untouched, and an already-cancelled caller reports that registration was skipped. The offline contract check grew from 16 to 24 assertions, pinning that those three outcomes are distinguishable in the trace.*

- **`check:grouping:status`：只读排查脚本 · `check:grouping:status`: a read-only triage script** — 对照 dsh 工作区注册表里的成员账与配置目录下**真实存在**的会话文件，列出没有归入分组的会话；不需要 dsh、不需要 Chrome、不产生任何 RPC。用来回答「会话在 dsh 里但不在分组下」时，究竟是注册没发生，还是那次会话早于分组能力。
  *Diffs the dsh Workspace registry's membership against the Session files that actually exist under the configured directory, listing the ones that never landed in the group — no dsh, no Chrome, no RPC. It answers whether a "session exists but is not grouped" report means registration never happened, or that the Session simply predates the feature.*

### 修复 · Fixes

- **档位真正生效：读的是发布视图，不是宿主 fold state · Tiers actually apply now: the bridge reads the published view, not the unit's fold state** — 桥接层从 `sessionProjections.stateOf(session, 'permissions')` 读档位，但那返回的是该投影单元的**宿主状态**（`preset`/`sandbox`/`approval`/`seeded`），而档位视图（`options`/`currentValue`）是单元 `view()` 产出、经 `viewSchema` 校验后才交给客户端的那一份。字段名不同，于是 `resolvePermission` 永远得到 `undefined`、判定为「本部署无档位能力」，而扩展侧对无策略的调用按 fail-closed 当作 `ask`。后果是**档位整体失效且没有任何报错**：选「完全权限」照样每次写操作弹确认；选「仅可查看」也不会在桥接层拒绝改页/导航（只剩扩展侧的人工确认兜底）；档位变化通告因此从不触发。现在改读 `sessionProjections.snapshot(session, ['permissions'])` 的 wire view，喂给 watcher 的值也来自同一份校验过的视图。离线契约校验新增 6 项，专门钉住「必须读发布视图、不得读 `stateOf`、缺该能力时报告无档位」，这类静默降级以后不会再溜过。
  *The bridge read the tier from `sessionProjections.stateOf(session, 'permissions')`, which returns the projection unit's **host state** (`preset`/`sandbox`/`approval`/`seeded`) — not the tier view (`options`/`currentValue`), which the unit's `view()` produces and `viewSchema` validates before any client sees it. The field names differ, so `resolvePermission` always got `undefined`, concluded "this deployment has no tier capability", and the extension's fail-closed reading of an absent policy is `ask`. The result was **tiers silently doing nothing, with no error anywhere**: picking full access still prompted for every write, picking read-only did not refuse page mutation at the bridge (only the extension's own confirmation stood in the way), and tier-change announcements never fired. The bridge now reads the wire view from `sessionProjections.snapshot(session, ['permissions'])`, and the value fed to the watcher comes from that same validated view. Six offline assertions pin "read the published view, never `stateOf`, and report no capability when it is unavailable", so this class of silent downgrade cannot slip through again.*

- **工作区先建、会话后开，不再被一次瞬时失败击穿 · The Workspace is created before the Session, and one transient failure can no longer defeat it** — 分组的唯一时机是扩展发起 `session.create` 的那一刻：dsh 的「收养」入口要求会话 header 的 `cwd` 等于工作区 path，所以一旦会话以未分组身份落地，桥接层**无法**再把它迁进分组（`cwd` 不同、且没有别的入口）。此前注册只尝试一次，任何瞬时失败（网关尚未就绪、调用超时、应答在连接换代中丢失）都会让这次会话永久停在「未分组」。现在注册失败按原因分两类：**瞬时**原因在同一次 `session.create` 内重试一次（仍然带完整轨迹），**永久**原因（路径不存在、请求被拒）不做无意义重试。于是「没有这个工作区时先建工作区、再发起会话」在首次会话上也是真保证，而不是只在顺利路径上成立。
  *Grouping has exactly one moment: the extension's `session.create`. dsh's adoption entry point requires the Session header's `cwd` to equal the Workspace path, so once a Session has landed ungrouped the bridge **cannot** migrate it (different `cwd`, and no other entry point exists). Registration used to be tried once, so any transient failure — a gateway that was not ready yet, a timed-out call, an answer lost across a connection generation — parked that Session in "Ungrouped" forever. Failures are now split by cause: a **transient** one is retried inside the same `session.create` (still fully traced), while a **permanent** one (missing path, rejected request) is not retried pointlessly. "Create the Workspace first, then start the Session" is therefore a real guarantee on the very first Session, not just on the happy path.*

- **`sync-profile.sh` 不再因硬链接把自己当来源而失败 · `sync-profile.sh` no longer fails when the profile's lib is hardlinked to the workspace build** — 开发机上 profile 的插件 `lib` 常与 workspace 构建产物是同一个 inode，此时 `cp` 会以「源与目标相同」失败。现在先判 `-ef`：是同一份就报告「已是同一份，无需拷贝」并正常退出，不再尝试拷贝，也就不会再留下半截备份。
  *On a dev machine the profile's plugin `lib` is often the same inode as the workspace build, and `cp` then fails with "source and destination are the same file". The script now checks `-ef` first: when they are one file it reports that no copy is needed and exits successfully instead of attempting the copy and leaving a partial backup behind.*

## 0.2.0

### 新功能 · New features

- **斜杠命令与技能 RPC · Slash-command and skill RPCs** — 新增 `commands.list`、`commands.execute`、`skills.list` 三条 RPC，把扩展的斜杠词汇请求转发给网关。命令与技能是**平行的两个命名空间**：技能没有执行端点，调用方式是发一条普通 `session.prompt`，由宿主 pre-step 边界的手势识别注入技能正文。这三条 RPC 的请求/响应契约在 `@dsh-browser/protocol` 中类型化，宿主侧字段改名从此是编译错误，而不是面板里静默消失的一列。
  *Three new RPCs — `commands.list`, `commands.execute` and `skills.list` — forward the panel's slash-vocabulary requests to the gateway. Commands and skills are **parallel namespaces**: a skill has no execute endpoint and is invoked by sending an ordinary `session.prompt`, whose `/name` gesture the host's pre-step boundary answers by injecting the skill body. Their contracts are typed in `@dsh-browser/protocol`, so a host-side field rename is a compile error instead of a silently missing column.*

- **会话归入工作区分组 · Session workspace grouping** — 新配置项 `sessionWorkspace`：开启后，扩展创建的会话会先把该目录**幂等**注册为 dsh 工作区，再注入解析出的 `workspaceId`，使它们按目录分组显示在 dsh GUI 侧边栏，而不是堆在「未分组」桶里。分组只由工作区的成员账（`sessionIds`）决定，比较 `cwd` 不会产生分组；注册失败绝不阻塞会话创建，失败也不会被永久固化为「不再尝试」。
  *New `sessionWorkspace` config: extension-created sessions first register that directory as a dsh Workspace (**idempotently**) and then carry the resolved `workspaceId`, so they group under the directory in the dsh sidebar instead of piling up in "Ungrouped". Grouping is decided solely by the Workspace's membership account (`sessionIds`) — comparing `cwd` produces none. A failed registration never blocks session creation, and a failure is never cached as "stop trying".*

- **共享地址规则 · Shared endpoint rules** — `@dsh-browser/protocol` 新增 `endpoint.ts`：把用户输入的地址（`10.0.0.7:3080`、`localhost:3080`、`wss://dsh.example.com`、完整 `ws://host:port/ext/bridge`）规范化为桥的 WebSocket URL，两端共用同一份规则。
  *`@dsh-browser/protocol` gained `endpoint.ts`: the rules that turn a user-typed address (`10.0.0.7:3080`, `localhost:3080`, `wss://dsh.example.com`, a full `ws://host:port/ext/bridge`) into a bridge WebSocket URL — one implementation shared by both halves.*

### 修复 · Fixes

- **保序 RPC 的有界等待 · Bounded wait for session-ordered RPCs** — 按会话串行化会一直占着该会话的队列槽位，而宿主命令执行端点的应答要等 handler 结束才产生，于是 `/compact`（压缩全量对话）这类长命令会把它之后所有 `session.prompt` / `session.cancel` / `commands.execute` **无限期**挡住 —— 用户看到的是「消息发出去没反应」。保序调用现在另有一道 120s 有界等待：超时后中止该调用自身的 signal、以 `rpc.result` 失败收尾（错误码 `timeout`）并**释放队列槽位**。deadline 在调用真正开始执行时才 arm，排队等待的时间不计入预算。
  *Per-session serialization held a session's queue slot until the call settled, and the host's command endpoint answers only after its handler finishes — so a long command such as `/compact` blocked every later `session.prompt` / `session.cancel` / `commands.execute` on that session **indefinitely**. Ordered calls now run under a 120s bound: on expiry the bridge aborts that call's own signal, ends it as a failed `rpc.result` (code `timeout`) and **releases the queue slot**. The deadline is armed when the call actually starts, so time spent queued is not charged to it.*

- **超时文案不声称已取消 · The timeout report never claims cancellation** — 宿主无法被强制停止一个已在运行的 handler（其 `withAbort` 只包装 Promise），所以失败文案只说「未在时限内应答、可能仍在执行、结果以事件流为准」。实测：`/compact` 会真的停止并自行补一条 `command/done`；`/goal`、`/permission`、`/feedback`、`/export` 不观察 signal，会跑完。
  *A host handler already running cannot be forced to stop (its `withAbort` only wraps a promise), so the failure text says only that the call did not answer within the limit, may still be running, and that the event stream owns the outcome. Measured: `/compact` really does stop and appends its own `command/done`; `/goal`, `/permission`, `/feedback` and `/export` do not observe the signal and run to completion.*

- **工作区注册不再借用调用方的连接 · Registration no longer borrows the caller's connection** — 注册曾缓存在首个调用方 signal 上构造的 promise，连接被替换时该 signal 失效，后续注册就可能沿用一个已死的生命周期。注册现在持有自己的 `AbortController`；已中止的调用方直接返回，不再发起一次注定被丢弃的注册。
  *Registration cached a promise built from the first caller's signal, so a connection replacement could leave later registrations on a dead lifecycle. Registration now holds its own `AbortController`, and an already-aborted caller returns without starting a registration doomed to be discarded.*

- **`sessionId` 收紧为 trim 后非空 · `sessionId` tightened to trimmed non-empty** — 纯空白 ID 不再被当作查找键：三条命令路径与线协议解析器对 `tool.call` 的既有处理由此一致，一律 `bad-request`。
  *A whitespace-only id is no longer used as a lookup key — the three command paths now match what the wire parser already does for `tool.call`: `bad-request`.*

- **发布说明固定版本而非 `@latest` · Release notes pin the version instead of `@latest`** — 安装说明不再给 `@latest`：pnpm 11 的 `minimumReleaseAge` 默认 1440 分钟，新发布的版本会被挡下，而 `@latest` 会**静默装成上一个版本**（不报错）。说明改为固定版本 + `--config.minimumReleaseAge=0`。
  *The install instructions no longer advertise `@latest`: pnpm 11's `minimumReleaseAge` defaults to 1440 minutes, so a fresh release is held back and `@latest` **silently installs the previous version** rather than failing. They now pin the version and pass `--config.minimumReleaseAge=0`.*

### 工具链 · Tooling

- `pnpm typecheck` 现在覆盖 `packages/protocol` 与 `packages/bridge-dsh`（此前只覆盖扩展）。
  *`pnpm typecheck` now covers `packages/protocol` and `packages/bridge-dsh` (previously only the extension).*

## 0.1.0

### 新功能 · New features

- **`model.catalog` RPC** — 只读、进程内直读 dsh 的 `llm` + `agentDefaultModel`，返回部署默认模型与按 provider 分组的模型目录（含 `inputModalities` 多模态能力）；单 provider 故障只记入 `failures`，服务缺失时返回 `llm-unavailable`，不影响连接与其它 RPC。
  *Read-only, in-process projection of dsh's `llm` + `agentDefaultModel`: the deployment default plus a provider-grouped catalog with `inputModalities` (multimodal capability), per-provider fault isolation into `failures`, and a clean `llm-unavailable` degradation.*

- **共享 prompt 契约 `protocol/prompt.ts`** — 分段标签常量 + 区域截图 prompt 组装函数，两端唯一真相源，替代散落的字符串字面量。
  *Shared prompt contract `protocol/prompt.ts`: section-label constants + region-prompt builders as the single source of truth for both halves.*

- **协议类型 · Protocol** — 新增 `PromptImagePart`（prompt 图片载荷）与区域捕获上限常量 `MAX_SCREENSHOT_BYTES` / `MAX_REGION_ELEMENTS`。
  *Added `PromptImagePart` and the region-capture limits `MAX_SCREENSHOT_BYTES` / `MAX_REGION_ELEMENTS`.*

### 修复 · Fixes

- 无。本次为纯增量：帧结构不变，审批 / token / 隐私边界均未削弱。
  *None — additive only; frame shapes and the approval / token / privacy boundaries are untouched.*

<!-- Earlier versions (0.0.3 and before) predate this changelog; their notes live
     on the GitHub releases for their own tags. -->
