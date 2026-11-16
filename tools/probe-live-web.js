#!/usr/bin/env node
/*
 * DeadRamp Base live-execution probe (browser ground truth).
 *
 * For every DeadRamp build: stage its bundle (the build's own
 * Python package, renamed uniquely per group, under
 * launch/bundles/<group>/), load Pyodide in headless Chrome from
 * the local copy (the sandbox proxy blocks the CDN), launch the
 * build through launch/driver.py (the same driver the CPython
 * probe and the client use), drive the canonical request set drawn
 * from the build's own surface, and compare every status against
 * the CPython probe's recorded statuses (tools/probe-cpython.json).
 *
 * A build is LIVE only if the browser drive matches CPython
 * exactly. Output: tools/live-probe-results.json, which the
 * exporter reads to catalogue each build's mode. Nothing here is
 * shipped; the bundles it stages are the client's lazy payloads
 * and are regenerated identically by tools/export-catalog.js.
 *
 * Usage: node tools/probe-live-web.js [--only group,group]
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const DEADRAMP = path.resolve(REPO, '..', 'deadramp');
const PYODIDE_DIR = '/home/hatch/workspace/fif-ears/verify-web/pyodide-local';
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8947;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.py': 'text/plain', '.wasm': 'application/wasm', '.zip': 'application/zip' };

const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'base-catalog.json'), 'utf8'));
const harvest = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'launch-harvest.json'), 'utf8'));
const cpython = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'probe-cpython.json'), 'utf8'));

function bundleName(group, pkg) { return pkg + '_' + group.replace(/-/g, '_'); }

function stageBundle(group) {
  const build = catalog.builds[group];
  const srcDir = path.join(DEADRAMP, 'groups', group, 'src', build.package);
  const dest = path.join(REPO, 'launch', 'bundles', group, bundleName(group, build.package));
  fs.rmSync(path.join(REPO, 'launch', 'bundles', group), { recursive: true, force: true });
  const files = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else if (name.endsWith('.py')) {
        const out = path.join(dest, r);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(p, out);
        files.push(bundleName(group, build.package) + '/' + r);
      }
    }
  })(srcDir, '');
  return files;
}

function canonicalRequests(group) {
  const build = catalog.builds[group];
  const users = (harvest[group] && harvest[group].demoUsers) || {};
  const routes = build.http.routes || [];
  const resources = build.http.resources || [];
  const getRoutes = routes.filter((r) => r.startsWith('GET ')).map((r) => r.slice(4));
  const postRoutes = routes.filter((r) => r.startsWith('POST ')).map((r) => r.slice(5));
  let admin = null;
  for (const name of Object.keys(users).sort()) if (users[name] === 'admin') { admin = name; break; }
  if (!admin && Object.keys(users).length) admin = Object.keys(users).sort()[0];
  const adminH = admin ? { 'X-User': admin, 'X-Role': users[admin] } : {};
  let prot = getRoutes.find((r) => r !== '/health') || (resources.length ? '/' + resources[0] : null);
  const reqs = [];
  if (getRoutes.includes('/health')) reqs.push({ method: 'GET', path: '/health', headers: {}, tag: 'health' });
  if (prot) {
    reqs.push({ method: 'GET', path: prot, headers: {}, tag: 'unauthenticated' });
    reqs.push({ method: 'GET', path: prot, headers: { 'X-User': 'mallory', 'X-Role': 'admin' }, tag: 'unknown-user' });
    if (admin) reqs.push({ method: 'GET', path: prot, headers: adminH, tag: 'admin' });
  }
  if (postRoutes.length && admin) reqs.push({ method: 'POST', path: postRoutes[0], headers: adminH, tag: 'admin-post', bodyText: '{}' });
  return reqs;
}

const PROBE_PAGE = `<!DOCTYPE html><html><body><script src="/pyodide/pyodide.js"></script><script>
window.__ready = (async () => {
  window.__py = await loadPyodide({ indexURL: '/pyodide/' });
  window.__driver = await (await fetch('/launch/driver.py')).text();
  window.__py.runPython(window.__driver);
  return true;
})();
window.__probeGroup = async (group, files, pkgName, users, requests) => {
  const py = window.__py;
  const base = '/bundles/' + group;
  for (const rel of files) {
    const text = await (await fetch('/launch/bundles/' + group + '/' + rel)).text();
    const target = base + '/' + rel;
    py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    py.FS.writeFile(target, text);
  }
  const call = (fn, args) => {
    py.globals.set('__a', JSON.stringify(args));
    return JSON.parse(py.runPython('import json as _j; ' + fn + '(*_j.loads(__a))'));
  };
  const launch = call('drv_launch', ['probe', base, pkgName, JSON.stringify(users || {})]);
  const out = { launch, results: [] };
  if (launch.ok) {
    for (const r of requests) {
      const res = call('drv_request', ['probe', r.method, r.path,
        JSON.stringify(r.headers || {}), r.bodyText || '']);
      out.results.push({ status: res.status, error: res.error || null,
        body: (res.body || '').slice(0, 200) });
    }
    call('drv_close', ['probe']);
  }
  return out;
};
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (url === '/probe.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PROBE_PAGE); return; }
      let file;
      if (url.startsWith('/pyodide/')) file = path.join(PYODIDE_DIR, url.slice(9));
      else file = path.join(REPO, url);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

(async () => {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : null;
  const groups = Object.keys(catalog.builds).sort().filter((g) => !only || only.includes(g));
  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const results = {};
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${PORT}/probe.html`, { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => window.__ready);
    console.log('pyodide ready');
    for (const group of groups) {
      const files = stageBundle(group);
      const reqs = canonicalRequests(group);
      const users = (harvest[group] && harvest[group].demoUsers) || {};
      let got;
      try {
        got = await page.evaluate((g, f, p, u, r) => window.__probeGroup(g, f, p, u, r),
          group, files, bundleName(group, catalog.builds[group].package), users, reqs);
      } catch (e) {
        results[group] = { ok: false, stage: 'evaluate', error: String(e).slice(0, 300), requests: [] };
        console.log('FAIL(evaluate)', group, String(e).slice(0, 160));
        continue;
      }
      const cp = cpython[group] || { requests: [] };
      const cpStatus = {};
      for (const r of cp.requests) cpStatus[r.tag] = r.status;
      const entry = { ok: false, stage: 'launch', error: null, requests: [] };
      if (!got.launch.ok) {
        entry.error = got.launch.error || 'launch failed';
        results[group] = entry;
        console.log('FAIL(launch)', group, entry.error);
        continue;
      }
      entry.stage = 'requests';
      let allMatch = true;
      reqs.forEach((req, i) => {
        const res = got.results[i] || {};
        const match = res.status === cpStatus[req.tag] && !res.error;
        if (!match) allMatch = false;
        entry.requests.push({ method: req.method, path: req.path, tag: req.tag,
          status: res.status, cpStatus: cpStatus[req.tag], error: res.error || null });
      });
      entry.ok = allMatch;
      if (!allMatch) entry.error = 'browser statuses differ from the CPython drive';
      results[group] = entry;
      console.log(allMatch ? 'live-ok' : 'MISMATCH', group);
    }
  } finally {
    await browser.close();
    srv.close();
  }
  const outPath = path.join(REPO, 'tools', 'live-probe-results.json');
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const merged = { ...prev, ...results };
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 1) + '\n');
  const nOk = Object.values(results).filter((r) => r.ok).length;
  console.log(`probe-live: ${nOk}/${groups.length} builds live-verified in the browser -> ${outPath}`);
})();
