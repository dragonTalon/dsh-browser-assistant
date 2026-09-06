# bridge-dsh

dsh 浏览器桥插件：token 鉴权的 WebSocket 桥 + 12 个 `browser_*` 工具，让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）读取、操作浏览器标签页（配合 Chrome 扩展 `bridge-browser` 使用）。

## Install

```sh
dsh plugin --profile web add -w "bridge-dsh@0.0.3"
```

## Requirements

- dsh ≥ `0.1.2-rc.1`（0.1.x 的 Typert Gateway + Connection 架构；已在 `0.1.3-alpha.1` 验证）
- WebSocket 另一端是 `bridge-browser` Chrome 扩展

## Docs

完整文档见仓库：<https://github.com/dragonTalon/dsh-browser-assistant>
