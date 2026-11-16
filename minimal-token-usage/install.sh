#!/bin/sh
# Existing files need --replace, which keeps them in a backup folder. A failed install puts everything back.
set -eu

usage() { echo "usage: sh install.sh [--replace] [--config DIR]"; }
fail() {
  echo "$1" >&2
  exit 1
}

config="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
replace=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace) replace=1 ;;
    --config)
      [ "$#" -ge 2 ] || {
        usage >&2
        exit 2
      }
      config="$2"
      shift
      ;;
    --config=*) config="${1#--config=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

command -v herdr-app >/dev/null 2>&1 || fail "herdr-app must be on PATH. Start Herdr once, then retry."
source="$(cd "$(dirname "$0")" && pwd)"
mod=minimal-token-usage
layout=Token-usage
items="mods/$mod layouts/$layout.json layouts/$layout.svg"

existing=0
for item in $items; do
  [ -e "$source/$item" ] || fail "Missing package file: $source/$item"
  [ ! -e "$config/$item" ] || existing=1
  [ ! -e "$config/$item" ] || [ "$replace" = 1 ] || fail "$config/$item already exists. Use --replace to back it up and update it."
done

# Herdr 0.1.16 keeps what a check loads: a panel first loaded by a check of its installed folder never refreshes.
herdr-app check "$source/mods/$mod" || fail "Herdr rejected the mod. Nothing was changed."

# Only what Herdr runs.
copy_mod() {
  mkdir "$2" "$2/icons"
  cp "$1"/*.js "$1/mod.json" "$1/tap.sh" "$2/"
  cp "$1"/icons/*.svg "$2/icons/"
}

backup=""
placed=""
finished=0
undo() {
  [ "$finished" = 0 ] || return 0
  for item in $placed; do rm -rf "${config:?}/$item"; done
  [ -n "$backup" ] || return 0
  for item in $items; do
    if [ -e "$backup/${item##*/}" ]; then mv "$backup/${item##*/}" "$config/$item"; fi
  done
  rmdir "$backup" 2>/dev/null || :
  echo "Nothing was changed." >&2
}
trap undo EXIT
trap 'exit 130' HUP INT TERM

mkdir -p "$config/mods" "$config/layouts"
if [ "$existing" = 1 ]; then
  mkdir -p "$config/.$mod-backups"
  backup="$(mktemp -d "$config/.$mod-backups/install-XXXXXX")"
fi
for item in $items; do
  if [ -e "$config/$item" ]; then mv "$config/$item" "$backup/${item##*/}"; fi
  placed="$placed $item"
  if [ -d "$source/$item" ]; then copy_mod "$source/$item" "$config/$item"; else cp "$source/$item" "$config/$item"; fi
done
finished=1

echo "Installed Minimal Token Usage. Select its layout ($layout), or add its mod to your own layout."
[ -z "$backup" ] || echo "Backup: $backup"
