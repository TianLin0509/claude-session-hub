#!/usr/bin/env python3
"""Claude Session Hub hook notifier. Called by Claude Code Stop/UserPromptSubmit hooks.

Reads CC's JSON payload from stdin to extract:
  - session_id       -> Hub saves as ccSessionId for future `--resume`
  - cwd              -> Hub saves as launch cwd for dormant wake
  - transcript_path  -> Hub reads the JSONL to get the last user message
                        on Stop events (transcript is authoritative when
                        the agent loop has actually finished)
  - prompt           -> Only on UserPromptSubmit; the raw just-submitted
                        text. Preferred over transcript read for the
                        prompt event because the new entry may not yet
                        be flushed to disk when this hook fires.
"""
import os, sys, json, urllib.request

sid = os.environ.get('CLAUDE_HUB_SESSION_ID', '')
if not sid:
    sys.exit(0)

port = os.environ.get('CLAUDE_HUB_PORT', '3456')
token = os.environ.get('CLAUDE_HUB_TOKEN', '')
event = sys.argv[1] if len(sys.argv) > 1 else 'stop'

cc_session_id = None
cwd = None
transcript_path = None
prompt = None
tool_name = None
tool_input = None
try:
    # Read raw bytes and decode as UTF-8 explicitly. On Chinese Windows
    # sys.stdin defaults to cp936, which mangles UTF-8 Chinese characters
    # in the `prompt` field into garbage like "继续" -> "缁х画".
    raw = sys.stdin.buffer.read() if hasattr(sys.stdin, 'buffer') else sys.stdin.read().encode('latin-1', 'replace')
    stdin_data = raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else raw
    if stdin_data:
        payload = json.loads(stdin_data)
        cc_session_id = payload.get('session_id')
        cwd = payload.get('cwd')
        transcript_path = payload.get('transcript_path')
        prompt = payload.get('prompt')
        tool_name = payload.get('tool_name')
        tool_input = payload.get('tool_input')
except Exception:
    pass

try:
    if event == 'tool-use':
        raise SystemExit(0)
    else:
        url = f'http://127.0.0.1:{port}/api/hook/{event}'
        body = {'sessionId': sid, 'token': token}
        if cc_session_id:
            body['claudeSessionId'] = cc_session_id
        if cwd:
            body['cwd'] = cwd
        if transcript_path:
            body['transcriptPath'] = transcript_path
        if prompt:
            body['prompt'] = prompt
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data, {'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass  # hub not running is non-fatal
