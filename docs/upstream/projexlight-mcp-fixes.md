# Upstream fixes for the ProjexLight MCP server

Three defects reproduced from ProjexCloud against the `projexlight-dev-mcp` image.
The source lives in that image (`/app/src/...`), not in this repository, so these are
patches to hand over rather than changes we can land here.

Tracked as **TK-4150** (the gate) and **TK-4151** (the two reviewer rules).

---

## 1. `pre_commit_regression_check` reports JSON keys as removed when nothing was removed

**Where:** `/app/src/core/server.py`, the `if ext == 'json':` block (≈ line 18553).

**What it does today**

```python
if ext == 'json':
    for line in removed_lines:
        m = _re.match(r'^\s*"([^"]+)"\s*:', line)
        if m and not m.group(1).startswith('_'):
            json_keys_removed.append(m.group(1))
```

`json_keys_removed` is built from **removed diff lines only**. Every other bucket in
this function collects the added side too — `fn_added`, `cls_added`, `const_added` exist
precisely so a rename is not reported as a deletion — but the JSON bucket has no
`json_keys_added` at all, so nothing ever subtracts a key that reappears three lines
down.

**Why that matters more than it looks.** Reformatting a JSON file — re-indenting,
sorting keys, a `json.dump(indent=2)` round-trip — rewrites every line. The diff shows
every key removed and every key added, and the check reports the whole file as deleted
symbols. Observed at 20, 14 and 11 "dangling references" across three runs, every one of
which still existed in the file.

This is a **gate**, which is what turns a false positive into damage:

- its `llmAutoAction: AUTO_RESTORE` on a symbol that was never removed tells an agent to
  put back something that is already there — applied blindly, that reverts correct work;
- the noise trains people to skip the check that exists to catch real regressions.

**Fix** — diff parsed key sets, not lines:

```python
if ext == 'json':
    def _json_keys(lines):
        out = set()
        for line in lines:
            m = _re.match(r'^\s*"([^"]+)"\s*:', line)
            if m and not m.group(1).startswith('_'):
                out.add(m.group(1))
        return out
    # A key present on BOTH sides was reformatted, not removed. This mirrors what the
    # fn/cls/const buckets already do with their *_added lists.
    json_keys_removed.extend(sorted(_json_keys(removed_lines) - _json_keys(added_lines)))
```

`added_lines` is already in scope directly above. Genuinely removed keys still surface,
so the real signal survives.

**Also reported:** the check hit its 30s timeout twice and returned 100k+ character
payloads. Worth bounding the response independently of this fix.

---

## 2. `AUTH-HEADER` fires on every correct `requiresRole` definition

**Where:** `/app/src/core/auth_header_review.py`, `audit_auth_header`.

```python
own_protected = (doc.get('requiresAuth') is True) or bool(doc.get('requiresRole')) or declares_401
...
if _has_auth(doc.get('headers')) or any(_has_auth(tc.get('headers')) for tc in (doc.get('testCases') or [])):
    return None
```

`requiresRole` marks the endpoint protected, and then the rule demands a credential
header in the definition. But the runner (`api_tester.py`, the role-token prefetch around
lines 1144–1230 and 7597) **fetches a role token for exactly these endpoints**, and a
definition-supplied `Authorization` header overrides it.

So the rule demands the one thing that breaks the behaviour it is checking for. The
reviewer is static and cannot see the resolution order, so a correctly authored
`requiresRole` definition is flagged permanently — five observed, including
`coach-scorecard-callid-get.json`.

**Fix** — a definition that declares `requiresRole` and supplies no header is relying on
the runner, which is correct authoring:

```python
# requiresRole means the RUNNER supplies the credential (it prefetches a role token),
# and a definition-supplied Authorization header would override it. Demanding one here
# asks the author to break the request.
if doc.get('requiresRole') and not doc.get('requiresAuth') is False:
    return None
```

placed after the exempt-path check and before the header scan. A protected definition
carrying no credential *and* no `requiresRole` must still be flagged.

---

## 3. `CODE-MATCH` cannot follow a barrel re-export

**Where:** `/app/src/core/server.py` ≈ line 13284.

`routes/index.ts` does `router.use('/leadflow/ai', aiRoutes)` through a re-export and
`aiRoutes` does `router.post('/propose')`, so the literal path `/leadflow/ai/propose`
never appears in any single file and the regex scan misses it. All 14 LeadFlow
definitions carry the finding permanently.

This one is **already advisory** — `severity: 'low'`, with a comment saying a miss is a
hint rather than an error — so it is the least urgent of the three. Two options:

1. resolve one level of `router.use(prefix, X)` where `X` is an imported symbol, joining
   the prefix to the sub-router's own paths; or
2. honour an explicit `implementedIn` field on the definition and suppress the finding
   when it points at a real file.

(2) is cheaper and does not deepen the scanner's coupling to one framework's idioms.

---

## Verification

Fix 1 is verified by `docs/upstream/verify-json-key-fix.py` in this repo, which runs the
current and proposed logic over a real reformatting diff and a real deletion diff.
