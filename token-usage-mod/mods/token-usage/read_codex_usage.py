"""Read usage events only; never read credentials or emit conversation content."""
import json
import math
import os
import tempfile
import argparse
from datetime import datetime
from pathlib import Path

TAIL_BYTES = 2 * 1024 * 1024


def usage_event(line):
    if b'"token_count"' not in line:
        return None
    try:
        event = json.loads(line)
        payload = event.get("payload", {})
        if event.get("type") != "event_msg" or payload.get("type") != "token_count":
            return None
        limits = payload.get("rate_limits")
        if not isinstance(limits, dict):
            return None
        timestamp = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00")).timestamp()
        windows = []
        for key in ("primary", "secondary"):
            w = limits.get(key)
            if not isinstance(w, dict):
                continue
            used, minutes, resets = (w.get(k) for k in ("used_percent", "window_minutes", "resets_at"))
            if not all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)
                       for n in (used, minutes, resets)):
                continue
            if not 0 <= used <= 100 or minutes <= 0 or resets <= 0:
                continue
            windows.append({"key": key, "used": used, "minutes": minutes, "resets": resets})
        if not windows:
            return None
        return {"at": timestamp, "limit_id": limits.get("limit_id") or "codex",
                "name": limits.get("limit_name"), "windows": windows}
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return None


def read_usage(root, cache_path=None):
    if not root.exists():
        return {"samples": [], "error": "No Codex session logs found."}
    cached = {}
    if cache_path:
        try:
            document = json.loads(cache_path.read_text())
            if document.get("version") == 1:
                cached = document.get("files", {})
            if not isinstance(cached, dict):
                cached = {}
        except (OSError, ValueError, AttributeError):
            pass
    # Bound discovery and reads. Unchanged files require only a stat call.
    days = sorted((p for p in root.glob("*/*/*") if p.is_dir()), reverse=True)[:8]
    candidates = []
    failures = 0
    for day in days:
        for path in day.glob("*.jsonl"):
            try:
                candidates.append((path.stat(), path))
            except OSError:
                failures += 1
    candidates.sort(key=lambda pair: pair[0].st_mtime_ns, reverse=True)
    latest, updated = {}, {}
    for stat, path in candidates[:24]:
        try:
            stamp = [stat.st_mtime_ns, stat.st_size]
            entry = cached.get(str(path))
            if isinstance(entry, dict) and entry.get("stamp") == stamp and isinstance(entry.get("samples"), list):
                samples = entry["samples"]
            else:
                with path.open("rb") as stream:
                    stream.seek(max(0, stat.st_size - TAIL_BYTES))
                    if stat.st_size > TAIL_BYTES:
                        stream.readline()
                    lines = stream.read(TAIL_BYTES).splitlines()
                by_limit = {}
                for line in reversed(lines):
                    sample = usage_event(line)
                    if sample and sample["limit_id"] not in by_limit:
                        by_limit[sample["limit_id"]] = sample
                samples = list(by_limit.values())
            updated[str(path)] = {"stamp": stamp, "samples": samples}
            for sample in samples:
                key = sample["limit_id"]
                if key not in latest or sample["at"] > latest[key]["at"]:
                    latest[key] = sample
        except (OSError, KeyError, TypeError):
            failures += 1
    if cache_path and cached != updated:
        temporary = None
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(prefix=".codex-cache-", dir=cache_path.parent)
            with os.fdopen(fd, "w") as stream:
                json.dump({"version": 1, "files": updated}, stream)
            os.replace(temporary, cache_path)
        except OSError:
            pass  # Optional cache failure must not hide valid usage data.
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    samples = sorted(latest.values(), key=lambda s: (s["limit_id"] != "codex", s["limit_id"]))
    return {"samples": samples, "error": f"Could not read {failures} session logs." if failures else None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    print(json.dumps(read_usage(codex_home / "sessions", args.cache), ensure_ascii=False))
