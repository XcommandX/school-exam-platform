# Cloudflare 部署与维护

## 本次边界

从 GitHub `XcommandX/school-exam-platform` 的 `main` 基线 `4c00fced60d155d26ab68343ed5e2d60eec8321c` 创建 `chore/cloudflare-deployment`。保留 Python 本机运行方式，新增 Cloudflare 运行适配，不替换 SAT 考试界面，不连接原私人 TOEFL 站。

这不是只有静态页面的 Pages 站点。Cloudflare Workers 负责同源入口；SQLite-backed Durable Objects 负责统一登录和账号记录。用户不需要将自己的电脑持续开机。

- 共享题库：来自 Git 已跟踪且明确允许的 SAT / TOEFL 目录；不删题以满足部署限制。
- 首次部署使用全新空数据库。不上传任何旧账号、密码、答题记录、作文、录音或本机 SQLite。
- 保留管理员创建/停用账号、重置密码；用户修改自己资料和密码。沿用单账号单会话、12 小时绝对期限、2 小时空闲期限、PBKDF2-SHA256 600,000 次。
- SAT 练习记录、错题本、设置、首页计划与目标、TOEFL 文字记录按账号云端保存；保存退出或完成时同步，不在每一秒计时中上传。
- TOEFL 口语录音仍只在当前账号的浏览器中；外部 AI、录音云上传不启用。AP / Personal Vocab 保持原占位入口。
- 不把旧私有 `active.json` 带入新云站。新题库从目录中选择，旧切库备份接口返回明确 `no_active_collection`，不会假装备份成功。
- 不自动合入 `main`，不建立未经授权的 GitHub Actions/付费项目。

## 站内审批注册扩展（2026-10-25 已发布）

2026-10-25 用户将此前未发布的邮件方案改为站内审批，在 `feature/admin-registration-approval` 分支继续实现：所有有效管理员在账号管理共享查看注册申请并通过或拒绝，通过才创建学生账号。有有效管理员时才允许注册；无需 Resend、发信域名或邮件 secret，原有登录保持。接口、隐私、数据迁移及验证边界见 [站内审批注册](registration-approval.md)。用户完成独立本地测试并确认正常后，先授权 commit / push 功能分支，随后明确授权合入 main 并更新在线网站。已完成；本地测试账号、数据库及凭证不上传。

### 本次实际发布记录

- GitHub `main` 从 `4c00fced` 快进到 `eb43306c6bface8e21d906a81ffa45311e7f8fc6`，包含此前已上线的 Cloudflare 基础实现和本次审批功能，没有覆盖其他远程提交。
- 仍部署 `school-exam-platform`，网址不变：<https://school-exam-platform.xcommandx-school.workers.dev>。新版本 **`acba59ea-53a7-418a-bb41-d17919a38605`**；发布前版本 `15171286-6521-4ea9-b314-f77ea694cef1`。
- 从 main 重新完整构建通过：7,550 文件 / 1,511,784,130 bytes；SAT 459 集 / 18,867 题、TOEFL 3,633 条 / 16,874 题。实际只上传 7 个改动页面资源，7,543 项复用；Worker 164.12 KiB（gzip 43.03 KiB）。
- 原 AUTH / ACCOUNTS / BANK 类名、命名对象和存储绑定不变，不重建或导入账号、学习记录，不配置初始化 secret，不执行付费升级。身份 schema 由 v1 幂等升级到 v3，增加申请表并保留现有用户及会话；废弃的未发布邮件申请表退出使用。
- 合并后注册边界测试再跑 **10/10 通过**；发布源码与此前 **123/123 完整回归、47/47 注册浏览器、15/15 原流程浏览器**的源码一致，用户另完成本地手动验收。
- 发布后 **27/27 公网匿名回归 + 15/15 审批专项检查通过**：线上 config 为 `{enabled:true,mode:'admin'}`；登录页有注册表单；五个登录/账号脚本样式 SHA-256 与源码一致；匿名读取、通过和拒绝均 401；跨站注册 403；旧邮件入口 410；初始化仍 503 关闭；真实 600k 登录散列探测正常返回 401。
- 未读取真实用户列表、学习数据或密码，未创建线上测试账号、申请或审批决定。匿名散列探测仅执行一次，会产生正常失败登录审计/限流状态。线上管理员实际登录、双管理员审批和学生登录尚需由用户使用自己的账号最终验收，不能把匿名检查冒充完整生产业务验收。
- 注意：旧版本身份代码仅接受 schema v1，本次身份库升级至 v3 后，**不能直接回滚到上述旧 Worker 版本恢复服务**；Cloudflare 回滚只回滚代码不回滚数据库。若需回退界面，应以保留 v3 身份兼容的修复版本发布，不删除正式表或数据。

## 实际发布记录（2026-10-24）

- 公网地址：<https://school-exam-platform.xcommandx-school.workers.dev>。本次注册用户确认的免费 `xcommandx-school.workers.dev` 子域名，没有购买域名或执行付费升级。
- 20:14（Asia/Shanghai）首次发布成功，代码对应独立分支提交 `8921de2`；初始 Worker 版本 `3924deb0-180c-41a6-8cbe-c2ce7997b8c6`。完整静态资源发布完成：本次上传 7,261 项，289 项无需重复上传。
- 20:15 设置一次性初始化 secret 后，Cloudflare 生成版本 `04d07d92-2077-445e-a6be-7d77512857ef`；20:30 按用户要求重新打开初始化页、轮换尚未使用的凭证，版本为 `fd364b69-51be-40d2-9019-539fb0d8bc5e`。这两次只有 secret 变化，代码和共享题库未变。
- 配置初始化凭证前、后各执行公网匿名检查，均 **26/26 通过**：服务状态、登录与初始化页面、未登录 API/页面保护、内部目录与题库脚本保护、跨站写入拒绝、三个公共前端文件 SHA-256 一致，以及真实 AUTH SQLite DO 对无效初始化的拒绝。
- 管理员初始化页面已在维护者浏览器安全打开，账号与密码由用户本人填写。首次提交发现线上内置 PBKDF2 上限与本地 workerd 不同，返回 `crypto_unavailable`；上述 26 项匿名检查没有执行密码散列，因此不能证明账号功能可用。现改为标准 JavaScript PBKDF2 实现，并新增真实 AUTH DO 的未知账号登录探测，成功标准是正常 `401 invalid_credentials` 而不是 `503`。修复发布及管理员创建结果另见下方记录；本地回归不能代替正式账号或两台真实设备验收。
- PBKDF2 修复提交 `a966304` 已实际发布，Worker 版本为 `1ccc75ec-8fde-47c1-8f9f-2e5ce06d7f05`，网站地址不变。打包 151.36 KiB（gzip 40.70 KiB）；未改静态资源，Cloudflare 确认无需重新上传题库。发布前 **112/112** 回归与 **15/15** Chrome 检查通过；静态资产 7,550 项、1,511,766,097 bytes 全量 SHA-256 复核一致。
- 修复发布后，**27/27 公网检查通过**，其中新的未知随机账号登录经过真实 AUTH DO 的 600k dummy verification，返回预期的 `401 invalid_credentials`，不再返回 `503 crypto_unavailable`。此次探测不创建账号，但会按正常流程记录失败审计/限流计数。未采集生产 CPU、内存峰值或并发容量。
- 21:05 按用户需求重新安全打开初始化页，凭证自动填入并隐藏（secret 变更版本 `dc61c5ea-21a7-4d6c-bb24-b30e172e886d`）。用户本人填写账号及密码，并明确确认**已成功进入账号管理页**；没有将密码交给代理，也没有由代理创建临时正式账号。
- 21:07 已删除 `SETUP_TOKEN`，当前正式版本为 `15171286-6521-4ea9-b314-f77ea694cef1`，代码仍对应修复提交 `a966304`。移除后核验：站点与登录页正常，初始化 API 对无效请求返回 `503 setup_unavailable`，不再启用首次创建入口；移除凭证不删除管理员或当前会话。首位管理员已可在账号管理内创建另外两位管理员，无需重跑初始化脚本。正式账号保存与两台真实设备验收仍待用户完成。
- 实现及密码修复已上传 GitHub 的 `chore/cloudflare-deployment` 分支；`main` 仍为基线 `4c00fced`，没有合并。只推送分支不会自动重新发布网站，也没有设置自动部署。

## 架构和安全边界

配置见 [wrangler.jsonc](../back-end/cloudflare/wrangler.jsonc)，入口见 [worker.mjs](../back-end/cloudflare/src/worker.mjs)。

| 绑定 | 责任 |
| --- | --- |
| `ASSETS` | 经过白名单构建的静态页面、脚本、共享题库及音频图片 |
| `AUTH` / `PlatformAuthStore` | 单一身份库、会话、限速、角色与一次性管理员初始化 |
| `ACCOUNTS` / `PlatformAccountStore` | 每个稳定用户 ID 独立的私有记录 SQLite 对象 |
| `BANK` / `PlatformBankStore` | 管理员导入的旧格式共享 SAT JSON 题库 |

**不要将 `assets.run_worker_first` 改为 `false` 或只保护 `/api/*`。** HTML、TOEFL 数据脚本、图片、音频也需要登录。`/_catalog/` 永不直接对浏览器开放；服务端只在验证身份后按路由表取内部资产。用户专属 HTML 注入身份，使用 `private, no-store`，不放共享缓存。

写操作要求同源 `Origin`、JSON 类型、页面固定的 `X-Account-ID`。DO 内部再次确认会话与用户；提交前再次检查，避免上传过程中账号被停用后仍保存。管理员权限由后端检查，不依赖菜单。登录 Cookie 使用 `HttpOnly; Secure; SameSite=Strict`。禁止读取 Cookie / OAuth 配置到聊天或日志。

SQL 单行/字符串/Blob 有 2 MiB 限制，SAT 快照以 256 KiB BLOB 分块保存。流式 JSON 校验只保留校验所需投影，原始值完整保存；结构散列保留精确数字，完成记录不可覆写。CAS 版本冲突、16 次操作重试记录、删除标记、错题显式恢复和 TOEFL 取消标记合同保留。同步失败时浏览器保留本机副本。

## 构建、测试和发布

环境：Node.js 22.13+、Python 3.10+、Git，推荐 Node.js 24 LTS。npm 只在新增的 Cloudflare 子目录运行；不要重新安装或改动原 TOEFL 依赖。

```sh
cd back-end/cloudflare
npm ci
npm run build
npm test
npx wrangler deploy --dry-run
# 可选：已安装 Chrome 时的隔离 HTTPS 真实浏览器检查
npm run test:browser
```

Windows 若 `python` 未在 PATH，将 `PYTHON` 环境变量设为实际 Python 可执行文件路径；Git 必须可在 PATH 调用。构建只写被忽略的 `local-data/builds/cloudflare/`。原 TOEFL 本机、私人云站及其构建目录不受影响。

构建会验证：Git 明确跟踪白名单、路径不为符号链接/目录联接、TOEFL 清单 SHA-256、SAT 导出规范、所有资产总数与大小。构建失败不会留下代表成功的清单。

2026-10-24 完整构建核验：

- SAT 459 个题集、731 个来源包、18,867 题；目录与索引计数一致，0 导出错误。
- TOEFL 3,633 条记录、16,874 题、5,025 个音频、1,934 张图片。
- 7,550 个静态资产，1,511,766,097 bytes；单文件最大 25 MiB。Wrangler 的扫描日志可能显示 7,585，包含 35 个目录，不代表上传了额外文件。
- TOEFL 原完整数据拆成 5 个不超过 8 MiB 的模块片段，按顺序加载后逐字恢复相同 JSON，不丢题序/元数据。
- 30,623,065-byte SAT 全库索引拆成两片。Worker 按原始字节流拼接，不对各片独立 UTF-8 解码。
- 470 条受保护路由逐条重组校验；SAT 2,108 个声明图片的大小与 SHA-256 全部一致。

Cloudflare 授权在开发者电脑通过 Wrangler 官方 OAuth 登录完成。仅申请本次 Workers 部署需要的权限，不在 Git 保存令牌，不将 Cloudflare 登录密码交给工具。

```sh
npx wrangler whoami
npx wrangler deployments list --name school-exam-platform
npx wrangler deploy
node scripts/check-live.mjs https://实际域名.workers.dev
```

部署前检查目标 Worker 是否已有他人站点，避免覆盖。使用默认 `workers.dev` 子域名，无需购买域名。`deploy` 是实际发布；Git `commit` 只是本地保存，`push` 只是上传分支；它们都不自动合入 `main`，也不自动发布。

## 第一个管理员

1. 发布后在 `back-end/cloudflare` 执行 `node scripts/setup-admin.mjs https://实际域名.workers.dev`。脚本先确认站点，再在内存中生成 32 字节安全随机值，编码为 base64url。
2. 脚本通过 Wrangler 的标准输入设置 `SETUP_TOKEN` secret，关闭此次 Wrangler 的磁盘日志，随后打开默认浏览器。凭证不出现在 Wrangler 命令参数、Git、终端输出或聊天，也不另存本地文件；唤起浏览器的操作系统进程参数会短暂携带初始化 URL，因此只在可信电脑执行。浏览器未打开时重跑脚本会轮换未使用的初始化凭证。
3. 脚本打开部署站点 `/setup#token=...`，网页自动填入并隐藏初始化凭证；用户只填写账号、显示名、密码和确认密码，不需要手动索取或输入凭证。片段不会被 HTTP GET 发送，页面立即从历史栏移除片段。创建完成前不要刷新：凭证只保存在当前页面内存，刷新后会丢失；若尚未创建管理员且页面已关闭或刷新，由维护者重跑脚本生成新凭证，关闭旧页，仅使用新打开的页面。
4. 后端只允许第一个管理员初始化成功；并发请求也只能成功一次。成功后由 `/account` 创建其他成员账号。
5. 确认首位管理员已进入账号管理后，执行 `npx wrangler secret delete SETUP_TOKEN` 移除已失效的 secret（不删除账号）。脚本不保存本地临时凭证；关闭初始化页面即可。本次已完成移除，此后直接使用 `/login`，不要再运行初始化脚本来创建其他管理员。

初始化不是公开注册入口。密码不得发到聊天，不提供固定默认密码。`http://127.0.0.1:8888/` 是开发者电脑上的本机服务，其既有管理员账号、密码和个人记录不会自动进入这个新云站。用户可在新站重新使用原用户名，但需自行设置密码；首位管理员登录后可在“账号管理 → 创建账号”中将角色选为“管理员”，创建另外两位管理员。此过程不删除或修改本机账号，也不迁移旧数据。遗失所有管理员凭证应由仓库维护者制定审计过的离线恢复流程，不开放绕过认证的重置后门。

## 免费额度与应用限制

选择 **Workers Free + SQLite Durable Objects Free**，不启用付费计划。额度可能变化，使用前查官方页面。150 名注册用户不等于任意峰值、请求和存储都免费可用。

| 类别 | 2026-10-24 核查值或本应用限制 |
| --- | --- |
| Worker Free | 100,000 动态请求/日，普通 Worker 每请求 10 ms CPU；静态资源经过 Worker 鉴权也会调用 Worker |
| SQLite DO Free | 100,000 请求/日、13,000 GB-s/日；超额会使操作失败，不代表自动升级为付费 |
| DO 存储 | 免费每个对象 1 GB、账号合计 5 GB，另有 SQL 行读写日配额 |
| 静态资产 | 免费最多 20,000 文件，单文件不超过 25 MiB |
| SAT 私有记录 | 单条 64 MiB、设置 256 KiB；每账号 SAT 512 MiB、最多 20,000 实体（含删除标记）；分块暂存总量 704 MiB，含索引/元数据的 SQLite 写入另留 896 MiB 安全边界 |
| TOEFL 状态 | 单次 8 MiB 以内；按原文字记录类型和取消标记合同保存 |
| 结构校验 | 128 层深度及受限节点/保留内存预算，过度复杂 JSON 拒绝而不让运行时内存溢出 |
| 旧格式共享 JSON 导入 | 仅管理员；20 MiB 请求、512 MiB 内容总量（规范格式、兼容副本及摘要合计，含暂存）；另检查 SQLite 实际大小并预留空间；当前没有在线删除接口 |
| 旧切库全量备份 | 本机原上限 256 MiB 超过云端 HTTP 限制；新站不部署旧活动卷，因此此旧接口不适用 |

一次业务写请求可能经过多个 DO 请求（身份初验/提交复验），不能将 DO 的 100,000 请求直接等同于 100,000 次学生保存。大型媒体、数据库读写、音频连发、登录散列和并发将影响用量。PBKDF2 在 SQLite DO 中执行，不在 10 ms 普通 Worker 中执行；不得通过降低密码散列强度来适应普通 Worker CPU。

### 线上 PBKDF2 兼容性

2026-10-24 用户实际创建管理员时发现：线上 Workers 的原生 `node:crypto.pbkdf2Sync` 和 WebCrypto 共用迭代限制，600,000 次会被拒绝；本地 workerd 的限制实现不同，所以本地 PASS 并不能证明生产支持。修复采用锁定的 `@noble/hashes@2.0.1` 同步 JavaScript PBKDF2-HMAC-SHA256，仍在 AUTH SQLite DO 中执行完整 600,000 次，24-byte 随机 salt、32-byte 结果及存储格式不变。不降为 100,000 次，不串联六次短 KDF，不切到客户端或外部收费服务。通过独立 Node 原生实现比较普通/UTF-8/长 HMAC 密钥/包含 NUL 的输入，另以原生 PBKDF2 被模拟为拒绝的回归测试确认不再依赖该路径，继续保持恒时比较及身份事务复验。完整测试按文件串行执行，避免数个高 CPU 运行时争抢本机资源；每项内部的并发与竞态测试仍保留。

该依赖零传递运行依赖，版本与 integrity 锁定；上游有 Cure53 对 v1.0.0 的审计记录，不能将其说成 v2.0.1 整版重新审计。本地检查仍需在真实生产补一项未知随机账号登录：它执行相同 600k dummy verification，只应返回 `401 invalid_credentials`，不创建测试用户或读取现有用户。每次发布最多一次该探测；它消耗真实散列资源，并记录正常的失败登录审计和两个限流计数桶（含同出口 IP 的 30 次/15 分钟额度），并非零状态影响的只读检查。JavaScript 路径比原生慢，DO 阻塞/并发与免费用量需监测，不宣称支持 150 人同时登录。Worker 冻结时钟，不能把 `performance.now()` 的单请求结果称为真实 CPU 用量。

依据：[workerd 生产迭代限制](https://github.com/cloudflare/workerd/blob/v1.20261019.1/src/workerd/io/limit-enforcer.h#L29)、[维护者对本地与生产限制的说明](https://github.com/cloudflare/workerd/issues/1346#issuecomment-1874827249)、[noble-hashes v2.0.1](https://github.com/paulmillr/noble-hashes/tree/2.0.1)。

查看 Cloudflare 控制台 Workers / Durable Objects 使用量；在用量接近上限时先降低无意义重复加载、导出/整理个人记录并估算容量。未经用户另行授权，不自动升级付费、增加外部存储或 AI API。

## 更新、回滚和数据保护

- 更新共享题库：改共享源目录与清单，重新构建、测试、部署；只 `git push` 不会刷新线上站点。
- 更新兼容层：回归匿名 Node SQLite、真实 workerd、权限边界与大快照流式测试；再部署。
- 查看版本：`npx wrangler deployments list`；必要时用 `npx wrangler rollback <version-id>` 回退代码。先核对版本，不盲目回滚。
- 回滚代码**不回滚 Durable Object 数据**，也不反向撤销数据库迁移。数据结构的破坏性迁移需要另行备份与批准。
- 不执行 `wrangler delete` 或删除 DO 类来“清理测试”；这可能删除正式数据。
- 本轮没有建立跨供应商定时数据库备份/灾难恢复系统；正式大规模使用前需补齐负责人、导出恢复演练、用量报警和校园网络/真实多设备验收。不能把代码在 GitHub 当成学生记录备份。
- 测试与正式数据库隔离：本地 Miniflare 测试使用匿名临时存储，退出销毁；线上首次只建立空库，用户自己初始化管理员。
- 身份审计事件目前只追加，没有自动保留期/轮换策略。事件不保存密码、会话令牌或原始 IP，但长期使用仍需监测身份对象空间，并另行批准审计归档策略；不宣称无限期免费存储。共享旧格式导入库暂无在线删除入口，满额时先停止新增、导出并由维护者制定整理方案。

## 验证范围

PBKDF2 修复后重新执行完整 Cloudflare 回归：**112/112 通过**（包括新增 UTF-8/长密钥/NUL 对照及原生 KDF 拒绝模拟）；隔离 HTTPS Chrome 复测 **15/15 通过**，异常和外部请求为 0。生产打包通过，另确认最终包无原生 PBKDF2 调用，并单独核对 RFC 7914 §11 公开算法向量。依赖安装后的 npm audit 报告 0 个已知漏洞，此结果不是安全审计。新加入的固定盐向量在首次运行因夹具误写为 25 字节而被现有 24 字节格式校验正确拒绝，修正夹具并增加长度断言后，全量复测通过；没有放宽生产校验。

2026-10-24 首次发布前的本地验证：Cloudflare `npm test` **110/110 通过**；Chrome 真实 HTTPS 非 localhost 的隔离浏览器检查 **15/15 通过**。这组历史结果不代表后续 PBKDF2 修复已在生产通过，修复回归与发布结果以实际发布记录为准。覆盖首次初始化、登录/退出、账号页、Secure/HttpOnly/SameSite Cookie、首页计划保存刷新、完整 SAT 目录与数学筛选、SAT 设置写入账号 DO、记录/错题/同步冲突直链、TOEFL 四科完整入口。JavaScript 异常、集成警告、外部服务请求均为 0；仅非致命 favicon 404。发现并修复了 HTTPS 题库连接门禁和账号菜单改名导致的 SAT 设置直链失效，不修改考试引擎。

自动化还覆盖登录/单会话/权限撤销、一次性初始化竞态、两账号隔离、跨会话保存读取、CAS/操作重放/删除/完成记录不可变、TOEFL 取消记录、完整题库构建、接近 20 MiB 共享题库导入以及 62 MiB SAT 快照真实 workerd 流式读写。运行时测试不等于校园网络、Safari、两台真实硬件、150 人并发或云端 CPU 额度的负载测试。

**原 Python 测试未全绿，不能宣称 Windows 本机流程全部通过。** 同日执行原 `back-end/tests` 的 240 项，5 failures / 15 errors；只读核实相关 Python 服务、工具与测试同基线未改。已确认的既有 Windows 问题：TOEFL 服务端生成的反斜杠路径触发自身安全拒绝（4 failures）、系统 MIME 缺少 woff2（1 failure）、测试默认 GBK（4 errors）、转换器 CRLF 与修订过程 LF 字节比较冲突（3 errors）、符号链接权限（5 errors）、测试未关闭 SQLite 连接导致清理失败（3 errors）。UTF-8 定向复跑 6 项中 2 项通过、3 failures / 1 error，证实 UTF-8 并非全部原因。未在本次部署顺便修改原 Python。Cloudflare 不使用该 Python HTTP 路由、本机 SQLite 或转换修订器；其构建强制 UTF-8，最终完整题库与上述云运行时检查通过。原首页 Node 模型回归通过。另执行原 TOEFL `node back-end/toefl/scripts/test.mjs`：45 项通过、2 项在创建符号链接夹具时因 Windows `EPERM` 中止（`test-shared-resources.mjs`、`test-task-format.mjs`），没有绕过或移除符号链接安全检查；未使用外部 AI 或生产数据库。

## 官方资料

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## 2026-10-26 竞赛适配：尚未发布

本次新增数学竞赛构建/运行适配，不代表重新部署。**本轮没有合入 main，也没有执行 Cloudflare 发布**；上文 SAT / TOEFL 和审批注册的既有发布记录仍有效，不据此宣称新竞赛功能已在线。

- `/contests/` 使用统一账号与登录门禁，静态白名单包含页面、样式、普通模型、应用、MathJax 配置及计时模型六个文件；不开放整个源码或本机目录。
- [竞赛导出器](../back-end/cloudflare/scripts/export_contests.py)只接受四份 Git 已跟踪且明确标记为原创示例的数据，不接受私有/外部图片资源。默认 private 目录为真实空态，`privateProblems: 0`；用户主动进入示例模式才显示四份示例。
- 真实竞赛题库、来源缓存、下载 PDF、研究证据、账号浏览器记录与测试产物不进入云构建。既有 SAT / TOEFL 题库专项授权不授予竞赛内容发布权限。
- 本机可选 MathJax 不导出；云目录明确返回 `mathjaxAvailable: false`，页面保留可读 LaTeX 文本并提示，不请求公共 CDN，不假称完成公式排版。
- 即使登录的是云站账号，竞赛作答、收藏、计时和归档仍只存在当前浏览器按账号隔离的空间；不写入账号 Durable Objects，不等于跨设备云同步。
- 定向检查入口为 `node --test --test-concurrency=1 back-end/cloudflare/tests/contest-worker.test.mjs`（仓库根目录）；还需执行现有完整 `npm test` 与 `npm run build`。检查、构建、commit / push 与部署分别记录；不能用旧版本通过数量替代本轮结果。

完整使用方式、导入权限、历史赛制证据和客户端计时限制见 [数学竞赛](math-contests.md)。
