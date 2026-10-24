# 耕读离线题包批量转换

日期：2026-10-23。用户授权将耕读合集内 `离线题包/测试`、`离线题包/数学`、`离线题包/英语` 全部分别转换为 SAT 新协议。主输入是已经整理过图片的离线 JSON，不是合集外层的另一份原始 JSON 副本。

| 分类 | 原 JSON | 来源题目 |
| --- | ---: | ---: |
| 测试 | 48 | 3498 |
| 数学 | 47 | 955 |
| 英语 | 181 | 3856 |
| 合计 | 276 | 8309 |

英语保留阅读、语法子目录。一个源文件对应一个独立题集，再按实际内容拆为读写四选一、数学四选一、数学填空包；不生成空类型包，不合并不同来源的重复题。原 8309 个来源题目 ID 全部不同，750 组内容重复仍各自保留出处。

## 输出与加载

```text
local-data/sat-packs/gengdu-offline/
  README.md
  catalog.json
  source-identities.json
  全真模考.zip / 数学真题.zip / 英语真题.zip
  全真模考.zip.sha256 / 数学真题.zip.sha256 / 英语真题.zip.sha256
  全真模考/<原名缩写--身份前缀>/
  数学真题/<原名缩写--身份前缀>/
  英语真题/{阅读,语法}/<原名缩写--身份前缀>/
    conversion-report.json
    assessment.json                 仅严格完整 SAT 存在
    <实际题型包>/{pack.json,items.json,solutions.json,assets/}
```

每个分类 ZIP 包含该分类的全部转换结果、资源、目录索引、使用说明与逐文件 SHA 清单。2026-10-24 已移除 Add Questions 的旧手动导入界面；现有题集由 Start Practice / Practice Builder 读取配置的题库目录（见 [SAT 模块](sat/README.md)），解压 ZIP 本身不会切换 `active.json`。

目录名称按用户后续整理统一为“全真模考”“数学真题”“英语真题”。`catalog.json` 的 `category`、`categories` 及身份表键仍保留来源“测试”“数学”“英语”，用 `categoryDirectories` 显式映射显示目录；每条 `directory`、`reportFile`、身份表目录和 ZIP 内路径同步到新名称。“全真模考”是来源分类名，不把其中非完整的题集标成完整 SAT。

本次转换不激活这些题集，不修改当前“26年3月美国A卷”模考、不清除浏览器库或个人历史。转换输出、压缩包、资源缓存和详细审计仍在忽略的 `local-data/`。2026-10-23 用户后续已完整复制题库到 `back-end/question-banks/sat-packs/gengdu-offline/`，明确授权这份题库与必要图片可提交 GitHub；统一服务默认读取共享副本。转换工具的默认输出位置不变，不自动覆盖共享副本；重复 ZIP 及对应校验文件仍忽略，个人记录和备份不提交。

## 身份、模块与审核

`source-identities.json` 为每份来源保存随机 UUID，重跑时复用；题目 ID 另含原 `question_id`。不依赖题干摘要、数组下标或重命名来重新生成身份，也避免与先前活动卷的旧导入 ID 冲突。重新转换时保留身份表；源字节变化会停止并要求明确审核。对转换实现带来的内容修订，应对照上一版提升受影响题目和包的修订，同步 assessment 和原顺序引用，原输出先保留为备份，不覆盖历史语义。

原题号、模块编号及输入数组顺序保存在各 `conversion-report.json` 的 `sourceOrder`。测试目录有 18 份题号连续的标准 98 题四模块试卷，为其生成现有 `sat-assessment/0.1-draft`，明确 27/27/22/22 题及 32/32/35/35 分钟。另有 1 份 98 题的读写第二模块源题号缺 12、13 却有 28、29，2 份 98 题采用读写模块 1/3，25 份仅英语 54 题（含 3 份模块 1/3），以及 52、38 题各一份；它们保留题库及来源映射，不猜测自适应分支、重编号或补成完整 SAT。专题题库的题号无需连续，模块 3 也按源保留。

全部来源答案仍为 `needs-review`。502 题有有效来源解析，保留并标待审；7807 题无解析，保存 `missing`，不生成解析。来源另有 12 份“非空 HTML”仅为 `<br>` 或空布局标签，不算有效解析，未丢弃任何独立正文。不带入学生已选答案、笔记、分数或练习时间。不能把来源 `confirmed/complete` 当作本项目已复核答案或完整官方模考的证明。

## 公式、表格与资源

- 文字继续使用 Markdown，公式继续使用 LaTeX；3102 个 MathQuill 公式节点都有 `latex-data`。隐藏编辑器 textarea 不导入。公式内比较符号按等价 `\lt/\gt` 规范化，避免被 Markdown 合同误认作 HTML。
- 来源尾部合法的 TeX 控制空格 `\ ` 在去普通首尾空白前等价写为 `\space{}`，避免孤立反斜线转义掉 Markdown 闭合符。原/新片段及处理原因均记录，不删数学内容或推测公式。
- 非空上标、下标和嵌套公式保留。源端把整句或 `2=` 放进上标的排版异常保留原内容并警告，不猜测作者原意；纯空白节点才可忽略。
- 普通显式 HTML 表格转静态 SVG，正常空白表角允许保留；4 个含公式的选项表转现有 GFM Markdown 表格，保留格值与公式。这不是新增结构化图表协议。源 `latex-data` 与可见 DOM 不一致的内容进入待审记录，不静默裁定哪一份正确。
- 图片先核对合集已归档字节、SHA、MIME 和路径。5 个超出现有静态 SVG 子集的来源资源在完全阻断网络、仅作为图片加载的隔离浏览器中转为 PNG；保留原 SVG，记录原/新 SHA、尺寸和方法，不放宽前端 SVG 白名单，不重画或猜测坐标数据。
- 10 个失效 Windows 临时图链接都有 WPS 剪贴板路径、图像显式 0/1×1 px、祖先绝对定位及 0/1 px 宽度的共同证据；仅这些无信息布局残留被移除并逐题记录，不能称为已找回图片。其他真正缺图继续报错。
- SPR 来源的超长小数拼写只在有完全等值合法来源写法时省略重复拼写，或移除可选的整数部分 0（如 `0.0588` → `.0588`）。每次都核对精确有理数相等并记录，不四舍五入，不扩大输入限制。

详细来源与资源审计位于 `local-data/agent-output/2026-10-23/`。包内逐题报告保存具体来源问题，不能把“格式校验通过”解释成题意、答案或来源排版已全部核定。

交接后对最终产物补跑全量浏览器检查：363 个题型包、8309 题、55875 个内容字段、3692 个公式、331 个公式 SVG 绘图和 639 个独立资源全部完成导入/渲染检查；导入、公式渲染、公式几何、图片解码、公式分隔符、页面、HTTP 和外部请求错误均为 0。31 条 Unicode 公式警告继续保留来源待审，不改写其题意。报告为 `local-data/agent-output/2026-10-23/gengdu-offline-browser-report.json`。

## 重复执行

Python 转换及打包只用标准库。先前已准备好的 SVG 衍生缓存可直接复用：

```sh
python3 back-end/tools/sat/convert_gengdu_offline.py \
  --image-cache local-data/cache/gengdu-svg-raster/manifest.json
```

已有输出时加 `--replace`；先前输出会保存在 `local-data/backups/`。工具保留逐文件身份与修订，最终只发布通过校验的包，失败源在 catalog 中明确标记，返回非零状态；不会把半个源文件冒充完整题集。

仅目录名称整理或索引落后时，使用以下命令同步目录、索引、身份表、说明和分类 ZIP，不重新转换题目，不改变题目 ID、修订或资源字节。它接受旧名称目录或已人工改好的新名称目录；旧/新目录同时存在、身份不一致或包校验失败时停止。旧索引和 ZIP 先备份到 `local-data/backups/gengdu-index-before-*`。

```sh
python3 back-end/tools/sat/convert_gengdu_offline.py --sync-index
```

若需从原 SVG 重新建立缓存，使用开发环境已有的 Node.js、Playwright 与 Chrome，无需改变网站运行依赖：

```sh
node back-end/tools/sat/prepare_gengdu_svg_assets.cjs \
  "local-data/references/Reference Folders/耕读合集" \
  local-data/cache/gengdu-svg-raster
```

该缓存必须显式传给转换器；转换器仍核对原图摘要及衍生 PNG 的摘要、尺寸和路径，不因有缓存而跳过验证。

检查命令：

```sh
python3 -B -m unittest discover -s back-end/tests -p 'test_convert_gengdu*.py' -q
node back-end/tests/gengdu-svg-raster.test.cjs
```
