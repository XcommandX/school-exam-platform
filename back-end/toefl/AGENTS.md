# 托福服务端与检查工具维护约定

- 本目录保存服务端源码、题目格式工具、原创匿名样例和测试；浏览器源码在 `front-end/toefl/`，说明在 `docs/toefl/`，均以仓库根定位。
- 先读 `docs/toefl/README.md`、`ENTRY_INTERFACE.md`、`QUESTION_FORMAT.md`；不含正式题库、来源音频、用户记录、录音或真实部署配置，完整资源另行审查接入。
- 保留录音保存顺序、AI 评分缓存、账号隔离、同步合并和专项复习行为；避免为目录整理重写这些流程。
- 在仓库根运行 `node back-end/toefl/scripts/check-source.mjs`、`node back-end/toefl/scripts/test.mjs`；也可进入本目录运行 `node scripts/check-source.mjs` 与 `node scripts/test.mjs`。后者使用内存数据库和替身 AI，不证明真实硬件、外部 AI 或跨平台验证通过。
- `SOURCE_MANIFEST.json` 使用仓库根相对路径，联合审查 `front-end/toefl/`、`back-end/toefl/`、`docs/toefl/`。三处 `.gitignore` 默认排除新文件；新增源码须逐项审查并在对应忽略规则和清单同时放行。审查差异后运行 `node back-end/toefl/scripts/check-source.mjs --update` 更新摘要；`docs/toefl/source-snapshot.json` 是原导出历史摘要，不覆盖。
- 构建只输出到忽略的 `local-data/builds/toefl/`。`preview/` 仅复制显式匿名白名单与原创样例；`cloud-test/` 单独组装服务端、浏览器云客户端和账号模板用于回归，不对外提供。不得把前端 `clients/`、`templates/`、`integration/` 整目录公开或自动连接 Cloud。
- `integration/platform-adapter.mjs` 只有映射草案，不提供公共鉴权或保存 API；浏览器入口生成器在 `front-end/toefl/integration/entry-links.mjs`。不得把客户端用户 ID 或分数直接视为服务端已验证结果。
- `src/schema.sql` 是结构参考，邀请表脚本为幂等结构补充；构建、检查和预览都不执行迁移，不连接原云站，也不提供正式部署命令。
- SAT 在 `front-end/sat/` 与 `back-end/tools/sat/` 独立维护，不覆盖其文件来满足托福构建。真实资源、个人数据、密钥与 `.DS_Store` 不加入 Git。

## 账号使用与删除规则

- 同一账号仅允许一个有效登录会话；在新浏览器成功登录后，旧会话失效。同一浏览器的多个标签页共享会话，不按 IP 限制，避免误伤校园共用网络。失败登录不得撤销原会话。
- 管理员删除账号必须由服务端再次核对权限和目标用户名；仅可删除普通账号，禁止删除自身与任何管理员。删除目标账号时原子清理其会话、私人状态、录音和评分，不能波及其他账号或共享题库。
- 取消未完成练习不调用提交、评分或学习排程；仅删除所选草稿及其未提交录音。保留轻量取消标记，避免离线或旧设备重新上传后复活；原有已提交报告保留。
- 上述规则需在未来统一身份接入中继续实施，不能仅靠隐藏按钮或前端判断。功能测试使用匿名/内存数据，维护和部署本身不执行任何真实账号或练习删除。

## 完整共享题库例外（2026-10-24）

用户已授权将完整题目和必要来源音频、图片加入 `back-end/question-banks/toefl/`，单独由资源清单和 `check-resources.mjs` 校验，不并入本目录的源码清单。前文不提交真实题库/媒体的通用限制在此指定目录内以本例外为准；用户作答、录音、账号、密钥和部署配置仍禁止提交。默认构建保持匿名；完整题库使用独立 `toefl-shared` 构建，不能借此公开 `clients/`、模板或服务端源码。详见 `docs/toefl/SHARED_BANK.md`。
