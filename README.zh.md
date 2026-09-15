<p align="center">
  <img src="packages/extension/icons/icon512.png" width="160" height="160" alt="bridge-browser 图标:戴单片眼镜的橙色圆形人物">
</p>

<h1 align="center">dsh 浏览器助手</h1>

<p align="center">
  <a href="README.md">English</a> | <b>中文</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/bridge-dsh"><img src="https://img.shields.io/npm/v/bridge-dsh?label=bridge-dsh" alt="npm version"></a>
  <a href="https://github.com/dragonTalon/dsh-browser-assistant/releases/tag/bridge-browser%400.1.0"><img src="https://img.shields.io/badge/bridge--browser-0.1.0-5b21b6" alt="extension version"></a>
</p>

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）读取、操作你正在使用的真实浏览器标签页：页面变成**纯文本结构化快照**，模型按编号寻址元素，登录态、会话、Cookie 全保留。

一个 pnpm workspace，两半由一条 WebSocket 连接：

- **`packages/bridge-dsh`** —— dsh Cordis 插件，发布为 **`bridge-dsh` `0.1.0`**，挂载 `/ext/bridge`，注册 12 个 `browser_*` 工具。
- **`packages/extension`** —— Chrome MV3 扩展，发布为 **`bridge-browser` `0.1.0`**（service worker + content script + side panel）。

> 模型工具链路**纯文本**——页面渲染为结构化文本快照，工具侧不截图。另外，面板提供**用户主动**框选，可把选区截图（裁剪）发给**视觉模型**。完整设计见 [docs/zh/architecture.md](docs/zh/architecture.md)。

## 能力

| 能力 | 实现 |
|---|---|
| 读页面 | `browser_snapshot` → 标题/URL/正文/编号控件/表单；`delta:true` 只返回变化 |
| 操作 | `browser_click` / `browser_type` / `browser_press` / `browser_scroll` 按稳定编号 |
| 导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` |
| 读区域/等待 | `browser_get_text` / `browser_wait` |
| 问用户 | dsh 的 `ask_user_question` 显示在面板，作答回传模型 |
| 页面感知 | 扩展追踪活动标签页，把 URL/标题注入每条消息作为上下文 |
| 框选截图 | 用户从面板框选页面区域 → 裁剪截图 + 选区内 DOM 元素清单 → 发给视觉模型 |
| 模型选择 | 面板连接后重拉 `model.catalog`；下拉框带能力标记（视觉/文本/未知）→ `session.selectModel` |

安全模型：桥自带 bearer token；读默认放行，写操作 fail-closed 需面板审批；密码/卡号掩码、永不离开页面。远端连接必须提供 token，且不会放宽以上任何一条。

## 前置要求

- Node.js `^22` 与 Corepack/pnpm
- **dsh ≥ `0.1.2-rc.1`** —— 最低支持版本（`0.1.x` 的 Typert Gateway + Connection 架构）；已在 `0.1.3-alpha.1` 上验证
- Chrome 116+

## 安装

桥插件发布在 [npm](https://www.npmjs.com/package/bridge-dsh)；Chrome 扩展以打包好的 zip 放在 [GitHub Releases](https://github.com/dragonTalon/dsh-browser-assistant/releases)。无需本地编译。

### 1. 从 npm 安装桥插件

```sh
dsh plugin --profile web add -w "bridge-dsh@0.1.0" --config.minimumReleaseAge=0
```

> **请固定版本，不要用 `@latest`。** pnpm 11 起 `minimumReleaseAge` 默认为 `1440` 分钟（1 天）：发布不满一天的版本会被挡下，而 `@latest` 这类 dist-tag **会静默装成上一个版本**（不报错）。`--config.minimumReleaseAge=0` 用于本次安装取消这一等待。桥插件与扩展是版本配对的，请始终安装与你的 `bridge-browser` zip 相匹配的版本。

### 2. 下载 Chrome 扩展

```sh
gh release download bridge-browser@0.1.0 --repo dragonTalon/dsh-browser-assistant
# → bridge-browser-0.1.0.zip
```

### 3. 重启 dsh 并验证

```sh
cd ~/.dsh && dsh web
curl http://127.0.0.1:3080/ext/bridge-config
# → {"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}
```

### 4. 加载扩展

解压 `bridge-browser-0.1.0.zip`，然后 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压出来的文件夹。打开任意 `http(s)` 页面，点扩展图标打开侧边栏，等「已连接 dsh」，即可对话。

### 5. 远端 dsh（可选）

dsh 跑在另一台机器上时，打开面板状态栏的齿轮按钮「系统配置」，填入地址（`10.0.0.7:3080` 或 `wss://dsh.example.com`）与那台机器上的 token（`cat ~/.dsh/ext-bridge-token`），保存前先点「测试连接」——它会做一次独立握手，并明确告诉你地址不可达还是 token 被拒绝。地址留空则维持零配置的本机自动发现。

被钉在回环上的方法（`settings.*`、`credentials.*`、`host.openPath`、`host.pickDirectory`）在远端连接下始终不可用——这是桥自身的信任边界，不是配置弹窗的缺陷。

### 从源码构建（可选）

```sh
pnpm install --frozen-lockfile
pnpm build
# → packages/bridge-dsh/lib/index.js  与  packages/extension/dist/
```

本地开发时注意：`dsh plugin add` 安装的是**打包快照**（`~/.dsh/profiles/<profile>/node_modules/bridge-dsh/`），重建 workspace 的 `lib/index.js` 不会影响正在运行的 dsh。每次改了 bridge 的源码后：

```sh
bash packages/bridge-dsh/build.sh       # 重建工作区产物
bash scripts/sync-profile.sh            # 拷贝进已安装的插件目录（自动备份）
# 然后重启 dsh（或重载该插件）让新 bundle 生效
```

## 发布版本

两半独立发布：

| 产物 | 包名 | 版本 | Git tag |
|---|---|---|---|
| dsh bridge 插件 | `bridge-dsh` | `0.1.0` | `bridge-dsh@0.1.0` |
| Chrome 扩展 | `bridge-browser` | `0.1.0` | `bridge-browser@0.1.0` |

桥插件已发布到 npm：[`bridge-dsh`](https://www.npmjs.com/package/bridge-dsh)。每个 tag 也都有对应的 [GitHub Release](https://github.com/dragonTalon/dsh-browser-assistant/releases)，附带构建产物，由打 tag 触发的流水线（`.github/workflows/release.yml`）自动生成：

- `bridge-dsh` —— 从 npm 安装：`dsh plugin --profile web add -w "bridge-dsh@0.1.0" --config.minimumReleaseAge=0`（其 release 也附了 `bridge-dsh-0.1.0.tgz`）
- `bridge-browser-0.1.0.zip` —— 扩展包；`chrome://extensions` → 「加载已解压的扩展程序」加载（或提交 Chrome 应用商店）

## 目录结构

```
packages/protocol/     共享零依赖帧协议（唯一真相源）
packages/bridge-dsh/   dsh bridge 插件（Cordis）
packages/extension/    Chrome MV3 扩展（background / content / panel）
docs/en/ docs/zh/       架构与功能文档（EN / 中文）
```

## 文档

文档为中英双语，每页都有 **EN | 中文** 切换：

- [整体架构](docs/zh/architecture.md) · [English](docs/en/architecture.md)
- [bridge 插件](docs/zh/bridge-plugin.md) · [English](docs/en/bridge-plugin.md)
- [Chrome 扩展](docs/zh/extension.md) · [English](docs/en/extension.md)
