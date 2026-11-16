import importlib.util
from pathlib import Path
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', PROJECT / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class Install(unittest.TestCase):
    def test_install_conflict_and_backup(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d)
            (target / 'settings.json').write_text('{"zoom":1.2}')
            installer.install(PROJECT, target)
            mod = target / 'mods/token-usage'
            self.assertTrue((mod / 'main.js').exists())
            self.assertFalse((mod / 'node_modules').exists())
            (mod / 'personal.txt').write_text('keep')
            with self.assertRaises(RuntimeError): installer.install(PROJECT, target)
            self.assertEqual((mod / 'personal.txt').read_text(), 'keep')
            backup = installer.install(PROJECT, target, replace=True)
            self.assertEqual((backup / 'token-usage/personal.txt').read_text(), 'keep')
            self.assertEqual((target / 'settings.json').read_text(), '{"zoom":1.2}')
    def test_standalone_mod_package_mirrors_mod(self):
        ignored = {'node_modules', '__pycache__', 'gpui-kit.d.ts', '.DS_Store'}
        def files(root):
            return {p.relative_to(root): p.read_bytes() for p in root.rglob('*')
                    if p.is_file() and not ignored & set(p.relative_to(root).parts) and p.suffix != '.pyc'}
        package = PROJECT.parent / 'token-usage-mod'
        self.assertFalse((package / 'layouts').exists(), 'a mod package must not contain layouts/')
        self.assertEqual(files(package / 'mods/token-usage'), files(PROJECT / 'mods/token-usage'),
                         'token-usage-mod is out of date; run the rsync command in README.md')
    def test_check_failure_restores_old_files(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d)
            installer.install(PROJECT, target)
            mod = target / 'mods/token-usage'
            (mod / 'personal.txt').write_text('keep')
            def fail(_): raise RuntimeError('invalid mod')
            with self.assertRaises(RuntimeError): installer.install(PROJECT, target, replace=True, check=fail)
            self.assertEqual((mod / 'personal.txt').read_text(), 'keep')
            self.assertTrue((target / 'layouts/token-usage.json').exists())
