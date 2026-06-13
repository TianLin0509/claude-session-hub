# -*- coding: utf-8 -*-
"""PPT 模式 E2E（隔离实例 + CDP 真人操作）

流程: 连接隔离 Hub (CDP 9231) -> 点 🎨 PPT 按钮 -> 等 server 拉起 + webview 加载
      -> 校验面板可见 + webview 指向 :8765 -> 截图 -> 点关闭 -> 校验回到正常界面
前置: 隔离 Hub 已用 CLAUDE_HUB_DATA_DIR 启动且 :8765 无人占用(测 Hub spawn 路径)
"""
import sys
import time

import requests
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CDP = "http://127.0.0.1:9231"
SHOT = r"C:\Users\lintian\claude-session-hub\tests\ppt_mode_e2e.png"

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(CDP)
    ctx = browser.contexts[0]
    page = next(pg for pg in ctx.pages if "index.html" in pg.url)
    print("[1] attached:", page.url.split("/")[-1])

    btn = page.locator("#btn-ppt-toggle")
    assert btn.count() == 1, "PPT 按钮不存在"
    # 起始状态归位: 面板若已开先关掉
    page.evaluate("document.querySelector('#ppt-mode-panel') && "
                  "(document.querySelector('#ppt-mode-panel').style.display='none')")
    btn.click()
    print("[2] 已点击 🎨 PPT")

    # 等 server 拉起(Hub spawn python, 最多 35s) + webview 出现
    page.wait_for_selector("#ppt-mode-panel", state="visible", timeout=40000)
    deadline = time.time() + 40
    src = ""
    while time.time() < deadline:
        src = page.evaluate(
            "document.querySelector('#ppt-mode-panel webview')?.getAttribute('src') || ''")
        if "8765" in src:
            break
        err = page.evaluate(
            "document.querySelector('#ppt-mode-status')?.textContent || ''")
        if "失败" in err or "超时" in err:
            print("FAIL status:", err)
            sys.exit(1)
        time.sleep(1)
    assert "8765" in src, f"webview src 未就位: {src!r}"
    print("[3] 面板可见, webview ->", src)

    r = requests.get("http://127.0.0.1:8765/api/templates", timeout=10)
    assert r.status_code == 200 and len(r.json()) >= 20, "server API 异常"
    print(f"[4] Hub 拉起的 server 健康: {len(r.json())} 套模板")

    time.sleep(3)  # 等 webview 渲染
    page.screenshot(path=SHOT)
    print("[5] 截图:", SHOT)

    page.locator("#ppt-mode-close").click()
    page.wait_for_selector("#ppt-mode-panel", state="hidden", timeout=5000)
    assert page.locator("#btn-compact-toggle").is_visible(), "关闭后主界面异常"
    print("[6] 关闭面板, 主界面正常")

    # 再开一次验证幂等
    btn.click()
    page.wait_for_selector("#ppt-mode-panel", state="visible", timeout=8000)
    page.keyboard.press("Escape")
    page.wait_for_selector("#ppt-mode-panel", state="hidden", timeout=5000)
    print("[7] 二次开关 + ESC 关闭正常")

print("PPT MODE E2E PASS")
