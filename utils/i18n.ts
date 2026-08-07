import type { App } from 'obsidian';
import { MAIN_ZH } from './i18n-main.zh';
import { VIEWS_ZH } from './i18n-views.zh';
import { ENTITIES_ZH } from './i18n-entities.zh';
import { BEATS_ZH } from './i18n-beats.zh';
import { EXTRA_ZH } from './i18n-extra.zh';
import type { BeatSheetTemplate } from '../models/Scene';

export type UiLanguageSetting = 'auto' | 'en' | 'zh';
export type UiLanguage = 'en' | 'zh';

const ZH_CORE: Record<string, string> = {
    // Global navigation
    'Board': '白板',
    'Plotgrid': '表格',
    'Concept Grid': '表格',
    'Table': '表格',
    'Table view': '表视图',
    'List': '列表',
    'Cards': '卡片',
    'Load more': '加载更多',
    'Untitled': '未命名',
    'Save failed': '保存失败',
    'Timeline': '时间线',
    'Plotlines': '情节线',
    'Manuscript': '文稿',
    'Canvas': '画布',
    'Library': '资料库',
    'Stats': '统计',
    'Export': '导出',
    'Characters': '角色',
    'Locations': '地点',
    'Items': '物品',
    'Lore': '设定',
    'Research': '研究',
    'Notes': '笔记',
    'NarrativeLab projects': 'NarrativeLab 项目',
    'Open board view': '打开白板视图',
    'Open timeline view': '打开时间线视图',
    'Open plotgrid view': '打开表格',
    'Open concept grid view': '打开表格',
    'Open plotlines view': '打开情节线视图',
    'Open character view': '打开角色视图',
    'Open statistics dashboard': '打开统计面板',
    'Open location view': '打开地点视图',
    'Open Library': '打开资料库',
    'Create new scene': '新建场景',
    'Create new project': '新建项目',
    'Open or switch project': '打开或切换项目',
    'Fork current project': '复制当前项目',
    'Delete current project': '删除当前项目',
    'Export project': '导出项目',
    'Open converter': '打开转换器',
    'Converter': '转换器',
    'Converter / Export & Import': '转换器 / 导出与导入',
    'Manuscript export': '文稿导出',
    'Project bundle': '项目包',
    'Plotlines to Canvas': '情节线 → 画布',
    'Export or import a full text asset pack: scenes, library, notes, research, System JSON, and ncanvas files. Attachments are not included.': '导出或导入完整文本资产包：场景、资料库、笔记、研究、System JSON 与 ncanvas。不包含附件二进制。',
    'Export project bundle': '导出项目包',
    'Writes a JSON pack under the project Exports folder.': '将 JSON 包写入项目的 Exports 文件夹。',
    'Export bundle': '导出项目包',
    'Import project bundle into current project': '导入项目包到当前项目',
    'Overwrites matching relative paths in the active project.': '按相对路径覆盖当前项目中的对应文件。',
    'Import into current…': '导入到当前…',
    'Import bundle into current project?': '将项目包导入当前项目？',
    'Files in the bundle will overwrite the same relative paths under this project.': '包内文件会按相同相对路径覆盖本项目中的文件。',
    'Import project bundle as new project': '导入项目包为新项目',
    'Creates a new project folder and loads the bundle into it.': '新建项目文件夹并载入包内文件。',
    'Import as new…': '导入为新项目…',
    'Import Scrivener…': '导入 Scrivener…',
    'Search for a project bundle JSON…': '搜索项目包 JSON…',
    'Not a NarrativeLab project bundle.': '不是 NarrativeLab 项目包。',
    'Bundle is missing file entries.': '项目包缺少文件条目。',
    'Project bundle written: {path}': '已写入项目包：{path}',
    'Project bundle written: {path} ({n} files)': '已写入项目包：{path}（{n} 个文件）',
    'Imported {n} files into the current project.': '已向当前项目导入 {n} 个文件。',
    'Created project and imported {n} files: {path}': '已创建项目并导入 {n} 个文件：{path}',
    'Each selected plotline becomes a Location Frame; each scene becomes a fillable Story Sequence with a link to its note.': '每条勾选的情节线会成为 Location Frame；每个场景会成为可填写的 Story Sequence，并链接到对应笔记。',
    'No plotlines in this project yet.': '当前项目还没有情节线。',
    'Select all': '全选',
    'Select none': '全不选',
    'Write mode': '写入方式',
    'Create new ncanvas': '新建 ncanvas',
    'Overwrite existing ncanvas': '覆盖已有 ncanvas',
    'Plotlines Canvas': '情节线画布',
    'Target ncanvas': '目标 ncanvas',
    'No .ncanvas files yet. Create one or choose “Create new ncanvas”.': '还没有 ncanvas 文件。请新建，或改选「新建 ncanvas」。',
    'Generate Canvas': '生成画布',
    'Generating…': '生成中…',
    'Select at least one plotline.': '请至少选择一条情节线。',
    'Choose an ncanvas file to overwrite.': '请选择要覆盖的 ncanvas 文件。',
    'Overwrite ncanvas?': '覆盖 ncanvas？',
    '“{name}” will be replaced entirely with plotline frames.': '「{name}」将被情节线画框完整替换。',
    'Wrote plotline canvas: {name}': '已写入情节线画布：{name}',
    'From plotlines': '从情节线',
    'Turn selected NarrativeLab plotlines into Location Frames and fillable Story Sequences.': '将选定的 NarrativeLab 情节线转为 Location Frame 与可填写的 Story Sequence。',
    'Generate from plotlines…': '从情节线生成…',
    'To fill — scene beats / dialog / outcomes.': '待填 — 节拍 / 对白 / 结果。',
    'To fill — add a scene to this plotline in NarrativeLab.': '待填 — 请先在 NarrativeLab 为该情节线添加场景。',
    'Plotline workspace — fill region / mood as needed.': '情节线工作区 — 可按需填写区域 / 氛围。',
    'Plotline frames generated from NarrativeLab.': '由 NarrativeLab 情节线生成的画框。',
    'Generated from NarrativeLab plotlines. Frames are ready to fill.': '由 NarrativeLab 情节线生成。画框待填写。',
    'Next plotline': '下一条情节线',
    'Begin': '开始',
    'Outline (metadata, stats, table)': '大纲（元数据、统计、表格）',
    'Manuscript (scene text in order)': '文稿（按序场景正文）',
    'Markdown (.md)': 'Markdown (.md)',
    'Word (.docx)': 'Word (.docx)',
    'PDF (.pdf)': 'PDF (.pdf)',
    'HTML (.html)': 'HTML (.html)',
    'CSV (.csv)': 'CSV (.csv)',
    'JSON (.json)': 'JSON (.json)',
    'Confirm': '确认',
    'Scene {n}': '场景 {n}',
    'Project: {title}': '项目：{title}',
    'Open help': '打开帮助',
    'Open navigator': '打开导航器',
    'Drafts': '草稿',
    'New draft': '新建草稿',
    'Rename draft': '重命名草稿',
    'Delete draft': '删除草稿',
    'Set as active draft': '设为当前草稿',
    'Keep at least one draft': '至少保留一个草稿',
    'Create new series from current project': '从当前项目创建系列',
    'Add current project to existing series': '将当前项目加入现有系列',
    'Remove current project from series': '将当前项目移出系列',
    'Rename current project': '重命名当前项目',

    // Global language
    'Interface language': '界面语言',
    "Choose the language used throughout NarrativeLab and Narrative Canvas. Auto follows Obsidian's interface language.": '选择 NarrativeLab 与 Narrative Canvas 共用的界面语言。自动会跟随 Obsidian 的界面语言。项目文件夹名与本地实体内容保持原文，不会翻译。',
    'Auto (follow Obsidian)': '自动（跟随 Obsidian）',
    'English': 'English',
    'Chinese': '中文',
    'Interface theme': '界面主题',
    'Follows Obsidian by default. Choose Light or Dark to override for this project and Narrative Canvas.': '默认跟随 Obsidian。如需覆盖，可为当前项目与 Narrative Canvas 选择浅色或深色。',
    'Light': '浅色',
    'Dark': '深色',

    // Project launcher
    'Open NarrativeLab Project': '打开 NarrativeLab 项目',
    'Select a project to load, or create a new one.': '选择要打开的项目，或创建新项目。',
    'Open Board': '打开白板',
    'Open Project': '打开项目',
    'Open Canvas': '打开画布试玩',
    'Playmode in Canvas': '画布试玩',
    'Choose, create, or open an ncanvas for this project': '为此项目选择、新建或打开 ncanvas',
    'New Project': '新建项目',
    'Manage Series…': '管理系列…',
    'Browse Project…': '浏览项目…',
    'Open ncanvas…': '打开 ncanvas…',
    'Manage NCanvas files': '管理画布文件',
    'Manage Canvas files': '管理画布文件',
    'Open Narrative Canvas (last used)': '打开 Narrative Canvas（上次使用）',
    'NCanvas files': '画布文件',
    'Canvas files': '画布文件',
    'Manage .ncanvas files for this project. Stored in {folder}.': '管理本项目的 .ncanvas 文件，保存在 {folder}。',
    'New ncanvas': '新建 ncanvas',
    'File name': '文件名',
    'Creates a blank canvas in this project’s NCanvas folder.': '在本项目的 Canvas 文件夹中创建空白画布。',
    'Creates a blank canvas in this project’s Canvas folder.': '在本项目的 Canvas 文件夹中创建空白画布。',
    'Untitled Canvas': '未命名画布',
    'Guide samples': '上手示例',
    'Generate the built-in Narrative Canvas walkthrough into this project.': '将内置 Narrative Canvas 上手导览生成到本项目。',
    'Sample (Chinese)': '示例（中文）',
    'Sample (English)': '示例（English）',
    'No .ncanvas files yet. Create one or generate a sample below.': '还没有 .ncanvas 文件。可在下方新建，或生成示例。',
    'Current': '当前',
    'Open': '打开',
    'Created ncanvas: {name}': '已创建 ncanvas：{name}',
    'Opened sample ncanvas: {name}': '已打开示例 ncanvas：{name}',
    'Failed to create ncanvas: {err}': '创建 ncanvas 失败：{err}',
    'Failed to create sample ncanvas: {err}': '创建示例 ncanvas 失败：{err}',
    'Cancel': '取消',
    'No project selected': '未选择项目',
    'No projects found.': '未找到项目。',
    'Only one project exists.': '当前只有一个项目。',

    // Project and series modals
    'Create New Project': '新建项目',
    'Project title': '项目标题',
    'The title of this project. Each project gets its own workspace folder.': '项目名称。每个项目都有独立的工作区文件夹。',
    'Location': '位置',
    'Create': '创建',
    'Series name': '系列名称',
    'Create as series': '创建为系列',
    'Manage Series': '管理系列',
    'No series found. Create a series from the new project modal or use the command palette.': '未找到系列。可在新建项目窗口或命令面板中创建系列。',
    'Add project to this series': '向此系列添加项目',
    'Rename Series': '重命名系列',
    'Rename Project': '重命名项目',
    'Remove from Series': '移出系列',
    'Add to Series': '添加到系列',
    'Delete': '删除',
    'Rename': '重命名',
    'New title': '新标题',
    'Confirm by typing the project title': '输入项目标题以确认',

    // Common controls
    'Add': '添加',
    'Edit': '编辑',
    'Remove': '移除',
    'Save': '保存',
    'Close': '关闭',
    'Search': '搜索',
    'Filter': '筛选',
    'Sort by': '排序',
    'Name': '名称',
    'Created': '创建时间',
    'Modified': '修改时间',
    'All': '全部',
    'None': '无',
    'Default': '默认',
    'Enabled': '已启用',
    'Disabled': '已禁用',
    'Settings': '设置',
    'Reset': '重置',
    'Apply': '应用',
    'Import': '导入',
    'Select': '选择',
    'Browse': '浏览',
    'Character Profiles': '角色档案',
    'Location Profiles': '地点档案',
    'Move up': '上移',
    'Move down': '下移',

    // Main views
    'Grid': '网格',
    'Map': '地图',
    'Story Graph': '故事图谱',
    'Search characters...': '搜索角色…',
    'Search locations...': '搜索地点…',
    'Search Library...': '搜索资料库…',
    'All projects': '所有项目',
    'No scenes yet': '暂无场景',
    'No characters found': '未找到角色',
    'No locations found': '未找到地点',
    'No Library entries found': '未找到资料条目',
    'Appears In (Projects)': '出现于（项目）',
    '+ Add project': '+ 添加项目',

    // Settings: project and display
    'Default new-project folder': '新项目默认文件夹',
    'Optional. Existing NarrativeLab projects are discovered anywhere in the vault.': '可选。现有 NarrativeLab 项目会在整个仓库中自动发现。',
    'Vault root': '仓库根目录',
    'Project attachment folder': '项目附件文件夹',
    'Folder inside each project where imported images and attachments are saved. Default: Attachments (e.g. MyProject/Attachments/).': '每个项目中保存导入图片与附件的文件夹。默认：Attachments（例如 MyProject/Attachments/）。',
    'Folder inside each project for scene and general attachments (default: Attachments). Library card images are stored under Library/<category>/Attachments instead.': '每个项目中用于场景与通用附件的文件夹（默认：Attachments）。资料库卡片图片保存在 Library/<分类>/Attachments。',
    'Attachments': 'Attachments',
    'Auto-open Navigator': '自动打开导航器',
    'Automatically open the NarrativeLab Navigator sidebar when a project loads': '加载项目时自动打开 NarrativeLab 导航侧栏。',
    'Automatically open the NarrativeLab Navigator in the left sidebar when the plugin starts or a project loads': '插件启动或加载项目时，自动在左侧边栏打开 NarrativeLab 导航器。',
    'General': '通用',
    'Scenes': '场景',
    'Templates': '模板',
    'Writing': '写作',
    'Export & Advanced': '导出与高级',
    'Hide frontmatter': '隐藏属性区',
    'Properties on NarrativeLab notes': 'NarrativeLab 笔记中的属性',
    'Controls the Obsidian Properties block on notes inside NarrativeLab projects only. Your global Obsidian "Properties in document" setting is left untouched.': '仅控制 NarrativeLab 项目内笔记的 Obsidian 属性区块。Obsidian 全局的「文档中的属性」设置不会改变。',
    'Folded (show header)': '折叠（保留标题）',
    'Hidden': '完全隐藏',
    'Expanded': '展开显示',
    'Default project language': '默认项目内容语言',
    'Rename project': '重命名项目',
    'Create series from this project': '从当前项目创建系列',
    'Manage series': '管理系列',
    'View, rename, and reorder projects in your series.': '查看、重命名及调整系列中的项目顺序。',
    'Default view': '默认视图',
    'Show word counts': '显示字数',
    'Compact card view': '紧凑卡片视图',
    'Color scheme': '配色方案',
    'Custom': '自定义',
    'Auto-save': '自动保存',
    'Spell check': '拼写检查',

    // Settings: general and scene defaults
    'Hide the properties/frontmatter block on NarrativeLab notes only (live preview and reading mode). Since all fields are editable from the Inspector, frontmatter can safely be hidden. Your global Obsidian "Properties in document" setting is left untouched.': '仅隐藏 NarrativeLab 笔记中的属性/前置元数据区块（实时预览和阅读模式）。所有字段都可在检查器中编辑，因此可以放心隐藏前置元数据。Obsidian 全局的“文档中的属性”设置不会改变。',
    'Collapse view-tab labels when toolbar is narrow': '工具栏较窄时折叠视图标签文字',
    'When the NarrativeLab toolbar is too narrow to fit every view-tab label, show only the icon (Corkboard, Timeline, etc.). Disable to always show both icon and text — the labels will wrap or be clipped if the toolbar is small.': '当 NarrativeLab 工具栏过窄，无法容纳所有视图标签文字时，仅显示图标（平铺画布、时间线等）。关闭后将始终同时显示图标和文字；工具栏较小时，标签可能换行或被截断。',
    'Scene Defaults': '场景默认设置',
    'Default status': '默认状态',
    'Status for newly created scenes': '新建场景的默认状态',
    'Idea': '构思',
    'Outlined': '已列提纲',
    'Draft': '草稿',
    'Written': '已写完',
    'Revised': '已修订',
    'Final': '定稿',
    'Auto-generate sequence': '自动生成序号',
    'Automatically assign sequence numbers to new scenes': '自动为新建场景分配序号',
    'Target word count': '目标字数',
    'Default target word count per scene': '每个场景的默认目标字数',
    'Custom Statuses': '自定义状态',
    'Add custom scene statuses after the built-in six (Idea → Final). Useful for editorial workflows like "Sent to Team", "Waiting", "Published", etc.': '在六个内置状态（构思 → 定稿）之后添加自定义场景状态。适用于“已发送给团队”“等待中”“已发布”等编辑工作流程。',
    'No custom statuses defined.': '尚未定义自定义状态。',
    'Label': '标签',
    'Counts as written': '计入已写内容',
    'Add custom status': '添加自定义状态',
    'Enter a name for the new status (e.g. "Sent to Team")': '输入新状态的名称（例如“已发送给团队”）',
    'Status name…': '状态名称…',

    // Settings: display and image sizes
    'Display': '显示',
    'Which view to open by default': '默认打开的视图',
    'Statistics': '统计',
    'Default Board mode': '默认白板模式',
    'Which sub-view opens first inside Board': '进入白板时首先打开的子视图',
    'Corkboard': '平铺画布',
    'Kanban': '列式白板',
    'Color coding': '颜色编码',
    'How to color-code scene cards': '场景卡片的颜色编码方式',
    'By Status': '按状态',
    'By POV Character': '按视角角色',
    'By Emotion': '按情绪',
    'By Act': '按幕',
    'By Tag / Plotline': '按标签/情节线',
    'Show notes in Kanban': '在列式白板中显示笔记',
    'When enabled, corkboard notes are also visible in Kanban columns': '启用后，平铺画布笔记也会显示在列式白板的各列中',
    'Show scenes in Corkboard': '在平铺画布中显示场景',
    'When enabled, scene cards are visible on the corkboard alongside notes': '启用后，场景卡片会与笔记一起显示在平铺画布中',
    'Display word counts on scene cards': '在场景卡片上显示字数',
    'Exclude Arc Points from word count': '从字数统计中排除弧线节点',
    'When enabled, scenes marked as Arc Points are excluded from aggregate word counts in Stats and the Manuscript footer': '启用后，标记为弧线节点的场景不会计入统计视图和文稿页脚的汇总字数',
    'Show scene number on cards': '在卡片上显示场景编号',
    'Display the sequence number badge in the card header': '在卡片标题栏中显示序号徽标',
    'Show less detail on scene cards': '减少场景卡片上显示的详细信息',
    'Scene card preview text': '场景卡片预览文本',
    'Show a short preview beneath each scene card title': '在每张场景卡片标题下显示简短预览',
    'Synopsis': '梗概',
    'First lines of draft': '草稿开头几行',
    'Conflict': '冲突',
    'Formatting toolbar': '格式工具栏',
    'Show a formatting toolbar in scene editors when the Editing Toolbar plugin is not installed': '未安装 Editing Toolbar 插件时，在场景编辑器中显示格式工具栏',
    'Image & frame sizes': '图片与边框尺寸',
    'Character card portrait size': '角色卡片头像尺寸',
    'Size in px for the circular portrait on character cards (default 64).': '角色卡片上圆形头像的尺寸（像素，默认 64）。',
    'Character detail portrait size': '角色详情头像尺寸',
    'Size in px for the large character portrait in detail view (default 96).': '角色详情视图中大头像的尺寸（像素，默认 96）。',
    'Location tree thumbnail size': '地点树缩略图尺寸',
    'Size in px for location/world thumbnails in the tree (default 20).': '树中地点/世界缩略图的尺寸（像素，默认 20）。',
    'Location detail image width': '地点详情图片宽度',
    'Width in px for location detail image frame (default 120).': '地点详情图片边框的宽度（像素，默认 120）。',
    'Location detail image height': '地点详情图片高度',
    'Height in px for location detail image frame (default 80).': '地点详情图片边框的高度（像素，默认 80）。',
    'Reset image sizes': '重置图片尺寸',
    'Restore all image/frame sizes to default values.': '将所有图片/边框尺寸恢复为默认值。',
    'Reset to defaults': '恢复默认值',

    // Settings: locations, writing, and focus
    'Custom Location Types': '自定义地点类型',
    'Add your own location types (e.g. Planet, Star System, Galaxy, Dimension) — they appear in the Type dropdown alongside the built-in options.': '添加自己的地点类型（例如行星、恒星系统、星系、维度）；它们会与内置选项一起出现在“类型”下拉菜单中。',
    'Add new type': '添加新类型',
    'e.g. Planet': '例如：行星',
    'Writing Goals': '写作目标',
    'Daily word goal': '每日字数目标',
    'Target number of words per day (shown in Stats view)': '每日目标字数（显示在统计视图中）',
    'Weekly word goal': '每周字数目标',
    'Target number of words per week (Monday → today, shown in Stats view)': '每周目标字数（周一至今天，显示在统计视图中）',
    'Monthly word goal': '每月字数目标',
    'Target number of words for the current calendar month (shown in Stats view)': '当前自然月的目标字数（显示在统计视图中）',
    'Project word goal': '项目字数目标',
    'Target total words for the active project (shown in Stats view)': '当前项目的总目标字数（显示在统计视图中）',
    'Sprint end sound': '冲刺结束提示音',
    'Play a chime when the writing sprint timer reaches zero': '写作冲刺计时器归零时播放提示音',
    'Write scene references as wikilinks': '将场景引用写为 Wiki 链接',
    'Issue #73 — when on, scene fields like POV, location, characters, setup_scenes and payoff_scenes are stored as Obsidian [[wikilinks]] so they auto-update on rename. Existing plain-text values keep working.': '问题 #73 — 启用后，POV、location、characters、setup_scenes 和 payoff_scenes 等场景字段会存储为 Obsidian [[Wiki 链接]]，以便重命名时自动更新。现有纯文本值仍然有效。',
    'Mirror custom fields to top-level YAML': '将自定义字段镜像到顶层 YAML',
    'Issue #71 — when on, Universal Field values are also written as top-level YAML keys (using each template\'s "Top-level key") so they show up in Obsidian Properties, Bases, and Dataview. Reserved NarrativeLab keys are skipped automatically.': '问题 #71 — 启用后，通用字段值还会写入顶层 YAML 键（使用各模板的“顶层键”），以便显示在 Obsidian 属性、Bases 和 Dataview 中。NarrativeLab 保留键会自动跳过。',
    'Count unit for scene lengths': '场景长度计数单位',
    'Choose whether scene cards, the Timeline, and the Inspector display scene length in words or characters. Useful for prose writers who track length in characters (e.g. Russian, Chinese, Japanese).': '选择场景卡片、时间线和检查器以字数还是字符数显示场景长度。适合以字符数追踪篇幅的散文作者（例如俄语、中文、日语作者）。',
    'Words': '字数',
    'Exclude `%%comments%%` from wordcount': '字数统计中排除 `%%注释%%`',
    'Issue #78 — strip Obsidian comment blocks (anything between `%%` markers) before counting words. Keeps `wordcount` aligned with what readers will actually see.': '问题 #78 — 统计字数前移除 Obsidian 注释区块（`%%` 标记之间的所有内容），使 `wordcount` 与读者实际看到的内容一致。',
    'Also ignore checkbox lines (`- [ ]`, `- [x]`)': '同时忽略复选框行（`- [ ]`、`- [x]`）',
    'Issue #78 — also drop markdown task lines from the wordcount. Off by default because some authors keep checklists in the manuscript body.': '问题 #78 — 同时从字数统计中排除 Markdown 任务行。默认关闭，因为有些作者会在文稿正文中保留核对清单。',
    'BCP-47 tag used for word counting, reading time, dialogue %, stop-word filtering and PDF line wrapping. Choose Auto-detect to infer the script from manuscript text. Existing projects that still use the old default are updated too; otherwise set per-project by editing `language:` in the project frontmatter.': '用于字数统计、阅读时间、对话占比、停用词过滤和 PDF 换行的 BCP-47 标签。选择“从文本自动检测”可根据文稿文本推断文字系统。仍使用旧默认值的现有项目也会更新；否则可编辑项目前置元数据中的 `language:`，为每个项目单独设置。',
    'Auto-detect from text': '从文本自动检测',
    'Default scene frontmatter': '默认场景前置元数据',
    'Issue #77 — raw YAML merged into the frontmatter of every newly-created scene. Useful for companion plugins (e.g. `cssclasses: [fountain]`). NarrativeLab\'s own keys (type, title, act, chapter, sequence, status…) always win on conflict.': '问题 #77 — 将原始 YAML 合并到每个新建场景的前置元数据中。适用于配套插件（例如 `cssclasses: [fountain]`）。发生冲突时，NarrativeLab 自有键（type、title、act、chapter、sequence、status…）始终优先。',
    'Focus Mode Settings': '专注模式设置',
    'Control how the UI changes when Focus mode is enabled in Manuscript view.': '控制在文稿视图中启用专注模式时界面的变化。',
    'Darken': '变暗',
    'Darken the entire Obsidian UI (higher = darker overlay)': '调暗整个 Obsidian 界面（数值越高，遮罩越暗）',
    'Blur': '模糊',
    'Blur everything outside the active text area (px)': '模糊活动文本区域以外的所有内容（像素）',
    'Timeline Drag-Scroll': '时间线拖动滚动',
    'Scroll speed': '滚动速度',
    'Pixels scrolled per animation frame while dragging near the edge (1–30).': '拖动到边缘附近时，每个动画帧滚动的像素数（1–30）。',
    'Scroll zone': '滚动触发区域',
    'Pixel distance from the viewport edge where drag-scrolling activates (20–200).': '触发拖动滚动的区域距视口边缘的像素数（20–200）。',

    // Settings: plotline and sticky-note colors
    'Colors': '颜色',
    'Plotline Color Scheme': '情节线配色方案',
    'Use project-specific colors': '使用项目专属颜色',
    'Moods': '氛围',
    'Pastel on light': '浅色背景上的粉彩',
    'Soft on mid-dark': '中深色背景上的柔和色',
    'Muted on dark': '深色背景上的低饱和色',
    'Pastel on darkest': '最深色背景上的粉彩',
    'Fresh & floral': '清新花卉',
    'Warm & golden': '温暖金色',
    'Vivid & bold': '鲜明醒目',
    'Warm & moody': '温暖深沉',
    'Deep & mysterious': '深邃神秘',
    'Earthy & harvest': '大地丰收',
    'Aquatic blues': '水系蓝调',
    'Woodland greens': '林地绿调',
    'Fiery & dramatic': '炽烈戏剧',
    'Icy & crisp': '冰冷清冽',
    'Muted & nostalgic': '柔和怀旧',
    'Electric & vivid': '电光鲜亮',
    'Manual per-tag': '按标签手动设置',
    'Colors are auto-assigned to plotline tags. To override a specific tag color, use the color picker in the Plotlines view.': '颜色会自动分配给情节线标签。如需覆盖某个标签的颜色，请使用情节线视图中的颜色选择器。',
    'Global Adjustments': '全局调整',
    'Hue shift': '色相偏移',
    'Saturation': '饱和度',
    'Lightness': '明度',
    'Reset adjustments': '重置调整',
    'Custom overrides': '自定义覆盖',
    'Clear all': '全部清除',
    'Sticky Note Colors': '便签颜色',
    'No tags found. Create scenes with tags to assign colors here.': '未找到标签。请创建带标签的场景，然后在此分配颜色。',
    'Colors are auto-assigned from the selected scheme. Use the color picker to override individual tags.': '颜色会从所选方案中自动分配。可使用颜色选择器覆盖单个标签的颜色。',
    'No color assigned': '未分配颜色',
    'Remove custom override': '移除自定义覆盖',
    'Theme': '主题',
    'Classic': '经典',
    'Pastel': '粉彩',
    'Warm': '暖色',
    'Cool': '冷色',
    'Earth': '大地',
    'Vivid': '鲜艳',
    'Clean, balanced pastels': '清爽均衡的粉彩',
    'Very light & airy': '极浅而轻盈',
    'Soft sunny pastels': '柔和明亮的粉彩',
    'Clear cool pastels': '清透冷调的粉彩',
    'Light natural pastels': '浅淡自然的粉彩',
    'Fresh, colourful pastels': '清新多彩的粉彩',
    'Yellow': '黄色',
    'Gold': '金色',
    'Orange': '橙色',
    'Coral': '珊瑚色',
    'Pink': '粉色',
    'Rose': '玫瑰色',
    'Lavender': '薰衣草色',
    'Violet': '紫罗兰色',
    'Blue': '蓝色',
    'Sky': '天蓝色',
    'Teal': '蓝绿色',
    'Mint': '薄荷色',
    'Green': '绿色',
    'Sage': '鼠尾草色',
    'Preview & Individual Overrides': '预览与单项覆盖',
    'Click a swatch to override that colour. Right-click to reset it. Sliders tint all 14 colours at once.': '单击色块可覆盖该颜色，右键单击可重置。滑块会同时调整全部 14 种颜色。',
    'Clear all colour overrides': '清除所有颜色覆盖',

    // Settings: project, templates, and custom fields
    'Project Management': '项目管理',
    'No active project': '无当前项目',
    'Rename…': '重命名…',
    'Rename Library tab': '重命名资料库页签',
    'Tab name matches the Library folder name.': '页签名称与 Library 子文件夹名称一致。',
    'Invalid folder name': '无效的文件夹名称',
    'A folder with this name already exists': '已存在同名文件夹',
    'Toggle categories to show in the Library. Tab names match Library folder names — right-click a tab to rename.': '切换要在资料库中显示的类别。页签名与 Library 子文件夹名一致 — 右键页签可改名。',
    'This project already belongs to a series.': '此项目已属于一个系列。',
    'Wrap the current project in a new series.': '将当前项目纳入一个新系列。',
    'Create Series…': '创建系列…',
    'Scene Templates': '场景模板',
    'Custom templates pre-fill fields and body text when creating new scenes. Built-in templates are always available.': '创建新场景时，自定义模板会预先填充字段和正文文本。内置模板始终可用。',
    'Create and manage multiple scene templates. Each template can pre-fill scene fields and insert reusable Markdown into the new scene.': '创建并管理多个场景模板。每个模板都可以预填场景字段，并在新场景中插入可复用的 Markdown 正文。',
    'Create a template': '创建模板',
    'Custom templates appear immediately in the Template dropdown when creating a scene.': '自定义模板会立即出现在新建场景时的“模板”下拉菜单中。',
    'Add Template': '添加模板',
    'Custom Scene Fields': '自定义场景字段',
    'Define your own metadata fields that appear on every scene’s Inspector. Useful for Story Grid functions, Truby aspects, beat-sheet labels, genre conventions, and any other scene tagging your method requires. Dropdown and multi-select fields can also be used to filter and group scenes on the Board.': '定义显示在每个场景检查器中的自有元数据字段。适用于 Story Grid 功能、Truby 要素、节拍表标签、类型惯例，以及您的创作方法所需的其他场景标记。下拉和多选字段还可用于在白板中筛选和分组场景。',
    'Add Scene Field': '添加场景字段',
    'No custom templates yet. Built-in templates (Blank, Action Scene, Dialogue Scene, Flashback, Opening Chapter) are always available.': '尚无自定义模板。内置模板（空白、动作场景、对话场景、闪回、开篇章节）始终可用。',
    '(none)': '（无）',
    'Blank': '空白',
    'Action Scene': '动作场景',
    'Dialogue Scene': '对话场景',
    'Flashback': '闪回',
    'Opening Chapter': '开篇章节',
    'Empty scene — no pre-filled body': '空白场景 — 不预填正文',
    'Goal / Conflict / Outcome structure': '目标 / 冲突 / 结果结构',
    'Character conversation with emotional stakes': '带情感张力的角色对话',
    'Past event revealed to the reader': '向读者揭示的过去事件',
    'Hook, world, and character introduction': '钩子、世界观与角色引入',
    '(unnamed)': '（未命名）',
    'Edit template': '编辑模板',
    'Delete template': '删除模板',
    'Open a project first to manage scene custom fields (templates are stored per project).': '请先打开项目，再管理场景自定义字段（模板按项目存储）。',
    'No custom scene fields yet. Click "Add Scene Field" to create one.': '尚无自定义场景字段。单击“添加场景字段”即可创建。',
    'Multi-select': '多选',
    'Dropdown': '下拉选项',
    'Text': '文本',
    'Textarea': '多行文本',
    'Number': '数字',
    'Date': '日期',
    'Checkbox': '复选框',
    'Edit field': '编辑字段',
    'Delete field': '删除字段',

    // Settings: export and import
    'Export & Import': '导出与导入',
    'Scene separator': '场景分隔符',
    'Separator used between scenes in manuscript exports (Markdown, Word, PDF, and HTML).': '导出文稿（Markdown、Word、PDF 和 HTML）时用于分隔场景的符号。',
    'Blank Line': '空行',
    'Custom Separator': '自定义分隔符',
    'Custom separator': '自定义分隔符',
    'Enter any UTF-8 character or text to use as a scene separator.': '输入任意 UTF-8 字符或文本作为场景分隔符。',
    'e.g. ~ ~ ~': '例如：~ ~ ~',
    'DOCX Export Settings': 'DOCX 导出设置',
    'Configure Word (.docx) export behavior. These settings apply when exporting via the Export dialog.': '配置 Word（.docx）导出行为。这些设置会在通过“导出”对话框导出时生效。',
    'Default font family': '默认字体系列',
    'Font used in the exported document (e.g. Calibri, Times New Roman, Arial).': '导出文档中使用的字体（例如 Calibri、Times New Roman、Arial）。',
    'Default font size': '默认字号',
    'Base font size in half-points (e.g. 24 = 12pt, 28 = 14pt).': '基本字号，以半磅为单位（例如 24 = 12 磅，28 = 14 磅）。',
    'Include metadata': '包含元数据',
    'When enabled, YAML frontmatter is included in the exported document. Disabled by default.': '启用后，导出文档中会包含 YAML 前置元数据。默认关闭。',
    'Preserve formatting': '保留格式',
    'Maintain original Markdown formatting in the output (bold, italic, code, etc.).': '在输出中保留原始 Markdown 格式（粗体、斜体、代码等）。',
    'Enable preprocessing': '启用预处理',
    'Preprocess Markdown before conversion (normalise line-breaks, clean up).': '转换前预处理 Markdown（规范换行并清理内容）。',
    'Use Obsidian appearance': '使用 Obsidian 外观',
    'Detect and apply the current Obsidian theme font settings to the document.': '检测当前 Obsidian 主题的字体设置并应用到文档。',
    'Include filename as header': '将文件名作为标题',
    'Add the note filename as a heading at the top of the exported document.': '在导出文档顶部添加笔记文件名作为标题。',
    'Page size': '页面尺寸',
    'Paper size for the exported document.': '导出文档的纸张尺寸。',
    'Letter': '信纸',
    'Legal': '法律用纸',
    'Tabloid': '小报纸',
    'Chunking threshold': '分块阈值',
    'Number of elements before chunked processing kicks in (for large documents). Default: 500.': '开始分块处理前的元素数量（用于大型文档）。默认：500。',
    'PDF Export Settings': 'PDF 导出设置',
    'Configure PDF export behavior. Uses pdf-lib for cross-platform generation (works on mobile).': '配置 PDF 导出行为。使用 pdf-lib 进行跨平台生成（支持移动端）。',
    'Font family': '字体系列',
    'Standard PDF font to use in the exported document.': '导出文档中使用的标准 PDF 字体。',
    'Helvetica (sans-serif)': 'Helvetica（无衬线）',
    'Times Roman (serif)': 'Times Roman（衬线）',
    'Courier (monospace)': 'Courier（等宽）',
    'Font size': '字号',
    'Base body font size in points (e.g. 11, 12).': '正文基本字号，以磅为单位（例如 11、12）。',
    'Paper size for the exported PDF.': '导出 PDF 的纸张尺寸。',
    'Line spacing': '行距',
    'Line height multiplier (1.0 = single, 1.5, 2.0 = double).': '行高倍数（1.0 = 单倍，1.5，2.0 = 双倍）。',
    'Margins (pt)': '页边距（磅）',
    'Top / Bottom / Left / Right margins in points. 72pt = 1 inch.': '上/下/左/右页边距，以磅为单位。72 磅 = 1 英寸。',
    'When enabled, YAML frontmatter is included in the exported PDF. Disabled by default.': '启用后，导出的 PDF 中会包含 YAML 前置元数据。默认关闭。',
    'Include page numbers': '包含页码',
    'Show centered page numbers at the bottom of each page.': '在每页底部居中显示页码。',
    'Import a Scrivener project (.scriv folder) as a new NarrativeLab project. Converts scenes, characters, locations, and research notes. Desktop only.': '将 Scrivener 项目（.scriv 文件夹）导入为新的 NarrativeLab 项目。会转换场景、角色、地点和研究笔记。仅限桌面端。',
    'Import scrivener project': '导入 Scrivener 项目',
    'Import Scrivener project': '导入 Scrivener 项目',
    'Select a .scriv folder to import.': '选择要导入的 .scriv 文件夹。',
    'Import .scriv': '导入 .scriv',

    // Settings: advanced and source folders
    'Advanced': '高级',
    'Enable plot hole detection': '启用情节漏洞检测',
    'Show warnings for potential plot holes': '显示潜在情节漏洞的警告',
    'Show warnings': '显示警告',
    'Display warning notifications': '显示警告通知',
    'Additional Source Folders (Experimental)': '其他源文件夹（实验性）',
    '⚠ Experimental — back up your files before linking external folders. Files in linked folders may be modified when you edit entities in NarrativeLab.': '⚠ 实验性功能 — 链接外部文件夹前请备份文件。在 NarrativeLab 中编辑实体时，链接文件夹中的文件可能会被修改。',
    'Point NarrativeLab to any folder in your vault. All .md files inside will be scanned and automatically sorted by their frontmatter type: field.': '将 NarrativeLab 指向仓库中的任意文件夹。系统会扫描其中所有 .md 文件，并根据前置元数据的 type: 字段自动分类。',
    'Type or browse for a folder...': '输入或浏览文件夹…',

    // Template editor opened from Settings
    'Edit Template': '编辑模板',
    'New Template': '新建模板',
    'Template name': '模板名称',
    'e.g. Climax Scene': '例如：高潮场景',
    'Description': '描述',
    'Short description…': '简短描述…',
    'Default emotion': '默认情绪',
    'e.g. tense, hopeful': '例如：紧张、充满希望',
    'Default tags': '默认标签',
    'Comma-separated': '以逗号分隔',
    'e.g. 1200': '例如：1200',
    'Body Template': '正文模板',
    'This text is inserted into the scene file body when using this template.': '使用此模板时，这段文本会插入场景文件的正文中。',
};

// Fragments first, then ZH_CORE overrides conflicts with curated translations.
const ZH: Record<string, string> = {
    ...MAIN_ZH,
    ...VIEWS_ZH,
    ...ENTITIES_ZH,
    ...BEATS_ZH,
    ...EXTRA_ZH,
    ...ZH_CORE,
};

let activeLanguage: UiLanguage = 'en';

export function normalizeUiLanguageSetting(value: unknown): UiLanguageSetting {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'en' || normalized === 'zh' ? normalized : 'auto';
}

function isChineseLocale(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('中文');
}

export function getObsidianInterfaceLanguage(app: App): UiLanguage {
    const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
    const values: unknown[] = [
        vault.getConfig?.('interfaceLanguage'),
        vault.getConfig?.('language'),
        vault.getConfig?.('locale'),
        (globalThis as unknown as { moment?: { locale?: () => string } }).moment?.locale?.(),
        activeDocument?.documentElement?.lang,
        globalThis.navigator?.language,
        ...(Array.isArray(globalThis.navigator?.languages) ? globalThis.navigator.languages : []),
    ];
    const detected = values.find(value => String(value ?? '').trim().length > 0);
    return isChineseLocale(detected) ? 'zh' : 'en';
}

export function resolveUiLanguage(setting: unknown, app: App): UiLanguage {
    const normalized = normalizeUiLanguageSetting(setting);
    return normalized === 'auto' ? getObsidianInterfaceLanguage(app) : normalized;
}

export function setActiveUiLanguage(language: UiLanguage): void {
    activeLanguage = language;
    activeDocument?.documentElement?.setAttribute('data-narrative-lab-language', language);
}

export function getActiveUiLanguage(): UiLanguage {
    return activeLanguage;
}

export function t(source: string, replacements: Record<string, string | number> = {}): string {
    const translated = activeLanguage === 'zh' ? (ZH[source] ?? source) : source;
    return Object.entries(replacements).reduce(
        (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
        translated,
    );
}

/** Localize a beat-sheet template for display / apply (name, labels, beat copy). */
export function localizeBeatSheet(template: BeatSheetTemplate): BeatSheetTemplate {
    const actLabels: Record<number, string> = {};
    for (const [k, v] of Object.entries(template.actLabels)) {
        actLabels[Number(k)] = t(v);
    }
    const chapterLabels: Record<number, string> = {};
    for (const [k, v] of Object.entries(template.chapterLabels)) {
        chapterLabels[Number(k)] = t(v);
    }
    return {
        ...template,
        name: t(template.name),
        summary: t(template.summary),
        actLabels,
        chapterLabels,
        beats: template.beats.map(beat => ({
            ...beat,
            label: t(beat.label),
            description: t(beat.description),
        })),
    };
}

function translateLiteral(value: string): string {
    return activeLanguage === 'zh' ? (ZH[value] ?? value) : value;
}

const LOCAL_ENTITY_SELECTOR = [
    '[data-narrative-lab-no-i18n]',
    // Native corkboard embeds Obsidian Canvas — never walk its DOM for i18n.
    '.story-line-corkboard-native-host',
    '.canvas-wrapper',
    '[data-type="canvas"]',
    // Obsidian file explorer / vault tree — never translate folder or file names.
    '.workspace-leaf-content[data-type="file-explorer"]',
    '.nav-files-container',
    '.nav-folder-title',
    '.nav-folder-title-content',
    '.nav-file-title',
    '.nav-file-title-content',
    '.tree-item-inner',
    '.tree-item-self',
    // Project and entity names rendered inside NarrativeLab.
    '.story-line-view-title',
    '.scene-card-title',
    '.timeline-card-title',
    '.sl-manuscript-scene-title',
    '.sl-nav-title',
    '.sl-nav-plotline-name',
    '.sl-nav-act-label',
    '.sl-nav-chapter-label',
    '.codex-entry-name',
    '.location-tree-name',
    '.scene-title',
    '.linked-alias-name',
    '.link-character-name',
    '.link-character-nickname',
    '.sl-research-card-title',
    '.storyline-export-project-name',
    '.gallery-lightbox-title',
    // Sticky-note bodies and captions are authored project content.
    '.story-line-corkboard-note-text',
    '.story-line-corkboard-note-preview',
    '.story-line-corkboard-note-caption',
    '.story-line-corkboard-note-caption-input',
].join(',');

function isDocumentShell(element: Element | null): boolean {
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'BODY' || tag === 'HTML' || element === activeDocument?.documentElement;
}

function isLocalEntityElement(element: Element | null): boolean {
    return !!element?.closest(LOCAL_ENTITY_SELECTOR);
}

export function localizeElement(root: ParentNode): void {
    // English UI uses source strings — skip expensive TreeWalker / querySelectorAll.
    if (activeLanguage === 'en') return;
    if (root instanceof Element && (isDocumentShell(root) || isLocalEntityElement(root))) return;

    const doc = root instanceof Document ? root : root.ownerDocument ?? activeDocument;
    if (!doc) return;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        const parent = node.parentElement;
        if (parent
            && !isLocalEntityElement(parent)
            && !['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(parent.tagName)) {
            const raw = node.nodeValue ?? '';
            const trimmed = raw.trim();
            if (trimmed) {
                const translated = translateLiteral(trimmed);
                if (translated !== trimmed) node.nodeValue = raw.replace(trimmed, translated);
            }
        }
        node = walker.nextNode();
    }

    const elements: Element[] = root instanceof Element
        ? [root, ...Array.from(root.querySelectorAll('*'))]
        : Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
        if (isLocalEntityElement(element)) continue;
        for (const attribute of ['placeholder', 'aria-label', 'title']) {
            const value = element.getAttribute(attribute);
            if (!value) continue;
            const translated = translateLiteral(value);
            if (translated !== value) element.setAttribute(attribute, translated);
        }
    }
}

/**
 * Only real plugin chrome — never match body classes like `sl-auto-hide-tab-labels`,
 * which previously caused the entire Obsidian UI (including the file explorer) to be
 * rewritten with Chinese labels for Canvas/Library/Notes.
 */
const PLUGIN_UI_SELECTOR = [
    '.narrative-lab-settings',
    '.narrative-lab-project-modal',
    '.narrative-lab-ncanvas-modal',
    '.story-line-view-switcher',
    '[class*="story-line-"]',
    '.codex-dropdown-menu',
    '.codex-category-tabs',
    '.codex-list-container',
    '.codex-search-row',
    '.storyline-export-modal',
    '.character-view',
    '.location-view',
    '.codex-view',
].join(',');

function isPluginUiRoot(element: Element): boolean {
    if (isDocumentShell(element) || isLocalEntityElement(element)) return false;
    return element.matches(PLUGIN_UI_SELECTOR);
}

export function localizePluginSubtree(node: Node): void {
    if (activeLanguage === 'en') return;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || isDocumentShell(element)) {
        const scope = isDocumentShell(element) ? element : activeDocument?.body;
        if (!scope) return;
        const localized = new Set<Element>();
        for (const root of Array.from(scope.querySelectorAll(PLUGIN_UI_SELECTOR))) {
            if (!isPluginUiRoot(root)) continue;
            const target = root.closest('.modal-container:not(.mod-dim)') ?? root;
            if (isDocumentShell(target) || localized.has(target)) continue;
            localized.add(target);
            localizeElement(target);
        }
        return;
    }

    if (isLocalEntityElement(element)) return;

    const containingRoot = element.closest(PLUGIN_UI_SELECTOR);
    if (containingRoot && isPluginUiRoot(containingRoot)) {
        const modal = containingRoot.closest('.modal-container');
        const target = modal && !isDocumentShell(modal) ? modal : containingRoot;
        localizeElement(target);
        return;
    }

    const localized = new Set<Element>();
    const roots = isPluginUiRoot(element)
        ? [element]
        : Array.from(element.querySelectorAll(PLUGIN_UI_SELECTOR)).filter(isPluginUiRoot);
    for (const root of roots) {
        const target = root.closest('.modal-container') ?? root;
        if (isDocumentShell(target) || localized.has(target)) continue;
        localized.add(target);
        localizeElement(target);
    }
}
