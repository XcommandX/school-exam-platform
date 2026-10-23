# SAT 模块

界面在 `front-end/sat/`；Python 维护工具在 `back-end/tools/sat/`。从仓库根目录启动统一平台：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/sat/>。统一平台使用独立的浏览器存储命名空间；目录调整不修改已有本机历史记录。

SAT 概览中的 `Practice Builder`（原 `Question Library` 卡片）集中提供练习名称、自定义选题、按来源组题、时长设置和开始练习。`Start Practice` 按 2026-10-23 后续截图接入 Full-Length Tests、Reading and Writing、Math 三分类目录，默认第一类；题集按开始、继续、重新开始和复盘分别显示入口。全真模考来源按官方考试日期时间线排列，School Day 保留月精度，Bluebook、拼卷及无日期来源单独归组，日期依据见 [考试日期](../sat-exam-dates.md)。`Explore Questions`、导入后的 `Practice Builder` 按钮以及首页英语/数学入口均进入组题页；旧 `view=questionLibrary` 链接兼容转到 `Practice Builder`，`view=practiceBuilder&mode=source` 继续支持按来源组题。整套模考入口与开始后的考试流程保持原有行为。

独立 SAT 服务使用不同端口与运行数据目录：

```sh
python3 back-end/tools/sat/question_bank_server.py --port 8876
```

它默认从 `front-end/sat/` 读静态文件，将题库、图片等运行文件保存到 `local-data/standalone-sat/`，不写回前端目录。双击 `back-end/tools/sat/Start SAT Practice.command` 也可启动；停止服务在对应终端按 Control-C。不要让统一服务与独立服务共用一个端口或混用浏览器命名空间。

使用 `front-end/sat/data/examples/synthetic-practice.json` 可验证两道原创合成题。2026-10-23 用户明确授权将已复制到 `back-end/sat/questions/sat-packs/gengdu-offline/` 的题库作为可提交 GitHub 的共享副本，Start Practice 与 Practice Builder 全库接口共用它；其他真实资料和个人数据仍留在忽略的 `local-data/`。完整 98 题指定卷的结构、转换、加载、待审答案和备份见 [SAT 数学与整套练习](../sat-math-exam.md)。

`source-snapshot.json` 是最初接入的历史源码导出摘要，保留当时相对路径与哈希。需要新源码导出时，运行 `back-end/tools/sat/prepare_sat_source.py`；新导出仍采用 `front-end/`、`back-end/`、`docs/` 布局，并在导出目录生成自己的 `docs/sat/SOURCE_MANIFEST.json`。该工具按固定白名单复制源码和许可，生成空题库与原创样例，不包含 `local-data/`、真实题目、备份或个人记录。

## Start Practice 题集目录

统一服务提供两个接口，前端不依赖个人电脑的绝对路径或分类文件夹名称：

- `GET /api/sat-library` 返回三分类元数据、题数、原模块信息及不可用题集错误；目录只保存元数据，不预取全部题目。
- `GET /api/sat-library/collections/{collectionId}` 只在 Start Exam / Restart Exam 时加载所选题集，返回 `packs`、可选 `assessment` 与带精确版本引用的来源 `modules`。切换分类、选中卡片、Open Review 和 Resume Exam 不重新下载题包。
- 服务根目录可由 `SAT_LIBRARY_ROOT` 或 `--sat-library-root` 配置，默认 `back-end/sat/questions/sat-packs/gengdu-offline`；显式参数优先于环境变量，相对路径以仓库根目录为基准。Start Practice 与 Practice Builder 全库索引共用该根目录，目录迁移后仍用稳定 `collectionId` 关联练习记录。

上述共享题库由用户从原 `local-data/sat-packs/gengdu-offline/` 完整复制，迁移只调整服务端默认读取位置，不改题包内容、版本、活动卷或浏览器记录。旧 `/api/sat-packs` 活动卷和可写旧格式题库仍归 `local-data/`。转换工具仍默认输出到 `local-data/`，不会自动覆盖共享副本；更新共享副本时应保留稳定身份及版本引用。服务启动时确定题库路径，修改后需重启服务；已有 `SAT_LIBRARY_ROOT` 或 `--sat-library-root` 会继续覆盖默认值。

示例（替换为自己的题集目录）：

```sh
python3 back-end/server/serve_platform.py --port 8888 --sat-library-root /path/to/sat-library
```

仅 `assessment.fullSAT === true` 启动完整 SAT。分类名不能作为完整性证明；部分卷显示 Partial Test，依返回模块和题序启动，保留原 moduleNumber，包括来源模块 3，不重切或补题。全真模考分类固定读写每模块 32 分钟、数学每模块 35 分钟，不能自行编辑，部分卷也保留对应科目标准时长。准备页右下的 Timed / Untimed 为橙色管理样式，与原蓝色 Back / Next 区分；Untimed 不改写标准时长。Practice Builder 的普通分段练习仍可调整时间。

开始所选题集仅导入其新版本，保留旧 sources、questions、attempts、wrongBook 和活动集合标记，不调用切换活动卷的归档流程，不修改磁盘 `active.json`。Restart Exam 新建场次并保留旧记录；Open Review 取最近完成记录，Resume Exam 取最近可恢复记录。新保存的记录在 IndexedDB 中带 `libraryCollectionId` 和当场 `questionSnapshots`，复盘及显式恢复优先使用快照；旧记录继续兼容按题目版本读取。带图片的完整快照不放入每次答题更新的 localStorage 运行状态。

开发接入依据接口合同，未展开真实题包文件或将题目正文、答案和图片送入聊天上下文。以下可重复检查使用原创合成题；浏览器脚本启动独立只读前端服务并拦截全部 API，题目在内存中生成，不连接真实题库：

```sh
node back-end/tests/sat-library.test.cjs
node back-end/tests/sat-library.browser.cjs
```

浏览器检查使用开发环境已有的 Playwright 与 Chrome，无新增网站运行依赖。覆盖三分类、按需加载、原模块与题序、Save and Exit / Resume、快照复盘、重新开始、固定时长及事件拦截、普通组题可调时长、375px 窄屏与历史数据隔离。真实题库最终报告沿用 [转换交接说明](../sat-offline-conversion.md)，不将本次合成检查称为真实全库再次验收。

另做真实接口运行检查：独立临时服务使用全新空 private_root 与真实题集目录，新 Chrome context 只经网站加载所选三集（完整 98 题、数学 5 题、英语 4 题），不遍历全部题包。107 题均进入准备及考试；10 张图片成功解码，121 个公式无渲染错误，保留 1 条兼容警告。完整卷固定 32/32/35/35 分钟，Save and Exit / Resume 保持同场；最小英语题集完成后 Open Review、Restart 新场并保留旧记录通过。页面、HTTP、请求和外部请求错误均为 0。测试浏览器与临时服务已关闭，未改活动卷或用户浏览器历史，临时私有目录未生成文件；脱敏报告只含计数和状态，位于忽略的 `local-data/agent-output/2026-10-23/sat-library-real-runtime-smoke-redacted.json`。此检查覆盖选中三集的实际接入，不表示重新审核了全库题意、来源答案或全部设备。

接入时发现旧的 8888 本机进程尚未载入新接口（目录返回 404），已仅重启此项目服务并核对目录返回 200、三类分别 48/181/47、不可用项为 0。以后修改服务端路由后需重新启动本机服务，仅刷新前端页面不会让旧服务进程获得新接口。

## Practice Builder 全库索引

原先首页题数和 Builder 只读取当前浏览器已经导入的 questions，所以未开始过的题集没有出现在选题范围中；截图中的 196 是本机已导入题数，不是新题包不受支持。现在后台 `GET /api/sat-library/question-index` 返回全库的来源、题目版本和完整搜索文字，支持英语、数学选择题与数学填空；不读取答案、解析或图片字节。每个集合按 report、manifest 与 items 的文件状态缓存，文件更新后自动失效，损坏集合独立显示错误。

页面把索引与本机题目按不可变题目 ID 合并，保留已有完整题、额外手动导入版本及个人记录。来源显示实际标题，题型使用新题包的原始分类；分页、跨页全选、按来源和全文搜索都使用全库索引。开始时仅加载选中题所在集合，核对包、题目修订与模块引用后才导入，不修改活动卷或归档历史。索引加载中首页显示加载状态，失败可 Retry；活跃来源中已删除的单题保持隐藏，已删除整源可显式恢复。原有自动命名、手工名称、自定义时长和错题本规则保留。

原创合成模块与浏览器检查、原 Start Practice 浏览器回归、源码白名单导出检查均通过；真实隔离运行核对 8309 题、363 个题型来源、276 个集合全部进入 Builder，可按科目筛选并全选。仅为实际选中的英语与数学填空各一题请求两个题集，两模块均使用指定的 120 秒，作答、保存与恢复通过，历史及活动标记未改。真实报告只含计数与状态，位于本机忽略目录 `local-data/agent-output/2026-10-23/sat-builder-real-smoke-redacted.json`，不含题目正文、答案或图片。

```sh
node back-end/tests/sat-builder-library.test.cjs
node back-end/tests/sat-builder-library.browser.cjs
python3 -B -m unittest discover -s back-end/tests -p 'test_sat_library_server.py' -q
```
