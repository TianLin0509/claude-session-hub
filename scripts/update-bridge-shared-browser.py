"""Guard the legacy local bridge from hiding a shared ordinary Chrome window.

This is a local compatibility patch, not a company transfer or login operation.
The caller separately enables shared_browser in that bridge's configuration.
"""
import argparse
from pathlib import Path
import shutil

SIGNATURE = 'def _hide_named_browser(cfg: dict[str, Any]) -> bool:\n'
GUARD = '    if cfg.get("shared_browser"):\n        return False\n'


def patched(source):
    if SIGNATURE + GUARD in source:
        return source
    if source.count(SIGNATURE) != 1:
        raise ValueError('Legacy bridge layout changed; preserve it and inspect before patching')
    return source.replace(SIGNATURE, SIGNATURE + GUARD, 1)


def apply(file, backup):
    source = file.read_text(encoding='utf-8')
    after = patched(source)
    if after == source:
        return False
    if backup.exists():
        raise ValueError('Backup already exists; preserve it and inspect before patching')
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, backup)
    temporary = file.with_name(file.name + '.shared-browser.tmp')
    temporary.write_text(after, encoding='utf-8')
    temporary.replace(file)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file', type=Path)
    parser.add_argument('backup', type=Path)
    args = parser.parse_args()
    print({'patched': apply(args.file, args.backup)})
