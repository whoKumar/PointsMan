# PointsMan

**A guardrail gate for building software with AI coding agents.**
Scaffold the rules into a repo, then check the repo follows them — like ESLint,
but for your *agent setup*. Zero dependencies, no model, no server, no cost.

```bash
npx pointsman init     # add the guardrail files to your project
npx pointsman check    # pass/fail — run it in CI to block unsafe changes
```

---

## Why this exists

I spent a year building and shipping a real, production mobile app almost entirely
by directing AI coding agents. The code wasn't the hard part — keeping it **safe
and sane** was. Agents are fast and literal: left ungoverned they'll deploy
without asking, rename a shipped API field, guess at a backend shape, or quietly
swallow an error that then lives for weeks.

What made it work was a small set of **guardrails** that grew out of real
incidents:

- a feature got built against the wrong internal format because the task was
  ambiguous → **restate the task before coding, ask one question when unsure**;
- a preview-only control leaked into the real app via a deep link → **hard rules
  the agent must always honour**;
- a near-miss deploy → **an explicit human-approval gate on anything risky**;
- client code wired against a backend shape that then changed → **write the API
  contract first, agree it, then wire**;
- choices that no one could later explain → **log every notable decision**.

`pointsman` packages those guardrails so anyone building with agents gets them on
day one instead of learning them the hard way.

## What `init` installs

| File | What it does |
|------|--------------|
| `CLAUDE.md` | The agent's operating manual: how to start, the approval gate, hard rules, decisions, contracts, design flags. |
| `docs/contracts/BACKEND_CONTRACT.template.md` | A contract to fill in before wiring any API. |
| `DECISIONS.md` | A one-line-per-choice log. |
| `.gitignore` | Keeps secrets and `node_modules` out of git. |

(`init` never overwrites a file you already have.)

## What `check` gates

Required (fail → exit 1, blocks CI):
- an **agent manual** is present;
- it **requires human approval** before deploy / publish / delete;
- **secrets are kept out of git**.

Recommended (warn):
- a **decision / change log** exists;
- an **API-contract** convention is in place.

## Use it in CI

```yaml
# .github/workflows/pointsman.yml
name: pointsman
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx pointsman check
```

## Status

Early (v0.1). The checks are deliberately simple and deterministic. Ideas,
issues, and PRs welcome.

## License

MIT.
