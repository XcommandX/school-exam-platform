# SAT 专用题目包草案

协议：`sat-question-pack/0.1-draft`。日期：2026-10-23。这里是原创结构样包，不能直接导入当前 SAT 引擎；没有实现新渲染器或判分器。

本轮采用每包一种 SAT 科目与作答类型：

| 样包 | section | responseType | 样题 |
| --- | --- | --- | --- |
| `rw-single-choice/` | `reading-writing` | `single-choice` | 2 道，含下划线与静态表格图 |
| `math-single-choice/` | `math` | `single-choice` | 1 道，含坐标图与 LaTeX 选项 |
| `math-spr/` | `math` | `student-produced-response` | 2 道，含多个正确值、分数与小数写法 |

这里的“题型”指作答方式。Algebra、Words in Context 等知识点放在 `classification`；可按知识点再分包，但不用另造协议。数学四选一和数学填空分别存包，组卷时跨包引用题目。原合集可包含混合试卷，导入时需拆包并另存原顺序映射。

## 文件

```text
pack.json          包身份、修订、科目、作答类型、文件位置、资源清单
items.json         有序题目，不含答案与解析
solutions.json     标准答案、解析、审核状态；出题端文件
assets/            实际图片；离线导出必须带齐
```

不要求每个专题题库附完整 `assessment.json`。正式试卷另保存模块、计时与 `{packId, packRevision, itemId, itemRevision}` 引用；包内数组位置只是默认浏览顺序。自适应路由、官方量尺分、计算器与 Desmos 接入不属于这次格式实现。

## 身份与题目

- `schemaVersion` 是协议版本，`revision` 是从 1 起算的内容修订；修改内容不重新生成 ID，而是增加修订。`id` 不来自数组位置、文件名或题干摘要。
- 题目 `id` 独立于题包，可在多个包复用；相同 ID 和修订的正文、选项及解答必须一致。历史记录应绑定题目及包修订，不能只保存题号。
- `content` 是材料，`prompt` 是提问；二者都是有序内容块。选项 `content`、解析 `content` 使用同一种内容格式。不再保存纯文本和 HTML 双副本或 UTF-16 样式区间。
- 四选项使用稳定 ID；A/B/C/D 由显示顺序生成。答案引用 `optionId`，不依赖数组下标。题目不得混入答案字段。
- `source` 保存内容出处，必填 `kind`，可选 `url`、`sourceSetId`、`sourceQuestionId`，均为字符串；样包仅使用 `kind: "original-synthetic"`。原卷位置另保存在明确白名单的迁移映射。不保存整理者姓名、学生选项、练习时间、分数、错题或笔记，也不接收任意 `customMetadata`。

## Markdown 与 LaTeX

`contentFormat: "markdown-latex/0.1-draft"` 明确所有文字采用 Markdown；本草案不再默认 plain。

```json
{"type":"markdown","text":"The value is $\\frac{2}{3}$.\n\n$$3x=2$$"}
```

- 行内公式使用 `$...$`，独立公式使用 `$$...$$`；JSON 中反斜线双写。金额美元符号使用 Markdown 转义，不能按任意一个 `$` 机械切分。
- Markdown 的段落、粗体、斜体、列表、显式换行与引用均须保留；诗歌换行需由内容明确表达。代码跨度/代码块里的美元符号不启动公式解析。渲染实现需再选定并锁定 Markdown 与数学插件版本。
- SAT 题目原有下划线需要保留。本草案仅允许静态 `<u>...</u>`，且禁止属性；这是受控的 Markdown 扩展。其他原始 HTML、脚本、事件属性、iframe 均不允许。渲染时先受限解析，再净化最终 HTML；学生交互高亮、Notes 另存作答记录。
- 图片使用独立 `image` 块及 `assetId`；Markdown 中不直接放图片链接。普通 Markdown 链接只能在明确的协议白名单内处理，不能当作自动加载资源。LaTeX 禁用外部资源、HTML 注入与自定义宏执行等能力。
- 不把源站 MathQuill 的整个 HTML 子树搬来：优先读取 `latex-data`，将公式节点整体替换成 LaTeX，避免混入隐藏 textarea 与重复字符。没有可靠公式源时保留原图并标为待审，不猜公式。

## 图片与待定图形

```json
{"type":"image","assetId":"line-graph","role":"coordinate-plane","alt":"A line through the labeled points (0, 1) and (2, 3)."}
```

`role` 仅表示用途，可为 `illustration`、`table`、`chart`、`coordinate-plane`、`geometry`；它不表示已经有对应数据渲染器。`alt` 描述学生可以从图中取得的信息，不添加答案提示。

清单保存 `id / path / mediaType / sha256 / byteLength / source`。路径只允许包内 `assets/` 相对路径，禁止绝对路径、外链、反斜线与目录穿越。原始 URL 可作来源信息，运行时按本地路径加载。相同资源可按内容摘要去重，但单个可交换包必须带齐依赖。

当前样包只使用原创静态 SVG；未来导入的 SVG 必须另行净化为无脚本、无外部引用的资源，或者转换成安全位图，不能直接执行来源 SVG。未知格式和缺失资源应使完整性校验失败，不补假图。

以下均是待定扩展，不列为当前已支持内容块：

| 内容 | 候选方案 | 仍需决定 |
| --- | --- | --- |
| 简单英语表格 | Markdown 表格、结构化表格、静态图 | 对齐、表头、读屏、窄屏表现 |
| 复杂英语表格 | 结构化 cells，或原图 | 合并单元格、脚注、单位、排版保真 |
| 统计图、函数图、坐标系 | 原图、受控 SVG、数据绘图 | 刻度、比例、误差线、断轴、标注与可访问性 |
| 教学互动图 | 作者图状态 + 静态替代图 | 选用工具、授权、导入安全与状态版本 |

因此暂用图片并非最终图表协议。禁止从截图推测数据后默默重画；原图和来源应保留。考试空白计算器与题干图形是两种功能，不给考试计算器预填解题表达式。

## 答案、解析与 SPR

`solutions.json` 按 `itemId + itemRevision` 与每题一一对应，不让题号兼任关联键。四选一引用选项 ID；SPR 没有 `options`，也不能凑出四个假选项。

- `answer.status`：`verified`、`needs-review`、`missing`。只有核对后的标准答案可为 verified；上游自称 `confirmed` 不等于本项目已复核，初次导入应映射为 needs-review。AI 建议也不自动升级。
- `explanation.status`：`provided`、`needs-review`、`missing`；没有解析时用 missing 与空内容数组，不编造正文。
- SPR 的输入语法限制与数学答案判定分开。`inputProfile` 是需复核的规则草案，不能因此宣称官方 Bluebook 行为已经实现。
- `acceptedRationals` 保存整数或分数字符串，精确有理数比较，多个值表示“任一即可”。`acceptedDecimalSpellings` 保存人工核对的小数写法；不把来源的逗号分隔答案整串当作一个答案，也不用全局浮点容差。
- 先检查输入是否合法、是否符合字符数限制，再判数值。比如 `4/6` 可与 `2/3` 精确等值；示例允许 `.6666`、`.6667`、`0.666`、`0.667`，拒绝 `.67`；这组名单只用于对应示例，不能套给所有题。
- 样包中的 verified 仅表示原创样题答案已按题意核算，不是 College Board 认证。练习答对数不能直接换算成官方 200–800 分。

缺失答案的最小形状为 `{"status":"missing","type":"single-choice"}`（SPR 将 type 换成 `student-produced-response`），不带选项或接受值。缺失解析为 `{"status":"missing","content":[]}`。有标准答案但无解析时，只有解析标 missing，不清空已知答案；needs-review 答案也不得作为已核定答案自动判分。

`visibility: "authoring-only"` 只是数据声明。正式考试服务必须剥离答案、解析和私有资源，不能把整个包静态公开后仅在界面隐藏。本机现有引擎仍客户端判分，本轮没有实现新的权限边界。

## 验证

在仓库根目录运行：

```sh
python3 docs/drafts/sat-question-packs/validate_examples.py
python3 -m unittest discover -s tests -p 'test_sat_pack_draft.py' -v
```

校验范围是此最小草案的字段、引用与资源完整性，不是生产导入器、Markdown/数学渲染或完整官方考试规则验证。完整比较与耕读资源整理情况见 [SAT 格式比较与新草案](../../sat-question-package-draft.md)。
