#!/bin/sh
umask 077
dir="$(cd "$(dirname "$0")/../.." && pwd)/data/minimal-token-usage"
payload="$(cat)"
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
if [ -n "$sid" ]; then
  mkdir -p "$dir/sessions"
  at="$(date +%s 2>/dev/null)"
  case "$at" in '' | *[!0-9]*) at=0 ;; esac
  config="$(printf '%s' "${CLAUDE_CONFIG_DIR-}" | sed 's/[\\"]/\\&/g')"
  if tmp="$(mktemp "$dir/sessions/.$sid.XXXXXX")"; then
    { printf '{"reported_at":%s,"config_dir":"%s","report":%s}' "$at" "$config" "$payload" >"$tmp" && mv -f "$tmp" "$dir/sessions/$sid.json"; } || rm -f "$tmp"
  fi
fi
printf '%s' "$payload"
