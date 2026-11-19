# rules.md — the invariants `pointsman review` checks each change against

These are **your** project's rules, not generic style nits. `pointsman review`
loads this file on every run; the deterministic layer runs the built-in
detectors for the rules below, and the optional model layer judges the semantic
ones. Edit freely — add the invariants that actually matter in this codebase.

Each rule has: an `id`, a `severity` (`block` | `warn` | `info`), a short
`rationale`, and a `detect` hint.

> Every built-in rule runs by default — a guardrail you forgot to list can't
> protect you. This file only *tunes* them: set a `severity:` to change one, or
> `severity: off` to disable it. `block` fails the gate
> (`pointsman review --gate`); `warn` / `info` advise only.

---

## secrets

- id: no-hardcoded-secrets
  severity: block
  rationale: A key shipped in source can be extracted by anyone.
  detect: Any literal API key / token / password added in source. Flag even if it
    was present before — a *re-introduced* secret is a finding. (deterministic)

## failure-defaults

- id: no-silent-zero-on-failure
  severity: block
  rationale: On an upstream failure, defaulting a result to 0 / "wrong" penalises
    the user for an outage.
  detect: A catch/fallback that returns 0 / "incorrect" when the real cause is
    "could not evaluate". Prefer an explicit "unavailable". (deterministic)

## money-and-scoring

- id: guard-value-paths
  severity: warn
  rationale: Changes to money, scoring, credits, or grading must be deliberate.
  detect: An edit to a value-computing path or the constants it reads. Confirm it
    is intended and called out, not incidental. (deterministic — flags for review)

## error-handling

- id: no-silent-catch
  severity: warn
  rationale: A catch that swallows the error hides failures for weeks.
  detect: A `catch` with an empty body. (deterministic)

## behaviour-vs-cosmetic

- id: label-behaviour-change
  severity: warn
  rationale: A behaviour change framed as "UI / colour" bypasses review.
  detect: A change the message calls cosmetic that edits control flow, a numeric
    threshold, a scoring value, or a data write. (needs the model layer)

## dependencies

- id: no-api-mismatch-after-bump
  severity: warn
  rationale: A major dependency bump can remove APIs the code still calls.
  detect: A call to a dependency symbol that no longer exists after an upgrade.
    (needs the model layer)

## consistency-across-commits

- id: flag-reversed-findings
  severity: info
  rationale: A later change can quietly undo an earlier fix.
  detect: A change that reverts or contradicts a recently merged fix.
    (needs the model layer)

## web-and-app-security

- id: no-wildcard-cors-credentials
  severity: block
  rationale: Any origin plus credentials lets any website act as your signed-in users.
  detect: CORS allow_origins "*" together with allow_credentials true. (deterministic)

- id: no-dangerous-html
  severity: warn
  rationale: Unsanitised HTML can run an attacker's script in the browser (XSS).
  detect: dangerouslySetInnerHTML / innerHTML set from a non-constant. (deterministic)

- id: no-token-in-web-storage
  severity: warn
  rationale: A token in localStorage / AsyncStorage is readable by any injected script.
  detect: setItem of a token / jwt / auth value into web or async storage. (deterministic)

- id: no-debug-in-prod
  severity: warn
  rationale: Debug mode can leak stack traces, config and internals on an error.
  detect: debug = True / DEBUG = True / debug: true. (deterministic)

- id: no-eval
  severity: warn
  rationale: Running a string as code is an injection path if any part is user input.
  detect: eval( / new Function( on a string. (deterministic)

---

## Notes

- Keep rules few and real. Ten a reviewer actually checks beat a hundred that
  produce noise.
- Add project-specific invariants here (platform-parity rules, "all writes go
  through X", naming constraints). That curation is where the value is.
