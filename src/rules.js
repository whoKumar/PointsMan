"use strict";
/**
 * rules.js — the impact-review rule set.
 *
 * Each rule has an id, an impact category, a severity, and a `mode`:
 *   "deterministic" → a zero-dependency detector runs here and now (verified);
 *   "llm"           → needs the optional model layer to judge (not run here).
 *
 * The moat is this rule set + the impact taxonomy + the verified/claimed
 * discipline — not the model. The deterministic detectors below catch the
 * headline failures of fast, agent-written code with no model at all.
 */

// Impact categories, in rough order of how much a reviewer cares.
const CATEGORIES = ["security", "scoring/money", "data", "behaviour", "cosmetic"];

const RULES = [
  {
    id: "no-hardcoded-secrets",
    category: "security",
    severity: "block",
    mode: "deterministic",
    title: "re-introduced or hardcoded secret",
    why: "A key shipped in source can be extracted by anyone; flag it even if it was removed before.",
  },
  {
    id: "no-silent-zero-on-failure",
    category: "behaviour",
    severity: "block",
    mode: "deterministic",
    title: "failure defaults a result to 0 / wrong",
    why: "On an upstream failure, scoring a user 0 penalises them for an outage; prefer an explicit 'unavailable'.",
  },
  {
    id: "guard-value-paths",
    category: "scoring/money",
    severity: "warn", // deterministic layer can see the edit, not the intent → warn, confirm
    mode: "deterministic",
    title: "a money / scoring / credit path changed",
    why: "Changes to value paths must be deliberate and called out, not incidental.",
  },
  {
    id: "no-silent-catch",
    category: "behaviour",
    severity: "warn",
    mode: "deterministic",
    title: "silent catch swallows an error",
    why: "A catch with no logging hides real failures for weeks.",
  },
  // ── Semantic rules: need the optional LLM layer (not run deterministically) ──
  {
    id: "label-behaviour-change",
    category: "behaviour",
    severity: "warn",
    mode: "llm",
    title: "behaviour change hidden in a 'cosmetic' commit",
    why: "A behaviour change framed as UI/colour bypasses review.",
  },
  {
    id: "no-api-mismatch-after-bump",
    category: "behaviour",
    severity: "warn",
    mode: "llm",
    title: "call to an API a dependency bump removed",
    why: "A major bump can remove exports the code still calls.",
  },
  {
    id: "flag-reversed-findings",
    category: "behaviour",
    severity: "info",
    mode: "llm",
    title: "a later change reverses an earlier fix",
    why: "A quiet revert of a recent fix that nobody connected.",
  },
];

const BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

/**
 * Load rule config from a repo's rules.md, if present. The file is prose, so we
 * only read the machine-relevant bits: which rule ids appear, and any
 * `severity:` override. Absent file → built-in defaults (all rules on).
 * Returns { enabled:Set<id>, severity:{id→sev}, hasFile:boolean }.
 */
function loadRules(cwd, fs, path) {
  const file = path.join(cwd, "rules.md");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* no file */ }
  if (!text) {
    return { enabled: new Set(RULES.map((r) => r.id)), severity: {}, hasFile: false };
  }
  const enabled = new Set();
  const severity = {};
  let lastId = null;
  for (const raw of text.split("\n")) {
    const idm = /^\s*-?\s*id:\s*([a-z0-9-]+)/i.exec(raw);
    if (idm) { lastId = idm[1]; enabled.add(lastId); continue; }
    const sm = /^\s*severity:\s*(block|warn|info)/i.exec(raw);
    if (sm && lastId) severity[lastId] = sm[1].toLowerCase();
  }
  // If the file names no known ids, fall back to defaults rather than disabling all.
  if (![...enabled].some((id) => BY_ID[id])) {
    return { enabled: new Set(RULES.map((r) => r.id)), severity, hasFile: true };
  }
  return { enabled, severity, hasFile: true };
}

// ────────────────────────────── detectors ──────────────────────────────
// Each works off the parsed diff's ADDED lines and returns findings:
//   { ruleId, file, line, snippet }

const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/,            // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/,                   // OpenAI-style
  /\bghp_[A-Za-z0-9]{20,}/,                  // GitHub classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,          // GitHub fine-grained PAT
  /\bAIza[A-Za-z0-9_\-]{20,}/,               // Google API key
  /\bAKIA[0-9A-Z]{16}\b/,                    // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,          // Slack token
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
];
const SECRET_FALSE_POSITIVE = /(process\.env|import\.meta\.env|YOUR_|REPLACE_|EXAMPLE|PLACEHOLDER|<[^>]+>|xxxx|\*\*\*\*|\$\{)/i;

const VALUE_PATH = /(score|scoring|price|pricing|payment|billing|credit|grade|grading|reward|coin|wallet|refund|charge|payable|discount|amount)/i;

function addedLines(file) {
  const out = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === "add") out.push(l);
  return out;
}

function detectSecrets(file, out) {
  for (const l of addedLines(file)) {
    if (SECRET_FALSE_POSITIVE.test(l.text)) continue;
    if (SECRET_PATTERNS.some((re) => re.test(l.text))) {
      out.push({ ruleId: "no-hardcoded-secrets", file: file.file, line: l.lineNo, snippet: redact(l.text) });
    }
  }
}

function detectSilentCatch(file, out) {
  for (const l of addedLines(file)) {
    // Empty catch braces anywhere on the added line (trailing code after the
    // `{}` — e.g. a function's closing brace — is common and must not hide it).
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(l.text)) {
      out.push({ ruleId: "no-silent-catch", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

function detectValuePaths(file, out) {
  const lines = addedLines(file);
  // A change inside a value-named file (score/price/grade/credit…) is worth one
  // "confirm intended" flag, regardless of what the line looks like.
  if (VALUE_PATH.test(file.file)) {
    if (lines.length) out.push({ ruleId: "guard-value-paths", file: file.file, line: lines[0].lineNo, snippet: lines[0].text.trim() });
    return;
  }
  // Otherwise, flag a line that both names a value concept and carries a number.
  for (const l of lines) {
    if (VALUE_PATH.test(l.text) && /\d/.test(l.text)) {
      out.push({ ruleId: "guard-value-paths", file: file.file, line: l.lineNo, snippet: l.text.trim() });
      return; // one finding per file is enough to prompt a look
    }
  }
}

function detectSilentZero(file, out) {
  for (const h of file.hunks) {
    const added = h.lines.filter((l) => l.kind === "add");
    const hasCatch = added.some((l) => /\bcatch\b/.test(l.text));
    if (!hasCatch) continue;
    const bad = added.find((l) =>
      /\breturn\s+0\b/.test(l.text) ||
      /\breturn\s+false\b/.test(l.text) ||
      /\bscore\s*[:=]\s*0\b/.test(l.text) ||
      /['"](?:incorrect|wrong|fail(?:ed)?)['"]/i.test(l.text) ||
      /\bcorrect\s*[:=]\s*false\b/.test(l.text)
    );
    if (bad) out.push({ ruleId: "no-silent-zero-on-failure", file: file.file, line: bad.lineNo, snippet: bad.text.trim() });
  }
}

const DETECTORS = {
  "no-hardcoded-secrets": detectSecrets,
  "no-silent-catch": detectSilentCatch,
  "guard-value-paths": detectValuePaths,
  "no-silent-zero-on-failure": detectSilentZero,
};

/** Mask the middle of a long literal so findings never echo a full secret. */
function redact(text) {
  return text.replace(/(["'])([^"'\s]{12,})(["'])/g, (_m, q, body, q2) =>
    q + body.slice(0, 4) + "…" + body.slice(-2) + q2
  ).trim();
}

/** Run every enabled deterministic detector over the parsed diff. */
function runDeterministic(parsed, cfg) {
  const findings = [];
  for (const file of parsed) {
    for (const rule of RULES) {
      if (rule.mode !== "deterministic") continue;
      if (!cfg.enabled.has(rule.id)) continue;
      DETECTORS[rule.id](file, findings);
    }
  }
  // attach rule metadata + effective severity
  return findings.map((f) => {
    const rule = BY_ID[f.ruleId];
    return {
      ...f,
      category: rule.category,
      title: rule.title,
      severity: cfg.severity[f.ruleId] || rule.severity,
    };
  });
}

module.exports = { RULES, BY_ID, CATEGORIES, loadRules, runDeterministic, redact };
