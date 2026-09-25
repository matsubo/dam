# Contributing

Thanks for looking. This repository is public so the data pipeline can be
audited and so anyone can help debug it. The service itself runs at
https://dam.teraren.com and is operated by one person.

## Reporting a problem

Open an issue. The most useful reports include:

- the page URL or API request,
- what you expected and what you saw (a screenshot or the raw number is fine),
- the upstream source you compared against, if any — for example the
  prefecture's dam page showing a different storage rate.

Reports of public data sources we have missed are as welcome as bug reports.
Discord (https://discord.gg/UbWqspWbAk) is fine for questions and discussion.

**Security issues:** do not open a public issue. Use GitHub's
"Report a vulnerability" button on the Security tab instead.

## Running it locally

```sh
just up && just ensure-bucket && just migrate
just dev-web
bun run typecheck && bun run lint && bun run test
```

`AGENTS.md` and `docs/llm/` describe the layout, the data flow and the
invariants that must not break. Read them before changing an ingest task.

## Pull requests

Tests come first: add a failing test that reproduces the bug, then fix it.
Keep one concern per pull request and use the commit format
`<type>: <description>` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`).

## License of contributions

This project is source-available under the
[PolyForm Shield License 1.0.0](LICENSE), not an OSI open-source license.
You may read, run, modify and debug it for any purpose except providing a
product that competes with it — see the Noncompete section of the license.

By submitting a contribution you confirm that you have the right to submit it,
and you grant the maintainer (Yuki Matsukura) a perpetual, worldwide,
non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and
relicense it under any terms, including future versions of this project's
license. You keep the copyright in your contribution.

The project name, the dam.teraren.com domain and the site's logo are not
licensed; a fork must not present itself as this service.
