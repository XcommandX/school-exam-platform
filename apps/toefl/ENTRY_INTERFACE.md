# 托福页面入口约定 v1

公共入口可根据下表生成托福链接。当前实现只约定页面导航，不提供统一登录或跨科账号映射；托福页面继续使用现有登录和账号隔离机制。不得通过链接传递用户名、密码、用户 ID、令牌或作答数据。

本轮只读参考了 `main` 的 `6e940a3` 版本首页及样式，没有修改或合并 `main`、SAT 或公共身份服务。

## 链接格式

模块地址由部署配置提供，示例中的域名不是正式部署地址：

```text
https://practice.example.test/toefl/?view=home
/toefl/?view=practice&section=reading
/toefl/?view=mock&section=speaking
```

| `view` | 托福页面 | `section` 的作用 |
| --- | --- | --- |
| `home`（默认） | 托福主页 | 忽略 |
| `practice` | 专项训练 | 选择科目，默认该科 T1 |
| `mock` | 模拟考试组卷 | 选择科目；省略时为全科 |
| `plan` | 今日学习 | 筛选学习科目 |
| `wrongBook` | 错题本 | 筛选科目；仍保留“曾答错／不熟悉”分类 |
| `report`、`history` | 考试记录 | 筛选考试科目，不直接打开某份私人成绩 |
| `progress` | 学习进度 | 忽略 |
| `vocab` | 词汇训练 | 忽略 |

`section` 仅接受 `reading`、`listening`、`speaking`、`writing`。没有 `view`、只有合法 `section` 时进入该科专项训练。非法页面参数不打开考试、私人记录或外部地址，回到主页。`view` 区分大小写，错题本使用 `wrongBook`。

链接只选择入口，不会自动开始计时、录音、评分或提交作答。进入模拟考试后仍需组卷并确认开始。

## 公共入口生成链接

```js
import { buildToeflEntryUrl } from './src/integration/entry-links.mjs';

const practice = buildToeflEntryUrl('/toefl/', {
  view: 'practice',
  section: 'listening',
});
const fullMock = buildToeflEntryUrl('https://practice.example.test/toefl/', {
  view: 'mock',
});
```

`baseUrl` 必须来自受信部署配置，接受明确的 `http://`、`https://` 绝对地址，或以单个 `/` 开头的同源根路径；保留该地址的模块路径。不得将任意用户输入用作 `baseUrl`。生成器拒绝凭据、协议相对地址、非 HTTP(S) 协议、反斜杠和控制字符，只接受 `view`、`section` 两项配置。原地址已有的查询参数和片段会被清除，只生成上述两个已知参数；不支持任意 `returnUrl` 或重定向。

## 恢复与返回

- 当前账号已有合法浏览器历史状态时，优先恢复该状态；入口 URL 不覆盖正在恢复的页面。
- 其他账号的历史状态不得恢复到当前账号。URL 参数不改变账号、权限或本地数据命名空间。
- 答题、解析等子页面的“返回”回到进入时的练习入口，保留筛选和草稿保存保护；主页按钮始终回主页。
- 非子页面的“返回”回到主页。切换前如录音未能可靠保存，则保留当前作答，不强行跳转。

## 检查范围

```sh
node tests/integration/test-entry-links.mjs
node tests/frontend/test-entry-navigation.cjs
```

检查覆盖链接生成和参数边界、URL 页面映射、当前账号历史状态优先、返回入口及录音保存失败保护。测试使用匿名替身状态，不连接正式账号，也不证明跨域统一登录已经完成。
