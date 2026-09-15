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

### Requirement: 命令生命周期事件的投递与重放

桥接层 SHALL 把 dsh 会话中的命令生命周期事件（命令开始事件与配对的命令结果事件）与其它会话事件同等对待：既 SHALL 在订阅建立后作为 `session/event` 帧实时投递，也 SHALL 被历史重放覆盖，使扩展无论通过实时到达还是通过历史读取都能获得完整的命令生命周期。

命令生命周期事件 MUST NOT 被事件筛选、展开或去重逻辑丢弃：从会话记录展开历史时 MUST 保留这些事件，断连窗口的按序回补 MUST NOT 因事件类型而跳过它们。

#### Scenario: 实时投递命令生命周期

- **WHEN** 连接已订阅会话 S，S 上发生一条命令开始事件与随后的配对结果事件
- **THEN** 两个事件按其既有事件序列顺序作为 `session/event` 帧投递到该连接，类型分别为命令开始与命令结果，且结果事件携带其成功或失败结论

#### Scenario: 历史读取覆盖命令生命周期

- **WHEN** 会话 S 的日志中已存在命令开始事件与配对结果事件，扩展发起会话历史读取
- **THEN** 返回的历史记录同时包含这两个事件，且它们的序列未被改写、未被合并进其它事件

#### Scenario: 断连窗口内的命令生命周期被回补

- **WHEN** 会话 S 的命令生命周期事件发生在连接断连期间，桥接层已记录该会话的投递游标，扩展重连后恢复订阅
- **THEN** 序列号大于投递游标的命令生命周期事件按序补发到新连接，且已被投递过的不重复回补

### Requirement: 按会话保序 RPC 的释放

桥接层对按会话保序的 RPC（`session.prompt`、`session.cancel`、`commands.execute`）SHALL 在调用 settle 后释放该会话的队列槽位。由于宿主命令执行入口的应答在 handler 结束后才产生，且单个命令的耗时不受桥接控制，保序队列 MUST NOT 允许一次调用无限期占用该会话的槽位：桥接层 SHALL 为 ordered RPC 施加有界等待，超时后 MUST 释放该会话的队列槽位，使该会话后续的 RPC 能继续被处理，并 MUST 以 `rpc.result` 失败收尾。

超时回报 MUST NOT 声称该命令已被取消或已中止：桥接层无法保证宿主停止一个已在运行的 handler。失败文案 SHALL 说明该调用未在时限内应答、其结果以事件流为准。

超时释放该槽位后，该会话后续到达的 RPC MUST NOT 继续排在一个已经超时的调用之后。

#### Scenario: 长命令超时后释放队列

- **WHEN** 会话 S 上的一条 `commands.execute` 调用在桥接的有界等待内未 settle（宿主仍在执行该命令）
- **THEN** 桥接层以 `rpc.result` 失败结束该调用、释放 S 的队列槽位，并对该调用回报「未在时限内应答、结果以事件流为准」而非「已取消」

#### Scenario: 超时后同会话后续 RPC 继续被处理

- **WHEN** 会话 S 的一条 `commands.execute` 已因超出有界等待而被释放，随后扩展对 S 发起 `session.prompt`
- **THEN** 该 `session.prompt` 被正常处理并向扩展返回结果，MUST NOT 继续等待那条已经超时的调用

#### Scenario: 未超时的调用仍保持到达顺序

- **WHEN** 会话 S 上先后到达一条 `commands.execute` 与一条 `session.prompt`，且前者在有界等待内 settle
- **THEN** 两条调用按到达顺序被处理，`session.prompt` 在 `commands.execute` settle 之后才被发起
