#!/usr/bin/env python3
"""Prepare attachments in the owned ChatGPT bridge. Never submit a message."""
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path


def show_owned_window(title):
    """Restore only one exact-title Chrome window; never recreate the draft tab."""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    matches = []

    @callback_type
    def visit(hwnd, _):
        text = ctypes.create_unicode_buffer(user32.GetWindowTextLengthW(hwnd) + 1)
        user32.GetWindowTextW(hwnd, text, len(text))
        kind = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, kind, len(kind))
        if title and text.value.startswith(title) and kind.value.startswith('Chrome_WidgetWin_'):
            matches.append(hwnd)
        return True

    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows(visit, 0)
    if len(matches) != 1:
        raise ValueError('无法唯一识别中转窗口，未改动已有草稿')
    user32.ShowWindowAsync(matches[0], 9)
    user32.SetForegroundWindow(matches[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bridge', required=True)
    parser.add_argument('files', nargs='+')
    args = parser.parse_args()
    bridge_path = Path(args.bridge).resolve(strict=True)
    sys.path.insert(0, str(bridge_path.parent))
    spec = importlib.util.spec_from_file_location('hub_attachment_bridge', bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    files = [str(Path(p).resolve(strict=True)) for p in args.files]
    if len(files) > 10 or any(not Path(p).is_file() or Path(p).stat().st_size > 20 * 1024 * 1024 for p in files):
        raise ValueError('最多 10 个文件，每个不超过 20 MiB')
    bridge.OPERATION_DEADLINE = time.monotonic() + 220
    with bridge.operation_lock():
        cfg = bridge.load_config()
        # Preserve the existing browser and any unsent draft. A failed login is explicit.
        browser = bridge.ensure_session(cfg)
        show_owned_window(str(browser.get('title') or ''))
        source = r'''async page => {
          const files = __FILES__;
          const target = __URL__;
          if (page.url().split('?')[0] !== target.split('?')[0]) throw new Error('目标会话不匹配');
          const box = page.locator('#prompt-textarea').last();
          await box.waitFor({state: 'visible', timeout: 20000});
          const form = box.locator('xpath=ancestor::form[1]');
          if (!(await form.count())) throw new Error('无法识别附件输入区域');
          // Preserve any existing draft. Do not overwrite or combine uncertain uploads.
          if ((await box.innerText()).trim() || await form.locator('[data-testid*="attachment"], button[aria-label*="Remove"], button[aria-label*="移除"]').count()) {
            throw new Error('ChatGPT 已有草稿或附件，请先处理后再添加');
          }
          const inputs = page.locator('input[type="file"]');
          if (!(await inputs.count())) throw new Error('当前页面没有可用附件入口，请在 ChatGPT 窗口手动添加');
          await inputs.last().setInputFiles(files);
          const names = files.map(p => p.split(/[\\/]/).pop());
          for (const name of names) await form.getByText(name, {exact: true}).first().waitFor({state:'visible', timeout:60000});
          const send = form.locator('button[data-testid="send-button"]');
          await send.waitFor({state:'visible', timeout:60000});
          await page.waitForFunction(() => {
            const button = document.querySelector('button[data-testid="send-button"]');
            return button && !button.disabled;
          }, null, {timeout:60000});
          return {ok:true, prepared:true, sent:false, conversation_url:page.url(), names};
        }'''.replace('__FILES__', json.dumps(files)).replace('__URL__', json.dumps(cfg['conversation_url']))
        result = bridge._run_code(cfg, source, timeout=180)
        if not isinstance(result, dict) or not result.get('prepared'):
            raise ValueError('附件准备未得到页面确认，请检查 ChatGPT 窗口')
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': {'code': getattr(error, 'code', 'attachment_prepare_failed'), 'message': str(error)}}, ensure_ascii=False))
        sys.exit(1)
