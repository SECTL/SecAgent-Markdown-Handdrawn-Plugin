import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import katex from "katex";
import rough from "roughjs";
import opentype from "opentype.js";
import { parseHTML } from "linkedom";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const fontPath = path.join(pluginRoot, "assets", "PingFangSanShengTi-2.ttf");
const katexCssPath = path.join(pluginRoot, "assets", "katex-inline.css");
const mathFontPath = fs.existsSync(path.join(pluginRoot, "assets", "KaTeX_Main-Regular.ttf"))
  ? path.join(pluginRoot, "assets", "KaTeX_Main-Regular.ttf")
  : path.join(pluginRoot, "..", "node_modules", "katex", "dist", "fonts", "KaTeX_Main-Regular.ttf");
const mathItalicFontPath = fs.existsSync(path.join(pluginRoot, "assets", "KaTeX_Math-Italic.ttf"))
  ? path.join(pluginRoot, "assets", "KaTeX_Math-Italic.ttf")
  : path.join(pluginRoot, "..", "node_modules", "katex", "dist", "fonts", "KaTeX_Math-Italic.ttf");
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const DEFAULT_WIDTH = 1200;
const fontBuffer = fs.readFileSync(fontPath);
const handwritingFont = opentype.parse(fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength));
function parseOptionalFont(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
const mathFont = parseOptionalFont(mathFontPath);
const mathItalicFont = parseOptionalFont(mathItalicFontPath) || mathFont;
let mermaidPromise;

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", "\"": "&quot;" }[character]));
}

function normalizeColor(value, fallback) {
  const candidate = String(value ?? "").trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(candidate)) return candidate;
  if (/^rgba?\(\s*[\d.]+%?(?:\s*,\s*[\d.]+%?){2,3}\s*\)$/i.test(candidate)) return candidate;
  return fallback;
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) || 1;
}

function protectCode(source, protectedParts) {
  return source.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g, (value) => value.replace(/\\\[|\\\]|\\\(|\\\)|\$/g, (delimiter) => {
    const token = `@@SECAGENT_LITERAL_${protectedParts.length}@@`;
    protectedParts.push({ token, value: delimiter });
    return token;
  }));
}

function extractMermaidBlocks(source) {
  const blocks = [];
  const masked = String(source).replace(/(?:```|~~~)\s*(?:mermaid|mmd)\s*\r?\n([\s\S]*?)(?:```|~~~)/gi, (_match, chart) => {
    const token = `@@SECAGENT_MERMAID_${blocks.length}@@`;
    blocks.push({ token, chart: chart.trim() });
    return `\n\n${token}\n\n`;
  });
  return { masked, blocks };
}

function installMermaidDom() {
  if (globalThis.document && globalThis.SVGElement?.prototype?.getBBox) return;
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  for (const name of ["window", "document", "Element", "HTMLElement", "SVGElement", "DOMParser", "XMLSerializer", "Node"]) {
    globalThis[name] = window[name];
  }
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  if (!globalThis.CSSStyleSheet) {
    globalThis.CSSStyleSheet = class {
      constructor() { this.cssRules = []; }
      replaceSync() {}
      insertRule() {}
    };
  }
  if (!window.document.adoptedStyleSheets) {
    Object.defineProperty(window.document, "adoptedStyleSheets", { value: [], writable: true });
  }
  window.SVGElement.prototype.getBBox = function () {
    const text = this.textContent || "";
    return { x: 0, y: 0, width: Math.max(1, text.length * 12), height: 24 };
  };
  window.SVGElement.prototype.getComputedTextLength = function () {
    return Math.max(1, (this.textContent || "").length * 12);
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24 });
}

async function getMermaid() {
  if (!mermaidPromise) {
    installMermaidDom();
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function handDrawMermaidSvg(svg, seed) {
  const filterId = `mermaid-jitter-${hashSeed(seed)}`;
  const filter = `<defs><filter id="${filterId}" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="${hashSeed(seed)}" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
  const withFilter = String(svg).replace(/<svg\b([^>]*)>/i, (_match, attributes) => `<svg${attributes} class="secagent-mermaid" role="img">${filter}`);
  return withFilter.replace(/<(path|line|polyline|polygon|rect|circle|ellipse)\b([^>]*?)(\/?>)/gi, (match, tag, attributes, end) => {
    if (/\bfilter\s*=/.test(attributes)) return match;
    return `<${tag}${attributes} filter="url(#${filterId})" stroke-linecap="round" stroke-linejoin="round"${end}`;
  });
}

function readSvgViewBox(svg) {
  const match = String(svg).match(/<svg\b[^>]*\b(?:viewBox|viewbox)\s*=\s*["']\s*[-+\d.]+\s+[-+\d.]+\s+([-+\d.]+)\s+([-+\d.]+)\s*["']/i);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : { width: 800, height: 500 };
}

async function renderMermaidBlock(chart, seed, index) {
  try {
    const mermaid = await getMermaid();
    const result = await mermaid.render(`secagent-mermaid-${hashSeed(`${seed}:${index}`)}`, chart);
    const svg = handDrawMermaidSvg(result.svg, `${seed}:${index}`);
    const size = readSvgViewBox(svg);
    return { chart, svg, ...size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Mermaid 图表解析失败：${message}`);
  }
}

function extractMath(source) {
  const protectedParts = [];
  let masked = protectCode(source, protectedParts);
  const mathParts = [];
  const addMath = (tex, displayMode) => {
    const token = `@@SECAGENT_MATH_${mathParts.length}@@`;
    mathParts.push({ token, tex, displayMode });
    return token;
  };
  masked = masked.replace(/\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g, (_match, bracketTex, dollarTex) => addMath(bracketTex ?? dollarTex, true));
  masked = masked.replace(/\\\(([^\n]+?)\\\)|(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_match, parenthesisTex, dollarTex) => addMath(parenthesisTex ?? dollarTex, false));
  for (const part of protectedParts) masked = masked.replaceAll(part.token, part.value);
  return { masked, mathParts };
}

async function renderMarkdownHtml(markdown, seed) {
  const { masked: mermaidMasked, blocks: mermaidBlocks } = extractMermaidBlocks(markdown);
  const { masked, mathParts } = extractMath(mermaidMasked);
  const renderer = new marked.Renderer();
  renderer.html = () => "";
  renderer.image = ({ text }) => `<span>${escapeXml(text || "图片")}</span>`;
  renderer.link = ({ href, title, text }) => {
    const safeHref = /^(?:https?:|mailto:)/i.test(String(href || "")) ? String(href) : "#";
    const titleAttribute = title ? ` title="${escapeXml(title)}"` : "";
    return `<a href="${escapeXml(safeHref)}"${titleAttribute} rel="noreferrer">${text}</a>`;
  };
  let html = marked.parse(masked, { gfm: true, breaks: true, renderer });
  html = mathParts.reduce((current, part) => {
    try {
      const rendered = katex.renderToString(part.tex.trim(), { displayMode: part.displayMode, throwOnError: true, strict: "ignore", output: "htmlAndMathml" });
      return current.replaceAll(part.token, rendered);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`数学公式解析失败：${part.tex.trim().slice(0, 120)}（${message}）`);
    }
  }, html);
  const mermaidArtifacts = [];
  for (let index = 0; index < mermaidBlocks.length; index += 1) {
    const block = mermaidBlocks[index];
    const artifact = await renderMermaidBlock(block.chart, seed, index);
    mermaidArtifacts.push(artifact);
    html = html.replaceAll(block.token, `<div class="mermaid-block">${artifact.svg}</div>`);
  }
  return { html, mermaidArtifacts };
}

function toXmlCompatibleXhtml(html) {
  return html.replace(/<(br|hr)(\s[^<>]*?)?>/gi, (_match, tag, attributes = "") => `<${tag}${attributes} />`);
}

function plainText(value) {
  return String(value).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim();
}

function inlineRoughLine(seed, stroke = "#3d3730") {
  const options = { roughness: 1.25, bowing: 1.35, maxRandomnessOffset: 2.2, stroke, strokeWidth: 1.7, seed, disableMultiStroke: true };
  const generator = rough.generator({ options });
  const path = roughPath(generator, generator.line(0, 4, 1000, 4, options));
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"rough-inline-line\" viewBox=\"0 0 1000 8\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" + path + "</svg>";
}

function decorateTableHtml(tableHtml, seed, showTableBorders) {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  if (!rows.length) return tableHtml;
  const cellsByRow = rows.map((row) => [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((match) => plainText(match[1])));
  const columnCount = Math.max(...cellsByRow.map((row) => row.length));
  const preferredWidths = Array.from({ length: columnCount }, (_, column) => Math.max(90, ...cellsByRow.map((row) => Math.min(320, 42 + displayLength(row[column] || "") * 11))));
  const preferredTotal = preferredWidths.reduce((sum, value) => sum + value, 0);
  const widths = preferredWidths.map((value) => (value / preferredTotal * 100).toFixed(4) + "%");
  const rowHeights = cellsByRow.map((row) => Math.max(40, ...row.map((cell, column) => Math.ceil(Math.max(1, displayLength(cell)) * 11 / (preferredWidths[column] / preferredTotal * 1000)) * 31 + 16)));
  const totalHeight = rowHeights.reduce((sum, value) => sum + value, 0);
  const colgroup = "<colgroup>" + widths.map((width) => "<col style=\"width:" + width + "\" />").join("") + "</colgroup>";
  let rowIndex = 0;
  const decoratedRows = tableHtml.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (row) => {
    const rowHeight = rowHeights[rowIndex] || 40;
    rowIndex += 1;
    const withHeight = row.replace(/<tr\b([^>]*)>/i, "<tr$1 style=\"height:" + rowHeight + "px\">");
    return withHeight.replace(/<(th|td)\b([^>]*)>/gi, "<$1$2 style=\"height:" + rowHeight + "px\">");
  });
  const tableWithLayout = decoratedRows.replace(/<table\b([^>]*)>/i, "<table$1 style=\"table-layout:fixed;width:100%;height:" + totalHeight + "px\">" + colgroup);
  if (!showTableBorders) return "<div class=\"rough-table-wrap\" style=\"height:" + totalHeight + "px\">" + tableWithLayout + "</div>";
  const generator = rough.generator({ options: { roughness: 0.85, bowing: 0.9, stroke: "#4c463f", strokeWidth: 1.45, seed, disableMultiStroke: true } });
  const xPositions = [0];
  for (const width of preferredWidths) xPositions.push(xPositions.at(-1) + width / preferredTotal * 1000);
  const yPositions = [0];
  for (const rowHeight of rowHeights) yPositions.push(yPositions.at(-1) + rowHeight);
  const paths = [];
  const options = { roughness: 0.85, bowing: 0.9, stroke: "#4c463f", strokeWidth: 1.45, disableMultiStroke: true };
  for (const yPosition of yPositions) paths.push(roughPath(generator, generator.line(0, yPosition, 1000, yPosition, options)));
  for (const xPosition of xPositions) paths.push(roughPath(generator, generator.line(xPosition, 0, xPosition, totalHeight, options)));
  const overlay = "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"rough-table-lines\" viewBox=\"0 0 1000 " + totalHeight + "\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" + paths.join("") + "</svg>";
  return "<div class=\"rough-table-wrap\" style=\"height:" + totalHeight + "px\">" + tableWithLayout + overlay + "</div>";
}

function decorateHtml(html, seed, showTableBorders) {
  let headingIndex = 0;
  let decorated = html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (_match, attributes, content) => {
    headingIndex += 1;
    return "<h1" + attributes + ">" + content + inlineRoughLine(seed + headingIndex) + "</h1>";
  });
  let dividerIndex = 0;
  decorated = decorated.replace(/<hr\s*\/>/gi, () => {
    dividerIndex += 1;
    return inlineRoughLine(seed + 1000 + dividerIndex, "#5d554b");
  });
  let tableIndex = 0;
  return decorated.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    tableIndex += 1;
    return decorateTableHtml(table, seed + 2000 + tableIndex, showTableBorders);
  });
}

function estimateHeight(markdown, html) {
  const sourceLines = markdown.split(/\r?\n/).length;
  const blocks = (html.match(/<(?:h[1-6]|p|li|blockquote|pre|table|hr)\b/g) || []).length;
  const tables = (html.match(/<tr\b/g) || []).length;
  return Math.min(14000, Math.max(420, 180 + sourceLines * 26 + blocks * 26 + tables * 18 + Math.ceil(html.length / 120) * 10));
}

function roughPath(generator, drawable) {
  return generator.toPaths(drawable).map((item) => "<path d=\"" + escapeXml(item.d) + "\" fill=\"" + escapeXml(item.fill || "none") + "\" stroke=\"" + escapeXml(item.stroke) + "\" stroke-width=\"" + item.strokeWidth + "\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>").join("");
}

function roughPathData(generator, drawable) {
  return generator.toPaths(drawable).map((item) => item.d).join(" ");
}

function splitPipeRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function displayLength(value) {
  return String(value).replace(/\x60[^\x60]*\x60/g, "code").replace(/[*_~]/g, "").length;
}

function drawRoughTable(generator, x, y, tableWidth, rows) {
  if (!rows.length) return { paths: "", height: 0 };
  const columnCount = Math.max(...rows.map((row) => row.length));
  const preferredWidths = Array.from({ length: columnCount }, (_, column) => Math.max(90, ...rows.map((row) => Math.min(320, 42 + displayLength(row[column] || "") * 11))));
  const preferredTotal = preferredWidths.reduce((sum, value) => sum + value, 0);
  const scale = tableWidth / preferredTotal;
  const columnWidths = preferredWidths.map((value) => value * scale);
  const xPositions = [x];
  for (const columnWidth of columnWidths) xPositions.push(xPositions.at(-1) + columnWidth);
  const rowHeights = rows.map((row) => Math.max(40, ...row.map((cell, column) => Math.ceil(Math.max(1, displayLength(cell)) * 11 / columnWidths[column]) * 31 + 16)));
  const yPositions = [y];
  for (const rowHeight of rowHeights) yPositions.push(yPositions.at(-1) + rowHeight);
  const options = { roughness: 0.85, bowing: 0.9, stroke: "#4c463f", strokeWidth: 1.45, disableMultiStroke: true };
  const paths = [];
  for (const yPosition of yPositions) paths.push(roughPath(generator, generator.line(x, yPosition, x + tableWidth, yPosition, options)));
  for (const xPosition of xPositions) paths.push(roughPath(generator, generator.line(xPosition, y, xPosition, yPositions.at(-1), options)));
  return { paths: paths.join(""), height: yPositions.at(-1) - y };
}

function roughContentPaths(markdown, width, height, seed, showFrame = true) {
  if (!showFrame) return "";
  const generator = rough.generator({ options: { roughness: 0.95, bowing: 1.1, stroke: "#81776a", strokeWidth: 1.1, seed } });
  return roughPath(generator, generator.rectangle(26, 26, width - 52, height - 52, { roughness: 1.15, bowing: 1.6, stroke: "#81776a", strokeWidth: 1.1 }));
}

function roughPaths(markdown, width, height, seed, showFrame = true) {
  return roughContentPaths(markdown, width, height, seed, showFrame);
}

function sceneText(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\\\[|\\\]|\\\(|\\\)|\$\$/g, "")
    .replace(/(?<!\\)\$/g, "")
    .replace(/\\([\\$])/g, "$1")
    .trim();
}

function formulaText(value) {
  let text = sceneText(value)
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\\(times|cdot)/g, "×")
    .replace(/\\(pm)/g, "±")
    .replace(/\\(leq|le)/g, "≤")
    .replace(/\\(geq|ge)/g, "≥")
    .replace(/\\(rightarrow|to)/g, "→")
    .replace(/\\(alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega)/g, (_match, name) => ({ alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", omega: "ω" }[name] || name))
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "数学公式";
}

const mathCommandSymbols = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ",
  pi: "π", sigma: "σ", omega: "ω", phi: "φ", varphi: "ϕ", rho: "ρ", tau: "τ",
  epsilon: "ε", varepsilon: "ϵ", kappa: "κ", nu: "ν", xi: "ξ", zeta: "ζ", eta: "η",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Omega: "Ω",
  times: "×", cdot: "·", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥",
  neq: "≠", ne: "≠", approx: "≈", propto: "∝", to: "→", rightarrow: "→", leftarrow: "←",
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", forall: "∀",
  exists: "∃", in: "∈", notin: "∉", cup: "∪", cap: "∩", subset: "⊂", subseteq: "⊆",
  supset: "⊃", supseteq: "⊇", ell: "…"
};

function hasFontGlyph(font, value) {
  if (!font || !value) return false;
  const codePoint = [...String(value)][0]?.codePointAt(0);
  if (!codePoint) return false;
  const glyph = font.charToGlyph(String.fromCodePoint(codePoint));
  return glyph && glyph.index !== 0 && glyph.unicode === codePoint;
}

function mathFontForGlyph(value) {
  const character = [...String(value)][0] || "";
  const codePoint = character.codePointAt(0) || 0;
  const isMathSymbol = codePoint > 0x2000 || /[π∑∏∫√≤≥≠≈∞±×·→←∈∉∪∩]/u.test(character);
  if (isMathSymbol && hasFontGlyph(mathFont, character)) return mathFont;
  if (/[A-Za-z]/.test(character) && hasFontGlyph(mathItalicFont, character)) return mathItalicFont;
  return handwritingFont;
}

function glyphBox(text, size, font = null) {
  const value = String(text || "");
  if (!value) return emptyMathBox();
  const selectedFont = font || mathFontForGlyph(value);
  const safeFont = selectedFont || handwritingFont;
  const advance = safeFont.getAdvanceWidth(value, size, { kerning: true });
  const top = -size * 0.84;
  const bottom = size * 0.2;
  return {
    width: Math.max(size * 0.12, advance),
    top,
    bottom,
    draw: (x, baseline) => safeFont.getPath(value, x, baseline, size, { kerning: true }).toPathData(2)
  };
}

function emptyMathBox() {
  return { width: 0, top: 0, bottom: 0, draw: () => "" };
}

function spacerBox(width) {
  return { width, top: 0, bottom: 0, draw: () => "" };
}

function readMathArgument(source, start) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] === "{") {
    let depth = 1;
    const bodyStart = ++index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    return { value: source.slice(bodyStart, Math.max(bodyStart, index - 1)), next: index };
  }
  if (source[index] === "\\") {
    const command = source.slice(index).match(/^\\([A-Za-z]+|.)/);
    if (command) return { value: command[0], next: index + command[0].length };
  }
  return { value: source[index] || "", next: Math.min(source.length, index + 1) };
}

function mathCommandAtom(command, size) {
  const symbol = mathCommandSymbols[command];
  if (symbol) return glyphBox(symbol, size, mathFont && hasFontGlyph(mathFont, symbol) ? mathFont : null);
  if (command === "text" || command === "mathrm" || command === "mathbf" || command === "mathit" || command === "operatorname") return null;
  if (["left", "right", "big", "Big", "bigg", "Bigg"].includes(command)) return null;
  if ([",", ";", ":", "!", "quad", "qquad"].includes(command)) return spacerBox(command === "qquad" ? size * 1.1 : command === "quad" ? size * 0.55 : size * 0.2);
  return glyphBox(command, size);
}

function scriptMathBox(base, superscript, subscript, size) {
  if (!superscript && !subscript) return base;
  const scriptSize = size * 0.62;
  const sup = superscript ? layoutMathSequence(superscript, scriptSize) : null;
  const sub = subscript ? layoutMathSequence(subscript, scriptSize) : null;
  const scriptX = Math.max(base.width * 0.72, base.width + size * 0.02);
  const width = Math.max(base.width, scriptX + Math.max(sup?.width || 0, sub?.width || 0));
  const top = Math.min(base.top, sup ? sup.top - size * 0.56 : base.top);
  const bottom = Math.max(base.bottom, sub ? sub.bottom + size * 0.34 : base.bottom);
  return {
    width,
    top,
    bottom,
    draw: (x, baseline) => [
      base.draw(x, baseline),
      sup ? sup.draw(x + scriptX, baseline - size * 0.56) : "",
      sub ? sub.draw(x + scriptX, baseline + size * 0.34) : ""
    ].filter(Boolean).join(" ")
  };
}

function fractionBox(numerator, denominator, size) {
  const num = layoutMathSequence(numerator, size * 0.66);
  const den = layoutMathSequence(denominator, size * 0.66);
  const padding = size * 0.24;
  const width = Math.max(num.width, den.width) + padding * 2;
  const lineY = size * 0.04;
  const numBaseline = -size * 0.24;
  const denBaseline = size * 0.76;
  return {
    width,
    top: Math.min(num.top + numBaseline, -size * 0.72),
    bottom: Math.max(den.bottom + denBaseline, size * 0.88),
    draw: (x, baseline) => [
      num.draw(x + (width - num.width) / 2, baseline + numBaseline),
      `M ${x.toFixed(2)},${(baseline + lineY).toFixed(2)} L ${(x + width).toFixed(2)},${(baseline + lineY).toFixed(2)}`,
      den.draw(x + (width - den.width) / 2, baseline + denBaseline)
    ].filter(Boolean).join(" ")
  };
}

function radicalBox(argument, size) {
  const content = layoutMathSequence(argument, size * 0.88);
  const rootWidth = size * 0.38;
  const top = Math.min(content.top, -size * 0.82);
  const bottom = Math.max(content.bottom, size * 0.22);
  const overlineY = top + size * 0.06;
  return {
    width: rootWidth + content.width + size * 0.08,
    top,
    bottom,
    draw: (x, baseline) => [
      `M ${(x + size * 0.02).toFixed(2)},${(baseline + size * 0.08).toFixed(2)} L ${(x + size * 0.14).toFixed(2)},${(baseline + size * 0.24).toFixed(2)} L ${(x + size * 0.28).toFixed(2)},${(baseline + top + size * 0.14).toFixed(2)} L ${(x + size * 0.38).toFixed(2)},${(baseline + top + size * 0.14).toFixed(2)}`,
      `M ${(x + rootWidth).toFixed(2)},${(baseline + overlineY).toFixed(2)} L ${(x + rootWidth + content.width + size * 0.08).toFixed(2)},${(baseline + overlineY).toFixed(2)}`,
      content.draw(x + rootWidth, baseline)
    ].join(" ")
  };
}

function layoutMathSequence(source, size) {
  const atoms = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      atoms.push({ box: spacerBox(size * 0.28) });
      index += 1;
      continue;
    }
    if ((character === "^" || character === "_") && atoms.length) {
      const argument = readMathArgument(source, index + 1);
      const previous = atoms[atoms.length - 1];
      if (character === "^") previous.superscript = argument.value;
      else previous.subscript = argument.value;
      previous.box = scriptMathBox(previous.baseBox || previous.box, previous.superscript, previous.subscript, previous.size || size);
      index = argument.next;
      continue;
    }
    let atom;
    if (character === "{") {
      const argument = readMathArgument(source, index);
      atom = { box: layoutMathSequence(argument.value, size) };
      index = argument.next;
    } else if (character === "\\") {
      const command = source.slice(index).match(/^\\([A-Za-z]+|.)/);
      if (!command) {
        atom = { box: glyphBox("\\", size) };
        index += 1;
      } else {
        const name = command[1];
        index += command[0].length;
        if (["frac", "dfrac", "tfrac"].includes(name)) {
          const numerator = readMathArgument(source, index);
          const denominator = readMathArgument(source, numerator.next);
          atom = { box: fractionBox(numerator.value, denominator.value, size) };
          index = denominator.next;
        } else if (name === "sqrt") {
          if (source[index] === "[") {
            const optionalEnd = source.indexOf("]", index + 1);
            index = optionalEnd >= 0 ? optionalEnd + 1 : index;
          }
          const argument = readMathArgument(source, index);
          atom = { box: radicalBox(argument.value, size) };
          index = argument.next;
        } else if (["text", "mathrm", "mathbf", "mathit", "operatorname"].includes(name)) {
          const argument = readMathArgument(source, index);
          atom = { box: glyphBox(sceneText(argument.value), size * 0.92, handwritingFont) };
          index = argument.next;
        } else if (["left", "right", "big", "Big", "bigg", "Bigg"].includes(name)) {
          if (source[index] && !/[A-Za-z\s]/.test(source[index])) {
            atom = { box: glyphBox(source[index], size) };
            index += 1;
          }
        } else {
          atom = { box: mathCommandAtom(name, size) || emptyMathBox() };
        }
      }
    } else {
      atom = { box: glyphBox(character, size) };
      index += 1;
    }
    if (atom) {
      atom.baseBox = atom.box;
      atom.size = size;
      atoms.push(atom);
    }
  }

  const boxes = atoms.map((atom) => atom.box);
  const width = boxes.reduce((total, box) => total + box.width, 0);
  const top = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
  const bottom = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;
  return {
    width,
    top,
    bottom,
    draw: (x, baseline) => {
      let cursor = x;
      const paths = [];
      for (const box of boxes) {
        const path = box.draw(cursor, baseline);
        if (path) paths.push(path);
        cursor += box.width;
      }
      return paths.join(" ");
    }
  };
}

function handwritingMathPath(value, fontSize) {
  const source = String(value || "");
  const parts = [];
  const pattern = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|(?<!\\)\$([^\n$]+?)(?<!\\)\$/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) parts.push({ math: false, value: source.slice(lastIndex, match.index) });
    parts.push({ math: true, value: match[1] ?? match[2] ?? match[3] ?? match[4] });
    lastIndex = pattern.lastIndex;
  }
  if (!parts.length) parts.push({ math: true, value: source });
  else if (lastIndex < source.length) parts.push({ math: false, value: source.slice(lastIndex) });

  const boxes = parts.map((part) => part.math
    ? layoutMathSequence(part.value.trim(), fontSize)
    : glyphBox(sceneText(part.value), fontSize, handwritingFont));
  const row = {
    width: boxes.reduce((total, box) => total + box.width, 0),
    top: boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0,
    bottom: boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0
  };
  const baseline = Math.max(fontSize, -row.top + 4);
  const d = [];
  let cursor = 0;
  for (const box of boxes) {
    const path = box.draw(cursor, baseline);
    if (path) d.push(path);
    cursor += box.width;
  }
  return {
    d: d.join(" "),
    width: Math.max(12, Math.ceil(row.width + 4)),
    height: Math.max(fontSize + 8, Math.ceil(row.bottom + baseline + 5)),
    baseline
  };
}

function sceneJitter(seed, amount = 1.4) {
  const value = (hashSeed(String(seed)) % 10000) / 10000;
  return (value - 0.5) * amount;
}

function handwritingPath(text, fontSize) {
  const value = sceneText(text);
  if (!value) return null;
  const path = handwritingFont.getPath(value, 0, fontSize, fontSize, { kerning: true });
  const bounds = path.getBoundingBox();
  const advance = handwritingFont.getAdvanceWidth(value, fontSize, { kerning: true });
  return {
    d: path.toPathData(2),
    width: Math.max(12, Math.ceil(Math.max(advance, bounds.x2) + 4)),
    height: Math.max(fontSize + 8, Math.ceil(bounds.y2 + 5)),
    baseline: fontSize
  };
}

function buildEditableScene(markdown, width, height, options = {}, mermaidArtifacts = []) {
  const marginX = 86;
  const contentWidth = Math.max(300, width - marginX * 2);
  const elements = [];
  let cursorY = 64;
  let elementId = 0;
  const textColor = normalizeColor(options.textColor, "#302c28");
  const lineColor = normalizeColor(options.lineColor, "#4c463f");
  const add = (element) => elements.push({ id: `scene-${++elementId}`, ...element });
  const addText = (text, x, y, w, h, fontSize = 21, fontWeight = 400, role = "text") => {
    const glyphs = role === "math"
      ? handwritingMathPath(text, fontSize)
      : handwritingPath(sceneText(text), fontSize);
    if (glyphs) add({ kind: "path", role, x, y, width: Math.max(w, glyphs.width), height: Math.max(h, glyphs.height), d: glyphs.d, fill: textColor, stroke: "none", strokeWidth: 0, fontSize, fontWeight });
  };
  const addLine = (x1, y1, x2, y2, strokeWidth = 1.7, seed = elementId + 1) => {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const localWidth = Math.max(8, Math.abs(x2 - x1) + 8);
    const localHeight = Math.max(8, Math.abs(y2 - y1) + 8);
    const roughness = 1.25;
    const bowing = 1.35;
    const maxRandomnessOffset = 2.2;
    const options = { roughness, bowing, maxRandomnessOffset, stroke: lineColor, strokeWidth, disableMultiStroke: true };
    const generator = rough.generator({ options: { ...options, seed: hashSeed(`${seed}:${x1}:${y1}:${x2}:${y2}`) } });
    const d = roughPathData(generator, generator.line(4, 4, localWidth - 4, localHeight - 4, options));
    add({ kind: "path", role: "line", x: left - 4, y: top - 4, width: localWidth, height: localHeight, d, fill: "none", stroke: lineColor, strokeWidth });
  };
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let mermaidIndex = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { cursorY += 18; index += 1; continue; }
    const mermaidFence = line.trim().match(/^(?:```|~~~)\s*(?:mermaid|mmd)\s*$/i);
    const trimmedLine = line.trim();
    const blockMathStart = trimmedLine.startsWith("$$") || trimmedLine.startsWith("\\[");
    if (blockMathStart) {
      const marker = trimmedLine.startsWith("\\[") ? "\\]" : "$$";
      let formula = trimmedLine.slice(2);
      const closingIndex = formula.indexOf(marker);
      if (closingIndex >= 0) {
        formula = formula.slice(0, closingIndex);
        index += 1;
      } else {
        const formulaLines = [formula];
        index += 1;
        while (index < lines.length && !lines[index].includes(marker)) formulaLines.push(lines[index++]);
        if (index < lines.length) {
          const closingLine = lines[index];
          const closingAt = closingLine.indexOf(marker);
          if (closingAt > 0) formulaLines.push(closingLine.slice(0, closingAt));
          index += 1;
        }
        formula = formulaLines.join(" ");
      }
      addText(formula, marginX, cursorY, contentWidth, 48, 26, 400, "math");
      cursorY += 62;
      continue;
    }
    if (mermaidFence) {
      const fence = line.trim().slice(0, 3);
      const chart = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) chart.push(lines[index++]);
      if (index < lines.length) index += 1;
      const artifact = mermaidArtifacts[mermaidIndex++];
      if (artifact) {
        const diagramWidth = contentWidth;
        const diagramHeight = Math.max(120, diagramWidth * artifact.height / Math.max(1, artifact.width));
        add({ kind: "svg", role: "mermaid", x: marginX, y: cursorY, width: diagramWidth, height: diagramHeight, svg: artifact.svg, chart: artifact.chart });
        cursorY += diagramHeight + 22;
      } else {
        const boxHeight = Math.max(46, chart.length * 30 + 20);
        add({ kind: "rect", x: marginX, y: cursorY, width: contentWidth, height: boxHeight, stroke: lineColor, strokeWidth: 1.5, fill: "#f1eee6" });
        chart.forEach((chartLine, row) => addText(chartLine, marginX + 14, cursorY + 9 + row * 30, contentWidth - 28, 28, 17, 400, "code"));
        cursorY += boxHeight + 22;
      }
      continue;
    }
    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      const fence = line.trim().slice(0, 3);
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const boxHeight = Math.max(46, code.length * 30 + 20);
      add({ kind: "rect", x: marginX, y: cursorY, width: contentWidth, height: boxHeight, stroke: lineColor, strokeWidth: 1.5, fill: "#f1eee6" });
      code.forEach((codeLine, row) => addText(codeLine, marginX + 14, cursorY + 9 + row * 30, contentWidth - 28, 28, 17, 400, "code"));
      cursorY += boxHeight + 22;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const rows = [splitPipeRow(line)];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(splitPipeRow(lines[index++]));
      const columnCount = Math.max(...rows.map((row) => row.length));
      const preferred = Array.from({ length: columnCount }, (_, column) => Math.max(90, ...rows.map((row) => Math.min(320, 42 + displayLength(row[column] || "") * 11))));
      const total = preferred.reduce((sum, value) => sum + value, 0);
      const columns = preferred.map((value) => value / total * contentWidth);
      const rowHeight = 44;
      rows.forEach((row, rowIndex) => {
        let x = marginX;
        if (rowIndex === 0) add({ kind: "rect", x, y: cursorY, width: contentWidth, height: rowHeight, stroke: "none", strokeWidth: 0, fill: "#ebe8e0" });
        row.forEach((cell, column) => {
          addText(cell, x + 14, cursorY + 8, Math.max(20, columns[column] - 28), 28, 19, rowIndex === 0 ? 600 : 400, "table-cell");
          x += columns[column];
        });
        if (options.tableBorders !== false) addLine(marginX + sceneJitter(rowIndex + 1), cursorY + rowHeight, marginX + contentWidth + sceneJitter(rowIndex + 101), cursorY + rowHeight, 1.45, rowIndex + 1);
        cursorY += rowHeight;
      });
      if (options.tableBorders !== false) {
        let x = marginX;
        addLine(marginX, cursorY - rows.length * rowHeight, marginX + contentWidth, cursorY - rows.length * rowHeight, 1.45, 500);
        columns.forEach((columnWidth, column) => { x += columnWidth; addLine(x, cursorY - rows.length * rowHeight, x + sceneJitter(column + 210), cursorY, 1.45, 600 + column); });
        addLine(marginX + sceneJitter(300), cursorY, marginX + contentWidth + sceneJitter(301), cursorY, 1.45, 700);
      }
      cursorY += 24;
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const fontSize = Math.max(23, 40 - level * 4);
      addText(heading[2], marginX, cursorY, contentWidth, fontSize + 12, fontSize, 600, "heading");
      cursorY += fontSize + 18;
      addLine(marginX, cursorY, marginX + contentWidth, cursorY, 1.7);
      cursorY += 18;
      index += 1;
      continue;
    }
    if (/^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      addLine(marginX, cursorY + 10, marginX + contentWidth, cursorY + 10, 1.7);
      cursorY += 32;
      index += 1;
      continue;
    }
    const list = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    addText(list ? `• ${list[1]}` : line, marginX, cursorY, contentWidth, 32, 21, 400, line.includes("$") || line.includes("\\(") ? "math" : "text");
    cursorY += 38;
    index += 1;
  }
  return { version: 1, width, height: Math.max(320, cursorY + 36), elements };
}

function sceneMetadata(scene) {
  const encoded = Buffer.from(JSON.stringify(scene), "utf8").toString("base64");
  return `<metadata id="secagent-editable-scene" data-encoding="base64">${encoded}</metadata>`;
}

async function renderSvg(markdown, options = {}) {
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("Markdown 内容不能超过 2 MiB");
  const width = Math.max(640, Math.min(2400, Number.isFinite(options.width) ? Math.round(options.width) : DEFAULT_WIDTH));
  const title = typeof options.title === "string" && options.title.trim() ? options.title.trim().slice(0, 120) : "Markdown 手写预览";
  const seed = hashSeed(markdown);
  const transparent = options.transparent === true;
  const showFrame = options.frame !== false;
  const tableBorders = options.tableBorders !== false;
  const renderedMarkdown = await renderMarkdownHtml(markdown, seed);
  const html = decorateHtml(toXmlCompatibleXhtml(renderedMarkdown.html), seed, tableBorders);
  const estimatedHeight = estimateHeight(markdown, html);
  const editableScene = buildEditableScene(markdown, width, estimatedHeight, options, renderedMarkdown.mermaidArtifacts);
  const height = editableScene.height;
  const textColor = normalizeColor(options.textColor, "#302c28");
  const lineColor = normalizeColor(options.lineColor, "#4c463f");
  const backgroundColor = normalizeColor(options.backgroundColor, "#fffdf6");
  const backgroundFill = transparent ? "none" : backgroundColor;
  const fontData = fs.readFileSync(fontPath).toString("base64");
  const katexCss = fs.readFileSync(katexCssPath, "utf8");
  const css = `
@font-face { font-family: "PingFang San Sheng Ti"; src: url(data:font/ttf;base64,${fontData}) format("truetype"); font-weight: 400; font-style: normal; }
${katexCss}
* { box-sizing: border-box; }
body { margin: 0; color: ${textColor}; background: transparent; }
.sheet { min-height: 100%; padding: 42px 52px; color: ${textColor}; font-family: "PingFang San Sheng Ti", "Klee One", "Comic Sans MS", cursive, sans-serif; font-size: 21px; line-height: 1.65; overflow-wrap: anywhere; }
.sheet h1, .sheet h2, .sheet h3, .sheet h4, .sheet h5, .sheet h6 { margin: 0 0 18px; color: #27231f; font-weight: 600; line-height: 1.3; }
.sheet h1 { font-size: 38px; padding-bottom: 10px; }
.sheet h2 { font-size: 31px; }
.sheet h3 { font-size: 27px; }
.sheet p { margin: 0 0 16px; }
.sheet ul, .sheet ol { margin: 0 0 18px; padding-left: 34px; }
.sheet blockquote { margin: 18px 0; padding: 10px 18px; border-left: 4px solid #6d655c; background: rgba(109,101,92,.08); }
.rough-table-wrap { position: relative; width: 100%; margin: 22px 0; }
.rough-table-wrap table { width: 100%; margin: 0 !important; border-collapse: collapse; table-layout: fixed; }
.rough-table-wrap colgroup { display: table-column-group; }
.rough-table-wrap .rough-table-lines { position: absolute; inset: 0; z-index: 2; display: block; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.rough-inline-line { display: block; width: 100%; height: 8px; margin-top: 10px; overflow: visible; }
.mermaid-block { width: 100%; margin: 20px 0; overflow: visible; }
.mermaid-block > svg { display: block; width: 100%; height: auto; max-width: 100%; overflow: visible; }
.sheet table { width: 100%; margin: 22px 0; border-collapse: collapse; }
.sheet th, .sheet td { border: 0; padding: 8px 14px; text-align: left; vertical-align: top; }
.sheet th { background: rgba(76,70,63,.1); font-weight: 600; }
.sheet hr { border: 0; margin: 26px 0; height: 3px; }
.sheet pre { margin: 18px 0; padding: 16px 18px; overflow: auto; border: 2px solid #4c463f; background: rgba(76,70,63,.08); font-family: "PingFang San Sheng Ti", monospace; font-size: 17px; line-height: 1.45; filter: url(#handdrawn-jitter); }
.sheet code { padding: 1px 5px; border-radius: 4px; background: rgba(76,70,63,.1); font-family: "PingFang San Sheng Ti", monospace; }
.sheet pre code { padding: 0; background: transparent; }
.sheet a { color: #315b73; text-decoration: underline; }
.sheet .katex, .sheet .katex * { font-family: "PingFang San Sheng Ti", "Times New Roman", serif !important; }
.sheet .katex-display { margin: 18px 0; filter: url(#handdrawn-jitter); }
`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${escapeXml(title)}</title>${sceneMetadata(editableScene)}<defs><filter id="handdrawn-jitter" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${hashSeed(markdown)}" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2.2" xChannelSelector="R" yChannelSelector="G"/></filter><style>${css}</style></defs><rect width="100%" height="100%" fill="${backgroundFill}"/><foreignObject x="34" y="34" width="${width - 68}" height="${height - 68}"><div xmlns="http://www.w3.org/1999/xhtml" class="sheet">${html}</div></foreignObject><g class="rough-overlay" aria-hidden="true" pointer-events="none">${roughPaths(markdown, width, height, seed, showFrame)}</g></svg>`;
}

export async function activate(api) {
  api.registerSkill("skills/handdrawn-markdown/SKILL.md");
  api.registerTool({
    name: "render",
    description: "将 Markdown、GFM 表格和数学公式渲染为手写风格 SVG 文件；默认打开预览，也支持只导出并插入画板。",
    hidden: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["markdown"],
      properties: {
        backgroundColor: { type: "string", pattern: "^(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))$" },
        textColor: { type: "string", pattern: "^(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))$" },
        lineColor: { type: "string", pattern: "^(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))$" },
        markdown: { type: "string", description: "要渲染的完整 Markdown 字符串。" },
        title: { type: "string", description: "可选的预览窗口标题。" },
        fileName: { type: "string", description: "可选的输出文件名，只能是文件名。" },
        width: { type: "number", minimum: 640, maximum: 2400, description: "可选 SVG 宽度，默认 1200。" },
        transparent: { type: "boolean", description: "是否使用透明背景，默认 false。" },
        frame: { type: "boolean", description: "是否显示外层手绘纸张边框，默认 true。" },
        tableBorders: { type: "boolean", description: "是否显示表格手绘网格，默认 true。" },
        preview: { type: "boolean", description: "是否打开独立预览窗口，默认 true；插入画板时可设为 false。" },
        insertToIccce: { type: "boolean", description: "是否同时插入当前 ICC-CE 白板；会优先创建可单独选择的文字和线条元素。" }
      }
    }
  }, async (args) => {
    if (typeof args.markdown !== "string") throw new Error("markdown 必须是字符串");
    const svg = await renderSvg(args.markdown, args);
    const result = await api.openSvgPreview({ svg, title: args.title, fileName: args.fileName, openPreview: args.preview !== false });
    if (!result.previewOpened && result.previewError && !result.previewError.includes("没有 Electron")) throw new Error(`SVG 预览失败：${result.previewError}`);
    let iccce = null;
    if (args.insertToIccce === true) {
      const response = await api.fetch("http://127.0.0.1:18790/tools/insert_iccce_svg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ svg, name: args.title || "Markdown 手写内容", width: args.width })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload?.error?.message || `ICC-CE 插入失败（HTTP ${response.status}）`);
      iccce = payload.result || payload;
    }
    const sceneBase64 = svg.match(/<metadata id="secagent-editable-scene" data-encoding="base64">([^<]+)<\/metadata>/)?.[1];
    const elementCount = sceneBase64 ? JSON.parse(Buffer.from(sceneBase64, "base64").toString("utf8"))?.elements?.length || 0 : 0;
    return { ok: true, ...result, editableScene: { version: 1, elementCount }, iccce };
  });
  api.setStatus("Markdown 手写 SVG 已就绪");
  return () => {
    api.unregisterTool("render");
    api.unregisterSkill("handdrawn-markdown");
  };
}

export { renderSvg };
