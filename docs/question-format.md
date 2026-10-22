# 统一题目格式与本机题库

统一首页按 `sat`、`ap`、`toefl`、`vocab` 隔离题库。当前已接入的答题引擎只有 SAT Reading and Writing；其他考试使用同一题集外层约定，等待接入自己的题型、模块和判分器。当前 schema v1 支持单选题；听力音频、口语、作文与多选题需要后续扩展格式和引擎，不能仅改变 `exam` 就认为已支持。

格式定义位于 [`shared/question-set.schema.json`](../shared/question-set.schema.json)，标准库校验和 SAT 兼容转换位于 [`shared/question_schema.py`](../shared/question_schema.py)。后端还会检查 JSON Schema 无法独立表达的关系：模块题量之和、模块时长数量、正确选项范围、题目 ID 所属题集、文字格式范围与表格列数。

## 题集与题目

```json
{
  "schemaVersion": 1,
  "exam": "sat",
  "id": "sat:synthetic-example",
  "title": "原创格式示例",
  "section": "Reading and Writing",
  "defaultDurationSeconds": 60,
  "questions": [
    {
      "id": "sat:synthetic-example:q0001",
      "section": "Reading and Writing",
      "passage": "",
      "passageFormatting": [],
      "passageStyle": "prose",
      "prompt": "Select the letter A.",
      "promptFormatting": [],
      "options": ["A", "B", "C", "D"],
      "optionsFormatting": [[], [], [], []],
      "correctOption": 0,
      "questionType": "",
      "explanation": "A is the requested letter.",
      "aiExplanation": "",
      "visualStimulus": null,
      "customMetadata": {}
    }
  ]
}
```

- `id` 使用考试命名空间。同名原始文件在不同考试内不会冲突；本地迁移从原始文件名摘要生成稳定题集 ID，题目 ID 加上顺序编号。修订题意或调整题目顺序时仍需注意历史记录版本；当前没有跨设备历史迁移。
- `correctOption` 从 0 起算，是题目的正确答案，不是某位学生选择的答案。SAT 必须有四个选项；其他考试单选题至少两个。
- `moduleQuestionCounts` 和 `moduleDurationsSeconds` 可选。迁移保留原有模块题量与计时，`moduleIndex` 从 0 起算，`questionNumberInModule` 从 1 起算。
- `passageFormatting`、`promptFormatting`、`optionsFormatting` 保留加粗、斜体、下划线，范围采用浏览器 JavaScript 的 UTF-16 字符位置。旧 `passageMarkdown` 在规范化时转换为正文与范围。
- `visualStimulus` 支持表格、图片和图表。图片使用 `question-assets/<exam>/...` 相对地址，禁止外部 URL 和目录穿越。图片本体保存在本机私有目录。
- `answerProvenance`、`agentSuggestedAnswer` 可选，表示答案编校来源；它们与学生作答记录不同。
- `customMetadata` 采用白名单：来源考试/题号、模块号、题型、section、表格源图引用。任意嵌套元数据、原用户选项、姓名、attempt、成绩和修题过程记录不会带入新题库。

## 兼容已有 SAT JSON

```python
from shared.question_schema import normalize_question_set, to_sat_legacy, validate_question_set

canonical = normalize_question_set(old_sat_json, exam='sat', source_key='stable-source.json')
validate_question_set(canonical)
legacy = to_sat_legacy(canonical)
```

`normalize_question_set` 只返回允许的题目字段，不读取文件或浏览器存储。它接受旧 `answer: "A"` / `answer: 0`，输出 `correctOption: 0`；接受旧 `durationSeconds` / `durationMinutes`，输出 `defaultDurationSeconds`。`validate_question_set` 校验已规范化的数据并拒绝未知字段。

`to_sat_legacy` 还原现有 SAT 导入器需要的 `answer` 与 `durationSeconds`，并保留题集 `id`、`sourceId` 和题目 `id`，让统一首页可以按稳定来源进入原答题引擎。再次导入这份兼容 JSON 时，规范化函数保留已验证命名空间的 `sourceId`，避免同一内容生成新的题集身份。它仅适用于 `exam: "sat"`。

## 本机迁移与隐私边界

私有内容目录已被根 `.gitignore` 忽略：

```text
private-data/
  question-banks/
    sat/*.json
    ap/*.json
    toefl/*.json
    vocab/*.json
  question-assets/sat/**
  migration-input/sat-original-seed.json
  sat-migration-report.json
```

迁移需要明确提供旧应用目录，在仓库根目录运行：

```sh
python3 scripts/migrate_sat_bank.py --source-root /path/to/original-sat-app
```

脚本默认只读取该目录的 `question-bank/*.json` 及题目引用的 `question-assets` 图片，不读取 HAR、浏览器数据库、练习记录、PDF、备份或 OCR 目录。迁移前确认目的地仍被 Git 忽略，拒绝符号链接及越界图片。题库文件名只含稳定 ID，不带原来的个人整理标签；原“错题”集合中的题目保留为中性命名的补充题集。已存在且相同的内容不会重复写入；需要更新内容时先审核，再显式使用 `--replace`。

额外使用 `--include-examples` 会检查 `data/examples/*.json`，只补充题库中尚未包含的题目，按正文、题干、选项和正确答案的内容摘要去重。原 `data/questions.js` 含有个人姓名配置，不能直接复制；此次在隔离的 JavaScript 环境中仅提取了题目字段，生成上述本机忽略目录内的 `sat-original-seed.json`。迁移脚本自身不执行 JavaScript；通过 `--seed-json` 显式读取经过审核的 JSON。保留这份私有导出后，可重复执行完整迁移：

```sh
python3 scripts/migrate_sat_bank.py --source-root /path/to/original-sat-app --include-examples --seed-json private-data/migration-input/sat-original-seed.json
```

2026-10-22 的本机完整迁移结果：18 个题集、929 道题（原题库 901 道、原型种子 27 道、独立示例 1 道），以及 36 张被引用的题图。另一个示例的 4 道题已在题库中，未重复导入；剔除 15 个原用户选项字段，未迁移个人练习或错题记录。报告只保存在忽略目录，不写入原题目、原文件路径或个人字段。

题库与图片未加入 Git，推送源码不会自动让其他开发者取得这些本机资源。共享题库需要另行确定资源授权、存储与分发方式。不能用 `git add -f private-data` 绕过这个边界。

验证转换逻辑：

```sh
python3 -m unittest discover -s tests -p 'test_question_schema.py' -v
```
