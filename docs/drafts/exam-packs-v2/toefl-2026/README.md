# 新 TOEFL iBT 2026 套题包草案

> 历史状态：2026-10-22 设计草案。当前项目按考试及题目类型分别设计题目包，TOEFL 现行实现见 [题型格式](../../../toefl/QUESTION_FORMAT.md)，SAT 以 [专用题目包协议](../../sat-question-packs/README.md) 为准。本目录的跨考试 `2.0-draft` 公共模型仍未接入；下文“当前”“本次”及源码快照均指当时调研，不应当作当前项目状态。

本文件夹是一套**出题端整包的结构样例**，同时草拟试卷结构、题组、共享材料、答案解析、评分标准及媒体清单。它不是一套完整真题或可直接运行的模拟考试；`assemblyStatus: incomplete`、`mockReady: false`，没有接入现有导入器、界面或判分器。公共字段遵循 [公共结构](../CONTRACT.md)。

所有题干、文章、音视频脚本及参考回答均为原创合成示例。ETS 资料只用于核对考试规格，没有复制其原题、媒体或真实学生数据。

## 文件与资源

| 文件 | 职责 |
| --- | --- |
| `pack.json` | 套题身份、2026 版本、文件入口、18 项占位媒体、规则来源 |
| `assessment.json` | 四科顺序、官方概览、模块/阶段、导航与时限、计分边界 |
| `items.json` | 12 类任务、共享材料与 31 个可评分小问 |
| `solutions.json` | 对应的 31 份答案/参考回答、解析与评分标准，出题端私有 |

`assets/` 的图片、MP3、MP4 均只在清单声明 `status: placeholder`，文件并不存在，`sha256: null`。这让资源缺失可被明确识别，避免用静音/提示音冒充听力。制作为可导入试卷时，须提供获授权的真实文件、时长与摘要，将状态改为 `included`，并逐项编校；本样包不应通过正式导入验收。不会下载官方媒体以填充占位。

媒体共用 `assetId`，题组共用 `material`，不把同一段录音复制到每道小题。音频/视频脚本保存在 `reviewOnlyContent`；正式考试投递必须从作答数据中剥离，只在复盘或获批辅助模式中提供。不能只把原文藏在前端折叠菜单或 CSS 后。

## 本次覆盖与缺项

| 科目 | 结构覆盖 | 完整性 |
| --- | --- | --- |
| Reading | Complete the Words、Read in Daily Life、Read an Academic Passage（含插句位置） | 示例含 10 个填词空、1 道日常阅读、2 道学术阅读；第二阶段路线缺题 |
| Listening | Listen and Choose a Response、Conversation、Announcement、Academic Talk | 每类各 1 道；第二阶段路线缺题，音频缺失 |
| Writing | Build a Sentence、Write an Email、Write for an Academic Discussion | 组句仅 1/10；邮件与讨论各 1 道 |
| Speaking | Listen and Repeat、Take an Interview | 结构列出 7 次复述及 4 次访谈回答；媒体缺失，复述逐题时限待核验 |

`items[]` 是题组/任务，不能用其长度充当官方小题数。`parts[]` 是可评分小问，每个小问关联唯一的 `solutionId`。填词使用稳定 `gapId`；组句使用稳定 `tokenId` 和 `slotId`，包含固定文字及一个干扰词，答案可声明多个可接受排列。将来修改题目时使用题目修订号关联历史作答。

开放邮件、讨论和访谈没有唯一正确答案：仍提供参考表达、完成要点、整体评分标准及解析。复述保留原句，但完整口语评分需要听取录音，不能只做 ASR 文本逐字比较。当前通用等级摘要是自编的练习提示，需逐题对照官方评分细则编校；不宣称复刻 ETS 引擎。

## 2026 规则与需要核验的配置

- 本包限定 `examVersion: ibt-2026-01-21`，四科顺序为 Reading → Listening → Writing → Speaking。旧版独立/综合口语及 integrated writing 必须使用不同考试版本，不能混用任务枚举。
- Reading 和 Listening 是两阶段自适应，第一阶段后选一个第二阶段，不能返回上一阶段；阅读可在同一模块内前后查看，听力按题向前。写作与口语线性。路线选择、校准题池及 IRT 等值模型是外部依赖，**本草案没有实现**；没有编造高/低路线阈值。
- 当前官方概览的名义基准是 Reading 50 题/约 30 分钟、Listening 47 题/约 29 分钟、Writing 12 题/约 23 分钟、Speaking 11 题/约 8 分钟，时间不含说明等步骤；官方明确自适应可能影响数量/时间。规格 PDF 中的 router + lower/upper 时间范围保存在 `officialTimingProfiles`，不是让缺题样包按完整时间开考。
- 邮件写作使用 420 秒，学术讨论 600 秒；讨论 100 词是建议，不作为自动判零门槛。组句示例不擅自从总科目时间倒推出逐题限制。写作与口语模块总时限均设为 `null`，仅保留科目基准；将来以任务/响应的事件时钟驱动，避免同时开启两套相互冲突的倒计时。
- 口语无准备时间；访谈四题每题 45 秒。复述每句时限本次未核实完整规则，因此使用 `null` 和 `needs-review-per-item`；这代表不能开考，不代表无限时。播放次数、跳转和时钟事件须随正式试卷规则进一步核验。
- 录音 MIME 类型只是平台兼容性候选；题包定义麦克风采集要求，不包含学生录音、ASR、答题时间或 AI 评分。字幕和辅助模式规则必须保持考试测量目的，不能默认向所有考生显示原文。
- 本 TOEFL profile 不允许计算器/Desmos，不从 SAT 自动继承工具权限。

来源：[ETS 当前结构](https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026)、[2026 规格](https://www.ets.org/pdfs/toefl/toefl-ibt-test-specifications-2026.pdf)、[Teacher FAQ](https://www.ets.org/content/dam/ets-org/pdfs/toefl/teacher-faq.pdf)、[2026 Teacher Practice Test 1](https://www.ets.org/content/dam/ets-org/pdfs/toefl/toefl-ibt-teachers-resources-practice-test-1.pdf)、[Overview（访谈时限）](https://www.ets.org/content/dam/ets-org/pdfs/toefl/toefl-ibt-test-overview.pdf)。核对日期：2026-10-22。

## 计分与隐私

客观阅读/听力及组句的计分小题最高 1 原始分，邮件、讨论及每个口语响应最高 5 原始分。练习原始分、AI 练习估分与官方 1–6 分必须分开。没有 ETS 校准/换分模型时，不根据简单正确率生成所谓官方 1–6 或 0–120 成绩；1–6 的四科/总成绩以及两年过渡期可比总分只记录为报告规范，`implemented: false`。

[官方口语评分标准](https://www.ets.org/content/dam/ets-org/pdfs/toefl/speaking-rubrics.pdf)及[写作评分标准](https://www.ets.org/content/dam/ets-org/pdfs/toefl/writing-rubrics.pdf)分别作为 rubric 来源。AI 若只得到 ASR 文本，不能评价发音、节奏、停顿或真实可懂度。个人答案、录音、ASR、教师批改、AI 估分与错题状态全部另存 attempt；不回写本题包。

## 与已有 TOEFL 源码的关系

只读检查的本地远程跟踪快照为 `origin/toefl` 的 `9d08f561a2d531e6fc89a2c682a94330e7e507d0`。本任务未 fetch，不能据此宣称 GitHub 此刻的最新状态。该分支已经包含源码及匿名样例，并非空分支；本草案未修改或接入它。

已有 `anonymous-bank.json` 顶层是 `records`、词汇等；每个 record 含 `module`、`items`、`passage`、`audio`、`transcript` 等。其 `platform-adapter.mjs` 的 `toefl-intake-draft-1` 只添加考试命名空间、哈希及来源，旧 record 仍封在 `payload`；它和 main 的单选 v1 并未成为同一个多题型协议。

| 旧结构 | v2 草案映射方向 |
| --- | --- |
| `reading-t1/t2/t3` | `reading.complete_words/daily_life/academic_passage` |
| `listening-t1/t2/t3/t4` | `listening.choose_response/conversation/announcement/academic_talk` |
| `speaking-t1/t2` | `speaking.listen_repeat/interview` |
| `writing-t1/t2/t3` | `writing.build_sentence/email/academic_discussion` |
| `passage`、`audio`、`audio_url`、`audioRanges` | 共用 materials、asset 清单及片段引用 |
| `mask/prefix/missingLetters` | gap-text、gapId 与 gap-map 答案 |
| `tokens/sentence_parts/answer_text` | tokenId、slotId、固定片段及可接受排列 |
| `recipient/subject_line/posts` | structured-document 情境与参与者元信息 |
| `answer/explanation` | 独立 solution + 解析；开放题追加 modelResponses 与 rubric |

旧前端已有 12 类任务和录音流程，但固定双模块组卷不等于官方自适应；原 AI 评估明示只是练习估分。匿名 fixture 中 180 秒 duration、2 秒口语准备与 15 秒回答仅用于流程测试，不作为官方配置迁入。

迁移应先增加版本化适配器与校验/能力检查，再由 TOEFL 负责人确认正式题包；不能覆盖原前端或只给 v1 改一个 `exam` 字段就宣称支持。未执行 commit、push、合并或部署。
