import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


def test(folder):
    folder=Path(folder).resolve();sys.path.insert(0,str(folder))
    spec=importlib.util.spec_from_file_location('style_test',folder/'stylemap_server.py');module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    calls=[]
    def reject(*args,**kwargs):calls.append(True);raise AssertionError('external API')
    urllib.request.urlopen=reject
    with tempfile.TemporaryDirectory() as root:
        root=Path(root);qs=module.load_questions(folder/'questions.json');ai=module.AI('old-key','old-model',str(root/'cache'),lambda _:None)
        gate=type('Gate',(),{'valid':lambda self,cookie:True})()
        handler=module.make_app(qs,ai,module.Live(str(root/'live.json'),qs),gate,str(folder/'web'),lambda _:None,module.Records(str(root/'records.json')),dev=True)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        def request(method,url,value=None,cap='a'*64):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            conn.request(method,url,body=json.dumps(value) if value is not None else None,headers={'Content-Type':'application/json','X-Hub-AI-Client':cap,'Origin':'http://127.0.0.1:'+str(server.server_port)})
            response=conn.getresponse();body=response.read();status=response.status;advertised=response.getheader('X-Hub-AI-Bridge');conn.close()
            assert advertised=='codeagent-v1';return status,json.loads(body)
        try:
            ans={item['id']:2 for item in qs['items']}
            status,created=request('POST','/style/api/self/analyze',{'name':'测试成员','ans':ans});assert status==200,created
            answers=[{'headline':'测试结果','traits':['a']*3,'strengths':['a']*3,'best_tasks':['a']*3,'watch_outs':['a']*2,'work_with_me':['a']*3,'tips':['a']*2},
                     {'assign':['a']*3,'brief':['a']*2,'follow':['a']*2,'pair':'a','care':'a'}]
            count=0
            for _ in range(150):
                assert request('POST','/style/api/hub-ai/claim',{},cap='b'*64)[1]['job'] is None
                status,claimed=request('POST','/style/api/hub-ai/claim',{});assert status==200,claimed
                job=claimed['job']
                if job:
                    # Both shapes together permit either independent queued prompt order.
                    value={**answers[0],**answers[1]}
                    status,done=request('POST','/style/api/hub-ai/complete',{'id':job['id'],'receipt':job['receipt'],'text':json.dumps(value)});assert status==200,done;count+=1
                if count==2:break
                time.sleep(.02)
            assert count==2,count
            for _ in range(100):
                status,result=request('GET','/style/api/self/result?h='+created['h'])
                if result['status']=='ok':break
                time.sleep(.02)
            assert result['status']=='ok',result
            assert calls==[]
            print(json.dumps({'passed':True,'checks':['real HTTP analyze + background context propagation','two scoped CodeAgent tasks','result cache and GET readback','zero external AI calls']}))
        finally:
            server.shutdown();server.server_close();ai.pool.shutdown(wait=True)


if __name__=='__main__':test(sys.argv[1])
