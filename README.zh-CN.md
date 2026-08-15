# NarrativeLab

[English](./README.md) · [更新记录](./CHANGELOG.md) · [支持](./SUPPORT.md) · [安全](./SECURITY.md)

NarrativeLab 是用于规划、写作和维护叙事项目的 Obsidian 工作区。场景、结构、研究、资料库、表格和交互叙事画布都在同一项目界面中管理，项目内容仍以普通文件保存在库中。

## 主要功能

- 项目工作区：白板、文稿、结构、统计、笔记、研究和资料库。
- 场景管理：幕、章、次序、状态、视角、位置、角色、情节线、铺垫/兑现、自定义字段和模板。
- 结构工具：时间线、分轨对比、情节列表、地铁图、章节模板和节拍占位场景。
- 递归资料库：默认只有角色和地点；`Library/` 下新增、改名或删除直属子文件夹时，分类页签和 Obsidian Base 会同步更新。
- 档案页：可编辑分区、自定义字段、图库、引用、笔记，以及按分类保存的横式或竖式布局。
- 概念表格：内嵌 Univer，保存为 `Library/datasheet.xlsx`，支持格式、公式、筛选、行列尺寸、Markdown、HTML、Obsidian 双链和聚焦编辑。
- 叙事画布：编辑和试玩 `.ncanvas`，并可投影到 Obsidian 原生 Canvas。
- 系列管理：共享资料、项目本地资料、项目与系列转换，以及带回滚的迁移流程。
- 模板与导出：场景模板、叙事结构、项目预设，以及 Markdown、HTML、PDF、DOCX、项目包和 Scrivener 导入。
- 完整英文和简体中文界面。

## 使用要求

- Obsidian **1.12.7 或更高版本**。
- 支持桌面端和移动端。Scrivener 导入和系统文件夹选择器仅在桌面端可用。
- 概念表格可在移动端使用；大型表格更适合桌面窗口。

## 快速开始

1. 在 **设置 → 第三方插件** 中启用 NarrativeLab。
2. 从命令面板运行 **NarrativeLab：打开项目**，或点击 NarrativeLab ribbon 图标。
3. 选择 **新建项目**，填写名称和可选位置，然后打开项目。
4. 在白板或结构页创建场景。
5. 在资料库中新建角色和地点；需要新分类时，直接在项目 `Library/` 下创建直属子文件夹。
6. 需要节点式创作或试玩时，打开叙事画布。

多个项目可以同时保持打开，每个页签绑定各自项目，不会互相覆盖。

## 项目目录

项目可位于库内任意位置，NarrativeLab 通过项目 Markdown 清单的 frontmatter 识别项目。

```text
任意目录/
  项目名称/
    项目名称.md           # type: narrative-lab
    Canvas/
      corkboard.canvas
      项目名称.ncanvas
      项目名称.narrative.canvas
    Library/
      library.base
      datasheet.xlsx
      Characters/
      Locations/
      ...自定义分类
    Scenes/
    Notes/
    Research/
    System/
      Templates/
      library-categories.json
      library-profile-layout.json
```

旧的 `type: storyline` 清单和 `Codex/` 目录仍可读取。新项目使用 `type: narrative-lab` 和 `Library/`。资料库索引会忽略 Excalidraw Markdown 绘图。

## 资料库同步原则

项目文件夹是分类的来源。`Library/` 的直属子文件夹会成为分类页签；文件夹改名时分类和 Base 视图随之改名；确认删除文件夹后，对应分类也会移除。系列项目可同时显示系列共享资料与当前项目的本地资料，并通过完整路径边界防止其他项目的同名目录串入。

## 数据与隐私

- 不需要账户或付费，不包含广告、分析和遥测。
- 项目内容保存在库中；项目专用布局和结构状态位于项目的 `System/` 目录。
- 不下载或执行远程代码。
- 只有当文档包含远程图片并且用户主动要求渲染或导出时，才会请求该图片；不会上传库内文本。
- 桌面端 Scrivener 导入器只读取用户明确选择的 `.scriv` 目录，其他文件操作使用 Obsidian Vault API。
- 卸载插件不会删除 Markdown、资料库、画布、Base 或表格文件。

## 安装

从版本发布页下载版本一致的 `main.js`、`manifest.json` 和 `styles.css`，放到：

```text
<库目录>/.obsidian/plugins/narrative-lab/
```

重新加载 Obsidian 后启用插件。也可用 BRAT 安装测试版。

## 开发

```sh
git clone https://github.com/ringeringeraja33/NarrativeLab.git
cd NarrativeLab
npm ci
npm run check
```

社区安装所需的运行时代码全部位于 `main.js`，不依赖额外 JavaScript 文件。

## 许可

NarrativeLab 采用 **AGPL-3.0-only**。项目包含从 NarrativeCanvas（AGPL-3.0）和 obsidian-storyline（MIT）派生的代码，原始许可见 `LICENSE-NarrativeCanvas`、`LICENSE-Storyline` 和 `NOTICE.md`。
