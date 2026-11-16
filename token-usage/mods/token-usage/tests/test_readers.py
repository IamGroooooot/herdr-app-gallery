import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
usage = load('read_codex_usage')
account = load('read_codex_account')
def event(at, used):
    return json.dumps({'timestamp':at,'type':'event_msg','payload':{'type':'token_count','rate_limits':{'limit_id':'codex','primary':{'used_percent':used,'window_minutes':10080,'resets_at':2000000000}}}}).encode()+b'\n'
class Readers(unittest.TestCase):
    def test_no_credentials_in_status_output(self):
        result=account.account_status(0,'Logged in using an API key - sk-test-secret')
        self.assertEqual(result,{'loggedIn':True,'method':'API key'})
        self.assertNotIn('sk-test-secret',json.dumps(account.account_status(1,'unexpected sk-test-secret')))
        self.assertEqual(account.account_status(1,'Not logged in'),{'loggedIn':False})
    def test_missing_cli_and_timeout(self):
        with patch.object(account.subprocess,'run',side_effect=FileNotFoundError):
            self.assertTrue(account.read_account()['missing'])
        with patch.object(account.subprocess,'run',side_effect=account.subprocess.TimeoutExpired('codex',8)):
            self.assertIn('timed out',account.read_account()['error'])
    def test_partial_events_and_newest_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); day=root/'2026/11/16';day.mkdir(parents=True)
            (day/'old.jsonl').write_bytes(event('2026-11-16T00:00:00Z',90))
            (day/'new.jsonl').write_bytes(event('2026-11-16T01:00:00Z',26)+b'{partial')
            self.assertEqual(usage.read_usage(root)['samples'][0]['windows'][0]['used'],26)
    def test_unchanged_logs_use_cache_then_invalidate_on_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); day=root/'2026/11/16';day.mkdir(parents=True)
            log=day/'session.jsonl';log.write_bytes(event('2026-11-16T00:00:00Z',26))
            cache=root/'cache.json'; first=usage.read_usage(root,cache)
            with patch.object(usage,'usage_event',side_effect=AssertionError('unchanged log reparsed')):
                self.assertEqual(usage.read_usage(root,cache),first)
            log.write_bytes(event('2026-11-16T01:00:00Z',27))
            self.assertEqual(usage.read_usage(root,cache)['samples'][0]['windows'][0]['used'],27)
            cache.write_text('{corrupt')
            self.assertEqual(usage.read_usage(root,cache)['samples'][0]['windows'][0]['used'],27)
    def test_invalid_values_do_not_become_usage(self):
        self.assertIsNone(usage.usage_event(b'{bad'))
        self.assertIsNone(usage.usage_event(event('2026-11-16T00:00:00Z',float('nan'))))
        self.assertIsNone(usage.usage_event(event('2026-11-16T00:00:00Z',101)))
