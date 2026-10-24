import tempfile
import threading
import time
import unittest
from hub_ai_queue import Queue, HubAiError, provider


class QueueTests(unittest.TestCase):
    def test_bound_provider_roundtrip_and_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            q=Queue(root); results=[]
            def run():
                with q.scope('a'*64):
                    results.append(provider('', '会议决定保留原始录像', '只概括决定'))
            thread=threading.Thread(target=run);thread.start()
            job=None
            for _ in range(100):
                job=q.claim('a'*64)['job']
                if job:break
                time.sleep(.01)
            self.assertTrue(job)
            self.assertEqual(q.claim('b'*64),{'job':None})
            self.assertEqual(q.claim('a'*64),{'job':None})
            value={**job,'text':'决定保留原始录像。'}
            with self.assertRaises(HubAiError):q.complete('b'*64,value)
            with self.assertRaises(HubAiError):q.complete('a'*64,{**value,'receipt':'wrong'})
            q.complete('a'*64,value);q.complete('a'*64,value)
            thread.join(3);self.assertFalse(thread.is_alive())
            self.assertEqual(results,[{'text':'决定保留原始录像。','model':'CodeAgent'}])
            with self.assertRaises(HubAiError):q.complete('a'*64,{**value,'text':'overwrite'})

    def test_restart_does_not_repeat_running_and_timeout_is_terminal(self):
        with tempfile.TemporaryDirectory() as root:
            q=Queue(root,timeout=.05);job=q.enqueue('a'*64,'system','text');claimed=q.claim('a'*64)['job']
            q2=Queue(root,timeout=.05);self.assertIsNone(q2.claim('a'*64)['job'])
            time.sleep(.06)
            with self.assertRaises(HubAiError):q2.wait(job)
            with self.assertRaises(HubAiError):q2.complete('a'*64,{**claimed,'text':'late'})

    def test_missing_owner_fails_closed(self):
        with self.assertRaises(HubAiError):provider('old-key','text')
        with tempfile.TemporaryDirectory() as root:
            q=Queue(root)
            with q.scope(''):
                with self.assertRaises(HubAiError):provider('old-key','text')


if __name__=='__main__':unittest.main()
