"""Account-page browser binding. Reads metadata only; never copies credentials or sends messages."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

module_spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('configure-hub-browser-tools.py'))
migration = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(migration)

def emit(**value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

def discover(pool, bridge):
    groups, tools = {}, []
    db_file = pool / 'queue.sqlite3'
    if db_file.exists():
        with contextlib.closing(sqlite3.connect(db_file.as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
            db.row_factory = sqlite3.Row
            for row in db.execute('SELECT id,config_dir,login_group FROM accounts ORDER BY id'):
                key = 'images:' + (row['login_group'] or row['id'])
                config = Path(row['config_dir']) / 'settings.json'
                value = migration.read(config)
                group = groups.setdefault(key, dict(id=key, name='网页生图 · ' + (row['login_group'] or row['id']), labels=[], lanes=0))
                label = str(value.get('account_name') or '')
                if label and label not in group['labels']:
                    group['labels'].append(label)
                group['lanes'] += 1
                tools.append(dict(id='images-' + row['id'], lane=row['id'], group=key, tool='images', config=str(config), expected_account=label))
    if bridge.exists():
        value = migration.read(bridge)
        label = str(value.get('account_name') or '')
        groups['bridge'] = dict(id='bridge', name='公司中转', labels=[label] if label else [], lanes=1)
        tools.append(dict(id='company-bridge', group='bridge', tool='bridge', config=str(bridge), expected_account=label))
    return list(groups.values()), tools

def bind(root, repo, pool, bridge, playwright, choices):
    groups, tools = discover(pool, bridge)
    known = {g['id'] for g in groups}
    if not choices or any(k not in known or v not in ('main', 'alt') for k, v in choices.items()):
        raise ValueError('请选择工具对应的 ChatGPT 账号')
    selected = [dict(t, identity=choices[t['group']]) for t in tools if t['group'] in choices]
    spec = dict(root=str(root), hub_repo=str(repo), playwright=str(playwright), pool_db=str(pool / 'queue.sqlite3'), tools=selected)
    changes = migration.prepare(spec)
    stop_files = []
    try:
        if any(t['tool'] == 'images' for t in selected):
            with contextlib.closing(sqlite3.connect((pool / 'queue.sqlite3').as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','dispatching','running','needs_attention') LIMIT 1").fetchone():
                    raise RuntimeError('生图队列仍有在途任务，请等待任务结束后接入；没有取消或重发任务')
        emit(stage='正在等待工具空闲，保留所有任务记录')
        for tool in selected:
            if tool['tool'] == 'images':
                marker = pool / ('stop-' + tool['lane'])
                try:
                    with marker.open('x', encoding='utf-8') as handle:
                        handle.write('Hub account browser migration')
                    stop_files.append(marker)
                except FileExistsError:
                    pass
        # Wait on worker ownership, never terminate a process. Stop markers prevent respawn.
        deadline = time.monotonic() + 35
        while True:
            try:
                with contextlib.ExitStack() as stack:
                    for tool in selected:
                        if tool['tool'] == 'images':
                            stack.enter_context(migration.lock(pool / ('worker-' + tool['lane'] + '.lock')))
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('工具尚未空闲，本次未更改配置；稍后重试')
                time.sleep(.25)

        def close_old(changes):
            emit(stage='正在关闭工具自己的旧页面，登录资料原样保留')
            for change in changes:
                tool = change['tool']
                config = json.loads(change['before'].decode('utf-8-sig'))
                old_entry = config.get('cli_entry')
                if old_entry == str(change['wrapper']):
                    continue
                if not old_entry or not Path(old_entry).is_file():
                    raise RuntimeError('原工具入口不可用，未改变接入配置')
                if tool['tool'] == 'images':
                    cwd = Path(config['data_dir'])
                    session = 'chatgpt-web-images'
                else:
                    cwd = Path(config.get('workspace') or Path.home() / 'tools' / 'chatgpt_bridge')
                    session = config.get('playwright_session', 'chatgpt-bridge')
                with contextlib.ExitStack() as stack:
                    if tool['tool'] == 'images':
                        stack.enter_context(migration.lock(cwd / 'operation.lock'))
                    result = subprocess.run([shutil.which('node.exe') or 'node', old_entry, '--session', session, 'close'], cwd=cwd,
                                            capture_output=True, timeout=35, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    output = (result.stdout + result.stderr).decode('utf-8', errors='replace')
                    if result.returncode and not any(s in output for s in ('is not open', 'No browser session', 'not running')):
                        raise RuntimeError('原工具页面未能安全退出，未更改配置')
            emit(stage='正在保存绑定与回退备份')

        backup = migration.apply(spec, changes, before_apply=close_old)
        return dict(backup=backup, connected=[g for g in choices])
    finally:
        for marker in stop_files:
            marker.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser()
    for name in ('root', 'repo', 'pool', 'bridge', 'playwright'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--choices')
    args = parser.parse_args()
    if not args.choices:
        groups, _ = discover(args.pool, args.bridge)
        emit(ok=True, groups=groups)
    else:
        choices = json.loads(args.choices)
        emit(ok=True, **bind(args.root, args.repo, args.pool, args.bridge, args.playwright, choices))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Paths/labels only, never include captured browser output or credential values.
        emit(ok=False, error=str(exc))
        raise SystemExit(1)
