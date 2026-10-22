# 团队协作约定

## 第一次加入

1. 使用自己的 GitHub 账号接受仓库邀请。
2. 将仓库克隆到自己的电脑；在 Codex 中将该文件夹添加为本地项目。
3. 阅读 README.md 与 AGENTS.md。
4. 完成源码导入后，按 README 中验证过的命令安装依赖、配置环境并运行项目。

每人拥有独立工作副本。某位成员下线时，其他人仍可继续开发；需要共享的修改必须先推送到 GitHub。

## 每项任务

1. 在 Issue 中写清楚目标、负责范围和验收条件，并由负责者认领。
2. 确保当前改动已妥善保存，然后更新主分支。
3. 为任务创建短期分支，例如 `feature/sat-review`、`fix/toefl-timer`、`chore/import-sources`。
4. 在分支上使用 Codex 开发并验证，将改动推送到远端。
5. 提交 PR，说明改动及验证证据。建议由另一位成员检查后合并。
6. 合并后更新本地主分支，下一项任务重新创建分支。

下面的命令只适用于工作区没有未保存改动时：

```sh
git switch main
git pull --ff-only
git switch -c feature/your-task
```

完成并检查修改后，可以提交和推送：

```sh
git status
git diff
git add <本次任务涉及的文件>
git commit -m "说明本次改动"
git push -u origin HEAD
```

遇到拉取失败或冲突时先检查原因，保留两边所需改动，不使用强制推送覆盖其他人的工作。

## macOS 双击推送

根目录的 `push.command` 用于将已经 commit 的当前功能分支推送到 `origin`。移动整个仓库后仍可使用；脚本以自身位置确定仓库目录。

1. 先查看修改和提交内容，确认本地 commit 不包含题库、个人记录、模型或密钥。
2. 双击 `push.command`，按终端提示查看检查结果和推送结果。
3. 推送成功后在 GitHub 创建 PR，待另一位成员检查后合并。

也可以在仓库根目录只执行检查：

```sh
./push.command --check
```

脚本拒绝直接推送 `main` / `master`，也会拒绝尚有未提交、已暂存或未跟踪改动的工作区；请先完成本地 commit。它不会自动暂存、commit 或强制推送。`--check` 不上传代码。

脚本优先使用已有环境代理；未设置时动态读取 macOS 系统 HTTP / HTTPS 代理，系统代理不可用时再尝试直连。不在共享脚本和文档中写死个人端口，也不修改永久代理设置；中国大陆网络能否直接连接 GitHub 取决于当前网络状况。

## macOS 双击拉取

根目录的 `pull.command` 更新当前分支对应的 `origin` 同名分支，例如在 `sat` 上只获取 `origin/sat`。它不会自动切换到 `main`，也不会把 `main` 的修改合入 `sat`。需要更新 `main` 时，先切换到 `main`，再双击脚本。

脚本会先检查工作区及网络，再下载远端提交，并且仅允许快进更新。未提交、已暂存或未跟踪的改动、尚未结束的 Git 操作、分支分叉或可能覆盖本地文件时都会停止；不会自动 stash、rebase、创建合并提交或强制重置。被忽略的本地题库等文件也受保护。

当前分支已有 upstream 时，必须是 `origin` 的同名分支；尚未设置 upstream 时，脚本仅探测并获取 `origin` 同名分支，不自动修改跟踪配置。代理检测方式与 `push.command` 相同。

只检查网络和远端状态、不下载提交或更新本地文件：

```sh
./pull.command --check
```

远端提交尚未下载时，检查模式只能确认远端存在且可访问；能否快进将在实际拉取时核实。拉取受阻后可能已经获取远端信息，但不会自动处理分叉或覆盖本地文件。拉取完成后仍需按修改范围运行项目检查。

## 审核与权限

- 约定 `main` 通过 PR 更新，任务按改动创建分支。
- GitHub Free 私有仓库的分支保护能力受套餐限制；团队流程不等于平台已经强制执行。
- PR 的审核重点是需求、行为、接口兼容性、数据权限和实际验证，不只看代码是否生成成功。
- Codex 负责辅助实现与检查；负责该任务的人应理解改动并核对验收结果。

## 共同调试

- 日常使用各自的本地运行环境和匿名测试数据。
- 在线预览用于让三人检查同一版本；调试写入测试数据，避免污染正式答题记录。
- 分享同一断点调试会话是临时协作方式，其可用性依赖发起人的电脑在线。
- 学生访问的正式网站应独立部署，不能依赖任何开发者电脑持续开机。

## 官方参考

- [GitHub 私有仓库协作](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration)
- [分支保护的套餐要求](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
