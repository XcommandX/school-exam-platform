# 统一学习首页

## 启动

需要 Python 3.10+，无需安装依赖。从仓库根目录运行：

```sh
python3 scripts/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/>。macOS 可双击根目录 `Start Study Platform.command`；终端窗口需要保持打开。默认端口 8888 与独立 SAT 原型的 8876 分开。Windows 可使用 `py -3`，本轮未验证 Windows 双击启动。

## 页面与功能

- 顶部选择 SAT、AP、TOEFL 或 Personal Vocab，各考试有独立题库目录。
- SAT 首页提供自定义训练、按套模考、错题本、题库筛选及单套练习入口。
- 右上圆形头像提供本地访客状态、设置和 SAT 计时设置。测试阶段无需登录。
- AP、TOEFL 和词汇展示待接入状态，不生成模拟进度或虚假题库。
- SAT 的答题引擎、保存退出、恢复、判题与复盘继续复用 `apps/sat/`，原 HTML、JS、CSS 保持不变，紫色新主题只作用于首页。独立的 `apps/web/sat-bridge.js` 负责入口跳转和存储名称映射，不添加 SAT 样式，不更改答题或计时逻辑。当前仅 Reading & Writing，不含数学、自适应分流或官方量尺分。

## 数据边界

源码在 `apps/web/`、`apps/sat/`、`shared/`、`scripts/`。题库格式和示例见 [question-format.md](question-format.md)。

真实题库在 `private-data/question-banks/{sat,ap,toefl,vocab}/`，图片在 `private-data/question-assets/<exam>/`。这些目录被 Git 忽略，不随提交/推送共享。服务器仅通过明确的题库接口和图片路由读取它们，不将仓库根目录作为静态网站公开。

本次本地迁移仅保留原 SAT 题目及其标准答案、解析、格式、模块信息与必要图片。逐字段白名单去除已选答案、学生信息和任意个人元数据；不复制 HAR、PDF、OCR 模型、备份、个人练习或浏览器记录。原始目录不修改。带个人练习含义的来源名称改为中性补充题集名称，题目内容保留。

本机完整迁移为 18 个题集、929 道题和 36 张必要图片：原题库目录 901 道、原型内置种子 27 道、独立示例 1 道。与题库重复的 4 道示例不再次导入。

统一平台使用 IndexedDB `SchoolExamPlatform:sat:v1`，考试运行状态使用 localStorage `school-exam-platform:sat:runtime:v1`。独立 SAT 页面保留旧存储名。新页面不读取、复制或清理旧记录。同一浏览器新平台仍是本地访客共享环境，不能当作账号隔离或云端存储。

## 本地迁移

使用迁移脚本的 `--help` 查看参数，显式提供原 SAT 根目录；迁移是独立操作，服务启动时不会自动读取桌面或原项目。不要复制原项目整目录，也不要 force-add `private-data/`。

```sh
python3 scripts/migrate_sat_bank.py --source-root "/path/to/original-sat-folder" --include-examples
```

对没有真实题库的开发副本，可从 SAT 题库页导入 `apps/sat/data/examples/synthetic-practice.json` 做基础验证。

原型内置 JS 种子需先导出为只含题目的 JSON，再用 `--seed-json <sanitized-seed.json>` 显式导入；不得复制包含姓名配置的完整 JS。迁移输入同样存于被忽略的本地目录。

## 本机接口

| 请求 | 用途 |
| --- | --- |
| `GET /api/platform/catalog` | 四个考试的题库统计、来源及接入状态 |
| `GET /api/exams/{exam}/sources` | 单个考试的独立题集目录 |
| `GET /api/exams/{exam}/sources/{id}` | 统一格式的单套题集 |
| `GET /api/auth/session` | 当前访客状态；为未来认证服务保留边界 |
| `GET /api/question-bank/status` | SAT 兼容接口状态与同源写入令牌 |
| `GET /api/question-bank` | 将统一题库转换为旧 SAT 引擎可导入格式 |
| `POST /api/question-bank` | 校验、过滤个人字段并保存 SAT JSON |
| `/sat/` | 进入旧 SAT 引擎，支持首页功能入口参数 |

`exam` 为 `sat`、`ap`、`toefl` 或 `vocab`。账号与其他考试引擎仍待实现；公共格式当前支持选择题，音频、录音和开放式题型可在后续版本扩展，不能冒充已支持。

本机服务仅绑定 `127.0.0.1`。写入需匹配 Host、Origin 和随机令牌；这不是正式身份验证。未来公开部署需要替换认证、授权、资源和记录服务。

## 验证

```sh
python3 -m unittest discover -s tests -v
```

自动检查只使用临时目录与合成题目，覆盖统一格式转换、隐私字段过滤、考试隔离、接口读写和路径访问边界。浏览器验证范围及未完成项在本次交付说明中单独列出。

本轮实际验证：13 项 Python 格式/接口测试通过，首页与桥接脚本语法检查通过；浏览器实测考试切换、搜索、头像菜单/设置、指定套题、准备页、作答、保存退出/恢复、交卷、判题、错题本及首页统计。验证使用另一端口上的原创合成题。36 张迁移图片在两种资源路径均返回成功。原 SAT 目录与任务开始前 Git 版本完全一致，未改原计时行为；已知原型限制继续适用。Windows 与真实多人账号场景未测试，账号功能尚未接入。
