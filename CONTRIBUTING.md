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
