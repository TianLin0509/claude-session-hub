import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager


@contextmanager
def connect(file):
    db = sqlite3.connect(file)
    try:
        with db:
            yield db
    finally:
        db.close()

entry = Path(__file__).resolve().parents[1] / 'scripts' / 'configure-hub-browser-tools.py'
spec = importlib.util.spec_from_file_location('migration', entry)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hub-tool-migration-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        config_dir = self.root / 'pool' / 'accounts' / 'primary' / 'config'
        config_dir.mkdir(parents=True)
        self.config = config_dir / 'settings.json'
        self.original = {'account_name': 'explicit-account', 'cli_entry': 'original.js', 'data_dir': str(self.root / 'data')}
        self.config.write_text(json.dumps(self.original), encoding='utf-8')
        self.db = self.root / 'pool' / 'queue.sqlite3'
        with connect(self.db) as db:
            db.execute('CREATE TABLE accounts(id TEXT,config_dir TEXT)')
            db.execute('INSERT INTO accounts VALUES(?,?)', ('primary', str(config_dir)))
            db.execute('CREATE TABLE jobs(status TEXT)')
        runtime = self.root / 'playwright.js'
        runtime.write_text('fixture')
        self.spec = {'root': str(self.root / 'chrome'), 'hub_repo': str(entry.parents[1]), 'playwright': str(runtime), 'pool_db': str(self.db),
                     'tools': [{'id': 'images-primary', 'tool': 'images', 'identity': 'main', 'config': str(self.config), 'expected_account': 'explicit-account'}]}

    def test_plan_has_no_side_effects_and_account_mismatch_is_rejected(self):
        changes = m.prepare(self.spec)
        self.assertEqual(len(changes), 1)
        self.assertFalse(Path(self.spec['root']).exists())
        self.assertEqual(m.read(self.config), self.original)
        self.spec['tools'][0]['expected_account'] = 'wrong-account'
        with self.assertRaisesRegex(ValueError, 'Account label changed'):
            m.prepare(self.spec)

    def test_apply_preserves_queue_and_settings_and_backs_up_original(self):
        changes = m.prepare(self.spec)
        backup = Path(m.apply(self.spec, changes))
        self.assertEqual(m.read(backup / 'images-primary.json'), self.original)
        updated = m.read(self.config)
        self.assertEqual(updated['data_dir'], self.original['data_dir'])
        self.assertTrue(Path(updated['cli_entry']).is_file())
        self.assertEqual(m.read(Path(self.spec['root']) / 'tool-bindings.json')['tools'][0]['identity'], 'main')
        with connect(self.db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM accounts').fetchone()[0], 1)
        self.config.write_text(json.dumps(dict(updated, unrelated='preserve')))
        m.rollback(backup)
        self.assertEqual(m.read(self.config)['cli_entry'], 'original.js')
        self.assertEqual(m.read(self.config)['unrelated'], 'preserve')

    def test_inflight_work_prevents_any_config_change(self):
        with connect(self.db) as db:
            db.execute('INSERT INTO jobs VALUES(?)', ('running',))
        with self.assertRaisesRegex(RuntimeError, 'pending work'):
            m.apply(self.spec, m.prepare(self.spec))
        self.assertEqual(m.read(self.config), self.original)
        self.assertFalse((Path(self.spec['root']) / 'tool-bindings.json').exists())

    def test_live_worker_and_changed_config_are_not_overwritten(self):
        changes = m.prepare(self.spec)
        with m.lock(self.db.parent / 'worker-primary.lock'):
            with self.assertRaisesRegex(RuntimeError, 'still running'):
                m.apply(self.spec, changes)
        self.config.write_text(json.dumps(dict(self.original, unrelated='new')))
        with self.assertRaisesRegex(RuntimeError, 'changed after planning'):
            m.apply(self.spec, changes)
        self.assertEqual(m.read(self.config)['unrelated'], 'new')


if __name__ == '__main__':
    unittest.main()
