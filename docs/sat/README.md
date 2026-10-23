# SAT 模块

界面在 `front-end/sat/`；Python 维护工具在 `back-end/tools/sat/`。从仓库根目录启动统一平台：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/sat/>。统一平台使用独立的浏览器存储命名空间；目录调整不修改已有本机历史记录。

2026-10-24 已接入 SAT 账号菜单和服务端记录。右上账号胶囊沿用首页与 TOEFL 的风格，原 Settings 收进菜单的“练习设置”；菜单还可进入完整练习记录、错题本、账号管理或个人中心、同步冲突和退出登录。练习记录支持名称搜索、状态与科目筛选、分页、复盘、继续及删除。考试阶段保持原界面。

练习记录、当场题目快照、错题本与练习设置按当前账号保存在统一服务的私有 SQLite，浏览器保留缓存和断网待同步队列。Save and Exit 会保存答案、计时及恢复快照，登录同一服务后可从另一浏览器继续；下载记录不会自动开启倒计时。考试中的高频本机状态、公共题库和文件夹句柄不加入同步队列。菜单显示真实同步状态，冲突可保留本机或服务器版本并下载本机副本；已完成记录不可降级，已删除练习不能由旧设备复活。接口、容量、迁移与网络边界详见 [统一账号](../unified-auth.md)。这不代表已发布公网网站。

以下检查仅使用临时账号、临时数据库和原创合成题，不操作已有用户记录：

```sh
python3 -B -m unittest discover -s back-end/tests -p 'test_sat_account_sync.py' -q
node back-end/tests/sat-account-menu.browser.cjs
node back-end/tests/sat-account-conflicts.browser.cjs
node back-end/tests/sat-account-flow.browser.cjs
```

SAT 概览中的 `Practice Builder`（原 `Question Library` 卡片）集中提供练习名称、自定义选题、按来源组题、时长设置和开始练习。`Start Practice` 按 2026-10-23 后续截图接入 Full-Length Tests、Reading and Writing、Math 三分类目录，默认第一类；题集按开始、继续、重新开始和复盘分别显示入口。全真模考来源按官方考试日期时间线排列，School Day 保留月精度，Bluebook、拼卷及无日期来源单独归组，日期依据见 [考试日期](../sat-exam-dates.md)。`Explore Questions` 以及首页英语/数学入口均进入组题页；旧 `view=questionLibrary` 链接兼容转到 `Practice Builder`，`view=practiceBuilder&mode=source` 继续支持按来源组题。整套模考入口与开始后的考试流程保持原有行为。

2026-10-24 已移除概览的 `Manage library` 入口及整个旧导入界面实现，包括文件夹管理、选择文件/题包、拖放、预览与导入按钮。首页 `Add Questions` 卡片继续保留，进入后仅显示 `Add Questions` 标题，下方留空，等待后续功能接入。后台既有题库加载、Start Practice、Practice Builder 和答题记录继续保留，不删除题库或历史。删除前源码与恢复补丁只保存在忽略的 `local-data/localfiles/sat-manage-library-<时间>/`，不进入 Git。

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
- 服务默认合并 `back-end/sat/questions/sat-packs/gengdu-offline/` 与并列的 `pdf-official/` 两份独立目录索引；缺少某份目录时仍可使用另一份。Start Practice 与 Practice Builder 全库索引读取相同的来源。`SAT_LIBRARY_ROOT` 或 `--sat-library-root` 可指定只读取一份目录，显式参数优先于环境变量，相对路径以仓库根目录为基准，不额外混入默认两库。目录迁移后仍用稳定 `collectionId` 关联练习记录。

上述共享题库由用户从原 `local-data/sat-packs/gengdu-offline/` 完整复制，迁移只调整服务端默认读取位置，不改题包内容、版本、活动卷或浏览器记录。旧 `/api/sat-packs` 活动卷和可写旧格式题库仍归 `local-data/`。转换工具仍默认输出到 `local-data/`，不会自动覆盖共享副本；更新共享副本时应保留稳定身份及版本引用。服务启动时确定题库路径，修改后需重启服务；已有 `SAT_LIBRARY_ROOT` 或 `--sat-library-root` 会继续覆盖默认值。

PDF 题库使用独立的 `pdf-official/catalog.json` 与每卷 `conversion-report.json`，不会修改耕读目录、题包 ID 或修订。两库合并只涉及目录元数据，选择一卷时才加载正文与资源；跨库重复的 `collectionId` 会显示错误并拒绝加载，不能用后一库覆盖前一库。损坏的一份目录索引不影响另一份可用目录。来源分类 `测试` 进入 Full-Length Tests，但是否为完整 SAT 仍由四模块、题数与原题序校验决定；单科或缺题 PDF 保持 Partial Test。标题保留可核对的年月，由已有时间线规则排序；未核实具体日期只保留月精度，无日期、Bluebook 或拼卷不伪造官方开考日。`pdf-official` 是来源目录名，不表示官方认证或答案已经复核。纯题目与答案版先精确配对去重，再将明确同年月、套号、地区和版本的英语与数学组合；详细来源、异常和可重复命令见 [PDF 转换与合并](../sat-pdf-conversion.md)。

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
