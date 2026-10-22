# 托福题目源文件标准 v1

本模块固定使用 `toefl-task/1`。这是托福编辑与导入的稳定格式，**不是尚在讨论的公共题包 v2**。其他科目不需要改动；以后由适配器映射到团队批准的公共协议。

每一篇材料或一个来源任务、一个日期版本单独一个 JSON 文件，结构为：

```json
{"formatVersion":"toefl-task/1","task":{"id":"source-task-id","module":"reading-t1","source":"ANONYMOUS_FIXTURE","title":"Title","date":"2026-10-21","group":"recurrence-group","duration":180,"complete":true,"items":[{"id":"q1","kind":"complete_word","prefix":"le","missingLetters":"arn","answer":"learn"}]}}
```

字段以 `schemas/task.schema.json` 为准，可用于编辑器 JSON Schema 提示。校验器支持该文件实际使用的有限关键词，并额外检查题型、答案选项、填词字母、引用、重复 ID 与音频区间。不得在 v1 中自行新增字段或改变含义；兼容新增需审查，破坏性改变另开版本。

- `module:id` 是任务身份，`items[].id` 是原小题身份；不能因改标题、换顺序而更换 ID。
- `group` 关联复现，`date`、`occurrenceDates`、`occurrenceCount` 保留日期与历史版本。不同来源日期版本分别保留，不以最早年份过滤，也不合并覆盖原任务。
- `items` 数组决定小题顺序，`content` 内的 `item_id` 对应小题。材料、逐题解析、翻译、参考答案及音频时间区间均保留原字段。
- 支持阅读 T1/T2/T3、听力 T1/T2/T3/T4、口语 T1/T2、写作 T1/T2/T3。写作来源旧名称 `write_email/academic_discussion` 与匿名样例 `email/discussion` 均为已声明兼容值；不改写原值。
- 组句按词块重建句子并比较规范化文本，不强制只有一种词块索引排列。主观题没有来源范文时不得编造来源答案。
- 媒体使用 `audio/`、`images/` 相对路径，来源 HTTPS 地址仅作来源记录或待本地化资源；不内嵌二进制。部署资源独立于 Git，验证时可指定完整资源根目录。

## 编辑与验证

以下命令均在 `apps/toefl` 下执行，使用 Node 22.13 或更新版本：

```sh
node scripts/task-files.mjs export fixtures/anonymous-bank.json dist/editable-example
node scripts/task-files.mjs validate dist/editable-example
node scripts/task-files.mjs import dist/editable-example dist/edited-bank.json
```

`export` 创建新目录，已有目录会拒绝覆盖。目录包含 `library.json`（文件索引与词汇等题库元数据）和 `tasks/<module>/<稳定散列>.json`。散列来自来源 ID，仅作跨平台安全文件名，真正身份仍是文件内的 `module:id`。导出保留源顺序；修改单题文件后 `validate` 检查，再 `import` 生成新题库，不覆盖旧文件。文件名和索引不随正文修改而变化，便于多人分开编辑。

完整私有题库同样使用上述命令，将输入、输出放在 Git 忽略的私人目录。`validate <目录> <媒体根目录>` 会额外核对本地媒体引用。工具不读取或写入账号、练习进度、个人录音、AI 评分或数据库。

题目源文件含答案、原文与翻译，属于**受保护的编辑资源**，不能直接作为公开的答题接口。现有部署仍通过登录与加密资源交付，作答阶段由现有界面控制解析展示。此标准不声称提供可防已登录用户提取答案的服务器考试安全模型。Git 只保留格式、工具和原创匿名样例；真实题库、来源媒体与用户数据继续分开保存。
