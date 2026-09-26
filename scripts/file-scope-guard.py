"""
file-scope-guard.py — PreToolUse hook for Edit/Write/MultiEdit

Prevents multiple Hub sessions from editing the same file simultaneously.
Uses a shared claims registry (~/.claude-session-hub/file-claims.json).

Usage:
  - As PreToolUse hook: receives tool_input JSON via stdin
  - As release helper: python file-scope-guard.py --release <session_id>
    (called from session-hub-hook.py on Stop to free all claims)

Protocol:
  - exit 0 with no stdout → allow
  - JSON stdout with permissionDecision:"deny" → block
"""
import json
import os
import sys
import time

CLAIM_TIMEOUT_SEC = 1800  # 30 min
DATA_DIR = os.environ.get(
    "CLAUDE_HUB_DATA_DIR",
    os.path.join(os.path.expanduser("~"), ".claude-session-hub"),
)
CLAIMS_FILE = os.path.join(DATA_DIR, "file-claims.json")


def load_claims():
    if not os.path.exists(CLAIMS_FILE):
        return {}
    try:
        with open(CLAIMS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_claims(claims):
    os.makedirs(os.path.dirname(CLAIMS_FILE), exist_ok=True)
    tmp = CLAIMS_FILE + f".tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(claims, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CLAIMS_FILE)
    except BaseException as error:
        # 2026-09-26：原来只接 OSError。用户按 Esc / Ctrl+C 打断 Claude 时，控制台中断
        # 也会落到正在跑的 hook 进程里 —— KeyboardInterrupt 不是 OSError，`with` 把写了
        # 一半的内容刷进 tmp 后直接穿出去，tmp 永远留在数据目录（生产目录攒了 252 个，
        # 内容都是截断的 JSON）。任何异常都先删自己的 tmp；非 OSError 照常抛出。
        # 进程被硬杀（hook 超时）时这里来不及执行，由 Hub 启动时清理 1 小时前的孤儿。
        try:
            os.unlink(tmp)
        except OSError:
            pass
        if not isinstance(error, OSError):
            raise


def purge_expired(claims):
    now = time.time()
    expired = [fp for fp, c in claims.items()
               if now - c.get("modifiedAt", 0) > CLAIM_TIMEOUT_SEC]
    for fp in expired:
        del claims[fp]
    return claims


def normalize_path(p):
    return os.path.normcase(os.path.normpath(p))


def release_session(session_id):
    """Remove all claims for a session (called on Stop)."""
    claims = load_claims()
    to_remove = [fp for fp, c in claims.items()
                 if c.get("sessionId") == session_id]
    if not to_remove:
        return
    for fp in to_remove:
        del claims[fp]
    save_claims(claims)


def deny(msg):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "additionalContext": msg,
        }
    }))
    sys.exit(0)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--release":
        sid = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CLAUDE_HUB_SESSION_ID", "")
        if sid:
            release_session(sid)
        sys.exit(0)

    session_id = os.environ.get("CLAUDE_HUB_SESSION_ID", "")
    if not session_id:
        sys.exit(0)

    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path:
        sys.exit(0)

    norm_path = normalize_path(file_path)
    now = time.time()

    claims = load_claims()
    claims = purge_expired(claims)

    existing = claims.get(norm_path)
    if existing and existing.get("sessionId") != session_id:
        owner_id = existing.get("sessionId", "unknown")
        owner_title = existing.get("sessionTitle", "")
        age_min = int((now - existing.get("claimedAt", now)) / 60)
        deny(
            f"[file-scope-guard] 文件冲突：{file_path}\n"
            f"已被 Session '{owner_id}'"
            + (f" ({owner_title})" if owner_title else "")
            + f" 占用（{age_min} 分钟前开始编辑）。\n\n"
            f"⚠️ 你必须立即暂停当前任务，将此冲突完整告知用户，等待用户指示后再继续。"
            f"不要自行决定切换文件或绕过，这是用户的决策。\n\n"
            f"用户可选择：\n"
            f"  1. 切换到其他文件\n"
            f"  2. 等待该 Session 完成后重试\n"
            f"  3. 创建 git worktree 隔离工作\n"
            f"  4. 强制释放占用：python ~/.claude/scripts/file-scope-guard.py --release {owner_id}"
        )

    session_title = os.environ.get("CLAUDE_HUB_SESSION_TITLE", "")
    if existing and existing.get("sessionId") == session_id:
        existing["modifiedAt"] = now
    else:
        claims[norm_path] = {
            "sessionId": session_id,
            "sessionTitle": session_title,
            "claimedAt": now,
            "modifiedAt": now,
        }
    save_claims(claims)
    sys.exit(0)


if __name__ == "__main__":
    main()
