# SAT 数学、新题目包与整套练习

2026-10-23：根据本轮 13 张截图及其文字注释接入 SAT 数学。这是用户对原考试界面保护约定的明确例外，范围限于本文列出的功能；其他未提及的英语界面、More 菜单、计时偏好、高亮与 Notes 行为继续保留。

## 可运行范围

- SAT 专用协议为 `sat-question-pack/0.1-draft`，合同及原创样例仍在 [题目包目录](drafts/sat-question-packs/README.md)。目录由 `pack.json`、`items.json`、`solutions.json`、`assets/` 组成，按读写四选一、数学四选一、数学填空分别存包。
- 现有 SAT 页面已能导入这种包，材料、题干、选项和解析均渲染 Markdown 与 LaTeX。Add Questions 的 `Choose SAT Pack Folder` 选择一个包或包含多个包的目录；现有 Choose Files 继续导入旧读写 JSON。手动导入新包保存在当前浏览器，源目录不被改写。
- 数学包含四选一与 Student-produced response，支持填答预览、切题、标记、检查、保存退出、恢复、精确分数判定、多个可接受值及显式小数写法。回答、题目修订和判分状态保存到练习记录；未审定答案为“待审核”，不误计为漏答或错题。
- 普通数学四选一居中；填空题左侧显示截图中的完整 directions 和示例表，右侧为题目、输入与 Answer Preview，分隔条可拖动或用左右键调整。
- 填空输入静默拒绝字母、空格、单位、重复分隔符及超长输入；非法键入或粘贴不会改变原答案，不显示错误提示。编辑过程中允许 `-`、`.`、`3.`、`3/` 等未完成写法，便于继续输入负数、小数与分数；只有完整数值显示公式预览，判分规则保持完整数值校验。
- 数学不显示 Highlights & Notes。英语仍保留原工具，新格式英语的 Markdown 下划线及高亮/Notes 已接入；公式、代码和图片工具栏不占高亮字符位置，图片缩放不移动后续文字的高亮范围。
- 统一首页数学入口现可进入数学练习；试题仍来自本机或手动导入，不包含公开题库或云端同步。

## 工具与位置

| 操作 | 行为 |
| --- | --- |
| Calculator | 只切换入口状态和题目位移，未接计算器或 Desmos；位移有接近目标时减速的动画 |
| Reference | 右侧独立滚动公式栏；题目立即调整位置，选项随可用空间变窄，没有移动动画 |
| 同时打开两者 | 题目回到截图所示中间位置，完整题目及排除选项按钮不被 Reference 遮住 |
| Reference 全屏 | 占用考试内容区域，保留页头、练习条与页脚；可恢复或关闭 |
| 图片全屏 | 灰色遮罩与独立浮动工具栏；Reference 已打开时继续保留它，关闭后恢复原图缩放 |

Reference 包含圆、矩形、三角形、勾股定理、两类特殊直角三角形、长方体、圆柱、球、圆锥、棱锥，以及圆弧度数/弧度和三角形内角和。几何示意为原创 SVG，不是外部动态程序。

图片工具按用户文字定义：**Zoom In 减少 25%，最低 25%；Zoom Out 增加 25%，最高 300%**。这个按钮含义保留本轮明确要求；后续若要改成通常命名，应另行修改约定及测试。Reset 回到 100% 与原始位置，没有 tooltip；其余图标有对应气泡。大于 100% 可用抓手拖动，触控板 pinch / ctrl+wheel 连续微调；全屏缩放与原图缩放独立。

图片工具仅用于数学。英语题目在内容块原位置以普通图片和资源原始尺寸显示，考试、题目详情和复盘均不挂缩放、Reset 或全屏工具；超出阅读栏的原图可随材料区域滚动查看。

电量显示同时用于英语、数学和休息页，读取浏览器 Battery API 并监听电量/充电变化；浏览器不支持时显示未知状态，不伪造 100% 或充电信息。普通浏览器无法保证所有设备提供该 API。

## 全套流程

试卷配置与同类型题库包分开。`assessment.json` 使用 `sat-assessment/0.1-draft`，每模块保存 `section`、`moduleNumber`、`durationSeconds` 与有序 `items` 引用，每个引用绑定 `packId / packRevision / itemId / itemRevision`。组卷按这些引用恢复原卷顺序，数学填空仍出现在原来的题号，不能把同类型包顺序当作试卷顺序。

完整测试集合首页提供“全套模考”。当前测试配置为英语 27+27 题、数学 22+22 题，模块分别为 32、32、35、35 分钟。普通自定义练习仍显示实际选题数量，不补假题、不宣称小样包是完整官方试卷。

检查页的 `Next` 直接保存本模块并进入下一模块；英语最后一个模块直接进入黑底双栏休息页，不再弹出结束确认。自动超时仍先显示 `This Module Is Over` 再推进。数学最后一个模块结束后才显示全套完成页。

休息倒计时固定从 600 秒开始；练习中可以随时点击 `Resume Testing` 提前结束休息，到零后按钮文字变为 `Resume Testing Now`。首次点击进入独立黑底等待页，标题为 `Resume Testing Now`，提示 `Your testing timer has not started counting down yet.`；再次点击黄色 `Resume Testing` 才启动数学第一模块及完整计时。休息截止时间和等待阶段 `section_ready` 均随运行状态保存，刷新不重置休息或提前启动数学。休息与等待都不计入作答用时。

当前没有官方自适应路由、校准或 200–800 换分算法；练习结果只表示已审定题目的原始判分。Calculator 入口没有计算功能。

## 指定测试卷的转换与备份

用户明确指定 `耕读合集/测试/26年3月美国A卷.json` 作为唯一可用测试集合，并要求先备份、清除原有集合。原始 JSON 保持未改，已转换为上面的 SAT 专用新协议，而不是旧 v1 或耕读 HTML 协议。

```text
private-data/sat-packs/
  active.json
  gengdu-2026-03-us-a/
    assessment.json
    conversion-report.json
    rw-single-choice/{pack.json,items.json,solutions.json,assets/}
    math-single-choice/{pack.json,items.json,solutions.json,assets/}
    math-spr/{pack.json,items.json,solutions.json,assets/}
```

实际转换结果：54 道读写四选一、32 道数学四选一、12 道数学填空，共 98 题；保留 67 个 `latex-data` 公式和 11 处上下标；丢弃 61 个编辑器 textarea。16 份原图按原 SHA256 保存，另两张源 HTML 表格按明确格值排为静态 SVG，未从图像猜测数据或新增图表数据协议。

来源 98 个答案全部标为 needs-review；98 道题均缺解析，明确保存 missing。4 道数学题存在重复选项或 LaTeX 属性与内部显示 DOM 冲突，保留来源并记录在私有 conversion-report 中，不擅自猜改或升级为已审核。它们在数学第一模块的第 3、14、17、22 题。

原有 18 集、929 题与 36 张图已备份到本机 `private-data/backups/sat-before-math-20261023-152950/`，题库 JSON 从活动旧库目录移出。备份清单保存逐文件摘要；旧图片继续保留以支持既有历史复盘。真实试题、图片、转换结果和备份全部被 Git 忽略。

浏览器遇到新集合时，先经本机服务成功备份旧 sources/questions/attempts/wrongBook 与运行状态，再软归档旧活动题库并导入新集合。历史复盘保留，旧中断练习不再恢复，旧错题不混入新活动题库；同一集合不重复归档。用户主动删除的题集或单题不会被自动同步复活。无法确认备份成功时不清理缓存。

重复转换命令（只写本机忽略目录）：

```sh
python3 scripts/convert_gengdu_sat.py --replace --activate
```

同一题目修订不可覆盖已导入的不同内容。需要修订题目或转换结果时，应提升修订或使用新的 collection ID，再进行审核导入；不能靠重复执行覆盖已保存历史。

文件备份恢复时先停止本机服务，保留当前新集合，将备份的 `question-banks-sat/` 复制回旧题库位置，并撤销或改指 `active.json`。浏览器快照位于 `private-data/backups/<collectionId>/browser-<sha256>.json`；包含本机历史记录，不应提交或公开。恢复操作应单独执行并核对目标，本文没有自动覆盖恢复按钮。

## 接口与依赖

统一本机服务沿用 `python3 scripts/serve_platform.py --port 8888`。独立 SAT 服务仍可使用 README 命令及包目录手动导入；默认指定测试集合的自动读取由统一服务实现。

- `GET /api/sat-packs`：只读取 active.json 指向集合的已声明包文件，检查协议、路径、资源摘要、MIME 与静态 SVG。
- `POST /api/sat-library-backup`：校验回环 Host、同源 Origin 与本机随机 token 后保存快照；返回确认与摘要。备份目录没有静态公开路由。
- `/api/platform/catalog` 的 SAT 统计包含新包；`/api/question-bank` 保留旧 v1 兼容职责。没有修改 TOEFL 的题目协议。
- 本地内置 Marked 18.1.1、DOMPurify 3.4.17、KaTeX 0.19.0 与所需字体；版本摘要及完整许可见 `apps/sat/vendor/`。页面运行不依赖远程 CDN 或新增 npm/Python 安装，也不新增付费服务。

## 验证方式与实际结果

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/sat-pack.test.cjs
node tests/sat-session.test.cjs
node tests/sat-storage.browser.cjs
node tests/sat-content.test.cjs
node tests/math-tools.test.cjs
node tests/sat-math.browser.cjs
node tests/sat-annotations.browser.cjs
```

浏览器脚本需要已有 Playwright 与 Chrome，仅用于开发检查，不是网站运行依赖。无这些工具时，不应声称浏览器检查已执行。

本轮 Python 共 65 项通过，题目包与组卷 Node 检查共 34 项通过。本机源码白名单导出实际生成 103 个文件，102 条文件摘要匹配，60 份字体字节与原依赖一致，脚本、样式及字体引用齐全，且不含真实题库、题图、备份或 `.DS_Store`。

本轮在 macOS Chrome 的独立测试上下文实际验证了数学布局和两工具组合、Reference、图片缩放/抓手/pinch/全屏、全屏图进入检查页后的清理、SPR 保存恢复/判分/错题/复盘、完整四模块流程、检查页 Next 直接推进、自动超时模块结束页、模拟时钟的十分钟休息、提前继续及刷新恢复、独立数学等待页与第二次 Resume 后才计时、电量已支持/未知状态，以及旧英语高亮与 Notes 回归。英语普通图片在 1440px 和 700px 视口及复盘中均保留原创资源 520×190 的原始尺寸，未挂数学工具。已目检原创样题的数学、Reference 双开、填空、休息、数学等待和英语图片页截图。

另对真实转换后的 98 题在本机统一服务逐块渲染：511 个内容块、18 个图片引用全部成功，没有公式解析错误或缺图；原四模块题量与时长匹配。实际 Chrome 页面已显示仅 98 道活动题目及四模块整套入口。未验证 Windows 或 Safari；模拟触控板事件不等于已在每种硬件上手动测试。
