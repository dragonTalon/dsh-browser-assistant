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

### Requirement: 状态栏的连接地址显示

状态栏 SHALL 在连接可用时展示当前桥地址。连接本机回环地址时，展示 MAY 省略 `ws://127.0.0.1` 前缀而只保留端口与路径（维持现状）；连接非回环地址时，SHALL 展示完整的 `host:port` 与路径，使用户能区分多份配置与多台 dsh。

#### Scenario: 本机连接维持紧凑显示

- **WHEN** 桥连接的是 `ws://127.0.0.1:3080/ext/bridge`
- **THEN** 状态栏显示形如 `:3080/ext/bridge` 的紧凑地址

#### Scenario: 远端连接显示完整地址

- **WHEN** 桥连接的是 `ws://10.0.0.7:3080/ext/bridge`
- **THEN** 状态栏显示包含 `10.0.0.7:3080` 的完整地址，用户可据此确认当前连的是远端而非本机

#### Scenario: 重连中仍显示目标地址

- **WHEN** 桥连接处于重连状态且目标为远端地址
- **THEN** 状态栏同时展示重连次数与该远端目标地址
