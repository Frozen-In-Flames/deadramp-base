# DeadRamp Base launch driver.
#
# Runs one DeadRamp reference build's own HTTP service in-process:
# the build's make_server() is called with the build's own store,
# audit log, and demo-user registry, exactly as its __main__ does,
# except that the socket-binding server class is replaced by a stub
# that captures the handler class make_server builds. Requests are
# then driven through that handler class with in-memory streams, so
# the build's routing, auth, store, and audit code all execute for
# real and hold state for the life of the session. A browser cannot
# bind a port; the transport is the only substituted part, and this
# file says so wherever it matters.
#
# Used identically by the exporter's browser probe (evidence for the
# catalog's live/recorded mode) and by the Base client under Pyodide
# (the room terminal's live sessions). One driver, one behaviour.
#
# All entry points take and return JSON strings so the JavaScript
# bridge stays trivial.

import io
import json
import sys
import importlib
import inspect
from http.client import parse_headers


class _StubServer:
    """Stands in for ThreadingHTTPServer / HTTPServer.

    Captures the handler class make_server passes, accepts the
    attribute assignments make_server performs (daemon_threads and
    friends), and never opens a socket."""

    def __init__(self, address, handler_cls=None, **kwargs):
        if handler_cls is None:
            handler_cls = kwargs.get("RequestHandlerClass")
        self.server_address = address
        self.handler_cls = handler_cls
        self.daemon_threads = True

    def server_close(self):
        pass

    def shutdown(self):
        pass


_SESSIONS = {}


def _ensure_ssl():
    """Some runtimes (Pyodide) ship no ssl module, while the builds
    import it at module level for their optional TLS serving branch.
    The driver never passes a certificate, so that branch never
    executes, exactly as when a build runs without TLS flags. When
    the real module is missing, install a stand-in that resolves the
    import and the protocol constants, and raises if any TLS object
    is actually constructed. When the real module exists (CPython),
    do nothing."""
    try:
        import ssl  # noqa: F401
        return
    except Exception:
        pass
    import types
    stub = types.ModuleType("ssl")
    stub.PROTOCOL_TLS = 2
    stub.PROTOCOL_TLS_SERVER = 16
    stub.PROTOCOL_TLS_CLIENT = 17
    stub.CERT_NONE = 0
    stub.CERT_OPTIONAL = 1
    stub.CERT_REQUIRED = 2

    class _Unavailable:
        def __init__(self, *a, **k):
            raise RuntimeError(
                "TLS is not available in this runtime; the build's "
                "TLS serving branch cannot execute here")

    stub.SSLContext = _Unavailable
    stub.SSLSocket = _Unavailable
    stub.wrap_socket = lambda *a, **k: (_ for _ in ()).throw(RuntimeError(
        "TLS is not available in this runtime"))
    sys.modules["ssl"] = stub


def _find_store_cls(store_mod):
    cands = []
    for name in dir(store_mod):
        obj = getattr(store_mod, name)
        if (isinstance(obj, type) and name.endswith("Store")
                and obj.__module__ == store_mod.__name__):
            cands.append(obj)
    if len(cands) != 1:
        raise RuntimeError(
            "expected exactly one *Store class in %s, found %d"
            % (store_mod.__name__, len(cands)))
    return cands[0]


def _launch(session_id, src_dir, pkg, users):
    """Import the build under its (unique) package name, construct
    its store the way its __main__ does, and capture the handler
    class from its own make_server()."""
    _ensure_ssl()
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)
    svc = importlib.import_module(pkg + ".service")
    audit_mod = importlib.import_module(pkg + ".audit")
    store_mod = importlib.import_module(pkg + ".store")
    # The build's own demo registry, exactly as its __main__ declares
    # it (some builds map names to identity objects, not strings).
    # Fall back to the registry passed in when __main__ has none.
    try:
        main_mod = importlib.import_module(pkg + ".__main__")
        own = getattr(main_mod, "DEMO_USERS", None)
        if isinstance(own, dict) and own:
            users = dict(own)
    except Exception:
        pass
    audit = audit_mod.AuditLog()
    store_cls = _find_store_cls(store_mod)
    params = inspect.signature(store_cls.__init__).parameters
    kwargs = {"audit": audit} if "audit" in params else {}
    store = store_cls(**kwargs)

    import http.server as _hs

    def _fake(address, handler_cls=None, **kw):
        return _StubServer(address, handler_cls, **kw)

    patched = []
    for mod, attr in ((svc, "ThreadingHTTPServer"), (svc, "HTTPServer"),
                      (_hs, "ThreadingHTTPServer"), (_hs, "HTTPServer")):
        if hasattr(mod, attr):
            patched.append((mod, attr, getattr(mod, attr)))
            setattr(mod, attr, _fake)
    try:
        server = svc.make_server("127.0.0.1", 0, store, audit, dict(users))
    finally:
        for mod, attr, orig in patched:
            setattr(mod, attr, orig)
    handler_cls = (getattr(server, "handler_cls", None)
                   or getattr(server, "RequestHandlerClass", None))
    if handler_cls is None:
        raise RuntimeError("make_server did not yield a handler class")
    _SESSIONS[session_id] = (handler_cls, server)
    return {"ok": True, "handler": handler_cls.__name__,
            "store": store_cls.__name__}


def _request(session_id, method, path, headers, body_text):
    handler_cls, server = _SESSIONS[session_id]
    headers = dict(headers or {})
    # The builds' own test helpers all drive them with
    # Content-Type: application/json (set whenever a body is sent,
    # and unconditionally in one helper family), and some handlers
    # gate body parsing on it. The driver follows the same
    # convention, unless the caller set a content type itself.
    if not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = "application/json"
    # Handlers read the request body by Content-Length (all 101 do);
    # a real client sends it, so the driver sends the true length.
    if not any(k.lower() == "content-length" for k in headers):
        headers["Content-Length"] = str(len((body_text or "").encode("utf-8")))
    h = handler_cls.__new__(handler_cls)
    h.server = server
    h.client_address = ("127.0.0.1", 0)
    h.requestline = "%s %s HTTP/1.1" % (method, path)
    h.raw_requestline = h.requestline.encode("utf-8")
    h.command = method
    h.path = path
    h.request_version = "HTTP/1.1"
    h.default_request_version = "HTTP/1.1"
    h.close_connection = True
    raw = "".join("%s: %s\r\n" % (k, v)
                  for k, v in (headers or {}).items()).encode("utf-8")
    h.headers = parse_headers(io.BytesIO(raw))
    body = (body_text or "").encode("utf-8")
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    h._headers_buffer = []
    fn = getattr(h, "do_" + method, None)
    if fn is None:
        return {"status": 0, "body": "",
                "error": "the build's handler has no %s method" % method}
    try:
        fn()
    except Exception as exc:  # the build raised: report, never invent
        return {"status": 0, "body": "",
                "error": "%s: %s" % (type(exc).__name__, exc)}
    out = h.wfile.getvalue()
    head, sep, rest = out.partition(b"\r\n\r\n")
    if not sep:
        head, sep, rest = out.partition(b"\n\n")
    status = 0
    first = head.decode("utf-8", "replace").split("\r\n", 1)[0].split(" ")
    if len(first) >= 2:
        try:
            status = int(first[1])
        except ValueError:
            status = 0
    return {"status": status, "body": rest.decode("utf-8", "replace")}


def drv_launch(session_id, src_dir, pkg, users_json):
    try:
        res = _launch(session_id, src_dir, pkg, json.loads(users_json))
        return json.dumps(res)
    except Exception as exc:
        return json.dumps({"ok": False,
                           "error": "%s: %s" % (type(exc).__name__, exc)})


def drv_request(session_id, method, path, headers_json, body_text):
    try:
        res = _request(session_id, method, path,
                       json.loads(headers_json) if headers_json else {},
                       body_text or "")
        return json.dumps(res)
    except Exception as exc:
        return json.dumps({"status": 0, "body": "",
                           "error": "%s: %s" % (type(exc).__name__, exc)})


def drv_close(session_id):
    _SESSIONS.pop(session_id, None)
    return json.dumps({"ok": True})
