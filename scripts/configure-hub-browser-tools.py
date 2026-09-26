"""Install reversible CLI bindings. Default is a read-only plan; --apply requires idle tools.

Spec: {root, hub_repo, playwright, pool_db?, tools:[{id,tool,identity,config,expected_account}]}
The operator explicitly binds accounts; names/primary/secondary are never guessed.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".%s.tmp" % os.getpid())
    temp.write_text(value, encoding="utf-8")
    os.replace(temp, path)


@contextlib.contextmanager
def lock(file):
    """Use the tools' own byte locks, released by the OS on process exit."""
    import msvcrt
    with Path(file).open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError("Tool is still running; stop it before applying: " + str(file)) from exc
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def prepare(spec):
    import re
    root, repo = Path(spec["root"]), Path(spec["hub_repo"])
    runtime = repo / "core" / "hub-browser-tool.js"
    if not all(p.is_absolute() for p in (root, repo, Path(spec["playwright"]))) or not runtime.is_file() or not Path(spec["playwright"]).is_file():
        raise ValueError("Absolute existing Hub/runtime paths are required")
    changes, ids, configs = [], set(), set()
    for tool in spec["tools"]:
        if tool["tool"] not in ("images", "bridge") or tool["identity"] not in ("main", "alt") or not re.fullmatch(r"[a-z0-9_-]{1,64}", tool["id"]):
            raise ValueError("Invalid explicit tool binding")
        config = Path(tool["config"])
        if not config.is_absolute() or not config.is_file() or tool["id"] in ids or str(config.resolve()).lower() in configs:
            raise ValueError("Missing or duplicate tool configuration")
        ids.add(tool["id"])
        configs.add(str(config.resolve()).lower())
        value = read(config)
        if "expected_account" not in tool or str(value.get("account_name") or "") != tool["expected_account"]:
            raise ValueError("Account label changed; inspect explicit binding: " + tool["id"])
        binding = {k: tool[k] for k in ("id", "tool", "identity")}
        binding.update(root=str(root), playwright=spec["playwright"])
        wrapper = root / "tool-entrypoints" / (tool["id"] + ".cjs")
        source = "'use strict';\nrequire(%s).main(%s);\n" % (json.dumps(str(runtime)), json.dumps(binding))
        changed = dict(value, cli_entry=str(wrapper))
        changes.append(dict(tool=tool, config=config, before=config.read_bytes(), after=json.dumps(changed, ensure_ascii=False, indent=2), wrapper=wrapper, source=source))
    return changes


def apply(spec, changes, restore_manifest=None):
    root = Path(spec["root"])
    root.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        stack.enter_context(lock(root / "tool-migration.lock"))
        images = [c for c in changes if c["tool"]["tool"] == "images"]
        db = None
        if images:
            db_file = Path(spec["pool_db"])
            if not db_file.is_file():
                raise ValueError("Existing image queue required")
            db = stack.enter_context(contextlib.closing(sqlite3.connect(db_file, timeout=5)))
            stack.enter_context(db)
            db.row_factory = sqlite3.Row
            # Worker byte locks prevent launches while the queue/config changes are committed.
            accounts = {r["config_dir"].lower(): r for r in db.execute("SELECT * FROM accounts")}
            for c in images:
                account = accounts.get(str(c["config"].parent).lower())
                if account is None:
                    raise ValueError("Image binding must belong to a registered queue lane")
                stack.enter_context(lock(db_file.parent / ("launch-" + account["id"] + ".lock")))
                stack.enter_context(lock(db_file.parent / ("worker-" + account["id"] + ".lock")))
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','dispatching','running','needs_attention') LIMIT 1").fetchone():
                raise RuntimeError("Queue has pending work; no configuration changed")
        for c in changes:
            if c["tool"]["tool"] == "bridge":
                stack.enter_context(lock(c["config"].with_suffix(".operation.lock")))
            if c["config"].read_bytes() != c["before"]:
                raise RuntimeError("Configuration changed after planning")
        backup = root / "tool-backups" / str(time.time_ns())
        backup.mkdir(parents=True)
        manifest = root / "tool-bindings.json"
        previous_manifest = read(manifest) if manifest.exists() else {"version": 1, "tools": []}
        write(backup / "transaction.json", json.dumps({"spec": spec, "manifest": previous_manifest}, ensure_ascii=False, indent=2))
        undo = []
        try:
            for c in changes:
                (backup / (c["tool"]["id"] + ".json")).write_bytes(c["before"])
                for file, value in ((c["wrapper"], c["source"]), (c["config"], c["after"])):
                    undo.append((file, file.read_bytes() if file.exists() else None))
                    write(file, value)
            undo.append((manifest, manifest.read_bytes() if manifest.exists() else None))
            touched = {c["tool"]["id"] for c in changes}
            retained = [t for t in previous_manifest.get("tools", []) if t.get("id") not in touched]
            write(manifest, json.dumps(restore_manifest if restore_manifest is not None else {"version": 1, "tools": retained + [dict(id=c["tool"]["id"], tool=c["tool"]["tool"], identity=c["tool"]["identity"], config=str(c["config"]), entry=str(c["wrapper"])) for c in changes]}, indent=2))
        except BaseException:
            for file, before in reversed(undo):
                if before is None:
                    file.unlink(missing_ok=True)
                else:
                    file.write_bytes(before)
            raise
    return str(backup)


def rollback(backup):
    backup = Path(backup)
    transaction = read(backup / "transaction.json")
    spec = transaction["spec"]
    changes = prepare(spec)
    for c in changes:
        current = read(c["config"])
        if current.get("cli_entry") != str(c["wrapper"]):
            raise RuntimeError("Tool entry changed since migration; refusing rollback")
        original = read(backup / (c["tool"]["id"] + ".json"))
        if "cli_entry" in original:
            current["cli_entry"] = original["cli_entry"]
        else:
            current.pop("cli_entry", None)
        c["after"] = json.dumps(current, ensure_ascii=False, indent=2)
    touched = {c["tool"]["id"] for c in changes}
    current_manifest = read(Path(spec["root"]) / "tool-bindings.json")
    restored = {"version": 1, "tools": [t for t in current_manifest.get("tools", []) if t.get("id") not in touched]
                + [t for t in transaction["manifest"].get("tools", []) if t.get("id") in touched]}
    return apply(spec, changes, restore_manifest=restored)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", nargs="?")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", metavar="BACKUP_DIRECTORY")
    args = parser.parse_args()
    if args.rollback:
        print(json.dumps({"rolled_back": True, "backup": rollback(args.rollback)}))
        return
    if not args.spec:
        parser.error("spec is required")
    spec = read(args.spec)
    changes = prepare(spec)
    result = {"applied": False, "tools": [{"id": c["tool"]["id"], "identity": c["tool"]["identity"], "config": str(c["config"]), "sha256": hashlib.sha256(c["before"]).hexdigest()} for c in changes]}
    if args.apply:
        result.update(applied=True, backup=apply(spec, changes))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
