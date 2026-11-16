#!/usr/bin/env node
/**
 * pointsman — a guardrail gate for building software with AI coding agents.
 *
 *   pointsman init    copy the guardrail templates into this project
 *   pointsman check   check this project has the guardrails (pass/fail; CI-friendly)
 *   pointsman help    show usage
 *
 * Zero dependencies — pure Node, so `npx pointsman` just works.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { runChecks } = require("../src/checks");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATES = path.join(ROOT, "templates");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

function help() {
  console.log(`
${paint("pointsman", C.bold)} — a guardrail gate for building with AI coding agents

${paint("Usage", C.bold)}
  npx pointsman <command>

${paint("Commands", C.bold)}
  ${paint("init", C.cyan)}    Copy the guardrail templates into the current project
  ${paint("check", C.cyan)}   Check the current project has the guardrails (exit 1 on a failed gate)
  ${paint("help", C.cyan)}    Show this message

${paint("In CI", C.bold)} (e.g. a GitHub Action step)
  npx pointsman check
`);
}

/** Recursively copy a directory tree, never overwriting an existing file. */
function copyTree(from, to, report) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst, report);
    } else if (fs.existsSync(dst)) {
      report.skipped.push(path.relative(process.cwd(), dst));
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      report.added.push(path.relative(process.cwd(), dst));
    }
  }
}

function init() {
  const cwd = process.cwd();
  const report = { added: [], skipped: [] };
  copyTree(TEMPLATES, cwd, report);
  console.log(paint("\npointsman init", C.bold));
  report.added.forEach((f) => console.log("  " + paint("+ added", C.green) + "  " + f));
  report.skipped.forEach((f) => console.log("  " + paint("• kept ", C.dim) + "  " + f + paint("  (already there)", C.dim)));
  if (!report.added.length) console.log(paint("  Nothing to add — the guardrails are already here.", C.dim));
  console.log(paint("\nNext: open CLAUDE.md, make the rules yours, then run ", C.dim) + paint("pointsman check", C.cyan) + ".\n");
}

function check() {
  const cwd = process.cwd();
  const results = runChecks(cwd);
  console.log(paint("\npointsman check", C.bold) + paint("  " + cwd, C.dim));
  let failed = 0;
  for (const r of results) {
    const required = r.level === "required";
    if (r.pass) {
      console.log("  " + paint("✓ pass", C.green) + "  " + r.name);
    } else if (required) {
      failed++;
      console.log("  " + paint("✗ FAIL", C.red) + "  " + r.name + paint("  — " + r.detail, C.dim));
    } else {
      console.log("  " + paint("! warn", C.yellow) + "  " + r.name + paint("  — " + r.detail, C.dim));
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(paint(`\n${passed}/${results.length} checks passed, ${failed} required gate(s) failed.\n`, C.bold));
  if (failed > 0) {
    console.log(paint("Gate not met. Run ", C.dim) + paint("pointsman init", C.cyan) + paint(" to add the missing guardrails.\n", C.dim));
    process.exit(1);
  }
}

const cmd = (process.argv[2] || "help").toLowerCase();
if (cmd === "init") init();
else if (cmd === "check") check();
else help();
