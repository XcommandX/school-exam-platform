# 免费部署评估

**2026-10-24 更新：** 本适配分支已选 Cloudflare Workers + SQLite Durable Objects Free，并实现完整共享题库构建与账号记录适配。当前实际命令、安全边界、初始化及配额见 [Cloudflare 部署指南](cloudflare-deployment.md)。不使用 Supabase，不要求付费，不自动合入 `main`；实际发布状态以交付记录为准。

以下为 2026-10-21 的历史候选评估，不是当前选型。

## 初步候选

若已有源码适合静态前端与托管数据服务，可以评估：

- Cloudflare Pages：前端托管、GitHub 自动部署、分支预览。
- Supabase Free：统一身份、Postgres 数据库与答题记录访问控制。
- 使用托管平台提供的子域名作为统一网址，避免初期自购域名。

若源码包含服务器渲染、常驻 Node / Python 后端或特殊运行依赖，需重新核对兼容性，再选择适合的免费运行方式。不能直接假定任意已有网站均可部署到 Pages。

## 当前免费档的主要边界

| 服务 | 官方公布的部分免费额度 / 条件 |
| --- | --- |
| Cloudflare Pages | 每月 500 次构建，免费档同时进行 1 次构建 |
| Supabase Free | 每项目 500 MB 数据库；1 GB 文件存储；50,000 月活用户额度 |
| Supabase Free 流量 | 5 GB 出站流量、另有 5 GB 缓存出站流量；计量口径见官方说明 |
| Supabase Free 空闲 | 项目连续 1 周不活跃可能暂停；最多 2 个活跃项目 |

150 名总用户并不直接决定用量。题目大小、图片和音频、保存频率、查询方式与同时在线人数都会影响容量和性能。应先估算，再用测试数据验证。

开发者电脑关闭后，已部署的平台仍由云服务运行；免费服务自己的配额、暂停与可用性限制仍然适用。

## 登录与记录保存的验收要求

- 选择具体登录方式，确认学生在校园网络上能够完成登录。
- 若使用邮件登录或找回密码，核对邮件服务配置、发送限制和实际投递；不默认免费档邮件配置已可供全校使用。
- 在两台设备上使用同一账号，验证答题记录可保存并读取。
- 用两个不同账号测试，确认不能读取或修改彼此的私人答题记录。
- 网络中断、刷新或重复提交不会产生重复或丢失的关键记录。
- 若使用 Supabase，配置并测试数据库行级权限；管理密钥仅在服务端使用。
- 测试环境使用匿名数据，正式记录与测试记录隔离。
- 验证可执行的数据导出与恢复方式，记录负责人和步骤。

## 部署流程目标

功能分支 → PR 与检查 → 测试预览 → 另一人检查 → 合并 main → 正式部署。

预览网址只是测试部署；需要对访问权限和测试数据单独配置。私有源码仓库不意味着部署网址自动只有团队可访问。

正式启用前，根据源码选定平台，并把以下信息补充到本文件：构建命令、输出目录、变量名称、测试与正式环境、回滚步骤及当前配额管理方式。

## 官方参考

- [Cloudflare Pages 的 GitHub 集成](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- [Cloudflare Pages 免费档限制](https://developers.cloudflare.com/pages/platform/limits/)
- [Supabase 方案与额度](https://supabase.com/pricing)
- [Supabase 出站流量说明](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

服务额度可能变化，启用前应再次核实。这里的免费部署目标不包含另行购买的域名、Codex 订阅或额外模型 API 服务。
