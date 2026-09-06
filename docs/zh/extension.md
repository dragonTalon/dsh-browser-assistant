> [English](../en/extension.md) | [中文](../zh/extension.md)

# Chrome 扩展（packages/extension）

MV3 扩展，三段式：**service worker（控制中心）+ content script（碰 DOM 的唯一部分）+ side panel（对话 UI）**。它不直接连 dsh 的会话，只经后台统一转发。

## 三部分职责

| 部分 | 职责 | 关键文件 |
|---|---|---|
| **background/** | 桥客户端（发现/重连/心跳）、RPC 转发、工具分发、审批协调、当前页追踪、日志 | `index.ts`(装配)、`bridge.ts`、`tools.ts`、`authorization.ts`、`approval-coordinator.ts` |
| **content/** | 页面→文本快照、执行点击/输入/滚动/导航、稳定编号、敏感遮蔽 | `snapshot.ts`、`extract.ts`、`actions.ts`、`ids.ts`、`privacy.ts` |
| **panel/** | 简单对话、连接状态、日志、审批框、问答框 | `main.ts`、`index.html` |

## 核心机制

### 连接与存活
- **发现**：探测端口 → `fetch /ext/bridge-config` → `WebSocket` → `hello` 握手。
- **重连**：指数退避（500ms→10s 封顶+抖动）；`4000` 视为「被顶替」直接停，不互相挤。
- **抗 SW 挂起**：面板 20s 心跳 + 30s alarm，双保险避免空闲挂起掐断 WebSocket；断开时清「正在分析」，重连后拉 `session.history` 恢复遗漏的最终输出。

### 工具分发与审批
- 收到 `tool.call` → 解析受控标签页 → 生成审批提示（`authorization.ts` 纯函数）→ 需审批则走 `approval-coordinator`（60s 窗口）→ 派发到 content script → `tool.result`。
- **读默认 auto**（`browser_snapshot`/`get_text`）；**写一律 fail-closed 审批**；无面板则超时拒绝。
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
- `tabs.onActivated`/`onUpdated`/`windows.onFocusChanged` 追踪活动标签页（URL+标题），面板实时显示，并在 `session.prompt` 时注入 `[浏览器上下文] 用户当前停留的页面: …`，让模型有上下文。

### 对话与交互
- **简单对话**：`session.create` → `session.prompt` → 订阅 `event` 流渲染；「正在分析」指示覆盖「思考→调工具→执行→输出」全程（严格跟随 turn：`turn/start` 显示、`turn/end` 清除，中间文本/工具事件不清除）。
- **dsh 提问**（`ask_user_question`）：`question/requested` 弹问题框（选项/自定义输入），作答经 `respond` 回传。
- **状态/日志**：顶部状态条（连接态+地址+重连次数+当前页）+ 可折叠日志面板（info/warn/error 分色，环形缓冲回放）。

## 安全模型

| 边界 | 机制 |
|---|---|
| 桥鉴权 | bearer token（5s hello、恒定时间） |
| 回环免密 | 仅限 `chrome-extension://` Origin |
| 特权方法 | 非回环拒绝 `settings.*`/`credentials.*`/`host.open*` |
| 页面数据 | 文本-only 无截图；敏感字段掩码；不可信内容包裹 |
| 动作 | 写操作 fail-closed 审批，读按 ask/auto/off 策略 |
