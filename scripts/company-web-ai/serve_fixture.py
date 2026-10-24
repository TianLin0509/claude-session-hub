"""Local-only UI acceptance fixture. Real service and renderer; synthetic AI replies."""
import importlib.util
import json
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
import uvicorn

folder=Path(sys.argv[1]).resolve();sys.path.insert(0,str(folder))
spec=importlib.util.spec_from_file_location('weekly_fixture',folder/'20260923-weekly-server.py');module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
root=tempfile.mkdtemp(prefix='company-web-ui-')
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
app=module.create_app({'public_origin':f'http://127.0.0.1:{port}','connector_token':'fixture-connector-token-'*2,'data_dir':root,'timezone':'Asia/Shanghai'})
store=app.state.store;store.add_member('测试甲');store.add_member('测试乙');store.ensure_weeks()
with store.db(True) as db:
    db.execute("UPDATE records SET progress='完成单小区基线验证，结果仍需多种子复核。',plan='补充边界条件测试。'")
def worker():
    while True:
        job=app.state.hub_ai_queue.claim('a'*64)['job']
        if job:
            if '只负责提炼内容' in job['system']:
                data={'sections':[{'heading':'基线验证','progress':'测试甲完成单小区基线验证，结果仍需多种子复核。','next':'补充边界条件测试。'},
                                  {'heading':'工具验证','progress':'测试乙完成离线回放流程，识别准确率尚待真实会议验证。','next':'补充真实录音样本。'}], 'members':'测试甲、测试乙'}
                answer=json.dumps(data,ensure_ascii=False)
            elif '事实核对' in job['system']:answer='{"issues":[]}'
            else:answer='测试甲完成单小区基线验证，结果仍需多种子复核；测试乙计划补充边界条件测试。'
            app.state.hub_ai_queue.complete('a'*64,{'id':job['id'],'receipt':job['receipt'],'text':answer})
        time.sleep(.1)
threading.Thread(target=worker,daemon=True).start()
info={'url':f'http://127.0.0.1:{port}','data':root,'pid':__import__('os').getpid(),'syntheticAi':True}
Path(sys.argv[2]).write_text(json.dumps(info),encoding='utf-8');print(json.dumps(info),flush=True)
uvicorn.Server(uvicorn.Config(app,log_level='warning')).run(sockets=[sock])
