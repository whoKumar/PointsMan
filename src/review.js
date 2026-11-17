"use strict";
/**
 * review.js — `pointsman review`
 *
 * Impact-aware review of a code change. The deterministic layer (zero-dep) runs
 * the built-in detectors against the diff and reports verified findings with
 * file:line anchors and an impact class. The semantic rules are left to the
 * optional LLM layer (not wired here) so the core stays model-free.
 */
const fs = require("fs");
const path = require("path");
const { collectDiff, parseDiff, isGitRepo } = require("./diff");
const { RULES, loadRules, runDeterministic } = require("./rules");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

const SEV = {
  block: { mark: "🔴 BLOCK", color: C.red },
  warn: { mark: "🟡 WARN ", color: C.yellow },
  info: { mark: "⚪ INFO ", color: C.gray },
};

function parseArgs(argv) {
  const opts = { gate: false, staged: false, range: null };
  for (const a of argv) {
    if (a === "--gate") opts.gate = true;
    else if (a === "--staged") opts.staged = true;
    else if (a === "--llm") opts.llm = true;
    else if (!a.startsWith("-")) opts.range = a; // e.g. main..HEAD
  }
  if (process.env.CI) opts.gate = true;
  return opts;
}

function review(cwd, argv) {
  const opts = parseArgs(argv);

  if (!isGitRepo(cwd)) {
    console.log(paint("\npointsman review", C.bold) + "  — not a git repository.");
    console.log(paint("  Run it inside a repo; review reads `git diff`.\n", C.dim));
    process.exit(2);
  }

  let raw;
  try { raw = collectDiff(cwd, opts); }
  catch (e) {
    console.log(paint("\npointsman review", C.bold) + "  — could not read the diff.");
    console.log(paint("  " + String(e.message || e).split("\n")[0] + "\n", C.dim));
    process.exit(2);
  }

  const parsed = parseDiff(raw);
  const cfg = loadRules(cwd, fs, path);

  const scope = opts.range ? opts.range : opts.staged ? "staged changes" : "uncommitted changes vs HEAD";
  console.log(paint("\npointsman review", C.bold) + paint("  " + scope, C.dim));
  console.log(paint(`  rules: ${cfg.hasFile ? "rules.md" : "built-in defaults (no rules.md)"}  ·  ${parsed.length} file(s) changed`, C.dim));

  if (!parsed.length) {
    console.log(paint("\n  No changes to review.\n", C.dim));
    return;
  }

  const findings = runDeterministic(parsed, cfg);

  // Group by severity: block, warn, info
  const order = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  if (findings.length) {
    console.log("");
    for (const f of findings) {
      const s = SEV[f.severity];
      const head = `  ${paint(s.mark, s.color)} ${paint(f.category, C.cyan)} · ${f.title}`;
      console.log(head);
      console.log(`      ${paint(f.file + ":" + f.line, C.bold)}  ${paint("[verified]", C.green)}  ${paint("rule " + f.ruleId, C.dim)}`);
      if (f.snippet) console.log(paint("      " + f.snippet.slice(0, 100), C.dim));
    }
  } else {
    console.log(paint("\n  No deterministic findings. ✓", C.green));
  }

  // Impact summary
  const byCat = {};
  for (const f of findings) byCat[f.category] = (byCat[f.category] || 0) + 1;
  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  console.log(paint("\n  Impact", C.bold));
  const cats = Object.keys(byCat);
  if (cats.length) for (const c of cats) console.log(`    ${c}: ${byCat[c]}`);
  else console.log(paint("    nothing flagged by the deterministic rules", C.dim));
  console.log(paint(`\n  ${blocks} block · ${warns} warn`, C.bold));

  // The optional semantic (LLM) layer — advertised, not run.
  const llmRules = RULES.filter((r) => r.mode === "llm");
  console.log(paint("\n  Semantic layer (optional, not run)", C.bold));
  console.log(paint(`    ${llmRules.length} rules need a model to judge: ${llmRules.map((r) => r.id).join(", ")}`, C.dim));
  console.log(paint("    These catch behaviour-hidden-in-UI, API drift after a bump, and reversed fixes.", C.dim));
  console.log(paint("    Wire a model (your API key, from an env var) to enable them — core review stays model-free.", C.dim));

  if (opts.gate && blocks > 0) {
    console.log(paint(`\n  Gate: ${blocks} blocking finding(s) — failing.\n`, C.red));
    process.exit(1);
  }
  console.log(paint(opts.gate ? "\n  Gate: no blocking findings. ✓\n" : "\n  (advisor mode — pass --gate or run in CI to block on 🔴)\n", C.dim));
}

module.exports = { review };
