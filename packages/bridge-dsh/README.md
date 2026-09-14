# bridge-dsh

dsh 浏览器桥插件：token 鉴权的 WebSocket 桥 + 12 个 `browser_*` 工具，让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）读取、操作浏览器标签页（配合 Chrome 扩展 `bridge-browser` 使用）。

## Install

```sh
dsh plugin --profile web add -w "bridge-dsh@0.1.0" --config.minimumReleaseAge=0
```

> **请固定版本，不要用 `@latest`。** pnpm 11 起 `minimumReleaseAge` 默认为 `1440` 分钟（1 天）：发布不满一天的版本会被挡下，而 `@latest` 这类 dist-tag **会静默装成上一个版本**（不报错）。`--config.minimumReleaseAge=0` 用于本次安装取消这一等待。本插件与 Chrome 扩展 `bridge-browser` 是版本配对的，请安装与之匹配的版本。

## Requirements

- dsh ≥ `0.1.2-rc.1`（0.1.x 的 Typert Gateway + Connection 架构；已在 `0.1.3-alpha.1` 验证）
- WebSocket 另一端是 `bridge-browser` Chrome 扩展

## Docs

完整文档见仓库：<https://github.com/dragonTalon/dsh-browser-assistant>
