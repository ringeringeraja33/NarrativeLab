import type { App } from 'obsidian';
import { outermostElements } from './mutationRoots';
import { MAIN_ZH } from './i18n-main.zh';
import { VIEWS_ZH } from './i18n-views.zh';
import { ENTITIES_ZH } from './i18n-entities.zh';
import { BEATS_ZH } from './i18n-beats.zh';
import { EXTRA_ZH } from './i18n-extra.zh';
import type { BeatSheetTemplate, SceneTemplate } from '../models/Scene';
import { coerceString } from './narrow';

export type UiLanguageSetting = 'auto' | 'en' | 'zh';
export type UiLanguage = 'en' | 'zh';

const ZH_CORE: Record<string, string> = {
    'Subfolder and single-folder scopes keep separate histories.': '包含子文件夹与仅当前文件夹分别保存记录。',
    'Existing text is not counted as new writing. Each folder scope keeps its own history.': '已有内容不计入新增写作量。各文件夹统计范围独立保存记录。',
    'No folder selected': '未选中统计文件夹',
    'Not tracking': '未在统计',
    'Recording this folder': '正在记录',
    'Paused': '已暂停',
    'Track a folder': '开始统计文件夹',
    'Track another folder': '统计其他文件夹',
    'Resume tracking': '继续统计',
    'No folder is recording new writing. Saved folders keep their history; select one to continue counting.': '现在不会记录任何文件夹的新写作。已保存的文件夹仍保留历史，选中后才会继续统计。',
    'Only this folder records new writing. Other saved folders keep history but are not counting.': '只统计当前选中的文件夹。其他已保存的文件夹只保留历史，此刻不记入编辑。',
    'Open a note in this folder to record. Other saved folders are not counting.': '打开此文件夹中的文稿才会继续记录。其他已保存的文件夹此刻也不计数。',
    'Stop folder tracking': '停止文件夹统计',
    'Open file in new tab': '在新标签页打开原文件',
    'Chapter templates and structure': '章节模板与结构',
    'Choose an existing folder in this vault.': '选择当前库中已有的文件夹。',
    'Tracked folder': '统计文件夹',
    'Include subfolders': '包含子文件夹',
    'Choose folder': '选择文件夹',
    'Indexing folder...': '正在建立文件夹统计基线…',
    'Track writing in a folder': '统计文件夹写作',
    'Track writing in this folder': '统计此文件夹的写作',
    'Folder statistics could not be read. Existing records were kept.': '无法读取文件夹统计，已有记录已保留。',
    'The tracked folder is unavailable. Its history was kept.': '统计文件夹当前不可用，历史记录已保留。',
    'Paused — no files from this folder are open.': '已暂停：当前未打开此文件夹中的文稿。',
    'Session (while folder files are open)': '本次会话（文件夹文稿打开期间）',
    'Folder writing statistics': '文件夹写作统计',
    'Total words': '当前总字数',
    'Collapse all documents': '折叠全部文稿',
    'Expand all documents': '展开全部文稿',
    'Modules': '模块',
    'Tab layout': '页签布局',
    'Word counting': '字数统计',
    'Disabled modules keep their data.': '停用模块保留数据',
    'Connect nodes and present a sequence.': '连接节点，按顺序演示内容。',
    'Project settings': '项目设置',
    'Manage projects': '管理项目',
    'More project actions': '更多项目操作',
    'Required content modules are selected automatically. Turning them off also disables dependent views.': '依赖的内容模块会自动勾选。关闭这些内容模块时，相关视图也会停用。',
    'Flat canvas': '平铺画布',
    'Column board': '列式白板',
    'Plot subway map': '情节地铁图',
    'Writing': '写作',
    'More views': '更多',
    'Canvases and organization': '画布与整理',
    'Narrative planning': '叙事规划',
    'Organize': '整理',
    'Presentation': '演示',
    'Tab groups only organize the tab bar. Each page can still be turned on or off in Modules.': '分组只整理入口，各功能仍可独立开关。',
    'Materials and research': '资料与研究',
    'Narrative content': '叙事内容',
    'Writing progress': '写作进度',
    'Arrange note cards freely on a flat canvas.': '在画布上自由排列笔记卡片。',
    'Organize note cards in columns.': '按列组织笔记卡片。',
    'Arrange scenes in reading or chronological order.': '按阅读顺序或故事时间排列场景。',
    'Compare parallel narrative tracks.': '并列对比不同叙事轨道。',
    'Review scenes grouped by plotline.': '按情节线查看场景。',
    'Visualize plotline intersections as a route map.': '用线路图展示情节线的交汇关系。',
    'Apply and manage act and chapter templates.': '应用和管理幕、章节的结构模板。',
    'The main writing page for drafts.': '主文稿写作页。',
    'A Notes folder in the binder for freeform files.': '侧栏绑定器里的笔记文件夹，用于随手记录。',
    'A structured outline of the work.': '作品的结构化大纲。',
    'A spreadsheet for lists, indexes, and data.': '用于清单、索引和数据表的表格页。',
    'Scene cards. Timeline, plot views, and scene sidebars need this.': '场景卡片。时间线、情节视图和场景侧栏都依赖此项。',
    'Character profiles and the Characters tab in Library. Save settings to hide that tab.': '角色档案，以及资料库中的“角色”页签。保存设置后才会隐藏该页签。',
    'Location profiles and the Locations tab in Library. Save settings to hide that tab.': '地点档案，以及资料库中的“地点”页签。保存设置后才会隐藏该页签。',
    'The scene inspector sidebar: status, POV, and metadata.': '场景检查器侧栏：状态、视角和元数据。',
    'A sidebar for notes attached to the current scene.': '当前场景附注所在的侧栏。',
    'A sidebar for the short synopsis of each scene.': '各场景短梗概所在的侧栏。',
    'Share library entries across books in a series.': '在系列多部作品之间共享资料库条目。',
    'The Library archive. Research projects start with literature, claims, arguments, and facts; narrative projects start with worldbuilding categories.': '资料库。科研项目默认提供文献、论点、论据、事实；叙事项目默认提供世界观类别。',
    'A Research folder in the binder for source notes.': '侧栏绑定器里的研究文件夹，用于文献和资料笔记。',
    'Does not add a page. Reserved for inserting and managing citations in drafts.': '不会新增独立页面。预留给在文稿中插入和管理引用。',
    'Daily word-count goals and writing sessions.': '每日字数目标和写作会话。',
    'Length and readability statistics.': '篇幅与可读性统计。',
    'General counts readable prose, including checklists. Academic also skips citations, footnotes, and a trailing references section. Narrative skips comments and checklists but keeps footnotes. Custom follows the comment and checklist switches in plugin settings. Language still follows the project locale.': '通用统计可读正文，清单也计入。学术还会去掉引文、脚注和文末参考文献。叙事去掉注释和清单，但保留脚注。自定义遵循插件设置里的注释与清单开关。语言仍跟随项目语言。',
    'This module is disabled': '此模块已停用',
    'Project overview': '项目概览',
    'Choose a project tab or enable a module in project settings. Existing files are kept.': '选择项目页签，或在项目设置中启用功能。已有文件均保留。',
    'Could not save project settings. Your files were kept.': '项目设置保存失败，已有文件均保留。',
    'Project settings are being saved. Please wait.': '正在保存项目设置，请稍候。',
    'Open flat canvas': '打开平铺画布',
    'Open timeline': '打开时间线',
    'Search notes...': '搜索笔记…',
    'Tab layout and default page': '页签布局与默认页面',
    'Default project page': '项目默认页面',
    'Automatic': '自动',
    'Project basics': '项目基本信息',
    'Choose modules': '选择模块',
    'Review and create': '确认并创建',
    'Previous step': '上一步',
    'Next step': '下一步',
    'Enter the project title and, if applicable, the series name.': '请填写项目名称；创建系列时还需填写系列名称。',
    'Open {view}': '打开{view}',
    'Show in tab bar': '显示在页签栏',
    'Hidden tabs remain available in More. Modules and files are not disabled.': '隐藏的页签仍可在“更多”中打开，功能与文件均保留。',
    'No notes found.': '暂无笔记。',
    'Create a note to start organizing your ideas.': '新建笔记，开始整理想法。',
    'Show startup diagnostics': '显示启动诊断',
    'Project modules': '项目模块',
    'Project modules…': '项目模块…',
    'Project preset': '项目预设',
    'Enabled modules': '启用的模块',
    'Word count profile': '字数统计方案',
    'Academic': '学术',
    'Narrative': '叙事',
    'Choose an initial module set. Modules can be changed later without deleting data.': '选择初始模块组合。之后可随时调整，已有数据不会被删除。',
    'Disabling a module keeps its files. Re-enable it to restore access.': '停用模块会保留其文件，重新启用后即可恢复访问。',
    'Project modules updated. Disabled module data was kept.': '项目模块已更新，停用模块的数据仍保留。',
    'This module is disabled for the project. Enable it from Project modules.': '该项目已停用此模块，请在“项目模块”中启用。',
    'Plain writing': '纯写作',
    'Essay': '随笔',
    'Research paper': '科研论文',
    'Literature review': '文献综述',
    'Novel': '小说',
    'Full narrative': '完整叙事',
    'Legacy full': '旧项目完整模式',
    'Outline': '大纲',
    'Writing statistics': '写作统计',
    'Citation helpers': '引用辅助',
    'Scene details': '场景详情',
    'Scene notes': '场景笔记',
    'New document': '新建文稿',
    'Documents': '文稿数',
    'Document list': '文稿',
    'Document title': '文稿标题',
    'No documents yet.': '还没有文稿。',
    'Open as table': '用表格打开',
    'Open Library to add literature, claims, arguments, and facts.': '打开资料库，添加文献、论点、论据和事实。',
    'Opening project document list...': '正在打开项目文稿列表…',
    'Please enter a document title': '请输入文稿标题',
    'A document with this title already exists': '已存在同名文稿',
    'Could not open the project document list.': '无法打开项目文稿列表。',
    '{n} documents · {words} words': '{n} 篇文稿 · {words} 字',
    // Global navigation
    'Board': '场景板',
    'Plotgrid': '表格',
    'Concept Grid': '表格',
    'Table': '表格',
    'Table view': '表视图',
    'List': '列表',
    'Cards': '卡片',
    'Load more': '加载更多',
    'Untitled': '未命名',
    'Save failed': '保存失败',
    'Could not save the field change. Your existing data was kept.': '无法保存字段修改，原有数据已保留。',
    'Could not safely read {name} before saving: {message}': '保存前无法安全读取“{name}”：{message}',
    'Failed to save entry: {message}': '无法保存条目：{message}',
    'Failed to save location: {message}': '无法保存地点：{message}',
    'Timeline': '时间线',
    'Order': '次序',
    'Plotlines': '情节线',
    'Manuscript': '文稿',
    'Canvas': '画布',
    'Node-based presentation canvas': '节点式演示画布',
    'Manage canvases': '管理画布',
    'Connect nodes and present content along their links. Optional and independent of the Board.': '连接节点，并按连线顺序演示内容。可独立勾选，与白板分别启用。',
    'Choose, create, or open a node-based presentation canvas for this project': '选择、新建或打开本项目的节点式演示画布',
    'Manage node-based presentation canvases': '管理节点式演示画布',
    'Open node-based presentation canvas (last used)': '打开节点式演示画布（上次使用）',
    'Library': '资料库',
    'Stats': '统计',
    'Export': '导出',
    'Characters': '角色',
    'Locations': '地点',
    'Items': '物品',
    'Lore': '设定',
    'Literature': '文献',
    'Claims': '论点',
    'Arguments': '论据',
    'Facts': '事实',
    'Research': '研究',
    'Notes': '笔记',
    'WritingLab projects': 'WritingLab 项目',
    'Open board view': '打开场景板',
    'Open timeline view': '打开次序视图',
    'Open structure view': '打开结构视图',
    'Open plotgrid view': '打开表格',
    'Open concept grid view': '打开表格',
    'Open plotlines view': '打开情节线视图',
    'Open character view': '打开角色视图',
    'Open statistics dashboard': '打开统计面板',
    'Open writing tracker': '打开写作记录',
    'Open writing tracker panel': '打开写作记录侧栏',
    'Open location view': '打开地点视图',
    'Open Library': '打开资料库',
    'Create new scene': '新建场景',
    'Create new project': '新建项目',
    'Open or switch project': '打开或切换项目',
    'Fork current project': '复制当前项目',
    'Delete current project': '删除当前项目',
    'Export project': '导出项目',
    'Open converter': '打开导入与导出',
    'Converter': '导入与导出',
    'Converter / Export & Import': '导入与导出',
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
    'Each selected plotline becomes a Location Frame; each scene becomes a fillable Story Sequence with a link to its note.': '每条勾选的情节线会生成一个地点框架；每个场景会生成一个可填写的故事序列，并链接到对应笔记。',
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
    'Turn selected NarrativeLab plotlines into Location Frames and fillable Story Sequences.': '将选定的 NarrativeLab 情节线转为地点框架和可填写的故事序列。',
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
    'Library wikilinks appear automatically. Connect via node menu (Connect to…) or mouse right-drag; double-click a relationship to focus; right-click an edge for type/category.': '资料库双链会自动显示；节点菜单选「连到…」或鼠标右键拖线可建关联；双击关系进入聚焦；右键连线可设类型/类别。',
    'Body wikilinks are default references. Right-click an edge to set a category (written to frontmatter), focus strands, or delete the link entirely (clears body + frontmatter on both notes).': '正文双链是默认引用。右键连线可设置类别（写入 YAML 属性）、聚焦关系线，或彻底删除这条关系（同时清除两篇笔记正文中的双链和 YAML 属性引用）。',
    'Profile associations and body wikilinks both appear here. Right-click an edge to set its category, edit focus strands, or remove that relationship.': '档案关联与正文双链都会显示在这里。右键连线可设置类别、编辑聚焦关系内容或移除该关系。',
    'Remove the profile association between "{from}" and "{to}"? Note body text will be kept.': '要移除“{from}”与“{to}”之间的档案关联吗？两篇笔记的正文都会保留。',
    'Focus relationship': '聚焦关系',
    'Connect with wikilink': '用双链连线',
    'Connect character relation': '连角色关系',
    'Cancel connect': '取消连线',
    'Connect cancelled': '已取消连线',
    'Right-drag from a node to connect': '从节点右键拖出连线以建立关联',
    'Or open a node menu and choose Connect to…': '或打开节点菜单，选择「连到…」',
    'Connect to…': '连到…',
    'Tip: on mouse, right-drag to connect': '提示：鼠标可右键拖线连结',
    'Tap another node to connect': '再点另一个节点以连线',
    'From {name} — tap a target node (Esc to cancel)': '从 {name} — 点选目标节点（Esc 取消）',
    'Drop on a target node to connect': '请拖放到目标节点上以连线',
    'Wikilink': '双链',
    'Character relation': '角色关系',
    'This node has no vault file': '该节点没有对应笔记文件',
    'Pick a different node': '请选择另一个节点',
    'Wikilink added': '已添加双链',
    'Wikilink already present': '双链已存在',
    'Failed to add wikilink': '添加双链失败',
    'Cites': '引用',
    'Supports': '支持',
    'Refutes': '反驳',
    'No links detected in Library files. Add an Obsidian wikilink such as [[Source]] to see it here.': '未在资料库文件中检测到关联。添加如 [[文献]] 的 Obsidian 双链后即可在此显示。',
    'Wikilinks between Library notes appear here. Right-click an edge to mark cites, supports, or refutes.': '资料库笔记之间的双链会显示在这里。右键连线可标为引用、支持或反驳。',
    'Library categories (same as tabs / Library subfolders). New Library categories appear here automatically.': '资料库类别（与页签及资料库子文件夹一致）。新建资料库类别会自动出现在这里。',
    'Back to Story Graph': '返回资料图谱',
    'Both endpoints need vault files to open focus view.': '两端都需要有对应笔记文件才能打开聚焦视图。',
    'Arrow style': '箭头形式',
    'Single arrow': '单箭头',
    'Double arrow': '双箭头',
    'Single arrow follows the wikilink direction; double arrow is mutual.': '单箭头沿双链方向；双箭头表示双向互指。',
    'Node size': '点大小',
    'Save layout': '保存布局',
    'Reset layout': '重置布局',
    'Export image': '导出图片',
    'Open in Graph view': '在原生图谱打开',
    'Show in Graph view': '在原生图谱中显示',
    'Graph view is disabled': '未启用 Obsidian 图谱视图',
    'Could not open Graph view': '无法打开图谱视图',
    'Story Graph layout saved': '已保存资料图谱布局',
    'Story Graph layout reset': '已重置资料图谱布局',
    'Story Graph image exported': '已导出资料图谱图片',
    'Failed to export Story Graph image': '导出资料图谱图片失败',
    'Nothing to export': '没有可导出的内容',
    'All entity filters are off. Turn some back on above, or reset filters.': '所有实体筛选都已关闭。请在上方重新打开，或重置筛选。',
    'Nothing matches the current filters. Enable more entity types above, or reset filters.': '当前筛选下没有可显示的内容。请在上方打开更多实体类型，或重置筛选。',
    'Reset filters': '重置筛选',
    'Set node image': '设置节点图片',
    'Change node image': '更换节点图片',
    'Clear node image': '清除节点图片',
    'Fullscreen': '全屏',
    'Exit fullscreen': '退出全屏',
    'Save strands': '保存指向',
    'Strands saved': '已保存指向',
    'Failed to save strands': '保存指向失败',
    'Add strand': '添加指向',
    'Remove strand': '移除指向',
    'New strand': '新指向',
    'Short label': '短标签',
    'Strand label': '指向标签',
    'Line style': '线条样式',
    'Solid': '实线',
    'Dashed': '虚线',
    'Dotted': '点线',
    'Keep at least one strand': '至少保留一股指向',
    'Keep at least one strand. To remove the link entirely, delete it on the Story Graph.': '至少保留一股指向。要彻底删除关系，请回到资料图谱右键删除连线。',
    'Remove link': '删除连线',
    'Remove all body wikilinks and annotated references between "{from}" and "{to}"?': '确定删除“{from}”与“{to}”之间的全部正文双链和 YAML 属性引用吗？',
    'Link removed': '已删除连线',
    'Failed to remove link': '删除连线失败',
    'Drag to connect': '拖拽连线',
    'Arrow / connect': '箭头 / 连线',
    'Strands': '指向',
    'Search strands': '搜索指向',
    'No matching strands': '无匹配指向',
    'No strands yet — use the arrow tool or add one below': '还没有指向 — 用箭头工具拖线，或在下方添加',
    'Arrow tool: drag a handle to the other side to add a strand': '连线工具：从把手拖到另一侧以添加指向',
    'Drag mid-point to bend · double-click line to edit label · right-click a strand to remove it · open Strands to manage': '拖动中点弯曲 · 双击连线编辑文字 · 右键下级连线可删除 · 打开「指向」管理',
    'Drag to bend': '拖动以弯曲',
    'Add handle': '添加把手',
    'Delete handle': '删除把手',
    'Create new handle?': '新建把手？',
    'Create a new handle for this strand, or attach it to an existing handle?': '要为这条指向新建把手，还是接到已有把手上？',
    'New handle': '新建把手',
    'Use existing handle': '使用已有把手',
    'Undo': '撤销',
    'Redo': '重做',
    'Nothing to undo': '没有可撤销的操作',
    'Could not record this change for undo.': '无法记录这次修改，之后不能撤销。',
    'The file changed outside NarrativeLab. Undo was cancelled to protect the newer content.': '文件已在 NarrativeLab 外部被修改。为保护较新的内容，已取消撤销。',
    'The file changed outside NarrativeLab. Redo was cancelled to protect the newer content.': '文件已在 NarrativeLab 外部被修改。为保护较新的内容，已取消重做。',
    'The file changed outside NarrativeLab. {action} was cancelled to protect the newer content.': '文件已在 NarrativeLab 外部被修改。为保护较新的内容，已取消{action}。',
    'A file already exists at the restore location.': '恢复位置已经存在文件。',
    'Expected a JSON object.': '这里应当是一个 JSON 对象。',
    'Project data file "{name}" is invalid. It will be preserved before the next save.': '项目数据文件“{name}”无效。下次保存前会先保留原文件。',
    'Could not save project data "{name}": {message}': '无法保存项目数据“{name}”：{message}',
    'Safe write failed for {name}: {message}': '{name} 的安全写入失败：{message}',
    'The Base file exists but is not indexed by Obsidian. Reopen the vault and try again: {path}': 'Base 文件存在，但 Obsidian 尚未建立索引。请重新打开仓库后再试：{path}',
    'Library folder not found: {path}': '未找到资料库文件夹：{path}',
    'Failed to rename Library category: {message}': '资料库分类重命名失败：{message}',
    'Staged Library assets could not be found.': '找不到暂存的资料库资产。',
    'Failed to delete Library category: {message}': '删除资料库分类失败：{message}',
    'Unsupported project bundle version: {version}': '不支持此项目包版本：{version}',
    'unknown': '未知',
    'Bundle is missing project metadata.': '项目包缺少项目元数据。',
    'Bundle file entry {index} is invalid.': '项目包中的第 {index} 个文件条目无效。',
    'Bundle contains the same path more than once: {path}': '项目包包含重复路径：{path}',
    'Bundle contains an unsafe path: {path}': '项目包包含不安全的路径：{path}',
    'A folder blocks the import path: {path}': '文件夹占用了导入路径：{path}',
    'The import target is not indexed by Obsidian. Reopen the vault and try again: {path}': '导入目标尚未被 Obsidian 索引。请重新打开仓库后再试：{path}',
    'Skipped rollback because the file changed: {path}': '文件已经变化，已跳过回滚：{path}',
    'Import failed. Some files could not be rolled back: {details}': '导入失败，部分文件无法回滚：{details}',
    'Imported project could not be registered.': '导入的项目无法注册。',
    'Nothing to redo': '没有可重做的操作',
    'Secondary strands under "{parent}"': '「{parent}」下的次级指向',
    'internal strands': '条内部指向',
    'Edit character relation styles (synced with character notes) and wikilink categories. Internal multi-strands are set in focus view.': '编辑角色关系样式（与角色笔记双向同步）以及双链类别。关系内部的多重小连线请在聚焦视图中设置。',
    'Character relations': '角色关系',
    'These appear as labeled lines between characters. Types found on character notes are imported automatically.': '会显示为角色之间的带字连线；角色笔记里已有的关系类型会自动导入。',
    'Legend matches library relation categories. Custom types sync with character profile relation entries.': '图例与资料库关系类别一致。自定义类型会同步到角色资料中的关系条目。',
    'Relation category': '关系分类',
    'Relation kind': '关系种类',
    'Wikilink category': '双链类别',
    'Character relations sync to character notes; wikilink categories label Obsidian links.': '角色关系会写入角色笔记；双链类别用于标注 Obsidian 双链。',
    'Double arrow is mutual; single arrow is directed.': '双箭头表示双向互指；单箭头表示有方向。',
    'Add character relation': '添加角色关系',
    'Cannot delete: used by character relations': '无法删除：已有角色关系在使用',
    'Wikilink categories': '双链类别',
    'Assign these to Obsidian wikilink edges via right-click on the graph.': '在图谱上右键双链连线即可指定这些类别。',
    'Add wikilink category': '添加双链类别',

    'Scene {n}': '场景 {n}',
    'Project: {title}': '项目：{title}',
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
    'Follows Obsidian by default. Choose Light or Dark to override NarrativeLab and Narrative Canvas.': '默认跟随 Obsidian。如需覆盖，可为 NarrativeLab 与 Narrative Canvas 选择浅色或深色。',
    'These are global color defaults. To use different colors for one project, right-click it in the Navigator and enable project-specific colors.': '这里是全局配色默认值。若要为单个项目使用不同颜色，请在导航器中右键该项目并开启「项目专属颜色」。',
    'Manage global scene templates, narrative structures and project presets. Project-scoped templates are managed from the Navigator (right-click a project).': '管理全局场景模板、叙事结构和项目预设。项目级模板请在导航器中右键项目进行管理。',
    'Create a global preset': '创建全局预设',
    'Creates an empty global preset. To snapshot the active project\'s Library setup, use Save as global preset in the Navigator project menu.': '创建一个空白全局预设。若要快照当前项目的资料库配置，请在导航器项目菜单中选择「保存为全局预设」。',
    'Project menu': '项目菜单',
    'Project templates…': '项目模板…',
    'Project templates': '项目模板',
    'Save as global preset…': '保存为全局预设…',
    'Saved global preset "{name}".': '已保存全局预设「{name}」。',
    'Project-specific colors enabled for "{name}".': '已为「{name}」启用项目专属颜色。',
    'Using global color defaults for "{name}".': '「{name}」已改用全局配色默认值。',
    'These templates are saved under System/Templates/ for the active project only. Global templates stay in Settings → Template Center.': '这些模板仅保存在当前项目的 System/Templates/。全局模板仍在「设置 → 模板中心」。',
    'No project scene templates yet.': '尚无项目场景模板。',
    'No project structures yet.': '尚无项目叙事结构。',
    '{name} preset': '{name} 预设',
    'BCP-47 tag used for word counting, reading time, dialogue %, stop-word filtering and PDF line wrapping. Choose Auto-detect to infer the script from manuscript text. Per-project overrides still use the `language:` field in the project frontmatter.': '用于字数统计、阅读时间、对话占比、停用词过滤和 PDF 换行的 BCP-47 语言标签。选择自动检测可从正文推断文字系统。单个项目仍可通过项目前言中的 `language:` 字段覆盖。',
    'Light': '浅色',
    'Dark': '深色',

    // Project launcher
    'Open NarrativeLab Project': '打开 NarrativeLab 项目',
    'Select a project to load, or create a new one.': '选择要打开的项目，或创建新项目。',
    'Open Project': '打开项目',
    'Open Canvas': '打开画布试玩',
    'Play in Canvas': '在叙事画布中试玩',
    'Choose, create, or open an ncanvas for this project': '为此项目选择、新建或打开 ncanvas',
    'New Project': '新建项目',
    'Manage Series…': '管理系列…',
    'Browse Project…': '浏览项目…',
    'Manage Canvas files': '管理画布文件',
    'Open Narrative Canvas (last used)': '打开 Narrative Canvas（上次使用）',
    'Canvas files': '画布文件',
    'Canvas box': '画布盒',
    '{count} canvases · stored in {folder}': '{count} 个画布 · 保存在 {folder}',
    'New canvas': '新建画布',
    'Canvas name': '画布名称',
    'The canvas is stored as a project-local .ncanvas file.': '画布将作为本项目内的 .ncanvas 文件保存。',
    'Create and open': '创建并打开',
    'Enter a canvas name.': '请输入画布名称。',
    'No canvases yet': '还没有画布',
    'Create separate canvases for different story lines, systems, or visual plans.': '可为不同故事线、系统设计或视觉规划创建独立画布。',
    'Create first canvas': '创建第一个画布',
    'Guide sample': '指南示例',
    'Open canvas: {name}': '打开画布：{name}',
    'Rename canvas': '重命名画布',
    'Delete canvas': '删除画布',
    'Modified {date} · {size}': '修改于 {date} · {size}',
    'Rename canvas to {name}': '将画布重命名为 {name}',
    'Delete canvas?': '删除画布？',
    '“{name}” will be moved to the Obsidian trash. Other canvases are not affected.': '“{name}”将移入 Obsidian 回收站，其他画布不受影响。',
    'Move to trash': '移入回收站',
    'Canvas operation failed: {error}': '画布操作失败：{error}',
    'This canvas is not part of the active project.': '此画布不属于当前项目。',
    'Renamed canvas to {name}': '画布已重命名为 {name}',
    'Moved canvas to trash: {name}': '画布已移入回收站：{name}',
    'Manage .ncanvas files for this project. Stored in {folder}.': '管理本项目的 .ncanvas 文件，保存在 {folder}。',
    'New ncanvas': '新建 ncanvas',
    'File name': '文件名',
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
    'Content font': '正文字体',
    'Follow Obsidian': '跟随 Obsidian',
    'System font': '系统字体',
    'Classic serif': '衬线体',
    'Font used for Play preview and narrative text on the canvas.': '用于画布试玩预览和叙事正文的字体。',
    'Spell-check in canvas fields': '画布文本拼写检查',
    'Show the browser spell-check underlines in Narrative Canvas text fields.': '在叙事画布的文本框中显示浏览器拼写检查下划线。',
    'Canvas auto-save (seconds)': '画布自动保存（秒）',
    'How often the open .ncanvas file is written. Leave empty for the canvas default.': '打开的 .ncanvas 写入间隔。留空则使用画布默认间隔。',
    'Canvas AI endpoint': '画布 AI 接口',
    'Canvas AI key': '画布 AI 密钥',
    'Canvas AI model': '画布 AI 模型',
    'Narrative craft guidance': '叙事技法提示',
    'Prime canvas AI replies with condensed storytelling craft. Adds tokens to each request.': '给画布 AI 加上精简的叙事技法提示。每次请求会多用一些 token。',
    'Create canvas backup': '创建画布备份',
    'Restore canvas backup': '恢复画布备份',
    'Create or restore a versioned snapshot of the open .ncanvas file.': '为当前打开的 .ncanvas 创建或恢复版本快照。',
    'Backup': '备份',
    'Cancel': '取消',
    'No project selected': '未选择项目',
    'No projects found.': '未找到项目。',
    'Only one project exists.': '当前只有一个项目。',

    // Project and series modals
    'Create New Project': '新建项目',
    'Project title': '项目标题',
    'The title of this project. Each project gets its own workspace folder.': '项目名称。每个项目都有独立的工作区文件夹。',
    'Location': '地点',
    'Create': '创建',
    'Series name': '系列名称',
    'Create as series': '创建为系列',
    'Manage Series': '管理系列',
    'Manage Projects and Series': '管理项目与系列',
    'Please enter a valid project name.': '请输入有效的项目名称。',
    'Cannot rename project because this path already exists: {path}': '无法重命名项目，目标路径已存在：{path}',
    'Delete Project': '删除项目',
    'Delete the project "{name}" and all files in its project folder?': '删除项目“{name}”及其文件夹内的全部文件？',
    'This includes documents, notes, canvases, tables, attachments and project settings stored in this folder.': '删除范围包括该文件夹中的文稿、笔记、画布、表格、附件和项目设置。',
    'The project will be removed from "{name}". The shared series Library and other projects will be kept.': '该项目将从“{name}”中移除，系列共享资料库和其他项目会保留。',
    'Deletion follows your vault’s Deleted files setting. Recovery depends on that setting; WritingLab has no undo for project deletion.': '删除方式遵循仓库的“删除文件”设置，能否恢复取决于该设置；WritingLab 不提供撤销项目删除的功能。',
    'Rename the project title, folder, manifest and existing project-named Base files. Document titles are kept.': '同步重命名项目标题、文件夹、项目配置文件及已有的项目专属 Base 文件，保留文稿标题。',
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
    '{name} Profiles': '{name} 档案',
    'Move down': '下移',

    // Main views
    'Story Graph': '资料图谱',
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
    'Tracking': '追踪',
    'Export & Advanced': '导出与高级',
    'Hide frontmatter': '隐藏 YAML 属性',
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
    'Hide the properties/frontmatter block on NarrativeLab notes only (live preview and reading mode). Since all fields are editable from the Inspector, frontmatter can safely be hidden. Your global Obsidian "Properties in document" setting is left untouched.': '仅在 NarrativeLab 笔记中隐藏 YAML 属性区（实时预览和阅读模式）。所有字段仍可在检查器中编辑，且不会更改 Obsidian 全局的“文档中的属性”设置。',
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
    'Store scene references such as POV, location, characters, setup_scenes, and payoff_scenes as Obsidian [[wikilinks]] so they update automatically when files are renamed. Existing plain-text values continue to work.': '将 POV、location、characters、setup_scenes 和 payoff_scenes 等场景引用存为 Obsidian [[Wiki 链接]]，文件重命名时可自动更新。现有纯文本值仍可继续使用。',
    'Mirror custom fields to top-level YAML': '将自定义字段镜像到顶层 YAML',
    'Also write Universal Field values as top-level YAML keys, using each template\'s “Top-level key”, so they appear in Obsidian Properties, Bases, and Dataview. Reserved NarrativeLab keys are skipped.': '同时按各模板的“顶层键”将通用字段值写入顶层 YAML，以便显示在 Obsidian 属性、Bases 和 Dataview 中。NarrativeLab 保留键会自动跳过。',
    'Count unit for scene lengths': '场景长度计数单位',
    'Choose whether scene cards, the Timeline, and the Inspector display scene length in words or characters. Useful for prose writers who track length in characters (e.g. Russian, Chinese, Japanese).': '选择场景卡片、时间线和检查器以字数还是字符数显示场景长度。适合以字符数追踪篇幅的散文作者（例如俄语、中文、日语作者）。',
    'Words': '字数',
    'Exclude `%%comments%%` from wordcount': '字数统计中排除 `%%注释%%`',
    'Used by the Custom word-count profile and by folder writing trackers. Academic and Narrative always skip comments. Markdown and HTML syntax are always ignored; only readable prose is counted.': '作用于「自定义」字数方案和文件夹写作记录。学术与叙事始终排除注释。Markdown / HTML 标记本身一律不计；只统计读者能读到的正文。',
    'Also ignore checkbox lines (`- [ ]`, `- [x]`)': '同时忽略复选框行（`- [ ]`、`- [x]`）',
    'Used by the Custom word-count profile and by folder writing trackers. Academic and Narrative always skip task lines. General keeps them.': '作用于「自定义」字数方案和文件夹写作记录。学术与叙事始终排除任务行；通用方案仍计入清单。',
    'BCP-47 tag used for word counting, reading time, dialogue %, stop-word filtering and PDF line wrapping. Choose Auto-detect to infer the script from manuscript text. Existing projects that still use the old default are updated too; otherwise set per-project by editing `language:` in the project frontmatter.': '用于字数统计、阅读时间、对话占比、停用词过滤和 PDF 换行的 BCP-47 标签。选择“从文本自动检测”可根据文稿推断文字系统。仍使用旧默认值的现有项目也会更新；也可在项目的 YAML 属性中编辑 `language:`，单独设置语言。',
    'Auto-detect from text': '从文本自动检测',
    'Default scene frontmatter': '默认场景 YAML 属性',
    'Raw YAML merged into every newly created scene. Useful for companion plugins (e.g. `cssclasses: [fountain]`). NarrativeLab\'s own keys (type, title, act, chapter, sequence, status…) take priority on conflict.': '将原始 YAML 合并到每个新建场景中，可用于配套插件（如 `cssclasses: [fountain]`）。如有冲突，以 NarrativeLab 自有键（type、title、act、chapter、sequence、status…）为准。',
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
    'Sticky Note Colors': '笔记颜色',
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
    'Tab name matches the Library folder name.': '页签名称与资料库子文件夹名称一致。',
    'Invalid folder name': '无效的文件夹名称',
    'A folder with this name already exists': '已存在同名文件夹',
    'This project already belongs to a series.': '此项目已属于一个系列。',
    'Wrap the current project in a new series.': '将当前项目纳入一个新系列。',
    'Create Series…': '创建系列…',
    'Scene Templates': '场景模板',
    'Template Center': '模板中心',
    'Manage scene templates, narrative structures and project presets in one place. Project templates are stored under System/Templates/. Continue using System, not Library, so Library folder scanning cannot treat templates as categories.': '统一管理场景模板、叙事结构和项目预设。项目模板保存在 System/Templates/，不要放入 Library，以免被资料库文件夹扫描识别为分类。',
    'Export all templates': '导出全部模板',
    'Template bundle written: {path}': '模板包已写入：{path}',
    'Could not export templates: {message}': '无法导出模板：{message}',
    'Import templates…': '导入模板…',
    'Imported {scenes} scene template(s), {structures} structure(s), and {presets} preset(s).': '已导入 {scenes} 个场景模板、{structures} 个结构模板和 {presets} 个项目预设。',
    'Could not import templates: {message}': '无法导入模板：{message}',
    'Pre-fill scene fields and Markdown body. Built-in templates are bilingual.': '预填场景字段和 Markdown 正文；内置模板提供中英文正文。',
    'Narrative Structures': '叙事结构',
    'Define acts, chapters and beats. Applying a structure always shows a change preview.': '定义幕、章节和节拍；应用结构前始终显示变更预览。',
    'Create a structure template': '创建结构模板',
    'Add Structure': '添加结构',
    'Project Presets': '项目预设',
    'A preset can combine a narrative structure, Library categories and project field templates.': '项目预设可组合叙事结构、资料库分类和项目字段模板。',
    'Capture current project as preset': '将当前项目保存为预设',
    'Copies current Library category and field-template definitions. Scene content is not included.': '复制当前资料库分类和字段模板定义，不包含场景正文。',
    'Add Preset': '添加预设',
    'Global': '全局',
    'Duplicate template': '复制模板',
    'Copy': '副本',
    'No custom structures yet. Built-in structures remain available.': '尚无自定义结构；内置结构仍可使用。',
    'No project presets yet.': '尚无项目预设。',
    'Project preset applied.': '项目预设已应用。',
    'Scope': '作用域',
    'Project templates are saved under System/Templates/ and sync with the project.': '项目模板保存在 System/Templates/，并随项目同步。',
    'Comma-separated numbers or ranges.': '使用逗号分隔数字或范围。',
    'One per line: number|label': '每行一项：编号|名称',
    'Beats': '节拍',
    'beats': '节拍',
    'Act labels': '幕名称',
    'Chapter labels': '章节名称',
    'One per line: act|chapter|label|description. Chapter may be blank.': '每行一项：幕|章节|名称|说明；章节可留空。',
    'Enter a template name.': '请输入模板名称。',
    'Preset name': '预设名称',
    'Narrative structure': '叙事结构',
    'Create beat scenes': '创建节拍场景',
    'Placeholder scene template': '占位场景模板',
    'This preset contains {categories} Library category definition(s) and {fields} field template(s).': '此预设包含 {categories} 个资料库分类定义和 {fields} 个字段模板。',
    'Enter a preset name.': '请输入预设名称。',
    'Choose a NarrativeLab template bundle…': '选择 NarrativeLab 模板包…',
    'Import template scope': '导入模板的作用域',
    'Choose where imported templates will be stored.': '选择导入模板的保存位置。',
    'Edit Structure Template': '编辑结构模板',
    'New Structure Template': '新建结构模板',
    'Edit Project Preset': '编辑项目预设',
    'New Project Preset': '新建项目预设',
    'Apply structure: {name}': '应用结构：{name}',
    'Acts: {before} → {after}; chapters: {chaptersBefore} → {chaptersAfter}.': '幕：{before} → {after}；章节：{chaptersBefore} → {chaptersAfter}。',
    '{n} existing scene(s) will be remapped.': '将重新映射 {n} 个现有场景。',
    '{n} existing scene(s) will become uncategorized.': '将有 {n} 个现有场景移到未分类。',
    '{n} missing beat scene(s) will be created.': '将创建 {n} 个缺失的节拍场景。',
    'Existing scene files are never deleted when applying a structure.': '应用结构不会删除现有场景文件。',
    'Apply mode': '应用方式',
    'Merge keeps the current structure. Replace uses the selected scene-handling rule.': '合并会保留当前结构；替换会按所选规则处理现有场景。',
    'Merge with current structure': '合并到当前结构',
    'Replace current structure': '替换当前结构',
    'Existing scenes': '现有场景',
    'Choose how current act and chapter assignments are handled.': '选择如何处理现有场景的幕和章节归属。',
    'Keep existing numbering': '保留现有编号',
    'Remap to the new structure': '重新映射到新结构',
    'Move to uncategorized': '移到未分类',
    'Create one placeholder scene for every missing beat.': '为每个缺失节拍创建一个占位场景。',
    'Optional fields and Markdown body for generated beat scenes.': '为生成的节拍场景选择可选字段和 Markdown 正文。',
    'Applied "{name}": {changed} scene(s) updated, {created} created.': '已应用“{name}”：更新 {changed} 个场景，新建 {created} 个场景。',
    'Could not apply structure: {message}': '无法应用结构：{message}',
    'Quick Structure Generator': '快速结构生成器',
    'Generate a regular act/chapter structure. Use Template Center when you want named beats or a reusable custom structure.': '生成规则的幕章结构；如需命名节拍或可复用的自定义结构，请使用模板中心。',
    'Generate Structure': '生成结构',
    'Generated {acts} act(s), {chapters} chapter(s), and {scenes} scene(s).': '已生成 {acts} 幕、{chapters} 章和 {scenes} 个场景。',
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
    [`## Goal
What does the POV character want in this scene?

## Conflict
What stands in their way? Who opposes them?

## Action
Describe the key beats of the scene.

## Outcome
How does the scene end? What changes for the character?`]: `## 目标
视角角色在这个场景中想要什么？

## 冲突
什么阻碍了角色？谁在反对角色？

## 行动
写下这个场景的关键节拍。

## 结果
场景如何结束？角色发生了什么变化？`,
    [`## Setup
Where are the characters, and what brought them here?

## Dialogue Focus
What is the conversation about? What subtext is at play?

## Emotional Stakes
What does each speaker want from this exchange?

## Takeaway
How has the relationship shifted by the end?`]: `## 情境
角色身在何处？什么让他们来到这里？

## 对话焦点
这场谈话围绕什么？潜台词是什么？

## 情感利害
每位说话者想从交流中得到什么？

## 余波
谈话结束时，人物关系发生了什么变化？`,
    [`## Trigger
What in the present triggers this memory?

## The Memory
Describe the past event in vivid detail.

## Emotional Weight
Why does this memory matter now?

## Return to Present
How does the character feel after reliving this?`]: `## 触发点
当下的什么事触发了这段回忆？

## 回忆
具体描写过去发生的事。

## 情感分量
为什么这段回忆此刻如此重要？

## 回到当下
重历往事后，角色有什么感受？`,
    [`## Hook
What grabs the reader's attention on page one?

## World & Setting
Establish time, place, and atmosphere.

## Character Introduction
Who is the POV character? What do they want?

## Inciting Moment
What disrupts the status quo?`]: `## 钩子
第一页用什么抓住读者？

## 世界与环境
交代时间、地点和氛围。

## 角色登场
视角角色是谁？角色想要什么？

## 诱发事件
什么打破了原有状态？`,
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
    'When enabled, YAML frontmatter is included in the exported document. Disabled by default.': '启用后，导出文档中会包含 YAML 属性。默认关闭。',
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
    'Configure PDF export on desktop (page size, margins, and fonts). Generation uses Electron print-to-PDF.': '配置桌面端 PDF 导出（页面尺寸、页边距与字体）。生成使用 Electron 的打印转 PDF。',
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
    'When enabled, YAML frontmatter is included in the exported PDF. Disabled by default.': '启用后，导出的 PDF 中会包含 YAML 属性。默认关闭。',
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
    'Additional Source Folders (Experimental)': '其他源文件夹（实验性）',
    '⚠ Experimental — back up your files before linking external folders. Files in linked folders may be modified when you edit entities in NarrativeLab.': '⚠ 实验性功能 — 链接外部文件夹前请备份文件。在 NarrativeLab 中编辑实体时，链接文件夹中的文件可能会被修改。',
    'Point NarrativeLab to any folder in your vault. All .md files inside will be scanned and automatically sorted by their frontmatter type: field.': '选择仓库中的任意文件夹。NarrativeLab 会扫描其中所有 .md 文件，并按 YAML 属性中的 `type` 字段自动分类。',
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

    // Interface completeness and operation feedback
    'Color': '颜色',
    'Please enter a name': '请输入名称',
    'Double-click to open': '双击打开',
    'Click to hide entries not in “{book}”': '点击后仅显示“{book}”中的条目',
    'Click to show all series entries': '点击显示系列中的所有条目',
    'Loading Base…': '正在加载 Base…',
    'Loading...': '正在加载…',
    'Retry': '重试',
    'Move up': '上移',
    'e.g. "Our heroes arrive in the capital…"': '例如：“主角一行抵达王都……”',
    'Moved "{name}" to the shared series Library': '已将“{name}”移至系列共享资料库',
    'Moved "{name}" to the current project Library': '已将“{name}”移至当前项目资料库',
    '{words} words · {scenes} scenes': '{words} 字 · {scenes} 个场景',
    'POV: {name}': '视角：{name}',
    'No scenes to export': '没有可导出的场景',
    'Exported to {filename}': '已导出到 {filename}',
    'Saved as {filename}. Open it in a browser to print as PDF.': '已保存为 {filename}。请在浏览器中打开并打印为 PDF。',
    'CSV exported: {path}': 'CSV 已导出：{path}',
    'Exporting to Word…': '正在导出 Word…',
    'Exporting to PDF…': '正在导出 PDF…',
    'PDF export requires the Obsidian desktop app.': '只能在 Obsidian 桌面端导出 PDF。',
    'Project "{title}" created': '已创建项目“{title}”',
    'Failed to create project files or folders: {error}': '创建项目文件或文件夹失败：{error}',
    'Project "{title}" was not found. It may have already been deleted.': '找不到项目“{title}”，它可能已被删除。',
    'Project "{title}" deleted.': '已删除项目“{title}”。',
    'Copied "{source}" to "{target}" ({count} scenes)': '已将“{source}”复制为“{target}”（{count} 个场景）',
    'scene': '场景',
    'Create "{name}"': '创建“{name}”',
    'Update "{name}"': '更新“{name}”',
    'Delete "{name}"': '删除“{name}”',
    'Delete scene': '删除场景',
    'Scene file not found': '找不到场景文件',
    'Note file not found': '找不到笔记文件',
    'No active NarrativeLab project. Open one first.': '当前没有 NarrativeLab 项目。请先打开一个项目。',
    'Selected file is not a Markdown note.': '所选文件不是 Markdown 笔记。',
    'This file is already a scene.': '该文件已是场景。',
    'This file is already a note.': '该文件已是笔记。',
    'This file is already a research post.': '该文件已是研究资料。',
    'Converted "{name}" to a scene.': '已将“{name}”转为场景。',
    'Converted "{name}" to a note.': '已将“{name}”转为笔记。',
    'Converted "{name}" to research.': '已将“{name}”转为研究资料。',
    'Failed to convert binder item: {err}': '转换失败：{err}',
    'Convert to Note': '转为笔记',
    'Convert to Research': '转为研究',
    'Archived "{name}"': '已归档“{name}”',
    'Archived file not found': '找不到已归档文件',
    'Restored "{name}" from the archive and assigned a new sequence number': '已从归档恢复“{name}”，并分配新序号',
    'Update tags for "{name}"': '更新“{name}”的标签',
    'Drafts moved into Scenes subfolders': '已将草稿迁移到 Scenes 子文件夹',
    'Draft folder created: {path}': '已创建草稿文件夹：{path}',
    'Draft folder removed: {name}': '已移除草稿文件夹：{name}',
    'Removed {count} missing draft folders': '已移除 {count} 个不存在的草稿文件夹',
    'Split "{name}" into two scenes': '已将“{name}”拆分为两个场景',
    'Merged {count} scenes into "{name}"': '已将 {count} 个场景合并为“{name}”',
    'Series "{name}" created': '已创建系列“{name}”',
    'Project added to series "{name}"': '已将项目加入系列“{name}”',
    'Project removed from series "{name}"': '已将项目移出系列“{name}”',
    'Before moving a project into a series, set "New link format" to "Shortest path when possible".': '将项目移入系列前，建议把“新链接格式”设为“尽可能使用最短路径”。',
    'Snapshot "{name}" saved': '已保存快照“{name}”',
    'Snapshot restored': '已恢复快照',
    'Undo: {action}': '撤销：{action}',
    'Undo failed: {message}': '撤销失败：{message}',
    'Redo: {action}': '重做：{action}',
    'Redo failed: {message}': '重做失败：{message}',
    'Classify Scrivener folders': '分类 Scrivener 文件夹',
    'These Scrivener folders do not match a standard category. Choose how to import each one.': '以下 Scrivener 文件夹无法匹配标准类别。请分别选择导入方式。',
    'Library category': '资料库类别',
    'Scenes (manuscript)': '场景（文稿）',
    'Skip': '跳过',
    '{count} items': '{count} 项',
    'Continue import': '继续导入',
    'Creating series "{name}" with {count} projects…': '正在创建系列“{name}”（{count} 个项目）…',
    'Importing… {processed}/{total}': '正在导入… {processed}/{total}',
    'e.g. 5': '例如：5',
    'e.g. 1943': '例如：1943',
    'Could not find an available attachment path.': '找不到可用的附件路径。',
    'Cannot parse {path}; the file was left unchanged.': '无法解析 {path}；文件未作修改。',
    'Narrative Canvas did not finish loading.': 'Narrative Canvas 未能完成加载。',
    'Scene not found': '未找到场景',
    'Select at least two scenes to merge.': '请至少选择两个要合并的场景。',
    'Some selected scenes could not be found.': '部分所选场景无法找到。',
    'Primary scene file not found.': '未找到主场景文件。',
    'This Scrivener 1.x project uses an unsupported format. Open it in Scrivener 3 to convert it, then import it again.': '此 Scrivener 1.x 项目使用了不支持的格式。请先用 Scrivener 3 打开并转换，然后重新导入。',
    'No .scrivx file was found in the selected folder.': '所选文件夹中没有 .scrivx 文件。',
    'This appears to be a Scrivener iOS stub without binder data. Open it in Scrivener desktop to sync the full project, then try again.': '这似乎是缺少活页夹数据的 Scrivener iOS 占位项目。请先用桌面版 Scrivener 打开并同步完整项目，然后重试。',
    'Import cancelled.': '已取消导入。',
    'Series name "{name}" matches the current project folder. Choose a different name, such as "{name} Series".': '系列名称“{name}”与当前项目文件夹同名。请换一个名称，例如“{name} 系列”。',
    'Invalid series folder: series.json was not found.': '系列文件夹无效：未找到 series.json。',
    'Series folder "{name}" has the same name as the project folder. Rename the project or series before adding it.': '系列文件夹“{name}”与项目文件夹同名。请先重命名项目或系列。',
    'Project is not in a series.': '项目不属于任何系列。',
    'Cannot determine the series folder.': '无法确定系列文件夹。',
    'Invalid series metadata.': '系列元数据无效。',
    'Series migration requires “Automatically update internal links”. Enable it under Settings → Files & Links, then try again.': '迁移到系列前，需在“设置 → 文件与链接”中启用“自动更新内部链接”，然后重试。',
    'Before moving a project into a series, enable “Automatically update internal links” under Settings → Files & Links.': '将项目移入系列前，建议在“设置 → 文件与链接”中启用“自动更新内部链接”。',
    '{title} Series': '{title} 系列',
    'Cannot move "{source}" into its own subfolder "{destination}". Choose a different destination name.': '不能将“{source}”移入其自身的子文件夹“{destination}”。请选择其他目标名称。',
    'File not found': '未找到文件',
    'No saved content is available to restore this file.': '没有可用于恢复此文件的已保存内容。',
    'No saved content is available to recreate this file.': '没有可用于重新创建此文件的已保存内容。',
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
    const normalized = coerceString(value).trim().toLowerCase();
    return normalized === 'en' || normalized === 'zh' ? normalized : 'auto';
}

function isChineseLocale(value: unknown): boolean {
    const normalized = coerceString(value).trim().toLowerCase();
    return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('中文');
}

export function getObsidianInterfaceLanguage(app: App): UiLanguage {
    const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
    const rawNavigatorLanguages: unknown = window.navigator?.languages;
    const navigatorLanguages: unknown[] = Array.isArray(rawNavigatorLanguages)
        ? rawNavigatorLanguages as unknown[]
        : [];
    const values: unknown[] = [
        vault.getConfig?.('interfaceLanguage'),
        vault.getConfig?.('language'),
        vault.getConfig?.('locale'),
        (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.(),
        activeDocument?.documentElement?.lang,
        window.navigator?.language,
        ...navigatorLanguages,
    ];
    const detected = values.find(value => coerceString(value).trim().length > 0);
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
    return localizeForLanguage(activeLanguage, source, replacements);
}

/**
 * Translate a chrome string for a specific language without changing the active UI language.
 * Used when seeding player-editable defaults from Obsidian's interface language.
 */
export function localizeForLanguage(
    language: UiLanguage,
    source: string,
    replacements: Record<string, string | number> = {},
): string {
    const translated = language === 'zh' ? (ZH[source] ?? source) : source;
    return Object.entries(replacements).reduce(
        (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
        translated,
    );
}

/** Obsidian UI language for one-shot seeds (zh/en only; anything else → en). */
export function seedUiLanguage(app: App): UiLanguage {
    return getObsidianInterfaceLanguage(app);
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

/** Localize built-in scene template labels and Markdown body. Custom copy passes through unchanged. */
export function localizeSceneTemplate(template: SceneTemplate): SceneTemplate {
    return {
        ...template,
        name: t(template.name),
        description: template.description ? t(template.description) : undefined,
        bodyTemplate: template.bodyTemplate ? t(template.bodyTemplate) : '',
        defaultFields: { ...template.defaultFields },
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
    if (root.instanceOf(Element) && (isDocumentShell(root) || isLocalEntityElement(root))) return;

    const doc = root.instanceOf(Document) ? root : root.ownerDocument ?? activeDocument;
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

    const elements: Element[] = root.instanceOf(Element)
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
    const element = node.instanceOf(Element) ? node : node.parentElement;
    if (!element || isDocumentShell(element)) {
        const scope = isDocumentShell(element) ? element : activeDocument?.body;
        if (!scope) return;
        const localized = new Set<Element>();
        for (const root of Array.from(scope.querySelectorAll(PLUGIN_UI_SELECTOR))) {
            if (!isPluginUiRoot(root)) continue;
            const target = root.closest('.modal-container:not(.mod-dim)') ?? root;
            if (isDocumentShell(target) || localized.has(target)) continue;
            localized.add(target);
        }
        for (const target of outermostElements(localized)) localizeElement(target);
        return;
    }

    if (isLocalEntityElement(element)) return;

    const containingRoot = element.closest(PLUGIN_UI_SELECTOR);
    if (containingRoot && isPluginUiRoot(containingRoot)) {
        // This path is called by the global MutationObserver. Localize only the
        // inserted branch; walking the entire view once for every new card made
        // large Chinese Library views progressively slower.
        localizeElement(element);
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
    }
    for (const target of outermostElements(localized)) localizeElement(target);
}
