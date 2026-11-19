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

// ── Progress display ──
// Renders each review pass (scan → secrets → security → failure defaults → impact)
// with a spinner. Disabled in CI / --gate / non-TTY so it never affects a pipeline.
// Duration via POINTSMAN_PACE=<seconds> (0 disables).
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paceStep(label, ms) {
  const start = Date.now();
  let i = 0;
  process.stdout.write("  " + SPIN[0] + " " + label);
  while (Date.now() - start < ms) {
    await sleep(70);
    i = (i + 1) % SPIN.length;
    process.stdout.write("\r\x1b[2K  " + paint(SPIN[i], C.cyan) + " " + label);
  }
  process.stdout.write("\r\x1b[2K  " + paint("✓", C.green) + paint(" " + label, C.dim) + "\n");
}

async function runProgress(parsed, opts) {
  const pace = process.env.POINTSMAN_PACE !== undefined ? Number(process.env.POINTSMAN_PACE) : 20;
  const paced = process.stdout.isTTY && !opts.gate && !process.env.CI && pace > 0;
  if (!paced) return;
  const steps = [
    `scanning ${parsed.length} file(s)`,
    "secrets & hardcoded keys",
    "CORS · XSS · token storage · eval · debug",
    "failure defaults & silent catches",
  ];
  if (!opts.all) steps.push("money / scoring / value paths");
  steps.push("classifying impact");
  const per = Math.max(120, Math.round((pace * 1000) / steps.length));
  console.log("");
  for (const s of steps) await paceStep(s, per);
}

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
  const noun = opts.all ? "scanned" : "changed";
  const rulesLabel = cfg.hasFile ? "rules.md" : "built-in defaults";

  const RULE = "─".repeat(48);
  console.log("\n  " + paint("pointsman review", C.bold) + paint("  ·  " + scope, C.dim));
  console.log(paint(`  ${parsed.length} file(s) ${noun} · ${rulesLabel}`, C.dim));

  if (!parsed.length) {
    console.log(paint(opts.all ? "\n  No reviewable files found.\n" : "\n  No changes to review.\n", C.dim));
    return;
  }

  await runProgress(parsed, opts);

  const findings = runDeterministic(parsed, cfg, { whole: opts.all });
  const order = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const infos = findings.filter((f) => f.severity === "info").length;

  // Headline the reader sees first.
  const summary = [blocks ? paint(`🔴 ${blocks} blocking`, C.red) : paint("✓ 0 blocking", C.green)];
  if (warns) summary.push(paint(`🟡 ${warns} to review`, C.yellow));
  if (infos) summary.push(paint(`⚪ ${infos} note(s)`, C.gray));
  console.log("\n  " + summary.join("    "));

  // Findings, grouped by severity, each with a plain-language risk line.
  const EMO = { block: "🔴", warn: "🟡", info: "⚪" };
  const GROUPS = [
    ["block", "Must fix", "fix before you ship"],
    ["warn", "To review", "confirm these are intended"],
    ["info", "Notes", "minor"],
  ];
  for (const [sev, label, tag] of GROUPS) {
    const g = findings.filter((f) => f.severity === sev);
    if (!g.length) continue;
    console.log(paint(`\n  ${label}`, C.bold) + paint("  ─ " + tag, C.dim));
    for (const f of g) {
      console.log(`    ${EMO[f.severity]} ${paint(f.category, C.cyan)} · ${f.title}`);
      console.log(`       ${paint(f.file + ":" + f.line, C.bold)}  ${paint("· verified", C.green)}`);
      if (f.why) console.log(paint(`       ↳ ${f.why}`, C.dim));
      if (sev === "block" && f.snippet) console.log(paint(`         ${f.snippet.slice(0, 72)}`, C.gray));
    }
  }

  if (!findings.length) {
    console.log(paint(`\n  Nothing flagged across ${parsed.length} ${opts.all ? "files" : "changed file(s)"}. ✓`, C.green));
  }

  // Verdict — a one-line answer, not a list to decode.
  console.log(paint("\n  " + RULE, C.dim));
  if (blocks) {
    console.log("  " + paint(`Verdict: ${blocks} blocking issue${blocks > 1 ? "s" : ""} — fix before you ship.`, C.red));
  } else if (warns || infos) {
    console.log("  " + paint("Verdict: clear to ship", C.green) + paint(` · ${warns + infos} advisory item${warns + infos > 1 ? "s" : ""} worth a look.`, C.dim));
  } else {
    console.log("  " + paint("Verdict: clear — nothing flagged. ✓", C.green));
  }
  if (opts.all) console.log(paint("  Scoring/value surface → pointsman tests --inventory", C.dim));

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
