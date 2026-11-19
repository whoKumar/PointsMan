"use strict";
/**
 * diff.js — collect and parse a git diff. Zero dependencies (shells out to git).
 *
 * The deterministic review layer works off the *added* lines of a unified diff,
 * with real file:line anchors. No model, no network.
 */
const { execFileSync } = require("child_process");

/** Run a git command, returning stdout (""+trimmed) or throwing on failure. */
function git(cwd, args) {
  // stdio: keep stdout piped (we return it); silence stderr so a "not a git repo"
  // or similar never leaks to the user's terminal — callers handle the throw.
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function isGitRepo(cwd) {
  try { git(cwd, ["rev-parse", "--is-inside-work-tree"]); return true; }
  catch { return false; }
}

/**
 * Collect a unified diff.
 *   opts.range   explicit git range, e.g. "main..HEAD" (overrides everything)
 *   opts.staged  true → `git diff --cached`
 * Default: all uncommitted work vs HEAD (`git diff HEAD`); on a repo with no
 * commits yet, falls back to the plain working-tree diff.
 */
function collectDiff(cwd, opts = {}) {
  const common = ["--no-color", "-U3"];
  if (opts.range) return git(cwd, ["diff", ...common, opts.range]);
  if (opts.staged) return git(cwd, ["diff", ...common, "--cached"]);
  try { return git(cwd, ["diff", ...common, "HEAD"]); }
  catch { return git(cwd, ["diff", ...common]); }
}

/**
 * Parse a unified diff into:
 *   [{ file, hunks: [{ newStart, lines: [{ kind:'add'|'del'|'ctx', text, lineNo }] }] }]
 * lineNo is the line number in the NEW file (null for deletions).
 */
function parseDiff(raw) {
  const files = [];
  let cur = null;
  let hunk = null;
  let newLine = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      cur = { file: null, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("+++ ")) {
      // "+++ b/path/to/file"  (or "+++ /dev/null" for deletes)
      let f = line.slice(4).trim();
      if (f.startsWith("b/")) f = f.slice(2);
      if (f !== "/dev/null") cur.file = f;
      continue;
    }
    if (line.startsWith("--- ")) continue;

    const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm) {
      newLine = parseInt(hm[1], 10);
      hunk = { newStart: newLine, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), lineNo: newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), lineNo: null });
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), lineNo: newLine });
      newLine++;
    }
    // "\ No newline at end of file" and others are ignored.
  }

  return files.filter((f) => f.file);
}

module.exports = { collectDiff, parseDiff, isGitRepo };
