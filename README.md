# SecAgent Markdown 手写 SVG 插件

模型可以调用 `markdown-handdrawn__render`，将 Markdown 渲染成带中文手写字体、KaTeX 数学公式、GFM 表格和 Rough.js 手绘线条的 SVG 文件。插件会将文件保存到当前 SecAgent 工作区的 `exports/handdrawn-markdown/`；默认打开独立预览窗口，插入 ICC-CE 时可传 `preview: false` 只保存并插入而不弹窗。

Markdown 中的 Mermaid fenced code（如 `flowchart`、`sequenceDiagram`、`classDiagram` 和 `pie`）会被 Mermaid 渲染为 SVG，并套用手写抖动效果；插入 CE 时图表作为一个独立可移动、缩放和删除的图表项保存。

## 构建

```bash
npm install
npm run build
```

产物为 `dist/markdown-handdrawn-1.0.1.zip`，可在 SecAgent 设置的插件页面安装。

插件会嵌入 `assets/PingFangSanShengTi-2.ttf`。该字体文件需要由插件发布者确认拥有再分发权限。

SVG 使用 `foreignObject` 保留中文、表格和公式的浏览器排版，推荐使用 SecAgent 的 Electron 预览窗口查看。
