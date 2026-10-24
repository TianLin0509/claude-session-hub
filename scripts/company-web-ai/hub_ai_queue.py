"""Server-side text provider for the company Hub. No model API or CLI lives here.

Deployment adapter must wrap each request with scope(), and copy_context() when
dispatching background work. Unbound work fails closed, never calls DeepSeek.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

_current = ContextVar('hub_ai_request', default=None)


class HubAiError(RuntimeError):
    pass


class Queue:
    def __init__(self, root, timeout=600):
        Path(root).mkdir(parents=True, exist_ok=True)
        self.file = str(Path(root) / 'codeagent-tasks.sqlite3')
        self.timeout = timeout
        with self.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL,
                created REAL NOT NULL, receipt TEXT, system TEXT NOT NULL,
                material TEXT NOT NULL, label TEXT NOT NULL, result TEXT, error TEXT)''')
            db.execute('CREATE INDEX IF NOT EXISTS owner_state ON tasks(owner,state,created)')
            db.execute('CREATE TABLE IF NOT EXISTS references_to_owners (reference TEXT PRIMARY KEY, owner TEXT NOT NULL)')

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.file, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def owner(capability):
        if not re.fullmatch('[a-f0-9]{64}', capability or ''):
            raise HubAiError('请在公司 AI Hub 的团队页面使用 CodeAgent 功能')
        return hashlib.sha256(capability.encode()).hexdigest()

    @contextmanager
    def scope(self, capability):
        owner = self.owner(capability) if re.fullmatch('[a-f0-9]{64}',capability or '') else None
        token = _current.set((self, owner))
        try:
            yield
        finally:
            _current.reset(token)

    def bind_reference(self, reference):
        current = _current.get()
        if not current or current[0] is not self or not current[1]:
            raise HubAiError('请从公司 Hub 提交该任务')
        with self.db() as db:
            old = db.execute('SELECT owner FROM references_to_owners WHERE reference=?',(str(reference),)).fetchone()
            if old and old['owner']!=current[1]:
                raise HubAiError('该后台任务属于另一个 Hub，请由发起者操作')
            db.execute('INSERT OR IGNORE INTO references_to_owners VALUES (?,?)',(str(reference),current[1]))

    @contextmanager
    def reference_scope(self, reference):
        with self.db() as db:
            row = db.execute('SELECT owner FROM references_to_owners WHERE reference=?',(str(reference),)).fetchone()
        if not row:
            raise HubAiError('此后台任务尚未绑定 Hub，请由发起者重新提交核对')
        token = _current.set((self,row['owner']))
        try:
            yield
        finally:
            _current.reset(token)

    def expire(self, db):
        db.execute("UPDATE tasks SET state='error',error=? WHERE state IN ('queued','running') AND created<?",
                   ('CodeAgent 任务超时；原材料未修改，请重新提交', time.time()-self.timeout))

    def enqueue(self, capability, system, text, label='团队文字任务'):
        return self.enqueue_owned(self.owner(capability),system,text,label)

    def enqueue_owned(self, owner, system, text, label='团队文字任务'):
        if not owner:
            raise HubAiError('请在公司 AI Hub 的团队页面使用 CodeAgent 功能')
        if not isinstance(system, str) or len(system)>24000 or not isinstance(text, str) or not text.strip() or len(text)>160000:
            raise HubAiError('任务内容无效或过长')
        job = str(uuid.uuid4())
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.expire(db)
            if db.execute("SELECT COUNT(*) FROM tasks WHERE state IN ('queued','running')").fetchone()[0]>=16:
                raise HubAiError('团队 AI 任务较多，请稍后重试')
            db.execute("INSERT INTO tasks VALUES (?,?,'queued',?,NULL,?,?,?,NULL,NULL)",
                       (job, owner, time.time(), system, text, str(label)[:80]))
        return job

    def claim(self, capability):
        owner = self.owner(capability)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.expire(db)
            row = db.execute("SELECT * FROM tasks WHERE owner=? AND state='queued' ORDER BY created LIMIT 1", (owner,)).fetchone()
            if not row:
                return {'job': None}
            receipt = secrets.token_hex(32)
            db.execute("UPDATE tasks SET state='running',receipt=? WHERE id=?", (receipt,row['id']))
            return {'job': {'id':row['id'],'receipt':receipt,'system':row['system'],'text':row['material'],'label':row['label']}}

    def complete(self, capability, value):
        owner = self.owner(capability)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.expire(db)
            row = db.execute('SELECT * FROM tasks WHERE id=? AND owner=?', (str(value.get('id','')),owner)).fetchone()
            if not row or not secrets.compare_digest(row['receipt'] or '', str(value.get('receipt',''))):
                raise HubAiError('任务不属于当前 Hub 或回执无效')
            result, error = value.get('text'), value.get('error')
            if error:
                result, error = None, str(error)[:300]
            elif not isinstance(result,str) or not result.strip() or len(result)>320000:
                raise HubAiError('CodeAgent 结果为空或过长')
            if row['state'] in ('done','error'):
                if row['result'] == result and row['error'] == error:
                    return {'ok':True}
                raise HubAiError('任务已结束，不能覆盖结果')
            if row['state']!='running':
                raise HubAiError('任务尚未领取')
            db.execute('UPDATE tasks SET state=?,result=?,error=? WHERE id=?',
                       ('error' if error else 'done',result,error,row['id']))
        return {'ok':True}

    def wait(self, job):
        while True:
            with self.db() as db:
                self.expire(db)
                row = db.execute('SELECT * FROM tasks WHERE id=?',(job,)).fetchone()
            if row['state']=='error':
                raise HubAiError(row['error'])
            if row['state']=='done':
                return {'text':row['result'],'model':'CodeAgent'}
            time.sleep(.2)


def provider(_unused_key, text, system=''):
    current = _current.get()
    if not current:
        raise HubAiError('此任务没有绑定公司 Hub，请从团队页面重新提交')
    queue, owner = current
    return queue.wait(queue.enqueue_owned(owner,system,text))


def attach_fastapi(app, root):
    from fastapi import Request, HTTPException
    queue = Queue(root)

    @app.middleware('http')
    async def scope(request, call_next):
        with queue.scope(request.headers.get('x-hub-ai-client','')):
            response = await call_next(request)
        response.headers['X-Hub-AI-Bridge']='codeagent-v1'
        return response

    # Keep Request resolvable in FastAPI's signature inspection with no postponed annotations.
    @app.post('/api/hub-ai/claim')
    def claim(request: Request):
        try:
            return queue.claim(request.headers.get('x-hub-ai-client',''))
        except HubAiError as error:
            raise HTTPException(403,str(error)) from None

    @app.post('/api/hub-ai/complete')
    async def complete(request: Request):
        if int(request.headers.get('content-length','0'))>1500000:
            raise HTTPException(413,'结果过长')
        try:
            return queue.complete(request.headers.get('x-hub-ai-client',''),await request.json())
        except (HubAiError, ValueError, TypeError) as error:
            raise HTTPException(409,str(error)) from None
    return queue


def wrap_http_handler(base, queue, prefix='/style'):
    class Bound(base):
        def send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
            return super().send(code,body,ctype,{**(extra or {}),'X-Hub-AI-Bridge':'codeagent-v1'})

        def do_GET(self):
            with queue.scope(self.headers.get('X-Hub-AI-Client','')):
                return super().do_GET()

        def do_POST(self):
            with queue.scope(self.headers.get('X-Hub-AI-Client','')):
                route=self.path.split('?')[0]
                if route in (prefix+'/api/hub-ai/claim',prefix+'/api/hub-ai/complete'):
                    if not self.origin_ok():
                        return self.send(403,{'msg':'来源不正确'})
                    try:
                        value=self.js(1500000)
                        result=queue.claim(self.headers.get('X-Hub-AI-Client','')) if route.endswith('/claim') else queue.complete(self.headers.get('X-Hub-AI-Client',''),value)
                        return self.send(200,result)
                    except (HubAiError,ValueError,TypeError) as error:
                        return self.send(409,{'msg':str(error)})
                return super().do_POST()
    return Bound
