# The change gate: `review` and `tests`

`pointsman` has two halves. The **set-up gate** (`init` / `check`) makes sure a
repo *has* the guardrails. The **change gate** (`review` / `tests`) watches what
each change actually *does*. This doc covers the second half.

## The bet

Generic "AI reviews your PR" tools are common now. The gap they leave is exactly
the gap that hurts fast, agent-written codebases:

1. **Impact triage** — per change, is this *cosmetic*, or does it move
   *behaviour / money / data / security*? That one answer, with evidence, is what
   a lead or a solo maintainer actually needs.
2. **Living QA** — keep the human-readable test sheet in sync with the code
   instead of letting it rot. Generating cases once is easy; *maintaining* them
   against real changes is the under-solved, valuable part.

The moat is not the model. It is the **rules format** (`rules.md`), the **impact
taxonomy**, and the **verified-vs-claimed discipline** (cite `file:line`, never a
free-floating guess) wrapped around it.

## Two layers

```
  git diff ──►  collect  ──►  load rules.md  ──►  [ deterministic detectors ]  ──►  report
                                                            │                        + test drift
                                                            └─ (optional) model layer ─┘
```

- **Deterministic layer — zero-dep, always on.** Built-in detectors run against
  the diff's added lines and emit `[verified]` findings with real anchors:
  - `no-hardcoded-secrets` — re-introduced / literal keys (known prefixes + assignments);
  - `no-silent-zero-on-failure` — a catch that returns a 0/"wrong" result;
  - `guard-value-paths` — an edit to a scoring / money / credit path (flag to confirm);
  - `no-silent-catch` — an empty catch block.
- **Semantic layer — optional, your API key.** The rules a regex can't judge:
  `label-behaviour-change`, `no-api-mismatch-after-bump`, `flag-reversed-findings`.
  It reads the change with a model (one key, from an env var, never committed),
  re-verifies high-severity claims, and labels `verified` vs `claimed`. The core
  never depends on it.

## The failure modes it targets

Observed repeatedly while auditing a real app built mostly by coding agents
(anonymised). These map 1:1 to the rules in `rules.md`:

- a hardcoded secret **re-introduced** after removal;
- a scoring/logic change **hidden in a "UI" commit**;
- a failure path that scores **0 instead of "unavailable"**;
- **silent `catch`** blocks;
- an **API mismatch** after a dependency bump;
- a fix **reversed by a later commit** nobody connected.

## `tests` — living QA

The test sheet is a file in the repo (`pointsman-tests.csv`). `pointsman tests`:
- seeds the sheet if it is missing;
- reads the diff and reports which areas (by rule finding + file) likely need
  case review — new behaviour → propose, changed → flag stale, cosmetic → none.

Writing and rewriting the cases from a change is the model layer's job; the
zero-dep layer keeps the sheet present and points at the drift.

## Roadmap (honest)

- [x] Deterministic `review` — diff collect, rules load, built-in detectors, report, `--gate`
- [x] `tests` scaffold — seed sheet + drift signals from the diff
- [ ] Model layer — the semantic rules + verified/claimed, behind your API key
- [ ] `.xlsx` export of the test sheet
- [ ] GitHub Action wired end-to-end (inline comments + gate)

## Non-goals (for now)

- Generating runnable automated tests (Jest/Detox). The first test pillar is
  **human QA cases**. Automated-test generation is a noisier effort for later.
- Being a linter. Style is solved; this is about **impact** and **drift**.
