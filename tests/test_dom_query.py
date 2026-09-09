"""Focused tests; Node's small DOM double requires no installed dependencies."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cli import dom_query

FAKE_DOM = r'''
class Element {
 constructor(tag, attrs={}, children=[]) {
  this.localName=tag; this.attrs=attrs; this.children=children; this.isConnected=true;
  this.type=attrs.type || 'text'; this.labels=[]; this.readOnly=false;
  if ('value' in attrs) this.value=attrs.value;
  for(let i=0;i<children.length;i++) { children[i].parentElement=this; children[i].previousElementSibling=children[i-1] || null; }
 }
 get lastElementChild(){return this.children.at(-1) || null;}
 getAttribute(k){return this.attrs[k] ?? null;}
 hasAttribute(k){return k in this.attrs;}
 getRootNode(){return document;}
 matches(s){if(s==='[')throw Error(); if(s===':disabled')return this.hasAttribute('disabled'); return s==='*'||s===this.localName||(s[0]==='#' && this.attrs.id===s.slice(1));}
 getBoundingClientRect(){return {x:0,y:0,width:10,height:20};}
 getClientRects(){return [this.getBoundingClientRect()];}
}
const document={getElementById:()=>null,createTreeWalker(e){let done=false;return {nextNode(){if(done)return null;done=true;return e.attrs.text===undefined?null:{data:e.attrs.text};}};}};
const getComputedStyle=e=>({visibility:'visible',display:'block',opacity:'1',getPropertyValue:n=>n==='color'?'rgb(0, 0, 0)':''});
const a=new Element('input',{id:'a',value:'',text:'Alpha','data-testid':'x'});
const b=new Element('input',{id:'b',value:'0',text:'Beta','data-testid':'x'});
a.checked=false;
const host=new Element('widget');
const shadow=new Element('button',{'data-testid':'shadow',text:'Shadow'});
host.shadowRoot={lastElementChild:shadow};
shadow.getRootNode=()=>({host});
document.documentElement=new Element('html',{},[a,b,host]);
'''


class DomQueryTests(unittest.TestCase):
    def payload(self, args):
        calls = []
        result = dom_query.run('dom', args, lambda c, p: calls.append((c, p)) or {'ok': True, 'result': {'ok': True, 'result': 0}})
        self.assertTrue(result['ok'], result)
        self.assertEqual(calls[0][0], 'dom.query')
        self.assertEqual(set(calls[0][1]), {'query'})
        return calls[0][1]['query']

    def test_escaping_and_compile(self):
        malicious = '\");globalThis.injected=true;//\\\n\u2028\U0001f600'
        data = self.payload(['find', json.dumps({'testid': malicious})])
        self.assertEqual(data['locator']['testid'], malicious)

    def test_validation_never_requests(self):
        def forbidden(*args):
            self.fail('Invalid input must not reach wire')
        cases = [[],['find','{}'],['find','{"css":"a","frame":"x"}'],
                 ['find','{"css":"a","nth":true}'],['find','{"css":"a","first":false}'],
                 ['find','{"css":"a","first":true,"last":true}'],
                 ['find','{"css":"a","css":"b"}'],['find','{"text":1}'],
                 ['find','{"css":"a","text":"b"}'],['get','attribute','{"css":"a"}'],
                 ['get','computedstyles','{"css":"a"}'] + ['color']*33,
                 ['find','x'*4097],['is','clicked','{"css":"a"}']]
        for args in cases:
            self.assertEqual(dom_query.run('dom',args,forbidden)['error']['code'], 'usage')

    def test_transport_errors_preserved(self):
        error = {'ok':False,'error':{'code':'session_not_found','message':'Missing'}}
        self.assertIs(dom_query.run('dom',['find','{"css":"a"}'],lambda *a:error), error)
        self.assertEqual(dom_query.run('dom',['find','{"css":"a"}'],lambda *a:{'ok':True,'result':None})['error']['code'], 'invalid_response')


if __name__ == '__main__':
    unittest.main()
