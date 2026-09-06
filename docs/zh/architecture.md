> [English](../en/architecture.md) | [中文](../zh/architecture.md)

# 整体架构

dsh-browser-assistant 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）读取、操作用户**正在使用的真实浏览器标签页**。页面被渲染成纯文本结构化快照，模型按编号寻址元素，登录态/Cookie 全程保留。

一句话：**「dsh 的浏览器执行终端」= 一个 dsh bridge 插件（服务端）+ 一个 Chrome MV3 扩展（浏览器端），中间一条自定义 WebSocket。**

## 拓扑

```
┌─────────────────────────── dsh 进程（Node） ───────────────────────────┐
│  packages/bridge-dsh（Cordis 插件，opt-in，不改 dsh 核心）              │
│    /ext/bridge-config   发现端点：返回 wsUrl                            │
│    /ext/bridge          WebSocket 升级路由（在 /api 信任边界之外）       │
│    12 个 browser_* 工具（注册进 ctx.tools）                             │
│    通过 typertGateway + connection 两个服务接入 dsh（0.1.2/0.1.3 架构）   │
└──────────────────────────────▲─────────────────────────────────────────┘
                               │ WebSocket（JSON 帧，见 packages/protocol）
┌──────────────────────────────┴─────────────────────────────────────────┐
│  packages/extension（Chrome MV3 扩展）                                  │
│    background/  service worker：桥客户端、RPC、工具分发、审批、状态日志  │
│    content/     页面侧（唯一接触 DOM）：快照/点击/输入/隐私遮蔽           │
│    panel/       侧边栏：对话、状态、日志、审批、问答                      │
└─────────────────────────────────────────────────────────────────────────┘
```

## 三个包的分工

| 包 | 运行位置 | 职责 | 是否含运行逻辑 |
|---|---|---|---|
| `packages/protocol` | 两端共享 | 帧类型、常量、解析器、类型守卫 | 否（纯类型+纯函数，零依赖） |
| `packages/bridge-dsh` | dsh 进程 | 挂路由、注册工具、把浏览器能力接进模型 | 是 |
| `packages/extension` | Chrome | 执行浏览器操作、呈现对话、用户审批 | 是 |

**协议是唯一真相源**：`protocol.ts` 被两端 import 同一份文件，帧结构不可能漂移；`isServerFrame`/`isClientFrame` 类型守卫把收发方向在类型层面分开。

## 端到端数据流

1. **发现**：扩展探测端口 `3080/3081/3090/14389/43189`，`fetch /ext/bridge-config` 拿到 wsUrl。
2. **握手**：`WebSocket` 连接后首帧必须是 `hello{token,caps}`（5s 超时），服务端校验 token → 回 `hello.ok`（协商快照预算）。
3. **会话**：面板 `session.create` / `session.prompt` → `rpc` 帧 → 桥转发给 Typert Gateway → dsh 执行 → `rpc.result`。
4. **事件回传**：dsh 的会话事件（`user/message`、`assistant/message`、`turn/end`、`question/requested`）经 `event` 帧流式推给面板渲染。
5. **浏览器操作**：模型调 `browser_*` → 桥发 `tool.call` → 扩展后台路由到 content script 执行 → `tool.result` 回给模型。

## 关键设计决策

| 决策 | 做法 | 为什么 |
|---|---|---|
| **文本优先，无截图** | 快照=标题/URL/正文/编号清单/表单；模型按编号操作 | DeepSeek 模型无视觉；文本省 token、可 diff |
| **窄接口隔离 dsh 版本** | 桥只依赖 `BrowserHostApi`（call/events/respond）三个方法 | dsh 0.1.1(ApiProxy) / 0.1.2(0.1.3)(Typert) 切换只换适配层 |
| **单受控标签页** | 工具绑定一个标签页，首次调用时绑定活动页 | 不让模型静默切换/偷看其它标签页 |
| **fail-closed 审批** | 读默认 auto；写操作一律审批，无面板即超时拒绝 | 安全边界在扩展后台，不赌模型自觉 |
| **稳定元素编号** | WeakMap 一次性分配 id + `data-dsh-el` 标记 | 跨快照可寻址，避免重渲染后点错 |
| **敏感字段永不外泄** | 密码/卡号/CVV 掩码为 `••••`；页面文本包一层不可信标记 | 快照是文本唯一出口，必须在这里挡住 |
| **MV3 生存性** | 面板 20s 心跳 + 30s alarm 重连 + 断开恢复 | SW 空闲挂起会掐 WebSocket，必须对抗 |
