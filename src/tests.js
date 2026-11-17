"use strict";
/**
 * tests.js — `pointsman tests`
 *
 * The living-QA pillar. Zero-dep scaffold:
 *   • seeds a human-readable test sheet (pointsman-tests.csv) if missing;
 *   • reads the current diff and reports which areas likely need case review,
 *     anchored to the review findings.
 *
 * Generating and rewriting cases from a change is the model's job (the optional
 * LLM layer) — this layer keeps the sheet present and tells you where it drifts.
 */
const fs = require("fs");
const path = require("path");
const { collectDiff, parseDiff, isGitRepo } = require("./diff");
const { loadRules, runDeterministic } = require("./rules");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

const SHEET = "pointsman-tests.csv";
const HEADER =
  "ID,Area,Title,Preconditions,Steps,Expected Result,Priority,Anchor (code/rule),Status,Source,Confidence,Last Updated";

function tests(cwd, argv) {
  const sheetPath = path.join(cwd, SHEET);
  console.log(paint("\npointsman tests", C.bold) + paint("  " + sheetPath, C.dim));

  // 1. Seed the sheet if it doesn't exist.
  if (!fs.existsSync(sheetPath)) {
    fs.writeFileSync(sheetPath, HEADER + "\n", "utf8");
    console.log("  " + paint("+ created", C.green) + "  " + SHEET + paint("  (header only — add your cases)", C.dim));
  } else {
    const rows = fs.readFileSync(sheetPath, "utf8").split("\n").filter((l) => l.trim()).length - 1;
    console.log("  " + paint("• found  ", C.dim) + "  " + SHEET + paint(`  (${Math.max(rows, 0)} case(s))`, C.dim));
  }

  // 2. If in a repo, map the current change to areas that need case review.
  if (!isGitRepo(cwd)) {
    console.log(paint("\n  Not a git repo — skipping drift check.\n", C.dim));
    return;
  }

  let parsed = [];
  try { parsed = parseDiff(collectDiff(cwd, {})); } catch { /* ignore */ }

  if (!parsed.length) {
    console.log(paint("\n  No changes — the sheet is up to date for the current diff.\n", C.dim));
    return;
  }

  const cfg = loadRules(cwd, fs, path);
  const findings = runDeterministic(parsed, cfg);

  console.log(paint("\n  Changed areas that may need test-case review", C.bold));
  if (findings.length) {
    const seen = new Set();
    for (const f of findings) {
      const key = f.category + "|" + f.file;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    ${paint(f.category, C.cyan)}  ${f.file}:${f.line}  ${paint("→ review cases anchored here (rule " + f.ruleId + ")", C.dim)}`);
    }
  } else {
    const files = parsed.map((p) => p.file);
    console.log(paint(`    ${files.length} file(s) changed; no rule-flagged areas. Spot-check cases for:`, C.dim));
    for (const f of files.slice(0, 10)) console.log(paint("      " + f, C.dim));
  }

  console.log(paint("\n  Generating / rewriting cases from the change needs the optional model layer.", C.dim));
  console.log(paint("  Edit " + SHEET + " by hand for now, or wire a model to keep it in sync.\n", C.dim));
}

module.exports = { tests };
