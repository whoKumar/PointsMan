"use strict";
/**
 * llm.js — the optional semantic layer ("run it through a model").
 *
 * The core review is deterministic, offline, and model-free. This layer is an
 * opt-in add-on: it only does anything when you pass `--llm` AND a key is set.
 * Nothing is ever sent anywhere otherwise.
 *
 * Bring your own key (your account, your cost — the diff is sent to the model):
 *   export ANTHROPIC_API_KEY=sk-ant-...     # required to enable the layer
 *   export POINTSMAN_MODEL=claude-...       # optional: override the default model
 *
 * Zero runtime dependencies — uses the global `fetch` built into Node 18+.
 */

const DEFAULT_MODEL = "claude-sonnet-4-5"; // sensible default; override with POINTSMAN_MODEL
const API_URL = "https://api.anthropic.com/v1/messages";

function keyPresent() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function modelName() {
  return process.env.POINTSMAN_MODEL || DEFAULT_MODEL;
}

async function callModel(system, user, maxTokens = 2000) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable — Node 18+ is required for the model layer");
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Generic client name on purpose — no user or project identity in the request.
      "user-agent": "pointsman-cli",
    },
    body: JSON.stringify({
      model: modelName(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`model API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

/**
 * Judge a diff against the semantic (llm-mode) rules. Returns an array of
 * findings: [{ file, line, ruleId, severity, note }]. Best-effort — returns []
 * if the model replies with nothing parseable.
 */
async function semanticReview(diffText, llmRules) {
  const system =
    "You are a precise code-change reviewer. You judge a unified diff against a fixed list of rules " +
    "and report only concrete, high-confidence findings with a real file and line. No style nits, no speculation. " +
    "Reply with JSON only.";
  const rulesText = llmRules
    .map((r) => `- ${r.id} (${r.severity}): ${r.title} — ${r.why}`)
    .join("\n");
  const user =
    `Rules to check:\n${rulesText}\n\n` +
    `Return a JSON array; each item: {"file","line","ruleId","severity","note"}. ` +
    `Only include a finding you can anchor to a specific added line. If there are none, return [].\n\n` +
    `DIFF:\n${String(diffText).slice(0, 60000)}`;
  const raw = await callModel(system, user, 2000);
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

module.exports = { keyPresent, modelName, callModel, semanticReview, DEFAULT_MODEL };
