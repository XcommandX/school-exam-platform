# SAT 目录时间线日期

2026-10-23：Start Practice 的 Full-Length Tests 分类按标题中的考试年月匹配以下官方开考日期。日期与来源由用户核实后提供，本轮直接使用该表，未打开真实题包、目录索引或转换报告，也未请求真实题库接口。

日期表独立保存在 `front-end/sat/js/library.js` 的 `officialSchedule` 中，每条周末日期保存 `month`、`date`、`precision: 'day'`、`source: 'official-schedule'` 和 `sourceUrl`。目录中的计算结果保存在元数据 `examDate`；该信息不进入题干、答案或考试计时配置。

| 标题年月 | 时间线日期 | 来源 |
| --- | --- | --- |
| 2023-03 | 2023-03-11 | A |
| 2023-05 | 2023-05-06 | A |
| 2023-06 | 2023-06-03 | A |
| 2023-10 | 2023-10-07 | B |
| 2023-11 | 2023-11-04 | B |
| 2023-12 | 2023-12-02 | B |
| 2024-03 | 2024-03-09 | B |
| 2024-04 School Day | Apr. 2024，仅月精度 | B、C |
| 2024-05 | 2024-05-04 | B |
| 2024-06 | 2024-06-01 | B |
| 2025-03 | 2025-03-08 | D |
| 2025-08 | 2025-08-23 | E |
| 2025-10 | 2025-10-04 | E |
| 2025-11 | 2025-11-08 | E |
| 2025-12 | 2025-12-06 | E |
| 2026-03 | 2026-03-14 | E |
| 2026-05 | 2026-05-02 | E |
| 2026-08 | 2026-08-22 | F |

来源链接：

- A：[Digital SAT: What Higher Ed Needs to Know](https://highered.collegeboard.org/media/pdf/digital-sat-what-higher-ed-needs-to-know-accessibility-final.pdf)
- B：[2023–24 AP / SAT Dates](https://counselors.collegeboard.org/media/pdf/23-24_AP_SAT_Dates.pdf)
- C：[Digital SAT Launches Across the Country](https://newsroom.collegeboard.org/digital-sat-launches-across-country-completing-transition-digital-and-providing-simpler-testing)
- D：[2024 Annual International School Webinar](https://international.collegeboard.org/media/pdf/2024%20Sep_Annual%20Intl%20School%20Webinar_Final%20for%20Sharing.pdf)
- E：[Comparing SAT Weekend and SAT School Day](https://satsuite.collegeboard.org/k12-educators/educator-experience/comparing-sat-weekend-school-day)
- F：[August 22, 2026 SAT Test Date](https://satsuite.collegeboard.org/dates/august-22-2026-sat-test-date)

该表只能证明某年月对应的常规开考日，不能证明本机题集的官方身份、A/B 卷或地区标签，也不能证明题目、答案和解析已经核定。标题年月匹配不会调整题号、模块或题目顺序。

School Day 只使用已提供的 Apr. 2024 月份窗口，不补成 4 月某一天；其他未核实 School Day 标题进入 Undated Tests。Bluebook、难题拼卷和零散汇总即使标题带年月也进入 Undated Tests。原创合成或模拟来源归入 Practice Tests；无日期来源归入 Undated Tests。不在日期表内的普通来源保留标题本身提供的日或月精度，`source` 为 `source-title`，不会补成未经核实的官方日期。

Full-Length Tests 是来源分类；只有服务元数据的 `fullSAT: true` 表示具备标准完整四模块。其他来源卡片显示 Partial Test，保留实际题量和模块数，并按来源模块练习，不补齐或重编号。目录渲染只使用元数据；点击开始才加载所选题集。已有完成记录显示 Open Review / Restart Exam；可恢复的未完成记录增加 Resume Exam，判断沿用 `status: 'incomplete'` 与 `resumable`，兼容旧记录结构。

原创合成测试：

```sh
node back-end/tests/sat-library.test.cjs
```

该检查使用内存合成目录逐一验证 17 个日级日期、Apr. 2024 月级窗口、来源 URL、特殊来源无日期归组、按需加载、恢复按钮和管理样式作用域，不访问真实题库。

时间线的月份统一采用带句点的三字母英文缩写，如 `Nov. 4, 2023`；只有月精度时为 `Apr. 2024`。日与年保留，日期单行显示，不改变排序或日期来源。
