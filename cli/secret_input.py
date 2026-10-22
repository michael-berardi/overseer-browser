"""Atomically fill a password field in an owned tab from stdin; never echo it."""
from urllib.parse import urlsplit
import json

MAX_SECRET_BYTES = 16384

# USER_SCRIPT execution isolates these built-ins from page overrides. The guard and
# value write execute synchronously in one document, not separate check/fill requests.
_ATOMIC_FILL = r'''(function(p){
 if(location.origin!==p.origin)return {changed:false,cause:'origin_mismatch'};
 const matches=document.querySelectorAll(p.selector);
 if(matches.length!==1)return {changed:false,cause:'ambiguous_target'};
 const e=matches[0];
 if(!(e instanceof HTMLInputElement)||e.type!=='password'||e.disabled||e.readOnly||!e.isConnected||e.getRootNode()!==document)return {changed:false,cause:'invalid_password_target'};
 const style=getComputedStyle(e);
 if(!e.getClientRects().length||style.visibility==='hidden'||style.display==='none')return {changed:false,cause:'hidden_password_target'};
 const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
 if(!setter)return {changed:false,cause:'invalid_password_target'};
 e.focus();setter.call(e,p.value);
 e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
 return {changed:true};
})'''


def run(args, request, stream):
    def error(code, message):
        return {'ok': False, 'error': {'code': code, 'message': message}}
    if len(args) != 2 or not args[0] or len(args[0]) > 1024:
        return error('usage', 'fill-secret CSS_SELECTOR EXPECTED_ORIGIN reads a UTF-8 password from non-terminal stdin.')
    selector, origin = args
    try:
        u = urlsplit(origin)
        if u.scheme not in {'https', 'http'} or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
            return error('usage', 'EXPECTED_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment.')
        if stream.isatty():
            return error('usage', 'Pipe the password through stdin; interactive terminal input is refused.')
        check = request('evaluate', {'source': 'location.origin'})
        if not check.get('ok'):
            return error('secret_fill_failed', 'The owned browser could not verify the origin; nothing was filled.')
        if check.get('result') != origin:
            return error('origin_mismatch', 'The selected owned page is not at the expected origin; nothing was filled.')
        source = getattr(stream, 'buffer', stream)
        value = source.read(MAX_SECRET_BYTES + 1)
        if isinstance(value, str):
            value = value.encode('utf-8')
        if not value or len(value) > MAX_SECRET_BYTES:
            return error('invalid_secret_input', 'Password stdin must contain 1 to 16384 UTF-8 bytes.')
        value = value.decode('utf-8')
        if '\x00' in value:
            return error('invalid_secret_input', 'Password stdin cannot contain NUL bytes.')
        source = _ATOMIC_FILL + '(' + json.dumps({'origin': origin, 'selector': selector, 'value': value}, ensure_ascii=True) + ')'
        filled = request('evaluate', {'source': source})
        if not filled.get('ok') or filled.get('result', {}).get('changed') is not True:
            causes = {'origin_mismatch', 'ambiguous_target', 'invalid_password_target', 'hidden_password_target'}
            cause = filled.get('result', {}).get('cause')
            return error(cause if cause in causes else 'secret_fill_failed', 'The guarded password fill was refused; no password content is included in this output.')
        return {'ok': True, 'result': {'changed': True, 'secret_output': False}}
    except Exception:
        # Transport/provider errors may echo a value. Never render their text or raw payload.
        return error('secret_fill_failed', 'The guarded password fill failed; no password content is included in this output.')
