# SAT 考试用户名

2026-10-24 用户授权：原考试页左下的 `Student` 改为当前登录账号的用户名；英语到数学的倒计时休息页及 `Resume Testing Now` 等待页也在左下显示同一用户名。

- `SATSession.getStudentName()` 每次读取共同账号客户端的 `PlatformAuth.user.username`，兼容缺少用户名时的 `displayName`、`name`。未接账号的独立 SAT 仍使用原匿名姓名。
- 答题页与 Check Your Work 共用考试页脚。两个休息页面使用相同左下定位；长姓名省略显示，完整内容保留在悬停提示里。窄屏休息页为姓名预留底部空间。
- `platform:user` 更新时仅替换姓名文本，不重建页面或重置计时。名字通过文本节点或转义模板输出，不写入练习记录、题库或运行快照。
- 此修改不改变学生角色、题型 `student-produced-response` 或休息规则中的一般性 `students` 文案。

验证命令（浏览器检查需要已有 Playwright 和 Chrome）：

```sh
node --test back-end/tests/sat-session.test.cjs
node back-end/tests/sat-username.browser.cjs
```

账号系统由统一平台提供；这个功能只消费已有用户信息，不创建账号、数据库或登录会话。
