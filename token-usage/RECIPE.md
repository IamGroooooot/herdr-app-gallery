# token-usage

Claude and Codex usage in a compact Herdr sidebar, with one settings window.

A personal fork of PostHog's [Claude usage recipe](https://github.com/PostHog/herdr/blob/main/claude-usage/RECIPE.md), shared under its [MIT license](LICENSE).

## What you see

A borderless `Usage · Week` header, one aligned bar and percentage per provider, and each reset time below its bar. The header shows a period only when all reported windows match. Mixed periods are labeled on their own rows. The 124 px sidebar block scrolls for extra limits. A narrow sidebar shows names and percentages.

The optional layout follows Herdr's main layout: spaces and agents on the left, terminals in the center, Files and Changes on the right. The panel sits above the sidebar footer. Colors follow the active theme.

## How it behaves

Click the panel or its settings icon to open Usage settings: Usage, Claude account, and Codex account. Both account pages expose only fields returned by the provider. Login opens its own CLI in a local tab; logout requires confirmation. Claude account also has Connect and Disconnect for its statusline wrapper.

Claude limits come from the statusline payload after a reply. Connect wraps the existing command and preserves its input and output. Codex limits come from local session-log events, checked every 15 seconds. The mod does not read credential files or call account usage endpoints directly. Reports are local snapshots; account changes can leave old limits until a new reply.

Bars use the theme accent, warning, and urgent colors. Expired windows show `--`. Refresh errors retain the last good value and show an error; stale reports are marked. Settings retains Claude's token totals and alert controls.

## Built from

- `layouts/token-usage.json` and its SVG preview; shipped Herdr mods for spaces, tabs, panes, Files and Changes.
- `mods/token-usage/src/types.ts`: common `UsageProvider`, `UsageReport`, and discriminated `AccountState` contracts.
- Provider adapters validate external results; `Resource` shares in-flight reads and preserves the last good value.
- `src/main.ts`: native GPUI view and commands. Generated `.js` files run directly in Herdr.
- Claude statusline/transcript adapter, `tap.sh`, and Python readers for Codex status and session reports.

Runtime requirements: macOS or Linux, Python 3, Herdr, and whichever provider CLIs you use. The mod runs local commands and reads Claude settings/transcripts and Codex session logs outside its own folder. Claude Connect writes its CLI settings only after confirmation. Codex's sanitized cache lives under Herdr's `data/token-usage/`. The shipped JS needs no dependency installation.

## Reuse just the mod

Copy `mods/token-usage/` into your Herdr config. Add this block to a personal layout; clone a shipped layout before editing it:

```json
{"id":"token-usage","type":"block","size":{"px":124},"content":{"mod":"token-usage"}}
```

## Done when

- `herdr-app check ~/.config/herdr-app/mods/token-usage` passes.
- Provider rows show real locally reported limits and reset times.
- Mixed periods are labeled separately; expired windows show `--`.
- Both account tabs show actual sign-in state.
- Claude Connect preserves the existing statusline; Disconnect removes only its wrapper.
- `npm run verify` passes from `mods/token-usage/`.

See [Development](DEVELOPMENT.md) for changing the code.
