"""Bounded, read-only DOM queries over the fixed session-owned dom.query command."""
from __future__ import annotations

import json

MAX_INPUT_BYTES = 4096
def _error(code, message):
    return {'ok': False, 'error': {'code': code, 'message': message}}


def _parse(namespace, args):
    if namespace != 'dom' or not isinstance(args, (list, tuple)) or not all(isinstance(a, str) for a in args):
        raise ValueError('Expected dom find|get|is arguments.')
    if sum(len(a.encode('utf-8')) for a in args) > MAX_INPUT_BYTES:
        raise ValueError('DOM arguments exceed 4096 UTF-8 bytes.')
    if not args or args[0] not in {'find', 'get', 'is'}:
        raise ValueError('dom find LOCATOR | get QUERY LOCATOR [NAMES...] | is STATE LOCATOR')
    action = args[0]
    query = None if action == 'find' else (args[1] if len(args) > 1 else None)
    index = 1 if action == 'find' else 2
    if len(args) <= index:
        raise ValueError('A JSON locator object is required.')
    def unique(pairs):
        d = {}
        for k, v in pairs:
            if k in d:
                raise ValueError('Duplicate locator key.')
            d[k] = v
        return d
    locator = json.loads(args[index], object_pairs_hook=unique)
    keys = {'css', 'text', 'role', 'label', 'placeholder', 'testid'}
    if not isinstance(locator, dict) or set(locator) - (keys | {'name', 'nth', 'first', 'last'}):
        raise ValueError('Unsupported locator key/scope; frames and closed roots are not supported.')
    if len(keys & locator.keys()) != 1:
        raise ValueError('Use exactly one of css, text, role, label, placeholder, testid.')
    for key in (keys | {'name'}) & locator.keys():
        if not isinstance(locator[key], str) or len(locator[key]) > 1024:
            raise ValueError('Locator strings must be at most 1024 characters.')
    if any(locator.get(k) == '' for k in ('css', 'role')):
        raise ValueError('CSS and role cannot be empty.')
    if 'name' in locator and 'role' not in locator:
        raise ValueError('name requires role.')
    if len({'nth', 'first', 'last'} & locator.keys()) > 1:
        raise ValueError('Choose only one of nth, first, last.')
    if 'nth' in locator and (type(locator['nth']) is not int or not 0 <= locator['nth'] < 500):
        raise ValueError('nth must be an integer from 0 to 499.')
    if any(locator[k] is not True for k in ('first', 'last') if k in locator):
        raise ValueError('first/last must be true.')
    names = list(args[index + 1:])
    if action == 'get' and query not in {'text', 'html', 'value', 'attribute', 'count', 'box', 'computedstyles'}:
        raise ValueError('Unknown get query.')
    if action == 'is' and query not in {'visible', 'enabled', 'checked', 'editable', 'attached'}:
        raise ValueError('Unknown is state (use visible, enabled, checked, editable, attached).')
    if action == 'get' and query in {'attribute', 'computedstyles'}:
        if not 1 <= len(names) <= (1 if query == 'attribute' else 32) or any(not n or len(n) > 128 for n in names):
            raise ValueError('attribute needs one name; computedstyles needs 1..32 property names (1..128 characters).')
    elif names:
        raise ValueError('Unexpected trailing arguments.')
    return {'action': action, 'query': query, 'locator': locator, 'names': names}


def run(namespace, args, request):
    """Return a CLI envelope. request(command, params) MUST bind the owned session.

    Parent extracts session/tab/timeout/request options; callback injects tab_id,
    forwards request_id and enforces transport timeout. No discovery/fallback here.
    """
    try:
        data = _parse(namespace, args)
        validate_query(data)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        return _error('usage', str(exc)[:512])
    response = request('dom.query', {'query': data})
    if not isinstance(response, dict):
        return _error('invalid_response', 'Expected dom.query response envelope.')
    if response.get('ok') is not True:
        if response.get('error', {}).get('code') in {'unsupported_command', 'unknown_command'}:
            return _error('extension_upgrade_required', 'Reload the extension with dom.query support (0.6.0+); no evaluate fallback is permitted.')
        return response
    result = response.get('result')
    if not isinstance(result, dict) or type(result.get('ok')) is not bool:
        return _error('invalid_response', 'Expected DOM query result envelope.')
    return result


def validate_query(data):
    """Validate wire data without accepting executable source or extra keys."""
    if not isinstance(data, dict) or set(data) != {'action', 'query', 'locator', 'names'}:
        raise ValueError('Invalid DOM query fields.')
    if not isinstance(data['names'], list) or not all(isinstance(n, str) for n in data['names']):
        raise ValueError('Invalid DOM query names.')
    if data['action'] == 'find':
        if data['query'] is not None:
            raise ValueError('find query must be null.')
        args = ['find']
    else:
        args = [data['action'], data['query']]
    parsed = _parse('dom', args + [json.dumps(data['locator'], ensure_ascii=False, separators=(',', ':'))] + data['names'])
    return parsed
