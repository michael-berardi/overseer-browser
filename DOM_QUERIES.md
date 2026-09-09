# Local read-only DOM queries

These use the fixed native `dom.query` command (0.6.0 unreleased), not evaluate.
No Allow User Scripts permission is required. Existing owned-session/tab and
borrowed-site access checks apply. Older extensions return
`extension_upgrade_required`; operator reload is required, never an eval fallback.

## Syntax (after parent CLI integration)

```sh
overseer-browser --session SESSION dom find '{"role":"button","name":"Save"}'
overseer-browser --session SESSION dom get text '{"css":"h1","first":true}'
overseer-browser --session SESSION dom get attribute '{"testid":"account"}' href
overseer-browser --session SESSION dom get computedstyles '{"css":"main"}' color display
overseer-browser --session SESSION dom get count '{"placeholder":"Search"}'
overseer-browser --session SESSION dom is visible '{"label":"Email"}'
```

`dom find LOCATOR` returns bounded descriptors (`index`, tag, id, role, name),
not persistent refs. `index` is the index in the returned selection.

`dom get QUERY LOCATOR [NAMES...]`: queries are `text`, `html` (outerHTML),
`value`, `attribute` (one attribute name), `count`, `box`, `computedstyles`
(1–32 explicit CSS property names). Text is raw descendant text, not rendered
innerText. Box coordinates are CSS pixels relative to the top viewport.
Missing attributes/non-value elements return null; empty strings, false and zero
are not discarded. Returned text, HTML, attributes and values may contain secrets.

`dom is STATE LOCATOR`: states are `visible`, `enabled`, `checked`, `editable`,
`attached`. These are DOM heuristics, not native actionability guarantees.

## Locator JSON

Exactly one string key: `css`, `text`, `role`, `label`, `placeholder`, `testid`.
`role` alone optionally accepts `name`. Test IDs use `data-testid`.
Text/name/label comparisons are whitespace-normalized exact matches;
placeholder/testid comparisons are exact. Text includes ancestor matches: select
a specific element or resolve ambiguity deliberately. Names use aria-labelledby,
aria-label, associated labels, image alt, button-input value, then descendant
text. Implicit roles cover common HTML controls/headings/lists/tables only, not
the complete accessibility-name or ARIA mapping specifications.

One optional disambiguator: `nth` (zero-based integer 0–499), `first: true`, or
`last: true`. These apply before count/find/get/is. Without a disambiguator,
get/is require one match (`ambiguous_match` otherwise). Exceptions: `count`
returns the count, and `attached` returns false for no match. Find returns an
array (empty on no match); other singular queries return `no_match`.

Unknown/duplicate keys, multiple locator types, arbitrary JavaScript, unsupported
scopes, invalid selectors and invalid arguments fail explicitly. CSS remains
native CSS evaluated separately within each root; it cannot cross shadow boundaries.

## Scope, limits and honesty

* Top document and recursively **open** shadow roots only. Deterministic traversal:
  host, shadow subtree, then host light-DOM subtree. No composed-slot projection.
* Frames are not descended into, including same-origin frames. Existing native
  frame helpers are nested inside another injected program and cannot be reused
  cleanly by the fixed inspector. `frame`/scope keys are rejected; iframe elements themselves
  can be inspected. Cross-origin frames and closed shadow internals are inaccessible.
  Closed roots cannot reliably be detected by ordinary DOM APIs. No match means
  no match **in supported scope**, not proof of absence in inaccessible trees.
  There is no implicit target/root/tab/session fallback.
* At most 4096 UTF-8 bytes of arguments, 1024 characters per locator string,
  5000 inspected elements, 500 matches, 5000 text nodes/65536 text characters
  per text inspection, and 65536 UTF-8 bytes of successful result envelope.
  Limit violations fail rather than truncate or miscount. Even a narrow selector
  scans the bounded document and can fail on large pages. Native CSS matching,
  layout and outerHTML serialization cannot be interrupted mid-operation;
  outerHTML/value materialization can temporarily exceed the output limit.
* A 250ms cooperative page-work budget is checked throughout traversal; this is
  not hard browser preemption. The parent callback must also bound transport
  timeout. No polling, observers, event dispatch, navigation, DOM mutation or
  retained element handles. A subsequent query may see a changed page.
* Visibility checks connection, CSS visibility/display/content-visibility/opacity,
  and positive client rects; it does not prove viewport intersection, lack of
  occlusion or trusted clickability. Enabled checks native disabled plus inherited
  inert/aria-disabled; checked uses native checked or aria-checked=true (mixed is
  false). Editable covers enabled non-readonly text-like inputs, textarea and
  contenteditable, not trusted keyboard parity.

## Parent integration

```python
from cli import dom_query

# In the dom branch AFTER global session/tab/request option extraction:
# Require a non-None owned session_key; never ambient tab/session routing.
# Reject unrelated --max-nodes and --wait-until options (fixed helper limits).
def dom_request(command, params):
    params = dict(params)
    if tab_id is not None:
        params['tab_id'] = tab_id
    return request_once(command, params, timeout=timeout,
                        request_id=request_id, **request_options)

payload = dom_query.run('dom', args, dom_request)
_render(payload, json_output, raw_json)
# exit 0 iff payload.get('ok'), otherwise 1
```

`request_options` must carry the already-resolved owned `session_key`.
The helper calls the callback exactly once for valid input, with
`('dom.query', {'query': DATA})`, where DATA contains action, query, locator,
and names. The canonical closure-free function in `extension/src/dom_query.ts`
runs in the isolated world, top frame only, via `chrome.scripting.executeScript`.
Only validated JSON data crosses the wire; no runtime eval or Function constructor.
The helper unwraps `response['result']`. Request IDs/timeouts remain CLI-owned.

Focused check:

```sh
python3 -m unittest discover -s tests -p test_dom_query.py -v
```

Tests use Python and a small Node DOM double (no installed test dependencies);
they do not claim real-browser/accessibility/layout validation. No live session
was used.
