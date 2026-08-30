import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const roots = [
  ".github",
  "docs",
  "scripts",
  "src",
  "test",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "tsconfig.json",
];
const extensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const failures = [];

async function check(target) {
  const metadata = await stat(target);
  if (metadata.isDirectory()) {
    for (const entry of (await readdir(target)).sort()) {
      await check(path.join(target, entry));
    }
    return;
  }
  if (!extensions.has(path.extname(target))) return;

  const contents = await readFile(target, "utf8");
  if (contents.includes("\r")) failures.push(`${target}: contains CRLF line endings`);
  if (!contents.endsWith("\n")) failures.push(`${target}: missing final newline`);
  contents.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      failures.push(`${target}:${index + 1}: trailing whitespace`);
    }
  });
}

for (const root of roots) await check(root);

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
