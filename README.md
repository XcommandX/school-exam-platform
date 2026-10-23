# School Exam Platform

校内 SAT / TOEFL 练习平台。当前是本机测试版本；首页、TOEFL 和 SAT 共用账号。首页设置、TOEFL 文字记录以及 SAT 练习记录、错题本、练习设置按用户保存在本机服务端；公网部署与录音上传尚未启用。账号菜单与保存边界见 [统一账号](docs/unified-auth.md)。

## 项目结构

```text
front-end/                  浏览器代码：页面、样式、题型交互和渲染
  web/                      Study Space 统一首页
  sat/                      SAT 英语、数学、模考与复盘
  toefl/                    TOEFL 界面、浏览器客户端和页面模板
back-end/                   本机服务、托福后端源码、维护工具与检查
  server/                   统一本机 Python 服务
  sat/questions/sat-packs/   用户授权共享的 SAT 题库副本
  toefl/                    Worker 源码、匿名构建、题型协议及模块测试
  tools/sat/                SAT 导入、转换、打包、源码导出和独立服务
  shared/                   公共校验与旧题库兼容工具
  tests/                    平台和 SAT 检查
docs/                       共享说明、格式合同、样式参考与设计讨论
local-data/                 仅本机：真实题库、媒体、记录备份、参考资料和产物
```

`local-data/` 被整体忽略，不进入 GitHub。GitHub 的三个主体目录是 `front-end/`、`back-end/`、`docs/`。Start Practice 和 Practice Builder 全库接口默认合并 `back-end/sat/questions/sat-packs/` 下的 `gengdu-offline/` 与 `pdf-official/` 两份目录；前者是已授权共享的副本，后者的转换题包与必要图片获本次本地 commit 授权，未授权 push。个人记录、备份和原始来源资料仍不提交。根目录保留本说明、`AGENTS.md`、启动/同步入口和 Git 必需配置；隐藏的 `.github/` 是 GitHub 模板目录。具体路径和迁移规则见 [项目结构](docs/project-structure.md)。

## 启动

需要 Python 3.10+；构建 TOEFL 匿名样例还需要 Node.js 22.13+，无需安装第三方 Python 或 npm 包。

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/> 后先登录；账号创建、管理与保存边界见 [统一账号](docs/unified-auth.md)。也可在 macOS 双击根目录 `Start Study Platform.command`。服务仅监听本机，不用于校内公开部署。页面 URL 仍为 `/sat/`、`/toefl/`，源码分目录不会改变浏览器存储命名空间或已有作答记录。

TOEFL 匿名构建命令：

```sh
node back-end/toefl/scripts/build.mjs
```

产物在 `local-data/builds/toefl/`，只有原创匿名样例，音频是测试提示音。真实托福题库和原音频不在当前 Git 仓库，统一账号与 TOEFL 文字记录已接入本机服务；原云站、正式 TOEFL 题库、录音上传和外部 AI 未接入。

## SAT 完整模考题包

本机指定卷包含英语 27+27、数学 22+22，共 98 题。完整离线包位于 `local-data/exports/gengdu-2026-03-us-a-sat-full-offline.zip`；它将有序 `assessment.json` 与三个题型包一起包装。服务读取 `local-data/sat-packs/active.json`，SAT 首页可点“全套模考”。来源答案仍待审核、解析缺失，不能声称是已核定官方评分。

检查页 Next 只移除确认弹窗，保留模块结束页、英语后休息及第二次 Resume 才启动数学的流程。当前模块保存为本机状态，不表示已经上传云端。格式、资源、原库备份和使用说明见 [SAT 数学与整套练习](docs/sat-math-exam.md)。

## 文档与检查

| 内容 | 入口 |
| --- | --- |
| 仓库约定 | [AGENTS.md](AGENTS.md) |
| 统一登录与用户管理 | [统一账号](docs/unified-auth.md) |
| 三人 Git 协作 | [CONTRIBUTING](docs/CONTRIBUTING.md) |
| 启动、路由与数据边界 | [统一首页](docs/unified-home.md) |
| 前后端、登录与加密分发讨论 | [设计说明](docs/frontend-backend-plan.md) |
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

浏览器回归还需要开发环境已有 Playwright 与 Chrome，运行方式见相应模块文档。Windows、Safari、真实硬件和正式云端流程没有因这次路径整理自动完成验证。

`push.command`、`pull.command` 仍位于根目录，只处理当前分支，不自动合入 `main` 或发布网站。除上述明确授权的 SAT 共享题库目录外，真实资源、备份、录音、密钥和 `.DS_Store` 不提交；目录中的重复 ZIP 及对应校验文件也不提交。修改读取路径不会自动 commit 或 push。
