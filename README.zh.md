# dsh 浏览器助手

[English](README.md) | **中文**

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）读取、操作你正在使用的真实浏览器标签页：页面变成**纯文本结构化快照**，模型按编号寻址元素，登录态、会话、Cookie 全保留。

一个 pnpm workspace，两半由一条 WebSocket 连接：

- **`packages/bridge-dsh`** —— dsh Cordis 插件，发布为 **`dsh-bs-plug` `0.0.1`**，挂载 `/ext/bridge`，注册 12 个 `browser_*` 工具。
- **`packages/extension`** —— Chrome MV3 扩展，发布为 **`dsh-br` `0.0.1`**（service worker + content script + side panel）。

> DeepSeek 模型无视觉，整条链路**纯文本**：全程不截图。完整设计见 [docs/architecture.md](docs/architecture.md)。

## 能力

| 能力 | 实现 |
|---|---|
| 读页面 | `browser_snapshot` → 标题/URL/正文/编号控件/表单；`delta:true` 只返回变化 |
| 操作 | `browser_click` / `browser_type` / `browser_press` / `browser_scroll` 按稳定编号 |
| 导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` |
| 读区域/等待 | `browser_get_text` / `browser_wait` |
| 问用户 | dsh 的 `ask_user_question` 显示在面板，作答回传模型 |
| 页面感知 | 扩展追踪活动标签页，把 URL/标题注入每条消息作为上下文 |

安全模型：桥自带 bearer token；读默认放行，写操作 fail-closed 需面板审批；密码/卡号掩码、永不离开页面。

## 前置要求

- Node.js `^22` 与 Corepack/pnpm
- **dsh ≥ `0.1.2-rc.1`** —— 最低支持版本（`0.1.x` 的 Typert Gateway + Connection 架构）；已在 `0.1.3-alpha.1` 上验证
- Chrome 116+

## 安装

### 1. 构建

当前环境无 npm 源，构建用本地 `deepseek-harness` checkout 里的 esbuild，运行时依赖靠工作区根目录已建好的软链解析：

```sh
bash packages/bridge-dsh/build.sh    # → packages/bridge-dsh/lib/index.js
bash packages/extension/build.sh     # → packages/extension/dist/
```

### 2. 把桥插件注册进 web profile

```sh
dsh plugin --profile web add -w "dsh-bs-plug@link:$PWD/packages/bridge-dsh"
```

### 3. 重启 dsh 并验证

```sh
cd ~/.dsh && dsh web
curl http://127.0.0.1:3080/ext/bridge-config
# → {"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}
```

### 4. 加载扩展

`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `packages/extension/dist`。打开任意 `http(s)` 页面，点扩展图标打开侧边栏，等「已连接 dsh」，即可对话。

## 发布版本

两半独立发布：

| 产物 | 包名 | 版本 | Git tag |
|---|---|---|---|
| dsh bridge 插件 | `dsh-bs-plug` | `0.0.1` | `dsh-bs-plug@0.0.1` |
| Chrome 扩展 | `dsh-br` | `0.0.1` | `dsh-br@0.0.1` |

每个 tag 都有对应的 [GitHub Release](https://github.com/dragonTalon/dsh-browser-assistant/releases)，附带构建产物：

- `dsh-bs-plug-0.0.1.tgz` —— bridge 插件包；用 `dsh plugin --profile web add -w "dsh-bs-plug@file:./dsh-bs-plug-0.0.1.tgz"` 安装
- `dsh-br-0.0.1.zip` —— 扩展包；`chrome://extensions` → 「加载已解压的扩展程序」加载（或提交 Chrome 应用商店）

## 目录结构

```
packages/protocol/     共享零依赖帧协议（唯一真相源）
packages/bridge-dsh/   dsh bridge 插件（Cordis）
packages/extension/    Chrome MV3 扩展（background / content / panel）
docs/                  架构与功能文档
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 整体架构与数据流
- [docs/bridge-plugin.md](docs/bridge-plugin.md) —— bridge 插件设计
- [docs/extension.md](docs/extension.md) —— 扩展设计
