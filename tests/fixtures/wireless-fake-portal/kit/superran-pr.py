#!/usr/bin/env python3
"""E2E 假协作台的候选 PR 提交：与真实 superran-pr.py 同样的参数。

submit 把当前分支推到 origin（本机裸仓库），在 state.json 里登记一个 PR 编号并打印。
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repository", default=os.getcwd())
sub = parser.add_subparsers(dest="command", required=True)
sub.add_parser("status")
start = sub.add_parser("start"); start.add_argument("branch"); start.add_argument("directory")
for name in ("draft", "submit"):
    p = sub.add_parser(name)
    p.add_argument("--base", required=True); p.add_argument("--title", required=True)
    p.add_argument("--summary", required=True); p.add_argument("--report", default="")
args = parser.parse_args()
if not os.environ.get("SUPERRAN_TEAM_CONFIG"):
    raise SystemExit("SUPERRAN_TEAM_CONFIG 未设置：请指向接入包里的 superran-team.json")
repo = Path(args.repository).resolve()
git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, encoding="utf-8")
if args.command == "status":
    print(json.dumps({"user": "lintian-admin", "open_prs": []}, ensure_ascii=False)); raise SystemExit
if args.command == "start":
    r = git("worktree", "add", "-b", args.branch, args.directory, "origin/develop")
    print(r.stdout or r.stderr); raise SystemExit(r.returncode)
branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
head = git("rev-parse", "HEAD").stdout.strip()
if branch in ("HEAD", "develop", "main", ""):
    raise SystemExit("请在任务分支上提交候选（当前：" + branch + "）")
if git("status", "--porcelain").stdout.strip():
    raise SystemExit("工作区还有未提交改动，先 commit 再提交候选")
push = git("push", "origin", branch + ":" + branch)
if push.returncode:
    raise SystemExit("推送失败：" + push.stderr[-300:])
if args.command == "draft":
    print(json.dumps({"draft": True, "branch": branch, "head": head}, ensure_ascii=False)); raise SystemExit
state_file = Path(__file__).with_name("state.json")
state = json.loads(state_file.read_text(encoding="utf-8"))
number = 100 + len(state.setdefault("prs", [])) + 1
state["prs"].append({"number": number, "branch": branch, "head": head, "base": args.base, "title": args.title,
                     "summary": args.summary, "at": time.time()})
tmp = state_file.with_suffix(".prtmp"); tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8"); os.replace(tmp, state_file)
print(json.dumps({"number": number, "branch": branch, "head": head, "url": "e2e://pr/" + str(number)}, ensure_ascii=False, indent=2))
