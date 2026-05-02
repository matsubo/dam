# LLM Documentation

Read in this order:

1. **[../../AGENTS.md](../../AGENTS.md)** — orientation, commands, gotchas. Always start here.
2. **[PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)** — architecture in two pages, package map, public surface.
3. **[CODEMAP.md](./CODEMAP.md)** — file index with one-line descriptions. Skim before searching.
4. **[DATA_FLOW.md](./DATA_FLOW.md)** — how a fact moves from upstream → DB → chart.
5. **[RUNBOOK.md](./RUNBOOK.md)** — local dev, debugging, failure recovery.
6. **[CONVENTIONS.md](./CONVENTIONS.md)** — coding style, file naming, commit format.

For product/architectural decisions and open issues, see:

- `../superpowers/specs/2026-05-01-dam-data-platform-design.md` — canonical spec.
- `../superpowers/plans/*.md` — implementation plans (numbered by date).

For workspace-global rules (apply across all projects):

- `~/.claude/CLAUDE.md`
- `~/.claude/rules/*.md`

## Documentation philosophy

- **Source of truth lives in code.** These docs describe *intent* and
  *invariants*; specifics (line counts, type signatures) belong in the
  files themselves.
- **No stale doc**: if a doc and the code disagree, the code wins. Update
  the doc to match.
- **Concrete over abstract.** Examples > prose. File paths > "a service
  somewhere".
- **Honest about gaps.** If a feature doesn't exist or a fixture is
  synthetic, the docs say so.
