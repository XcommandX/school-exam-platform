# AP 分科分年套题包结构样例

这是用于讨论数据结构的**原创目录样包**：13 个独立科目/年份 profile、17 个 section、17 个普通题目、5 个项目任务、38 个可评分 Part。它不是把所有科目拼成的一张 AP 试卷，也不是一套已经能运行的完整模考。所有 profile 都标记 `assemblyStatus: incomplete`。

本目录按 [公共草案约定](../CONTRACT.md) 分为 `pack.json`、`assessment.json`、`items.json`、`solutions.json` 和 `assets/`。仅供设计与审核，没有改动、导入或接入现有 SAT 页面、题库与运行时。

## 如何使用这些文件

1. 在 `assessment.json` 选择一个 `courseProfiles[].id`，只组装具有相同 `courseProfileId` 的 section。不能按顶层数组把不同科目的 section 串成一张试卷。
2. 按 modules 中的题目引用和选择组装配题目；`choiceGroups.choose` 表示需要选做的题目数量。普通题和项目任务分别在 `items` 与 `assessmentTasks` 查找。
3. Part 引用 `solutions.json` 中的标准答案、参考答案、评分点和解析。自动评分目前只演示选择题；开放题都保留多种可接受响应和人工 rubric。
4. `assets` 里只有 3 个随包附带的原创 SVG。8 个 `placeholder` 资源路径故意没有对应媒体文件，正式投递必须阻止缺资源的任务启动；不能把占位误报为已支持音频、乐谱或项目参考。
5. 正式考试投递要由平台剥离 `solutions.json`、复盘原文和参考音频。只在 UI 隐藏不能保护答案。当前旧引擎没有因本草案新增这些保护。

## 题型覆盖与对应示例

| 家族 | 示例 ID | 表达的信息 |
| --- | --- | --- |
| 单选与指定数量多选 | `csp:single`、`csp:select-two` | 稳定选项 ID、选 2 约束、无顺序答案集合 |
| 数学多小问 FRQ | `calc:frq` | 表格、计算、方法分、单位、前题结果跟随评分和整体舍入规则 |
| SAQ / DBQ / LEQ 与选做 | `ush:saq-*`、`ush:dbq`、`ush:leq-*` | 来源材料、选做组、论证与证据 rubric；DBQ 只含 2 份原创材料，显式标记缺少完整 7 文献结构 |
| 历史格式变化 | `ush:leq-2027` | 2026 LEQ 三选一与 2027 必答宽题干分别保存，不覆盖旧规则 |
| 听力、对话、口语录音 | `language:conversation-2026` | 提示顺序、录音格式、逐轮时间，复盘可见原文 |
| 新语言项目与多来源作文 | `language:project-2027`、`language:essay-2027` | PPR 要求、准备/展示/4 轮问答阶段、print+audio 来源、项目依赖的答案与评分表 |
| 物理实验、图形和手写 | `physics:graph-method` | 图题、坐标系、绘图答案、手写图片/PDF替代提交、方法解释；不需要 OCR |
| 音乐听写与视唱 | `music:dictation`、`music:sight-sing` | 音频、五线谱、MusicXML、手写备选、视唱录音、参考演唱资源 |
| 编程自由回答 | `csa:method` | Java 原样空白、代码响应、方法级 rubric；不把执行测试当作官方判卷 |
| 多文件设备证据 | `cyber:evidence` | firewall rules、logs、file permissions、policy 的独立结构化文档及证据引用 |
| CSP 项目 | `csp:create` | 程序 PDF、视频、PPR、考前项目和考场响应的分离 |
| 艺术作品集 | `art:portfolio` | Sustained Investigation、Selected Works、作品元信息、引用；3-D 的双视图规则需另建科目 profile |
| Capstone | `research:paper-defense`、`seminar:team-project` | 论文、展示、答辩、团队与个人部分分离、附件提交要求 |

这些样例用于检查公共模型能否表达主要家族，**不表示每一科的完整蓝图、正式 rubric 和所有资源都已编好**。例如 Biology、Chemistry、Economics、Statistics、Latin 等仍需要各自内容与年度规则审核；`toolPolicyProfiles` 中部分科目只有计算器政策占位，没有整卷题目。

## 2026 与 2027 的规则边界

`courseId + administrationYear + examVersion` 决定评估规则。profile 中 `effectiveFrom` 是本草案为学年建立的命名空间起点，明确不是官方考试日期；可核实的规则来源在 `sourceRefs`，详细网址位于 `pack.json.references`，查询日期为 2026-10-22。

- 2026 Calculus 示例依据当年评分材料，不能将其题量或时间沿用为已经调整的 2027 蓝图。
- 2026 US History 保留 SAQ 的最后一题选做和 LEQ 三选一；2027 则按照更新后的必答 SAQ 与宽题干 LEQ 分开配置。
- 2026 西语口语对话属于历史格式；2027 西语使用项目展示、4 轮项目问答、论证作文以及听读选择题。2027 项目展示准备与作答各 3 分钟，问答每轮 40 秒，作文 55 分钟。这些是版本规则，不能给所有语言年份通用。
- 2027 Music Theory 使用 hybrid 数字考试并在 Bluebook 录制视唱；2027 Statistics 转为 fully digital。题干数字呈现和响应手写/录音/键入需要分别描述。
- `timeLimitSeconds: null` 表示这个不完整样包没有定义可直接启动的计时，不表示正式 AP 无时间限制。没有核准的听力播放/回放规则也显式留待核对。

## Desmos 是平台工具依赖

本包不带 Desmos JS、SDK、二进制、引擎或 API key。全部模式共用 `runtimeRegistryKey: "desmos.shared"`，同一提供方 runtime 由平台只加载一次；graphing、scientific、four-function 由各工具的 `kind` 与 `configuration.mode` 区分，再按需创建实例。平台统一初始化、销毁和配置，并在具体科目、年份、section/part 执行计算器许可。

平台可以在适用授权下使用官方托管或获准自行托管的 runtime；自行托管不等于 Desmos 引擎完全开源或无需授权。两种托管方式都不应逐套题复制引擎。普通计算器开始为空白；学生演算状态只存在独立 attempt 中，不写回题包。

Calculus 与 Precalculus 有禁止计算器的部分；Economics 只声明 four-function，Biology 的当前政策为 scientific，Physics/Chemistry 可有 scientific 与 graphing。不能因为平台有 Desmos 就对全部 AP 题开放 graphing。普通 SDK 是否与 Bluebook 的考试专用功能完全相同仍标记未核验。

## 答案、解析与个人记录

每个可评分 Part 都有 `solutionId`，包括项目、口语、绘图、手写与代码。选择题提供答案集合；开放题提供参考内容、要点、rubric 与解析，不能以一个唯一字符串判定。

所有题目、材料、解答和 SVG 均为本次原创合成内容。官方资源只链接来源，未复制官方真题、媒体或学生示例。实际项目、录音、手写文件、姓名、团队身份、计时、已选答案、批改和成绩均不在包内；`artifactRequirements` 仅定义未来提交要求。

## 后续实施前必须补齐

- 每科、每年度完整蓝图、选做和导航规则、各 section 时限、评分权重、工具与参考资料、无障碍规则。
- 待编校的原创题和 rubric；真实科目知识有效性检查。示例中的虚构历史材料仅测试结构，不能代替真实历史训练。
- 替换 8 个资源占位，清理录音格式差异，计算正式 SHA-256，审查资源授权并验证所有引用。
- 导入校验、渲染交互、录音上传、图形/乐谱编辑和人工阅卷接口。此草案并未实现这些能力。
- 安全拆分题目、答案与 attempt；不得把当前目录直接全量公开为考试投递接口。
- 保持 raw practice rubric 与官方 AP 1–5 分开，没有校准依据不提供换分公式，也不合计不同科目的分数。
