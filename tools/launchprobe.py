#!/usr/bin/env python3
"""DeadRamp Base launch tooling: harvest + CPython probe.

Two subcommands, both pure evidence work over the DeadRamp source
tree. Nothing here invents behaviour; everything emitted traces to
a source file.

harvest  -> tools/launch-harvest.json
    Per build group: the demo-user registry its __main__ declares
    (resolved statically from the source), and the recorded HTTP
    exchanges inside its test suites: calls made through the tests'
    own request helpers whose method, path, headers, and body are
    statically literal, paired with the response facts the same
    test asserts (exact body, asserted fields, asserted status).
    Every exchange names the test file and test it was recorded
    from. Calls whose inputs are not statically literal are counted
    as skipped, never guessed.

probe    -> tools/probe-cpython.json
    Per build group: drives the build's own HTTP handler in-process
    under this CPython (launch/driver.py, the same driver the
    browser probe and the client use), through a canonical set of
    requests drawn from the build's own extracted surface (its
    literal routes and resource roots, from the catalog). Records
    the verdict and the full responses, which become the recorded
    surface's drive exchanges: real outputs of the build's own
    code, recorded at export time.

The browser verdict (Pyodide in headless Chrome) is produced by
tools/probe-live-web.js into tools/live-probe-results.json; the
exporter derives each build's catalogued mode from that file.
"""
import ast
import json
import os
import subprocess
import sys

HTTP_VERBS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER = os.path.join(REPO, "launch", "driver.py")


# ------------------------------------------------------------------
# demo users
# ------------------------------------------------------------------
def _literal_dict(node):
    """A name->role registry as written in the source: either a
    literal str:str dict, or a dict whose values are identity
    objects constructed with (name, role) string arguments (the
    User dataclass shape two builds use); the role is the second
    argument, exactly as the source states it."""
    try:
        value = ast.literal_eval(node)
    except Exception:
        value = None
    if isinstance(value, dict) and all(
            isinstance(k, str) and isinstance(v, str)
            for k, v in value.items()):
        return value
    if isinstance(node, ast.Dict) and node.keys:
        out = {}
        for key_node, val_node in zip(node.keys, node.values):
            if not isinstance(key_node, ast.Constant) \
                    or not isinstance(key_node.value, str):
                return None
            if not isinstance(val_node, ast.Call) \
                    or len(val_node.args) < 2 \
                    or not isinstance(val_node.args[1], ast.Constant) \
                    or not isinstance(val_node.args[1].value, str):
                return None
            out[key_node.value] = val_node.args[1].value
        return out or None
    return None


def _module_assigns(tree):
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            out[node.targets[0].id] = node.value
    return out


def _resolve_name(tree, modules, name, depth=0):
    """Resolve a module-level name to a name->role dict, following
    aliases and `from .<mod> import <name>` one module at a time."""
    if depth > 3 or tree is None:
        return None
    assigns = _module_assigns(tree)
    node = assigns.get(name)
    if node is None:
        # the name may be imported, not assigned, in this module
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom) and stmt.module:
                for alias in stmt.names:
                    if alias.name == name and stmt.module in modules:
                        return _resolve_name(modules[stmt.module], modules,
                                             name, depth + 1)
        return None
    seen = set()
    while node is not None:
        got = _literal_dict(node)
        if got is not None:
            return got
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                and node.func.id == "dict" and len(node.args) == 1 \
                and isinstance(node.args[0], ast.Name):
            nxt = node.args[0].id
        elif isinstance(node, ast.Name):
            nxt = node.id
        else:
            return None
        if nxt in seen:
            return None
        seen.add(nxt)
        if nxt in assigns:
            node = assigns[nxt]
            continue
        return _resolve_name(tree, modules, nxt, depth + 1)
    return None


def _resolve_users_in(tree, modules, depth=0):
    return _resolve_name(tree, modules, "DEMO_USERS", depth)


def resolve_demo_users(group_dir):
    src = os.path.join(group_dir, "src")
    pkgs = sorted(d for d in os.listdir(src)
                  if os.path.isdir(os.path.join(src, d)))
    if not pkgs:
        return None, None
    pkg = pkgs[0]
    base = os.path.join(src, pkg)
    modules = {}
    for fname in ("service.py", "store.py", "audit.py", "__main__.py"):
        p = os.path.join(base, fname)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                modules[fname[:-3]] = ast.parse(fh.read())
    main_tree = modules.get("__main__")
    if main_tree is None:
        return pkg, None
    return pkg, _resolve_users_in(main_tree, modules)


# ------------------------------------------------------------------
# recorded exchanges from the test suites
# ------------------------------------------------------------------
def _literal(node, scope):
    """Resolve a node to a Python literal using a name->literal map."""
    if node is None:
        return None, False
    if isinstance(node, ast.Name):
        if node.id in scope:
            return scope[node.id], True
        return None, False
    try:
        return ast.literal_eval(node), True
    except Exception:
        return None, False


def _scope_of(tree):
    scope = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            value, ok = _literal(node.value, scope)
            if ok:
                scope[node.targets[0].id] = value
    return scope


def _is_request_call(node):
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr in ("request", "call")
    if isinstance(func, ast.Name):
        return func.id in ("call", "request")
    return False


def _call_parts(node, scope):
    """(method, path, headers, body, ok) for a request-shaped call."""
    args = node.args
    kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
    method = path = None
    body = None
    headers = {}
    if len(args) >= 2:
        m0, ok0 = _literal(args[0], scope)
        if ok0 and isinstance(m0, str) and m0 in HTTP_VERBS:
            method = m0
            p1, ok1 = _literal(args[1], scope)
            if ok1 and isinstance(p1, str):
                path = p1
        elif len(args) >= 3:
            m1, ok1 = _literal(args[1], scope)
            p2, ok2 = _literal(args[2], scope)
            if ok1 and isinstance(m1, str) and m1 in HTTP_VERBS \
                    and ok2 and isinstance(p2, str):
                method, path = m1, p2
    if method is None or path is None:
        return None
    if "headers" in kwargs:
        hv, ok = _literal(kwargs["headers"], scope)
        if ok and isinstance(hv, dict):
            headers = {k: v for k, v in hv.items()
                       if isinstance(k, str) and isinstance(v, str)}
        elif hv is not None:
            return None
    user, uok = _literal(kwargs.get("user"), scope)
    role, rok = _literal(kwargs.get("role"), scope)
    if uok and isinstance(user, str):
        headers["X-User"] = user
    if rok and isinstance(role, str):
        headers["X-Role"] = role
    if "body" in kwargs:
        bv, ok = _literal(kwargs["body"], scope)
        if not ok:
            return None
        body = bv
    return method, path, headers, body


def _assertions(fn, status_var, body_var, text_var):
    """Response facts asserted after a call, in statement order."""
    status = None
    exact = None
    fields = {}
    present = []
    contains = []
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        name = func.attr
        a = node.args
        if name == "assertEqual" and len(a) == 2:
            for var_node, lit_node in ((a[0], a[1]), (a[1], a[0])):
                if isinstance(var_node, ast.Name) and var_node.id == status_var:
                    value, ok = _literal(lit_node, {})
                    if ok and isinstance(value, int):
                        status = value
                elif isinstance(var_node, ast.Name) and var_node.id == body_var:
                    value, ok = _literal(lit_node, {})
                    if ok and isinstance(value, (dict, list, str, int)):
                        exact = value
                elif isinstance(var_node, ast.Subscript) \
                        and isinstance(var_node.value, ast.Name) \
                        and var_node.value.id == body_var:
                    key, kok = _literal(var_node.slice, {})
                    value, ok = _literal(lit_node, {})
                    if kok and ok and isinstance(key, str):
                        fields[key] = value
        elif name == "assertIn" and len(a) == 2:
            needle, ok = _literal(a[0], {})
            if ok and isinstance(needle, str) and isinstance(a[1], ast.Name):
                if a[1].id == body_var:
                    present.append(needle)
                elif text_var and a[1].id == text_var:
                    contains.append(needle)
    return status, exact, fields, present, contains


def harvest_group(group_dir, group):
    tests_dir = os.path.join(group_dir, "tests")
    exchanges = []
    skipped = 0
    if not os.path.isdir(tests_dir):
        return exchanges, skipped
    for fname in sorted(os.listdir(tests_dir)):
        if not (fname.startswith("test_") and fname.endswith(".py")):
            continue
        fpath = os.path.join(tests_dir, fname)
        with open(fpath, encoding="utf-8") as fh:
            try:
                tree = ast.parse(fh.read())
            except SyntaxError:
                continue
        mod_scope = _scope_of(tree)
        rel = "groups/%s/tests/%s" % (group, fname)
        for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
            cls_scope = dict(mod_scope)
            for stmt in cls.body:
                if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
                        and isinstance(stmt.targets[0], ast.Name):
                    value, ok = _literal(stmt.value, cls_scope)
                    if ok:
                        cls_scope[stmt.targets[0].id] = value
            for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
                scope = dict(cls_scope)
                # local literal assignments in order
                for stmt in fn.body:
                    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
                            and isinstance(stmt.targets[0], ast.Name):
                        value, ok = _literal(stmt.value, scope)
                        if ok:
                            scope[stmt.targets[0].id] = value
                # request calls in source order
                calls = []
                for node in ast.walk(fn):
                    if _is_request_call(node):
                        parts = _call_parts(node, scope)
                        if parts is None:
                            skipped += 1
                        else:
                            calls.append((node, parts))
                for node, (method, path, headers, body) in calls:
                    # result variable names from the enclosing assign
                    status_var = body_var = text_var = None
                    for parent in ast.walk(fn):
                        if isinstance(parent, ast.Assign) \
                                and parent.value is node:
                            if isinstance(parent.targets[0], ast.Tuple):
                                elts = parent.targets[0].elts
                                if len(elts) >= 2 and isinstance(elts[0], ast.Name):
                                    status_var = elts[0].id
                                if len(elts) >= 2 and isinstance(elts[-1], ast.Name):
                                    body_var = elts[-1].id
                                if len(elts) >= 3 and isinstance(elts[1], ast.Name):
                                    text_var = elts[1].id
                    if status_var is None and body_var is None:
                        skipped += 1
                        continue
                    status, exact, fields, present, contains = _assertions(
                        fn, status_var, body_var, text_var)
                    if status is None and exact is None and not fields \
                            and not present and not contains:
                        skipped += 1
                        continue
                    response = {}
                    if exact is not None:
                        response["text"] = json.dumps(exact)
                    if fields:
                        response["fields"] = fields
                    if present:
                        response["fieldsPresent"] = present
                    if contains:
                        response["contains"] = contains
                    exchanges.append({
                        "method": method,
                        "path": path,
                        "headers": {k: headers[k] for k in sorted(headers)
                                    if k in ("X-User", "X-Role")},
                        "body": body,
                        "status": status,
                        "response": response,
                        "source": {"kind": "test", "file": rel,
                                   "test": "%s.%s" % (cls.name, fn.name)},
                    })
    # dedup (first wins in traversal order), then deterministic sort
    seen = set()
    unique = []
    for ex in exchanges:
        key = (ex["method"], ex["path"],
               json.dumps(ex["body"], sort_keys=True),
               ex["headers"].get("X-User", ""))
        if key in seen:
            continue
        seen.add(key)
        unique.append(ex)
    unique.sort(key=lambda e: (e["path"], e["method"],
                               e["headers"].get("X-User", ""),
                               json.dumps(e["body"], sort_keys=True)))
    return unique[:80], skipped


def cmd_harvest(root, out_path):
    groups_dir = os.path.join(root, "groups")
    result = {}
    total_ex = 0
    total_skip = 0
    for group in sorted(os.listdir(groups_dir)):
        gdir = os.path.join(groups_dir, group)
        if not os.path.isdir(gdir):
            continue
        pkg, users = resolve_demo_users(gdir)
        exchanges, skipped = harvest_group(gdir, group)
        total_ex += len(exchanges)
        total_skip += skipped
        result[group] = {
            "package": pkg,
            "demoUsers": users,
            "recorded": exchanges,
            "skippedCalls": skipped,
        }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("harvest: %d groups, %d exchanges, %d skipped calls -> %s"
          % (len(result), total_ex, total_skip, out_path))


# ------------------------------------------------------------------
# CPython probe (ground truth for the driver + drive exchanges)
# ------------------------------------------------------------------
RUNNER = r"""
import importlib.util, json, sys
sys.dont_write_bytecode = True  # driving a build must not dirty its tree
driver_path, src_dir, pkg, users_json, requests_json = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("launch_driver", driver_path)
drv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drv)
out = {"launch": json.loads(drv.drv_launch("probe", src_dir, pkg, users_json)),
       "results": []}
if out["launch"].get("ok"):
    for req in json.loads(requests_json):
        res = json.loads(drv.drv_request("probe", req["method"], req["path"],
                                         json.dumps(req.get("headers") or {}),
                                         req.get("bodyText") or ""))
        res["method"] = req["method"]; res["path"] = req["path"]
        res["user"] = req.get("user")
        out["results"].append(res)
print(json.dumps(out))
"""


def canonical_requests(build, users):
    routes = build.get("http", {}).get("routes", [])
    resources = build.get("http", {}).get("resources", [])
    get_routes = [r.split(" ", 1)[1] for r in routes if r.startswith("GET ")]
    post_routes = [r.split(" ", 1)[1] for r in routes if r.startswith("POST ")]
    admin = None
    if users:
        for name in sorted(users):
            if users[name] == "admin":
                admin = name
                break
        if admin is None:
            admin = sorted(users)[0]
    admin_h = {"X-User": admin, "X-Role": users[admin]} if admin else {}
    protected = None
    for r in get_routes:
        if r != "/health":
            protected = r
            break
    if protected is None and resources:
        protected = "/" + resources[0]
    reqs = []
    if "/health" in get_routes:
        reqs.append({"method": "GET", "path": "/health", "headers": {},
                     "user": None, "tag": "health"})
    if protected:
        reqs.append({"method": "GET", "path": protected, "headers": {},
                     "user": None, "tag": "unauthenticated"})
        reqs.append({"method": "GET", "path": protected,
                     "headers": {"X-User": "mallory", "X-Role": "admin"},
                     "user": "mallory", "tag": "unknown-user"})
        if admin:
            reqs.append({"method": "GET", "path": protected,
                         "headers": admin_h, "user": admin, "tag": "admin"})
    if post_routes and admin:
        reqs.append({"method": "POST", "path": post_routes[0],
                     "headers": admin_h, "user": admin, "tag": "admin-post",
                     "bodyText": "{}"})
    return reqs


def cmd_probe(root, catalog_path, out_path):
    with open(catalog_path, encoding="utf-8") as fh:
        catalog = json.load(fh)
    builds = catalog.get("builds", {})
    result = {}
    for group in sorted(builds):
        build = builds[group]
        gdir = os.path.join(root, "groups", group)
        pkg, users = resolve_demo_users(gdir)
        pkg = pkg or build.get("package")
        src_dir = os.path.join(gdir, "src")
        reqs = canonical_requests(build, users)
        entry = {"package": pkg, "ok": False, "stage": "launch",
                 "requests": [], "drive": [], "error": None}
        try:
            proc = subprocess.run(
                [sys.executable, "-B", "-c", RUNNER, DRIVER, src_dir, pkg,
                 json.dumps(users or {}), json.dumps(reqs)],
                capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                entry["error"] = (proc.stderr or "").strip().split("\n")[-1]
                result[group] = entry
                continue
            got = json.loads(proc.stdout)
        except Exception as exc:
            entry["error"] = "%s: %s" % (type(exc).__name__, exc)
            result[group] = entry
            continue
        if not got["launch"].get("ok"):
            entry["error"] = got["launch"].get("error")
            result[group] = entry
            continue
        entry["stage"] = "requests"
        by_tag = {}
        for req, res in zip(reqs, got["results"]):
            by_tag[req["tag"]] = res
            entry["requests"].append({
                "method": req["method"], "path": req["path"],
                "tag": req["tag"], "user": req.get("user"),
                "status": res.get("status"), "error": res.get("error")})
            if res.get("status"):
                body = None
                if req.get("bodyText"):
                    try:
                        body = json.loads(req["bodyText"])
                    except ValueError:
                        body = req["bodyText"]
                entry["drive"].append({
                    "method": req["method"], "path": req["path"],
                    "headers": {k: req["headers"][k]
                                for k in sorted(req.get("headers") or {})
                                if k in ("X-User", "X-Role")},
                    "body": body,
                    "status": res["status"],
                    "response": {"text": (res.get("body") or "")[:4000]},
                    "source": {"kind": "drive",
                               "file": "groups/%s/src/%s/service.py"
                                       % (group, pkg),
                               "test": "exporter drive (CPython, launch/driver.py)"},
                })
        key = by_tag.get("admin") or by_tag.get("health")
        health = by_tag.get("health")
        ok = bool(key and key.get("status") and not key.get("error"))
        if health is not None:
            ok = ok and not health.get("error") and bool(health.get("status"))
        entry["ok"] = ok
        if not ok and key is not None:
            entry["error"] = key.get("error") or "no real response"
        result[group] = entry
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, sort_keys=True)
        fh.write("\n")
    n_ok = sum(1 for v in result.values() if v["ok"])
    print("probe: %d/%d builds drive clean under CPython -> %s"
          % (n_ok, len(result), out_path))
    for g, v in result.items():
        if not v["ok"]:
            print("  NOT OK %s: %s" % (g, v["error"]))


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["harvest", "probe"])
    ap.add_argument("--root", default=os.path.expanduser("~/workspace/deadramp"))
    ap.add_argument("--catalog",
                    default=os.path.join(REPO, "data", "base-catalog.json"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if args.cmd == "harvest":
        cmd_harvest(args.root, args.out or os.path.join(
            REPO, "tools", "launch-harvest.json"))
    else:
        cmd_probe(args.root, args.catalog, args.out or os.path.join(
            REPO, "tools", "probe-cpython.json"))


if __name__ == "__main__":
    main()
