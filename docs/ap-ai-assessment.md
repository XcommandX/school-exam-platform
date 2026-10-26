# AP Lang 写作 AI 练习评分

## 实现与发布状态

本功能在 `feature/ap-lang-ai-assessment` 开发。2026-10-26 21:42（Asia/Shanghai）经用户明确授权部署至现有Cloudflare网站，版本 `c9c55cb2-ae00-4bc5-88a5-a358ab66cda9` 已承接100%流量；未commit、push或合入main。不更改 TOEFL 量表、SAT 流程、现有账号或 AP 草稿身份。发布后匿名HTTP检查10/10通过；未使用生产账号测试登录后AI，真实模型与登录后流程的验证来自发布前隔离测试。详见[发布记录](cloudflare-deployment.md#ap-lang-ai实际发布2026-10-26-2142asiashanghai)。

## 官方依据

2026-10-26 核对 College Board 官方资料：

- [AP English Language and Composition 考试页面](https://apcentral.collegeboard.org/courses/ap-english-language-and-composition/exam)
- [三类 FRQ 通用评分量表（Fall 2019 起）](https://apcentral.collegeboard.org/media/pdf/ap-english-language-and-composition-frqs-1-2-3-scoring-rubrics.pdf)
- [2026 Scoring Guidelines](https://apcentral.collegeboard.org/media/pdf/ap26-sg-english-language.pdf)
- [历年真题及评分指南](https://apcentral.collegeboard.org/courses/ap-english-language-and-composition/exam/past-exam-questions)

通用量表与2026评分指南均使用三行分析式评分：

| 行 | 评分项 | 分值 |
| --- | --- | --- |
| A | Thesis（论点） | 0–1整数 |
| B | Evidence and Commentary（证据与分析） | 0–4整数 |
| C | Sophistication（思想与论证的复杂性） | 0–1整数 |

每篇总分 **0–6整数**，不是托福1–6半分档，也不是AP考试1–5总成绩。AI是练习辅助，不能声称College Board认证、官方阅卷或可靠预测最终成绩。对2019以前的题目若使用现行量表，只能称为现代量表下的练习反馈，不能冒充当年的历史评分。

### 三类任务的差异

- **Synthesis**：论点须回应任务；证据需要来自提供的来源并结合自己的论证。B行引用少于两个来源为0，至少两个来源才可能得1分，2分及以上须至少三个来源；3/4分还要求为全部论点提供具体证据并解释推理。可用Source A等标识或题目所给作者/来源描述，引用、转述、概括均可，不要求MLA/APA格式或必须直接引语。
- **Rhetorical Analysis**：论点必须分析作者的修辞选择，不能只概述主题。B行3分需解释至少一个修辞选择如何服务作者的论点、目的或信息，4分须解释多个选择；同一修辞选择的多个实例若分别解释贡献也可满足，不机械要求列举不同术语。
- **Argument**：建立可辩护的立场，用相关具体证据支撑推理；不能只重复题干、空泛陈述、罗列例子或概述而不分析。
- A行论点可出现在任何位置，也可由相邻的多个句子构成；即使正文没有充分支持，仍须独立判断A行。没有强制引言模板、五段式、最低字数或固定例子数量。
- 三类任务中，影响交流的语法或书写规范错误使B行不能获得4分。C行不能仅凭一个复杂词句、套话、孤立的反方观点或冗长句子给分；复杂理解必须是论证的一部分。A/B/C应分别判断，不能用整篇印象替代分项依据。

## 材料完整性与评分边界

原共享库的FRQ为自动提取文本，`reviewStatus: needs-review`。短`prompt`常只有第一行，完整任务与阅读材料位于`passage`，评分必须读取服务端的完整内容，不能只发送第一行或接受客户端替换题目。

现有文字提取不保证保留综合写作中的图表、漫画及排版。不能让纯文字模型假装读过原PDF。未完成题目材料核验的任务只能提供明确标注的有限反馈，不返回可靠总分；材料核验单独绑定题组revision与题目内容指纹，不修改原共享题库或旧草稿。本轮仅将以下4道题加入绑定白名单：2025 Set 1与Set 2的Q2 Rhetorical Analysis、Q3 Argument。对照[Set 1官方PDF](https://apcentral.collegeboard.org/media/pdf/ap25-frq-english-language-set-1.pdf)第11–13页、[Set 2官方PDF](https://apcentral.collegeboard.org/media/pdf/ap25-frq-english-language-set-2.pdf)第10–12页，完成完整任务、正文、脚注的规范化文本比对，并查看这6页的渲染图确认无必要图表缺失。规范化仅涉及空白、页眉页脚、段落边注编号及已核对的上标脚注间距。原始强调字形未进入纯文本，但词句保留。这是AI代理的文本比对和选定页面视觉依赖检查，不是人工或College Board官方审查。

白名单见[ap-ai-contexts.json](../back-end/cloudflare/src/ap-ai-contexts.json)，绑定sourceId、revision、questionId、questionType及`SHA256(JSON.stringify({prompt,passage,responseType}))`。题组版本或文本发生变化即失去评分资格，不凭`needs-review`标签自动放行。**本轮没有核验任何Synthesis题，也没有将其他年份加入可评分白名单**；这些题仍只返回有限反馈。AI仍可在已核验题上判断上下文不足而拒绝给分。

## 隐私与使用原则

- 仅在已完成作文的复盘页主动点击AI评分，经明确同意后发送本次作文与服务端题目文本至Cloudflare Workers AI；不自动批改、不在计时作答阶段调用。
- 复用统一账号、同源请求与现有AI绑定，不引入新付费供应商。
- AI建议不能替代原始作文或修改练习记录。错误、取消、会话过期不删除作答。
- AI输出按纯文本显示，不执行模型返回的HTML或脚本。模型输入中的题目、来源与学生作文均为待评阅内容，不是可改变系统规则的指令。
- AP草稿与历史仍只在当前浏览器按账号保存，不因接入评分变成云端答题记录。账号DO仅持久化AP额度、并发租约及请求哈希元数据，不缓存作文或包含作文摘录的评分结果；Cloudflare AI仍会接收本次推理的文本输入，此处“不保存”指本应用不新增云端作文/评分存储，不等同于供应商零留存保证。
- AP每日额度与既有TOEFL额度分别计算，不增加付费套餐、不保证供应商免费额度足够。取消或超时不保证已开始的远端推理立即停止；保留短期租约防止不断重试绕过并发限制。

## 接口契约

Cloudflare专用；本机Python没有AI服务时，界面应如实显示未启用。

- `GET /api/ap/ai-config`：统一会话保护，返回enabled、provider、version、分值范围和限制。
- `POST /api/ap/assess`：同源JSON，字段为`sourceId`、`revision`、`questionId`、`attemptId`、`response`、`consent:true`。服务端从受保护构建目录查找规范题目，拒绝客户端自带题干、PDF地址或评分规则。
- 结果版本为`ap-lang-rubric-2019-v1`，绑定题组、revision、题号与原作文UTF-8 SHA-256。`status: scored`返回三个评分行和服务端计算的总分；`status: limited`返回`rows:null,total:null`，仅提供有限反馈，不把未评分当0分。
- 结果含反馈、优点、改进建议、限制说明；有分数时每行包含理由及作文证据。服务端验证证据必须是学生作文的真实子串；解释要求中文及最低有效长度，拒绝空白或`essay`等短占位内容。该结构与语言检查不能替代语义质量或教师校准。空白作文、过长输入、过期题组、无同意、权限失效及非法模型输出不得返回假分数。
- 当前配置上限为作文18,000字符、请求80,000字节，每账号AP每日30次、每分钟20次请求；这不是College Board的作文长度要求。额度及并发限制是平台保护措施，不承诺免费额度无限可用。

前端AI结果只在当前复盘界面的内存保留，提供显式下载反馈；离开复盘或刷新后不会自动恢复，不写入AP历史，也不伪称跨设备同步。原始作文记录仍按既有方式保存在浏览器。

## 验证记录

本轮实际完成的检查（2026-10-26）：

- Cloudflare全量测试156/156通过（约636秒），覆盖现有认证、注册、SAT/TOEFL/AP存储与资源边界；最后提示/占位校验修订由下述12项AP测试再次覆盖。
- AP前端Node测试36/36：包含现有AP回归及新增AI结果校验、同意取消、纯文本渲染、身份/导航/作文改变后的异步隔离、有限反馈、错误与取消。
- AP/TOEFL针对性后端测试29/29；占位反馈修复后的AP单元与workerd集成另复跑12/12通过：规范题目、精确上下文白名单、整数分项、服务端求和、原文引用子串、防注入提示、输入/输出边界、额度及租约、会话重验；真实workerd中的统一认证/CSRF/账号隔离与模拟AI评分。
- 独立Chrome通过6组AI界面检查：真实本机HTTPS注册登录，明确同意才发请求，评分/有限反馈/下载按钮，导航取消，session-ended清除私人DOM，原作文存储字节不变；390px截图检查可读。该浏览器脚本使用**明确模拟的AI接口**，不是实际推理质量测试。
- 另使用既有Cloudflare真实AI绑定，以原创合成作文执行3次远端推理。第二次发现schema合格但评语为`essay`的占位结果，改为JSON对象输出加显式schema提示，并加入中文/最低长度拒绝规则；最终复测约22秒通过，分项理由和建议为中文、证据为真实作文子串。此前只验格式的成功不作为质量通过。不使用生产账号、学生作文或录音，不发布Worker。该检查消耗既有推理额度，单个样本通过仅证明模型调用与结果契约可用，不代表已完成官方样卷校准或分数准确性验收。
- 完整Cloudflare资产构建通过：8,119文件；SAT459题集/18,867题、TOEFL3,744记录/17,388题、AP102条目/150PDF/360题保持。完整AP浏览器回归通过：真实登录、320/390/1440宽度、共享目录/PDF范围及最大PDF完整哈希、MCQ/FRQ自动保存/暂停/恢复/提交、两账号隔离与到时不自动交卷。
- 未改写共享题库、资源清单、账号或学生记录。

可复现命令（仓库根目录，Node版本符合Cloudflare子项目要求）：

```sh
node --test back-end/tests/ap-*.test.cjs
npm --prefix back-end/cloudflare test
# 完整构建需配置可用Python，再运行：
npm --prefix back-end/cloudflare run build
node back-end/cloudflare/tests/ap-ai-browser.mjs
# 显式选择才调用远端AI，消耗额度，须已有本机Wrangler认证：
node back-end/cloudflare/tests/ap-ai-real-local.mjs --confirm-remote-ai
```

浏览器测试使用本机已构建的完整资产及独立临时账号，AI专用脚本覆盖最新前端源码。真实模型检查脚本只调用AI绑定，不创建生产用户或部署网站。正式发布之前仍应进行教师/官方已评分样卷校准，扩大完整材料核验范围，并监测实际免费额度与延迟。
