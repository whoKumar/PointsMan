# Example `pointsman review` output

What an impact-aware review looks like. Every finding carries an impact class, a
`file:line` anchor, a severity, and a `verified` / `claimed` label so you know
what was read from the diff vs. taken from the author's words.

> This is an **illustrative, anonymised** example — not a real project's output.
> The deterministic layer (zero-dep) produces the `[verified]` findings below;
> the `claimed` note is the kind of thing the optional model layer adds.

---

## Change summary

Commit: `a1b2c3d` — "small UI tidy on the results card"

| Impact | Count |
|---|---|
| cosmetic | 3 |
| behaviour | 1 |
| scoring/money | 1 |
| security | 1 |

**Headline:** the commit is described as cosmetic, but it also changes a scoring
value and re-introduces a secret. Two findings block.

---

## Findings

### 🔴 BLOCK · security · re-introduced secret
`src/services/ai.ts:14` **[verified]** — a literal API key is added back to the bundle.
- Rule: `no-hardcoded-secrets`. Move it server-side; rotate the exposed key.

### 🔴 BLOCK · scoring/money · value change in a "UI" commit
`src/game/score.ts:132` **[verified]** — partial-credit weight changed `0.5 → 1.0`.
- Rule: `guard-value-paths`. Confirm this is intended and call it out — not cosmetic.
- **Test impact:** `TC-004` is now stale (see the test-case update).

### 🟡 WARN · behaviour · failure now scores 0
`src/game/grade.ts:88` **[verified]** — on a grader exception the catch returns `score: 0`.
- Rule: `no-silent-zero-on-failure`. A network blip would mark a correct answer 0.

### 🟡 WARN · behaviour · silent catch
`src/net/upload.ts:61` **[verified]** — `catch {}` swallows the upload error.
- Rule: `no-silent-catch`. Add a log at minimum.

### ⚪ INFO · cosmetic (x3)
Colour tokens and spacing on the results card. No behaviour change.

---

## Author claims (needs the model layer — not independently verified)
- Comment at `score.ts:130` says "display only". **Claimed, not verified** — the
  changed constant is read by the scoring path, so treat with care.
