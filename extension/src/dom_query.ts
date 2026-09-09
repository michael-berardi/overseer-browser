/** Fixed read-only inspector. This function is serialized by executeScript; keep it closure-free. */
export interface DomQuery {
  action: 'find' | 'get' | 'is';
  query: string | null;
  locator: {css?: string; text?: string; role?: string; name?: string; label?: string; placeholder?: string; testid?: string; nth?: number; first?: true; last?: true};
  names: string[];
}
export function queryDom(p: DomQuery) {

  const fail = (code: string, message: string): never => { throw {domQuery: true, code, message}; };
  const start = performance.now();
  const tick = () => { if (performance.now() - start > 250) fail('query_timeout', 'DOM query exceeded 250ms cooperative budget.'); };
  const norm = (s: unknown): string => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  type QueryElement = HTMLElement & HTMLInputElement & HTMLSelectElement;
  const parent = (e: QueryElement): QueryElement | null => (e.parentElement || (e.getRootNode() as ShadowRoot).host || null) as QueryElement | null;
  const text = (e: QueryElement) => {
    // Bound text traversal rather than materializing an unbounded textContent.
    let out = '', count = 0;
    const walker = document.createTreeWalker(e, 4);
    let n;
    while ((n = walker.nextNode())) {
      tick();
      if (++count > 5000 || out.length + (n as Text).data.length > 65536)
        fail('limit_exceeded', 'Text exceeds inspection limit.');
      out += (n as Text).data;
    }
    return out;
  };
  const tag = (e: QueryElement) => e.localName;
  const label = (e: QueryElement) => {
    let s = '';
    for (const l of Array.from(e.labels || [])) {
      s += ' ' + text(l as unknown as QueryElement);
      if (s.length > 65536) fail('limit_exceeded', 'Label exceeds inspection limit.');
    }
    return norm(s);
  };
  const name = (e: QueryElement) => {
    const ids = e.getAttribute('aria-labelledby');
    if (ids) {
      if (ids.length > 4096) fail('limit_exceeded', 'Name reference exceeds inspection limit.');
      const root = e.getRootNode() as Document | ShadowRoot;
      let s = '';
      for (const id of ids.trim().split(/\s+/)) {
        const target = root.getElementById(id);
        if (target) s += ' ' + text(target as QueryElement);
        if (s.length > 65536) fail('limit_exceeded', 'Name exceeds inspection limit.');
      }
      if (norm(s)) return norm(s);
    }
    const aria = e.getAttribute('aria-label');
    if (aria !== null) return norm(aria);
    const l = label(e);
    if (l) return l;
    if (tag(e) === 'img') return norm(e.getAttribute('alt'));
    if (tag(e) === 'input' && ['submit','reset','button'].includes(e.type)) return norm(e.value);
    return norm(text(e));
  };
  const role = (e: QueryElement) => {
    const explicit = e.getAttribute('role');
    if (explicit) return norm(explicit).split(' ')[0];
    const t = tag(e);
    if (t === 'a' && e.hasAttribute('href')) return 'link';
    if (t === 'input') {
      return ({checkbox:'checkbox',radio:'radio',range:'slider',number:'spinbutton',
        button:'button',submit:'button',reset:'button',search:'searchbox',
        text:'textbox',email:'textbox',tel:'textbox',url:'textbox'} as Record<string, string>)[e.type] || '';
    }
    if (t === 'select') return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
    return ({button:'button',textarea:'textbox',img:'img',option:'option',
      h1:'heading',h2:'heading',h3:'heading',h4:'heading',h5:'heading',h6:'heading',
      ul:'list',ol:'list',li:'listitem',table:'table',tr:'row',td:'cell',th:'columnheader'} as Record<string, string>)[t] || '';
  };
  const enabled = (e: QueryElement) => {
    if (e.matches(':disabled')) return false;
    let n: QueryElement | null = e;
    while (n) { tick(); if (n.hasAttribute('inert') || n.getAttribute('aria-disabled') === 'true') return false; n = parent(n); }
    return true;
  };
  const visible = (e: QueryElement) => {
    if (!e.isConnected) return false;
    const own = getComputedStyle(e);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
    let n: QueryElement | null = e;
    while (n) {
      tick();
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.contentVisibility === 'hidden' || Number(s.opacity) === 0) return false;
      n = parent(n);
    }
    return Array.from(e.getClientRects()).some(r => r.width > 0 && r.height > 0);
  };
  try {
    const l = p.locator;
    if (l.css) {
      try { document.documentElement?.matches(l.css); }
      catch (_) { fail('invalid_selector', 'CSS selector is invalid.'); }
    }
    let visited = 0;
    const matches: QueryElement[] = [];
    const stack: QueryElement[] = [];
    if (document.documentElement) stack.push(document.documentElement as QueryElement);
    while (stack.length) {
      tick();
      const e = stack.pop()!;
      if (++visited > 5000) fail('limit_exceeded', 'Document exceeds 5000 inspected elements. Narrowing does not bypass this limit.');
      let yes = false;
      if (l.css !== undefined) yes = e.matches(l.css);
      else if (l.text !== undefined) yes = norm(text(e)) === norm(l.text);
      else if (l.role !== undefined) yes = role(e) === l.role && (l.name === undefined || name(e) === norm(l.name));
      else if (l.label !== undefined) yes = !!e.labels && label(e) === norm(l.label);
      else if (l.placeholder !== undefined) yes = e.getAttribute('placeholder') === l.placeholder;
      else if (l.testid !== undefined) yes = e.getAttribute('data-testid') === l.testid;
      if (yes) {
        matches.push(e);
        if (matches.length > 500) fail('limit_exceeded', 'More than 500 matches.');
      }
      // No frame descent, no selector execution across closed roots.
      for (let c = e.lastElementChild; c; c = c.previousElementSibling) {
        stack.push(c as QueryElement);
        if (stack.length + visited > 5000) fail('limit_exceeded', 'Document exceeds 5000 elements.');
      }
      if (e.shadowRoot) {
        for (let c = e.shadowRoot.lastElementChild; c; c = c.previousElementSibling) {
          stack.push(c as QueryElement);
          if (stack.length + visited > 5000) fail('limit_exceeded', 'Document exceeds 5000 elements.');
        }
      }
    }
    let selected = matches;
    if (l.nth !== undefined || l.first || l.last) {
      const i = l.nth !== undefined ? l.nth : l.last ? matches.length - 1 : 0;
      selected = i >= 0 && i < matches.length ? [matches[i]!] : [];
    }
    let result;
    if (p.action === 'get' && p.query === 'count') result = selected.length;
    else if (p.action === 'find') result = selected.map((e, i) => ({index: i, tag: tag(e), id: e.getAttribute('id'), role: role(e), name: name(e)}));
    else if (p.action === 'is' && p.query === 'attached' && !selected.length) result = false;
    else {
      if (!selected.length) fail('no_match', 'No match in top document/open-shadow scope; frames and closed roots are inaccessible.');
      if (selected.length !== 1) fail('ambiguous_match', 'Multiple matches; use nth, first or last.');
      const e = selected[0]!;
      if (!e.isConnected) fail('detached_target', 'Target is detached.');
      if (p.action === 'is') {
        switch (p.query) {
          case 'attached': result = true; break;
          case 'visible': result = visible(e); break;
          case 'enabled': result = enabled(e); break;
          case 'checked': result = 'checked' in (e as Element) ? !!e.checked : e.getAttribute('aria-checked') === 'true'; break;
          case 'editable': result = enabled(e) && !e.readOnly && (e.isContentEditable || tag(e) === 'textarea' ||
            (tag(e) === 'input' && ['text','search','email','url','tel','password','number','date','datetime-local','month','week','time'].includes(e.type))); break;
        }
      } else {
        switch (p.query) {
          case 'text': result = text(e); break;
          case 'html': result = e.outerHTML; break;
          case 'value': result = 'value' in e ? e.value : null; break;
          case 'attribute': result = e.getAttribute(p.names[0]!); break;
          case 'box': { const r = e.getBoundingClientRect(); result = {x:r.x,y:r.y,width:r.width,height:r.height}; break; }
          case 'computedstyles': { const s = getComputedStyle(e); result = Object.fromEntries(p.names.map(n => [n,s.getPropertyValue(n)])); break; }
        }
      }
    }
    tick();
    const envelope = {ok:true,result,scope:'top-document-and-open-shadow-roots'};
    if (new TextEncoder().encode(JSON.stringify(envelope)).length > 65536)
      fail('limit_exceeded', 'Result exceeds 65536 UTF-8 bytes; no partial value returned.');
    return envelope;
  } catch (caught) {
    const e = caught as {domQuery?: boolean; code?: string; message?: string} | null;
    return {ok:false,error:{code:e && e.domQuery ? e.code : 'query_failed',
      message:e && e.domQuery ? e.message : 'DOM inspection failed; no fallback target used.'}};
  }
}

export function validateDomQuery(value: unknown): DomQuery {
  const bad = (): never => { throw new Error('Invalid DOM query'); };
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad();
    return v as Record<string, unknown>;
  };
  const p = object(value);
  if (Object.keys(p).sort().join(',') !== 'action,locator,names,query') bad();
  const l = object(p.locator);
  const keys = ['css','text','role','label','placeholder','testid'];
  if (Object.keys(l).some(k => ![...keys,'name','nth','first','last'].includes(k)) || keys.filter(k => k in l).length !== 1) bad();
  for (const k of [...keys,'name']) if (k in l && (typeof l[k] !== 'string' || [...l[k] as string].length > 1024)) bad();
  if (l.css === '' || l.role === '' || ('name' in l && !('role' in l))) bad();
  if (['nth','first','last'].filter(k => k in l).length > 1) bad();
  if ('nth' in l && (typeof l.nth !== 'number' || !Number.isInteger(l.nth) || l.nth < 0 || l.nth >= 500)) bad();
  for (const k of ['first','last']) if (k in l && l[k] !== true) bad();
  if (!Array.isArray(p.names) || p.names.some(n => typeof n !== 'string')) bad();
  const names = p.names as string[];
  if (p.action === 'find') { if (p.query !== null) bad(); }
  else if (p.action === 'get') { if (!['text','html','value','attribute','count','box','computedstyles'].includes(p.query as string)) bad(); }
  else if (p.action === 'is') { if (!['visible','enabled','checked','editable','attached'].includes(p.query as string)) bad(); }
  else bad();
  if (p.action === 'get' && (p.query === 'attribute' || p.query === 'computedstyles')) {
    if (names.length < 1 || names.length > (p.query === 'attribute' ? 1 : 32) || names.some(n => !n || [...n].length > 128)) bad();
  } else if (names.length) bad();
  const size = new TextEncoder().encode(String(p.action) + (p.query ?? '') + JSON.stringify(l) + names.join('')).length;
  if (size > 4096) bad();
  return value as DomQuery;
}
