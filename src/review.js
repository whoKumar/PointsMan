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
const { collectProject } = require("./scan");
const { RULES, loadRules, runDeterministic } = require("./rules");
const { keyPresent, modelName, semanticReview } = require("./llm");

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
  const opts = { gate: false, staged: false, all: false, llm: false, range: null };
  for (const a of argv) {
    if (a === "--gate") opts.gate = true;
    else if (a === "--staged") opts.staged = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--llm") opts.llm = true;
    else if (a.startsWith("#")) break; // a stray shell comment — ignore it and the rest
    else if (!a.startsWith("-") && !opts.range) opts.range = a; // first range wins, e.g. main..HEAD
  }
  if (process.env.CI) opts.gate = true;
  return opts;
}

async function review(cwd, argv) {
  const opts = parseArgs(argv);
  const isRepo = isGitRepo(cwd);

  if (!isRepo && !opts.all) {
    console.log(paint("\npointsman review", C.bold) + "  — not a git repository.");
    console.log(paint("  Run it inside a repo, or pass --all to scan the whole folder.\n", C.dim));
    process.exit(2);
  }

  let parsed, rawForModel = null;
  if (opts.all) {
    // Whole-project scan: every line of every reviewable file, no diff needed.
    try { parsed = collectProject(cwd, isRepo); }
    catch (e) {
      console.log(paint("\npointsman review", C.bold) + "  — could not scan the project.");
      console.log(paint("  " + String(e.message || e).split("\n")[0] + "\n", C.dim));
      process.exit(2);
    }
  } else {
    try { rawForModel = collectDiff(cwd, opts); }
    catch (e) {
      console.log(paint("\npointsman review", C.bold) + "  — could not read the diff.");
      console.log(paint("  " + String(e.message || e).split("\n")[0] + "\n", C.dim));
      process.exit(2);
    }
    parsed = parseDiff(rawForModel);
  }

  const cfg = loadRules(cwd, fs, path);

  const scope = opts.all
    ? "whole project"
    : opts.range ? opts.range : opts.staged ? "staged changes" : "uncommitted changes vs HEAD";
  const noun = opts.all ? "file(s) scanned" : "file(s) changed";
  console.log(paint("\npointsman review", C.bold) + paint("  " + scope, C.dim));
  console.log(paint(`  rules: ${cfg.hasFile ? "rules.md" : "built-in defaults (no rules.md)"}  ·  ${parsed.length} ${noun}`, C.dim));

  if (!parsed.length) {
    console.log(paint(opts.all ? "\n  No reviewable files found.\n" : "\n  No changes to review.\n", C.dim));
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

  // The optional semantic (LLM) layer — opt-in with --llm + your own key.
  const llmRules = RULES.filter((r) => r.mode === "llm");
  if (!opts.llm) {
    console.log(paint("\n  Semantic layer (optional, not run)", C.bold));
    console.log(paint(`    ${llmRules.length} rules need a model to judge: ${llmRules.map((r) => r.id).join(", ")}`, C.dim));
    console.log(paint("    These catch behaviour-hidden-in-UI, API drift after a bump, and reversed fixes.", C.dim));
    console.log(paint("    Enable with --llm + your own key — core review stays model-free:", C.dim));
    console.log(paint("      export ANTHROPIC_API_KEY=sk-ant-...   then   pointsman review --llm", C.dim));
  } else if (!keyPresent()) {
    console.log(paint("\n  Semantic layer (--llm): no API key found.", C.bold));
    console.log(paint("    Set your key to run it through a model — your account, your cost, the diff is sent to the model:", C.dim));
    console.log(paint("      export ANTHROPIC_API_KEY=sk-ant-...        # required to enable", C.dim));
    console.log(paint("      export POINTSMAN_MODEL=claude-...           # optional: override the model", C.dim));
    console.log(paint("    Nothing is sent anywhere until a key is set and --llm is passed.", C.dim));
  } else if (!rawForModel) {
    console.log(paint("\n  Semantic layer (--llm): runs on a diff, not --all (whole-project model review not wired yet).", C.dim));
  } else {
    console.log(paint(`\n  Semantic layer (--llm): asking ${modelName()} to judge ${llmRules.length} rule(s)…`, C.dim));
    try {
      const sem = await semanticReview(rawForModel, llmRules);
      if (!sem.length) {
        console.log(paint("    model found no additional issues. ✓", C.green));
      } else {
        for (const f of sem) {
          console.log(`  ${paint("🔵 MODEL", C.cyan)} ${paint(f.ruleId || "semantic", C.cyan)} · ${f.note || ""}`);
          console.log(`      ${paint((f.file || "?") + ":" + (f.line != null ? f.line : "?"), C.bold)}  ${paint("[model]", C.cyan)}  ${paint(f.severity || "", C.dim)}`);
        }
      }
    } catch (e) {
      console.log(paint("    model layer error: " + String(e.message || e).split("\n")[0], C.yellow));
    }
  }

  if (opts.gate && blocks > 0) {
    console.log(paint(`\n  Gate: ${blocks} blocking finding(s) — failing.\n`, C.red));
    process.exit(1);
  }
  console.log(paint(opts.gate ? "\n  Gate: no blocking findings. ✓\n" : "\n  (advisor mode — pass --gate or run in CI to block on 🔴)\n", C.dim));
}

module.exports = { review };
