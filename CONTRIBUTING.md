# Contributing

Issues and pull requests are welcome. For anything bigger than a fix, open an issue first so we
can agree on the approach.

## Setup

Follow the quick start in the [README](README.md). The tests don't need a Supabase project: they
run the app against a fake one.

## Before opening a pull request

- `npm run build` passes. It type-checks the app and the API, then builds.
- `npm test` passes, with a test in `tests/e2e` (or `tests/mcp.mjs`) for what you changed.
- Database changes update `supabase/schema.sql` and add a migration in `supabase/migrations` that
  makes the same change to an existing database.
- Code follows the style around it. Interface text is short and plain.

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), like the rest of Margin.
