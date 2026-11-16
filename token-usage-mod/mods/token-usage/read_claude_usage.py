"""Claude reports use atomic statusline files; freshness is the file's write time."""
import json
import math
import os
import sys
from pathlib import Path

KEYS = ('five_hour', 'seven_day', 'spend_limit')

def read_usage(directory):
    windows, sessions, stamps = {}, {}, {}
    reports, failures = 0, 0
    for path in directory.glob('*.json'):
        try:
            # Writers replace each file atomically; the open descriptor identifies the report.
            with path.open(encoding='utf-8') as stream:
                reported_at = os.fstat(stream.fileno()).st_mtime * 1000
                payload = json.load(stream)
            if not isinstance(payload, dict):
                continue
            reports += 1
            sid = payload.get('session_id') or path.stem
            sessions[sid] = {'transcript': payload.get('transcript_path'), 'model': (payload.get('model') or {}).get('display_name')}
            for key in KEYS:
                w = (payload.get('rate_limits') or {}).get(key)
                if not isinstance(w, dict):
                    continue
                used, resets = w.get('used_percentage'), w.get('resets_at')
                if not all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in (used, resets)):
                    continue
                if not 0 <= used <= 100 or resets <= 0:
                    continue
                candidate = (resets, used, reported_at)
                if candidate > stamps.get(key, (0, 0, 0)):
                    stamps[key] = candidate
                    windows[key] = {'used': used, 'resets': resets}
        except (OSError, ValueError, TypeError, AttributeError):
            failures += 1
    return {'windows': windows, 'sessions': sessions, 'reports': reports,
            'reportedAt': max((s[2] for s in stamps.values()), default=None),
            'error': f'Could not read {failures} Claude reports.' if failures else None}

if __name__ == '__main__':
    print(json.dumps(read_usage(Path(sys.argv[1]))))
