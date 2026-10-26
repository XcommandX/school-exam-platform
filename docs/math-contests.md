# 数学竞赛：本机题库、普通练习与限时练习

## 范围与发布状态

AMC 10、AMC 12、AIME、USAMO 是独立的竞赛模块，不复用或改写 SAT 考试引擎，不改变 TOEFL 题库与评分。入口为 `/contests/`，沿用 Study Space 页面与统一账号。

本说明描述 2026-10-26 的竞赛升级工作。**本轮没有合入 main，也没有发布新的线上版本**。既有 SAT / TOEFL Cloudflare 网站已经部署；不能由此推断竞赛升级也已上线。commit、push、merge、deploy 是不同操作。

- 真实竞赛题库、来源缓存、研究证据、导入产物和测试报告只留在忽略的 `local-data/`，不随 Git 或 Cloudflare 构建发布。
- Git 只带四份明确标记 `example: true` 的原创示例，每项竞赛一题；它们不是官方真题，不代表完整试卷。
- 默认 `private` 模式没有导入时显示真实空态；不会悄悄用示例冒充题库。用户主动选择示例后才使用 `mode=example`。
- 账号登录是访问条件，但**竞赛作答、收藏和限时记录目前仅在本浏览器按账号保存，不同步到 SQLite / Durable Objects，不跨设备同步**。

## 本机启动与访问

要求 Python 3.10+、Git；Node 22.13+ 用于检查及现有 TOEFL / Cloudflare 构建。依赖和统一账号初始化沿用 [项目说明](../README.md) 与 [统一账号](unified-auth.md)，不要另建固定密码或旁路登录。

从仓库根目录执行：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

Windows 可用 `python` 替代 `python3`。在同一个地址登录后打开：

- `http://127.0.0.1:8888/contests/`：本机真实题库。
- `http://127.0.0.1:8888/contests/?mode=example`：主动进入原创示例。

本机账号与既有云站账号分开。浏览器存储按站点 origin 隔离，`localhost`、`127.0.0.1`、不同端口或不同浏览器不是同一份记录。

### 普通练习

1. 选择竞赛，按年份、关键词筛选试卷；补充卷由单独选项控制。
2. 打开试卷，按原题号导航。AMC 使用选项；AIME 接受 0–999 的一至三位整数（含前导零）；USAMO 保存证明草稿，不自动判分。
3. 仅在题目质量标记允许、结构与答案完整且不存在已标记分歧时自动检查。答案冲突、缺答案或证明题不产生伪造分数。
4. 首次有效检查结果锁定；先看参考答案再作答不计入正确率。普通练习统计不是官方竞赛总分。
5. 可收藏、查看历史、继续草稿。示例与真实题库分别统计；题库修订变化后旧记录保留，但不会被算进新修订的有效练习统计。

参考解答保留来源与审核状态：镜像解答不等于官方审核，`unreviewed_generated` 表示独立撰写但仍待审的生成解答。没有解答时明确显示缺失，不把最终答案伪装成完整证明。外部解答链接需用户主动打开，网站不自动抓取或嵌入全文。

## 限时练习

选择“限时”只进入准备状态；点击“开始计时”才创建或启动对应场次。开始后没有暂停：离开、关闭或刷新页面仍按绝对截止时间计时。返回时重新核对是否超时，不靠后台每秒定时器累积时间。

| 竞赛 / 年份 | 本实现时长 | 题号与场次 |
| --- | --- | --- |
| AMC 10 / AMC 12 | 75 分钟 | 整卷，标准 25 题 |
| AIME | 180 分钟 | 整卷，标准 15 题 |
| USAMO 1972–1995 | 210 分钟练习约定，早年限制见下文 | 单场，题 1–5 |
| USAMO 1996–2001 | 两场各 180 分钟 | 同一天；题 1–3 / 4–6 |
| USAMO 2002 起 | 两场各 270 分钟 | 两天；题 1–3 / 4–6 |

- 第二场须在第一场结束后**独立点击开始**；没有自动接着计时，也不把两场合并成一个长倒计时。日期描述用于说明赛制，浏览器不会强制等待到下一个自然日。
- 当前场次只允许填写该场题号。未开始、已结束或超时后只读；手动结束与到时都保留归档，不能恢复为进行中。
- 同一模式、试卷与修订存在未完成练习时，不能另开一场覆盖它；全部场次结束后可新建练习，旧场保留。
- 练习进行中不开放检查答案或参考解答；同卷仍有待开始场次时也不通过切换普通模式提前复盘。全部结束后才查看参考内容。
- 限时记录与普通练习统计分开，不产生官方成绩、排名或证明题自动评分。
- 示例与缺题试卷标注为示例/部分题限时练习，不声称是完整全真卷；没有收录题目的场次不可开始。
- 早年 AMC 12 来源（例如历史 AHSME）并非已逐年核定原赛制；本实现采用现代 75 分钟练习标准，并提示这一限制。

### 计时依据与证据边界

2026-10-26 的来源检查中，[MAA 2023 年报](https://2023report.maa.org/what-we-do)可达，其 USAMO 描述为六题、两天、九小时。[现行 AMC 入口](https://maa.org/student-programs/amc/)、[邀请赛入口](https://maa.org/maa-invitational-competitions/)、[2026–27 AIME 政策](https://maa.org/wp-content/uploads/2026/08/2026-27-AIME-Policies.pdf)、[2026–27 USAMO / USAJMO 政策](https://maa.org/wp-content/uploads/2026/10/2026-2027-USAMO_USAJMO-Policies.pdf)当次请求返回 403；不能写成“本轮已直接核验现行官方全文”。AMC 75 分钟与 AIME 180 分钟为本实现采用的现代标准，不把年报当成这两项时长的直接证据。

历史资料使用带 MAA 标识的第三方镜像，**未与官方原站文件逐字节独立认证**：

- [1989 年试卷](https://olimpicos.net/files/usamo/USAMO_1989_Q1-5.pdf)至 [1995 年试卷](https://olimpicos.net/files/usamo/USAMO_1995_Q1-5.pdf)镜像标注 3½ 小时，五题。
- [1996 年试卷](https://olimpicos.net/files/usamo/USAMO_1996_Q1-6.pdf)为 5 月 2 日 9–12 时和 13–16 时；[2001 年试卷](https://olimpicos.net/files/usamo/USAMO_2001_Q1-6.pdf)也是同日两场各三小时。此阶段不能套用现代“两天各 4½ 小时”。
- [2002 年试卷](https://olimpicos.net/files/usamo/USAMO_2002_Q1-6.pdf)为 5 月 3 日及 4 日各 13–17:30，支持分界后的两天各 270 分钟。
- [Klamkin《USA Mathematical Olympiads 1972–1986》镜像](https://darithmathblog.wordpress.com/wp-content/uploads/2017/04/murray-s-klamkin-usa-mathematical-olympiads-1972-1986-problems-and-solutions.pdf)前言明确写“3 hours (later changed to 3½ hours)”，但没有在该段给出变更年份。因此不能声称 1972–1995 每一年原赛制都是 210 分钟；本实现早年统一 210 分钟只是练习约定，待逐年原卷补证。
- [AIME 1983–2011 合集镜像](https://mathwo.github.io/assets/files/AIME-Problems-1983-2011.pdf)同样是第三方汇编，不可称作本轮下载的官方原件。

来源研究的 PDF、截图、提取文本和抓取清单不进入共享源码。研究引用不构成转授题目或解答版权。

### 存储与可靠性限制

[计时状态机](../front-end/contests/timer.js)按账号建立 `study-space:contests:account:<编码后的账号ID>:v2` 键；其中普通练习与限时练习分别保存。不会自动读取或迁移旧匿名命名空间。

- 使用 Web Locks 为同账号竞赛页面取得单写者锁；第二标签页只有临时练习，不覆盖主标签页记录。关闭持锁页面后刷新另一页才能接管保存。
- 不支持 Web Locks、存储被禁用、配额不足或记录损坏时会显示真实警告，不能宣称已经保存；限时开始受存储能力限制。损坏记录不静默覆盖。
- 登出/会话失效后停止该页面写入；切换账号不继承上一账号的记录。清除浏览器站点数据仍会丢失这些本机记录。
- 截止时间依赖客户端系统时钟，虽然状态机检查非法/倒退时间和结束状态，用户仍可修改系统时钟或开发者工具。本功能是自主练习，**不是可信监考、服务端权威截止时间或防作弊系统**。
- 同源账号隔离不等于对共享电脑本地管理员的加密保护。不要把个人浏览器数据或测试档案上传仓库。

## 显式导入本机真实题库

导入工具不会搜索任意磁盘或联网下载题库。先确认自己有本地使用权限，明确指定源目录：

```sh
python3 back-end/tools/contests/import_contest_bank.py --source-root "/absolute/path/to/contest-bank" --acknowledge-rights
```

源目录必须包含以下一致的数据结构，而不是任意 PDF / ZIP：

```text
data/problems.json
data/exams.json
data/exams/<exam-id>.json
assets/...                       # 仅题目资源清单实际引用的图片
```

[导入器](../back-end/tools/contests/import_contest_bank.py)核对全库与分卷记录一致性、唯一 ID、题序、题型、元数据、图片字节数及 SHA-256，并通过[标准化与安全检查](../back-end/shared/contest_bank.py)生成供前端使用的受限内容。拒绝路径穿越、符号链接、资源哈希不匹配和不安全图片；HTML 使用白名单，SVG 不允许脚本或外部引用，不执行题目中的图示源码。

默认输出如下：

```text
local-data/contests/current.json
local-data/contests/versions/<内容哈希>/manifest.json
local-data/contests/versions/<内容哈希>/catalog.json
local-data/contests/versions/<内容哈希>/exams/...
local-data/contests/versions/<内容哈希>/assets/...
```

工具使用 Git 实际检查输出是否被忽略以及是否已经被跟踪，不能靠路径名称或 `force-add` 绕过。`--private-dir` 可指定同工作树内另一个被忽略的竞赛存储目录，但默认服务仍从自己的 private root 下的 `contests/` 读取；除非同步配置服务根目录，否则不要改默认路径。

- 相同内容再次导入返回 `unchanged`。
- 切换不同内容必须显式加 `--replace`；先完整验证、发布不可变版本，再原子切换当前指针。
- 失败不会切换原活动版本；旧版本保留，不自动删除，便于诊断和恢复。
- 失败留下的 staging 目录不会被服务。恢复前先查明错误与锁状态，不随意清空全部 `local-data/`。
- `--acknowledge-rights` 只是使用者对本地使用权限的确认，不授予 GitHub 发布、公开网站分发或解答转载许可。

### 本轮私有数据整理快照

2026-10-26 本机导入结果为 232 份试卷、4,011 题及 437 个资源，活动版本 `8933e9da6bd1cd91a739734b086d6ede800cb670ceeeb8323dde057d95ff7fb5`。这是特定私有副本的快照，不是仓库自带内容，也不是官方完整性或准确性认证。

- 额外整理 1,148 个 LIVE 与 11 个 Evan Chen 外部参考链接，共 1,159 个；只保留链接及来源信息，不批量转载其解答正文。
- 独立补写 10 份中文离线解答，保留 `unreviewed_generated` 待审标记；离线解答覆盖从 2,818 题增至 2,828 题，缺解答从 1,193 题降至 1,183 题。外部链接数不计入离线解答覆盖，不据此声称缺解答已全部补齐。
- 原始来源副本未改；升级后的私有工作副本经导入器生成新版本，旧版本与来源备份不自动清理。

## 公式与离线资源

本机公式渲染为可选的固定 MathJax 3.2.2。执行一次：

```sh
python3 back-end/tools/contests/setup_contest_mathjax.py
```

无网络时使用相同官方 npm 压缩包：

```sh
python3 back-end/tools/contests/setup_contest_mathjax.py --archive "/absolute/path/to/mathjax-3.2.2.tgz"
```

[安装器](../back-end/tools/contests/setup_contest_mathjax.py)校验固定 SHA-512，仅提取所需浏览器脚本及许可证，拒绝链接与不安全归档路径，不执行 npm 安装钩子。输出在忽略的 `local-data/contest-vendor/mathjax/`；服务不会自动下载依赖。运行时只走同源 `/contest-vendor/mathjax/`，不依赖 CDN。

未安装、校验失败或加载失败时提示并保留可读的 LaTeX 文本，不应显示虚假的渲染成功。安装后刷新页面；不要为解决公式问题关闭资源校验或允许任意外部脚本。

## 接口与 Cloudflare 边界

统一登录保护页面、目录、试卷和资源；前端隐藏按钮不是权限控制。

| 路由 | 用途 |
| --- | --- |
| `/contests/` | 竞赛页面；静态文件仅允许明确的六个模块文件 |
| `/api/contests/catalog` | 默认本机真实题库元数据；`?mode=example` 显式示例 |
| `/api/contests/exams/<id>` | 按模式读取一份规范化试卷 |
| `/contest-assets/...` | 本机当前版本已声明、校验的题目图片 |
| `/contest-vendor/mathjax/...` | 本机固定版本渲染依赖 |

六个模块文件为 [页面](../front-end/contests/index.html)、[样式](../front-end/contests/styles.css)、[普通练习模型](../front-end/contests/model.js)、[应用](../front-end/contests/app.js)、[MathJax 配置](../front-end/contests/mathjax-config.js)及[计时状态机](../front-end/contests/timer.js)。源题库、整个本机目录及示例 JSON 不作为任意静态目录暴露。

Cloudflare [竞赛导出器](../back-end/cloudflare/scripts/export_contests.py)只处理 Git 已跟踪的四份原创示例，拒绝带私有/外部资产的示例。云端 `private` 目录为空，`privateProblems: 0`；不导出本机 MathJax，`mathjaxAvailable: false`，采用 LaTeX 文本降级。完整真实竞赛题库与本机研究资料不会因现有 SAT / TOEFL 共享授权而获得发布许可。进一步说明见 [Cloudflare 部署](cloudflare-deployment.md)。

## 检查与复现

以下为本工作树实际存在的检查入口，**命令清单不代表已经执行或全部通过**。结果以本次执行日志与最终交付报告为准，不沿用旧部署的通过数量。先在仓库根目录运行：

```sh
python3 -B -m unittest discover -s back-end/tests -p 'test_contest_*.py' -v
node back-end/tests/contest-model.test.cjs
node back-end/tests/contest-timer.test.cjs
node back-end/tests/contest-browser.mjs
```

Python 项目覆盖规范化、导入、资源与 MathJax、安全边界和登录保护；模型检查覆盖判分/统计，计时检查覆盖历史分界、绝对截止时间、重载、结束只读与多场独立性。浏览器检查用隔离测试账号、临时数据库及 Chrome profile，通过真实 Chromium 操作页面，不使用个人登录档案。`PYTHON`、`CHROME_PATH` 环境变量可指定可执行文件；它依赖本机已安装 Chrome，报告写在忽略的 `local-data/test-results/`。

浏览器检查真实本机已导入题库时额外执行：

```sh
node back-end/tests/contest-browser.mjs --private
```

该选项可能在忽略的测试目录中复制私有题库用于隔离检查，报告和 profile 也不应上传。应分别验证无 MathJax 时的降级和安装后的公式排版，不把示例测试当成所有真题排版人工审核。

Cloudflare 定向检查与既有回归：

```sh
node --test --test-concurrency=1 back-end/cloudflare/tests/contest-worker.test.mjs
npm --prefix back-end/cloudflare test
npm --prefix back-end/cloudflare run build
```

构建会检查 Git 已跟踪白名单；工作树里新建但尚未按协作流程加入 Git 的原创文件可能被拒绝，不能因此放宽检查。构建成功不等于 deploy；本轮不运行部署命令。

涉及统一入口时还需检查首页、SAT 和 TOEFL 原流程；不要改动受保护的 SAT 考试界面来让竞赛测试通过。Windows 符号链接、旧测试编码等既有环境问题需单列，不得隐藏失败、删掉安全测试或宣称跨平台/生产全量验收完成。

### 2026-10-26 本轮验证记录

- Windows + Python 3.12.14：新增 39 项竞赛测试，36 通过，3 因本机符号链接权限明确跳过；9 组普通模型及 11 组计时状态机检查通过。
- Chrome 实际浏览器：原创示例与本机真实题库各 17 组流程通过；覆盖刷新续计时、结束/超时锁定、USAMO 独立两场、不同账号、单写者、存储禁用、注入防护、MathJax、解析/外链及窄屏。浏览器未捕获脚本异常或自动外部请求。首页验收 390px，竞赛页面另检查 320px（扣除滚动条后的实际内容宽度）。
- Python 全套：当前 279 项与精确 `origin/main c6a7fd0` 的 240 项基线均出现 5 failures / 15 errors；20 个标识及归一化 traceback 完全一致，无新增。既有问题包括 Windows TOEFL 路径 404、woff2 MIME、GBK 解码、转换版本协调、符号链接权限与 SQLite 清理锁。**全套仍非全绿**，不是跨平台验收。
- Cloudflare 竞赛/资源定向 11 项通过；完整共享资源构建通过，未部署。完整测试中的既有 600000 次 PBKDF2 runtime 检查曾因并行系统负载超过 30 秒，隔离重跑通过（约 16.5 秒）；随后完整套件在既有重型 auth 检查长时间运行，本轮主动停止，未完成整套；不得把隔离通过写成完整套件通过。
- 日志、截图、隔离账号数据库和基线比对均留在忽略的 `local-data/`，不进入 Git。
