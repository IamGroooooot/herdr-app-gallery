# token-usage

See Claude Code and Codex usage at a glance in [Herdr](https://herdr.dev). Remaining allowance and reset times, side by side.

![Claude Code and Codex usage in Herdr](preview.png)

## Install

Requires Herdr, Python 3, and signed-in Claude Code or Codex CLIs on macOS or Linux.

```sh
git clone https://github.com/IamGroooooot/herdr-app-gallery.git
cd herdr-app-gallery/token-usage
python3 install.py
herdr-app do layout.switch --name token-usage
```

Open **Usage settings → Claude account → Connect** for Claude Code. Codex needs no connection setup. Limits refresh after replies.

To update, run `git pull` and `python3 install.py --replace` from the same folder. Existing files are backed up.

[Use your own layout](RECIPE.md) · [Development](DEVELOPMENT.md)

A personal fork of PostHog's [Claude usage](https://github.com/PostHog/herdr/blob/main/claude-usage/RECIPE.md), shared under its [MIT license](LICENSE).
