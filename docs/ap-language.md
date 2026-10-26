# AP Language and Composition

## 范围与入口

AP 本机应用位于 `front-end/ap/`，从统一首页 **AP** 大卡片中的“英语语言与写作”课程或 `/ap/` 进入；MCQ / FRQ 在课程目录内筛选，`?kind=mcq|frq` 预选参数继续兼容。管理页面沿用 Study Space 的暖白背景、白色面板和共享样式变量。按用户要求，作答阶段参照 SAT/Bluebook 界面：浅蓝顶栏、居中计时、双阅读/作答栏、深蓝题组条、底部题号导航和翻题按钮；FRQ 左侧题目/材料、右侧编辑器。样式限定在 `body.ap-exam-active`，不改变 SAT 考试阶段或其素材。原生 HTML/CSS/JavaScript，无新增前端依赖或构建步骤。

2026-10-26 通过 GitHub Git 远端获取最新主分支 `c6a7fd0`，核对 `front-end/sat/css/exam.css` 与 `front-end/sat/html/index.html`（主分支已迁目录）；此次已适配最新主分支目录及统一账号，保留其 SAT/TOEFL 功能。布局参照不等于复制 SAT 全部工具功能：未加入 SAT 的高亮/笔记、选项排除、分栏拖动或数学工具，不展示无功能占位按钮。

- 按年份、题型和关键词查找本机材料。
- MCQ 选择、提交、复盘与错题本。只有选项和独立答案键通过导入检查的题目才自动判对错；缺少答案不算错，也不进入正确率分母。
- FRQ 写作、字数、草稿和原卷/评分标准复盘；不提供 AI 评分、AP 1–5 分估算或官方成绩。
- 文字无法可靠提取的扫描卷保留 PDF 阅读入口，结构化题数为 **0**，不能伪装成已解析题目。
- 原创合成示例由用户主动打开，不混入真实题库，不计入首页真实练习统计。

该功能不是 College Board 官方产品。持有文件并不等于拥有公开分发授权；部分材料自带禁止电子再分发的声明。真实 PDF、提取文本、题库和练习记录均不得推送至 GitHub 或公开网站。只处理有权使用的本机材料。

## 启动

Python 3.10+；可选 Node.js 22.13+ 用于同站点 TOEFL 匿名样例，AP 本身不需要 Node 运行时。

```sh
python3 back-end/server/serve_platform.py --port 8888
```

Windows 可用 `py -3` 或 `python` 代替 `python3`，取决于安装方式。打开 `http://127.0.0.1:8888/ap/`。本机服务只监听回环地址；需使用统一本机账号登录。Cloudflare 同样要求登录，但账号及记录与本机服务独立。

未导入时显示真实空态，可以主动体验原创示例。Git 克隆不会得到真实题目；不要把未导入误认为加载故障。

## 私有 PDF 导入

另需安装 Poppler 命令行工具，使 `pdftotext`、`pdfinfo` 在 `PATH` 中可用（Windows/macOS/Linux 分发方式不同）。不需要 Python 第三方包，不安装 OCR 模型、不上传至 AI 或远端服务，也不恢复 SAT 已删除的 OCR 管线。

```sh
python3 back-end/tools/ap/import_ap_language.py --source-root "/path/to/authorized/AP-materials"
# 或直接读取 ZIP，不修改原始压缩包
python3 back-end/tools/ap/import_ap_language.py --archive "/path/to/authorized/AP-materials.zip"
```

输出固定在当前仓库忽略的 `local-data/`：

| 路径 | 内容 |
| --- | --- |
| `question-banks/ap/*.json` | AP v2 题组与来源/警告 |
| `question-assets/ap/<sha256>.pdf` | 内容寻址的原卷和参考文件 |
| `ap-import-manifest.json` | 来源追踪、去重与可重复导入记录 |
| `ap-import-report.json` | 实际数量、跳过项、待检查项目 |

完整相同 PDF 按 SHA-256 去重，不使用模糊语义去重。题组 ID 按来源相对路径稳定生成，`revision` 随内容变化；重复运行不能覆盖已修改的本机题库。确认替换后使用 `--replace`；仅清理上次导入清单中、内容仍与上次指纹一致的过期题组，不删除无关题库或旧 PDF，不迁移任何浏览器个人历史。清单用来源路径哈希追踪，报告记录年份、卷别、类型和跳过原因，不保存个人绝对路径。

导入检查不是人工审题：文字可提取不代表图表、脚注、排版和页码完全正确。FRQ 保留逐题原卷页码，特别是 synthesis 的 Source A–F 图表/漫画必须以原卷为准。无法可靠识别的题目退回原卷阅读，不猜测题干、选项或答案。扫描件不执行 OCR，无法自动识别像素中的手写姓名/答案；使用前仍需人工检查。发现疑似个人信息/已填写表单等时保守跳过，不声称已审查全部扫描页。官方匿名评分示例与个人旧作答记录要明确区分。

年份、Form / Set、参考材料的配对只按明确来源匹配；无法可靠配对的评分/统计资料单独作为参考条目，不自动挂到其他年份或卷别。图表不转换成虚构文字。每套题的 `importWarnings` 和导入报告记录限制。

## 本机验收记录（2026-10-23）

本轮授权材料共 187 份 PDF，按 SHA-256 去重为 169 份；实际保留 150 份私有资源，19 份因禁止内嵌附件的保守规则而跳过。逐文件检查附件目录后，确认它们都含印刷设置 `.joboptions` 附件，未发现这 19 份含 JavaScript；这不等于发现恶意代码或个人记录。附件内容未进一步审阅，本轮不自动剥除附件、修改原卷或绕过检查，所有源文件未修改。

- 102 个目录条目：34 个可练习题组、5 个仅原卷阅读的扫描题组、63 个独立参考条目；另有 48 份评分/示例文件明确配对到题组。
- 360 道结构化题目：274 道 MCQ（218 道可依据独立答案键判分，56 道不判分）、86 道 FRQ（全部需自评或教师评阅）。这不是压缩包全部题目的人工录入完成声明。
- 扫描题组为 2007、2016、2017、2018、2024 年材料，不生成占位题；Student Performance Q&A 归入参考，不误算为 FRQ。
- 1999 年 FRQ 第 2 题原卷因版权省略阅读材料，未生成不完整题目。2001 年 MCQ 的答案/解析存在可靠性问题，54 题均不启用自动判分；2012 年第 29 题、2013 年第 52 题在答案键中撤回，不判分。
- 最终版本全量重复导入：0 个题组重写、102 个题组未变；150 份资源、102 份题库及清单的大小/修改时间不变。187 份源文件 SHA 与导入前一致。
- 逐文件跳过原因、年份/卷别及待核对警告见本机 `local-data/ap-import-report.json`。以上数字是这一份本机材料的验收记录，不是克隆 Git 后自带题库，也不代表全部来源完成视觉隐私审查。

## AP v2 数据契约

单选 v1 不能表达 essay、评分标准和整卷 PDF，所以 AP Language 使用独立的 v2 扩展，由 `back-end/shared/ap_schema.py` 严格验证。SAT 与其余 v1 接口不变；不对所有考试盲目升级 schema。

必需题组字段：

```text
schemaVersion: 2
exam: "ap"
subject: "english-language"
id: "ap:<stable-slug>"
title, section, year (integer|null), form
kind: "mcq" | "frq" | "reference"
contentMode: "private" | "synthetic"
revision: SHA-256 hex
defaultDurationSeconds: nonnegative integer
documents: [{id, role, label, asset, pageCount}]
questions: [...]
importWarnings: [string]
```

- `documents.role` 为 `questions`、`scoring`、`sample` 或 `reference`。`asset` 只允许 `question-assets/ap/<64位小写sha256>.pdf`，不允许远端 URL、跨考试路径或目录穿越。
- 每题必需 `id`（所属题组加 `:q001`）、`type`、`number`、`prompt`、`passage`、`options`、`correctOption`、`explanation`、`pages`、`reviewStatus`、`answerProvenance`。
- `type` 为 `mcq` 或 `free-response`。后者必须有 `responseType`：`synthesis`、`rhetorical-analysis`、`argument` 或 `essay`；`options: []`、`correctOption: null`，不可自动判分。
- `correctOption` 为零基索引或 `null`；非空时必须是 `verified` 并注明答案来源。`reviewStatus` 另外允许 `needs-review`、`document-only`。`verified` 表示满足程序导入的结构/答案来源检查，不代表全卷经过人工视觉审校。
- 私有题必须提供 `sourceDocument` 和非空 `pages`，页码为 **PDF 物理页码，从 1 起**，不是印刷页码。可选 `answerDocument` / `answerPage` 指向答案或评分来源。
- 未知字段一律拒绝，不允许 `selectedAnswer`、姓名、已用时间等个人作答元数据混入。
- 参考资料和纯扫描卷可以没有结构化题目；不得通过占位题伪造题量。

原创完整示例见 `front-end/ap/examples/synthetic-practice.json`。不支持把历史 `exam: "ap", schemaVersion: 1` 文件未经转换直接交给新 AP 引擎；该情况会显示目录校验错误，不静默错误解释。当前接入前 AP 为占位，没有既有 AP 练习记录需要迁移。

## 服务 API 与资源边界

| 接口 | 用途 |
| --- | --- |
| `GET /api/exams/ap/sources` | `{exam, schemaVersion:2, sources, errors}`；不含个人历史 |
| `GET /api/exams/ap/sources/{id}` | 经过验证的完整 AP v2 文档 |
| `GET /api/ap/example` | 只提供明确标注为 synthetic、无私有文件引用的原创示例 |
| `GET /question-assets/ap/<sha256>.pdf` | 只允许有效 AP 题组引用的私有 PDF，支持单段 Range、HEAD |
| `GET /api/platform/catalog` | 原有四考试顺序不变，AP 数量来自真实本机题库 |

PDF 采用 `private, no-store`，按块读取，支持浏览器原生 PDF 查看器跳页。路径、符号链接、文件头与引用白名单均检查；目录原始 JSON 和未引用文件不能作为静态文件访问。AP 静态文件只允许应用的四个运行文件，不暴露源码目录或示例目录列表。没有 AP 写入 API，不新增上传口或云端记录接口。

本机用户仍可从内容 API 查看答案，这不是安全考试或保密判分系统。隐藏评分入口是练习交互，不是权限隔离。

## 浏览器数据与首页统计

AP 数据只使用 `school-exam-platform:account:<userId>:ap:*` 命名空间，按当前登录账号隔离，不迁移旧匿名记录。会话失效时停止计时并清空页面中的作答内容。草稿关联题组 ID 和 `revision`，版本不一致时不能静默套用，但仍能下载旧作答。记录仅在当前浏览器/来源地址，按账号隔离但不与其他设备同步；清除浏览器站点数据会删除它们。保留上限为 100 次历史、30 份草稿、2000 道错题，应及时下载重要作答；多标签页同时编辑仅提示冲突，不自动合并。计时规则见下节；不是严格监考计时器。

### 官方限时与练习时钟

2026-10-26 核对 [College Board AP English Language and Composition Exam](https://apcentral.collegeboard.org/courses/ap-english-language-and-composition/exam)：

| 部分 | 现行题量 | 限时 |
| --- | --- | --- |
| Section I — MCQ | 45 题 | 60 分钟 |
| Section II — FRQ | 3 题 | 135 分钟，**已包含** 15 分钟阅读 |

开始前可选择限时（默认）或自由练习；重练也回到设置页。纯 MCQ / FRQ 题组采用现行整部分限时，历史卷或缺题题组不因此成为现行完整模考，不按题数虚构官方限时。混合原创示例保留题组练习时长并明确非官方整卷。FRQ 前 15 分钟提示阅读，之后提示写作；不锁定编辑器，不把每篇 40 分钟称作强制官方限制。

- 保存 `timing: {durationSeconds, readingSeconds, paused, anchorAt}` 与累计 `elapsedSeconds`；纯模型按毫秒时间锚点计算，后台节流后补算，不依赖 interval 调用次数。
- 切换标签查看 PDF、刷新、关闭页面继续计时；“暂停”或“保存并退出”停止计时。暂停隐藏题目/输入，恢复草稿后需点“继续计时”。自由练习显示累计用时，同样可暂停。
- 到时显示 00:00 与提醒，不自动提交，不删除答案；仍可继续、下载或自行提交复盘。
- 老版无 `timing` 字段的草稿/历史继续兼容；首次恢复补时钟锚点，保留旧用时和旧限时，不追扣过去离线时间。浏览器 storage key 仍为 v1，源题库 schema 不变。
- 时钟使用本机时间，用户调系统时钟可能影响它；不是防作弊或严格监考。多标签同时编辑仍不支持合并。

首页读取 `school-exam-platform:account:<userId>:ap:history:v1` 的完成记录：`id`、`status: "completed"`、`finished`（毫秒时间戳）、`sourceId`、`revision`、`contentMode`、`questionCount`、`answeredCount`、`correctCount`、`gradedCount`、`title`。只汇总 private 完成记录，去重并拒绝未来时间和不合理计数。FRQ 只贡献真实已作答数量，不增加已判分数量。原创示例不增加首页真实题库学习进度。SAT/TOEFL 存储与行为不受影响。

## 主分支与公网边界

2026-10-26 用户授权合入 main 并更新现有 Cloudflare 网站。以最新 main 为基础适配 AP，而不是覆盖统一账号及目录迁移。另经用户确认合入此前已上线的 TOEFL AI 分支，避免发布 AP 时撤掉现有 AI 评分。

- Cloudflare 仅显式构建 AP 四个运行文件及原创示例；不扫描或上传 `local-data/question-banks/ap/`、原始 PDF、导入报告或个人记录。
- 公网目录是真实空库（AP v2），可以主动打开原创示例；不是已上传 102 份真实材料。
- AP 页面、示例 API 与题库 API 需登录；HTML 注入固定当前账号，与现有平台会话规则一致。
- AP 草稿、错题及历史只在当前浏览器按账号隔离保存，没有 AP 云端记录 API；SAT/TOEFL 现有云同步不变。
- 正式 AUTH、ACCOUNTS、BANK 的类名、对象名称和绑定不变，不初始化或清空生产数据。

## 检查命令

```sh
python3 -m unittest discover -s back-end/tests -p 'test_ap*.py' -v
node --test back-end/tests/ap-*.test.cjs back-end/tests/home-ap-entry.test.cjs
node back-end/tests/home-model.test.cjs
# Cloudflare（完整构建前先按文档安装锁定依赖）
cd back-end/cloudflare
npm run build
npm test
node tests/ap-browser-smoke.mjs
```

浏览器检查使用独立 Miniflare 临时数据库及 Chrome 配置，只创建匿名测试账号和原创示例作答，不使用生产账号或真实个人数据。详情及本轮实际结果见 [Cloudflare 部署](cloudflare-deployment.md)。原本机分支已验证 102 份真实目录、PDF HEAD/Range、MCQ/FRQ 官方计时；此记录不等于将它们部署到公网。未声称完成 macOS、其他浏览器或全部题目人工校对。
