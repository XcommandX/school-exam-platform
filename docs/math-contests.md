# 数学竞赛练习

## 当前范围

统一首页页脚的“数学竞赛”打开 `/contests/`。模块沿用 Study Space 的共享字体、暖白背景、白面板、圆角与橙/蓝强调色；样式限定于 `.contest-app`，没有修改 SAT 受保护的考试阶段。

- AMC10 / AMC12：按单个选项作答；多个被接受的答案中选择任意一个均有效。
- AIME：只接受一至三位十进制数字，范围 0–999；`0` 与 `000` 等价，参考答案显示三位。
- USAMO：保存证明草稿、查看参考解答，**不自动评分**。
- 四竞赛、年份、卷别搜索；补充卷默认不显示；缺题卷显示缺少题号，不冒充完整试卷。
- 收藏、错题本、练习记录、草稿保存于当前浏览器；首个检查结果固定，重开题目不刷高正确率。查看参考答案或解答后不再计入本题正确率。
- `quality` 的完整性、可练习、可判分标志必须全部通过，且不能有答案/题面争议；服务端和前端双重检查。所有参考解答显示未逐题核验提示。

没有倒计时模考、自适应考试、官方分数、AI 证明评分、正式认证或云同步。答案随题目由本机只读 API 提供，这不是防作弊考试系统。竞赛统计独立于首页现有 SAT/TOEFL 汇总。

## 启动与原创示例

需要 Python 3.10+；统一平台的 TOEFL 构建及 Node 测试需要 Node.js 22.13+。无需安装 npm / pip 包。

```sh
python3 scripts/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/contests/>。默认本机真实题库为空，**不会自动换成示例**。点击“原创示例”或打开 <http://127.0.0.1:8888/contests/?mode=example>，可体验四套原创小题集；它们不是历年真题，也不用于宣传真实覆盖率。Windows 可把 `python3` 换成 `python` 或 `py -3`。

页面仅从本机服务读取内容，不使用第三方 CDN、在线字体或外部评分服务。未经安装的公式资源会显示明确提示，并保留 LaTeX 原文；不是假装渲染成功。

### 一次性安装本机公式资源

```sh
python3 scripts/setup_contest_mathjax.py
```

脚本只下载固定 MathJax 3.2.2 的官方 npm 压缩包并校验内置 SHA512，解包浏览器 JS 与 LICENSE 到被 Git 忽略的 `private-data/contest-vendor/mathjax/`。不执行 npm、安装钩子或包脚本。服务启动时不下载任何东西。

离线机器可提前取得对应压缩包，并使用：

```sh
python3 scripts/setup_contest_mathjax.py --archive "/path/to/mathjax-3.2.2.tgz"
```

完整安装幂等；发现现有目录损坏时默认拒绝覆盖，检查后才使用 `--replace`。不要将生成目录加入 Git。前端只加载本机 `tex-svg.js` 与安全扩展，禁用 TeX 自动加载/require，禁止公式 URL、样式和自定义类属性。

## 导入真实题库（仅本机）

源目录需包含采集器产出的 [数据结构](#数据契约)：`data/problems.json`、`data/exams.json`、`data/exams/<id>.json` 和所引用的 `assets/`。全量记录与分卷记录必须一致。导入不会联网，不会重新爬取题目或读取浏览器历史。

```sh
python3 scripts/import_contest_bank.py --source-root "/path/to/usa-contest-bank" --acknowledge-rights
```

`--acknowledge-rights` 表示操作者已核对本机使用范围，**不授予任何原题/解答版权许可**。MAA、AoPS 及镜像各自权利仍适用；公开可读或镜像软件的开源许可不等于题目可以再分发。不得把题库目录上传 GitHub，或在未确认权利与身份控制前公开部署。

导入器会：

1. 用 Git 对真实目标路径执行 `check-ignore`，拒绝仓库外、非忽略目录或已经被跟踪的私有文件；检查源/目标各级符号链接与目录穿越。
2. 严格核对题目 ID、卷别、题号、题量、答案与全部资源 SHA256；只保留逐字段白名单，不复制学生已选答案、成绩、姓名、记录、HAR、PDF、数据库或任意元数据。
3. 清理 HTML 为有限静态标记，图片必须引用当前记录已声明的本地图示；SVG 禁止脚本、外链和活动内容。Asymptote 源码只作为文字，绝不执行。
4. 生成内容寻址版本，完整验证后原子切换 `private-data/contests/current.json`；失败不改已激活题库。相同内容重复导入不产生新版本。

不同题库版本需要显式替换：

```sh
python3 scripts/import_contest_bank.py --source-root "/path/to/updated-bank" --acknowledge-rights --replace
```

旧版本保留在 `private-data/contests/versions/`，不自动清理。回退可对之前的可信源重新执行导入并加 `--replace`；校验成功后指针切回对应版本。不要手动覆盖版本文件。更新题库后刷新页面，旧版本作答仍保留在历史列表，但不混入新版本统计或草稿。

## 数据契约

本模块**不改变**公共 SAT v1 schema，校验入口是 [contest_bank.py](../shared/contest_bank.py)，本机导入入口是 [import_contest_bank.py](../scripts/import_contest_bank.py)。

| 字段 | 含义 |
| --- | --- |
| `id`, `exam_id` | 稳定题目/试卷 ID |
| `contest`, `year`, `season`, `paper`, `number`, `special_paper` | 四竞赛、年份、春/秋/常规、卷别、题号及补充卷 |
| `question_type` | `multiple_choice`、`integer`、`proof` |
| `statement` | `text_latex`、清理后的 `html`、`html_includes_choices`；避免重复显示题面自带选项 |
| `choices` | 标签、LaTeX 文字和清理后的 HTML |
| `answer` | `choice` + `accepted[]`，或 `integer` + `value`，或 `null`；仅供练习 |
| `solutions` | 标题、文字/HTML、来源、`verification` 和质量标志；默认未经逐题数学核验 |
| `quality` | `flags`、`structurally_complete`、`ready_for_practice`、`auto_gradable`、`solutions_reviewed:false` |
| `source_url`, `provenance` | 来源链接（仅 HTTP/HTTPS）与有限来源字段 |
| `assets` | 当前题目实际引用的路径、摘要等有限资源元数据 |

试卷 `revision` 是完整规范化内容的 SHA256，覆盖题面、答案、解析、质量和资源；不只比较题目数量。试卷目录包含真实/预期题量、缺失题号、卷别以及版本，不伪造完整性。

### 路由

| 请求 | 内容 |
| --- | --- |
| `/contests/` | 前端入口，仅允许显式列出的源文件 |
| `GET /api/contests/catalog` | 本机试卷目录；未导入时为空 |
| `GET /api/contests/catalog?mode=example` | 显式原创示例目录 |
| `GET /api/contests/exams/<id>[?mode=example]` | 指定模式的一份试卷与版本 |
| `/contest-assets/assets/...` | 仅当前题库引用且通过校验的图示 |
| `/contest-vendor/mathjax/es5/...` | 校验过的本机公式 JS |

API 的 `mode` 为 `private` / `example`；目录含 `exams`、`totalProblems`、`errors`、`mathjaxAvailable`。不提供竞赛写入 HTTP 接口。私有目录、源题库、manifest 和示例源文件不能作为任意静态路径浏览。服务只监听 `127.0.0.1` 并校验 Host；这些约束不是公开部署需要的身份与访问控制。

## 浏览器记录

使用独立键 `school-exam-platform:contests:practice:v1`，不读取 SAT、TOEFL、旧采集预览或其他来源的个人记录。

- 作答主键为 `mode + examId + revision`；收藏为模式内稳定题目 ID。
- 证明草稿最大 20,000 字符；输入后即保存。浏览器拒绝/耗尽存储时显示警告，明确提示草稿尚未保存，当前页面仍可练习。不会按会话数量无声删除旧版本或最新记录。
- 只统计当前模式、当前题库版本的首次客观检查；证明、争议、只看答案的题目不计入正确率。
- “练习记录 → 清除本模式记录”需确认，保留收藏和另一模式的记录。
- 用 Web Locks 保证同一来源只有一个竞赛标签页写入：第二个标签页明确提示仅临时练习，不覆盖首个标签页的记录。关闭原标签页并刷新第二页后才能保存；不支持 Web Locks 的浏览器同样只临时练习。
- 本地身份 `admin` 不提供账号隔离；清除站点数据会删除记录，没有云备份。

## 验证与范围

从仓库根目录运行：

```sh
python3 -m unittest discover -s tests -v
node tests/home-model.test.cjs
node tests/contest-model.test.cjs
node tests/contest-browser.mjs
```

浏览器脚本需要安装 Chrome/Chromium；可用环境变量 `CHROME_PATH` 指定可执行文件，`PYTHON` 指定 Python。脚本自动启动随机端口的本机测试服务与全新浏览器配置，结束时关闭，所有截图/报告留在忽略的 `private-data/test-results/`。默认使用隔离空私库，先验证空态，再显式选择原创示例；真实来源截图不写入源码或 PR。

已在本机导入真实题库且安装 MathJax 后，可额外运行：

```sh
node tests/contest-browser.mjs --private
```

`--private` 检查本次配套的 4011 题/232 卷快照及代表性本地图示、2026 争议门控；换成不同快照时需调整该测试的预期，默认匿名检查不依赖真实题库。Python 测试覆盖规范化、隐私、哈希、路径/Host 边界和导入原子性；Node 模型测试覆盖多有效答案、整数边界、门控、首答锁定、版本/模式隔离和损坏存储。浏览器检查覆盖目录、作答/收藏/错题、证明草稿恢复、空解答不锁判分、参考答案门控、多标签写入保护、延迟目录/公式导航、恶意 HTML/TeX 的惰性处理、窄屏、减少动画、键盘打开后焦点、存储被拒绝及外部网络零请求。

实际交付测试结果以 PR 为准。不将本机 Windows 验证描述为 macOS、Safari、多账号或生产环境已验证。无正式发布或真实题库再分发。
