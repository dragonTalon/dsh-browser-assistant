# panel-composer-submit-gating Specification

## Purpose

定义扩展面板输入区的提交闸门：在模型仍在回复（turn 进行中）期间，面板 SHALL 让「提交」这一动作不可用——发送按钮禁用、Enter 不提交——从而使用户的重复点击或连按不会静默排入多条 prompt；同时保证提交失败、切换会话与断连重放之后闸门都能回到正确状态。

## Requirements

### Requirement: 回复中禁止提交

会话存在进行中的 turn 时，面板的发送按钮 SHALL 反映禁用态，且输入区的 Enter 键 MUST NOT 提交。禁用态 MUST NOT 只落在二者之一：发送按钮与 Enter 是两个等价提交手势，MUST 同时不可用。禁用期间任何提交手势 MUST NOT 产生 `session.prompt` 调用。

进行中状态包含多步 turn 的整个区间：turn 内的 assistant 文本、工具调用与思考输出 MUST NOT 使闸门提前放开。

#### Scenario: 回复中按钮禁用

- **WHEN** 会话 S 的 `turn/start` 到达，面板进入进行中状态
- **THEN** 发送按钮处于禁用态（`disabled` 属性为真），输入区 Enter 键不触发提交

#### Scenario: 多步 turn 期间闸门不放开

- **WHEN** 会话 S 的一个 turn 中模型先输出文本、随后调用工具并继续输出
- **THEN** 从 `turn/start` 到 `turn/end` 期间发送按钮始终为禁用态，中途的 assistant 文本与工具事件不使其恢复可用

#### Scenario: 回复中重复点击不产生第二次提交

- **WHEN** 会话 S 的 turn 进行中，用户连续按下发送按钮或 Enter
- **THEN** 面板产生的 `session.prompt` 调用次数为 0 次，且不出现第二条排队中的 prompt

#### Scenario: turn 结束后恢复可提交

- **WHEN** 会话 S 的 `turn/end` 到达
- **THEN** 发送按钮回到可用态，下一次提交手势正常产生 `session.prompt`

### Requirement: 提交入口的忙态守卫

面板 SHALL 在提交入口对忙态做判定，使禁用态与实际是否发出请求相互独立：按钮的禁用表现 MUST NOT 是「不重复提交」的唯一保证。提交手势到达时若面板处于进行中状态，该手势 SHALL 被丢弃且 MUST NOT 进入任何发送路径。

忙态区间 SHALL 覆盖从提交意图片刻起、直到 `turn/end`、turn 因失败终止或状态复位为止，包括冷会话首次提交时创建会话的等待窗口，以及框选截图路径的提交。

#### Scenario: 冷会话首次提交的等待窗口内不重复提交

- **WHEN** 面板尚未绑定任何会话，用户在一次提交的会话创建等待期间再次提交
- **THEN** 面板只产生一次会话创建，且不产生第二次 `session.prompt`

#### Scenario: 框选路径同样受守卫约束

- **WHEN** 用户带着待发送的框选截图提交，在 `turn/end` 之前再次提交
- **THEN** 截图与意图只被发送一次，MUST NOT 出现第二次 `session.prompt`

### Requirement: 失败与状态复位后恢复可提交

闸门 MUST NOT 留下永久禁用。提交所依赖的 `session.prompt` 调用失败时，面板 SHALL 恢复可提交并给出失败提示。会话切换与对话区清空 SHALL 使面板回到可提交状态。既有「进行中」指示的生命周期语义不变：闸门与该指示由同一状态驱动，MUST NOT 引入与它漂移的第二个忙态。

#### Scenario: 提交失败不留残态

- **WHEN** 用户提交后 `session.prompt` RPC 失败
- **THEN** 面板清除进行中状态并使发送按钮恢复可用，同时显示失败提示

#### Scenario: 切换会话后回到可提交

- **WHEN** 用户在有 turn 进行中的会话 S 上切换到另一会话或回到「新会话」
- **THEN** 对话区被清空且发送按钮恢复可用状态

#### Scenario: 进行中指示仍按既有语义显示

- **WHEN** 会话 S 发送 prompt 并收到 `turn/start`
- **THEN** 面板显示进行中指示，且发送按钮的禁用态与该指示同时出现、同时消失

### Requirement: 重连重放后的闸门状态一致

断连重连后，面板 SHALL 按既有历史重放的事件顺序重建闸门状态，使重放结束后的闸门与会话真实状态一致：历史以未结束的 turn 收尾则保持禁用，以 `turn/end` 收尾则恢复可提交。

#### Scenario: 重连后 turn 已结束

- **WHEN** 断连期间 turn 已结束，重连后面板重放会话历史
- **THEN** 重放完成后发送按钮处于可用态

#### Scenario: 重连后 turn 仍在进行

- **WHEN** 断连期间 turn 未结束，重连后面板重放会话历史
- **THEN** 重放完成后发送按钮保持禁用，直到后续实时 `turn/end` 到达才恢复可用

### Requirement: 重放进行期间闸门保持关闭

面板正在重放会话历史（对话区已被清空、turn 状态尚未由事件重建完成）时，闸门 SHALL 保持关闭：发送按钮 MUST 处于禁用态，提交手势 MUST NOT 产生 `session.prompt`。其理由是该区间内面板对会话是否仍有进行中的 turn 尚无结论，放行提交会在用户不知情的情况下把消息排入队列。重放结束（含读取历史失败而提前结束）后，闸门 SHALL 按重放结果再次求解。

#### Scenario: 重放窗口内不可提交

- **WHEN** 面板开始重放会话 S 的历史，在重放完成之前用户点击发送按钮或按 Enter
- **THEN** 发送按钮处于禁用态且不产生 `session.prompt`

#### Scenario: 重放结果决定重放结束后的状态

- **WHEN** 重放会话 S 的历史时读到进行中的 turn（存在 `turn/start` 而无对应 `turn/end`）
- **THEN** 重放结束后发送按钮仍为禁用态，直到后续实时 `turn/end` 到达才恢复可用

#### Scenario: 历史读取失败后恢复可提交

- **WHEN** 会话 S 的历史读取 RPC 失败，重放提前结束并显示失败提示
- **THEN** 发送按钮按重放已应用的事件求解，不因失败本身而永久禁用

### Requirement: 闸门只约束提交

闸门 SHALL 只作用于提交动作，MUST NOT 妨碍用户为下一条消息做准备。禁用期间输入内容 SHALL 保持可编辑且已输入内容 MUST NOT 被清空；框选按钮与附件移除按钮 SHALL 保持可用。

#### Scenario: 回复中仍可书写草稿

- **WHEN** 会话 S 的 turn 进行中，用户在输入区键入下一句话
- **THEN** 输入区接受键入且内容被保留，发送按钮仍为禁用态

#### Scenario: 回复中仍可准备框选附件

- **WHEN** 会话 S 的 turn 进行中，用户点击框选按钮并完成框选
- **THEN** 选区截图作为待发送附件展示，且用户可在 turn 结束后提交它
