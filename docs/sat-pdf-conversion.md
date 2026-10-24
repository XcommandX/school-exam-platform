# SAT 可编辑 PDF 题库转换与合并

本次来源为用户指定的“更新到26年10月SAT最新真题题库+答案”。原 PDF 保留在忽略的 `local-data/references/`，不改写、不纳入本次提交。用户要求转换结果进入 `back-end/question-banks/sat-packs/pdf-official/` 并本地提交；本次不包含推送、合入 main 或发布网站。目录名 `pdf-official` 不构成官方认证。

## 转换和来源追溯

程序清点 508 份 PDF、9,732 页，先固定种子分层随机抽取 5 份并审阅少量文本和页面图像，之后才批处理。抽样覆盖不同年份、阅读/数学、缺题和 Bluebook。每次只处理一卷，不把全库题干或 JSON 放入 agent 上下文。

508 份文件恰好为 254 对纯题目版与答案解析版。初始逐 PDF 转换共 21,116 个条目；去重后保留 10,558 道来源题目。配对核对每题原模块/题号、规范化文本、字符字体/上下标特征、实际绘制图片摘要和向量线条特征，全部 10,558 对相符。因此无需使用模糊相似度，不通过题号或“99%”阈值盲目转移答案。纯题目版合入答案版，公开目录不重复列无答案版。原 PDF 和转换证据保留用于追溯。

- `pdf-source-manifest.json` 记录每个 PDF 的路径、SHA-256、持久来源身份以及最终去重/组卷映射。
- `catalog.json` 是 Start Practice 的最终目录；服务只在开始指定题集时加载题目与资源。
- 每个目录包含按作答方式拆开的 `rw-single-choice/`、`math-single-choice/`、`math-spr/`，各自保存 `pack.json`、`items.json`、`solutions.json` 和所需 `assets/`。
- `conversion-report.json` 保留模块与原题号到具体题目修订的映射、转换警告、答案状态；完整 SAT 另有 `assessment.json`。
- 中间 PDF 提取文本、坐标、抽样图、审阅结果以及去重前的生成副本保存在忽略的 `local-data/pdf-sat-conversion/`，不提交原 PDF、用户答题记录或临时文件。

## 英语与数学如何合并

匹配键为来源明确给出的年月、单一套号、地区与模块版本。明确的“亚太”“北美”与未标地区不是同一个键；多套合并、去重混卷、歧义版本、缺少另一科的来源不猜配。Bluebook 保留独立来源，不虚构考试日期。

原阅读包和原数学包的题目 ID、修订、题序、答案与图片保持一致；组合仅新增共同目录与有序模块引用。只有英语 M1/M2 各 27 题、数学 M1/M2 各 22 题且原题号连续，才设置 `fullSAT: true`，按 32/32/35/35 分钟与英语后 10 分钟休息启动。缺题或非标准模块的组合保留 Partial Test，不补题、不重编号。

例如 `2026年10月第3套阅读语法.pdf` 与 `2026年10月第3套数学.pdf` 具有相同年月、套号和地区范围，合为一套；相应纯题目 PDF 只作为同卷来源，不重复出现。最终得到 **71 个跨科组合：51 套完整 SAT、20 套 Partial Test**；另有 112 个单科来源无法明确匹配，公开目录共 **183 集、10,558 题**。254 个纯题目版不再重复上架。逐组合及未合并理由见 [合并说明](../back-end/question-banks/sat-packs/pdf-official/合并说明.md)，原508来源到最终题集的映射见同目录的 `pdf-source-manifest.json`。

## 文字、公式和异常

文本使用 Markdown；公式统一保存为 LaTeX。真实上下标依据 Unicode 或 PDF 字号/基线转换。源文件本身丢失幂、根号或分式信息时，保留可见符号的 LaTeX 并标记待审，不根据答案反推原式，不用公式截图掩盖错误。图表、几何图及需保留的原始视觉信息使用本地资源；数学与英语图片仍由原有引擎各自显示。

解析器依据左侧粗体独立题号、文字基线及 Module 标记分题；保留跨页连续内容。数学重复的全空 A/B/C/D 占位视为 SPR，但有内容的重复/缺失选项会阻止发布。英语材料/提问仅在可靠边界拆分；无法判断时全部保留在提问区域并记录警告，不能丢弃材料。

来源答案与解析均是 `needs-review`，不是已核定答案。当前一项明确的来源冲突是“2024年12月第6套数学”M2 第 11 题：给出的数值答案无法对应四个选项，保持 `missing` 并保留原值与定位。该卷其他答案保留；不凭推断选择选项。源公式、英语分栏等警告也仍需内容复核。结构/KaTeX 解析通过不等于全部题意和答案已审核。

## 可重复运行

网站运行仍使用 Python 标准库；只有离线 PDF 转换/源坐标复核需要独立维护环境中的 `PyMuPDF==1.26.7`。现有 Node 与浏览器依赖沿用项目环境，不给网站增加新运行依赖。

每次重建使用新的 `staging` 与 `publish-staging` 目录；若这些路径已经存在，应改用新的路径，不覆盖上次产物。先从当前题库复制 **两份**身份清单：`pdf-source-manifest.json` 保留原 PDF/题目身份，`assembly-identities.json` 保留跨科组合身份。只复制其中一份会造成身份变化或组合来源冲突。以下初始化命令要求 `staging` 尚不存在：

```sh
python3 -c "from pathlib import Path; import shutil; src=Path('back-end/question-banks/sat-packs/pdf-official'); dst=Path('local-data/pdf-sat-conversion/staging'); dst.mkdir(parents=True, exist_ok=False); [shutil.copy2(src/name, dst/name) for name in ('pdf-source-manifest.json', 'assembly-identities.json')]"

python3 back-end/tools/sat/convert_pdf_sat.py \
  --source-root '/path/to/source-pdfs' \
  --output local-data/pdf-sat-conversion/staging \
  --work-dir local-data/pdf-sat-conversion/rebuild --workers 4

python3 back-end/tools/sat/review_pdf_sat.py \
  --root local-data/pdf-sat-conversion/staging \
  --evidence-root local-data/pdf-sat-conversion/rebuild/extracted \
  --source-root '/path/to/source-pdfs'

node back-end/tools/sat/review_pdf_latex.cjs \
  --root local-data/pdf-sat-conversion/staging

python3 back-end/tools/sat/assemble_pdf_sat.py \
  --root local-data/pdf-sat-conversion/staging \
  --evidence-root local-data/pdf-sat-conversion/rebuild/extracted \
  --publish-root local-data/pdf-sat-conversion/publish-staging
```

`staging` 保留全部原来源包和生成的组合，便于审阅与重试；它不是最终发布副本。`--publish-root` 只复制最终 `catalog.json` 引用的目录，以及目录、原来源索引、来源映射、组合身份和合并摘要这五份 JSON；已有的 `README.md`、`合并说明.md` 也会复制。它不移动或删除来源包，目标必须为空且不能与来源目录互相包含；复制结果先通过最终结构审阅，才落入目标目录。因此无需手动删除纯题目版或已被组合吸收的单科目录。

转换器拒绝在已有 `assembly-summary.json` 的目录原地重建；重新转换时按上面的步骤建立新 staging，并保留两份 UUID 清单。原 PDF 内容摘要发生变化时转换器拒绝覆盖，需要显式审阅并做修订迁移，不能复用旧修订冒充相同内容。

导出后审阅 `publish-staging`，不要将仍保留原来源的 `staging` 交给最终公开目录审阅器。该程序逐卷读取，不依赖 PDF 解析库，也不输出题干。`--source-root` 可选，提供后会检查原 PDF 文件覆盖与 SHA-256；报告默认写入忽略的 `local-data/pdf-sat-conversion/assembly-review.json`。

```sh
python3 -B back-end/tools/sat/review_pdf_assembly.py \
  --root local-data/pdf-sat-conversion/publish-staging \
  --source-root '/path/to/source-pdfs'

node back-end/tools/sat/review_pdf_latex.cjs \
  --root local-data/pdf-sat-conversion/publish-staging

python3 -B -m unittest discover -s back-end/tests -p 'test_convert_pdf_sat.py' -q
python3 -B -m unittest discover -s back-end/tests -p 'test_assemble_pdf_sat.py' -q
python3 -B -m unittest discover -s back-end/tests -p 'test_pdf_assembly_review.py' -q
```

审阅器核对来源、纯题目版与答案版到最终集合的完整映射；实际公开目录必须与 `catalog.json` 精确一致。它还独立检查题目引用、模块与题号、完整模考条件和时长、全部题包及图片完整性、孤儿文件、公开集合的答案存在性，以及最终题数等于去重后的来源题数。计数从清单合同推导，不把本次的 508 或 183 写死为验收条件。

上述命令只生成并审阅新的发布副本，不自动替换当前题库。完成最终审阅与浏览器检查后，先将当前 `pdf-official/` 整体备份到 `local-data/`，再用 `publish-staging` 整体替换；不要把两个目录逐文件叠加，以免留下旧集合。最后保留两份身份清单和来源映射，按本次范围提交。原 PDF 与完整 source staging 继续留在 `local-data/`。

当前默认服务合并已有 `gengdu-offline/` 与这份 PDF 目录，不改耕读文件、不切换 `active.json`，也不归档或清空浏览器历史。显式设置 `SAT_LIBRARY_ROOT` / `--sat-library-root` 仍只读取指定一份目录。修改服务端后要重启对应本机服务才能生效；本次检查使用独立临时服务和浏览器，不覆盖其他正在进行的登录接入工作。

## 实际验证与边界

- 原508份PDF的SHA-256、独立题号锚点、模块、资源、答案分离和一题一引用全部通过。
- 最终公开目录独立审阅及原PDF摘要复核通过：508份来源映射至183集，254对纯题目版与答案版指向相同最终集合；368个题型包、1,424个图片资源及10,558个唯一题目全部通过，孤儿文件与无答案集合为0。7个原创合成回归测试通过，覆盖小规模清单、缺失目标、冗余目录、孤儿资源、原题序、全缺答案和来源摘要变动。
- 最终183集、368个题型包的55,347个LaTeX片段均通过严格解析，未配对美元符、解析错误为0。
- 71个组合均由真实服务读取，完整/部分卷与assessment一致。
- 浏览器实际访问3个最终题集共196题：完整98题卷与44题数学、54题英语；28张图片解码、704个公式节点通过，页面/HTTP/外部请求错误为0。完整卷27/27/22/22原序、32/32/35/35分钟、英语后10分钟休息和两次Resume均通过。只用全新浏览器context，未访问或改动个人记录。
- 自动检查不证明全部来源公式、题意和答案正确。无法可靠拆分的英语材料保持可见并记录待审；一处来源答案冲突仍保留missing。

去重前完整的508生成集合已归档到 `local-data/pdf-sat-conversion/source-packs/`，可用于原PDF审阅及重组；公开目录仅保留183个实际可选题集。组合工具拒绝对缺少原来源包的公开目录直接重建，应在完整staging操作，再审阅发布集合。
