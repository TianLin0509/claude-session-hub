#!/usr/bin/env python3
"""E2E 假协作台：与真实 superran-proposals.py 同样的命令与参数，状态存在本目录 state.json。

只供 tests/e2e-wireless-real-flow.js 使用；不联网、不读任何真实凭据。
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

STATE = Path(__file__).with_name("state.json")
LOCK = Path(__file__).with_name("state.lock")


def locked(fn):
    for _ in range(200):
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            time.sleep(0.05)
    else:
        raise SystemExit("服务返回 503：假协作台忙，请稍后用 retry 重试")
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
        result = fn(state)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, STATE)
        return result
    finally:
        os.close(fd)
        os.unlink(LOCK)


def find(state, pid):
    for p in state["proposals"]:
        if p["id"] == pid:
            return p
    raise SystemExit("服务返回 404：提案不存在")


def event(p, actor, kind, text=""):
    p.setdefault("history", []).append({"at": time.time(), "actor": actor, "kind": kind, "text": text[:2000]})
    p["revision"] = p.get("revision", 1) + 1
    p["updated"] = time.time()


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--allow-local", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "protocol", "whoami"):
        sub.add_parser(name)
    show = sub.add_parser("show"); show.add_argument("id"); show.add_argument("--output"); show.add_argument("--snapshot", action="store_true")
    for name in ("comment", "edit", "withdraw"):
        s = sub.add_parser(name); s.add_argument("id"); s.add_argument("--file", required=True)
        if name == "edit":
            s.add_argument("--title", required=True)
    claim = sub.add_parser("claim"); claim.add_argument("id"); claim.add_argument("--slot", required=True); claim.add_argument("--base", required=True)
    progress = sub.add_parser("progress"); progress.add_argument("id")
    progress.add_argument("--action", choices=["plan", "renew", "release", "report"], required=True)
    progress.add_argument("--file"); progress.add_argument("--note", default=""); progress.add_argument("--pr-number", type=int)
    progress.add_argument("--outcome", choices=["modified", "no_change"], default="")
    retry = sub.add_parser("retry"); retry.add_argument("request_file")
    al = sub.add_parser("align-list"); al.add_argument("--module")
    args = parser.parse_args(argv)
    if hasattr(args, "id") and not re.fullmatch(r"[a-f0-9]{16}", args.id):
        raise SystemExit("提案编号不合法。")
    user = "lintian-admin"
    read = lambda f: Path(f).read_text(encoding="utf-8") if f else ""

    if args.command == "whoami":
        value = {"user": user, "profile": {"id": "e2e0000000000000", "name": "林田"}, "approver": False, "captain": False}
    elif args.command == "protocol":
        value = {"protocol": Path(__file__).with_name("PROPOSALS.md").read_text(encoding="utf-8")}
    elif args.command == "list":
        value = locked(lambda s: {"user": user, "owner": False, "captain": False, "lease_seconds": 7200, "proposals": s["proposals"]})
    elif args.command == "align-list":
        value = {"items": []}
    elif args.command == "show":
        value = locked(lambda s: find(s, args.id))
        if args.output:
            Path(args.output).write_text(value["markdown"], encoding="utf-8")
    elif args.command == "comment":
        def op(s):
            p = find(s, args.id); p.setdefault("comments", []).append({"at": time.time(), "author": user, "markdown": read(args.file)}); event(p, user, "comment", read(args.file)); return {"id": p["id"], "revision": p["revision"]}
        value = locked(op)
    elif args.command == "claim":
        def op(s):
            p = find(s, args.id)
            if p["state"] != "accepted" or p.get("executor"):
                raise SystemExit("服务返回 409：提案不在可接手状态（" + p["state"] + "，执行席位 " + (p.get("executor") or "无") + "）")
            p.update(state="implementing", executor=args.slot, executor_member=user, base=args.base, lease_until=time.time() + 7200)
            event(p, user, "claim", args.slot)
            return {"id": p["id"], "state": p["state"], "executor": p["executor"], "base": p["base"], "lease_until": p["lease_until"]}
        value = locked(op)
    elif args.command == "progress":
        def op(s):
            p = find(s, args.id)
            if p.get("executor_member") != user or p["state"] != "implementing":
                raise SystemExit("服务返回 409：你没有接手这份提案")
            text = read(args.file)
            if args.action in ("plan", "renew"):
                if args.action == "plan":
                    p["plan"] = text or args.note
                p["note"] = args.note or p.get("note", ""); p["lease_until"] = time.time() + 7200
            elif args.action == "release":
                p.update(state="accepted", executor="", executor_member="", note=args.note or text[:200] or "执行端释放")
            else:
                if "### 红灯测试" not in text:
                    raise SystemExit("服务返回 400：交付报告缺少「### 红灯测试」一节")
                if args.outcome == "modified" and not args.pr_number:
                    raise SystemExit("服务返回 400：已修改必须带 --pr-number")
                if args.outcome == "no_change" and args.pr_number:
                    raise SystemExit("服务返回 400：不修改不能带 PR")
                p.update(state="reported", result=text, outcome=args.outcome or "modified", pr_number=args.pr_number, note=args.note)
            event(p, user, args.action, text or args.note)
            return {"id": p["id"], "state": p["state"], "revision": p["revision"]}
        value = locked(op)
    elif args.command == "retry":
        value = {"ok": True}
    else:
        raise SystemExit("服务返回 400：E2E 假协作台不支持 " + args.command)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    if args.command not in ("list", "whoami", "show", "protocol", "align-list"):
        print("云端已回执；不是代码合入证明。", file=sys.stderr)


if __name__ == "__main__":
    main()
