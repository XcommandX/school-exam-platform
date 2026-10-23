# AP Language and Composition

原生 HTML / CSS / JavaScript 模块，无第三方前端依赖，无构建步骤。通过统一平台服务访问 `/ap/`，不单独启动静态服务器。共享首页样式只读引用 `/web/styles.css`；新增 CSS 限定在 `.ap-app` 内。

## 运行与检查

从仓库根目录运行：

```sh
python scripts/serve_platform.py --port 8888
node tests/ap-model.test.cjs
node --check apps/ap/ap-model.js
node --check apps/ap/app.js
```

打开 `http://127.0.0.1:8888/ap/`。入口支持 `?view=history`、`?view=wrong`、`?view=drafts`。Study Space 返回链接为 `/`。

## 接口

本模块只读请求，不向服务端写入题库、作文或个人作答：

| GET | 响应 |
| --- | --- |
| `/api/exams/ap/sources` | `{exam:'ap', schemaVersion:2, sources:[summary], errors:[]}` |
| `/api/exams/ap/sources/{encoded-id}` | AP Language v2 题集 |
| `/api/ap/example` | `examples/synthetic-practice.json` 原创合成示例，仅由明确点击载入 |

v2 契约由 `shared/ap_schema.py` 定义。前端 `APModel.validateSource` 进行独立防御性校验，保留已知字段，不渲染原始 HTML。PDF 只允许 `/question-assets/ap/<64位小写hex>.pdf#page=N` 链接，并验证页码范围；新标签页使用 `noopener noreferrer`，不嵌入脚本或不可信 HTML。

私有目录中可以存在未结构化扫描资料。`questions: []` 明确显示“文档阅读”，不生成虚构题量、作答记录或成绩。练习先呈现原卷链接，提交后显示评分资料；纯文档也有显式“进入资料复盘”操作。文本抽取待核对的题目有明确提示。

## 功能与判分边界

- 题库按年份、类型、私有/示例来源、关键词筛选；载入失败、部分无效、空库与无匹配分别呈现。
- 原创示例含 2 道 MCQ 和 3 道 FRQ，覆盖 synthesis、rhetorical analysis、argument；示例不是 AP 真题，不计入真实题库与首页私有练习统计。
- MCQ 使用原生单选框，可清除选择、导航、提交与复盘。只有 `reviewStatus:'verified'` 且已有正确答案的已答 MCQ 才判分；未答、待核对题和 FRQ 不计入客观题正确率分母。
- 已核实选择题答错后进入错题本；同一题集同一版本答对后移出。不同 revision 的旧错题不被新版本覆盖。
- FRQ 是纯文本编辑器，支持字数统计、自动草稿、继续编辑、下载作答、提交后查看自己的作答和评分 PDF。没有 AI、FRQ 自动评分或 AP 1–5 分换算。
- 计时可选，显示参考倒计时；到零只提示，不自动提交、不清空答案。只有当前可见的练习页面计入用时，退出或切换标签暂停。关闭页面后不会累计用时。
- 响应式布局、原生键盘表单、聚焦样式、跳过导航、对话框和 reduced-motion。`Ctrl/Cmd+S` 在作答页保存草稿，不劫持输入框的普通按键。

## 本地记录契约

仅使用以下 localStorage 键，不枚举、读取、迁移或清理其他考试或旧应用记录：

```text
school-exam-platform:ap:history:v1
school-exam-platform:ap:drafts:v1
school-exam-platform:ap:wrong:v1
```

每个键直接保存 JSON 数组。完成记录示意：

```js
{
  id: 'ap-attempt:<uuid>',
  status: 'completed',
  finished: 1792756800000, // Unix 毫秒
  started: 1792756740000,
  updated: 1792756800000,
  title: '题集名称',
  sourceId: 'ap:source-slug',
  revision: '<64位hex>',
  contentMode: 'private', // 或 synthetic；首页必须排除 synthetic
  questionCount: 3,
  answeredCount: 2,
  correctCount: 1,
  gradedCount: 1,
  elapsedSeconds: 60,
  cursor: 1,
  timerEnabled: false,
  answers: { 'ap:source-slug:q001': 0, 'ap:source-slug:q002': 'My response.' }
}
```

来源 ID、revision、contentMode 必须全部匹配才可恢复草稿或复盘，答案也需符合对应题型。题库更新、移除、旧记录损坏时，不把旧答案套到新题目，不自动重判旧成绩；可保留并下载旧作答。未保存题目原文快照。

最多保留 100 份完成记录、30 份草稿、2000 个错题条目，按更新时间从新到旧保留。当前为本机浏览器存储，没有账号隔离或云端同步。多标签页同一草稿不提供合并编辑：侦测到其他标签页写入 AP 键会提示备份。存储拒绝/配额不足时使用当前页内存保留作答，明确警告未持久化、提供文本下载、退出前触发浏览器确认；不能声称刷新后仍会保留内存记录。

## 验证范围

`tests/ap-model.test.cjs` 用 Node 内置测试覆盖浏览器/CJS 导出、v2 校验、原创示例、文档-only 计数、安全 PDF 路径、目录筛选、字数、MCQ 判分边界、FRQ 不评分、source/revision 恢复隔离、历史格式、错题更新、命名空间隔离、损坏数据与存储失败。

真实浏览器端到端由集成任务检查；本模块模型测试不等同于跨浏览器、真实多人账号或部署验证。真实题库内容与个人作答不能作为提交的测试夹具。
