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

### Requirement: 未配置时不改变既有行为

部署未配置会话工作区目录时，桥接层 SHALL 保持与变更前逐字段一致的 `session.create` 转发行为，会话落点仍完全由 dsh 自身默认规则决定。

#### Scenario: 缺省配置下的会话创建

- **WHEN** 部署未配置会话工作区目录，扩展以空 payload 发起 `session.create`
- **THEN** 桥接层转发的请求不含 `workspaceId`，会话按 dsh 默认规则创建，其分组表现与本次变更前相同（即「未分组」）

### Requirement: 分组失败不连累会话创建

桥接层 MUST NOT 因工作区注册或身份解析失败而使 `session.create` 失败。此类失败发生时，桥接层 SHALL 退回转发原始请求，并 MUST NOT 把该次失败永久固化为「不再尝试」的状态。

#### Scenario: 配置目录不存在导致注册被拒

- **WHEN** 部署配置的目录 P 在磁盘上不存在（工作区注册因路径不存在被 dsh 拒绝），扩展以空 payload 发起 `session.create`
- **THEN** 该会话仍被成功创建并向扩展返回有效 `sessionId`，仅其归属保持未分组；桥接层不因本次失败中断后续连接与 RPC

#### Scenario: 失败后恢复可用时重新尝试

- **WHEN** 前一次 `session.create` 因目录 P 缺失而未能分组，随后 P 变为存在，扩展再次以空 payload 发起 `session.create`
- **THEN** 桥接层重新执行注册并成功把新会话归入对应工作区分组
