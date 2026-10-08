# Contributing

## Run the app locally

1. Clone this repo and run `npm i`.
2. In `example`, run `npm i`.
3. In `example`, run `claude mcp add website_audit -- node ../bin/cli.js mcp --library .`, then open Claude Code there.

## Folder structure

```
bin/         cli.js runs a command or shows help, one file = one command
tools/       one file = one tool
prompts/     one file = one slash command
example/     the starter library users copy
```

## How an audit works

```
audit ⟲ [human answers or skips, AI answers prompts] ─▶ report ⟲ [human decides] ─▶ report.html
```

Each audit lives in `audits/{auditId}/` of the library: `library.json` (a copy of the library), `inputs.json`, `sources/`, `work/`, `findings.json`, `review.json`, `report.html`.

## Writing commands

- Name the file after the command and add it to `cli.js`, `mcp.js` runs as `npx website-audit mcp`.
- Export `commandUsage`, `commandDescription` and `main`, help lists them.
- Throw an error to stop with its message.

## Writing tools

- End a tool where a human acts.
- Share files in the audit folder, never code between tools.
- Export `toolDescription`, `inputSchema`, `outputSchema` and `main`.
- Start the description with what the tool does, then `Step {n}` lines that start with a verb.
- Use plain words, letters and numbers only, and never name another tool.
- Describe every input and output field by the same rules.
- Return every field always, empty as `[]`, `{}` or `""`.
- Give back items with `id`, `target`, `found`, `actual`, `expected` and `evidence`.

## Writing prompts

```yaml
title: {Title}
description: {What it does}
arguments:
  {argumentName}: { description: "{What it is}", required: true }
prompt: |
  {Instructions}
```

- Name the file after the command, `client_audit.yaml` runs as `/mcp__website_audit__client_audit`.
- Use `{{argumentName}}` for an argument and `{{libraryFolder}}` for the full path from `--library`.

## Writing library files

Field rules live in `tools/validate.js`, their meaning in `prompts/library_builder.yaml`.

## Code rules

- Order a file as import, const, exec, fn.
- Put each function right after its first caller.
- Name variables with nouns and functions with verbs, never one word except `main`.
- Write no comments, let names explain the code.
- Add packages with `npm i`, never write versions by hand.

## Gotchas

- Tools load when the server starts, run `/mcp` to reconnect after a change.
- Audit and report take everything on every call, nothing is merged.
- Your local `claude mcp add` wins over the published package in `example/.mcp.json`.

## Suggest a change

Open an issue.
