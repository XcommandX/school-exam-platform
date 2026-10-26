# TOEFL 共享题库

2026-10-26 更新：3,744 题组、17,388 小题、1,796 词、5,239 个引用音频和 2,025 张图片。用户已明确授权本轮将题目和引用媒体推送至最新 main；不包含私人站的账号或练习数据。详见 `docs/toefl/SHARED_BANK.md`。

沿用现有 `bank.json` 共享格式；每个任务按 `toefl-task/1` 校验，以 `RESOURCE_MANIFEST.json` 逐文件核对大小与 SHA-256。运行 `node back-end/toefl/scripts/check-resources.mjs` 检查。原始任务、小题 ID、日期版本、复现关系、答案、解析和译文保留，仅运行时本地资源路径归一化。

不含账号、作答、用户录音、密钥、HAR 或部署配置；不得上传重复 ZIP 或生成页面。
