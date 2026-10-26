# School Exam Platform

面向校内约 150 名学生的标化考试刷题平台。目标是将已有 SAT、托福刷题功能整合到统一网址，提供统一登录和云端答题记录，由约三位开发者使用 Codex 协作维护。

## 当前状态

统一学习首页位于 `apps/web/`，采用已确认的 Study Space 模板：暖白背景、现行 TOEFL 青绿主卡与 SAT 橙色主卡，主卡下方提供 AP 独立入口。首页保留四科托福入口，SAT 阅读与文法统一显示为“英语”；原模板的顶部白色导航、搜索、继续上次示例和底部工具栏已移除。学习计划、成绩报告、目标分数和设置从右上头像进入。

SAT Reading & Writing 已接入自定义训练、按套练习、复盘与错题本；非考试管理页面已更新视觉，点击开始后的准备、考试、检查和完成阶段继续保护原有界面与行为。`apps/toefl/` 已接入 `feature/toefl-exam-interface` 分支 `72ab41d` 的源码，通过 `/toefl/` 运行原创匿名样例，支持四科入口和学习页面导航；完整私有题库、正式账号、云端同步与外部 AI 未接入，不能将匿名样例视为真实完整模考。AP English Language and Composition 已通过首页独立卡片与 `/ap/` 接入本机私有 PDF 题库、选择题练习、FRQ 草稿与评分资料复盘；作答阶段参照 SAT/Bluebook 双栏界面，提供 MCQ 60 分钟、FRQ 135 分钟（含 15 分钟阅读）的限时模式及自由练习，支持暂停/恢复、到时提醒与草稿续作，详见 [AP 接入与导入](docs/ap-language.md)。SAT 数学和跨考试 Personal Vocab 仍保留待接入接口。

测试阶段直接使用 `admin` 本机测试身份，无需输入密码，不提供真实认证或管理员权限。每日目标、目标分数和练习统计只使用当前浏览器的新平台存储；支持新 TOEFL 1–6 分、0.5 分档及 SAT 两科目标，尚未实现统一账号与跨设备记录。

Git 仅包含源码、空题库种子和原创合成示例。授权迁移的真实 SAT 题库和必要图片保存在被 Git 忽略的 `private-data/`，不随推送上传；个人已选答案、旧练习记录和错题记录不迁移。SAT 的 OCR 已取消，模型、HAR 和原浏览器数据均不导入。AP 使用独立的本机 PDF 导入器与 v2 题型契约：原卷保存在忽略目录，扫描材料不做 OCR；不会将 PDF 上传 Git。统一格式见 [题库格式](docs/question-format.md)，本地运行见 [统一首页](docs/unified-home.md)。

已确认的要求：

- 约 150 名总用户；同时在线人数尚未确定。
- 一个统一网址、一套登录身份、云端保存答题记录。
- 三位开发者分别在 Windows / macOS 上独立开发，任何一人下线不影响其他人工作。
- 使用功能分支和 Pull Request 审核合并；开发过程以 Codex 为主。
- GitHub 协作与部署优先采用免费方案，容量和功能以实际服务额度为准。

## 从这里开始

| 任务 | 文档 |
| --- | --- |
| 让 Codex 理解项目 | [AGENTS.md](AGENTS.md) |
| 沿用首页与 SAT 管理页样式 | [参考样式](参考样式.md) · [参考 CSS](参考样式.css) |
| 团队日常协作 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 三个人如何使用 Codex | [Codex 工作流程](docs/codex-workflow.md) |
| 收集已有 SAT、托福代码 | [源码接入清单](docs/source-intake.md) |
| 运行和继续开发 SAT 原型 | [SAT 接入记录](docs/sat-source-intake.md) |
| 理解整合边界和数据约定 | [架构与整合计划](docs/architecture.md) |
| 选择免费部署服务 | [部署评估](docs/deployment.md) |

## 第一阶段完成标准

1. 两套原始源码与资源已收集，并记录来源版本和原有启动方式。
2. 两套功能分别能在开发电脑运行；Windows 和 macOS 的启动步骤均已验证。
3. 确定统一网站、登录与答题记录的实现方式，并记录决定。
4. 提供准确的安装、启动、检查和部署命令，随后补充自动检查。

## 运行统一首页

需要 Python 3.10 或以上版本。要从源码构建 TOEFL 匿名样例，还需 Node.js 22.13 或以上版本；两部分均无需安装第三方包。在仓库根目录运行：

```sh
python3 scripts/serve_platform.py --port 8888
```

打开 [统一学习首页](http://127.0.0.1:8888/)。macOS 也可双击根目录的 `Start Study Platform.command`。服务启动时会调用 `PATH` 中的 Node.js 构建 TOEFL 匿名样例；也可先进入 `apps/toefl/` 运行 `node scripts/build.mjs`。没有 Node.js 时，已存在且通过匿名构建标记检查的 `dist/preview` 仍可使用；没有构建产物则托福入口提示未就绪，SAT 和首页可继续使用。生成的 `dist/` 不提交。

新平台使用独立的浏览器存储名称，不读取原 SAT 或 TOEFL 应用的个人练习记录。服务仅监听本机，不用于校内公开部署。

其他开发者克隆后 SAT 与 AP 真实题库初始为空，AP 可主动打开原创示例，TOEFL 只有原创匿名样例。AP 本机 PDF 导入、依赖和检查命令见 [AP Language](docs/ap-language.md)。使用 SAT 页的 JSON 导入或本地迁移脚本填充本机题库；TOEFL 私有题库尚未接入统一服务。不要通过 Git 共享真实题库或个人数据；所有层级的 `.DS_Store` 也应保持忽略。详见 [本地题库迁移](docs/unified-home.md)。

## 运行独立 SAT 原型

需要 Python 3.10 或以上版本，无需安装第三方依赖。在仓库根目录运行：

```sh
python3 apps/sat/scripts/question_bank_server.py --root apps/sat --port 8876
```

打开 [SAT 本机页面](http://127.0.0.1:8876/html/index.html)。初始题库为空，可用 `apps/sat/data/examples/synthetic-practice.json` 导入两道原创合成题，检查基础练习流程。完整操作及验证范围见 [SAT 接入记录](docs/sat-source-intake.md)。

本副本默认使用端口 8876。若该端口用于其他练习环境，请另选空闲端口，避免读到既有浏览器记录；同一端口下换页面路径不能隔离 IndexedDB / localStorage。

Windows 可按本机 Python 安装方式把 `python3` 换为 `py -3` 或 `python`；Windows 启动尚未验证。此命令运行的是独立 SAT 原型，统一平台尚未部署。

## 合作方式

领取任务 → 更新主分支 → 创建功能分支 → 使用 Codex 修改并验证 → 推送分支 → 提交 PR → 另一人检查 → 合并 → 其他人更新代码。

`main` 保存团队认可的版本。每项任务使用短期分支，具体分支和提交操作见 [CONTRIBUTING.md](CONTRIBUTING.md)。

macOS 可双击仓库根目录的 `pull.command`，从 `origin` 同名分支快进更新当前分支；未提交改动或分支分叉时会停止。完成功能分支的本地提交后，可双击 `push.command` 推送。两个脚本都支持 `--check` 只读检查，不自动提交文件或强制覆盖；详细用法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

仓库同步源码、配置样例和数据库结构变更；数据库中的实际答题记录由网站后端保存，不通过 Git 同步。
