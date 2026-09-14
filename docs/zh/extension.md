> [English](../en/extension.md) | [中文](../zh/extension.md)

# Chrome 扩展（packages/extension）

MV3 扩展，三段式：**service worker（控制中心）+ content script（碰 DOM 的唯一部分）+ side panel（对话 UI）**。它不直接连 dsh 的会话，只经后台统一转发。

## 三部分职责

| 部分 | 职责 | 关键文件 |
|---|---|---|
| **background/** | 桥客户端（发现/重连/心跳）、RPC 转发、工具分发、审批协调、当前页追踪、日志 | `index.ts`(装配)、`bridge.ts`、`tools.ts`、`authorization.ts`、`approval-coordinator.ts` |
| **content/** | 页面→文本快照、执行点击/输入/滚动/导航、稳定编号、敏感遮蔽 | `snapshot.ts`、`extract.ts`、`actions.ts`、`ids.ts`、`privacy.ts` |
| **panel/** | 对话、状态、模型选择、框选截图、Markdown 渲染、日志、审批框、问答框、系统配置 | `main.ts`(组装根) + `transport`/`conversation`/`model-selector`/`region`/`question`/`approval`/`status`/`settings`/`errors`/`log` + 共享 `common/`（`tools/` + `ui/`）；`index.html` |

## 核心机制

### 连接与存活
- **发现**：`host` 留空时探测端口 → `fetch /ext/bridge-config` → `WebSocket` → `hello` 握手。
- **远端 dsh**：状态栏齿轮按钮打开「系统配置」弹窗，填 `dsh host` 与 `token`。地址接受 `10.0.0.7:3080`、`localhost:3080`、`wss://dsh.example.com`、完整 `ws://host:port/ext/bridge` 四种写法——不带 scheme 时补 `ws://` 与 `/ext/bridge`，带 scheme 时保留（`http`/`https` 映射为 `ws`/`wss`），带子路径时原样保留（反代挂在子路径的场景）。`host` 非空时**不再回落本机自动发现**：配错的远端地址必须表现为连不上，而不是悄悄连上本机。
- **配置即可验证**：输入时实时显示生效地址（纯本地计算，不发请求）；`测试连接` 用**独立的一次性连接**做完整 `hello` 握手（不顶替正在工作的连接），失败按阶段分开报：地址格式无效 / 地址不可达 / 地址可达但 token 被拒绝（`4002`）/ 地址可达但握手超时；`保存并重连` 等真实重连结果，失败时弹窗保持打开并保留输入。
- **token**：远端连接必须填（服务端对非回环来源强制校验，无例外）。本机可用 `cat ~/.dsh/ext-bridge-token` 获取；粘贴内容的**首尾空白会被自动去掉**——token 文件以换行结尾，而服务端按字节全等比较，不去掉就会稳定得到 `4002`。
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
- `tabs.onActivated`/`onUpdated`/`windows.onFocusChanged` 追踪活动标签页（URL+标题），面板实时显示，并在 `session.prompt` 时注入 `[网页描述]：<title> (<url>)`，让模型有上下文。

### 对话与交互
- **简单对话**：`session.create` → `session.prompt` → 订阅 `event` 流渲染；「正在分析」指示覆盖「思考→调工具→执行→输出」全程（严格跟随 turn：`turn/start` 显示、`turn/end` 清除，中间文本/工具事件不清除）。
- **模型选择与能力标记**：输入区左侧的丸状下拉（与 dsh GUI 同位置同款观感）每次 connected 后重拉 `model.catalog`（只读）。当前选中的确定次序：会话历史 `projections.values.modelSelection` 的 `next` → `lastUsed` → 目录 `default`；同步通道三条——`session.selectModel` 成功乐观更新、事件流里的 `model/selection` 即时对齐、重连 `session.history` 投影兜底。多模态标记三元态：候选/当前模型 `inputModalities` 含 `image`→「视觉」、公布且不含→「文本」、未公布或目录查无此项→「能力未知」（不臆断），当前模型的能力另以小 badge 紧随下拉。下拉选定即调 `session.selectModel`；**该 dsh 行为会同时改写部署默认模型**（`agentDefaultModel.saveSelection`），以便在选择器 tooltip 常驻如实提示。目录拉取失败时选择器显示「模型不可用」并在对话里给出含错误码的失败行，不阻断消息收发。
- **dsh 提问**（`ask_user_question`）：`question/requested` 弹问题框（选项/自定义输入），作答经 `respond` 回传。
- **状态/日志**：顶部状态条（连接态+地址+重连次数+当前页）+ 可折叠日志面板（info/warn/error 分色，环形缓冲回放）。

## 安全模型

| 边界 | 机制 |
|---|---|
| 桥鉴权 | bearer token（5s hello、恒定时间）；远端连接必须提供 |
| 回环免密 | 仅限 `chrome-extension://` Origin |
| 特权方法 | 非回环拒绝 `settings.*`/`credentials.*`/`host.openPath`/`host.pickDirectory`——**远端连接下这些功能不可用**，面板把该失败如实说明为「仅本机可用」，不显示原始错误码 |
| 连接目标 | `connect-src` 允许任意 `ws://`/`wss://`（远端部署需要）；放宽的只是连接目标，token 校验、审批与回环闸均不变 |
| 页面数据 | 文本-only 无截图；敏感字段掩码；不可信内容包裹 |
| 动作 | 写操作 fail-closed 审批，读按 ask/auto/off 策略 |

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
