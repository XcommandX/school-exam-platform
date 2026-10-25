# TOEFL AI 批改：本地预览与后续启用

## 状态与范围

2026-10-26 用户在预览和真实本地测试后，明确授权六分制实现、上传 GitHub 与更新现有 Cloudflare 网站。在 `feature/toefl-ai-six-band` 分支发布，生产配置加入 Workers AI binding；具体完成状态、提交与部署版本以 [部署记录](cloudflare-deployment.md) 为准。不自动合入 `main`，不升级付费。Python 统一服务及私人 TOEFL 站不接入此适配，SAT 考试流程不改。

## 六分制合同

- 新结果为 **1–6 分、0.5 分档的单题练习估分**，不是 ETS 官方成绩、分科成绩或经官方校准的换算；不是把旧五分制乘以系数。
- 总分与分项均用新的六档能力描述直接评价，输出 `scoreScale: "toefl-practice-1-6-v1"`、`scoreMin: 1`、`scoreMax: 6`。非半分档和越界结果拒绝，不默默四舍五入错误输出。
- 旧五分制结果保留并标注旧制，不进入六分制平均、趋势与学习排程；重新评分按新标准生成。模型/量表版本进入缓存键，不能复用旧制缓存。
- 口语只估转写内容、组织、语法与复述文字一致性；即使复述文字完全匹配并得到 6 分，也不代表发音满分。空白作答或无有效转写不生成估分。
- 批量平均与趋势仅为已评单题的练习汇总，不代表官方整科估分；真实口音、麦克风和人工标注集校准仍未完成。

2026-10-26 用户确认界面符合预期，并授权真实 AI 本地测试。经用户在 Cloudflare 官方页面确认，Wrangler OAuth 已补充 `ai:write`；真实文本与合成语音链路已成功调用。此前固定演示仍独立保留，不能把它当成真实批改效果。该首轮测试未改变生产配置；后续六分制发布按上述授权执行。

## 供应商与免费约束

选择 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)，不另加第三方 API 密钥：

- 文本批改：[`@cf/meta/llama-3.3-70b-instruct-fp8-fast`](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)，[JSON Schema 结构化输出](https://developers.cloudflare.com/workers-ai/features/json-mode/)限定总分与维度半分枚举，服务端仍独立校验结果；不自动重试增加模型调用。
- 口语转写：[`@cf/openai/whisper-large-v3-turbo`](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)，随后对转写文本反馈。
- Workers Free 当前每天 **10,000 Neurons**，UTC 00:00（北京时间 08:00）重置；不是 10,000 次评分。Free 超额应拒绝请求，不自动升级付费。
- 按每次约 2,000 输入 token + 500 输出 token 粗算，文本约 156 Neurons，约 64 次/天；附带一分钟口语转写约 49 次/天。实际取决于题目、输出长度、录音时长、重试及模型价格，不能保证覆盖 150 人每日使用。应用按账号限流不等于全站费用上限。
- 1–6 是本应用的非官方单题练习估分，不等于 ETS 官方 TOEFL 分科成绩。**口语只提供转写、内容/语法/组织及复述文字对齐反馈，不提供可靠的发音、语调、重音或声学流利度评分**。转写错误可能影响反馈。

不采用 Gemini Free 作为面向校内未成年用户的默认方案：需额外审查其 [年龄与免费数据使用条款](https://ai.google.dev/gemini-api/terms)。任何供应商均应在真实学生使用前由学校确认适用条款与隐私告知。

## 启动隔离预览

需要现有 Node >=22.13、仓库锁定依赖（Wrangler 4.152.0、Miniflare 5.20261019.2-beta、esbuild 0.28.2）与完整 Cloudflare 资产构建。仓库根执行：

```powershell
node back-end/cloudflare/scripts/build.mjs
node back-end/cloudflare/scripts/preview-ai.mjs
```

已有完整构建时可只执行第二条。此脚本叠加当前白名单浏览器源码、实时编译 Worker；不改写完整构建，不触碰另一预览的账号或正式云端数据。

- 地址：`https://127.0.0.1:8790/toefl/?view=history`，只监听本机。
- 合成账号：`ai-preview`，密码 `Preview-only-2026!`，**仅限此本机临时预览**；不是正式凭证。
- 使用本地自签名 HTTPS；只对明确的 `127.0.0.1:8790` 预览接受证书提示，不关闭全局浏览器安全检查。
- 自动生成一份合成英文作文练习报告。进入“考试记录 → 查看报告 → 一键 AI 评分”，先阅读并确认发送提示，再查看固定示例布局。
- `AI_PREVIEW=true` 只在 loopback 主机有效；无 AI binding、`ENABLE_AI=false`。不联网调用模型。示例反馈不是针对提交作答生成；分数占位、示例纠错不会保存为成绩、进入进度或云端评分缓存。刷新后示例结果消失。
- 本机模拟 AUTH / ACCOUNTS / BANK 使用临时数据库。停止后重启会重置预览账号和服务端记录，浏览器可能仍有本机缓存；不要在此输入真实学生信息或正式密码。录音仍只在该账号浏览器 IndexedDB，用户同意后为本次评分临时发送，不能跨设备恢复。

## API 与安全边界

- `GET /api/toefl/ai-config`：需登录，返回 `{scoreScale,scoreMin,scoreMax,enabled,preview,provider,notice,examples:false,limits}`；前端拒绝启用量表不兼容的真实评分。bootstrap `me` 始终提供 `aiReady/aiDemo/aiProvider`，以区别未接入 AI 的 Python 服务。
- `POST /api/toefl/assess`：需有效同源会话、当前账号 header、multipart；字段 `record/question/attempt/consent=true` 及 `response` 或 `audio`。拒绝重复/未知字段、过大文件与不支持 MIME。题目及评分指令从服务端构建索引获取，不信任客户端 prompt/分数/转写。
- 只评估当前账号已保存的完成报告；作文逐字匹配已保存作答。口语按浏览器原始录音 SHA-256 写入报告 `recordingHashes[record+':'+question]`，flush 成功后再送评，与本次上传字节匹配。hash 是防止过期缓存/错配，不证明录音真实或不可篡改。
- 账号 DO 处理串行预留、每日/每分钟限流、缓存和过期租约；重新核验账号/报告/作答防止跨账号或旧请求落库。真实缓存按题目、模型/版本、作答/录音、attempt 绑定。演示仅保留限流/租约 bookkeeping，不写评分缓存。
- 录音不写入持久存储；真实反馈缓存不存转写，首次响应可包含转写，前端可随真实练习报告按账号保存；缓存命中不重新返回转写，重新评估相同录音时可能不再显示之前的转写。生产没有开启录音云同步，也不支持 AI 范文接口。
- 点击停止会阻止后续批量请求与本页结果采纳；已发往提供方的请求可能仍完成并消耗额度，不能保证撤回数据或取消计费。网络失败重试也可能产生额外调用。
- 不向浏览器返回原始供应商错误或输出日志，避免作文/录音/密钥泄漏；错误明确区分额度、繁忙、超时、格式等。
- 新增 AI 表随账号 DO 惰性 `CREATE TABLE IF NOT EXISTS`；不导入生产账号，不迁移录音。上线前账号删除/重置工具应覆盖 AI 缓存、限流及租约表，旧一次性维护 wrapper 不应复用。

## 真实 AI 本地测试（首轮五分制历史记录）

本节 1/5、4/5 与首次测试数为六分制改造前的历史证据，不代表新制验证。新制验收另记部署记录。

```powershell
# 仓库根；依赖已安装且 Wrangler 已取得 ai:write
node back-end/cloudflare/scripts/preview-ai.mjs --real-ai
# 需先准备 local-data/test-artifacts/ai-real/synthetic-speaking.wav 合成英文语音
node back-end/cloudflare/tests/ai-real-local.mjs --confirm-remote-ai
node back-end/cloudflare/tests/ai-real-browser.mjs --confirm-remote-ai
```

- 独立地址 `https://127.0.0.1:8791/toefl/?view=history`；临时账号密码与演示相同，但数据库隔离。真实模式只由显式参数开启。
- 本地 wrapper 将模型调用经 Wrangler `getPlatformProxy` 转发到远程 AI；临时远程绑定连接不是部署本网站。生产 Worker、正式账号/记录均不变。OAuth 由 Wrangler 管理，代码不读取或复制 Token；生成的纯绑定配置位于忽略的 `local-data/ai-real-preview/`。
- 仅允许本文列出的两个模型，单进程最多 6 次调用（失败也计数）；重启会重置这个本地保护上限，不是账号全局预算。没有升级付费；本轮没有取得供应商用量账单，不能报告精确 Neurons 消耗或剩余额度。
- 真实 Chrome 页面验收通过：缓存中的真实写作结果显示为 1/5，分项、反馈和折叠纠错均存在，浏览器异常为空；浏览器重复查看没有增加远程模型调用。最终专项单元测试 10/10 通过，脚本语法与 `git diff --check` 通过。
- 本轮实测共 3 次远程调用：作文 Llama、合成 WAV Whisper、转写内容 Llama。作文约 7.0 秒，1/5；合成口语约 10.0 秒，4/5。结果 `demo:false`，口语转写与输入合成文本一致，audioHash 匹配。
- 作文故意使用既有偏题示例（题目为实习邮件，作答为学习小组），模型识别出偏题并建议 `Dear Professor` 改为 `Dear Mr. Davis`。分项校准尚未系统验证；不能把一次低分视为评分标准已验证。
- 口语原句 `I usually shop at a small grocery store near my home` 本身正确，模型给出的改写是风格建议，不应理解成语法错误。这是当前质量限制，正式使用前仍需更多人工标注样本。
- 原始响应与截图保存在忽略的 `local-data/test-artifacts/ai-real/`；只有合成作答，无真实学生录音。接口测试不自动保存前端评分，浏览器测试会将写作结果保存在本地预览报告中；口语结果见 JSON。用户浏览器没有测试脚本的 IndexedDB 音频，不能直接重评该合成口语记录。

## 正式启用配置

用户已明确批准发布，Wrangler 已取得 AI 权限。学校仍应在真实学生使用前完成适用条款与隐私告知。本轮不执行付费升级。

[Workers AI binding 配置](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/)已写入生产配置：

```jsonc
{
  "ai": { "binding": "AI", "remote": true },
  "vars": {
    "ENABLE_AI": "true",
    "ASSESSMENT_PROVIDER": "cloudflare",
    "TEXT_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  }
}
```

AI binding 在本地也会[远程执行并消耗配额](https://developers.cloudflare.com/workers/local-development/#remote-bindings)，不能把 `wrangler dev` 当成无上传演示。真实测试须关闭 `AI_PREVIEW`，只用原创合成文本和合成录音先验收。不要把真实学生记录、API token、登录凭证写入仓库/前端/部署截图。

按 [Workers AI 数据使用说明](https://developers.cloudflare.com/workers-ai/platform/data-usage/)及 [Cloudflare 隐私政策](https://www.cloudflare.com/privacypolicy/)审查处理、保留与例外，不能承诺绝对零保留。确认学生/监护人或学校适用授权、撤回/删除安排、用量和失败处理。本轮发布授权来自用户后续明确请求，不是从本地预览推断；发布前完整重建、复核 diff 和测试，保留既有账号和记录，不导入本机预览数据。

## 首轮预览验证状态（历史记录）

以下为六分制改造前的验证范围；最新六分制、完整构建及生产验收以 [部署记录](cloudflare-deployment.md) 为准。

- 真实 Chrome 本机预览通过：登录、同意/拒绝、写作演示、合成音频口语上传与 SHA-256、演示不入成绩、刷新隔离、390px 窄屏、无外部页面请求；桌面与手机截图已生成。
- 最终 AI 单元/workerd 集成测试 12/12 通过；前端专项集成测试通过；认证审查 17/17 与构建资产测试 9/9 通过。真实时钟跨分钟导致的一条限流测试已调整为有界突发校验；精确边界仍由注入时钟的单元测试覆盖。
- TOEFL 源码清单检查通过；模块测试 45 通过、2 因 Windows 创建符号链接 `EPERM` 失败（shared-resources、task-format），未通过跳过或修改业务逻辑掩盖。
- 完整 Cloudflare 回归和全量共享资产重建曾被会话中断，不能宣称完整通过。预览使用已有完整题库资产，并叠加当前源码及内存评分题目索引；后续发布前仍须完成全量重建与回归。
- 后续真实远程合成测试已通过（见上节）；真实麦克风/口音效果、评分校准及线上配额仍未验收；没有部署操作。

## 可复现验证

```powershell
node --test --test-concurrency=1 back-end/cloudflare/tests/*.test.mjs
node back-end/toefl/scripts/check-source.mjs
node back-end/toefl/scripts/test.mjs
# 先保持本地 preview-ai.mjs 运行；安装 Chrome，非默认位置设置 CHROME_PATH
node back-end/cloudflare/tests/ai-browser.mjs
```

浏览器测试仅访问隔离预览，测试同意/拒绝、示例不入成绩、刷新隔离、移动布局以及合成静音 WAV 的口语上传/hash 校验（不是麦克风或识别质量测试）。截图与报告位于忽略的 `local-data/test-artifacts/ai-preview/`。真实 AI 合成测试另行显式执行；真实麦克风/口音、多设备及生产 CPU/配额仍需进一步验收。`--synthetic-debug` 可在真实本地预览中显式保存合成模型原始响应至忽略目录，仅用于排错，禁止向该模式输入学生数据；生产不会启用此日志。
