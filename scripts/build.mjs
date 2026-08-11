import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import AdmZip from "adm-zip";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");
const require = createRequire(import.meta.url);
const katexRoot = path.dirname(require.resolve("katex/package.json"));
const katexCssPath = path.join(katexRoot, "dist", "katex.min.css");

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "assets"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "main.mjs")],
  outfile: path.join(output, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22"
});

fs.cpSync(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });
for (const fontName of ["KaTeX_Main-Regular.ttf", "KaTeX_Math-Italic.ttf"]) {
  fs.copyFileSync(path.join(katexRoot, "dist", "fonts", fontName), path.join(output, "assets", fontName));
}
let katexCss = fs.readFileSync(katexCssPath, "utf8");
katexCss = katexCss.replace(/url\((['"]?)(fonts\/[^)'"\s]+)\1\)/g, (_match, _quote, relativePath) => {
  const fontPath = path.join(katexRoot, "dist", relativePath);
  const extension = path.extname(fontPath).toLowerCase();
  const mime = extension === ".woff2" ? "font/woff2" : extension === ".woff" ? "font/woff" : "application/octet-stream";
  return `url(data:${mime};base64,${fs.readFileSync(fontPath).toString("base64")})`;
});
fs.writeFileSync(path.join(output, "assets", "katex-inline.css"), katexCss, "utf8");
fs.copyFileSync(path.join(root, "secagent-plugin.json"), path.join(output, "secagent-plugin.json"));
fs.copyFileSync(path.join(root, "README.md"), path.join(output, "README.md"));
fs.cpSync(path.join(root, "skills"), path.join(output, "skills"), { recursive: true });

const zip = new AdmZip();
zip.addLocalFolder(output);
zip.writeZip(path.join(output, "markdown-handdrawn-1.0.1.zip"));
console.log("Created dist/markdown-handdrawn-1.0.1.zip");
