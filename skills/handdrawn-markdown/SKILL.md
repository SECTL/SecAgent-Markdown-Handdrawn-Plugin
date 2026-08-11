---
name: handdrawn-markdown
description: 将 Markdown 内容渲染为带中文手写字体、手绘表格线和数学公式的 SVG 文件并打开预览。
---

# Markdown 手写 SVG

## 工具

`markdown-handdrawn__render`：将 Markdown 渲染为 SVG 文件；默认弹出独立预览窗口，也可只导出并插入画板。

参数：

- `markdown`：必填，完整 Markdown 字符串。
- `title`：可选，预览窗口标题。
- `fileName`：可选，输出文件名；只能是文件名，不能包含目录。
- `width`：可选，SVG 宽度，默认 1200，范围 640-2400。
- `transparent`：可选，是否使用透明背景，默认 `false`。
- `frame`：可选，是否显示外层手绘纸张边框，默认 `true`；插入其它画板时可设为 `false`。
- `tableBorders`：可选，是否显示表格手绘网格，默认 `true`；设为 `false` 可隐藏表格边框。
- `preview`：可选，是否打开独立预览窗口，默认 `true`；插入画板时设为 `false` 可避免弹窗。
- `insertToIccce`：可选，设为 `true` 时会在保存后，将 SVG 直接插入当前运行中的 ICC-CE 白板；是否预览由 `preview` 控制。

工具返回保存后的绝对路径、工作区相对路径、文件字节数和 `previewOpened` 状态。设置 `preview: false` 时仍会保存 SVG，但不会创建预览窗口。

支持标题、段落、列表、引用、代码块、GFM 表格、分隔线、行内公式、块级公式和 Mermaid 代码块（例如 `flowchart`、`sequenceDiagram`、`classDiagram`、`pie`）。普通代码块中的公式标记不会被转换。

生成的 SVG 同时嵌入 `editableScene` 元数据。ICC-CE 连接插件会优先把它拆为独立的文字行、表格线、分隔线和基础形状；因此可以逐行选中、移动、缩放，面积橡皮擦会删除被擦到的独立元素。预览文件仍保留完整 HTML、KaTeX、CSS 和 Rough.js 效果。
## Editable path scene

The SVG contains an `editableScene` metadata payload for ICC-CE insertion.

- The preview keeps the complete HTML, KaTeX, CSS and Rough.js rendering.
- The editable scene contains no editable text nodes. Text is converted to glyph-outline SVG paths using the bundled handwriting font.
- One rendered source line is one `path` scene element. All glyph outlines in that line are combined into the same path, so the line is selected, moved and deleted as one item.
- Each divider, table border segment and shape is also an independent path or shape element.
- Mermaid fences are rendered by Mermaid and wrapped with a hand-drawn displacement filter; in CE they are kept as one independently movable diagram item because Mermaid may use advanced SVG features.
- `insertToIccce: true` sends this scene to the CE connector; the CE plugin creates WPF Path elements instead of a browser/WebView SVG surface.
- KaTeX preview remains the visually authoritative formula rendering. For CE insertion, inline and block formulas use a structured path layout for superscripts, subscripts, fractions, roots and common symbols; the complete formula is still one selectable path item. Unsupported TeX falls back to glyph outlines instead of leaving literal `^`, `_` or source markup on the canvas.

## Background and sizing

- For whiteboard insertion, prefer `transparent: true` and `frame: false`; this avoids baking a white rectangle into a board with another background.
- When the board is dark or the background is known, pass matching `textColor` and `lineColor` (for example `#f5f1e8` and `#e0d8ca`). `backgroundColor` only applies when `transparent` is false.
- If the board background is unknown and contrast matters, first obtain a CE whiteboard screenshot, infer whether the canvas is light or dark, then render with an explicit text/line color. Do not make the renderer guess from Markdown.
- The SVG height is based on the generated scene layout, not the old source-length estimate, so short documents do not receive a large blank tail.
- Block formulas delimited by `$$...$$` or `\[...\]` are converted into one formula path for CE insertion. The preview continues to use KaTeX layout.
