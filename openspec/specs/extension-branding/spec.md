# extension-branding Specification

## Purpose

约束 dsh 浏览器扩展的品牌视觉资产:图标以仓库内单一目录为真相源,各尺寸构图一致且带透明通道,清单与侧边栏的引用指向真实存在的资产,README 首屏图形与仓库资产保持同步,构建产物可由源资产复现。

## Requirements

### Requirement: 品牌图标以仓库目录为唯一真相源

扩展的品牌图标资产 SHALL 存放于 `packages/extension/icons/`,并且 SHALL 同时提供 `icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`、`icon512.png` 五个位图尺寸。系统 MUST NOT 依赖 `dist/icons/` 或任何 `dist/` 下的副本作为真相源,因为 `dist/` 由 `.gitignore` 忽略、可随时重建。

#### Scenario: 图标资产目录内容完整

- **WHEN** 检出仓库并列出 `packages/extension/icons/` 目录内容
- **THEN** 该目录包含 `icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`、`icon512.png` 五个文件,且每个文件的像素尺寸与其文件名声明的尺寸一致(分别为 16×16、32×32、48×48、128×128、512×512)

#### Scenario: 品牌图形不残留在无引用资产中

- **WHEN** 检查 `packages/extension/icons/icon.svg`
- **THEN** 该文件描述的图形与同目录位图资产所呈现的品牌图形一致,不包含已被替换的旧图形

### Requirement: 各尺寸图标构图一致并保留透明通道

五个位图尺寸 SHALL 由同一源图形派生,任意两个尺寸之间的构图 SHALL 一致(相同内容、相同相对位置、相同留白比例),使开发者仅凭尺寸即可预测外观。每个位图文件 SHALL 为带 alpha 通道的 PNG,图形以外的背景 SHALL 为透明,MUST NOT 填充不透明白色底板。

#### Scenario: 新增尺寸时不出现构图漂移

- **WHEN** 从同一源图形新增一个此前不存在的尺寸(例如 256×256)
- **THEN** 新尺寸与既有尺寸并排显示时,图形主体占画布的比例与居中位置保持一致,不出现肉眼可辨的偏移或缩放差异

#### Scenario: 透明背景在深浅两种底色上均保留

- **WHEN** 把 `icon128.png` 分别合成到纯白背景与深灰背景上
- **THEN** 两种情况下图形以外的区域均显示为底色本身,即不存在不透明的白色矩形底板

### Requirement: 清单图标引用必须指向存在的资产

`packages/extension/manifest.json` 的 `icons` 与 `action.default_icon` 两处 SHALL 各自声明 `16`、`32`、`48`、`128` 四个尺寸,其路径 SHALL 指向 `packages/extension/icons/` 中真实存在的文件。系统 MUST NOT 在 `manifest.json` 中引用不存在的图标路径,否则 Chrome 会拒绝加载扩展或回退到默认占位图标。

#### Scenario: 清单引用的八个路径全部可解析

- **WHEN** 读取 `packages/extension/manifest.json` 并取出 `icons` 与 `action.default_icon` 的键值对(合计 8 个条目)
- **THEN** 每一条路径都能在 `packages/extension/` 下解析为存在的文件,且路径保持形如 `icons/iconNN.png` 的相对形式

#### Scenario: 扩展在刷新后使用新图标

- **WHEN** 变更图标源资产后执行 `bash packages/extension/build.sh`,并在 `chrome://extensions` 重新加载该扩展
- **THEN** 扩展管理页的扩展条目、Chrome 工具栏的扩展按钮、以及侧边栏标签三处均显示新品牌图形,不出现空白或默认占位图标

### Requirement: 侧边栏状态图标按 1:1 尺寸引用

`packages/extension/panel/index.html` 中的侧边栏状态图标 SHALL 以其声明尺寸对应的资产文件引用,使浏览器无需二次降采样即可显示。该元素 SHALL 保持可见尺寸为 16×16。

#### Scenario: 状态图标引用 16px 资产

- **WHEN** 检查 `packages/extension/panel/index.html` 中 `id="statusIcon"` 的 `<img>` 元素
- **THEN** 其 `src` 指向 `../icons/icon16.png`,`width` 与 `height` 属性均为 `16`

#### Scenario: 侧边栏状态图标正常渲染

- **WHEN** 打开扩展侧边栏,连接状态为 `stopped`、`connecting`、`reconnected` 中任一状态
- **THEN** 状态行最左侧显示新品牌图形,图形清晰且不出现请求失败导致的破图占位

### Requirement: README 首屏品牌图形与仓库资产同步

`README.md` 与 `README.zh.md` SHALL 各自在首屏展示同一品牌图形,且 `src` SHALL 指向仓库内的图标资产而非外部 URL。两份 README 的 `alt` 文案 SHALL 描述该图形所属的产品,并且 MUST NOT 继续使用已被替换的旧品牌名称。

#### Scenario: 两份 README 指向同一资产

- **WHEN** 提取 `README.md` 与 `README.zh.md` 首屏 `<img>` 的 `src`
- **THEN** 两个 `src` 相同,均指向 `packages/extension/icons/` 下的图标资产,且该路径在仓库中存在

#### Scenario: alt 文案不残留旧图形描述

- **WHEN** 检查 `README.md` 与 `README.zh.md` 首屏 `<img>` 的 `alt` 属性
- **THEN** 两个 `alt` 均对应本次变更后的品牌图形与产品名,不包含旧图形相关的措辞

### Requirement: 产品命名在本变更中保持稳定

本变更 SHALL NOT 修改产品命名。`manifest.json` 的 `name` 与 `action.default_title`、`packages/extension/package.json` 的 `name`、以及 `panel/index.html` 的 `<title>` SHALL 保持其既有取值不变。

#### Scenario: 命名相关字段未被视觉变更波及

- **WHEN** 对比本变更前后的 `manifest.json`、`packages/extension/package.json`、`packages/extension/panel/index.html`
- **THEN** `name`、`action.default_title` 与 `<title>` 的取值均未改变,`packages/extension/icons/` 内的新文件名亦未引入新的品牌命名

### Requirement: 图标资产可复现且体积受控

五个位图尺寸 SHALL 可由声明的源图形通过可复现的派生步骤重建,派生过程 MUST NOT 依赖网络下载或 npm registry。单个位图文件体积 SHOULD 控制在合理范围,`icon512.png` MUST NOT 超过 400 KB,以免 README 加载过重。

#### Scenario: 无网络环境下重跑派生

- **WHEN** 在无 npm registry 访问的环境中按记录的派生步骤重新生成全部五个尺寸
- **THEN** 生成过程不发起网络请求并成功产出五个文件,各文件像素尺寸正确且图形与提交版本一致

#### Scenario: 512px 资产体积在上限内

- **WHEN** 检查派生后的 `packages/extension/icons/icon512.png` 文件体积
- **THEN** 该体积不超过 400 KB
