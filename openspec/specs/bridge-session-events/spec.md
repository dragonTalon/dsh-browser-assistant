# bridge-session-events Specification

## Purpose

桥接层把 dsh 会话的事件流（assistant 输出、turn 生命周期等）可靠投递给浏览器扩展：每个已认证连接拥有一代事件流，会话订阅在连接重建后自动恢复，断连窗口内错过的事件按序回补。

## Requirements

### Requirement: 会话事件订阅的建立

桥接层 SHALL 在扩展通过桥发起 `session.prompt` 时，于事件投递之前建立该会话的 `session/follow` 订阅，使该会话的增量事件作为 `session/event` 帧投递到当前连接。同一连接内对同一会话重复建立订阅时 MUST 复用现有订阅。

#### Scenario: 首次 prompt 建立订阅

- **WHEN** 扩展对会话 S 发起 `session.prompt` 且当前连接尚未订阅 S
- **THEN** 桥接层在 prompt 准入前建立 S 的 follow 订阅，随后 S 的 `user/message`、`assistant/*`、`turn/end` 事件陆续投递到该连接

#### Scenario: 同代内重复 prompt 不重复订阅

- **WHEN** 同一连接对会话 S 再次发起 `session.prompt`，且 S 的订阅仍然存活
- **THEN** 桥接层复用现有订阅，不打开第二个 follow 流

### Requirement: 连接重建后的订阅恢复

桥接层 MUST 记住当前最近被订阅的会话。新的已认证连接建立新一代事件流时，若存在被记住的会话，桥接层 SHALL 自动为其重新建立 `session/follow` 订阅，无需扩展再发任何 RPC。恢复失败（如会话已归档）MUST NOT 中断新连接的事件流；后续 prompt 仍可正常建立订阅。

#### Scenario: 断连重连后事件流自动恢复

- **WHEN** 连接在会话 S 的 turn 进行中断开，扩展重连并完成握手
- **THEN** 桥接层自动重新订阅 S，此后 S 的增量事件（含最终的 `turn/end`）继续投递到扩展

#### Scenario: 无历史订阅时不动作

- **WHEN** 新连接建立，但本进程内从未有任何会话被订阅过
- **THEN** 桥接层不打开任何 `session/follow`，仅运行转发事件泵

#### Scenario: 恢复失败不影响连接

- **WHEN** 新连接尝试恢复被记住会话的订阅，但该会话已不存在
- **THEN** 该连接保持可用（`$events` 泵、RPC、后续 prompt 均正常），仅该会话的订阅不恢复

### Requirement: 断连窗口事件的回补

建立 follow 订阅时，若桥接层已记录该会话的投递游标（本进程内向任一前代连接推送过该会话事件），桥接层 SHALL 把 follow 快照中的记录展开为标量事件，仅将 `seq` 大于投递游标的事件按序推入事件队列，随后继续投递增量事件。未记录游标时 MUST NOT 推送快照内容。快照中单条无法展开的 record MUST 跳过，不得因此中断订阅。

#### Scenario: 断连期间完成的 turn 被补发

- **WHEN** 会话 S 在断连窗口内产生了事件 seq 11…20（含 `turn/end`），重连后自动恢复订阅
- **THEN** 桥接层把 seq 11…20 的事件按序作为 `session/event` 推送给扩展，扩展在恢复连接后收到完整的 turn 结束信号

#### Scenario: 已投递事件不重复回补

- **WHEN** 会话 S 的投递游标为 seq 10，follow 快照含 seq 1…20 的记录
- **THEN** 桥接层仅推送 seq 11…20 的事件，seq ≤ 10 的事件不进入队列

#### Scenario: 首次订阅不回补历史

- **WHEN** 扩展对会话 S 发起首次 `session.prompt`，本进程此前未推送过 S 的任何事件
- **THEN** follow 快照中的既有记录不推送，仅投递订阅建立后的增量事件
