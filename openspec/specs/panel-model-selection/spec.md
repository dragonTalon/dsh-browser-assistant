# panel-model-selection Specification

## Purpose

面板让用户看见会话实际使用的模型并按会话切换它：桥接提供一份带多模态能力的模型目录，面板以下拉呈现候选、标注每个模型的多模态能力、实时反映会话实际选中，选择即生效。

## Requirements

### Requirement: 模型目录的提供

桥接 SHALL 提供一个只读的 `model.catalog` RPC 方法，返回：部署默认模型选择 `default`（`{provider, model, reasoningEffort?}`）、provider 分组目录（每组含 `provider id/name` 与模型条目 `{id, name, inputModalities?}`）、以及逐 provider 的故障列表 `failures`。其中一个 provider 的目录查询失败 MUST 只记入 `failures`，MUST NOT 影响其余 provider 条目的返回。模型 `inputModalities` 字段 MUST 如实透传 provider 公布值：provider 未公布时必须省略该字段，MUST NOT 编造。桥接所依赖的模型服务缺失时，`model.catalog` MUST 返回明确的失败结果，且 MUST NOT 断开连接或影响其他 RPC 方法与事件流。

#### Scenario: 正常返回带能力标记的目录

- **WHEN** 已认证连接 R 发起 `model.catalog` RPC，dsh 进程内存在一个 provider P（含模型 m，公布 `inputModalities: ['text','image']`）
- **THEN** RPC 成功，返回体含 `default`、组 P 的条目 m 且其 `inputModalities` 为 `['text','image']`

#### Scenario: 单个 provider 故障被隔离

- **WHEN** 发起 `model.catalog`，provider A 的目录查询抛错而 provider B 正常
- **THEN** 返回体中 A 仅出现在 `failures`（含可读的失败信息），B 的模型条目完整返回，RPC 整体成功

#### Scenario: 模型服务缺失

- **WHEN** 桥接进程内探测不到模型目录服务，扩展发起 `model.catalog`
- **THEN** RPC 返回明确失败（含稳定的错误码与原因文本），连接保持，事件流与后续 `session.prompt` 不受影响

### Requirement: 当前选中模型的确定

面板 SHALL 按以下次序确定「当前选中模型」：会话历史响应 `projections.values.modelSelection` 的 `next`，为 null 时取 `lastUsed`，再为 null 或投影缺失时取 `model.catalog` 的 `default`。活动会话发生变化时——用户切换到另一个会话，或落到尚未创建的「新会话」——面板 MUST 先清除上一会话的选择显示，再按上述次序对新会话重新确定，MUST NOT 沿用上一会话的选中显示。会话 S 因 `session.selectModel` 成功提交 `model/selection` 事件后，面板 MUST 把当前选中更新为该事件的选择，无需等待下一次历史拉取。面板在每次连接成功后 SHOULD 刷新目录（目录内容可能随 adapter 注册变化）。

#### Scenario: 已选模型的会话显示所选

- **WHEN** 会话 S 已提交过 provider P、模型 m 的 `model/selection` 事件，面板拉取 S 的历史
- **THEN** 面板显示 (P, m) 为当前选中

#### Scenario: 新空会话回退部署默认

- **WHEN** 面板新建会话 S 且 S 无任何模型事件，目录 `default` 为 (P, d)
- **THEN** 面板显示 (P, d) 为当前选中

#### Scenario: 切换会话后重新对齐模型显示

- **WHEN** 面板此前显示会话 S1 的选中模型 (P, m)，用户切换到无任何模型事件的会话 S2，目录 `default` 为 (P, d)
- **THEN** 面板不再显示 (P, m)，而是显示 (P, d) 为 S2 的当前选中

#### Scenario: 目录失败不阻断对话

- **WHEN** 连接成功但 `model.catalog` 拉取失败
- **THEN** 面板显示「模型目录不可用」提示，消息收发照常可用

### Requirement: 用户在面板选择模型

面板 SHALL 提供模型选择下拉，列出目录中的候选（按 provider 分组）。用户选定 (provider, model) 后，面板 MUST 调用 `session.selectModel` 使会话后续请求改用该模型；成功后面板 MUST 立即更新当前选中显示，且 MUST 在会话历史投影回流后保持一致。选择 RPC 失败时，面板 MUST 显示可读的失败提示并维持原选中显示。面板 MUST 在模型选择区域留常驻或选定前的提示，说明该选择会同时成为 dsh 的部署默认模型。

#### Scenario: 选择成功即生效

- **WHEN** 会话 S 当前模型为 a，用户在下拉选定模型 m（同 provider P）并确认，`session.selectModel` 返回成功
- **THEN** 面板立即显示 (P, m)，此后 S 上发出的 prompt 使用模型 m

#### Scenario: 选择失败保持原状

- **WHEN** 用户选定 m 但 `session.selectModel` 返回 `session/model-unavailable`
- **THEN** 面板显示含该错误码的失败提示，当前选中显示维持为 a

#### Scenario: 面板外改模型同步进来

- **WHEN** 会话 S 被另一个客户端改了模型，产生 `model/selection` 事件 (Q, n) 并经事件流到达面板
- **THEN** 面板把当前选中更新为 (Q, n)

### Requirement: 多模态能力标记

面板 SHALL 对当前选中模型与下拉候选显示能力标记：模型的 `inputModalities` 含 `'image'` 时标记为视觉；`inputModalities` 存在且不含 `'image'` 时标记为文本；`inputModalities` 未公布，或会话投影中的 (provider, model) 在目录中查无此条目时，MUST 标记为未知，MUST NOT 臆断其能力。

#### Scenario: 视觉模型被标注

- **WHEN** 当前选中模型在目录条目中含 `inputModalities: ['text','image']`
- **THEN** 面板在模型名旁显示视觉标记

#### Scenario: 文本模型被标注

- **WHEN** 当前选中模型在目录条目中含 `inputModalities: ['text']`
- **THEN** 面板显示文本标记

#### Scenario: 能力未知不臆断

- **WHEN** 当前选中 (P, m) 在目录中没有条目，或该条目未公布 `inputModalities`
- **THEN** 面板显示「能力未知」标记，不显示视觉或文本断言
