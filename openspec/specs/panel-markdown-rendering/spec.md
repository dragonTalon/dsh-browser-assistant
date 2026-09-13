# panel-markdown-rendering Specification

## Purpose

扩展侧边栏面板把 assistant 回复以 Markdown 渲染为富文本展示，使模型输出的加粗、标题、列表、代码块、引用、链接等结构可读，且渲染前经过 HTML 消毒以防注入。

## Requirements

### Requirement: assistant 回复的 Markdown 渲染

面板 SHALL 将 assistant 回复文本作为 Markdown 渲染后展示，而不是作为纯文本原样呈现。渲染 MUST 覆盖常见 Markdown 结构（加粗、标题、有序/无序列表、代码块、行内代码、引用、链接）。渲染行为 SHALL 对流式输出与历史重放一致。

#### Scenario: 流式回复渲染 Markdown

- **WHEN** 模型以流式 text-delta 输出一段含 Markdown 结构（如 `**加粗**`、`- 列表`、行内代码）的回复
- **THEN** 面板展示渲染后的富文本（加粗、列表、代码样式），而非字面的 `**`、`-`、反引号符号

#### Scenario: 历史重放同样渲染

- **WHEN** 面板重连后重放会话历史，遇到 assistant 文本消息
- **THEN** 该消息以与实时流式输出相同的 Markdown 渲染方式展示

### Requirement: 渲染前的 HTML 消毒

面板在把 Markdown 渲染结果写入 DOM 前，MUST 对生成的 HTML 进行消毒：移除脚本、事件处理器、`javascript:` 协议等可执行内容，只保留安全的结构化标签。消毒 MUST NOT 因模型输出内容的变化而被绕过。

#### Scenario: 脚本内容被剥离

- **WHEN** 模型回复经 Markdown 渲染后包含 `<script>` 或 `onerror=` 等可执行内容（无论其来源是模型自身还是被页面诱导）
- **THEN** 面板 DOM 中不出现可执行元素，仅保留安全的文本与结构标签

#### Scenario: 危险协议被拦截

- **WHEN** 渲染结果包含 `javascript:` 协议的链接
- **THEN** 该链接的危险协议被移除，不产生可点击执行的链接

### Requirement: 非 assistant 消息保持纯文本

面板对用户消息（user）与系统提示（system）SHALL 保持纯文本呈现，不进行 Markdown 渲染。

#### Scenario: 用户消息不渲染

- **WHEN** 用户发送的消息或注入的页面上下文包含 `*`、`#`、`<div>` 等 Markdown/HTML 特征字符
- **THEN** 这些内容按原文纯文本展示，不被解释为 Markdown 结构或 HTML 标签
