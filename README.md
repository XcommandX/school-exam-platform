# School Exam Platform

面向校内约 150 名学生的标化考试刷题平台。目标是将已有 SAT、托福刷题功能整合到统一网址，提供统一登录和云端答题记录，由约三位开发者使用 Codex 协作维护。

## 当前状态

本仓库已导入 SAT Reading & Writing 独立练习原型，位于 `apps/sat/`，可在本机运行。该原型尚未接入统一登录、账号隔离或云端答题记录；托福源码尚未导入，统一平台的技术方案与部署仍待确定。

本次 SAT 接入仅包含代码、空题库种子和两道原创合成示例题。真实题库、题目图片、PDF、个人答题记录与 HAR 均未导入。OCR 功能已取消，上传界面、任务代码和服务 API 已移除；仓库不包含 OCR 模型或运行环境，题目使用 JSON 导入。来源与已知限制见 [SAT 接入记录](docs/sat-source-intake.md)。

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

## 运行 SAT 原型

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
