#!/usr/bin/env python3
"""
Reproduces the pre_commit_regression_check jsonKey false positive and proves the fix.

Runs BOTH the current logic and the proposed one over two diffs taken from real cases:

  A. a reformatting diff  - every line rewritten, not one key removed
  B. a deletion diff      - one key genuinely gone

The fix has to be silent on A and still fire on B. A fix that only satisfies A is a
mute button, which is worse than the false positive: it would hide the regressions the
gate exists to catch.

Usage:  python docs/upstream/verify-json-key-fix.py
Exit 0 = the proposed logic behaves; exit 1 = it does not.
"""
import re
import sys

KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:')


def _keys(lines):
    out = set()
    for line in lines:
        m = KEY_RE.match(line)
        if m and not m.group(1).startswith('_'):
            out.add(m.group(1))
    return out


def current(removed_lines, added_lines):
    """server.py as it stands: removed lines only, added side never consulted."""
    found = []
    for line in removed_lines:
        m = KEY_RE.match(line)
        if m and not m.group(1).startswith('_'):
            found.append(m.group(1))
    return sorted(set(found))


def proposed(removed_lines, added_lines):
    """A key on BOTH sides was reformatted, not removed."""
    return sorted(_keys(removed_lines) - _keys(added_lines))


# --- Case A: reformatting. Same four keys, re-indented from 4 spaces to 2. -----------
A_REMOVED = [
    '    "endpoint": "/api/assignment/simulate",',
    '    "method": "POST",',
    '    "expectedStatus": 200,',
    '    "requiresAuth": true,',
]
A_ADDED = [
    '  "endpoint": "/api/assignment/simulate",',
    '  "method": "POST",',
    '  "expectedStatus": 200,',
    '  "requiresAuth": true,',
]

# --- Case B: a real deletion. "captureResponse" is gone; the rest just moved. --------
B_REMOVED = [
    '    "endpoint": "/api/assignment/simulate",',
    '    "captureResponse": {',
    '    "method": "POST",',
]
B_ADDED = [
    '  "endpoint": "/api/assignment/simulate",',
    '  "method": "POST",',
]

failures = []

a_cur, a_new = current(A_REMOVED, A_ADDED), proposed(A_REMOVED, A_ADDED)
print('Case A - reformatting only, nothing removed')
print(f'  current  -> {len(a_cur)} "removed" keys: {a_cur}')
print(f'  proposed -> {len(a_new)} "removed" keys: {a_new}')
if a_new:
    failures.append('A: proposed logic still reports keys on a pure reformat')
if not a_cur:
    failures.append('A: current logic did not reproduce the false positive - check the fixture')

b_cur, b_new = current(B_REMOVED, B_ADDED), proposed(B_REMOVED, B_ADDED)
print('\nCase B - one key genuinely deleted')
print(f'  current  -> {b_cur}')
print(f'  proposed -> {b_new}')
if b_new != ['captureResponse']:
    failures.append(f'B: proposed logic lost the real deletion (got {b_new})')

print()
if failures:
    for f in failures:
        print(f'FAIL: {f}')
    sys.exit(1)

print('PASS: the fix silences the reformat false positive and keeps the real deletion.')
print(f'      (current logic reports {len(a_cur)} phantom removals on Case A)')
sys.exit(0)
