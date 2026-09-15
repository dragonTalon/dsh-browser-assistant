# Changelog — `bridge-dsh`

The dsh-side bridge plugin (Cordis). Released independently from the Chrome
extension, so this version stream and `bridge-browser`'s do not line up.

Every entry is bilingual — 中文 first, then an italic English line. The topmost
version section is what the release pipeline publishes to GitHub verbatim (see
`scripts/release-notes.sh`), with a generated install footer appended.

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
