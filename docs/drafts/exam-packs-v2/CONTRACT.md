# 套题包 v2 草案的公共结构

状态：仅设计草案；没有接入现有导入器、渲染器或判分器。文件与示例均为原创或结构占位，不包含实际学生数据。不得把示例中资源占位或练习计分当作官方考试实现。

## 目录

每套完整试卷是一个文件夹，可压缩为 zip 分发；不是孤立的单题 JSON：

```text
pack.json                    套题身份、版本、文件位置、媒体清单、工具依赖
assessment.json              考试版本、科目/section/module/stage、顺序、时限与路由
items.json                   题组、共享材料、大题/小问、交互与提交要求
solutions.json               标准答案、参考答案、解析和评分细则，出题端私有
assets/                      图片、音频、视频、文档、作者导出的图状态等
```

`pack.json` 顶层统一字段：
- `schemaVersion`: 固定 `"2.0-draft"`；`documentType`: `"exam-pack"`；`status`: `"draft"`。
- `id`、`revision`、`title`、`language`、`exam`（`sat` / `ap` / `toefl`）、`subject`、`examVersion`、`administrationYear`、`effectiveFrom`。
- `files`: `{assessment:"assessment.json",items:"items.json",solutions:"solutions.json"}`。
- `assets`: `[{id,kind,mediaType,path,status,sha256,...}]`；`kind` 为 image/audio/video/document/graph-state/musicxml/data；`status` 为 placeholder 或 included；占位 sha256 为 null，正式资源必须有摘要。可加 durationSeconds、width、height、language、caption、source、license。
- `toolRequirements`: `[{id,provider,kind,runtimeRegistryKey,configuration,verificationStatus,...}]`。
- `provenance`: 出题/编校来源；`references`: `[{id,title,url,accessedOn}]`；`draftNotes`: 字符串数组。

`assessment.json`: `{profile,sections,scoreReporting,draftNotes}`。
- profile 包括 id、examVersion、有效日期、科目、考试年份、规则来源；按科目和年份配置，不把 AP 所有科目当成同一试卷。
- sections[]: `{id,title,sequence,modules:[{id,sequence,itemRefs,timeLimitSeconds,toolPolicy,navigation,...}],...}`；可使用 stages、路由配置、材料组/大题选择等扩展。区分官方标准卷蓝图与只有少量原创题的结构样包：样包缺题必须明确 `assemblyStatus:"incomplete"`，不得伪称完整可考的真题卷。
- `scoreReporting` 明确 raw/practiceEstimate 与 official scaled scores 的区别，缺官方校准不能捏造 SAT/AP/TOEFL 换分公式。

`items.json`: `{materials:[],items:[],assessmentTasks:[],draftNotes:[]}`。
- materials[]: `{id,content:[Block],reviewOnlyContent:[Block],attribution:{...},metadata:{...}}`；多题引用同一阅读/音频/文献/图形，不重复附件。
- items[]: `{id,revision,title,sectionId,taskType,classification:{...},stimulusRefs:[],prompt:[Block],parts:[Part],delivery:{...},...}`。
- Part: `{id,label,prompt:[Block],interactions:[Interaction],solutionId,...}`。单选也用一个 Part，FRQ 可有多个部分/嵌套依赖。
- assessmentTasks[] 使用同一大题/小问结构，可再有 artifactRequirements、stages、projectReferencePolicy 等，用于作品集/项目/答辩，避免硬塞进普通选择题。
- Interaction: `{id,kind,required,prompt:[Block],options:[{id,content:[Block]}],constraints:{...},...}`。
- kind: single-choice / multiple-choice / numeric-entry / text-entry / gap-fill / token-order / extended-text / audio-recording / file-upload / drawing / code-entry / music-entry / composite。options 只在选择题使用。题目只定义录音/上传要求，不包含实际学生提交文件。

Block 使用 `type` 区分：
- text: `{type:"text",text,format?:"plain"|"markdown"}`，默认 plain；markdown 内的 `asset:<assetId>` 图片引用由平台受控解析，原始 HTML 禁用，渲染不得自动补载任意外部 URL。此扩展需与正式 schema 一并确认。math: `{type:"math",latex,spokenText}`。
- image: `{type:"image",assetId,alt,caption?}`。
- audio/video: `{type:"audio"|"video",assetId,alt,playback:{...}}`；回放/跳转/倍速等为版本化规则配置；transcript 放 reviewOnlyContent 或有权限的资源，不直接泄露在标准作答数据中。
- table: `{type:"table",columns:[{id,label,unit?}],rows:[{id,cells:[]}],caption?}`。
- code: `{type:"code",language,text}`。
- interactive: `{type:"interactive",toolId,role:"stimulus"|"utility"|"response",stateAssetId?,fallbackAssetId?,alt}`。
- gap-text: `{type:"gap-text",segments:[{type:"text",text}|{type:"gap",id,prefix?,suffix?,missingCharacterCount?}]}`。
- structured-document: `{type:"structured-document",format,fields:{...},content:[Block]}`，如邮件/帖子/防火墙日志。
- music-notation: `{type:"music-notation",assetId,alt,...}`；file: `{type:"file",assetId,label}`。

`solutions.json`: `{visibility:"instructor-only",solutions:[Solution],draftNotes:[]}`。
- Solution: `{id,itemId,partId,status,scoring,explanation,...}`。
- scoring: `{mode:"automatic"|"rubric"|"manual"|"external",maxScore,rules:[],rubric:{criteria:[],...},modelResponses:[],...}`。
- rules[] 使用 `{interactionId,kind,expected,...}`；例如 option-set、numeric、gap-map、token-order。预期答案可为集合、多个可接受排列、分数/数值规则；数值格式限制与数学数值判定需分开。
- 开放口语/作文/绘图/项目没有唯一答案：仍须有参考答案/要点、rubric 和解析；不能伪造一个唯一正确字符串。
- explanation: `{status,content:[Block],steps:[],optionFeedback:[],sourceRefs:[],...}`。每个可评分 Part 必须关联答案/参考答案和解析；尚未编校内容需显式标记 needs-review，不用空串假装完成。

## Desmos

包内不放 Desmos JS/SDK/二进制或 API key。`toolRequirements[].runtimeRegistryKey` 由平台统一解析为 SDK 版本与配置；计算器许可、可用功能、初始化、销毁、资源加载在平台工具层处理。API key 是部署级配置，按 Desmos 的授权方式配置，不能逐包携带。key 是否允许暴露按提供方规范处理，不把浏览器 SDK key 错当成永不出现在浏览器的后端密钥。

普通考试计算器默认空白，只声明允许的模式和分区，不预填解题表达式。教学题干若需要互动图，可引用作者通过 getState 导出的 JSON（graph-state 资源）及静态替代图；图状态不是 Desmos 引擎。学生临时演算图状态属于个人 attempt，不回写原始包。普通 SDK 与官方考试专用版不保证完全相同，需记录工具配置的核验状态。

## 边界

本包是出题端完整包；正式考试下发客户端时，标准答案、rubric 内部细则、解析、仅复盘可见原文应按投递策略剥离，不能只通过 CSS 隐藏。项目当前本机旧引擎仍客户端判分，此草案不代表该权限分离已经实现。

个人答案、作答时间、录音、ASR、教师批改、AI 分数、错题状态等另存 attempt/response 数据；本草案包不包含它们。正式导入需另实现资源校验、防越界/压缩炸弹、引用一致性、版本与校验和、媒体兼容及渲染/评分能力检查。
