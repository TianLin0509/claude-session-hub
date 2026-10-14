#!/usr/bin/env python3
"""E2E 假协作台的接入自检：核对两份配置在、身份一致。不改本机登记文件。"""
import argparse
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--expected-user", required=True)
parser.add_argument("--source")
parser.add_argument("--registry")
args = parser.parse_args()
here = Path(__file__).parent
ok = (here / "superran-proposals.json").exists() and (here / "superran-team.json").exists()
if args.expected_user != "lintian-admin":
    raise SystemExit("身份不符：服务器认定的是 lintian-admin")
print(json.dumps({"access_ready": ok, "executor_user": "lintian-admin", "development_user": "lintian-admin",
                  "note": "E2E 假协作台：两份身份一致、云端可达。access_ready 不代表安装或合入成功。"}, ensure_ascii=False, indent=2))
