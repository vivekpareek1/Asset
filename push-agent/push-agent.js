#!/usr/bin/env node
'use strict';
/**
 * push-agent — connects to GitHub, pushes a directory, and deploys it on Render.
 *
 * Meant to be the standing tool for this project rather than a one-off: settings
 * live in .pushagent.json, so a routine deploy is one command with no flags.
 *
 * Runs on your own personal access token, so it is not limited by whatever
 * permissions a hosted integration was granted. No npm dependencies; Node 20+.
 *
 *   GITHUB_TOKEN=ghp_xxx node push-agent.js --repo owner/name --dir ./build
 *
 * It uses the Git Data API (blob -> tree -> commit -> ref) rather than the
 * contents API, so every file lands in ONE commit and binary files survive
 * intact. An interrupted run leaves the branch untouched: the ref is only
 * moved once the commit object exists.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const RENDER_API = process.env.RENDER_API_URL || 'https://api.render.com/v1';
const UA = 'push-agent';
const CONFIG_NAME = '.pushagent.json';
const POLL_MS = Number(process.env.PUSH_AGENT_POLL_MS) || 5000;

/** Render deploy statuses that mean "stop polling". */
const DEPLOY_DONE = { live: true, deactivated: true };
const DEPLOY_FAILED = { build_failed: true, update_failed: true, canceled: true, pre_deploy_failed: true };

/* ------------------------------------------------------------------ args -- */

const HELP = `
push-agent — push a directory to GitHub and deploy it on Render

  node push-agent.js [command] [options]

Commands
  push                       push the directory to GitHub          (default)
  deploy                     push, then trigger a Render deploy and wait
  status                     show the current Render service and last deploy
  init                       write .pushagent.json from the given options

Credentials, from the environment
  GITHUB_TOKEN               needs Contents: read and write
  RENDER_API_KEY             only for deploy and status

Options            (any of these can instead live in .pushagent.json)
  --repo <owner/name>        target repository
  --dir <path>               directory to push                     (default: .)
  --branch <name>            target branch          (default: repo default, else main)
  --message <text>           commit message
  --service <id>             Render service id, e.g. srv-xxxxxxxx
  --create                   create the repo if missing (private by default)
  --public                   with --create, make it public
  --dry-run                  list what would be pushed and stop
  --no-wait                  trigger the Render deploy without waiting for it
  --timeout <seconds>        how long to wait for a deploy          (default: 900)
  --config <path>            config file to read  (default: ./.pushagent.json)
  --force-empty              allow pushing zero files (deletes everything)
  --verbose                  log every API call
  --help                     this text

Examples
  node push-agent.js init --repo me/app --dir ./build --service srv-abc123
  node push-agent.js deploy
  node push-agent.js status

Exit codes
  0 success   1 usage error   2 auth failure   3 API failure
  4 nothing to push   5 the deploy failed
`;

const COMMANDS = new Set(['push', 'deploy', 'status', 'init']);

function parseArgs(argv) {
  const o = { command: 'push', dir: '.', create: false, public: false, dryRun: false,
              verbose: false, forceEmpty: false, wait: true, timeout: 900, _given: new Set() };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    if (!COMMANDS.has(argv[0])) fatal(1, `unknown command: ${argv[0]}`);
    o.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fatal(1, `${a} needs a value`);
      return v;
    };
    const mark = k => { o._given.add(k); return k; };
    switch (a) {
      case '--repo': o[mark('repo')] = next(); break;
      case '--dir': o[mark('dir')] = next(); break;
      case '--branch': o[mark('branch')] = next(); break;
      case '--message': o[mark('message')] = next(); break;
      case '--service': o[mark('service')] = next(); break;
      case '--config': o.config = next(); break;
      case '--token': o.token = next(); break;
      case '--timeout': o[mark('timeout')] = Number(next()) || 900; break;
      case '--create': o[mark('create')] = true; break;
      case '--public': o[mark('public')] = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--no-wait': o.wait = false; break;
      case '--force-empty': o.forceEmpty = true; break;
      case '--verbose': o.verbose = true; break;
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      default: fatal(1, `unknown option: ${a}`);
    }
  }
  return o;
}

/**
 * Merges saved settings under the command line. An option typed today always
 * wins over the same option saved last week — otherwise a one-off override
 * would silently do nothing.
 */
function withConfig(o) {
  const file = o.config ? path.resolve(o.config) : path.resolve(process.cwd(), CONFIG_NAME);
  let saved = {};
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { fatal(1, `${file} is not valid JSON: ${e.message}`); }
    log(`Using settings from ${path.relative(process.cwd(), file) || CONFIG_NAME}`);
  }
  const merged = { ...o };
  for (const k of ['repo', 'dir', 'branch', 'message', 'service', 'create', 'public', 'timeout']) {
    if (!o._given.has(k) && saved[k] !== undefined) merged[k] = saved[k];
  }
  merged._configPath = file;
  return merged;
}

function writeConfig(o) {
  const out = {};
  for (const k of ['repo', 'dir', 'branch', 'service', 'create', 'public']) {
    if (o[k] !== undefined && o[k] !== false) out[k] = o[k];
  }
  if (!out.repo) fatal(1, 'init needs at least --repo owner/name');
  fs.writeFileSync(o._configPath, JSON.stringify(out, null, 2) + '\n');
  log(`Wrote ${o._configPath}`);
  log(JSON.stringify(out, null, 2));
  log('\nNow a deploy is just: node push-agent.js deploy');
  log(`Add ${CONFIG_NAME} to .gitignore if the repo is shared \u2014 it holds no secrets, but it does name your service.`);
}

const log = (...a) => console.log(...a);
function fatal(code, msg) {
  console.error('error: ' + msg);
  process.exit(code);
}

/* ------------------------------------------------------------------- api -- */

class Api {
  constructor(token, verbose) { this.token = token; this.verbose = verbose; }

  /**
   * One authenticated request, with retries on the failures that are worth
   * retrying: 5xx, and secondary rate limits. A 4xx is a decision, not a blip.
   */
  async call(method, url, body, { attempt = 1 } = {}) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (this.verbose) log(`  ${method} ${url} -> ${res.status}`);

    if (res.status === 401) fatal(2, 'the token was rejected (401). Check GITHUB_TOKEN.');
    if (res.status === 403 && !res.headers.get('retry-after')) {
      const t = await res.text().catch(() => '');
      fatal(2, `permission denied (403). The token needs "repo" scope, or Contents: read and write.\n${t.slice(0, 300)}`);
    }

    const retryable = res.status >= 500 || res.status === 429 ||
                      (res.status === 403 && res.headers.get('retry-after'));
    if (retryable && attempt <= 4) {
      const waitFor = Number(res.headers.get('retry-after')) || Math.min(2 ** attempt, 8);
      log(`  ${res.status}, retrying in ${waitFor}s (attempt ${attempt} of 4)`);
      await new Promise(r => setTimeout(r, waitFor * 1000));
      return this.call(method, url, body, { attempt: attempt + 1 });
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async need(method, url, body, what) {
    const r = await this.call(method, url, body);
    if (!r.ok) {
      const msg = (r.json && r.json.message) || r.text.slice(0, 300) || '(no body)';
      fatal(3, `${what} failed (${r.status}): ${msg}`);
    }
    return r.json;
  }
}

/* ----------------------------------------------------------------- files -- */

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.env']);

/** Minimal .gitignore support: exact names, directory names, and *.ext globs. */
function loadIgnore(dir) {
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => l.replace(/\/$/, ''));
}
function ignored(rel, patterns) {
  const parts = rel.split('/');
  if (parts.some(p => ALWAYS_SKIP.has(p))) return true;
  return patterns.some(p => {
    if (p.startsWith('*.')) return rel.endsWith(p.slice(1));
    return parts.includes(p) || rel === p;
  });
}

async function walk(root) {
  const patterns = loadIgnore(root);
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { fatal(1, `cannot read ${dir}: ${e.message}`); }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ignored(rel, patterns)) continue;
      if (e.isSymbolicLink()) continue;          // never follow: avoids loops and escapes
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) {
        const st = await fsp.stat(full);
        out.push({ rel, full, size: st.size, mode: (st.mode & 0o111) ? '100755' : '100644' });
      }
    }
  }
  await rec(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

const human = n => n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : (n / 1048576).toFixed(1) + ' MB';

/* ---------------------------------------------------------------- render -- */

class Render {
  constructor(key, verbose) { this.key = key; this.verbose = verbose; }

  async call(method, pathname, body, { attempt = 1 } = {}) {
    const res = await fetch(RENDER_API + pathname, {
      method,
      headers: {
        'Authorization': `Bearer ${this.key}`,
        'Accept': 'application/json',
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (this.verbose) log(`  ${method} ${pathname} -> ${res.status}`);
    if (res.status === 401) fatal(2, 'Render rejected the API key (401). Check RENDER_API_KEY.');
    if (res.status === 403) fatal(2, 'Render denied the request (403). The key may not cover this workspace.');
    if ((res.status >= 500 || res.status === 429) && attempt <= 4) {
      const waitFor = Math.min(2 ** attempt, 8);
      log(`  ${res.status}, retrying in ${waitFor}s (attempt ${attempt} of 4)`);
      await new Promise(r => setTimeout(r, waitFor * 1000));
      return this.call(method, pathname, body, { attempt: attempt + 1 });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async need(method, pathname, body, what) {
    const r = await this.call(method, pathname, body);
    if (!r.ok) {
      const msg = (r.json && (r.json.message || r.json.error)) || r.text.slice(0, 300) || '(no body)';
      fatal(3, `${what} failed (${r.status}): ${msg}`);
    }
    return r.json;
  }

  service(id) { return this.need('GET', `/services/${id}`, null, 'reading the Render service'); }

  triggerDeploy(id) {
    // clearCache is deliberately not set: a normal deploy should reuse the cache.
    return this.need('POST', `/services/${id}/deploys`, {}, 'triggering the Render deploy');
  }

  deploy(serviceId, deployId) {
    return this.need('GET', `/services/${serviceId}/deploys/${deployId}`, null, 'reading the deploy');
  }

  async lastDeploy(id) {
    const r = await this.need('GET', `/services/${id}/deploys?limit=1`, null, 'listing deploys');
    // The API returns [{ deploy: {...} }]; tolerate a bare array too.
    const first = Array.isArray(r) ? r[0] : null;
    return first ? (first.deploy || first) : null;
  }

  /**
   * Polls until the deploy settles. Render reports several intermediate states;
   * anything not terminal is treated as still running.
   */
  async waitFor(serviceId, deployId, timeoutSec) {
    const started = Date.now();
    let last = null;
    for (;;) {
      const d = await this.deploy(serviceId, deployId);
      if (d.status !== last) {
        log(`  ${d.status}`);
        last = d.status;
      }
      if (DEPLOY_DONE[d.status]) return { ok: true, deploy: d };
      if (DEPLOY_FAILED[d.status]) return { ok: false, deploy: d };
      if ((Date.now() - started) / 1000 > timeoutSec) {
        return { ok: false, timedOut: true, deploy: d };
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const o = withConfig(parseArgs(process.argv.slice(2)));

  if (o.command === 'init') return writeConfig(o);

  if (o.command === 'status') return status(o);

  const token = o.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) fatal(1, 'no token. Set GITHUB_TOKEN, or pass --token.');
  if (!o.repo || !o.repo.includes('/')) {
    fatal(1, 'no repository. Pass --repo owner/name, or save one with: push-agent init --repo owner/name');
  }
  // Fail before uploading anything if the deploy half cannot run.
  if (o.command === 'deploy') {
    if (!o.service) fatal(1, 'deploy needs a Render service id. Pass --service srv-xxxx, or save it with init.');
    if (!process.env.RENDER_API_KEY) fatal(1, 'deploy needs RENDER_API_KEY in the environment.');
  }

  const commitSha = await push(o, token);
  if (o.command !== 'deploy' || o.dryRun) return;

  await deployOnRender(o, commitSha);
}

/** Pushes the directory. Returns the new commit sha, or null on a dry run. */
async function push(o, token) {
  const [owner, repo] = o.repo.split('/');
  const dir = path.resolve(o.dir);
  if (!fs.existsSync(dir)) fatal(1, `directory not found: ${dir}`);

  const api = new Api(token, o.verbose);

  log(`Reading ${dir}`);
  const files = await walk(dir);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (!files.length && !o.forceEmpty) fatal(4, 'nothing to push (use --force-empty if that is intended)');
  const oversize = files.filter(f => f.size > 50 * 1024 * 1024);
  if (oversize.length) fatal(1, `over GitHub's 50 MB blob limit: ${oversize.map(f => f.rel).join(', ')}`);
  log(`${files.length} files, ${human(total)}`);

  if (o.dryRun) {
    files.forEach(f => log(`  ${f.rel}  ${human(f.size)}`));
    log('\nDry run: nothing was sent.');
    return null;
  }

  let info = (await api.call('GET', `/repos/${owner}/${repo}`)).json;
  if (!info || info.message === 'Not Found') {
    if (!o.create) fatal(3, `${o.repo} not found. Create it on GitHub, or re-run with --create.`);
    log(`Creating ${o.repo} (${o.public ? 'public' : 'private'})`);
    info = await api.need('POST', '/user/repos',
      { name: repo, private: !o.public, auto_init: false }, 'repository creation');
  } else {
    log(`Connected to ${info.full_name}`);
  }

  const branch = o.branch || info.default_branch || 'main';

  const refRes = await api.call('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const parentSha = refRes.ok && refRes.json && refRes.json.object ? refRes.json.object.sha : null;
  log(parentSha ? `Branch ${branch} is at ${parentSha.slice(0, 7)}`
                : `Branch ${branch} does not exist yet; it will be created`);

  log(`Uploading ${files.length} blobs`);
  const tree = [];
  let done = 0;
  for (const f of files) {
    const content = await fsp.readFile(f.full);
    const blob = await api.need('POST', `/repos/${owner}/${repo}/git/blobs`,
      { content: content.toString('base64'), encoding: 'base64' }, `blob ${f.rel}`);
    tree.push({ path: f.rel, mode: f.mode, type: 'blob', sha: blob.sha });
    done++;
    if (done % 10 === 0 || done === files.length) log(`  ${done}/${files.length}`);
  }

  const treeObj = await api.need('POST', `/repos/${owner}/${repo}/git/trees`, { tree }, 'tree creation');
  const message = o.message || `Deploy ${files.length} files (${human(total)})`;
  const commit = await api.need('POST', `/repos/${owner}/${repo}/git/commits`,
    { message, tree: treeObj.sha, parents: parentSha ? [parentSha] : [] }, 'commit creation');

  if (parentSha) {
    await api.need('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { sha: commit.sha, force: false }, 'branch update');
  } else {
    await api.need('POST', `/repos/${owner}/${repo}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: commit.sha }, 'branch creation');
  }

  const check = await api.need('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`, null, 'verification');
  if (!check.object || check.object.sha !== commit.sha) {
    fatal(3, `the branch tip is ${check.object && check.object.sha}, not the commit just created.`);
  }
  log(`\nPushed ${commit.sha.slice(0, 7)} to ${owner}/${repo}@${branch}`);
  log(`https://github.com/${owner}/${repo}/tree/${branch}`);
  return commit.sha;
}

async function deployOnRender(o, commitSha) {
  const r = new Render(process.env.RENDER_API_KEY, o.verbose);
  const svc = await r.service(o.service);
  log(`\nRender service ${svc.name || o.service}`);

  // Auto-deploy would fire on its own; triggering explicitly gives us a deploy
  // id to follow, and is harmless when auto-deploy is off.
  const dep = await r.triggerDeploy(o.service);
  log(`Deploy ${dep.id} triggered`);

  if (!o.wait) {
    log('Not waiting (--no-wait). Check progress with: push-agent status');
    return;
  }

  log(`Waiting up to ${o.timeout}s`);
  const res = await r.waitFor(o.service, dep.id, o.timeout);
  const url = (svc.serviceDetails && svc.serviceDetails.url) || svc.url;

  if (res.ok) {
    log(`\nLive${commitSha ? ` at ${commitSha.slice(0, 7)}` : ''}`);
    if (url) log(url);
    return;
  }
  if (res.timedOut) {
    log(`\nStill ${res.deploy.status} after ${o.timeout}s. It may yet finish; check with: push-agent status`);
    process.exit(5);
  }
  log(`\nDeploy ${res.deploy.status}. Open the Render dashboard for the build log.`);
  process.exit(5);
}

async function status(o) {
  if (!o.service) fatal(1, 'status needs a Render service id. Pass --service, or save it with init.');
  if (!process.env.RENDER_API_KEY) fatal(1, 'status needs RENDER_API_KEY in the environment.');
  const r = new Render(process.env.RENDER_API_KEY, o.verbose);
  const svc = await r.service(o.service);
  const url = (svc.serviceDetails && svc.serviceDetails.url) || svc.url;
  log(`Service   ${svc.name || o.service}`);
  log(`Type      ${svc.type || 'unknown'}`);
  if (svc.suspended) log(`Suspended ${svc.suspended}`);
  if (url) log(`URL       ${url}`);
  const last = await r.lastDeploy(o.service);
  if (!last) return log('No deploys yet.');
  log(`Deploy    ${last.id}`);
  log(`Status    ${last.status}`);
  if (last.commit && last.commit.id) log(`Commit    ${String(last.commit.id).slice(0, 7)}`);
  if (last.finishedAt) log(`Finished  ${last.finishedAt}`);
}

if (require.main === module) {
  main().catch(e => fatal(3, e.stack || e.message));
}
module.exports = { walk, ignored, loadIgnore, parseArgs, withConfig, human, Render };
