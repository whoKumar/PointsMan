"use strict";
/**
 * scan.js — whole-project collector.
 *
 * `review` normally works off a git diff. For a whole-project audit we need the
 * same parsed shape the diff parser produces, but with *every* line of *every*
 * reviewable file marked as an "added" line — so the deterministic detectors run
 * unchanged over the entire tree, not just a change.
 *
 * Zero dependencies: shells out to `git ls-files` when possible (so .gitignore is
 * respected for free), and falls back to a plain filesystem walk otherwise.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".expo",
  "coverage", "vendor", "out", ".turbo", ".cache", "__pycache__",
]);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map)$/;
const TEXT_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "scala", "dart",
  "json", "yml", "yaml", "toml", "ini", "sh", "bash", "zsh",
  "sql", "graphql", "gql", "prisma",
  "md", "mdx", "html", "css", "scss",
]);
const MAX_BYTES = 512 * 1024; // skip files bigger than this — not worth scanning line-by-line

function listFilesGit(cwd) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.split("\n").filter(Boolean);
}

function listFilesWalk(cwd) {
  const found = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(abs);
      } else {
        found.push(path.relative(cwd, abs));
      }
    }
  })(cwd);
  return found;
}

function isReviewable(rel) {
  if (SKIP_FILES.test(rel)) return false;
  for (const part of rel.split("/")) if (SKIP_DIRS.has(part)) return false;
  const base = rel.split("/").pop();
  if (base === ".env" || base.startsWith(".env.")) return true; // scan env files for leaked secrets
  const ext = (base.includes(".") ? base.split(".").pop() : "").toLowerCase();
  return TEXT_EXT.has(ext);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // a NUL byte → treat as binary
  return false;
}

function collectWith(cwd, listFiles) {
  const parsed = [];
  for (const rel of listFiles(cwd)) {
    if (!isReviewable(rel)) continue;
    const abs = path.join(cwd, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n").map((t, i) => ({ kind: "add", text: t, lineNo: i + 1 }));
    parsed.push({ file: rel, hunks: [{ newStart: 1, lines }] });
  }
  return parsed;
}

/**
 * Collect the whole project as a parsed structure (every line = "added").
 * Prefers git (respects .gitignore); falls back to a filesystem walk.
 */
function collectProject(cwd, isRepo) {
  if (isRepo) {
    try { return collectWith(cwd, listFilesGit); } catch { /* fall through to walk */ }
  }
  return collectWith(cwd, listFilesWalk);
}

module.exports = { collectProject };
