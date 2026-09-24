"""Bounded account operations. No prompts, downloads, cursor updates or credentials in output."""
import json
import os
import sqlite3
import sys
from pathlib import Path

def _account_name(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return str(json.load(handle).get('account_name') or '')[:80]
    except Exception:
        return ''


def main():
    tool, action, root = sys.argv[1:4]
    sys.path.insert(0, root)
    if tool == 'images':
        from image_pool import pool_root
        db_path = pool_root() / 'queue.sqlite3'
        if action == 'status':
            if not db_path.exists():
                return {'ok': True, 'accounts': []}
            with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=3) as db:
                db.row_factory = sqlite3.Row
                rows = []
                columns = {c['name'] for c in db.execute('PRAGMA table_info(accounts)')}
                group_column = 'login_group' if 'login_group' in columns else "'' AS login_group"
                for a in db.execute('SELECT id,enabled,ready,state,heartbeat,updated,' + group_column + ' FROM accounts ORDER BY id'):
                    r = dict(a)
                    # Display label the tool already stores in plaintext; never a credential.
                    r['account_name'] = _account_name(pool_root() / 'accounts' / str(a['id']) / 'config' / 'settings.json')
                    control = db.execute('SELECT action,status,result,updated FROM controls WHERE account_id=? ORDER BY created DESC LIMIT 1',(a['id'],)).fetchone()
                    if control:
                        value = json.loads(control['result'] or '{}')
                        # Preserve only explicit login proof, never serialize a tool result wholesale.
                        r['login_confirmed'] = value.get('logged_in') is True or value.get('account', {}).get('logged_in') is True
                        r['control_pending'] = control['status'] in ('queued','running')
                        r['checked_at'] = control['updated'] if r['login_confirmed'] else 0
                    rows.append(r)
                return {'ok': True, 'accounts': rows}
        if action not in ('open','check'):
            raise ValueError('unsupported action')
        from image_pool import Pool
        pool = Pool()
        result = pool.control(sys.argv[4], action)
        failures = pool.ensure_workers()
        if failures:
            raise RuntimeError('worker_start_failed')
        return {'ok': result.get('ok', False), 'queued': True}
    if tool == 'bridge':
        import bridge
        cfg = bridge.load_config()
        with bridge.operation_lock():
            # Unlike bridge.status(), this never bootstraps/advances the pull cursor.
            value = bridge._run_code(cfg, bridge._status_code(), timeout=15) if action == 'check' else bridge.open_login(cfg)
        if not isinstance(value, dict):
            raise ValueError('invalid account observation')
        return {'ok': True, 'logged_in': value.get('logged_in') is True,
                'login_required': value.get('login_visible') is True,
                'challenge': value.get('challenge') is True,
                'account_name': str(cfg.get('account_name') or '')[:80]}
    raise ValueError('unsupported tool')

if __name__ == '__main__':
    try:
        result = main()
    except Exception as exc:
        # Exceptions from third-party browser tools can contain tokens or page content.
        result = {'ok': False, 'error': type(exc).__name__}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0 if result.get('ok') else 1)
