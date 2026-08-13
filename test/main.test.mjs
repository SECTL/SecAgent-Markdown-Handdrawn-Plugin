import assert from "node:assert/strict";
import test from "node:test";
import { activate, renderSvg } from "../dist/main.mjs";

test("renders hand-drawn SVG with Markdown, table and math", async () => {
  const svg = await renderSvg("# 标题\n\n| 名称 | 值 |\n| --- | --- |\n| x | $x^2$ |\n\n$$\\int_0^1 x dx$$", { width: 900 });
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /<foreignObject\b/);
  assert.match(svg, /handdrawn-jitter/);
  assert.match(svg, /<path\b/);
  assert.match(svg, /class="katex/);
  assert.match(svg, /data:font\/ttf;base64/);
  assert.match(svg, /<table\b/);
  assert.match(svg, /rough-table-lines/);
  assert.match(svg, /rough-inline-line/);
  const headingLinePath = svg.match(/class="rough-inline-line"[\s\S]*?<path d="([^"]+)"/)?.[1] || "";
  assert.match(headingLinePath, /C/);
  const sceneBase64 = svg.match(/<metadata id="secagent-editable-scene" data-encoding="base64">([^<]+)<\/metadata>/)?.[1];
  const scene = JSON.parse(Buffer.from(sceneBase64, "base64").toString("utf8"));
  assert.equal(scene.version, 1);
  assert.ok(scene.elements.some((element) => element.kind === "path" && element.role === "heading"));
  assert.ok(scene.elements.some((element) => element.kind === "path" && element.role === "line"));
  assert.equal(scene.elements.some((element) => element.kind === "text"), false);
});

test("does not interpret math-like text in fenced code as a formula", async () => {
  const svg = await renderSvg("~~~js\nconst value = '$not-math$';\n~~~");
  assert.match(svg, /not-math/);
  assert.equal((svg.match(/class="katex/g) || []).length, 0);
});

test("drops raw HTML and prevents unsafe link schemes", async () => {
  const svg = await renderSvg("<script>alert('xss')</script>\n\n[bad](javascript:alert(1))");
  assert.equal(svg.includes("alert('xss')"), false);
  assert.equal(svg.includes("javascript:alert"), false);
});

test("serializes HTML void elements as XML-compatible XHTML", async () => {
  const svg = await renderSvg("第一行  \n第二行\n\n---\n\n第三行");
  assert.doesNotMatch(svg, /<(?:br|hr)(?!\s*\/>)[^>]*>/i);
  assert.match(svg, /<br\s*\/>/i);
  assert.match(svg, /rough-inline-line/);
});

test("supports transparent, borderless and border-free table output", async () => {
  const svg = await renderSvg("# title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", {
    transparent: true,
    frame: false,
    tableBorders: false
  });
  assert.match(svg, /<rect width="100%" height="100%" fill="none"\/>/);
  assert.match(svg, /<g class="rough-overlay"[^>]*><\/g>/);
  assert.doesNotMatch(svg, /<svg[^>]*class="rough-table-lines"/);
  assert.match(svg, /<table\b/);
});

test("reports invalid KaTeX syntax to the caller", async () => {
  await assert.rejects(() => renderSvg("公式：$\\thisMacroDoesNotExist$"), /数学公式解析失败/);
});

test("renders Mermaid fences as hand-drawn diagram SVG and editable scene items", async () => {
  const svg = await renderSvg("# 流程\n\n```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```", { frame: false, transparent: true });
  assert.match(svg, /class="mermaid-block"/);
  assert.match(svg, /secagent-mermaid/);
  assert.match(svg, /feDisplacementMap/);
  const sceneBase64 = svg.match(/<metadata id="secagent-editable-scene" data-encoding="base64">([^<]+)<\/metadata>/)?.[1];
  const scene = JSON.parse(Buffer.from(sceneBase64, "base64").toString("utf8"));
  assert.ok(scene.elements.some((element) => element.kind === "svg" && element.role === "mermaid"));
});

test("normalizes string tool flags and inserts without opening preview", async () => {
  let toolHandler;
  let previewRequest;
  let insertRequest;
  const api = {
    registerSkill() {},
    unregisterSkill() {},
    registerTool(_definition, handler) { toolHandler = handler; },
    unregisterTool() {},
    setStatus() {},
    async openSvgPreview(input) {
      previewRequest = input;
      return { path: "test.svg", relativePath: "test.svg", bytes: input.svg.length, previewOpened: false };
    },
    async fetch(_url, input) {
      insertRequest = input;
      return { ok: true, status: 200, async json() { return { ok: true, result: { inserted: true } }; } };
    }
  };
  await activate(api);
  const result = await toolHandler({
    markdown: "# title",
    width: "1000",
    transparent: "true",
    frame: "false",
    tableBorders: "false",
    preview: "false",
    insertToIccce: "true"
  });
  assert.equal(previewRequest.openPreview, false);
  assert.equal(insertRequest !== undefined, true);
  assert.equal(JSON.parse(insertRequest.body).width, 1000);
  assert.equal(result.iccce.inserted, true);
});
