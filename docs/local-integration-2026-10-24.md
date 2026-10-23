# 2026-10-24 本地分支整合

用户授权将所有现有本地分支合入本地 `main`，修复代码和接口问题；后续明确要求风格冲突选用最新修改，并停止扩大检查。此次不推送、不发布网站。

## 合并范围与保留

- 用户名：`feature/sat-current-username`（`7aa46f0`）。
- 删除 Manage Library、保留 Add Questions 空白入口：`codex/sat-remove-manage-library`（`2a273b5`）。
- 统一账号与 SAT 数据同步：原工作区未提交内容已保存到 `codex/local-workspace-preserved-20261024`（`aaa53cd`），再合入整合分支。
- PDF 题库：`codex/sat-pdf-library`（`cebfa59`）。
- 题库路径与按需加载：`codex/sat-questions-directory` / `codex/sat-start-practice`（`d6929c9`）及 `e34938d`。
- 全库组题：`codex/sat-builder-library`（`90dc511`）。
- 其他本地分支的历史提交一并纳入；`docs/exam-pack-strategy` 作为历史设计草案保留，不替换现行按考试/题型独立协议。

整合使用 `codex/local-main-integration`。保留原分支与快照分支，没有强制推送、改写共享历史或丢弃未提交工作。合并前已获取远端更新，整合结果包含当时的 `origin/main`（`ca33372`）；仅在远端存在的 AP 和数学竞赛功能分支不属于本次本地分支范围。

## 冲突与修复

保留新版账号菜单、完整练习历史、全库组题及账号快照补全逻辑；删除的 Manage Library 不被旧分支重新带回。保留用户名分支的休息页页脚与窄屏间距，旧题库导入样式不恢复。文档同时保留统一账号与两个 SAT 题库来源的说明。

修复会话资料嵌入 HTML 时 `<` 转义失效的问题，避免特殊显示名提前结束脚本。新增匿名账号的四条页面路由回归。清除重复的题库索引模拟，并补充统一账号下的用户名与 Add Questions 占位入口检查。

## 风格选择

同一界面发生冲突时采用最新实现。账号菜单使用 2026-10-24 的版本，SAT 用户名与休息页使用其最新分支，考试主体沿用已授权布局。

原有跨模块差异仍记录如下：TOEFL 底色 `#F6F7F3`、子页绿色导航；主站和 SAT 底色 `#F5F4F0`。主站显示 `displayName`，SAT/TOEFL 胶囊显示 `username`（SAT 展开卡片显示 `displayName`）。主站、SAT 与 TOEFL 的账号菜单收起/键盘规则也存在差异。这些不是合并冲突，本次未另行重画页面。

## 验证与数据边界

整合版本 Python 236 项通过；TOEFL 匿名构建、88 文件源码清单与 46 组回归通过。十份 Chrome 浏览器脚本通过：统一账号、SAT 账号菜单、同步冲突、账号保存恢复、用户名、存储、数学、笔记、题集与全库组题。浏览器使用临时账号和匿名数据，不修改维护者数据库。未验证 Windows、Safari、真实录音、公网服务或多人容量。

已授权的耕读题库和 PDF 转换题包随本地 Git 历史保留；PDF 工作区文件与其已有提交逐文件摘要一致。原 PDF、数据库、答题记录、备份、截图、ZIP 和 `.DS_Store` 没有新增进入提交。检查产物在整合工作副本的 `local-data/`；原工作区快照清单与补丁在主目录的 `local-data/integration/2026-10-24/`。

此次合入只发生在本机。协作者尚不能从 GitHub 拉到本次结果；以后经授权推送并更新远端 main 后，协作者再拉取最新 main 并开新分支。
