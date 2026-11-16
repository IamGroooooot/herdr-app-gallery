# token-usage

Claude and Codex remaining allowance and reset times in one compact [Herdr](https://herdr.dev) panel, with shared account settings and an optional layout.

A personal fork of PostHog's [Claude usage](https://github.com/PostHog/herdr/blob/main/claude-usage/RECIPE.md).

## Install

Requires macOS or Linux, Herdr, Python 3, and signed-in Claude Code / Codex CLIs for the accounts you use.

```sh
git clone https://github.com/IamGroooooot/herdr-app-gallery.git
cd herdr-app-gallery/token-usage
python3 install.py
herdr-app do layout.switch --name token-usage
```

In **Usage settings → Claude account**, choose **Connect**. Codex needs no connection setup. Limits update after replies; these are local snapshots.

From `herdr-app-gallery/token-usage`, update with `git pull`, then `python3 install.py --replace` (backs up existing files).

To use the mod in your existing layout, follow [RECIPE.md](RECIPE.md). [Development](DEVELOPMENT.md).
