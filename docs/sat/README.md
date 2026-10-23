# SAT 模块

界面在 `front-end/sat/`；Python 维护工具在 `back-end/tools/sat/`。从仓库根目录启动统一平台：

```sh
python3 back-end/server/serve_platform.py --port 8888
```

打开 <http://127.0.0.1:8888/sat/>。统一平台使用独立的浏览器存储命名空间；目录调整不修改已有本机历史记录。

独立 SAT 服务使用不同端口与运行数据目录：

```sh
python3 back-end/tools/sat/question_bank_server.py --port 8876
```

它默认从 `front-end/sat/` 读静态文件，将题库、图片等运行文件保存到 `local-data/standalone-sat/`，不写回前端目录。双击 `back-end/tools/sat/Start SAT Practice.command` 也可启动；停止服务在对应终端按 Control-C。不要让统一服务与独立服务共用一个端口或混用浏览器命名空间。

使用 `front-end/sat/data/examples/synthetic-practice.json` 可验证两道原创合成题。真实题目和必要图片只放本机 `local-data/`，不放 Git。完整 98 题指定卷的结构、转换、加载、待审答案和备份见 [SAT 数学与整套练习](../sat-math-exam.md)。

`source-snapshot.json` 是最初接入的历史源码导出摘要，保留当时相对路径与哈希。需要新源码导出时，运行 `back-end/tools/sat/prepare_sat_source.py`；新导出仍采用 `front-end/`、`back-end/`、`docs/` 布局，并在导出目录生成自己的 `docs/sat/SOURCE_MANIFEST.json`。该工具按固定白名单复制源码和许可，生成空题库与原创样例，不包含 `local-data/`、真实题目、备份或个人记录。
