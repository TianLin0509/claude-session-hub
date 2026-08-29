#!/usr/bin/env python3
"""Real two-browser stress matrix for the ChatGPT company bridge.

`chatgpt-company-sim` is the company-side browser. `chatgpt-bridge` is the
home-side browser consumed through bridge.py. Both use the same ChatGPT account
and conversation but separate browser contexts.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "playwright" / "chatgpt-bridge-stress"
OUTPUT.mkdir(parents=True, exist_ok=True)
BRIDGE = Path(r"C:\Users\lintian\tools\chatgpt_bridge\bridge.py")
DEFAULT_CONFIG = json.loads(Path(r"C:\VibeData\ChatGPTBridge\config.json").read_text(encoding="utf-8"))
STRESS_CONFIG = OUTPUT / "stress-config.json"
STRESS_STATE = OUTPUT / "stress-state.json"
URL = ""
COMPANY_SESSION = "chatgpt-company-sim"
HOME_SESSION = "chatgpt-bridge"
NPX = shutil.which("npx.cmd") or shutil.which("npx")
if not NPX:
    raise SystemExit("npx not found")


def parse_cli(stdout: str):
    envelope = json.loads(stdout.strip())
    result = envelope.get("result")
    if isinstance(result, str):
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            return result
    return result


def run_code(session: str, source: str, timeout: int = 120):
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
            handle.write(source)
            path = Path(handle.name)
        cmd = [
            NPX, "--yes", "--package", "@playwright/cli", "playwright-cli",
            "--session", session, "--json", "run-code", "--filename", str(path),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"playwright-cli failed: {proc.stderr[-2000:]} {proc.stdout[-2000:]}")
        return parse_cli(proc.stdout)
    finally:
        if path:
            path.unlink(missing_ok=True)


def run_bridge(*args: str, timeout: int = 180):
    proc = subprocess.run(
        [os.fspath(Path(os.sys.executable)), os.fspath(BRIDGE), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        env={
            **os.environ,
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "CHATGPT_BRIDGE_CONFIG": str(STRESS_CONFIG),
            "CHATGPT_BRIDGE_STATE": str(STRESS_STATE),
        },
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"bridge returned no JSON: {proc.stderr[-2000:]}")
    result = json.loads(lines[-1])
    if proc.returncode != 0 or result.get("ok") is not True:
        raise RuntimeError(f"bridge failed: {json.dumps(result, ensure_ascii=False)}")
    return result


def make_payload(case_id: str, target_bytes: int, *, unicode_mix: bool) -> str:
    header = f"CHATGPT_BRIDGE_STRESS {case_id}\n"
    footer = f"\nEND_CHATGPT_BRIDGE_STRESS {case_id}"
    budget = max(0, target_bytes - len(header.encode()) - len(footer.encode()))
    chunks: list[str] = []
    used = 0
    index = 0
    while used < budget:
        digest = hashlib.sha256(f"{case_id}:{index}".encode()).hexdigest()
        if unicode_mix:
            chunk = f"{index:05d}|无线仿真/SRS/±45°/αβγ|{digest}|```code```\n"
        else:
            chunk = f"{index:05d}|{digest}|ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n"
        encoded = chunk.encode("utf-8")
        if used + len(encoded) > budget:
            remaining = budget - used
            # The tail is ASCII so byte slicing remains valid even for unicode_mix.
            tail = (digest * ((remaining // len(digest)) + 1))[:remaining]
            chunks.append(tail)
            used += len(tail)
            break
        chunks.append(chunk)
        used += len(encoded)
        index += 1
    payload = header + "".join(chunks) + footer
    return payload


def create_stress_conversation():
    prompt = "本会话仅用于两台电脑之间的ChatGPT桥接压力测试。以后粘贴的内容不要分析、改写或摘要；原样保留，长内容可以转为文本附件。收到后只回复 READY。"
    source = f"""async (page) => {{
  await page.goto('https://chatgpt.com/', {{ waitUntil: 'domcontentloaded', timeout: 45000 }});
  const box = page.getByRole('textbox', {{ name: /Chat with ChatGPT|Message ChatGPT/ }}).last();
  await box.waitFor({{ state: 'visible', timeout: 30000 }});
  await box.fill({json.dumps(prompt, ensure_ascii=False)});
  const send = page.getByRole('button', {{ name: /^(Send prompt|Send message)$/ }}).last();
  await send.waitFor({{ state: 'visible', timeout: 15000 }});
  await send.click();
  await page.waitForURL(/chatgpt\\.com\\/c\\//, {{ timeout: 45000 }});
  await page.waitForSelector('[data-message-author-role="user"]', {{ timeout: 30000 }});
  await page.waitForFunction(() => location.pathname.startsWith('/c/')
    && !location.href.includes('WEB:') && !location.href.includes('WEB%3A'), null, {{ timeout: 60000 }});
  await page.waitForTimeout(800);
  await page.screenshot({{ path: {json.dumps(str(OUTPUT / '00-stress-conversation-ready.png'))}, fullPage: false }});
  return {{ url: page.url(), title: await page.title() }};
}}"""
    return run_code(COMPANY_SESSION, source, timeout=210)


def company_send(payload: str, case_id: str):
    source = f"""async (page) => {{
  const url = {json.dumps(URL, ensure_ascii=False)};
  const payload = {json.dumps(payload, ensure_ascii=False)};
  await page.goto(url, {{ waitUntil: 'domcontentloaded', timeout: 45000 }});
  const userSelector = '[data-testid^="conversation-turn-"] [data-message-author-role="user"]';
  await page.waitForSelector(userSelector, {{ timeout: 30000 }});
  const beforeIds = await page.locator(userSelector).evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('data-message-id')
      || node.closest('[data-turn-id]')?.getAttribute('data-turn-id')
      || ''
  ).filter(Boolean));
  const box = page.getByRole('textbox', {{ name: /Chat with ChatGPT|Message ChatGPT/ }}).last();
  await box.waitFor({{ state: 'visible', timeout: 20000 }});
  const editableDeadline = Date.now() + 120000;
  while (!(await box.isEditable().catch(() => false)) && Date.now() < editableDeadline) await page.waitForTimeout(500);
  if (!(await box.isEditable().catch(() => false))) throw new Error('company composer remained non-editable');
  await box.fill('');
  await box.click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {{ origin: 'https://chatgpt.com' }}).catch(() => {{}});
  await page.evaluate(async value => navigator.clipboard.writeText(value), payload);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(900);
  const send = page.getByRole('button', {{ name: /^(Send prompt|Send message)$/ }}).last();
  await send.waitFor({{ state: 'visible', timeout: 60000 }});
  await send.click();
  await page.waitForFunction(
    existing => Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"] [data-message-author-role="user"]')).some(node => {{
      const id = node.getAttribute('data-message-id') || node.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
      return id && !existing.includes(id);
    }}),
    beforeIds,
    {{ timeout: 45000 }}
  );
  const messageIds = await page.locator(userSelector).evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('data-message-id')
      || node.closest('[data-turn-id]')?.getAttribute('data-turn-id')
      || ''
  ).filter(Boolean));
  const messageId = messageIds.filter(id => !beforeIds.includes(id)).at(-1) || '';
  const last = page.locator(`[data-message-id="${{messageId}}"]`).first();
  const turn = last.locator('xpath=ancestor::*[starts-with(@data-testid,"conversation-turn-")][1]');
  const testId = await turn.getAttribute('data-testid');
  const labels = await turn.locator('button[aria-label]').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')).filter(Boolean));
  await page.screenshot({{ path: {json.dumps(str(OUTPUT / f'company-{case_id}.png'))}, fullPage: false }});
  return {{ message_id: messageId, turn: Number((testId || '').match(/(\\d+)$/)?.[1] || 0), attachment_labels: labels }};
}}"""
    return run_code(COMPANY_SESSION, source, timeout=120)


def company_extract_message(message_id: str, case_id: str):
    source = f"""async (page) => {{
  const url = {json.dumps(URL, ensure_ascii=False)};
  const messageId = {json.dumps(str(message_id))};
  await page.goto(url, {{ waitUntil: 'domcontentloaded', timeout: 45000 }});
  const author = page.locator(`[data-message-id="${{messageId}}"]`).first();
  await author.waitFor({{ state: 'visible', timeout: 30000 }});
  const turn = author.locator('xpath=ancestor::*[starts-with(@data-testid,"conversation-turn-")][1]');
  const rawAttachment = await page.evaluate(async (args) => {{
    try {{
      const auth = await (await fetch('/api/auth/session')).json();
      const accessToken = String(auth.accessToken || '');
      const conversationId = args.url.split('?')[0].split('/').filter(Boolean).at(-1);
      const conversation = await (await fetch(`/backend-api/conversation/${{conversationId}}`, {{
        headers: {{ Authorization: `Bearer ${{accessToken}}` }}, credentials: 'include',
      }})).json();
      const message = Object.values(conversation.mapping || {{}}).map(node => node && node.message)
        .find(value => value && value.id === args.messageId);
      const attachment = message && message.metadata && Array.isArray(message.metadata.attachments)
        ? message.metadata.attachments[0] : null;
      if (!attachment) return null;
      const fileId = attachment.id || attachment.file_id;
      const meta = await (await fetch(`/backend-api/files/${{fileId}}/download`, {{
        headers: {{ Authorization: `Bearer ${{accessToken}}` }}, credentials: 'include',
      }})).json();
      const response = await fetch(meta.download_url, {{ credentials: 'include' }});
      const raw = await response.arrayBuffer();
      return {{
        source: 'text_attachment', filename: attachment.name || 'attachment.txt',
        content: new TextDecoder('utf-8').decode(raw),
      }};
    }} catch (_) {{ return null; }}
  }}, {{ url, messageId }});
  if (rawAttachment) {{
    await page.screenshot({{ path: {json.dumps(str(OUTPUT / f'home-to-company-{case_id}.png'))}, fullPage: false }});
    return rawAttachment;
  }}
  const buttons = await turn.locator('button[aria-label]').all();
  const textExt = /\\.(txt|md|markdown|json|jsonl|csv|tsv|log)$/i;
  for (const button of buttons) {{
    const filename = (await button.getAttribute('aria-label')) || '';
    if (!textExt.test(filename)) continue;
    await button.click();
    const close = page.getByRole('button', {{ name: /^(Close|关闭)$/ }}).last();
    await close.waitFor({{ state: 'visible', timeout: 10000 }});
    const modal = close.locator('xpath=../../..');
    const body = modal.locator(':scope > div').first();
    const handle = await body.elementHandle();
    await page.waitForFunction(el => {{
      const value = String(el && el.innerText || '').trim();
      return value && value !== 'Loading file content';
    }}, handle, {{ timeout: 30000 }});
    const content = await body.innerText();
    await page.screenshot({{ path: {json.dumps(str(OUTPUT / f'home-to-company-{case_id}.png'))}, fullPage: false }});
    await close.click();
    return {{ source: 'text_attachment', filename, content }};
  }}
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {{ origin: 'https://chatgpt.com' }}).catch(() => {{}});
  const oldClipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  await turn.hover().catch(() => {{}});
  const copy = turn.getByRole('button', {{ name: 'Copy message' }}).first();
  await copy.waitFor({{ state: 'attached', timeout: 15000 }}).catch(() => {{}});
  let content = '';
  if (await copy.count()) {{
    await copy.click({{ force: true }});
    await page.waitForTimeout(750);
    content = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    await page.evaluate(value => navigator.clipboard.writeText(value), oldClipboard).catch(() => {{}});
  }}
  if (!content) content = (await author.innerText()).trim();
  await page.screenshot({{ path: {json.dumps(str(OUTPUT / f'home-to-company-{case_id}.png'))}, fullPage: false }});
  return {{ source: 'inline_text', filename: null, content }};
}}"""
    return run_code(COMPANY_SESSION, source, timeout=120)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_text(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


def main() -> None:
    global URL
    stress_chat = create_stress_conversation()
    URL = str(stress_chat["url"])
    config = {
        "version": 1,
        "conversation_url": URL,
        "conversation_id": URL.rstrip("/").split("/")[-1],
        "playwright_session": HOME_SESSION,
        "storage_state_path": DEFAULT_CONFIG["storage_state_path"],
        "max_text_bytes": DEFAULT_CONFIG.get("max_text_bytes", 1024 * 1024),
    }
    STRESS_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    STRESS_STATE.unlink(missing_ok=True)
    bootstrap = run_bridge("status", timeout=180)
    matrix = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "conversation_url": URL,
        "company_session": COMPANY_SESSION,
        "home_session": HOME_SESSION,
        "bootstrap": bootstrap,
        "c2h": [],
        "h2c": [],
    }

    c2h_cases = [
        ("c2h-000256-ascii", 256, False),
        ("c2h-004096-unicode", 4096, True),
        ("c2h-016384-ascii", 16384, False),
        ("c2h-049152-unicode", 49152, True),
        ("c2h-066082-ascii", 66082, False),
    ]
    for case_id, size, unicode_mix in c2h_cases:
        payload = make_payload(case_id, size, unicode_mix=unicode_mix)
        expected_sha = sha(payload)
        t0 = time.perf_counter()
        sent = company_send(payload, case_id)
        t1 = time.perf_counter()
        pulled = run_bridge("pull", timeout=180)
        t2 = time.perf_counter()
        actual = normalize_text(pulled.get("content", ""))
        row = {
            "id": case_id,
            "bytes": len(payload.encode("utf-8")),
            "expected_sha256": expected_sha,
            "actual_sha256": sha(actual),
            "match": actual == payload,
            "company_turn": sent.get("turn"),
            "company_message_id": sent.get("message_id"),
            "company_attachment_labels": sent.get("attachment_labels", []),
            "pull_sources": [item.get("source") for item in pulled.get("items", [])],
            "pull_transports": [item.get("transport") for item in pulled.get("items", [])],
            "send_ms": round((t1 - t0) * 1000),
            "pull_ms": round((t2 - t1) * 1000),
        }
        matrix["c2h"].append(row)
        print(json.dumps(row, ensure_ascii=False))
        if not row["match"]:
            raise AssertionError(f"C2H mismatch: {case_id}")

    h2c_cases = [
        ("h2c-000512-unicode", 512, True),
        ("h2c-008192-ascii", 8192, False),
        ("h2c-032768-unicode", 32768, True),
        ("h2c-066082-ascii", 66082, False),
    ]
    for case_id, size, unicode_mix in h2c_cases:
        payload = make_payload(case_id, size, unicode_mix=unicode_mix)
        expected_sha = sha(payload)
        payload_file = OUTPUT / f"payload-{case_id}.txt"
        payload_file.write_text(payload, encoding="utf-8", newline="\n")
        t0 = time.perf_counter()
        pushed = run_bridge("push", "--file", str(payload_file), timeout=300)
        t1 = time.perf_counter()
        extracted = company_extract_message(str(pushed["message_id"]), case_id)
        t2 = time.perf_counter()
        actual = normalize_text(extracted.get("content", ""))
        row = {
            "id": case_id,
            "bytes": len(payload.encode("utf-8")),
            "expected_sha256": expected_sha,
            "actual_sha256": sha(actual),
            "match": actual == payload,
            "home_turn": pushed.get("turn"),
            "home_message_id": pushed.get("message_id"),
            "company_source": extracted.get("source"),
            "push_ms": round((t1 - t0) * 1000),
            "company_read_ms": round((t2 - t1) * 1000),
        }
        matrix["h2c"].append(row)
        print(json.dumps(row, ensure_ascii=False))
        if not row["match"]:
            raise AssertionError(f"H2C mismatch: {case_id}")

    matrix["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    matrix["passed"] = sum(1 for row in matrix["c2h"] + matrix["h2c"] if row["match"])
    matrix["total"] = len(matrix["c2h"]) + len(matrix["h2c"])
    summary = OUTPUT / "stress-summary.json"
    summary.write_text(json.dumps(matrix, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": matrix["passed"] == matrix["total"], "summary": str(summary), "passed": matrix["passed"], "total": matrix["total"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
