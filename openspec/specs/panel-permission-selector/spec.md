# panel-permission-selector Specification

## Purpose

在面板输入区提供会话级权限档位控件：读取 dsh 会话的权限投影、以 dsh 自己的档位名呈现当前档位、允许用户切换，并与 dsh 界面的档位选择保持双向一致。

## Requirements

### Requirement: 权限档位控件的呈现

面板 SHALL 在输入区提供权限档位控件，与模型选择器并列，呈现当前会话生效的档位并提供切换入口。

控件的档位值 MUST 全部来自会话权限投影，MUST NOT 由扩展本地配置推导或本地缓存为权威值。控件的候选档位 MUST 来自投影公布的可用档位集合，MUST NOT 硬编码档位清单。

脱离连接（未连接、会话不可用或投影缺失）时，控件 SHALL 呈现与「不可用」相符的禁用状态，并 MUST NOT 允许发起切换。

#### Scenario: 呈现会话当前档位

- **WHEN** 面板绑定会话 S，S 的权限投影 `currentValue` 为 `workspace-write`
- **THEN** 权限档位控件显示为「工作区内修改」

#### Scenario: 候选来自投影而非硬编码

- **WHEN** 所连 dsh 的权限投影只公布 `workspace-write` 与 `danger-full-access` 两项
- **THEN** 控件只列出这两项，MUST NOT 显示该部署不提供的 `read-only`

#### Scenario: 未连接时禁用

- **WHEN** 桥连接未建立
- **THEN** 权限档位控件呈禁用状态，且 MUST NOT 因用户操作而发出切换请求

#### Scenario: 新会话状态下即可预先配置档位

- **WHEN** 面板处于「新会话」状态（尚无任何会话被绑定），且所连 dsh 公布了可用档位集合
- **THEN** 控件 SHALL 列出该集合的候选并保持可交互，MUST NOT 以「不可用」呈现

面板在该状态下 SHALL 从**部署公布**的档位集合取得候选（任一会话的权限投影都会公布它），MUST NOT 因为本会话尚无当前值就拒绝提供候选。用户选定档位时，面板 SHALL 先创建会话再提交切换（与首次选模型同样的惰性创建），MUST NOT 在用户仅打开面板时就创建会话。无当前值期间控件 MUST NOT 把任何候选标记为已选中——「尚未读到」与「已选中某档」是两件事。

#### Scenario: 新会话状态下选定档位即创建会话并生效

- **WHEN** 面板处于「新会话」状态，用户选定 `read-only`
- **THEN** 面板创建一个会话、提交该档位切换，并在投影回流后把控件显示为该档位

#### Scenario: 打开面板不因档位控件而创建会话

- **WHEN** 用户仅打开面板并查看档位控件，未做任何选择
- **THEN** 会话列表 MUST NOT 因该控件而新增会话

#### Scenario: 新会话状态不伪装已选中

- **WHEN** 面板处于「新会话」状态且控件已列出候选
- **THEN** 任何候选都 MUST NOT 呈选中态，控件 SHALL 提示选定后会创建会话并生效

### Requirement: 档位标签与浏览器作用范围标注

控件 SHALL 使用与 dsh 界面一致的档位标签：`read-only` → 「仅可查看」、`workspace-write` → 「工作区内修改」、`danger-full-access` → 「完全权限」。对于部署公布的、上述映射之外的预设名，控件 MUST NOT 臆造标签，SHALL 以投影公布的名称为准，缺失时回退为预设名原文。

控件 SHALL 为每个档位标注其在浏览器操作上的作用范围：`read-only` 标注为仅可读取页面与观察，不可操作页面或打开网站；`workspace-write` 标注为改页面与打开网站每次需人工确认；`danger-full-access` 标注为改页面与打开网站不再确认。

#### Scenario: 标准三档显示 dsh 标签

- **WHEN** 投影公布 `read-only`、`workspace-write`、`danger-full-access` 三项
- **THEN** 控件分别显示「仅可查看」「工作区内修改」「完全权限」

#### Scenario: 部署自定义预设不臆造标签

- **WHEN** 投影公布一个名为 `strict-audit` 的预设且未提供显示名
- **THEN** 控件显示 `strict-audit` 原文，MUST NOT 显示为「仅可查看」或任何其他标准档位名

#### Scenario: 档位附带浏览器作用范围说明

- **WHEN** 用户展开或悬停 `read-only` 档位
- **THEN** 该档位的说明文本指出不可操作页面、不可打开网站

### Requirement: custom 档位的如实呈现

当投影的档位取值为 `custom` 时，控件 SHALL 如实呈现「自定义」语义并说明当前设置不匹配任何预设，MUST NOT 强行归类到任一同构档位。`custom` MUST NOT 成为切换目标。

#### Scenario: 自定义档位如实显示

- **WHEN** 会话 S 的权限投影 `currentValue` 为 `custom`
- **THEN** 控件显示「自定义」及其说明，MUST NOT 显示为「仅可查看」或「工作区内修改」

#### Scenario: 自定义不可被再次选中

- **WHEN** 会话 S 的投影 `currentValue` 为 `custom`
- **THEN** 该条目呈不可选状态，用户点击它不会发出切换请求

### Requirement: 用户从面板切换档位

用户选定目标档位后，面板 SHALL 经桥接发起档位切换请求。面板 MUST NOT 直接改写会话的 sandbox 模式或审批策略，MUST NOT 在扩展本地记录权威档位。

面板 MAY 在请求发出后乐观更新显示；当请求失败时，面板 MUST 显示含稳定错误码的可读失败提示，并 MUST 把显示恢复为投影的当前档位。

#### Scenario: 切换成功即生效

- **WHEN** 会话 S 当前档位为 `workspace-write`，用户选定「仅可查看」且切换成功
- **THEN** 此后 S 上的 `browser_click` 被拒绝，控件显示「仅可查看」

#### Scenario: 切换失败保持原状

- **WHEN** 用户选定目标档位而切换请求返回失败
- **THEN** 面板显示含该错误码的失败提示，控件显示恢复为切换前的档位

#### Scenario: 面板不直写会话权限

- **WHEN** 用户从面板完成一次成功切换
- **THEN** 会话权限投影中的档位与 sandbox 模式、审批策略三者互相自洽，任一项都未出现与目标预设不匹配的残留值

### Requirement: 完全权限的前置风险确认

用户选定 `danger-full-access` 时，面板 MUST 先进行一次风险确认，确认内容 MUST 说明该档位会使改页面与打开网站操作不再需要人工确认，且 MUST 明确该档位同时影响会话在 dsh 侧的文件与命令权限。

用户未完成确认时，面板 MUST NOT 发出切换请求。面板 MUST NOT 记住该确认：每次切到 `danger-full-access` 都必须重新确认。

#### Scenario: 未确认不切换

- **WHEN** 用户选定「完全权限」但在风险确认中取消
- **THEN** MUST NOT 发出切换请求，会话档位不变

#### Scenario: 每次都需要确认

- **WHEN** 用户曾确认过「完全权限」，随后切到「可操作」并再次选定「完全权限」
- **THEN** 面板再次要求风险确认，MUST NOT 因先前的确认而直接切换

#### Scenario: 确认文案覆盖两侧权限

- **WHEN** 风险确认出现
- **THEN** 文案同时说明「浏览器操作不再需要确认」与「会话在 dsh 侧的文件与命令权限一并放开」

### Requirement: 桥接不支持切换时的呈现

当桥接以「方法不存在」或「能力不可用」拒绝一次档位切换时，面板 SHALL 认定所连桥接进程不支持切换，MUST 停止继续提供切换入口，并 SHALL 给出**可执行**的说明（指出需在 dsh 中重载 bridge-dsh 插件），MUST NOT 只回显原始错误码。

该判定 SHALL 在每次连接建立时重新探测，使重载插件后无需重载扩展即可恢复。

#### Scenario: 桥接未重载时给出可执行说明

- **WHEN** 会话投影公布了档位，但桥接拒绝 `permission.set` 并返回方法不存在
- **THEN** 面板显示「需重载 dsh 插件」的说明，控件不再提供切换，且 MUST NOT 反复重试同一请求

#### Scenario: 重载插件后自动恢复

- **WHEN** 桥接已验证不支持切换，随后连接断开并重新建立（插件已重载）
- **THEN** 面板清除该判定并重新提供切换入口，MUST NOT 要求用户重载扩展

### Requirement: 与 dsh 侧档位变化的同步

面板显示的档位 MUST 完全由投影驱动，MUST NOT 依赖单一客户端的本地状态。当会话档位被面板自身、dsh 界面或其他客户端改动时，面板 SHALL 在收到该会话的状态更新后把控件更新为新档位。

面板在切换成功后的显示 MUST 与后续投影回流保持一致；两者冲突时以投影为准。

#### Scenario: dsh 界面改档位同步到面板

- **WHEN** 用户在 dsh 界面把会话 S 从 `workspace-write` 改为 `danger-full-access`
- **THEN** 面板的权限档位控件更新为「完全权限」，无需用户重新打开面板

#### Scenario: 面板改档位同步到 dsh 界面

- **WHEN** 用户在面板把会话 S 切到 `read-only` 且切换成功
- **THEN** dsh 界面上的会话权限显示为对应档位，两处呈现一致

#### Scenario: 面板外改动覆盖乐观更新

- **WHEN** 面板乐观显示目标档位后，投影回流的档位与目标不同
- **THEN** 控件最终显示投影的档位值
