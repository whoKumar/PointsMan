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
    changeOnly: true, // "a value path *changed*" — meaningful on a diff, not a static whole-project scan
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
  // ── Security: pattern-detectable, OWASP-style checks (deterministic) ──
  {
    id: "no-wildcard-cors-credentials",
    category: "security",
    severity: "block",
    mode: "deterministic",
    title: "CORS allows any origin with credentials",
    why: "Allowing any origin together with credentials lets any website make authenticated requests as your signed-in users.",
  },
  {
    id: "no-dangerous-html",
    category: "security",
    severity: "warn",
    mode: "deterministic",
    title: "raw HTML injected into the page",
    why: "Rendering unsanitised HTML (dangerouslySetInnerHTML / innerHTML) can run an attacker's script in your users' browsers (XSS).",
  },
  {
    id: "no-token-in-web-storage",
    category: "security",
    severity: "warn",
    mode: "deterministic",
    title: "auth token kept in web / async storage",
    why: "A token in localStorage or AsyncStorage can be read by any injected script; prefer an HttpOnly cookie or a secure store.",
  },
  {
    id: "no-debug-in-prod",
    category: "security",
    severity: "warn",
    mode: "deterministic",
    title: "debug mode left on",
    why: "Debug mode can leak stack traces, config and internals to anyone who triggers an error.",
  },
  {
    id: "no-eval",
    category: "security",
    severity: "warn",
    mode: "deterministic",
    title: "eval / new Function on a string",
    why: "Running a string as code is a direct injection path if any part of it ever comes from user input.",
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
 * Load rule config from a repo's rules.md, if present. Opt-OUT model: every
 * built-in rule runs by default — a guardrail you don't know about can't protect
 * you — so a new release's rules apply even to a repo that already has a rules.md.
 * The file only *tunes*: `severity: block|warn|info` overrides a rule, and
 * `severity: off` disables it. Returns { enabled:Set<id>, severity:{id→sev}, hasFile }.
 */
function loadRules(cwd, fs, path) {
  const allIds = RULES.map((r) => r.id);
  const file = path.join(cwd, "rules.md");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* no file */ }
  if (!text) {
    return { enabled: new Set(allIds), severity: {}, hasFile: false };
  }
  const severity = {};
  const disabled = new Set();
  let lastId = null;
  for (const raw of text.split("\n")) {
    const idm = /^\s*-?\s*id:\s*([a-z0-9-]+)/i.exec(raw);
    if (idm) { lastId = idm[1]; continue; }
    const sm = /^\s*severity:\s*(block|warn|info|off)/i.exec(raw);
    if (sm && lastId) {
      const sev = sm[1].toLowerCase();
      if (sev === "off") disabled.add(lastId);
      else severity[lastId] = sev;
    }
  }
  const enabled = new Set(allIds.filter((id) => !disabled.has(id)));
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

// Word-bounded so "underScores" / "gradeLevel" / "scoreW" don't match on a substring.
const VALUE_PATH = /\b(score|scoring|price|pricing|payment|billing|credit|grade|grading|reward|coin|wallet|refund|charge|payable|discount|amount)\b/i;

function addedLines(file) {
  const out = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === "add") out.push(l);
  return out;
}

// A C-style comment line. The behaviour rules describe `catch`/`return` patterns
// in their own comments and examples — those are prose, not control flow.
function isCommentLine(text) {
  return /^\s*(\/\/|\/\*|\*|<!--)/.test(text);
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
    if (isCommentLine(l.text)) continue; // a `catch {}` shown in a comment/example is not code
    const code = l.text.replace(/\/\/.*$/, ""); // drop a trailing line comment before testing
    // Empty catch braces anywhere on the added line (trailing code after the
    // `{}` — e.g. a function's closing brace — is common and must not hide it).
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(code)) {
      out.push({ ruleId: "no-silent-catch", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

// A line we should not treat as a value-path hit: a comment, a bullet, or markup
// whose only number lives inside a tag (e.g. `<h2>…</h2>`, `<Icon size={12} />`).
function isNoisyValueLine(text) {
  const t = text.trim();
  if (/^(\/\/|\/\*|\*|<!--|#|•)/.test(t)) return true;   // comment / doc / bullet prose
  if (!/\d/.test(t.replace(/<[^>]*>/g, ""))) return true;  // the digit was only inside a tag
  return false;
}

function detectValuePaths(file, out) {
  const lines = addedLines(file);
  // A change inside a value-named file (score/price/grade/credit…) is worth one
  // "confirm intended" flag, regardless of what the line looks like.
  if (VALUE_PATH.test(file.file)) {
    if (lines.length) out.push({ ruleId: "guard-value-paths", file: file.file, line: lines[0].lineNo, snippet: lines[0].text.trim() });
    return;
  }
  // Otherwise, flag a line that both names a value concept and carries a number —
  // but skip comments and markup, where a keyword + digit is almost always noise.
  for (const l of lines) {
    if (VALUE_PATH.test(l.text) && /\d/.test(l.text) && !isNoisyValueLine(l.text)) {
      out.push({ ruleId: "guard-value-paths", file: file.file, line: l.lineNo, snippet: l.text.trim() });
      return; // one finding per file is enough to prompt a look
    }
  }
}

// Words that mark a line as being about a *value* (a score, a grade, money…).
const VALUE_WORD = /\b(score|scoring|grade|grading|marks?|credit|points?|reward|accuracy|amount|price|pay|billing|refund|coin)\b/i;

// A failure default is only a finding when it is actual code (a return/assignment)
// *inside* a catch — not a quoted word in prompt/doc text — AND it defaults a
// *value*. `catch { return false }` on an existence check is correct, common code
// and must not be flagged; `catch { return 0 } // score` is the real smell.
function isSilentZeroLine(text) {
  // Explicitly value-shaped defaults — always a finding.
  if (/\bscore\s*[:=]\s*0\b/i.test(text)) return true;
  if (/\bcorrect\s*[:=]\s*false\b/i.test(text)) return true;
  if (/\b(?:return|[:=])\s*['"](?:incorrect|wrong|fail(?:ed)?)['"]/i.test(text)) return true;
  // Generic `return 0` / `return false` — only when the line is about a value,
  // otherwise it is ordinary control flow (a count, a guard, an existence check).
  if ((/\breturn\s+0\b/.test(text) || /\breturn\s+false\b/.test(text)) && VALUE_WORD.test(text)) return true;
  return false;
}

function detectSilentZero(file, out) {
  for (const h of file.hunks) {
    const added = h.lines.filter((l) => l.kind === "add");
    for (let i = 0; i < added.length; i++) {
      if (isCommentLine(added[i].text)) continue;
      if (!/\bcatch\b/.test(added[i].text)) continue;
      // scan the catch line and the next few lines — a catch body that defaults a
      // result, not a `catch` keyword that merely shares a hunk with the word elsewhere.
      for (let j = i; j < Math.min(i + 7, added.length); j++) {
        if (isCommentLine(added[j].text)) continue;
        if (isSilentZeroLine(added[j].text)) {
          out.push({ ruleId: "no-silent-zero-on-failure", file: file.file, line: added[j].lineNo, snippet: added[j].text.trim() });
          break;
        }
      }
    }
  }
}

// ── Security detectors (OWASP-style, pattern-based) ──

// CORS: a wildcard origin *together with* credentials is the dangerous combo.
function detectCorsCredentials(file, out) {
  const lines = addedLines(file).filter((l) => !isCommentLine(l.text));
  const text = lines.map((l) => l.text).join("\n");
  const wildcard = /allow_origins\s*=\s*\[[^\]]*["']\*["']/i.test(text) ||
    /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/i.test(text);
  const creds = /allow_credentials\s*=\s*True/i.test(text) ||
    /Access-Control-Allow-Credentials["']?\s*[:,]\s*["']?\s*true/i.test(text);
  if (!wildcard || !creds) return;
  const anchor = lines.find((l) => /allow_origins|Allow-Origin/i.test(l.text)) || lines[0];
  out.push({ ruleId: "no-wildcard-cors-credentials", file: file.file, line: anchor.lineNo, snippet: anchor.text.trim() });
}

function detectDangerousHtml(file, out) {
  for (const l of addedLines(file)) {
    if (isCommentLine(l.text)) continue;
    if (/dangerouslySetInnerHTML\s*[=:]/.test(l.text) || /\.(inner|outer)HTML\s*=/.test(l.text)) {
      out.push({ ruleId: "no-dangerous-html", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

function detectTokenInStorage(file, out) {
  for (const l of addedLines(file)) {
    if (isCommentLine(l.text)) continue;
    if (/(localStorage|sessionStorage|AsyncStorage)\s*\.\s*setItem\s*\(/.test(l.text) &&
        /token|jwt|auth|secret|password|session/i.test(l.text)) {
      out.push({ ruleId: "no-token-in-web-storage", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

function detectDebugOn(file, out) {
  for (const l of addedLines(file)) {
    if (isCommentLine(l.text)) continue;
    if (/\bdebug\s*=\s*True\b/.test(l.text) || /\bDEBUG\s*=\s*True\b/.test(l.text) ||
        /\bdebug\s*:\s*true\b/i.test(l.text) || /\.run\([^)]*debug\s*=\s*True/i.test(l.text)) {
      out.push({ ruleId: "no-debug-in-prod", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

function detectEval(file, out) {
  for (const l of addedLines(file)) {
    if (isCommentLine(l.text)) continue;
    if (/\beval\s*\(/.test(l.text) || /\bnew\s+Function\s*\(/.test(l.text)) {
      out.push({ ruleId: "no-eval", file: file.file, line: l.lineNo, snippet: l.text.trim() });
    }
  }
}

const DETECTORS = {
  "no-hardcoded-secrets": detectSecrets,
  "no-silent-catch": detectSilentCatch,
  "guard-value-paths": detectValuePaths,
  "no-silent-zero-on-failure": detectSilentZero,
  "no-wildcard-cors-credentials": detectCorsCredentials,
  "no-dangerous-html": detectDangerousHtml,
  "no-token-in-web-storage": detectTokenInStorage,
  "no-debug-in-prod": detectDebugOn,
  "no-eval": detectEval,
};

/** Mask the middle of a long literal so findings never echo a full secret. */
function redact(text) {
  return text.replace(/(["'])([^"'\s]{12,})(["'])/g, (_m, q, body, q2) =>
    q + body.slice(0, 4) + "…" + body.slice(-2) + q2
  ).trim();
}

// Prose / documentation files: a leaked key in them is real, but the code-pattern
// rules (silent catch, failure defaults, value paths) only produce noise on prose.
const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
function isDocFile(f) { return DOC_EXT.test(f); }

/** Run every enabled deterministic detector over the parsed diff (or whole project). */
function runDeterministic(parsed, cfg, opts = {}) {
  const findings = [];
  for (const file of parsed) {
    const docOnly = isDocFile(file.file);
    for (const rule of RULES) {
      if (rule.mode !== "deterministic") continue;
      if (!cfg.enabled.has(rule.id)) continue;
      // "Did this change?" rules (confirm-the-edit) are meaningless in a static
      // whole-project scan — nothing changed — so skip them under --all.
      if (opts.whole && rule.changeOnly) continue;
      // On docs, only scan for secrets — code-pattern rules don't apply to prose.
      if (docOnly && rule.id !== "no-hardcoded-secrets") continue;
      DETECTORS[rule.id](file, findings);
    }
  }
  // De-dupe: the same line can be reached by more than one detector pass
  // (e.g. two nearby catches windowing onto one `return 0`).
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    const key = f.ruleId + "|" + f.file + "|" + f.line;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  // attach rule metadata + effective severity
  return unique.map((f) => {
    const rule = BY_ID[f.ruleId];
    return {
      ...f,
      category: rule.category,
      title: rule.title,
      why: rule.why,
      severity: cfg.severity[f.ruleId] || rule.severity,
    };
  });
}

module.exports = { RULES, BY_ID, CATEGORIES, loadRules, runDeterministic, redact };
