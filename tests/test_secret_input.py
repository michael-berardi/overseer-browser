import io
import json
import unittest
from unittest.mock import patch
from cli.secret_input import run, MAX_SECRET_BYTES
from cli.main import main

ORIGIN='https://accounts.example.test'

class SecretInputTests(unittest.TestCase):
    def test_atomic_guarded_write_after_stdin_no_secret_output(self):
        order=[]
        class Source(io.BytesIO):
            def read(self,*a):order.append('read');return super().read(*a)
        def request(command, params):
            self.assertEqual(command,'evaluate');order.append('evaluate')
            if params['source']=='location.origin':return {'ok':True,'result':ORIGIN}
            self.assertIn('location.origin!==p.origin',params['source'])
            self.assertIn("e.type!=='password'",params['source'])
            self.assertIn('fixture-sensitive-value',params['source'])
            return {'ok':True,'result':{'changed':True,'echo':'fixture-sensitive-value'}}
        result=run(['#password',ORIGIN],request,Source(b'fixture-sensitive-value'))
        self.assertEqual(order,['evaluate','read','evaluate'])
        self.assertNotIn('fixture-sensitive-value',json.dumps(result));self.assertTrue(result['ok'])
    def test_origin_change_during_read_is_refused_by_atomic_guard(self):
        calls=[]
        def request(c,p):
            calls.append(p)
            return {'ok':True,'result':ORIGIN if len(calls)==1 else {'changed':False,'cause':'origin_mismatch'}}
        result=run(['#password',ORIGIN],request,io.BytesIO(b'fixture-sensitive-value'))
        self.assertEqual(result['error']['code'],'origin_mismatch')
        self.assertNotIn('fixture-sensitive-value',json.dumps(result))
    def test_mismatched_initial_origin_never_reads_or_fills(self):
        class Unreadable(io.BytesIO):
            def read(self,*a):raise AssertionError('Must not read secret')
        result=run(['#password',ORIGIN],lambda *a:{'ok':True,'result':'https://other.test'},Unreadable())
        self.assertEqual(result['error']['code'],'origin_mismatch')
    def test_rejects_oversize_and_invalid_utf8_without_second_request(self):
        for value in [b'x'*(MAX_SECRET_BYTES+1),b'\xff',b'',b'\x00']:
            calls=[]
            def request(c,p):calls.append(p);return {'ok':True,'result':ORIGIN}
            self.assertFalse(run(['#password',ORIGIN],request,io.BytesIO(value))['ok']);self.assertEqual(len(calls),1)
    def test_failure_payload_exception_and_arbitrary_causes_never_echo(self):
        for mode in ['payload','exception','cause']:
            calls=[]
            def request(c,p):
                calls.append(p)
                if len(calls)==1:return {'ok':True,'result':ORIGIN}
                if mode=='exception':raise RuntimeError('fixture-sensitive-value')
                if mode=='cause':return {'ok':True,'result':{'changed':False,'cause':'fixture-sensitive-value'}}
                return {'ok':False,'error':{'message':'fixture-sensitive-value'}}
            r=run(['#password',ORIGIN],request,io.BytesIO(b'fixture-sensitive-value'))
            self.assertNotIn('fixture-sensitive-value',json.dumps(r));self.assertFalse(r['ok'])
    def test_invalid_origin_tty_and_evaluate_denial_fail_closed(self):
        def request(*a):raise AssertionError('No request expected')
        for origin in ['https://user:pass@expected.test','https://expected.test/path','https://expected.test?token=x','file:///tmp/x']:
            self.assertFalse(run(['#password',origin],request,io.BytesIO(b'fixture'))['ok'])
        stream=io.StringIO('fixture');stream.isatty=lambda:True
        self.assertFalse(run(['#password',ORIGIN],request,stream)['ok'])
        self.assertEqual(run(['#password',ORIGIN],lambda *a:{'ok':False},io.BytesIO(b'fixture'))['error']['code'],'secret_fill_failed')
    def test_main_requires_explicit_tab_and_pins_all_requests(self):
        with patch('cli.main.request_once') as transport,patch('sys.stdin',io.StringIO('fixture')),patch('sys.stdout',io.StringIO()):
            self.assertNotEqual(main(['--session','fixture-session','fill-secret','#password',ORIGIN]),0)
            transport.assert_not_called()
        calls=[]
        def transport(c,p,**kw):
            calls.append(kw.get('session_key'));self.assertEqual(p['tab_id'],7)
            return {'ok':True,'result':ORIGIN if p['source']=='location.origin' else {'changed':True}}
        with patch('cli.main.request_once',transport),patch('sys.stdin',io.StringIO('fixture')),patch('sys.stdout',io.StringIO()):
            self.assertEqual(main(['--session','fixture-session','--tab-id','7','fill-secret','#password',ORIGIN]),0)
        self.assertEqual(calls,['fixture-session','fixture-session'])
