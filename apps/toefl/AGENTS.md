# 托福模块维护约定

- 本目录交付原有功能源码、原创匿名样例和检查工具；不含正式题库、来源音频、用户记录、录音或真实部署配置。完整资源另行审查接入。
- 保留录音保存顺序、AI 评分缓存、账号隔离、同步合并和专项复习行为；避免为目录整理重写这些流程。
- 修改后运行 `node scripts/check-source.mjs` 与 `node scripts/test.mjs`。后者使用内存数据库和替身 AI，不证明真实硬件、外部 AI 或跨平台验证通过。
- `.gitignore` 默认排除新文件。新增源码须逐项审查，在忽略规则和 `SOURCE_MANIFEST.json` 同时放行；审查差异后用 `node scripts/check-source.mjs --update` 刷新现有清单摘要，原导出 `source-snapshot.json` 不覆盖。
- `src/integration/` 只有映射草案，不提供公共鉴权或保存 API。不得把客户端用户 ID 或分数直接视为服务端已验证结果。
- `src/cloud/schema.sql` 是结构参考，邀请表脚本为幂等结构补充；本模块构建、检查和预览都不执行迁移，不连接原云站，也不提供正式部署命令。
- SAT 在 `apps/sat/` 独立维护。公共入口、路径前缀、身份与跨科记录服务需另行约定；不覆盖 SAT 文件来满足托福构建。
