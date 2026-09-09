import copy
import unittest
from native_host.protocol import ProtocolError, validate_request
from cli.dom_query import run

QUERY={'action':'get','query':'count','locator':{'role':'button'},'names':[]}

def request():
    return {'version':1,'kind':'request','request_id':'fixture-1','command':'dom.query',
            'session_key':'owned-fixture','params':{'query':copy.deepcopy(QUERY)},'token':'fixture'}

class DOMWireTests(unittest.TestCase):
    def test_valid_owned_query_and_target(self):
        value=request();value['params']['tab_id']=42
        self.assertEqual(validate_request(value,token='fixture')['session_key'],'owned-fixture')
        with self.assertRaises(ProtocolError):validate_request(value,token='different')

    def test_no_ambient_session_or_arbitrary_source(self):
        value=request();del value['session_key']
        with self.assertRaises(ProtocolError):validate_request(value)
        for extra in ({'source':'alert(1)'},{'tab_id':True},{'tab_id':-1},{'query':{}}, {'query':{**QUERY,'source':'alert(1)'}}):
            value=request();value['params'].update(extra)
            with self.subTest(extra=tuple(extra)):
                with self.assertRaises(ProtocolError):validate_request(value)

    def test_malformed_and_bounded_locator_contract(self):
        for locator in ({'css':'x'*1025},{'css':'button','nth':True},{'css':'button','first':True,'last':True},{'css':'button','frame':'peer'},{'role':'button','name':3}):
            value=request();value['params']['query']['locator']=locator
            with self.subTest(locator_keys=tuple(locator)):
                with self.assertRaises(ProtocolError):validate_request(value)

    def test_old_extension_failure_never_falls_back_to_evaluate(self):
        commands=[]
        def call(command,params):
            commands.append(command)
            return {'ok':False,'error':{'code':'unknown_command'}}
        result=run('dom',['get','count','{"role":"button"}'],call)
        self.assertEqual(commands,['dom.query'])
        self.assertEqual(result['error']['code'],'extension_upgrade_required')

if __name__=='__main__':unittest.main()
