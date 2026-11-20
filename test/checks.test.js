"use strict";
/**
 * `pointsman check` tests — black-box over runChecks(dir) against fixture folders.
 * Locks in the secrets gate behaviour: a green .gitignore is NOT enough; a key
 * hardcoded in tracked source must fail the gate (the fix made in 0.4.2).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runChecks } = require("../src/checks");

const CLAUDE = "Agents must ask for permission / approval before any deploy, publish, or delete.\n";
const GITIGNORE = ".env\nnode_modules\n";
const FAKE_KEY = "sk-ant-aaaa1111bbbb2222cccc3333";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-check-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}
const gate = (results, needle) => results.find((r) => r.name.toLowerCase().includes(needle));

test("secrets gate passes on a clean project", () => {
  const dir = fixture({ "CLAUDE.md": CLAUDE, ".gitignore": GITIGNORE, "src/app.ts": "export const x = 1;\n" });
  try {
    const secrets = gate(runChecks(dir), "secrets kept out of source");
    assert.ok(secrets, "the secrets gate should exist");
    assert.strictEqual(secrets.pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets gate FAILS when a key is hardcoded in source (even config is fine)", () => {
  const dir = fixture({
    "CLAUDE.md": CLAUDE,
    ".gitignore": GITIGNORE, // .gitignore is correct — the gate must still catch the in-source key
    "scripts/gen.mjs": `//export ANTHROPIC_API_KEY=${FAKE_KEY}\n`,
  });
  try {
    const secrets = gate(runChecks(dir), "secrets kept out of source");
    assert.strictEqual(secrets.pass, false);
    assert.match(secrets.detail, /scripts\/gen\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent-manual gate fails when no CLAUDE.md is present", () => {
  const dir = fixture({ ".gitignore": GITIGNORE });
  try {
    const manual = gate(runChecks(dir), "agent manual");
    assert.strictEqual(manual.pass, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
