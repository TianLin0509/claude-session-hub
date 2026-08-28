#!/usr/bin/env python3
"""Resume the current real bridge stress conversation after platform throttling."""

from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tests" / "stress-chatgpt-bridge-real.py"
SPEC = importlib.util.spec_from_file_location("bridge_stress", MODULE_PATH)
stress = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(stress)

stress.URL = json.loads(stress.STRESS_CONFIG.read_text(encoding="utf-8"))["conversation_url"]
SCAN_STATE = stress.OUTPUT / "stress-scan-state.json"
SUMMARY = stress.OUTPUT / "stress-summary.json"


def retry(label, fn, attempts: int = 6):
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - retry only the explicit platform throttle
            text = str(exc)
            throttled = "rate_limited" in text or "Too many requests" in text or "请求过快" in text
            if not throttled or attempt >= attempts:
                raise
            delay = 60
            print(json.dumps({"event": "rate_limit_backoff", "label": label, "attempt": attempt, "sleep_seconds": delay}, ensure_ascii=False), flush=True)
            time.sleep(delay)


def scan_all_messages():
    SCAN_STATE.write_text(json.dumps({"version": 2, "seen_message_ids": []}) + "\n", encoding="utf-8")
    original = stress.STRESS_STATE
    stress.STRESS_STATE = SCAN_STATE
    try:
        return retry("scan_all", lambda: stress.run_bridge("pull", timeout=240))
    finally:
        stress.STRESS_STATE = original


def cases():
    values = [
        ("c2h", "c2h-000256-ascii", 256, False),
        ("c2h", "c2h-004096-unicode", 4096, True),
        ("c2h", "c2h-016384-ascii", 16384, False),
        ("c2h", "c2h-049152-unicode", 49152, True),
        ("c2h", "c2h-066082-ascii", 66082, False),
        ("h2c", "h2c-000512-unicode", 512, True),
        ("h2c", "h2c-008192-ascii", 8192, False),
        ("h2c", "h2c-032768-unicode", 32768, True),
        ("h2c", "h2c-066082-ascii", 66082, False),
    ]
    return [(direction, case_id, stress.make_payload(case_id, size, unicode_mix=unicode_mix))
            for direction, case_id, size, unicode_mix in values]


def main():
    all_cases = cases()
    scan = scan_all_messages()
    existing = {}
    for item in scan.get("items", []):
        content = stress.normalize_text(item.get("content", ""))
        for direction, case_id, expected in all_cases:
            if content.startswith(f"CHATGPT_BRIDGE_STRESS {case_id}\n"):
                existing[case_id] = {
                    "direction": direction,
                    "id": case_id,
                    "bytes": len(expected.encode("utf-8")),
                    "expected_sha256": stress.sha(expected),
                    "actual_sha256": stress.sha(content),
                    "match": content == expected,
                    "message_id": item.get("message_id"),
                    "source": item.get("source"),
                    "transport": item.get("transport"),
                    "evidence": "re-read-existing-message",
                }

    results = []
    for direction, case_id, expected in all_cases:
        row = existing.get(case_id)
        if row and row["match"]:
            results.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            continue
        if direction != "h2c":
            raise AssertionError(f"missing or mismatched existing C2H case: {case_id}")
        payload_file = stress.OUTPUT / f"payload-{case_id}.txt"
        payload_file.write_text(expected, encoding="utf-8", newline="\n")
        pushed = retry(case_id, lambda: stress.run_bridge("push", "--file", str(payload_file), timeout=360))
        extracted = retry(case_id + "-read", lambda: stress.company_extract_message(str(pushed["message_id"]), case_id))
        actual = stress.normalize_text(extracted.get("content", ""))
        row = {
            "direction": direction,
            "id": case_id,
            "bytes": len(expected.encode("utf-8")),
            "expected_sha256": stress.sha(expected),
            "actual_sha256": stress.sha(actual),
            "match": actual == expected,
            "message_id": pushed.get("message_id"),
            "source": extracted.get("source"),
            "transport": "company-page-api-or-copy",
            "evidence": "new-resume-send",
        }
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
        if not row["match"]:
            raise AssertionError(f"H2C mismatch: {case_id}")
        time.sleep(12)

    report = {
        "ok": all(row["match"] for row in results),
        "conversation_url": stress.URL,
        "company_session": stress.COMPANY_SESSION,
        "home_session": stress.HOME_SESSION,
        "total": len(results),
        "passed": sum(1 for row in results if row["match"]),
        "results": results,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    SUMMARY.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "passed": report["passed"], "total": report["total"], "summary": str(SUMMARY)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
