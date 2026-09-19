# panel-page-sharing-setting Specification

## Purpose

把扩展既有的页面分享偏好（是否允许页面内容离开页面送给模型）做成用户可见、可撤销的隐私轴控件：它与权限档位正交，只控制页面内容的读取与分享，不控制智能体能做什么。

## Requirements

### Requirement: 页面分享偏好控件

系统 SHALL 在面板的系统配置处提供页面分享偏好控件，取值与语义为：`auto`（自动）表示页面读取直接放行；`ask`（每次询问）表示每次页面读取都先经人工确认；`off`（关闭）表示页面读取一律拒绝。

控件当前值 MUST 反映实际持久化的偏好值，MUST NOT 显示与实际生效值不符的状态。用户改变选择后，该值 SHALL 立即持久化并对后续工具调用生效。

#### Scenario: 控件呈现实际偏好

- **WHEN** 持久化的页面分享偏好为 `ask`
- **THEN** 控件显示为「每次询问」

#### Scenario: 改变即持久化并生效

- **WHEN** 用户把偏好从「自动」改为「关闭」
- **THEN** 后续的 `browser_snapshot` 与 `browser_get_text` 被拒绝，且该值在扩展重启后仍为「关闭」

#### Scenario: 关闭状态下的读取被拒

- **WHEN** 偏好为 `off`，模型调用 `browser_snapshot`
- **THEN** 该调用被拒绝，且 MUST NOT 产生人工审批请求

#### Scenario: 每次询问状态下的读取需确认

- **WHEN** 偏好为 `ask`，模型调用 `browser_get_text`
- **THEN** 该调用产生人工审批请求，用户拒绝时返回拒绝结果

### Requirement: 页面分享偏好的唯一改动入口可撤销

面板 MUST 提供页面分享偏好的可见入口，使用户能够查看并撤销任何由其他途径造成的偏好改动。

当用户在审批弹框中选定「总是允许读取」时，系统 SHALL 把偏好置为 `auto` 并持久化；该次改动 MUST 立即反映在控件上，MUST NOT 存在只能被写入而无法被看见或撤销的偏好状态。

#### Scenario: 总是允许读取后控件同步

- **WHEN** 偏好为 `ask`，用户在审批弹框中选择「总是允许读取」
- **THEN** 该次读取被放行，偏好被置为 `auto`，控件立即显示为「自动」

#### Scenario: 撤销总是允许读取

- **WHEN** 偏好因「总是允许读取」被置为 `auto`，用户随后在控件中改回「每次询问」
- **THEN** 后续页面读取重新逐次产生人工审批请求

#### Scenario: 分享关闭的提示指向真实入口

- **WHEN** 偏好为 `off`，模型发起一次页面读取
- **THEN** 返回给模型的失败说明指出可在面板系统配置的页面分享控件中调整，MUST NOT 指向不存在的设置位置

### Requirement: 隐私轴与权限档位互不干扰

页面分享偏好与权限档位 SHALL 保持独立：改变页面分享偏好 MUST NOT 改变会话权限档位，改变会话权限档位 MUST NOT 改变页面分享偏好。

在任一权限档位下，页面读取的放行/确认/拒绝 MUST 只由页面分享偏好决定：`auto` 放行、`ask` 确认、`off` 拒绝。页面的 URL 与标题等标签页元信息 SHALL 保持既有行为，MUST NOT 因分享偏好为 `off` 而改变。

#### Scenario: 改分享不影响档位

- **WHEN** 会话 S 的档位为 `workspace-write`，用户把页面分享偏好从「自动」改为「关闭」
- **THEN** S 的权限档位仍为 `workspace-write`，`browser_click` 仍按档位产生人工审批请求

#### Scenario: 改档位不影响分享

- **WHEN** 页面分享偏好为 `off`，用户把会话 S 的档位切到 `danger-full-access`
- **THEN** 页面分享偏好仍为 `off`，`browser_snapshot` 仍被拒绝

#### Scenario: 只读档下读取仍由分享决定

- **WHEN** 会话 S 的档位为 `read-only`，页面分享偏好为「自动」
- **THEN** `browser_snapshot` 与 `browser_get_text` 正常返回结果

#### Scenario: 只读档叠加关闭分享仍可读标签页元信息

- **WHEN** 会话 S 的档位为 `read-only`，页面分享偏好为 `off`
- **THEN** 页面内容读取被拒绝，而标签页的 URL 与标题仍照常呈现
