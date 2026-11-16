# Agent operating manual

This file auto-loads for any AI coding agent working in this repo. It is the
agent's rulebook. Keep it short, specific, and current — an agent follows what is
written here, not what you meant.

> Installed by **pointsman**. Make these rules yours, delete what doesn't apply,
> and run `pointsman check` to confirm the guardrails are in place.

---

## 1. How to start a task

Before writing any code, restate the task in 2–3 lines (scope + intent), then
proceed. If the request is ambiguous or could be done more than one way, ask one
focused question instead of guessing.

---

## 2. Approval gate — never do these without explicit, per-action permission

These are hard to reverse or outward-facing. Stop and get a human "go ahead" each
time — approval for one does not carry to the next:

- **Deploy / publish / release** anything (any environment).
- **git push**, force-push, or delete a branch.
- **Delete or overwrite** data, files, or infrastructure.
- **Run a database migration** or any destructive command.
- **Send anything to an external service** (it may be cached or indexed even if
  deleted later).

A local build, test, or dev-server run is **not** gated. Publishing is.

---

## 3. Hard rules (always, regardless of task)

> Replace these with your project's real invariants. Examples of the *kind* of
> rule that belongs here:

- **Secrets never get committed.** Keys/tokens live in env/secret stores, not the
  repo. Add every secret file to `.gitignore`.
- **No silent failures.** Every catch logs what failed; never swallow an error.
- **Contracts are additive.** Don't rename a shipped API field; add a new optional
  one and keep the old as a fallback until the other side migrates.
- **State facts, not guesses.** Report what a command or diff actually showed; if a
  step was skipped or failed, say so.
- _(add yours: platform parity, performance, accessibility, style…)_

---

## 4. Decisions are logged

Every notable choice (a tradeoff, a workaround, a thing that surprised you) gets a
one-line entry in `DECISIONS.md` (or a `memory/` note). The next agent — or you in
a month — should be able to see *why*, not just *what*.

---

## 5. API changes start with a contract

Before an agent wires the client to a new or changed API, write the shape down in
`docs/contracts/<NAME>_CONTRACT.md` (there's a template there). Agree it with
whoever owns the other side first. Client code follows the contract, not a guess.

---

## 6. Design / user-facing changes get flagged first

Any change to how the product looks or behaves for users is flagged to the owner
**before** it ships and recorded in the change log. Don't change the look or the
copy on the agent's own judgement.

---

Keep this file honest and small. A rule nobody enforces is worse than no rule —
`pointsman check` enforces the structural ones.
