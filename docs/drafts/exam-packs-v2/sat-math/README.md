# SAT Math 套题结构样包

这是供团队审阅的 **v2 格式草案**：包括 4 道原创数学样题、1 道不计入考试的教学互动图示例、答案解析、两张原创 SVG 和一个明确标记的 Desmos 图状态占位文件。它不是官方真题或完整试卷，不能直接导入当前 SAT Reading and Writing 引擎；原 SAT 的 HTML、JS、CSS 和 v1 格式均未修改。

## 如何查看

- `pack.json`：整包身份、附件清单、摘要、平台工具依赖和规则来源。
- `assessment.json`：标准数学卷蓝图、模块、时间、适应性路由占位与样题覆盖情况。
- `items.json`：共享材料、表格、LaTeX、图片、题目/小问和作答输入要求。
- `solutions.json`：与每个小问一一关联的答案、解析、步骤和选项反馈；正式投递时须由服务端剥离。
- `assets/`：两张原创 SVG、一个待作者导出的图状态占位 JSON。没有个人作答或录音，也没有 Desmos 引擎、SDK 或 API key。

样题展示四类需求：根据表格求线性函数值的四选一；允许正、负两个答案之一的 SPR；有分数及多种合格小数写法的 SPR；带原创几何图的四选一。第五道题只说明教学模式如何声明互动图及静态替代图。

## 考试规则与蓝图

SAT 数学包含四选一与学生自行输入答案的 SPR。SPR 可以有多个正确数值，但每题只输入一个；不能用强制四选项加单个 `correctOption` 表达全部数学题。[College Board SPR 说明](https://satsuite.collegeboard.org/sat/whats-on-the-test/math/student-produced)

标准数字 SAT 数学为两个分别计时的 35 分钟模块，共 44 题；第二模块难度取决于第一模块表现。本样包仅把这组标准写入可版本化蓝图，并明确 `assemblyStatus: "incomplete"`，不伪造缺失的 40 道题，也不编造官方路由阈值。只有样题预览数据，不应启动正式整卷计时。[College Board 考试结构](https://satsuite.collegeboard.org/sat/whats-on-the-test/structure)

`profile` 将模块时长、输入限制、导航、计算器政策与单题内容分开。官方框架版本为 **2026 年 9 月的 v4**；该材料没有给出这些规则共同生效的确切日期，因此 `effectiveFrom` 为 `null`，用 `ruleEditionPublishedOn`、`rulesVerifiedOn` 记录版本与核验日期。数字/线性卷、延长时间或后续规则应另设配置，不能修改所有题目的正文。[官方框架](https://satsuite.collegeboard.org/media/pdf/assessment-framework-for-digital-sat-suite.pdf)

SPR 输入规则按该框架附录 D 的印刷页 205（PDF 第 214 页）草拟：非负输入最多 5 个字符；负数最多 6 个字符，包含负号；使用符合空间限制的分数/小数，带分数改成假分数或小数，不附百分号、逗号、货币符号。小数不够空间时按官方方向处理截断/四舍五入。本样题中 `2/3`、`.6666`、`.6667`、`0.666`、`0.667` 合格，`.66`、`.67` 等不合格。输入语法检查与数学判定分开：等值分数可精确比较；循环小数使用审校后的写法集合，不用统一宽松浮点误差。[官方输入说明与示例](https://satsuite.collegeboard.org/media/pdf/assessment-framework-for-digital-sat-suite.pdf#page=214)

标准答案、练习原始分与官方换分也分开。示例每题 1 分只代表本地练习结果；没有官方校准、题目参数与适应性换分信息，因此不生成 200–800 的官方数学分数。题型、知识点分类以[官方数学概览](https://satsuite.collegeboard.org/sat/whats-on-the-test/math/overview)为规则来源；示例题本身为原创。

## Desmos 由平台共用

套题只声明 `runtimeRegistryKey: "desmos.shared"`、用途、模式和配置需求，由未来平台工具层统一选择 SDK 版本、加载、初始化、销毁和授权方式。同一个注册项可服务多套试卷；每份包不重复带引擎或 key。该注册项是本草案的接口约定，当前平台尚未实现。

考试计算器是 `role: "utility"` 的空白工具；教学图是 `role: "stimulus"` 的作者内容。数学全程可以使用计算器，Bluebook 提供图形与科学模式；本包不把教学图预填进考试计算器。[College Board 计算器政策](https://satsuite.collegeboard.org/in-school-assessments/calculator-policy)

作者的教学图状态需要由共享 Desmos 实例的 `getState()` 原样导出，再由 `setState()` 加载；状态应视为不透明对象。当前 `teaching-parabola.graph-state.json` 只是说明性占位，不是可加载状态：媒体清单标记 `placeholder`、摘要为 `null`，现阶段使用原创静态替代图。替换为真实导出后，必须更新状态、摘要并核验资源引用。学生临时演算图状态另存个人 attempt，不回写原包。[Desmos API 文档](https://www.desmos.com/api/v1.12/docs/index.html)

Desmos 官方提供远程加载 API 的方式；其合作方也可以在授权范围内自托管完整 API，实现离线使用。平台注册表可据授权配置 `official-hosted` / `authorized-self-hosted`，不能把这理解为 SDK 公开开源、可随意下载分发或免费自托管。使用自己的 API key、开通哪些计算器能力及生产授权应按官方流程确认，草案不假定价格或许可。[API key 与自托管文档](https://www.desmos.com/api/v1.12/docs/index.html#document-api-keys)、[官方 key 入口](https://www.desmos.com/my-api)

普通网站版/SDK 与考试专用版的功能并不保证完全一致，考试配置可能按年调整。因此 `verificationStatus` 保持未核验状态，不能把设置为 SAT 配置的普通实例宣称为 Bluebook 的完全复刻。[Desmos 考试版说明](https://help.desmos.com/hc/en-us/articles/18228147914381-Practice-With-Testing-Calculators)

## 使用边界

正式完整套题还需补齐题目、公式表、第二模块分支及项目自己的练习路由政策，并实现导入校验、数学渲染、数值判分和工具注册层。套题内题号、资源、工具、答案和解析可被检查，不意味着这些运行功能已经完成。标准答案、解析及仅复盘可见材料必须按投递策略剥离；不能只用前端隐藏。

本目录不包含官方题目、真实题库、学生答案、成绩、错题状态、媒体提交或个人 Desmos 演算状态。所有媒体均是原创结构样例或明确的占位文件。
