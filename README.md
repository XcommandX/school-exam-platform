# School Exam Platform

校内 SAT / TOEFL 练习平台。首页、TOEFL 和 SAT 共用账号；首页设置、TOEFL 文字记录以及 SAT 练习记录、错题本、练习设置按用户保存。本分支新增 Cloudflare Workers + SQLite Durable Objects 云端适配，保留原 Python 本机运行方式；Cloudflare 版新增用户同意后的 TOEFL 写作/口语内容 AI 批改（1–6 半分档，非官方单题估分），录音仅为本次识别临时发送、不云端持久保存。具体发布状态见部署记录。账号菜单与保存边界见 [统一账号](docs/unified-auth.md)，云端构建、初始化、配额与维护见 [Cloudflare 部署](docs/cloudflare-deployment.md)。

## Cloudflare 在线版

2026-10-24 已实际发布：<https://school-exam-platform.xcommandx-school.workers.dev>。完整共享 SAT / TOEFL 题库和必要音频图片已上传，页面与题库须登录。2026-10-25 Cloudflare 实现与站内注册审批已合入并推送 `main`，且已手动发布新版；以后更新 GitHub 仍不会自动更新网站。首位管理员已由维护者在安全初始化页面自行创建并确认进入账号管理，一次性初始化凭证已移除；之后直接使用 `/login`，其他管理员在账号管理内创建。云端账号与 `127.0.0.1:8888` 本机账号独立，不迁移旧个人数据。发布版本、已完成与待验收检查见 [发布记录](docs/cloudflare-deployment.md#本次实际发布记录)。

## 管理员站内审批注册

线上已启用与首页同风格的注册入口：申请进入所有有效管理员共享可见的「账号管理 → 注册申请」列表，任一管理员通过后才创建学生账号，也可拒绝；原有账号直接登录。无需邮件服务或自有域名，有有效管理员时才开放注册。此方案是人工把关，尚不通过学号保证一人一号。使用、安全与验证边界见 [站内审批注册](docs/registration-approval.md)。2026-10-25 已发布到上述线上地址，线上原有账号无需重新创建。

## AP 英语语言与写作

首页新增独立蓝色 **AP** 卡片，课程入口为“英语语言与写作”；`/ap/` 需登录。支持 MCQ/FRQ、官方分部分限时、自由练习、草稿与复盘，记录只在当前浏览器按账号隔离保存。Cloudflare 仅提供原创示例，真实 AP 材料与 PDF 留在本机忽略目录，不公开上传。导入、数据协议与保存边界见 [AP Language](docs/ap-language.md)。本次还合入此前已上线的 TOEFL AI 分支，保留其现有功能。

## 项目结构

```text
front-end/                  浏览器代码：页面、样式、题型交互和渲染
  web/                      Study Space 统一首页
  sat/                      SAT 英语、数学、模考与复盘
  toefl/                    TOEFL 界面、浏览器客户端和页面模板
back-end/                   本机服务、托福后端源码、维护工具与检查
  server/                   统一本机 Python 服务
  cloudflare/               统一云端 Worker、SQLite DO、完整资源构建与匿名测试
  question-banks/sat-packs/   用户授权共享的 SAT 题库副本
  question-banks/toefl/      用户授权共享的完整托福题目、来源音频与图片
  toefl/                    Worker 源码、匿名/共享构建、题型协议及模块测试
  tools/sat/                SAT 导入、转换、打包、源码导出和独立服务
  shared/                   公共校验与旧题库兼容工具
  tests/                    平台和 SAT 检查
docs/                       共享说明、格式合同、样式参考与设计讨论
local-data/                 仅本机：真实题库、媒体、记录备份、参考资料和产物
```

`local-data/` 被整体忽略，不进入 GitHub。GitHub 的三个主体目录是 `front-end/`、`back-end/`、`docs/`。Start Practice 和 Practice Builder 全库接口默认合并 `back-end/question-banks/sat-packs/` 下的 `gengdu-offline/` 与 `pdf-official/` 两份目录；两者均来自本次已授权部署的 GitHub `main` 共享副本；旧说明中的“仅本地 commit”限制对应此前转换阶段。个人记录、备份和原始来源资料仍不提交。根目录保留本说明、`AGENTS.md`、启动/同步入口和 Git 必需配置；隐藏的 `.github/` 是 GitHub 模板目录。具体路径和迁移规则见 [项目结构](docs/project-structure.md)。

## 启动

本机运行需要 Python 3.10+；构建 TOEFL 题库还需要 Node.js 22.13+，无需安装第三方 Python 或 npm 包。Cloudflare 部署另需在 `back-end/cloudflare/` 执行 `npm ci`，使用该目录的锁定依赖；不影响原本机启动。

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/> 后先登录；账号创建、管理与保存边界见 [统一账号](docs/unified-auth.md)。也可在 macOS 双击根目录 `Start Study Platform.command`。服务仅监听本机，不用于校内公开部署。页面 URL 仍为 `/sat/`、`/toefl/`，源码分目录不会改变浏览器存储命名空间或已有作答记录。

TOEFL 匿名构建命令：

```sh
node back-end/toefl/scripts/build.mjs
```

产物在 `local-data/builds/toefl/`，只有原创匿名样例，音频是测试提示音。用户于 2026-10-24 另授权共享全部托福题目及引用来源媒体，位于 `back-end/question-banks/toefl/`。平台启动会校验并构建完整库到独立的 `local-data/builds/toefl-shared/`，登录后可访问；也可显式运行 `node back-end/toefl/scripts/build.mjs --shared-bank`。资源清单和范围见 [共享题库](docs/toefl/SHARED_BANK.md)。原私人云站保持独立，统一服务没有接入其账号、录音上传或外部 AI。

## SAT 完整模考题包

本机指定卷包含英语 27+27、数学 22+22，共 98 题。完整离线包位于 `local-data/exports/gengdu-2026-03-us-a-sat-full-offline.zip`；它将有序 `assessment.json` 与三个题型包一起包装。服务读取 `local-data/sat-packs/active.json`，SAT 首页可点“全套模考”。来源答案仍待审核、解析缺失，不能声称是已核定官方评分。

检查页 Next 只移除确认弹窗，保留模块结束页、英语后休息及第二次 Resume 才启动数学的流程。当前模块保存为本机状态，不表示已经上传云端。格式、资源、原库备份和使用说明见 [SAT 数学与整套练习](docs/sat-math-exam.md)。

## 文档与检查

| 内容 | 入口 |
| --- | --- |
| 仓库约定 | [AGENTS.md](AGENTS.md) |
| 统一登录与用户管理 | [统一账号](docs/unified-auth.md) |
| Cloudflare 完整部署、免费限额与维护 | [部署指南](docs/cloudflare-deployment.md) |
| 三人 Git 协作 | [CONTRIBUTING](docs/CONTRIBUTING.md) |
| 启动、路由与数据边界 | [统一首页](docs/unified-home.md) |
| 前后端、登录与加密分发讨论 | [设计说明](docs/frontend-backend-plan.md) |
| 跨考试题包历史草案 | [结构策略草案](docs/所有题目包结构策略.md)（当前 SAT 实现以专用协议为准） |
| SAT 协议 | [专用题目包](docs/drafts/sat-question-packs/README.md) |
| 耕读离线三类题包转换 | [批量转换说明](docs/sat-offline-conversion.md) |
| TOEFL 源码、构建与测试 | [模块说明](docs/toefl/README.md) |
| 首页与管理页样式 | [参考样式](docs/design/参考样式.md) |

```sh
python3 -B -m unittest discover -s back-end/tests -p 'test_*.py' -q
node back-end/tests/home-model.test.cjs
node back-end/toefl/scripts/check-source.mjs
node back-end/toefl/scripts/test.mjs
```

原模块浏览器回归需要已有 Playwright 与 Chrome，运行方式见相应模块文档。新增 Cloudflare `npm run test:browser` 使用已安装 Chrome 与 CDP，不需要 Playwright；最终本地云运行时 110 项、隔离 HTTPS 浏览器 15 项通过。原 Python 240 项测试在当前 Windows 环境仍有已确认的历史路径、编码与测试环境问题，详见 [验证范围](docs/cloudflare-deployment.md#验证范围)。这些检查不等于 Safari、两台真实硬件或 150 人并发验收。

`push.command`、`pull.command` 仍位于根目录，只处理当前分支，不自动合入 `main` 或发布网站。除上述明确授权的 SAT 与 TOEFL 共享题库目录外，真实资源、备份、录音、密钥和 `.DS_Store` 不提交；目录中的重复 ZIP 及对应校验文件也不提交。修改读取路径不会自动 commit 或 push。
