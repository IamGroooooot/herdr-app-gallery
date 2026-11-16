#!/usr/bin/env python3
"""Install this layout and mod; existing files require --replace."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def install(source, config, replace=False, check=None):
    pairs = [(source / 'mods/token-usage', config / 'mods/token-usage'),
             (source / 'layouts/token-usage.json', config / 'layouts/token-usage.json'),
             (source / 'layouts/token-usage.svg', config / 'layouts/token-usage.svg')]
    for src, dst in pairs:
        if not src.exists():
            raise RuntimeError('Missing package file: ' + str(src))
        if dst.exists() and not replace:
            raise RuntimeError(str(dst) + ' already exists. Use --replace to back it up and update it.')
    config.mkdir(parents=True, exist_ok=True)
    backup = None
    if any(dst.exists() for _, dst in pairs):
        backup_root = config / '.token-usage-backups'
        backup_root.mkdir(exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='install-', dir=backup_root))
    placed, saved = [], []
    try:
        for src, dst in pairs:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                saved_path = backup / dst.name
                shutil.move(str(dst), str(saved_path))
                saved.append((saved_path, dst))
            placed.append(dst)
            if src.is_dir():
                shutil.copytree(src, dst, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '*.pyc', 'gpui-kit.d.ts'))
            else:
                shutil.copy2(src, dst)
        if check:
            check(config / 'mods/token-usage')
    except Exception:
        for dst in reversed(placed):
            if dst.is_dir():
                shutil.rmtree(dst)
            elif dst.exists():
                dst.unlink()
        for saved_path, dst in saved:
            shutil.move(str(saved_path), str(dst))
        raise
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', str(Path.home() / '.config/herdr-app'))))
    parser.add_argument('--replace', action='store_true', help='back up and replace this project only')
    args = parser.parse_args()
    if not shutil.which('herdr-app'):
        parser.error('herdr-app must be on PATH. Start Herdr once, then retry.')
    try:
        backup = install(Path(__file__).resolve().parent, args.config.expanduser(), args.replace,
                         lambda mod: subprocess.run(['herdr-app', 'check', str(mod)], check=True))
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')
    print('Installed token-usage. Select its layout, or add its mod to your own layout.')
    if backup:
        print('Backup: ' + str(backup))


if __name__ == '__main__':
    main()
