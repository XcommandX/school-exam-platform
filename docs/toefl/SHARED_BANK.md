# 托福共享题库与独立站同步

2026-10-24 用户要求拉取最新 main，核对 SAT 题库是否已在 Git，并在确有共享题库的情况下上传其全部托福题目与音频。基线 main 为 `75d919e`；已确认 SAT 的耕读及 PDF 转换题包、必要图片均在私有仓库。此授权只向 `toefl` 推送，main 由团队另行合并。

## 收录范围

资源目录为 `back-end/question-banks/toefl/`：

- `bank.json`：现有四科完整数据，3,633 题组、16,874 小题及 1,797 词；保留原 ID、答案、解析、来源标识和不完整状态，不伪造内容或审核结果。
- `audio/`：题目实际引用的 5,025 个来源音频。
- `images/`：题目实际引用的 1,934 个来源图片。
- `RESOURCE_MANIFEST.json`：版本、原数据摘要、数量及逐文件大小/SHA-256。

只复制现有题库引用资源。两个未引用的样例/旧音频不进入共享副本。原始来源键 `audio_key` / `visual_asset_key` 用于溯源，不是本地路径；实际播放路径为 `audio` / `audio_url`，图片路径为 `visual_asset_url`。没有新增下载或重生成音频，也没有导出或上传个人账号、答题、作文、口语录音、数据库、Secret、Cloudflare 标识或部署配置。

## 校验与运行

在仓库根目录运行：

```sh
node back-end/toefl/scripts/check-source.mjs
node back-end/toefl/scripts/check-resources.mjs
node back-end/toefl/scripts/build.mjs --shared-bank
python3 back-end/server/serve_platform.py --port 8888
```

资源校验检查安全相对路径、逐文件摘要、类型与大小、完整题目/媒体引用和额外文件。默认 `build.mjs` 与 `preview.mjs` 仍使用原创匿名样例；完整构建独立写入忽略的 `local-data/builds/toefl-shared/`，不覆盖匿名产物。统一平台启动发现共享清单后构建完整版本，只有登录后才能读取已列明的题库资源；服务不公开资源目录中的源码、清单、任意文件或上级路径。共享资源失败时应报错，不以不匹配的旧资源伪装成功。

Git 共享副本约 1.15 GiB，明显大于源码。不要把 ZIP、生成 HTML、重复副本或个人音频加入此目录。后续容量扩大时可单独评估受控资源存储；本轮不引入付费依赖或 Git LFS，不改写已有历史。

## 私人托福站

原 Cloudflare 私人托福站与统一平台是独立项目。此次同步新版 `four-app.js` 和可选配置的 `cloud-client.js`；无配置时继续原 `/api/`、账号、存储名称、录音上传及 AI。不把平台 `toefl-bridge.js`、统一 Cookie 或本机 SQLite 部署到私人站，不合并两套账号或记录。

私人站保留现有内容加密密钥、D1 bindings、AI 配置及数据库结构。发布前后核对账号和记录；开发检查使用匿名或内存数据，不删除真实账号与练习。

## 本机仍显示样例时

合并源码不会替换正在运行的 Python 进程。先在旧服务窗口按 Control-C 停止，再重新启动平台；同一服务运行时再次双击启动脚本只会打开旧服务。运行环境需能找到 Node.js 22.13+，否则只能使用已有构建。完整构建目录是 `local-data/builds/toefl-shared/`，默认不带参数的 `build.mjs` 仍只生成匿名样例。

2026-10-24 本机曾因旧服务仍在运行且完整构建未生成而显示匿名样例；首次生成还被 Finder 的 `.DS_Store` 阻断。资源遍历现忽略各层级的普通 `.DS_Store` 文件，它们不进入资源清单或运行产物；符号链接、隐藏的未知文件及清单中的非法路径仍拒绝。题目与媒体内容不因此改变。
