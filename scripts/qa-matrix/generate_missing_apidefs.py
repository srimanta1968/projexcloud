"""Scan all implemented routes in packages/ + services/, find those WITHOUT an
api_definition, and generate canonical api_definition JSON files for them.

Generated defs are marked testability:"manual" (_generated:true) with a
best-effort payload/pathParams inferred from the handler — so they are
DISCOVERED + registered by the projexlight pre-commit/pre-push hooks and appear
in the docs, without breaking the auto-test gate on imperfect payloads.
"""
import json
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API_DIR = os.path.join(ROOT, "tests", "api_definitions")

ROUTE_RE = re.compile(
    r"\b(?:app|router|instance|fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*(<.*?>)?\s*\(\s*([`'\"])(/[^`'\"]+)\3",
    re.DOTALL,
)
SUCCESS_RE = re.compile(r"\.(?:code|status)\(\s*(2\d\d)\s*\)")
BODY_GENERIC_RE = re.compile(r"Body\s*:\s*\{")


def norm(path):
    """Normalize a route path for matching: lower, params -> :p, strip trailing /."""
    p = re.sub(r"[:{<]\w+[>}]?", ":p", path)
    return p.rstrip("/").lower()


def sdk_for(relfile):
    f = relfile.replace("\\", "/")
    m = re.search(r"packages/([^/]+)/", f)
    if m:
        return m.group(1)
    m = re.search(r"services/([^/]+)/", f)
    if m:
        return m.group(1)
    return "(unknown)"


def path_params(path):
    return re.findall(r"[:{<](\w+)[>}]?", path)


def resource_stem(path):
    segs = [s for s in path.strip("/").split("/") if s]
    if segs and segs[0] == "api":
        segs = segs[1:]
    if not segs:
        return "root", "index"
    resource = re.sub(r"[^a-z0-9]+", "-", segs[0].lower()) or "root"
    rest = segs[1:] or ["index"]
    stem = "-".join(re.sub(r"[:{<]\w+[>}]?", lambda m: m.group(0).strip(":{<>}"), s) for s in rest)
    stem = re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-").lower() or "index"
    return resource, stem


def placeholder_for(field):
    f = field.lower()
    if "email" in f:
        return "{{dynamic:email}}"
    if f.endswith("_at") or f.endswith("date") or "time" in f:
        return "{{dynamic:futuredatetime}}"
    if f.endswith("_id") or f == "id":
        return "{{static:REPLACE_WITH_ID}}"
    if "name" in f:
        return "{{dynamic:name}}"
    if "password" in f:
        return "{{dynamic:password}}"
    if "url" in f or "uri" in f:
        return "https://example.com"
    if "count" in f or "amount" in f or "qty" in f or "quantity" in f or "hours" in f or f.endswith("_ms") or "limit" in f:
        return 1
    if f.startswith("is_") or f.startswith("has_") or "enabled" in f:
        return True
    return "{{static:sample}}"


def extract_body_fields(generic, body_after):
    """Pull field names from a Fastify Body generic or a req.body destructure."""
    fields = []
    # 1) Fastify Body generic: <{ Body: { a: string; b?: number } }>
    if generic and "Body" in generic:
        m = BODY_GENERIC_RE.search(generic)
        if m:
            # balanced-brace capture of the Body object
            i = m.end() - 1
            depth, j = 0, i
            for j in range(i, len(generic)):
                if generic[j] == "{":
                    depth += 1
                elif generic[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
            inner = generic[i + 1:j]
            for fm in re.finditer(r"(\w+)\s*\??\s*:", inner):
                fields.append(fm.group(1))
    # 2) const { a, b } = req.body
    for dm in re.finditer(r"const\s*\{([^}]*)\}\s*=\s*(?:req|request)\.body", body_after):
        for nm in re.findall(r"\w+", dm.group(1)):
            fields.append(nm)
    # 3) req.body.field
    for dm in re.finditer(r"(?:req|request)\.body\.(\w+)", body_after):
        fields.append(dm.group(1))
    # dedupe preserve order
    seen, out = set(), []
    for f in fields:
        if f not in seen and f not in ("Body",):
            seen.add(f)
            out.append(f)
    return out


# ---- existing coverage ----
existing = set()
for dp, _d, fs in os.walk(API_DIR):
    for fn in fs:
        if not fn.endswith(".json") or fn == "api_summary.json":
            continue
        try:
            d = json.load(open(os.path.join(dp, fn), encoding="utf-8"))
        except Exception:
            continue
        if isinstance(d, dict) and d.get("endpoint"):
            existing.add((d.get("method", "").upper(), norm(d["endpoint"])))

# ---- scan code ----
routes = {}  # (METHOD, norm) -> dict
for base in ("packages", "services"):
    for dp, dirs, fs in os.walk(os.path.join(ROOT, base)):
        if any(seg in dp for seg in ("node_modules", os.sep + "dist", os.sep + "tests")):
            continue
        for fn in fs:
            if not fn.endswith(".ts") or fn.endswith(".d.ts") or ".test." in fn or ".spec." in fn:
                continue
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, ROOT)
            try:
                src = open(full, encoding="utf-8").read()
            except Exception:
                continue
            for m in ROUTE_RE.finditer(src):
                method = m.group(1).upper()
                generic = m.group(2) or ""
                path = m.group(4)
                if path.startswith("/mcp") or "${" in path:
                    continue
                key = (method, norm(path))
                if key in existing or key in routes:
                    continue
                window = src[m.end(): m.end() + 1600]
                success = SUCCESS_RE.findall(window)
                status = 0
                if success:
                    nums = sorted(int(s) for s in success)
                    status = nums[0]
                if not status:
                    status = 201 if method in ("POST", "PUT") else 200
                auth = bool(re.search(r"requireAuth|authenticate|authorizeRole|preHandler", m.group(0) + window[:400]))
                admin = "x-admin-ops-token" in window or "checkAdminToken" in window
                body_fields = extract_body_fields(generic, window) if method in ("POST", "PUT", "PATCH") else []
                routes[key] = {
                    "method": method, "path": path, "file": rel, "sdk": sdk_for(rel),
                    "status": status, "auth": auth, "admin": admin, "body_fields": body_fields,
                    "params": path_params(path),
                }

# ---- generate files ----
made = 0
used_names = set()
for (method, _n), r in sorted(routes.items(), key=lambda kv: (kv[1]["sdk"], kv[1]["path"], kv[1]["method"])):
    resource, stem = resource_stem(r["path"])
    fname = f"{stem}-{method.lower()}.json"
    rel_out = os.path.join("tests", "api_definitions", resource, fname)
    n = 1
    while rel_out in used_names or os.path.exists(os.path.join(ROOT, rel_out)):
        fname = f"{stem}-{method.lower()}-{n}.json"
        rel_out = os.path.join("tests", "api_definitions", resource, fname)
        n += 1
    used_names.add(rel_out)

    headers = {}
    if r["auth"]:
        headers["Authorization"] = "Bearer {{cache:auth.register.response.data.token}}"
    if r["admin"]:
        headers["x-admin-ops-token"] = "{{static:ADMIN_OPS_TOKEN}}"
    payload = None
    if r["method"] in ("POST", "PUT", "PATCH"):
        payload = {f: placeholder_for(f) for f in r["body_fields"]} or {}
    pp = {p: "{{static:REPLACE_WITH_ID}}" for p in r["params"]} or None

    tc = {"name": "Auto-generated from route scan (review payload before enabling)"}
    if headers:
        tc["headers"] = headers
    if pp:
        tc["pathParams"] = pp
    if payload is not None:
        tc["payload"] = payload
    tc["expectedStatus"] = r["status"]

    definition = {
        "name": f"{method} {r['path']} — {r['sdk']}",
        "endpoint": r["path"],
        "method": method,
        "requiresAuth": bool(r["auth"]),
        "expectedStatus": r["status"],
        "sdk": r["sdk"],
        "sourceFile": r["file"].replace("\\", "/"),
        "_generated": True,
        "testability": "manual",
        "skipReason": "Auto-generated from implemented route scan; payload/expectedResponse inferred from the handler and need review before enabling automated execution.",
        "testCases": [tc],
    }
    out_abs = os.path.join(ROOT, rel_out)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    with open(out_abs, "w", encoding="utf-8") as f:
        json.dump(definition, f, indent=2)
    made += 1

print(f"existing_defs={len(existing)} scanned_routes_missing={len(routes)} files_generated={made}")
