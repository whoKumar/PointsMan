"use strict";
/**
 * tests.js — `pointsman tests`
 *
 * The living-QA pillar. Zero-dep:
 *   • keeps a human-readable test sheet (pointsman-tests.csv) present + headed;
 *   • from the diff (or the whole project with --inventory) seeds a TODO row per
 *     risk area, so the sheet is a usable checklist, not an empty file;
 *   • tells you which areas need cases.
 *
 * Writing the case *body* (steps + expected result) from intent is the model's
 * job (--llm, or your agent) — this layer scaffolds the rows and keeps them anchored.
 */
const fs = require("fs");
const path = require("path");
const { collectDiff, parseDiff, isGitRepo } = require("./diff");
const { collectProject } = require("./scan");
const { loadRules, runDeterministic } = require("./rules");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

const SHEET = "pointsman-tests.csv";
const HEADER =
  "ID,Area,Title,Preconditions,Steps,Expected Result,Priority,Anchor (code/rule),Status,Source,Confidence,Last Updated";
const PRIORITY = { block: "High", warn: "Medium", info: "Low" };

function csvField(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Ensure the sheet exists and starts with the header. Returns { created, rows }. */
function ensureSheet(sheetPath) {
  let content = "";
  try { content = fs.readFileSync(sheetPath, "utf8"); } catch { /* missing */ }
  if (!content.trim()) {
    fs.writeFileSync(sheetPath, HEADER + "\n", "utf8");
    return { created: true, rows: 0 };
  }
  // A non-empty file that somehow lost its header gets it back (rows preserved).
  if (content.split("\n")[0].trim() !== HEADER) {
    content = HEADER + "\n" + content;
    fs.writeFileSync(sheetPath, content, "utf8");
  }
  const rows = content.split("\n").filter((l) => l.trim() && l.trim() !== HEADER).length;
  return { created: false, rows };
}

/** Append a TODO stub row per new risk anchor (deduped). Returns the number added. */
function seedStubs(sheetPath, findings) {
  let content = "";
  try { content = fs.readFileSync(sheetPath, "utf8"); } catch { content = HEADER + "\n"; }
  const today = new Date().toISOString().slice(0, 10);
  let seq = content.split("\n").filter((l) => l.trim() && l.trim() !== HEADER).length;
  const seen = new Set();
  const rows = [];
  for (const f of findings) {
    const anchor = `${f.file}:${f.line}`;
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    if (content.includes(anchor)) continue; // already covered in the sheet
    seq += 1;
    rows.push([
      "TC-" + String(seq).padStart(3, "0"),
      f.category,
      "Cover: " + f.title,
      "", "", "",                           // Preconditions, Steps, Expected — you / the model fill these
      PRIORITY[f.severity] || "Medium",
      `${anchor} (${f.ruleId})`,
      "TODO", "pointsman", "",              // Status, Source, Confidence
      today,
    ].map(csvField).join(","));
  }
  if (rows.length) {
    if (!content.endsWith("\n")) content += "\n";
    fs.appendFileSync(sheetPath, rows.join("\n") + "\n", "utf8");
  }
  return rows.length;
}

function reportSeed(added) {
  if (added) {
    console.log("  " + paint(`+ ${added} TODO row(s)`, C.green) + paint("  into " + SHEET + " — fill Steps/Expected, or let a model draft them.", C.dim));
  } else {
    console.log(paint("  No new rows — every flagged area is already in the sheet.", C.dim));
  }
}

function tests(cwd, argv) {
  const inventory = (argv || []).some((a) => a === "--inventory" || a === "--all");
  const sheetPath = path.join(cwd, SHEET);
  console.log(paint("\npointsman tests", C.bold) + paint("  " + sheetPath, C.dim));

  const sheet = ensureSheet(sheetPath);
  if (sheet.created) console.log("  " + paint("+ created", C.green) + "  " + SHEET + paint("  (header ready)", C.dim));
  else console.log("  " + paint("• found  ", C.dim) + "  " + SHEET + paint(`  (${sheet.rows} case(s))`, C.dim));

  if (inventory) return surface(cwd, isGitRepo(cwd), sheetPath);

  if (!isGitRepo(cwd)) {
    console.log(paint("\n  Not a git repo — pass --inventory to map the whole folder.\n", C.dim));
    return;
  }

  let parsed = [];
  try { parsed = parseDiff(collectDiff(cwd, {})); } catch { /* ignore */ }
  if (!parsed.length) {
    console.log(paint("\n  No changes — nothing new to add for the current diff.\n", C.dim));
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
      console.log(`    ${paint(f.category, C.cyan)}  ${f.file}:${f.line}  ${paint("(rule " + f.ruleId + ")", C.dim)}`);
    }
    console.log("");
    reportSeed(seedStubs(sheetPath, findings));
  } else {
    console.log(paint(`    ${parsed.length} file(s) changed; no rule-flagged areas — spot-check by hand.`, C.dim));
  }
  console.log(paint("\n  Case bodies (steps + expected) need the model layer: ", C.dim) + paint("pointsman review --llm", C.cyan) + paint(", or your agent.\n", C.dim));
}

/**
 * Whole-project test surface: risk files first, and a TODO row seeded for each
 * so the sheet opens as a real checklist.
 */
function surface(cwd, isRepo, sheetPath) {
  let parsed = [];
  try { parsed = collectProject(cwd, isRepo); } catch { /* ignore */ }
  if (!parsed.length) {
    console.log(paint("\n  No reviewable files found.\n", C.dim));
    return;
  }

  const cfg = loadRules(cwd, fs, path);
  const findings = runDeterministic(parsed, cfg);
  const byFile = {};
  for (const f of findings) (byFile[f.file] = byFile[f.file] || []).push(f);
  const riskFiles = Object.keys(byFile);

  console.log(paint("\n  Whole-project test surface", C.bold) + paint(`  (${parsed.length} source file(s))`, C.dim));

  if (riskFiles.length) {
    console.log(paint("\n  Priority — files on value / failure / secret paths (write cases here first):", C.bold));
    for (const file of riskFiles) {
      const cats = [...new Set(byFile[file].map((x) => x.category))].join(", ");
      console.log(`    ${paint(file, C.cyan)}  ${paint("→ " + cats, C.dim)}`);
    }
    console.log("");
    reportSeed(seedStubs(sheetPath, findings));
  } else {
    console.log(paint("\n  No rule-flagged risk areas — nothing to seed.", C.dim));
  }

  const rest = parsed.map((p) => p.file).filter((f) => !byFile[f]);
  console.log(paint(`\n  ${rest.length} more file(s) have no flagged risk (baseline cases are yours to add).`, C.dim));
  console.log(paint("\n  Case bodies (steps + expected) need the model layer: ", C.dim) + paint("pointsman review --llm", C.cyan) + paint(", or your agent.\n", C.dim));
}

module.exports = { tests };
