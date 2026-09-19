# browser-permission-tiers Specification

## Purpose

让浏览器操作的授权强度成为会话级、可切换且与 dsh 会话权限同进同退的档位：桥接从 dsh 的权限投影独立求解当前档位并据此闸门每次工具调用，扩展只按桥接下发的档位决定是否产生审批请求，扩展无法自证或绕过档位。

## Requirements

### Requirement: 当前权限档位的求解
系统 SHALL 以会话自身的持久旋钮事件为唯一真相源求解当前档位：折叠该会话日志中的 `permission/preset`、`sandbox/mode`、`approval/policy` 三个事件，得到生效的 sandbox 模式与审批策略，再按部署公布的预设表解析出档位名。档位取值限定为该预设表的键与 `custom` 的并集。桥接 MUST NOT 引入、持久化或派生第二份档位状态。
求解 SHALL 仅产生三种可解释的结果，且三者 MUST NOT 互相折算：
1. **已求解**：折叠出的预设名，或在不匹配任何预设时为 `custom`。
2. **无档位能力**：可证明该部署不提供档位数据（会话不存在、或部署未公布任何预设表），此时按「无需档位」处理。
3. **求解失败**：会话存在但档位无法求解。此时系统 SHALL 显式失败并留痕，MUST NOT 折算为任何档位。
档位名 MUST 以部署公布的预设表为准，桥接 MUST NOT 用硬编码的档位名白名单限制它。取自该表之外的档位名，或 `custom`，SHALL 按最严档位 `read-only` 参与闸门判定。
档位求解 MUST NOT 依赖任何可能返回「无值」的读取路径（例如会话权限投影的注册表读取）。当桥接为核对镜像规则而读取投影时，所得值 MUST NOT 单独作为判据：出现分歧时系统 SHALL 留痕，并以更严的一方参与闸门判定。
#### Scenario: 从会话旋钮事件求解档位
- **WHEN** 会话 S 的日志中最后一次 `permission/preset` 为 `danger-full-access`（sandbox 模式与审批策略分别由 `sandbox/mode`、`approval/policy` 记为 `danger-full-access` 与 `never`）
- **THEN** 求解结果为 `danger-full-access`
#### Scenario: 同一会话内求解结果稳定
- **WHEN** 会话 S 的档位在 seq 5 至 seq 435 之间未发生任何变化，模型在该区间内调用 `browser_click`、`browser_type` 各若干次
- **THEN** 每次调用的求解结果都相同，任一调用都 MUST NOT 因求解结果不同而改变策略
#### Scenario: 自定义预设名不按最严档位判定
- **WHEN** 部署公布的预设表含部署自定义的预设名 `team-write`（sandbox `workspace-write`、审批策略 `ask`），会话 S 的档位为 `team-write`，模型调用 `browser_click`
- **THEN** 求解结果为 `team-write`，闸门按与 `workspace-write` 同级的可操作档位放行该调用并要求人工审批，MUST NOT 以 `read-only` 拒绝
#### Scenario: custom 按最严档位处理
- **WHEN** 会话 S 的折叠结果不匹配预设表中的任何条目
- **THEN** 求解结果为 `custom`，闸门按 `read-only` 判定，状态变更类工具调用被拒绝
#### Scenario: 求解失败时不折算为档位
- **WHEN** 会话 S 存在但档位无法求解（会话事件不可读，或镜像规则与投影出现分歧且无法归一）
- **THEN** 该次工具调用以稳定错误码显式失败，MUST NOT 按 `workspace-write` 或任何其他档位放行，且 MUST NOT 产生审批请求
#### Scenario: 部署确实无档位能力时才按无能力处理
- **WHEN** 所连 dsh 未公布任何预设表（旧版部署）
- **THEN** 求解结果为「无档位能力」，`tool.call` 帧省略档位字段，扩展按现状的读写两态行为运行

### Requirement: 档位对工具调用的闸门
桥接 SHALL 在每次 `browser_*` 工具调用到达扩展之前，按求解出的档位与调用所属动作类别决定放行或拒绝：
- 档位 `read-only`：`改页面` 与 `开网站` 两类 MUST 被拒绝，MUST NOT 下发到扩展；`读页面` 与 `观测` 两类 MUST 放行。
- 档位 `workspace-write`：`改页面` 与 `开网站` 两类 MUST 放行，并要求扩展产生人工审批请求。
- 档位 `danger-full-access`：`改页面` 与 `开网站` 两类 MUST 放行，且 MUST NOT 要求扩展产生人工审批请求。
动作类别定义为：`读页面` = `browser_snapshot`、`browser_get_text`；`观测` = `browser_scroll`、`browser_wait`；`改页面` = `browser_click`、`browser_type`、`browser_press`；`开网站` = `browser_navigate`、`browser_open_tab`、`browser_back`、`browser_forward`、`browser_reload`。
#### Scenario: 仅可查看下状态变更被拒
- **WHEN** 会话 S 的求解档位为 `read-only`，模型调用 `browser_click`
- **THEN** 该调用以稳定错误码被拒绝，扩展侧 MUST NOT 收到该 `tool.call`
#### Scenario: 仅可查看下开新标签页被拒
- **WHEN** 会话 S 的求解档位为 `read-only`，模型调用 `browser_open_tab`
- **THEN** 该调用以稳定错误码被拒绝，且 MUST NOT 创建新标签页
#### Scenario: 仅可查看下读取与观测放行
- **WHEN** 会话 S 的求解档位为 `read-only`，模型调用 `browser_snapshot`、`browser_get_text`、`browser_scroll` 或 `browser_wait`
- **THEN** 四类调用全部下发到扩展并正常返回结果
#### Scenario: 可操作下放行并要求确认
- **WHEN** 会话 S 的求解档位为 `workspace-write`，模型调用 `browser_navigate`
- **THEN** 该调用带「需人工审批」档位下发给扩展，扩展产生审批请求
#### Scenario: 完全权限下不产生审批请求
- **WHEN** 会话 S 的求解档位为 `danger-full-access`，模型调用 `browser_click`
- **THEN** 该调用带「直接执行」档位下发给扩展，扩展 MUST NOT 产生审批请求

### Requirement: 档位求解不可被扩展影响
档位判定 MUST 由桥接独立完成。扩展侧的任何输入——包括其本地持久化设置、`tool.call` 帧之外的消息、以及任何自称已获用户授权的声明——MUST NOT 参与档位求解，也 MUST NOT 使档位 `read-only` 的拒绝结果被规避。
`tool.call` 帧携带的档位 MUST 被扩展视为桥接已确定的结论：扩展 MUST NOT 从本地配置推导档位，也 MUST NOT 用本地档位覆盖帧内档位；若帧未携带档位，扩展 SHALL 按「需人工审批」处理。
#### Scenario: 扩展不能自证档位
- **WHEN** 扩展在任何面板或后台消息中声称当前档位为 `danger-full-access`，而会话 S 的投影 `currentValue` 为 `read-only`
- **THEN** 闸门仍按 `read-only` 拒绝 `browser_click`，该声明不改变判定
#### Scenario: 扩展不能覆盖帧内档位
- **WHEN** 扩展本地设置指示无需审批，而收到的 `tool.call` 帧档位为「需人工审批」
- **THEN** 扩展按帧内档位产生审批请求
#### Scenario: 无档位帧按最严处理
- **WHEN** 扩展收到一个未携带档位字段的 `tool.call` 帧且调用属于 `改页面` 类别
- **THEN** 扩展产生人工审批请求，MUST NOT 直接执行

### Requirement: 档位切换请求
桥接 SHALL 接受来自扩展的档位切换请求，请求载荷为单个目标预设名。桥接 MUST 校验该名称为该会话可用档位集合中的预设名，且 MUST NOT 接受 `custom`。
校验通过时，桥接 SHALL 经 dsh 的预设命令写入（记录预设选择并同步更新 sandbox 模式与审批策略），MUST NOT 只改写 sandbox 模式或审批策略中的单个旋钮。
切换是否生效 MUST 以会话权限投影回传的档位值等于目标档位为唯一判据，MUST NOT 以扩展的声明或写入调用的返回值为判据。
#### Scenario: 合法切换生效
- **WHEN** 扩展请求把会话 S 切到 `danger-full-access`，且该名在 S 的可用档位集合内
- **THEN** 桥接执行预设写入，随后 S 的权限投影 `currentValue` 变为 `danger-full-access`，S 上后续 `browser_click` 不再产生审批请求
#### Scenario: 未知档位名被拒
- **WHEN** 扩展请求把会话 S 切到 `super-user`
- **THEN** 桥接以可读失败拒绝，S 的档位不变，MUST NOT 产生任何会话事件
#### Scenario: custom 不可作为切换目标
- **WHEN** 扩展请求把会话 S 切到 `custom`
- **THEN** 桥接以可读失败拒绝，S 的档位不变
#### Scenario: 不直写单个旋钮
- **WHEN** 扩展请求把会话 S 从 `danger-full-access` 切到 `read-only`
- **THEN** 切换后 S 的投影 `currentValue` 为 `read-only`（而非 `custom`），且在 dsh 界面再次选择其他预设时不会残留先前的档位意图

### Requirement: 模型侧的档位播报
当部署提供系统提示词上下文能力时，系统 SHALL 把当前档位及其对浏览器操作的后果播报给模型：`read-only` 下 MUST 说明改页面与开网站操作会被拒绝并提示不要请求这些操作；`workspace-write` 下 MUST 说明改页面与开网站操作需要人工确认且可能被拒绝；`danger-full-access` 下 MUST 说明这些操作会直接执行。
该播报 SHALL 在每次模型请求时按会话当前档位重新求值，MUST NOT 缓存首次结果。当部署不提供该系统提示词能力时，系统 SHALL 跳过播报，MUST NOT 因此失败或影响工具可用性。
#### Scenario: 只读档下模型被告知限制
- **WHEN** 会话 S 的档位为 `read-only`，S 上发生一次模型请求
- **THEN** 该请求的系统提示词包含「改页面与开网站操作会被拒绝」的说明
#### Scenario: 切换档位后播报更新
- **WHEN** 会话 S 的档位从 `read-only` 切到 `danger-full-access` 后发生下一次模型请求
- **THEN** 该请求的播报反映 `danger-full-access` 的后果，不再包含只读限制说明
#### Scenario: 无系统提示词能力时跳过
- **WHEN** 部署未提供系统提示词上下文能力
- **THEN** 跳过播报，12 个 `browser_*` 工具照常注册与可用，桥接连接不受影响

### Requirement: 无档位能力部署的降级
当且仅当所连 dsh 可证明不提供权限档位能力时，系统 SHALL 整体降级为「无档位」：工具照常注册，`tool.call` 帧省略档位字段，扩展按现状的读写两态行为运行（读按页面分享偏好、改页面与新开标签页每次人工审批），且档位切换请求 MUST 以稳定的「能力不可用」失败返回。
当档位能力存在但某次求解失败时，系统 MUST NOT 进入该降级：该次调用 SHALL 以显式失败返回，不产生审批请求，也不改变连接、握手与其他 RPC 的可用性。
降级 MUST NOT 影响连接建立、握手、其他 RPC 方法与事件流。
#### Scenario: 降级后工具照常可用
- **WHEN** 已认证连接 R 所连 dsh 不提供权限档位能力
- **THEN** 模型调用 `browser_snapshot` 与 `browser_click` 均照常下发；后者产生人工审批请求
#### Scenario: 降级后切换请求明确失败
- **WHEN** 扩展在无档位能力的部署上请求切换档位
- **THEN** 桥接返回稳定的「能力不可用」失败，连接保持，事件流不受影响
#### Scenario: 能力存在时求解失败不等于降级
- **WHEN** 会话 S 的档位能力可用，但某次 `browser_click` 的档位求解失败
- **THEN** 该次调用以显式失败返回且 MUST NOT 产生审批请求；紧接着的下一次 `browser_snapshot` 与 `browser_click` 照常按 S 的真实档位判定，MUST NOT 整体降级为每次审批

### Requirement: 求解失败的可诊断性
档位求解失败 SHALL 被显式记录，记录内容 MUST 足以定位失败发生在求解链的哪一环（会话标识、失败环节、以及该环节的可读原因）。系统 MUST NOT 用同一种静默返回值表达「读取抛错」与「数据确实不存在」这两类不同情况。
模型侧可见的失败结果 SHALL 使用稳定错误码，且 SHALL 说明档位无法求解这一事实；MUST NOT 把失败表述为「档位不允许该操作」，以免模型据此改用其他工具绕过。
#### Scenario: 失败留痕且可定位
- **WHEN** 会话 S 上的一次 `browser_click` 因档位求解失败被拒绝
- **THEN** 桥接日志中出现一条包含 S 的标识与失败环节的记录，且该次调用返回稳定错误码
#### Scenario: 失败不被表述为档位拒绝
- **WHEN** 会话 S 上的一次 `browser_click` 因档位求解失败被拒绝
- **THEN** 返回给模型的文本说明「档位无法求解」，MUST NOT 声称是某个档位不允许该操作
#### Scenario: 读取抛错与数据缺失可区分
- **WHEN** 档位求解过程中某一步抛出异常，而另一次求解中同一环节正常返回但数据不存在
- **THEN** 两次事件留下可区分的记录，MUST NOT 折叠为同一条无差别日志
