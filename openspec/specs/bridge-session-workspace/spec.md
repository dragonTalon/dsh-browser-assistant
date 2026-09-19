# bridge-session-workspace Specification

## Purpose

让 Chrome 扩展面板创建的会话自动归入部署配置的 dsh 工作区，从而在 dsh GUI 侧边栏中按项目分组显示，而不是堆在「未分组」桶里；同时保证未配置该能力时行为与变更前完全一致。

## Requirements

### Requirement: 扩展创建会话的工作区归属

当部署配置了会话工作区目录，且扩展发起的 `session.create` 请求既未指定 `workspaceId` 也未指定 `cwd` 时，桥接层 SHALL 先把该目录幂等注册为 dsh 工作区，再把解析出的 `workspaceId` 注入转发请求，使新建会话以该工作区 path 作为 cwd 并成为该工作区成员。会话在 dsh GUI 中的分组标题 SHALL 等于该工作区标题（即配置目录的 basename）。

#### Scenario: 配置目录尚未注册为工作区时创建首个会话

- **WHEN** 部署已配置会话工作区目录 P（如 `/repo/packages/bridge-dsh`），dsh 工作区注册表中尚无 path 等于 P 的工作区，且扩展以空 payload 发起 `session.create`
- **THEN** 桥接层先以 P 注册工作区，再以该工作区身份创建会话，返回的 `sessionId` 在 dsh GUI 侧边栏归入标题为 `bridge-dsh` 的分组，而不是「未分组」

#### Scenario: 工作区已注册时复用既有身份

- **WHEN** 部署已配置目录 P，且 P 已作为工作区 W 注册（登记表已有 W），扩展再次以空 payload 发起 `session.create`
- **THEN** 桥接层复用 W 的身份创建会话，不新建第二个工作区，且 W 的标题与既有成员顺序保持不变，新会话出现在 W 分组下

### Requirement: 调用方显式位置优先

桥接层 MUST NOT 在 `session.create` 请求已指定 `workspaceId` 或 `cwd` 时注入配置的工作区目录，显式指定的位置 MUST 原样传递给 dsh。

#### Scenario: 请求自带 workspaceId

- **WHEN** 扩展发起 `session.create` 且 payload 含 `workspaceId` W2（部署同时配置了目录 P）
- **THEN** 桥接层不注入 P 解析出的工作区，会话归属 W2；该请求与未配置 P 时的转发结果一致

#### Scenario: 请求自带 cwd

- **WHEN** 扩展发起 `session.create` 且 payload 含 `cwd` C（部署同时配置了目录 P）
- **THEN** 桥接层不注入 P 解析出的工作区，会话 cwd 为 C，且不因本能力而改变归属

### Requirement: 分组失败不连累会话创建

桥接层 MUST NOT 因工作区注册或身份解析失败而使 `session.create` 失败。此类失败发生时，桥接层 SHALL 退回转发原始请求，并 MUST NOT 把该次失败永久固化为「不再尝试」的状态。

桥接层 MUST NOT 让一次注册尝试的生命周期绑定到**发起它的那次连接**。连接被替换（扩展重连或换代）时，该连接自身的取消信号失效 MUST NOT 导致后续注册沿用一个已失效的生命周期而必然失败；注册 SHALL 使用独立于调用方连接的生命周期，使连接替换后配置未变的分组仍能注册成功。

#### Scenario: 配置目录不存在导致注册被拒

- **WHEN** 部署配置的目录 P 在磁盘上不存在（工作区注册因路径不存在被 dsh 拒绝），扩展以空 payload 发起 `session.create`
- **THEN** 该会话仍被成功创建并向扩展返回有效 `sessionId`，仅其归属保持未分组；桥接层不因本次失败中断后续连接与 RPC

#### Scenario: 失败后恢复可用时重新尝试

- **WHEN** 前一次 `session.create` 因目录 P 缺失而未能分组，随后 P 变为存在，扩展再次以空 payload 发起 `session.create`
- **THEN** 桥接层重新执行注册并成功把新会话归入对应工作区分组

#### Scenario: 瞬时失败在同一次请求内重试

- **WHEN** 部署已配置目录 P，扩展以空 payload 发起 `session.create`，而该次注册因瞬时原因失败（网关暂不可用、调用超时、应答丢失），且紧接着的一次尝试会成功
- **THEN** 桥接层 MUST 在**同一次 `session.create` 内**重试注册，且该会话 MUST 以解析出的工作区身份创建（即直接分组）；MUST NOT 因为一次瞬时失败就先建出一个再也无法迁入分组的未分组会话

#### Scenario: 永久失败不做无意义重试

- **WHEN** 注册被「路径不存在」或「请求被拒」这类永久性原因拒绝
- **THEN** 桥接层 MUST NOT 重复同一必然失败的调用；该会话按未分组创建，诊断日志说明原因

#### Scenario: 分组决策留痕

- **WHEN** 部署已配置目录 P，扩展以空 payload 发起 `session.create`
- **THEN** 桥接层 MUST 为本次决策输出可区分的诊断（复用既有工作区身份 / 正在注册 / 注册成功 / 注册失败及其错误码），使「会话落在未分组」可从事后日志判定，而不是只能靠推断

#### Scenario: 连接替换后分组仍能注册成功

- **WHEN** 工作区注册在连接 A 上被发起，注册尚未完成时连接 A 被连接 B 替换，随后扩展在连接 B 上以空 payload 发起 `session.create`，且部署配置未变
- **THEN** 桥接层在连接 B 上完成注册并把新会话归入对应工作区分组，MUST NOT 因为连接 A 已失效而永久失去分组能力

### Requirement: 未配置时的默认工作区

部署未配置会话工作区项目时,桥接层 SHALL 使用本机 dsh 数据根下的默认目录 `$DSH_HOME/workspaces/bridge-dsh`(数据根缺省为 `~/.dsh`,遵从 `$DSH_HOME` 覆盖),而不是把该能力视为关闭。该默认目录不存在时,桥接层 SHALL 创建它,再把它幂等注册为 dsh 工作区;插件 MUST NOT 因创建或注册失败而留下半成品状态(残留目录不参与任何后续判定)。

默认来源之外,部署显式配置的目录 MUST 原样使用,且桥接层 MUST NOT 为显式配置的目录创建任何目录 —— 配置错误必须表现为显式失败,而不是被静默补齐。

工作区标题由 dsh 从目录 basename 推导,因此默认来源产生的分组标题 SHALL 恒为 `bridge-dsh`。

#### Scenario: 干净机器未配置时开箱获得默认工作区

- **WHEN** 一台从未安装过本插件的机器完成安装并首次启动 dsh,部署未配置 `sessionWorkspace`,且 `$DSH_HOME/workspaces/bridge-dsh` 不存在
- **THEN** dsh 的工作区列表中 SHALL 出现标题为 `bridge-dsh` 的工作区,其 path 为 `$DSH_HOME/workspaces/bridge-dsh`

#### Scenario: 默认工作区承载扩展发起的首个会话

- **WHEN** 默认工作区已由启动期供给注册,扩展以空 payload 发起 `session.create`
- **THEN** 桥接层以该工作区身份创建会话,返回的 `sessionId` 在 dsh GUI 侧边栏归入 `bridge-dsh` 分组,且该会话的 cwd 等于 `$DSH_HOME/workspaces/bridge-dsh`

#### Scenario: 显式配置覆盖默认值且不自动建目录

- **WHEN** 部署配置 `sessionWorkspace` 为存在的绝对目录 P,同时默认目录不存在
- **THEN** 桥接层使用 P 注册与注入,分组标题为 P 的 basename,MUST NOT 创建默认目录或 P 之外的任何目录

#### Scenario: 显式配置的目录不存在

- **WHEN** 部署配置 `sessionWorkspace` 为磁盘上不存在的绝对目录 P
- **THEN** 桥接层 MUST NOT 创建 P;扩展发起的 `session.create` 仍成功返回有效 `sessionId`,仅归属保持未分组

### Requirement: 缺省工作区的启动期供给不影响 dsh 启动

桥接层 SHALL 在 dsh 启动、插件激活时尽力供给默认工作区,使工作区在用户尚未发起任何扩展会话时就已存在。该供给 MUST NOT 使 dsh 启动失败、MUST NOT 使插件条目保持未激活状态:创建目录或注册工作区的任何失败 SHALL 只产生一条可诊断记录,并保持桥接其余能力(连接、RPC、工具注册、事件泵)完全正常。

供给 MUST NOT 被固化为永久状态:启动期未成功的部署,在其后首次 `session.create` 时 SHALL 重新尝试供给。

#### Scenario: 默认目录无法创建时 dsh 仍正常启动

- **WHEN** 部署未配置 `sessionWorkspace`,且 dsh 数据根不可写导致默认目录无法创建
- **THEN** dsh SHALL 正常完成启动、插件条目处于激活状态、`/ext/bridge` 可接受扩展连接;工作区列表不出现 `bridge-dsh`;随后扩展以空 payload 发起 `session.create` 时该会话仍被成功创建,仅归属保持未分组

#### Scenario: 启动期失败后于首次会话恢复

- **WHEN** 前一次 dsh 启动因数据根不可写而未能供给默认工作区,随后该目录变为可创建,dsh 未重启而扩展以空 payload 发起 `session.create`
- **THEN** 桥接层在该次会话前完成目录创建与工作区注册,并把该会话归入 `bridge-dsh` 分组

#### Scenario: 启动期供给未完成时扩展立即发消息

- **WHEN** dsh 启动后启动期供给仍在进行中,扩展即以空 payload 发起 `session.create`
- **THEN** 该会话被归入 `bridge-dsh` 分组,SHALL NOT 因供给尚未落定而落回「未分组」,也 SHALL NOT 因此创建第二个工作区

### Requirement: 显式关闭

部署把 `sessionWorkspace` 显式设为 `off`(大小写不敏感)、空串或纯空白时,桥接层 SHALL 视为关闭:不供给默认工作区、不注册任何工作区、不创建任何目录,`session.create` 的转发行为与「未配置」在本能力引入前的行为逐字段一致。

#### Scenario: 关闭时启动不产生任何副作用

- **WHEN** 部署配置 `sessionWorkspace: off`,且默认目录不存在
- **THEN** dsh 启动后工作区列表不出现 `bridge-dsh`,默认目录仍不存在

#### Scenario: 关闭时的会话创建

- **WHEN** 部署配置 `sessionWorkspace: off`(或空串、纯空白),扩展以空 payload 发起 `session.create`
- **THEN** 桥接层转发的请求不含 `workspaceId`,会话按 dsh 自身默认规则创建并显示为「未分组」

### Requirement: 分组状态可诊断

桥接层的本机发现端点 SHALL 在既有 `wsUrl` 之外报告当前的分组状态:生效路径、取值来源(默认 / 显式配置 / 已关闭),以及最近一次供给或注册失败的原因;从未失败时该失败项为空。客户端 SHALL NOT 因该端点多出字段而失效(只读既有字段的客户端行为不变)。

#### Scenario: 缺省配置下的端点报告

- **WHEN** dsh 启动完成且部署未配置 `sessionWorkspace`(默认工作区已成功供给)
- **THEN** 发现端点报告来源为默认、路径为 `$DSH_HOME/workspaces/bridge-dsh`,且不存在失败原因

#### Scenario: 关闭时的端点报告

- **WHEN** 部署配置 `sessionWorkspace: off` 并完成 dsh 启动
- **THEN** 发现端点报告来源为已关闭,且不报告任何生效路径

#### Scenario: 失败原因可见

- **WHEN** 默认目录因权限问题无法创建,扩展或运维读取发现端点
- **THEN** 端点报告来源为默认、路径为期望的默认目录,并给出最近一次失败的原因;与此同时 `wsUrl` 字段保持可用的原有取值
