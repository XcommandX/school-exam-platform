# 统一学习首页

> 2026-10-26：首页 AP 从占位入口升级为独立蓝色大卡，标题 **AP**，白色“开始练习”按钮与“英语语言与写作”课程入口均进入 `/ap/`；课程内筛选 MCQ/FRQ，保留后续其他 AP 课程的扩展空间。首页只统计当前账号的本机 AP 私有完成记录，原创示例不混入真实学习统计。统一登录及 SAT/TOEFL 云同步保留；AP 保存边界见 [AP Language](ap-language.md)。

> 2026-10-24 统一账号更新：首页、TOEFL 与 SAT 共用登录会话；首页设置、TOEFL 文字状态及 SAT 练习记录、错题本、练习设置按账号保存在本机 SQLite，TOEFL 录音仍在按账号隔离的浏览器空间。当前账号事实、接口、迁移边界以 [统一账号](unified-auth.md) 为准；下文未认证 admin 与待接身份的描述保留为此前阶段背景，不再是当前登录行为。

## 启动

需要 Python 3.10+。从源码构建 TOEFL 匿名样例还需要 Node.js 22.13+，不需要安装第三方 Python 或 npm 包。从仓库根目录运行：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/>。macOS 可双击根目录 `Start Study Platform.command`；终端窗口需要保持打开。默认端口 8888 与独立 SAT 原型的 8876 分开。Windows 可使用 `py -3`，本轮未验证 Windows 双击启动。

服务启动时自动查找 `PATH` 中的 Node.js，并调用 `back-end/toefl/scripts/build.mjs` 构建匿名预览。也可先手动构建：

```sh
node back-end/toefl/scripts/build.mjs
```

构建结果为本机忽略提交的 `local-data/builds/toefl/`。没有 Node.js 时，现有且满足匿名构建标记与文件白名单检查的 `local-data/builds/toefl/preview/` 仍可使用；没有可用构建时，`/toefl/` 返回未就绪提示，首页和 SAT 仍可使用。Python 服务不启动原托福云端 Worker；账号与 TOEFL 文字状态由公共 SQLite 服务提供，不连接原云站、正式题库或外部 AI。

## 页面与功能

- 首页采用用户确认的模板：暖白底、TOEFL 绿色主卡、SAT 橙色主卡与 Study Space 品牌；两个考试名称使用同一字号与对齐规则，悬浮、聚焦和减少动画偏好均有对应样式。图标直接随源码提供，主页不依赖外链字体或图标脚本。
- 删除原模板顶部的白色导航、搜索、继续上次示例和底部工具栏；“学习计划”“成绩报告”迁入右上头像菜单，仅显示功能名，不附描述。没有会员体系，不显示会员标识；页脚不显示口号。
- TOEFL 阅读、听力、口语、写作保留独立跳转，开始练习进入 `/toefl/`；SAT 阅读与文法合并显示为“英语”，使用书本图标，数学入口也已接入，分别传入 `section=reading-writing` 与 `section=math`，开始练习进入 SAT 管理首页。
- 初始进入 `/login`，右上头像显示已验证账号的显示名。首页与 TOEFL 共用 Cookie 会话；管理员可从头像进入账号管理，所有用户可编辑自己的显示名、修改密码和退出登录。
- 学习计划可保存每日题目目标及个人计划；今日摘要显示新平台已完成题目数与每日目标。目标设置支持新 TOEFL 四科 1–6 分、每 0.5 分一档，目标总分为四科均值取最近的 0.5 分；SAT 两科各 200–800 分、每 10 分一档。目标提示支持鼠标悬浮和键盘聚焦，可查看具体分科目标。
- 成绩报告和练习记录读取当前账号的服务端记录，SAT 合并无冲突的本机待同步记录，展示完成练习数、已答题数、客观题正确率及最近记录；没有记录时显示真实空态，不预填模板进度。统计不换算官方考试分数，口语、写作和未评分题目不计入客观题正确率；SAT 的 `ungradedCount` 从正确率分母扣除，但仍计入已答题目与学习活动。
- AP 与跨考试 Personal Vocab 通过页脚保留待接入入口；个人词库弹层可跳转到已接入的 TOEFL 词汇样例功能，二者不是同一个完整产品。

### 文案与后续交接约定

按用户最新确认，标题和功能名直接单行展示。后续修改不得擅自补充装饰性副标题、卡片说明、菜单描述、标题下解释小字或底部口号；该约定覆盖此前为“学习计划”“成绩报告”添加菜单说明的要求。后续聊天与本地接手的 agent 应同时读取本节及根目录 `AGENTS.md`，继承此偏好。

必要的分值、计时、统计标签、错误提示和完成操作必需的说明继续保留，不能根据字号大小或 `span`、`small` 等标签批量删除。此约定不修改受保护的 SAT 准备、考试、检查及完成界面。

### SAT 界面边界

SAT 管理页面不显示重复的顶部 Overview / Questions / Practice / Wrong Book 导航组；入口保留在概览卡片。各管理子页使用醒目的 Overview 回退按钮，保持悬浮、按下与键盘焦点反馈。

SAT 自定义训练、题库、错题本、练习报告和复盘仍复用 `front-end/sat/`。本轮只更新其非考试管理页面，新增主题限定于 `.app-shell[data-sat-management]`；`front-end/sat/js/app.js` 只在相应管理视图设置该标记。因此不能再概括为“SAT 的所有 JS、CSS 完全没改”。

从开始练习后的 `ready`、`preparing`、`exam`、`check`、`moduleOver`、`saving`、`congrats` 阶段不应用管理主题，原有考试实现继续保护；2026-10-23 截图授权的数学与休息流程例外见 [SAT 数学与整套练习](sat-math-exam.md)。独立的 `front-end/web/sat-bridge.js` 负责统一入口和存储名称映射。当前 SAT 已支持 Reading & Writing 与 Math，没有自适应分流或官方量尺分。

### TOEFL 接入边界

本地整合版本使用 `toefl` 分支 `98aa9c7` 的 `back-end/toefl/` 源码。原前端与云端源文件保留在模块内；统一平台只服务本地匿名构建，并在入口注入独立的 `front-end/web/toefl-bridge.js`，映射存储名称与录音库。URL 路由与账号范围内的页面恢复由模块原生实现负责，桥接层不再抢写导航。链接合同见 [TOEFL 页面入口约定](toefl/ENTRY_INTERFACE.md)，本轮合并及接口问题见 [本地整合报告](local-integration-2026-10-23.md)。

匿名构建使用 `fixtures/anonymous-bank.json` 的原创样例；音频为合成测试提示音，场景图为原创 SVG。已提供四科和学习页面入口，不能将这些样例、套题页或已有评分源码描述为真实题库、完整官方模考或已上线的 AI 评分。私有托福题库、原音频、正式云端资源和外部 AI 尚未接入统一服务；统一登录和 TOEFL 文字状态保存现由公共账号层提供。

| 入口 | 目标 |
| --- | --- |
| `/toefl/` | TOEFL 匿名样例应用 |
| `/toefl/?section=reading` | 阅读练习入口 |
| `/toefl/?section=listening` | 听力练习入口 |
| `/toefl/?section=speaking` | 口语练习入口 |
| `/toefl/?section=writing` | 写作练习入口 |
| `/toefl/?view=plan` | 每日学习计划 |
| `/toefl/?view=report` | 练习记录 |
| `/toefl/?view=progress` | 学习进度 |
| `/toefl/?view=mock` | 套题样例页 |
| `/toefl/?view=vocab` | 词汇样例训练 |
| `/toefl/?view=wrongBook` | 错题本，可按 `section` 筛选 |

账号菜单在打开或关闭个人中心、目标、计划等弹窗时保留展开状态；点击首页空白或再次点击头像时收起。未设置分数的悬浮提示只显示“未设置”，不添加说明小字。

## 数据边界

2026-10-23 指定测试集合已改为新协议 SAT 包：98 题，原 929 题已备份归档。该指定活动卷的新包、原图和备份仍只在本机忽略目录。新包协议、转换与恢复说明见 [SAT 数学与整套练习](sat-math-exam.md)，下文首次迁移数量保留历史背景。

Start Practice 与 Practice Builder 全库接口默认合并 `back-end/question-banks/sat-packs/gengdu-offline/` 和 `pdf-official/` 两份独立目录，按需读取所选题集；显式 `SAT_LIBRARY_ROOT` 或 `--sat-library-root` 只读取指定目录。耕读副本已获共享授权，PDF 转换题包与必要图片获本轮本地 commit 授权，未授权 push；范围见 `AGENTS.md`。这些目录不替换旧活动卷，也不包含个人作答记录。

源码在 `front-end/web/`、`front-end/sat/`、`back-end/toefl/`、`back-end/shared/`、`scripts/`。统一 v1 题库格式和示例见 [question-format.md](question-format.md)；TOEFL 当前仍使用本模块的匿名样例格式，没有自动接入统一 v1 题库或未来 v2 题包。

旧格式真实题库在 `local-data/question-banks/{sat,ap,toefl,vocab}/`，图片在 `local-data/question-assets/<exam>/`。这些目录被 Git 忽略，不随提交/推送共享。服务器仅在登录后通过明确的题库接口和图片路由读取它们，不将仓库根目录作为静态网站公开。

本次本地迁移仅保留原 SAT 题目及其标准答案、解析、格式、模块信息与必要图片。逐字段白名单去除已选答案、学生信息和任意个人元数据；不复制 HAR、PDF、OCR 模型、备份、个人练习或浏览器记录。原始目录不修改。带个人练习含义的来源名称改为中性补充题集名称，题目内容保留。

此前在维护者本机完成的 SAT 迁移为 18 个题集、929 道题和 36 张必要图片：原题库目录 901 道、原型内置种子 27 道、独立示例 1 道。与题库重复的 4 道示例不再次导入。这是本机迁移记录，不是克隆仓库即包含的题库；服务启动不会重新迁移原项目。

统一 SAT 使用 IndexedDB `SchoolExamPlatform:account:<id>:sat:v1`，运行状态使用 `school-exam-platform:account:<id>:sat:runtime:v1`。TOEFL 状态缓存使用 `school-exam-platform:account:<id>:toefl:<原key>`，录音库为 `SchoolExamPlatform:account:<id>:toefl:recordings:v1`。用户 ID 来自服务端会话；旧匿名空间保留，不自动迁移。

首页计划、目标与减少动画偏好通过 `/api/me/home` 按账号保存到服务端，并缓存于账号空间；统计读取该账号 TOEFL 服务端状态与 SAT 服务端摘要，并合并无冲突的 SAT 本机待同步记录。旧匿名及独立应用的数据保留，不自动分配给任何新账号，不迁移原模板硬编码数字。

`.DS_Store` 由根目录忽略规则覆盖所有层级；除 `AGENTS.md` 明确授权的 SAT 题包与必要图片外，生成的 `dist/`、真实来源资料与个人数据均不应提交。

## 本地迁移

使用迁移脚本的 `--help` 查看参数，显式提供原 SAT 根目录；迁移是独立操作，服务启动时不会自动读取桌面或原项目。不要复制原项目整目录，也不要 force-add `local-data/`。

```sh
python3 back-end/tools/sat/migrate_sat_bank.py --source-root "/path/to/original-sat-folder" --include-examples
```

对没有真实题库的开发副本，可从 SAT 题库页导入 `front-end/sat/data/examples/synthetic-practice.json` 做基础验证。

原型内置 JS 种子需先导出为只含题目的 JSON，再用 `--seed-json <sanitized-seed.json>` 显式导入；不得复制包含姓名配置的完整 JS。迁移输入同样存于被忽略的本地目录。

## 本机接口

| 请求 | 用途 |
| --- | --- |
| `GET /api/platform/catalog` | 四个考试的题库统计、来源及接入状态 |
| `GET /api/exams/{exam}/sources` | 单个考试的独立题集目录 |
| `GET /api/exams/{exam}/sources/{id}` | 统一格式的单套题集 |
| `GET /api/auth/session` | 真实当前会话；未登录返回 `authenticated: false`，完整接口见 [统一账号](unified-auth.md) |
| `GET /api/toefl/status` | 匿名构建可用性、样例数量与入口 |
| `GET /api/question-bank/status` | SAT 兼容接口状态与同源写入令牌 |
| `GET /api/question-bank` | 将统一题库转换为旧 SAT 引擎可导入格式 |
| `GET /api/sat-packs` | 读取活动 SAT 新包及有序试卷配置 |
| `POST /api/sat-library-backup` | 校验当前账号、同源与令牌后备份自己的本机旧库，成功后才允许浏览器归档 |
| `POST /api/question-bank` | 管理员校验、过滤个人字段并保存 SAT JSON |
| `/sat/` | 进入旧 SAT 引擎，支持首页功能入口参数 |
| `/toefl/` | 仅服务通过匿名标记检查的预览文件及资源白名单 |

`exam` 为 `sat`、`ap`、`toefl` 或 `vocab`。公共 v1 题库格式当前仅支持选择题；TOEFL 原模块虽有媒体和开放式题型源码，其匿名应用并未使公共格式自动具备这些能力。统一账号、角色权限与 SAT/TOEFL 文字记录接口见 [统一账号](unified-auth.md)。

本机服务仅绑定 `127.0.0.1`。写入需通过服务端会话和账号权限校验；题库兼容接口额外匹配 Host、Origin 和随机令牌。公开部署仍需 HTTPS、生产 HTTP 服务、备份及容量验收。

## 验证

```sh
python3 -m unittest discover -s back-end/tests -v
node back-end/tests/home-model.test.cjs
```

TOEFL 模块检查在 `back-end/toefl/` 内执行：

```sh
node scripts/check-source.mjs
node scripts/test.mjs
```

自动检查使用临时目录与原创匿名样例。Python 检查覆盖统一格式转换、隐私字段过滤、考试隔离、接口及路由访问边界；首页模型检查覆盖目标分档、记录统计与旧数据边界。TOEFL 检查的范围见该模块 README；替身 AI 或匿名音频通过不代表正式 AI、来源音频或真实麦克风硬件已验证。

每次交付应分别记录实际执行的检查、浏览器操作和未完成项，不沿用旧首页的验证结果冒充本次验证。重点复查头像菜单、学习目标保存、TOEFL 各入口、新命名空间统计，以及 SAT 开始后的各考试阶段没有管理主题标记或外观变化。Windows、真实多人账号、跨设备同步与正式部署需单独验证。
