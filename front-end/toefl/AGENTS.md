# 托福浏览器源码维护约定

- 本目录保存界面、判分、学习、录音与浏览器客户端；先读 `docs/toefl/README.md`、`ENTRY_INTERFACE.md`、`QUESTION_FORMAT.md`，说明路径均相对仓库根。
- 保留现有录音保存顺序、评分缓存、导航恢复、账号隔离、同步合并及专项复习行为，不因目录整理重写功能。
- `clients/` 保存浏览器运行的云端客户端，`templates/` 保存账号页面模板；它们不是服务端实现，也不属于匿名公开预览。`integration/entry-links.mjs` 只生成受限入口链接，不提供身份认证。
- 匿名构建只复制 `index.html`、`four.css`、`four-logic.js`、`four-learning.js`、`four-app.js`、`favicon.svg`，再生成匿名题目、合成提示音和原创场景图；不能整目录复制 `clients/`、`templates/` 或 `integration/` 到公开输出，不加载正式 Cloud 客户端。
- 服务端源码和检查工具在 `back-end/toefl/`；构建产物位于忽略的 `local-data/builds/toefl/`，不修改生成文件代替源码。修改后在仓库根运行 `node back-end/toefl/scripts/check-source.mjs` 与 `node back-end/toefl/scripts/test.mjs`，测试只用内存数据库与替身 AI。
- 本目录 `.gitignore` 默认排除新文件，新增文件逐项审查并同时加入对应忽略规则及 `back-end/toefl/SOURCE_MANIFEST.json`；该清单以仓库根相对路径联合审查前端、后端和模块文档。审查后运行 `node back-end/toefl/scripts/check-source.mjs --update` 更新摘要，原 `docs/toefl/source-snapshot.json` 不改。
- 不提交真实题库、来源媒体、用户记录、录音、密钥、部署配置或 `.DS_Store`；浏览器隐藏菜单不是访问控制，正式权限仍须由服务端核验。

## 账号使用与删除规则

- 同一账号仅允许一个有效登录会话；在新浏览器成功登录后，旧会话失效。同一浏览器的多个标签页共享会话，不按 IP 限制，避免误伤校园共用网络。失败登录不得撤销原会话。
- 管理员删除账号必须由服务端再次核对权限和目标用户名；仅可删除普通账号，禁止删除自身与任何管理员。删除目标账号时原子清理其会话、私人状态、录音和评分，不能波及其他账号或共享题库。
- 取消未完成练习不调用提交、评分或学习排程；仅删除所选草稿及其未提交录音。保留轻量取消标记，避免离线或旧设备重新上传后复活；原有已提交报告保留。
- 上述规则需在未来统一身份接入中继续实施，不能仅靠隐藏按钮或前端判断。功能测试使用匿名/内存数据，维护和部署本身不执行任何真实账号或练习删除。

## 完整共享题库例外（2026-10-24）

用户已授权将完整题目和必要来源音频、图片加入 `back-end/question-banks/toefl/`，单独由资源清单和 `check-resources.mjs` 校验，不并入本目录的源码清单。前文不提交真实题库/媒体的通用限制在此指定目录内以本例外为准；用户作答、录音、账号、密钥和部署配置仍禁止提交。默认构建保持匿名；完整题库使用独立 `toefl-shared` 构建，不能借此公开 `clients/`、模板或服务端源码。详见 `docs/toefl/SHARED_BANK.md`。
