"use strict";
/**
 * Detector tests — drive the real pipeline (collectProject → runDeterministic),
 * the same path `review --all` and `check` use, so a passing test means the thing
 * users actually run behaves. Zero dependencies: Node's built-in test runner.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { collectProject } = require("../src/scan");
const { loadRules, runDeterministic } = require("../src/rules");

/** Write {relPath: content} into a throwaway dir and return the findings. */
function scan(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    const parsed = collectProject(dir, false);
    return runDeterministic(parsed, loadRules(dir, fs, path), { whole: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const ids = (findings) => findings.map((f) => f.ruleId);

// A clearly fake but pattern-valid Anthropic-style key used across the secret tests.
const FAKE_KEY = "sk-ant-aaaa1111bbbb2222cccc3333";

test("flags a hardcoded Anthropic-style key", () => {
  const f = scan({ "a.ts": `const k = "${FAKE_KEY}";\n` });
  assert.ok(ids(f).includes("no-hardcoded-secrets"));
});

test("flags a secret even when it is commented out", () => {
  const f = scan({ "scripts/gen.mjs": `// setup\n//export ANTHROPIC_API_KEY=${FAKE_KEY}\n` });
  const hit = f.find((x) => x.ruleId === "no-hardcoded-secrets");
  assert.ok(hit, "a key in a comment is still committed and extractable");
  assert.strictEqual(hit.line, 2);
});

test("does NOT flag an env-var reference (no literal)", () => {
  const f = scan({ "a.ts": "const k = process.env.ANTHROPIC_API_KEY;\n" });
  assert.ok(!ids(f).includes("no-hardcoded-secrets"));
});

test("redacts the key so findings never echo the full secret", () => {
  const f = scan({ "a.ts": `const k = "${FAKE_KEY}";\n` });
  const hit = f.find((x) => x.ruleId === "no-hardcoded-secrets");
  assert.ok(hit && !hit.snippet.includes("aaaa1111bbbb2222cccc3333"));
});

test("flags wildcard CORS combined with credentials", () => {
  const f = scan({
    "server.py": 'app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)\n',
  });
  assert.ok(ids(f).includes("no-wildcard-cors-credentials"));
});

test("flags an auth token written to web/async storage", () => {
  const f = scan({ "s.ts": 'localStorage.setItem("authToken", token);\n' });
  assert.ok(ids(f).includes("no-token-in-web-storage"));
});

test("flags eval of a string", () => {
  const f = scan({ "e.js": "const r = eval(userInput);\n" });
  assert.ok(ids(f).includes("no-eval"));
});

test("flags debug mode left on", () => {
  const f = scan({ "settings.py": "DEBUG = True\n" });
  assert.ok(ids(f).includes("no-debug-in-prod"));
});

test("flags dangerouslySetInnerHTML", () => {
  const f = scan({ "C.tsx": "const C = () => <div dangerouslySetInnerHTML={{ __html: bio }} />;\n" });
  assert.ok(ids(f).includes("no-dangerous-html"));
});

test("stays quiet on a clean file", () => {
  const f = scan({ "ok.ts": "export const add = (a, b) => a + b;\n" });
  assert.deepStrictEqual(f, []);
});
