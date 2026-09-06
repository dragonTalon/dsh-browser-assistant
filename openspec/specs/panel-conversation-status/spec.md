# panel-conversation-status Specification

## Purpose

扩展面板的对话区用一个进行中指示（「正在分析」转圈行）告诉用户模型是否仍在工作；该指示的生命周期与会话 turn 严格对齐，使用户在多步 turn（含工具调用与思考阶段）中始终能看到真实的进行状态。

## Requirements

### Requirement: 进行中指示跟随 turn 生命周期

面板 SHALL 在 `turn/start` 时显示进行中指示，在 `turn/end` 时清除。turn 内的 assistant 文本（`assistant/message` / `assistant/chunk` 的 text-delta）、工具调用与思考事件 MUST NOT 提前清除该指示。发送 prompt 后、`turn/start` 到达前，面板 SHALL 立即显示该指示；prompt RPC 失败时 MUST 清除。指示显示期间，新渲染的内容行 MUST 出现在指示行之上的位置（指示行保持在对话末尾）。

#### Scenario: 多步 turn 全程显示

- **WHEN** 一个 turn 中模型先输出一段文本，随后调用工具并继续思考
- **THEN** 面板从 `turn/start` 起持续显示进行中指示，文本输出、工具调用期间指示不消失，直到 `turn/end` 才清除

#### Scenario: 单步 turn 正常结束

- **WHEN** 模型一次输出完整回复后 turn 结束
- **THEN** 进行中指示在文本流期间保持显示，收到 `turn/end` 后清除

#### Scenario: 发送失败不留残态

- **WHEN** 用户发送消息但 `session.prompt` RPC 失败
- **THEN** 进行中指示被清除并显示失败提示

### Requirement: 历史重放后的状态一致

面板重放会话历史（重连恢复）时 MUST 按事件顺序应用同一套规则，使重放结束后的进行中指示与会话真实状态一致：历史以未结束的 turn 收尾则显示指示，以 `turn/end` 收尾则不显示。

#### Scenario: 重连后 turn 已完成

- **WHEN** 断连期间 turn 已结束，重连后面板重放历史
- **THEN** 重放完成后进行中指示处于清除状态，且最终 assistant 文本完整展示

#### Scenario: 重连后 turn 仍在进行

- **WHEN** 断连期间 turn 未结束，重连后面板重放历史
- **THEN** 重放完成后进行中指示保持显示，直到后续实时 `turn/end` 到达
