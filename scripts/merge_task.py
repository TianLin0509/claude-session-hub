#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""主干的唯一入口。

为什么要有这个脚本：
    防覆盖靠两件事 —— ① 各干各的（worktree 隔离，pre-commit 管）
    ② 一次只落一个（单一入口，pre-push 管 + 本脚本执行）。
    合并位 Agent 说 PASS 不算数，**测试由本脚本亲自跑**，跑出来的结果才作数。

为什么必须在主工作目录合：
    SuperRAN 的 editable 安装把 import 路径硬指向主仓库，
    在 worktree 里跑测试拿到的是主仓库的代码，证据是假的。
    所以「合进去 → 跑测试 → 不过就回滚」这一套必须在主目录做。
    AI HUB 没这个问题，但统一走同一条路，少一种情况要记。

用法：
    python scripts/merge_task.py <分支名>
    python scripts/merge_task.py <分支名> --dry-run    # 只验不合

项目差异全部读 .agents/project.json，本脚本对项目一无所知。
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / ".agents" / "project.json"
_MERGE_LOCK_HANDLE = None


def say(msg=""):
    print(msg, flush=True)


def run(cmd, cwd=None, env=None, check=True, capture=True):
    """跑一条命令。capture=False 时把输出直接透给终端（跑测试用）。"""
    e = dict(os.environ)
    if env:
        e.update(env)
    r = subprocess.run(
        cmd, cwd=str(cwd or REPO), env=e, shell=isinstance(cmd, str),
        capture_output=capture, text=True, encoding="utf-8", errors="replace",
    )
    if check and r.returncode != 0:
        out = (r.stdout or "") + (r.stderr or "") if capture else "(输出见上)"
        raise RuntimeError(f"命令失败（退出码 {r.returncode}）：{cmd}\n{out}")
    return r


def git(*args, **kw):
    return run(["git", *args], **kw).stdout.strip()


def acquire_merge_lock():
    """同一仓库一次只允许一个合并进程触碰主工作区。进程退出时 OS 自动释放锁。"""
    global _MERGE_LOCK_HANDLE
    common = Path(git("rev-parse", "--git-common-dir"))
    if not common.is_absolute():
        common = (REPO / common).resolve()
    lock_path = common / "hub-merge-task.lock"
    handle = open(lock_path, "a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return False
    _MERGE_LOCK_HANDLE = handle
    return True


def load_config():
    if not CONFIG.exists():
        say(f"✗ 找不到项目配置：{CONFIG}")
        say("  这个项目还没整理过。先让一个普通 agent 跑 project-prep skill。")
        sys.exit(2)
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except json.JSONDecodeError as ex:
        say(f"✗ 项目配置不是合法 JSON：{ex}")
        sys.exit(2)


def main_worktree():
    line = git("worktree", "list", "--porcelain").splitlines()[0]
    return Path(line.replace("worktree ", "", 1).strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("branch", help="要合并的任务分支")
    ap.add_argument("--dry-run", action="store_true", help="只 rebase 和跑测试，不真合")
    args = ap.parse_args()

    cfg = load_config()
    trunk = cfg.get("trunk") or "master"
    name = cfg.get("name") or REPO.name
    tests = cfg.get("test") or []
    after = cfg.get("afterMerge") or []
    branch = args.branch

    say(f"── {name} · 合并 {branch} → {trunk} ──")
    say()

    if not acquire_merge_lock():
        say("✗ 另一个合并任务正在运行，本次没有触碰主工作区。")
        say("  等前一个结束后再重试；不要并行启动两个合并位。")
        return 2

    # ① 必须在主工作目录 —— 否则 SuperRAN 的测试证据是假的
    here, main_wt = REPO.resolve(), main_worktree().resolve()
    if str(here).lower() != str(main_wt).lower():
        say("✗ 必须在主工作目录跑这个脚本。")
        say(f"  当前：{here}")
        say(f"  主目录：{main_wt}")
        say("  原因：worktree 里的测试可能解析到主仓库的代码，结果不可信。")
        sys.exit(2)

    # ② 主目录必须干净 —— 别人的未提交改动不能被 checkout 冲掉
    dirty = git("status", "--porcelain")
    if dirty:
        say("✗ 主工作目录有未提交的改动，先处理掉再合：")
        for ln in dirty.splitlines()[:10]:
            say(f"    {ln}")
        say("  （这些可能是别人的活，本脚本不会替你决定怎么处理。）")
        sys.exit(2)

    # ③ 分支必须存在
    if run(["git", "rev-parse", "--verify", branch], check=False).returncode != 0:
        say(f"✗ 分支不存在：{branch}")
        sys.exit(2)

    original = git("rev-parse", trunk)
    say(f"① 记下回滚点：{trunk} = {original[:12]}")

    bypass = {"HUB_ALLOW_MAIN_COMMIT": "1", "HUB_ALLOW_TRUNK_PUSH": "1"}
    merged_sha = None

    try:
        git("checkout", trunk, env=bypass)

        # ④ 主干可能已经被别的任务推进过 —— 这是并行开发唯一新增的复杂度
        if run(["git", "remote", "get-url", "origin"], check=False).returncode == 0:
            if run(["git", "fetch", "origin", trunk], check=False).returncode == 0:
                behind = git("rev-list", "--count", f"{trunk}..origin/{trunk}")
                if behind != "0":
                    say(f"   主干落后远端 {behind} 个提交，先对齐")
                    git("merge", "--ff-only", f"origin/{trunk}", env=bypass)
                    original = git("rev-parse", trunk)

        say(f"② 合并 {branch}")
        git("merge", "--no-ff", "--no-edit", branch, env=bypass)
        merged_sha = git("rev-parse", "HEAD")
        say(f"   合成 {merged_sha[:12]}")

        # ⑤ 亲自跑测试 —— 不采信任何 Agent 的说法
        if not tests:
            say("③ 项目没配测试命令，跳过（建议补上）")
        else:
            say(f"③ 跑测试（{len(tests)} 条）")
            for i, t in enumerate(tests, 1):
                say(f"   [{i}/{len(tests)}] {t}")
                r = run(t, check=False, capture=False)
                if r.returncode != 0:
                    raise RuntimeError(f"测试没过：{t}")
            say("   全部通过")

        if args.dry_run:
            say()
            say("④ --dry-run，回滚不真合")
            git("reset", "--hard", original, env=bypass)
            say(f"   已回到 {original[:12]}")
            say()
            say("结论：验证通过，可以合。")
            return 0

    except Exception as ex:
        say()
        say(f"✗ {ex}")
        say()
        say(f"回滚 {trunk} → {original[:12]}")
        run(["git", "merge", "--abort"], check=False)
        run(["git", "reset", "--hard", original], env=bypass, check=False)
        say("已回滚，主干没有被污染。")
        say()
        say("这个分支还在，改完再跑一次本脚本即可。")
        return 1

    # ⑥ 推远端（有就推，没有也不算失败 —— 远端只是备份，不是关卡）
    say("④ 推远端")
    if run(["git", "remote", "get-url", "origin"], check=False).returncode == 0:
        r = run(["git", "push", "origin", trunk], env=bypass, check=False)
        say("   已推送" if r.returncode == 0 else f"   推送失败（本地已合，不影响）：{(r.stderr or '').strip()[:200]}")
    else:
        say("   没配 origin，跳过")

    # ⑦ 合并后动作 —— 项目专属的东西全在这里，脚本本身不知道是什么
    if after:
        say(f"⑤ 合并后动作（{len(after)} 条）")
        for a in after:
            cmd = a.replace("{branch}", branch).replace("{sha}", merged_sha or "")
            say(f"   {cmd}")
            r = run(cmd, check=False, capture=False)
            if r.returncode != 0:
                say("   ⚠ 这条失败了，但代码已经合进去了，不回滚")

    say()
    say(f"✓ 已合并：{branch} → {trunk} @ {merged_sha[:12]}")
    say(f"  撤回：git revert -m 1 {merged_sha[:12]}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\n中断")
        sys.exit(130)
