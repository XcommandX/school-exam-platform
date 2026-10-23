# 统一账号与用户管理

首页、TOEFL 与 SAT 入口现在共用 Python 服务签发的登录会话。此实现运行在既有本机服务中，数据保存在 `local-data/auth/platform.sqlite3`，没有开通外部云服务或发布公网网站。

## 启动与首次管理账号

```sh
python3 back-end/server/serve_platform.py --port 8888
```

访问 `http://127.0.0.1:8888/`，未登录会进入 `/login`；登录后返回原先想访问的站内页面。账号管理位于 `/account`，也可从首页头像菜单进入。管理员可以创建账号、调整显示名和角色、停用或恢复账号、重置密码；普通用户只能管理自己的资料、计划、目标与密码。重置密码、修改密码、停用和角色改变会撤销目标账号已有会话。服务端禁止停用或降级最后一个有效管理员。

用户指定的三个初始账号仅在维护者本机数据库创建，不把姓名、初始密码或数据库写入共享源码。其他开发副本需要自行创建初始管理员：

```sh
python3 back-end/server/platform_auth.py create-admin --username YourAdmin
```

维护命令会在终端私下询问两次密码，不把密码写进命令参数。启动不会自动创建弱密码账号，也不会把重启当作重置密码。

同一账号只保留一个有效登录会话：在另一浏览器成功登录后，原会话失效；失败登录不影响原会话。同一浏览器的标签页共享会话，页面绑定的用户 ID 不随 Cookie 切换而改变，旧标签不能把旧账号记录写给新账号。

## 保存边界

| 内容 | 保存位置与行为 |
| --- | --- |
| 用户、密码验证信息、会话、管理审计 | 私有 SQLite；密码只保存加盐哈希，会话只保存令牌摘要 |
| 首页学习计划、目标分数、减少动画偏好 | 当前账号的服务端记录；用版本号检测并发修改，冲突时重新读取 |
| TOEFL 历史、草稿、词汇、学习状态、旧题型历史 | 当前账号的服务端状态；复用 TOEFL 原有队列、合并与版本重试 |
| TOEFL 显示偏好、页面恢复、录音 | 当前账号的当前浏览器；录音尚未接入服务端 |
| SAT 练习历史、当场题目版本、错题本、练习设置 | 当前账号的服务端记录及浏览器缓存；本机保存与待同步队列在同一事务中落盘 |
| SAT 逐题计时、当前页面与正在运行的考试 | 当前账号的浏览器；保存退出或完成练习才同步持久记录，保存退出包含可恢复快照 |
| 旧匿名平台记录、原独立应用记录 | 保留原存储，不自动复制、删除或分配给任何账号 |

首页通过当前账号的 TOEFL 服务端记录和 SAT 服务端摘要计算统计；无冲突的本机待同步 SAT 记录覆盖对应摘要，服务不可用时显示本机缓存与提示。不将未评分题目或客户端练习分数当作官方考试成绩。新登录后看不到过去匿名身份的数据属于明确的隔离边界，不表示数据被删除。

服务端同步意味着两个浏览器连接**同一台服务**可以读取该账号已同步的记录。两位开发者各自在自己电脑启动的 `127.0.0.1` 服务有各自数据库，不会自动同步。公网部署、跨设备网络接入、正式 TOEFL 题库、外部 AI 和录音上传需要另行配置和验证。

## 接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/auth/session` | 返回真实登录状态与当前用户；未登录返回 `authenticated: false` |
| `POST /api/auth/login` | 用户名和密码验证，签发会话 Cookie |
| `POST /api/auth/logout` | 撤销当前会话并清除 Cookie |
| `POST /api/auth/password` | 验证原密码后修改密码、撤销该账号全部会话 |
| `GET/PATCH /api/me` | 当前用户及显示名 |
| `GET/PUT /api/me/home` | 当前账号首页数据，携带 `revision`，冲突返回 409 |
| `GET/POST /api/admin/users` | 管理员查询、创建用户 |
| `PATCH /api/admin/users/{id}` | 管理员调整显示名、角色、启用状态 |
| `POST /api/admin/users/{id}/password` | 管理员重置密码 |
| `GET /api/toefl/bootstrap` | 当前用户与其 TOEFL 状态 |
| `GET/PUT /api/toefl/state` | 当前用户 TOEFL 状态，按 key 和版本合并 |
| `GET /api/sat/bootstrap` | 当前账号的 SAT 记录版本目录，含删除标记；每页最多 500 项，以 `nextCursor` 续读 |
| `GET/PUT /api/sat/attempts/{id}` | 一次练习的记录、答案及当场题目与恢复快照 |
| `GET/PUT /api/sat/wrong-book/{id}` | 一条错题及其题目快照 |
| `GET/PUT /api/sat/settings/{key}` | 允许同步的练习设置 |
| `GET /api/sat/summary` | 首页需要的轻量统计，不返回答案、题目快照或运行状态 |

写请求只接受本机同源 `Origin`；JSON 接口要求 `Content-Type: application/json`。已登录请求的 `X-Account-ID` 绑定页面加载时的用户，不能选择目标账号，服务端始终以 Cookie 为身份依据。学生无法通过改写 URL、请求体或隐藏菜单取得管理权限。共享 SAT 题库的导入要求管理员身份，并保留原本机令牌检查。`/api/sat-library-backup` 允许已登录用户备份自己的浏览器库，校验身份、同源与令牌后保存至 `local-data/backups/accounts/<userId>/`，避免首次加载题库时阻塞普通用户。

## SAT 账号菜单与同步

统一平台的 SAT 管理页面右上显示账号胶囊；原独立 Settings 已收进菜单的“练习设置”。菜单提供练习记录、错题本、账号管理或个人中心、同步状态、立即同步及退出。完整练习记录页支持名称搜索、完成状态与科目筛选、分页、复盘、继续和删除。独立 SAT 服务保留原 Settings；准备、答题、检查、模块结束及休息阶段不显示账号菜单，也不应用新的管理样式。

本机 IndexedDB 升级至版本 3，增加 `accountSync` 与 `accountSyncConflicts`，保留已有按账号划分的库名。服务启动按顺序应用 `002_sat_accounts.sql`，不重建账号。同步只处理当前账号的持久练习记录、错题和五类设置：`appConfig`、`practiceDurationPreferences`、`customPracticeDurationSeconds`、`timingTargets`、`questionTimer`。公共 sources/questions、文件夹句柄、活动题库标记和高频运行状态不会单独上传；记录包含当场所用题目快照，另一浏览器无需依赖当前题库版本即可复盘或继续已保存的练习。

初次恢复位于本机题库初始化之后，避免题库归档把刚恢复的练习标记为不可继续。下载未完成练习不会自动开始倒计时，用户点击 Resume 后才恢复。考试期间可以发送已持久化的保存任务，但不应用远端记录或重绘考试页面。

每项写入携带 `revision` 与唯一 `mutationId`，网络重试不重复创建记录。断网时保留本机答案及待同步任务，重新联网、回到页面或点击“立即同步”时重试。状态只有在没有待同步项和冲突时才显示“已同步”。同一浏览器各标签通过共享事务和同步锁协调；同账号同时只允许一个标签运行练习，另一个标签需等待前者保存退出，防止共享运行缓存和旧答案互相覆盖。该保护使用现代浏览器的 Web Locks；不支持时明确提示，不能静默放弃保护。旧账号页面仍绑定原用户 ID，不能向切换后的账号写入。

错题恢复仅补回该题及带 `accountSnapshot` 标记的来源元数据。此来源不代表整包已导入；Start Practice 和 Practice Builder 后续加载时会补齐完整包，仍检查已知来源哈希，练习记录中的历史题目快照不被改写。

两处都修改同一记录时，菜单中的“同步冲突”可选择本机或服务器版本，并可先下载本机完整副本。互不重叠的设置修改可合并；已完成的服务器练习不允许被旧设备覆盖或降级，已删除的练习不允许复活，此时可下载本机副本后采用服务器版本。错题删除后只有显式重新加入才可恢复。删除标记保留，避免旧浏览器再次上传已删除记录。

单项记录最多 64 MiB，设置最多 256 KiB，每账号最多 512 MiB、20000 项；同时最多处理两个大型传输。超过限制会返回错误并保留本机待同步内容，不把失败当作已保存。此限制防止单次读取失控，不代表已完成 150 人容量验收。完整练习快照可能包含题目与图片，仅保存于该账号私有数据库，不公开为静态文件。

受保护 HTML 与账号接口使用 `Cache-Control: no-store`。Cookie 为 `HttpOnly; SameSite=Strict; Path=/`；本机 HTTP 开发不设 `Secure`，因此服务继续只绑定回环地址。公开部署必须使用 HTTPS、安全 Cookie、生产 HTTP 服务、备份恢复及容量验证，不可把这个开发服务器直接开放给校园网络。

## 代码边界

- `back-end/server/platform_auth.py`：账号、密码、会话、权限、限速、用户状态与 HTTP 接口。
- `back-end/server/sat_account_state.py`：SAT 记录校验、版本与删除标记、幂等写入、容量限制及摘要。
- `back-end/server/migrations/`：按顺序应用的数据库结构迁移。
- `front-end/web/platform-auth.js`：共同客户端、退出、失效与旧标签隔离。
- `front-end/web/login.*`、`account.*`：登录与账号管理。
- `front-end/web/toefl-bridge.js`：等待验证身份与恢复状态后加载 TOEFL；只加载单个经审查的云客户端，不公开整个 `clients/` 目录，也不连接原云站。
- `front-end/web/sat-bridge.js`：按已验证用户映射存储名称，SAT 考试页面布局、计时、判分与答题引擎不变。
- `front-end/web/sat-account-sync.js`：SAT 持久队列、恢复、重试与冲突处理；`front-end/sat/js/storage.js` 在本机保存事务中登记同步任务。

数据库和截图等产物均在被忽略的 `local-data/`，不得提交或上传。维护数据库前先停止服务并做备份；备份需包含 SQLite 已提交数据，不能只在运行中随意复制主文件而遗漏 WAL。

## 验证

2026-10-24 实际完成：12 项账号后端测试、32 项既有平台/SAT 服务端回归、46 组 TOEFL 模块回归及 9 组 Chrome 浏览器流程检查通过。浏览器检查包含真实登录、首页与 TOEFL 身份一致、两个账号的数据隔离、管理员页面创建/角色/启停/重置操作、学生个人资料与改密、旧会话撤销、首页版本冲突保护及桌面/手机宽度。测试使用临时数据库和原创匿名数据，未导入个人历史。三个用户指定初始账号另在本机逐一检查了登录、共享 TOEFL 身份、管理员访问与退出。

后续 SAT 同步检查：13 项 SAT 账号后端测试、12 项原账号回归、33 项平台/SAT 服务端回归、9 组账号菜单检查、8 组同步与冲突浏览器检查、6 组真实保存退出/换浏览器恢复流程均通过。另运行首页统计模型、原 IndexedDB、Start Practice 题集和 Practice Builder 回归；补充了部分错题来源补齐完整题包及版本冲突检查。所有新增账号与答题均在临时环境使用原创匿名数据。8888 本机服务已加载新接口，启动前备份了私有数据库，迁移后原三个账号及管理员角色保留；没有重置其密码或在测试中重新登录这些账号。

```sh
python3 -B -m unittest discover -s back-end/tests -p 'test_platform_auth.py' -q
python3 -B -m unittest discover -s back-end/tests -p 'test_*server.py' -q
node back-end/tests/home-model.test.cjs
node back-end/toefl/scripts/check-source.mjs
node back-end/toefl/scripts/test.mjs
node back-end/tests/unified-auth.browser.cjs
python3 -B -m unittest discover -s back-end/tests -p 'test_sat_account_sync.py' -q
node back-end/tests/sat-account-menu.browser.cjs
node back-end/tests/sat-account-conflicts.browser.cjs
node back-end/tests/sat-account-flow.browser.cjs
node back-end/tests/sat-storage.browser.cjs
node back-end/tests/sat-library.browser.cjs
node back-end/tests/sat-builder-library.browser.cjs
```

浏览器脚本需要开发环境已有 Playwright 和 Chrome，可通过 `NODE_PATH` 指向现有 Playwright 包位置，或用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器。运行前构建 TOEFL 匿名预览。截图及结果写入忽略的 `local-data/test-artifacts/unified-auth/`。未运行 Windows、Safari、真实麦克风、公网部署或多人容量验收，不把上述检查当作这些环境已验证。
