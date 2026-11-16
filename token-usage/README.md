# token-usage

Claude Code and Codex usage at a glance in [Herdr](https://herdr.dev): remaining allowance and reset times, side by side.

![Claude Code and Codex usage in Herdr](preview.png)

## Install

Requires Herdr, Python 3, and signed-in Claude Code or Codex CLIs on macOS or Linux.

```sh
git clone https://github.com/IamGroooooot/herdr-app-gallery.git
cd herdr-app-gallery/token-usage
python3 install.py
herdr-app do layout.switch --name token-usage
```

For Claude Code, click the panel to open **Usage settings → Claude account → Connect**. Codex needs no setup. Limits refresh after each reply.

To update, run `git pull` and then `python3 install.py --replace` in the same folder. The installer backs up the files it replaces.

To add only the panel to your own layout, see the [token-usage mod](../token-usage-mod/RECIPE.md). The [recipe](RECIPE.md) describes the layout in full.

## Change the code

Edit the TypeScript in `mods/token-usage/src/`, then run from `mods/token-usage/` in this folder:

```sh
npm ci
npm run verify
```

`verify` type-checks, rebuilds the JS, runs the Node and Python tests, and runs `herdr-app check`. Then copy the mod into the standalone mod package from the repository root:

```sh
rsync -a --delete --exclude node_modules --exclude __pycache__ --exclude gpui-kit.d.ts token-usage/mods/token-usage/ token-usage-mod/mods/token-usage/
```

`python3 -m unittest discover -s tests` in this folder fails while the two copies differ.

A personal fork of PostHog's [Claude usage](https://github.com/PostHog/herdr/blob/main/claude-usage/RECIPE.md), shared under its [MIT license](LICENSE).
