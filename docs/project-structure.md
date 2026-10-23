# 四个主体目录

2026-10-23 用户明确要求实际整理，已按文件的运行角色迁移，不只是换文件夹名称。

```text
front-end/
  web/                              统一首页、存储桥接、统计界面
  sat/                              SAT HTML/CSS/JS、渲染依赖和原创样例
  toefl/                            TOEFL 页面、样式和交互
    clients/                        在浏览器执行的云端/账号客户端
    templates/                      登录/账号页面模板源码
    integration/                    页面入口 URL 生成器
back-end/
  server/serve_platform.py           仅本机运行的统一开发服务
  toefl/
    src/                            Worker、账号、同步、评分与 SQL
    content/                        题目编辑格式校验
    integration/                    题目/记录映射适配
    scripts/                        匿名构建、预览、检查与题目工具
    fixtures/                       原创匿名数据，不是真实题库
    tests/                          托福模块检查
  tools/sat/                        转换、打包、迁移、源码导出、独立服务
  shared/                           公共 JSON 合同与旧格式校验工具
  tests/                            平台、首页和 SAT 检查
docs/
  design/                           样式参考与可复用示意 CSS
  sat/                              SAT 使用说明与原始导出摘要
  toefl/                            TOEFL 使用说明、入口和题目编辑合同
  drafts/                           供团队评审的格式及原创结构样包
  ...                               架构、协作、运行与验证记录
local-data/                         整个目录不进入 Git
  sat-packs/                        当前完整 SAT 测试卷与活动配置
  question-banks/                    本机旧格式题库
  question-assets/                   题目资源
  backups/                          原题库及浏览器库的本机备份
  exports/                          完整模考 ZIP 和摘要
  standalone-sat/                   独立 SAT 服务的运行数据
  builds/toefl/                     匿名 preview 和后端内存测试构建
  references/                       Reference Folders 与 Reference Zips
  agent-output/                     截图、临时检查报告与目录迁移记录
  cache/                            本机缓存
```

GitHub 中有三个主体目录：`front-end/`、`back-end/`、`docs/`。Git 必须保留 `.gitignore`、`.gitattributes` 等配置；`.github/` 用于 Issue/PR 模板。根目录同时保留 `README.md`、`AGENTS.md`、`Start Study Platform.command`、`push.command`、`pull.command` 这些直接入口。它们是少量入口文件，不是业务源码散落。

## 这次移动了什么

| 旧位置 | 新位置 |
| --- | --- |
| `apps/web/` | `front-end/web/` |
| `apps/sat/` 的浏览器代码 | `front-end/sat/` |
| SAT 原模块脚本及根 SAT 维护脚本 | `back-end/tools/sat/` |
| TOEFL `src/frontend/` | `front-end/toefl/` |
| TOEFL 浏览器云客户端/HTML 模板 | `front-end/toefl/clients/`、`templates/` |
| TOEFL Worker/账号/评分等源码与构建检查 | `back-end/toefl/` |
| 根 `scripts/serve_platform.py` | `back-end/server/serve_platform.py` |
| 根 `shared/`、`tests/` | `back-end/shared/`、`back-end/tests/` |
| 根样式说明、参考 CSS | `docs/design/` |
| 各模块 README 与合同、根 CONTRIBUTING | `docs/` 的相应位置 |
| 原 `private-data/` | `local-data/`，题库和备份原样保留 |
| 原 `Reference Folders/`、`Reference Zips/` | `local-data/references/`，原名称保留 |

`docs/sat/source-snapshot.json`、`docs/toefl/source-snapshot.json` 保留原始导出的相对路径和哈希，用于溯源。当前 TOEFL 联合源码清单已按新布局更新；SAT 源码导出每次生成自身清单，不把历史摘要伪装成当前文件校验。

## 运行与构建边界

统一平台仍从仓库根目录执行：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

网址仍是 `http://127.0.0.1:8888/`，公共 `/sat/`、`/toefl/`、`/web/` 和 API 路由保持。服务负责将这些网址映射到新磁盘路径，不能把整个仓库或 `local-data/` 直接作为静态网站公开。浏览器的 IndexedDB/localStorage 名称保持不变。

TOEFL 构建只从明确白名单复制匿名预览所需文件。`clients/`、`templates/` 和服务端源码不会因为拆到新目录而被统一服务公开。后端内存测试构建和预览均写 `local-data/builds/toefl/`。

独立 SAT 服务从 `front-end/sat/` 读静态文件，默认只向 `local-data/standalone-sat/` 写运行题库与图片。前端目录不再生成本机题库。完整题包只在 `local-data/exports/`；解压到 `local-data/sat-packs/` 后由统一服务读取。

两个考试的完整源码仍保留在一个 Git 仓库；Git 可以识别大量文件为重命名。其他成员尚在旧目录的分支需要在合入时处理路径适配，不能只复制旧文件夹回来。建议其他成员在本次结构合入共用版本之后更新 `main` 再开新任务。

## 产物怎么放

确定要共享的说明、架构和验证结论写入 `docs/`，同代码一起审查；截图、临时脚本、跑检查的 JSON、导出 ZIP、来源资料与个人数据放在 `local-data/` 对应子目录。不要把整份 agent 临时输出或个人题库加入提交。`.DS_Store` 在所有层级继续忽略。

目录整理没有启用正式登录、云数据库、加密分发或真实托福题库。具体可行性与下一步文件职责见 [前后端方案](frontend-backend-plan.md)。

## 2026-10-23 迁移验收

- 新路径下 Python 全量 73 项通过，平台/SAT 的 9 份 Node 与浏览器脚本通过；另检查统一 `/sat/` 路由中的英语流程、桥接加载顺序、KaTeX 字体与存储名称。
- TOEFL 联合清单检查通过，86 项源码/文档摘要与 Git 索引一致；匿名构建、44 组回归和 12 条原创记录的题目工具往返检查通过。
- 独立匿名副本、随机端口和全新 macOS Chrome 上下文的 12 组检查通过：统一首页、四科入口、TOEFL 主页/错题本/模考/历史与刷新；9 项白名单资源全部 200，页面错误、请求失败、错误响应与外部请求均为 0。
- 实际 8888 服务的首页、SAT、TOEFL 与状态接口可用，SAT 返回 98 题和 27/27/22/22 四模块；`local-data/`、后端源码及 docs 均无静态公开路由。
- 根目录可见主体目录恰为四个；共享 Markdown 本地链接无失效，暂存清单没有本机数据、ZIP、密钥或 `.DS_Store`。完整 SAT ZIP 的版本、引用、资源及摘要校验通过。

检查截图与临时报告集中在忽略的 `local-data/agent-output/2026-10-23/`。本次未验证 Windows、Safari、真实麦克风/触控板、正式账号、真实云端同步或部署；匿名/替身测试不证明这些流程已经上线。
