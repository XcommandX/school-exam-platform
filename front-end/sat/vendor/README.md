# SAT 离线正文渲染依赖

新增 SAT 题目包使用下列固定版本的浏览器发行文件。运行时不联网、不安装 npm 包、不执行第三方包脚本。旧 SAT 纯文本渲染不依赖这些文件。

| 项目 | 版本 | 来源 | 许可 |
| --- | --- | --- | --- |
| Marked | 18.1.1 | `https://registry.npmjs.org/marked/-/marked-18.1.1.tgz` | MIT，见 `marked/LICENSE` |
| DOMPurify | 3.4.17 | `https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz` | Apache-2.0 或 MPL-2.0，见 `dompurify/LICENSE` 与 `dompurify/LICENSE-MPL` |
| KaTeX | 0.19.0 | `https://registry.npmjs.org/katex/-/katex-0.19.0.tgz` | MIT，见 `katex/LICENSE` |

2026-10-23 从 npm registry HTTPS 下载，逐份验证发行元数据的 SHA512 `integrity` 后提取。`*-metadata.json` 保存准确来源与校验值。未修改第三方发行代码。KaTeX CSS 引用的全部 60 份 `.woff2`、`.woff`、`.ttf` 字体均包含在 `katex/fonts/`，不通过网络加载字体；仓库无需构建步骤。

加载顺序：

```html
<link rel="stylesheet" href="../vendor/katex/katex.min.css">
<link rel="stylesheet" href="../css/content-renderer.css">
<script defer src="../vendor/marked/marked.umd.js"></script>
<script defer src="../vendor/dompurify/purify.min.js"></script>
<script defer src="../vendor/katex/katex.min.js"></script>
<script defer src="../js/content-renderer.js"></script>
```

新渲染器不接受 Markdown 图片，只接受显式 `image` 内容块及已验证的本地资源映射。资源支持本地路径、同源 URL、blob，或由 SATPack 完成 MIME/文件签名/摘要/静态 SVG 检查后生成的持久 `data:image/...;base64`（png、jpeg、gif、webp、svg+xml），不接受块自己提供的 URL。Markdown 原始 HTML 仅接受无属性的 `<u>`、`</u>`；LaTeX 禁外部资源与自定义宏，并启用 `trust:false`、严格解析和展开上限。最终 Markdown/数学 HTML 再经 DOMPurify 净化。普通链接仅接受 `http://`、`https://`、`mailto:` 或页内锚点，不自动加载目标。

`SATContent.render(container, blocks, {assets, imageFactory, annotations, styleAnnotation})` 按块顺序渲染，返回 `{text, container}`。`assets` 是对象或 Map，条目为 `{src}`；`imageFactory` 收到 `{...block, src}`，返回本地图片查看器的 DOM 元素。未提供工厂时生成普通 `<img>`。

`annotations` 采用专用正文的 UTF-16 起止位置；`styleAnnotation(mark, layers)` 可使用原高亮样式方法。高亮保持 Markdown 元素及原有 `<u>` 结构，不拆开公式、代码或图片控件。`SATContent.annotationText(container)` 和 `render(...).text` 返回可标记正文；公式、代码与整个图片查看器子树均不计入偏移，因此缩放百分比等控件文字变化不会移动 Notes。`SATContent.textIndex(container)` 返回对应文本节点和稳定偏移；`SATContent.selectionOffset(container, node, offset)`（别名 `textOffset`）把 DOM 选区端点转成相同偏移，不能对新题包继续使用原始 `Range.toString().length`。横跨公式的选区只标记其前后正文，单独选公式不会产生正文范围。`SATContent.plainText(blocks)` 用于摘要，公式返回 LaTeX 源，因此不能把摘要位置误用为高亮位置。

验证（需要本机已有 Node.js、Playwright 和 Chrome；不安装额外依赖）：

```sh
node --test back-end/tests/sat-content.test.cjs
```

升级依赖时须重查当前版本、发行摘要、全部许可和 CSS 字体引用，再运行安全及离线渲染回归。简单 Markdown pipe 表格作为 Markdown 语法显示，不代表复杂表格、数据图或坐标模型协议已定案。
