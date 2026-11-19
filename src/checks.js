"use strict";
/**
 * The guardrail checks. Each returns { name, level, pass, detail }.
 *   level "required"    → a failed one makes `pointsman check` exit 1 (blocks CI)
 *   level "recommended" → a failed one only warns
 *
 * Deterministic and dependency-free. These encode the guardrails that keep
 * agent-driven work safe: a written manual the agent must follow, a human-
 * approval gate before risky actions, secrets out of git, a traceable decision
 * log, and API contracts agreed before any client wiring.
 */
const fs = require("fs");
const path = require("path");
const { collectProject } = require("./scan");
const { loadRules, runDeterministic } = require("./rules");
const { isGitRepo } = require("./diff");

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const firstExisting = (dir, names) => names.find((n) => exists(path.join(dir, n)));

/** Shallow recursive filename search, skipping node_modules/.git. */
function hasFileMatching(dir, re, maxDepth, depth = 0) {
  if (depth > maxDepth) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (e.isDirectory()) {
      if (hasFileMatching(path.join(dir, e.name), re, maxDepth, depth + 1)) return true;
    } else if (re.test(e.name)) {
      return true;
    }
  }
  return false;
}

function runChecks(dir) {
  const results = [];

  // 1. An agent operating manual exists.
  const manualName = firstExisting(dir, [
    "CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md",
  ]);
  const manual = manualName ? read(path.join(dir, manualName)) : "";
  results.push({
    name: "Agent manual present (CLAUDE.md / AGENTS.md)",
    level: "required",
    pass: !!manualName,
    detail: "no agent operating manual at the repo root — the agent has no rules to follow",
  });

  // 2. The manual gates risky actions on human approval.
  const m = manual.toLowerCase();
  const mentionsRisky = /(deploy|publish|release|push to prod|delete|drop |migration)/.test(m);
  const mentionsApproval = /(permission|approve|authori|confirm|without asking|gate)/.test(m);
  results.push({
    name: "Human-approval gate for risky actions (deploy / publish / delete)",
    level: "required",
    pass: !!manualName && mentionsRisky && mentionsApproval,
    detail: manualName
      ? "the manual doesn't clearly require human approval before risky actions"
      : "add the agent manual first",
  });

  // 3. Secrets are kept out of the source — the .gitignore config AND a real scan.
  //    A green .gitignore says nothing about a key hardcoded in a tracked file, so we
  //    run the same secret detector `review` uses; the two can never disagree.
  const gi = read(path.join(dir, ".gitignore"));
  const ignoresEnv = /(^|\n)\s*\.env/.test(gi);
  const ignoresNodeModules = /(^|\n)\s*node_modules/.test(gi);
  const strayEnv = exists(path.join(dir, ".env")) && !ignoresEnv;
  const giOk = !!gi && ignoresEnv && ignoresNodeModules && !strayEnv;
  let secretHit = null;
  try {
    const parsed = collectProject(dir, isGitRepo(dir));
    const cfg = loadRules(dir, fs, path);
    const hits = runDeterministic(parsed, cfg, { whole: true })
      .filter((f) => f.ruleId === "no-hardcoded-secrets");
    if (hits.length) secretHit = hits[0];
  } catch { /* scan is best-effort — the config check still stands on its own */ }
  results.push({
    name: "Secrets kept out of source (.env ignored · no hardcoded keys)",
    level: "required",
    pass: giOk && !secretHit,
    detail: secretHit
      ? `hardcoded secret in ${secretHit.file}:${secretHit.line} — remove it and rotate the key`
      : !gi
      ? "no .gitignore"
      : strayEnv
      ? "a .env file exists but is not git-ignored"
      : "`.gitignore` should ignore .env and node_modules",
  });

  // 4. A decision / change log makes agent choices traceable.
  const hasLog =
    !!firstExisting(dir, ["DECISIONS.md", "CHANGELOG.md", "docs/decisions", "memory"]) ||
    (exists(path.join(dir, "docs")) &&
      (fs.readdirSync(path.join(dir, "docs")).some((f) => /change|decision|log/i.test(f))));
  results.push({
    name: "Decision / change log (agent choices are traceable)",
    level: "recommended",
    pass: !!hasLog,
    detail: "add DECISIONS.md or a memory/ folder so each notable choice is recorded",
  });

  // 5. API contracts are agreed before client wiring.
  const hasContracts =
    exists(path.join(dir, "docs", "contracts")) || hasFileMatching(dir, /_CONTRACT\.md$/i, 3);
  results.push({
    name: "API-contract convention (contracts before client wiring)",
    level: "recommended",
    pass: !!hasContracts,
    detail: "no *_CONTRACT.md / docs/contracts — agree the API shape in a doc before the agent wires it",
  });

  return results;
}

module.exports = { runChecks };
