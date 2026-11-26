'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

function installGitBridge() {
  if (globalThis.__SILLYCLIENT_GIT_BRIDGE_INSTALLED__) return;
  const backend = String(
    process.env.SILLYTAVERN_GIT_BACKEND || process.env.SILLYCLIENT_GIT_BACKEND || 'auto'
  ).toLowerCase();
  if (backend === 'disabled' || process.env.SILLYCLIENT_DISABLE_GIT_BRIDGE === '1') return;

  function hasSystemGitBinary() {
    if (process.env.SILLYTAVERN_GIT_HAS_SYSTEM === '1') return true;
    if (process.env.SILLYTAVERN_GIT_HAS_SYSTEM === '0') return false;
    const rawPath = process.env.PATH || process.env.Path || '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
    for (const dir of rawPath.split(sep)) {
      const cleanDir = dir.trim().replace(/^"+|"+$/g, '');
      if (!cleanDir) continue;
      for (const name of names) {
        try {
          const full = path.join(cleanDir, name);
          fs.accessSync(full, fs.constants.X_OK);
          if (fs.statSync(full).isFile()) return true;
        } catch (_) {}
      }
    }
    return false;
  }

  const cwd = process.cwd();
  const bridgeDir =
    process.env.SILLYCLIENT_GIT_BRIDGE_DIR || process.env.SILLYTAVERN_GIT_BRIDGE_DIR || __dirname;

  function resolveModuleFile(specifier, fallbackFile) {
    try {
      return require.resolve(specifier, { paths: [cwd] });
    } catch (_) {
      if (bridgeDir) {
        const candidate = path.join(bridgeDir, fallbackFile);
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    }
  }

  const isoGitPath = resolveModuleFile('isomorphic-git', 'isomorphic-git.cjs');
  const isoHttpPath = resolveModuleFile('isomorphic-git/http/node', 'isomorphic-git-http-node.cjs');
  if (!isoGitPath || !isoHttpPath) return;

  const isomorphicGit = require(isoGitPath);
  const origHttp = require(isoHttpPath);
  const hasSystemGit =
    backend === 'system' ? true : (backend === 'bridge' ? false : hasSystemGitBinary());

  let realSimpleGit = null;
  if (hasSystemGit && backend !== 'bridge') {
    try {
      const sgPath = require.resolve('simple-git', { paths: [cwd] });
      realSimpleGit = require(sgPath);
    } catch (_) {}
  }

  globalThis.__SILLYCLIENT_GIT_BRIDGE_INSTALLED__ = true;

  const initBridge = function(fsMod, pathMod, isoGit, baseHttp, realSg) {
    const KNOWN_REPOS = {
      'JS-Slash-Runner': { repo: 'N0VI028/JS-Slash-Runner', version: '4.11.2', commit: '46ec10df770b47e1ce6562de747d72f1bde3549e' },
      'LittleWhiteBox': { repo: 'RT15548/LittleWhiteBox', version: '3.1.6', commit: '66cb1001e860cdddd77e5a3911c7c47ea325df3a' },
      'ST-Prompt-Template': { repo: 'zonde306/ST-Prompt-Template', version: '1.17.9', commit: 'd6f520d149aba146305b0b781ddd691d449c28d2' },
      'Extension-Dice': { repo: 'SillyTavern/Extension-Dice', version: '2.0.0', commit: 'b4047508a1191ba3b32cb20f64ebc5f7877d689b' },
    };
    const DEFAULT_MIRRORS = 'https://gh-proxy.com/,https://gh-proxy.org/,https://v6.gh-proxy.org/,https://ghproxy.vip/';
    let preferredMirror = '';
    function isSha(val) {
      return typeof val === 'string' && val.length === 40 && /^[0-9a-f]{40}/i.test(val);
    }
    function stripGitSuffix(rawUrl) {
      const text = String(rawUrl || '').trim();
      return text.toLowerCase().endsWith('.git') ? text.slice(0, -4) : text;
    }
    async function collectBody(body) {
      if (!body) return undefined;
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) return [Buffer.from(body)];
      if (Array.isArray(body)) return [Buffer.concat(body.map(b => Buffer.from(b)))];
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return [Buffer.concat(chunks)];
    }
    function withTimeout(promise, ms) {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Git HTTP request timed out')), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const http = {
      async request(req) {
        const mirrorsRaw =
          process.env.SILLYCLIENT_GIT_MIRRORS ?? process.env.SILLYTAVERN_GIT_MIRRORS ?? DEFAULT_MIRRORS;
        const mirrors = mirrorsRaw.split(',').map(s => s.trim()).filter(Boolean);
        const isGitHub = /^https:\/\/github\.com\//i.test(req.url);
        const allowMirrors =
          isGitHub || Boolean(process.env.SILLYCLIENT_GIT_MIRRORS || process.env.SILLYTAVERN_GIT_MIRRORS);
        const candidates = [];
        if (allowMirrors) {
          const sticky = preferredMirror && mirrors.includes(preferredMirror) ? preferredMirror : '';
          if (sticky) candidates.push({ prefix: sticky, url: (sticky.endsWith('/') ? sticky : sticky + '/') + req.url });
          candidates.push({ prefix: '', url: req.url });
          for (const m of mirrors) {
            if (m === sticky) continue;
            candidates.push({ prefix: m, url: (m.endsWith('/') ? m : m + '/') + req.url });
          }
        } else {
          candidates.push({ prefix: '', url: req.url });
        }
        const bufferedBody = await collectBody(req.body);
        let lastError;
        for (let i = 0; i < candidates.length; i++) {
          const { prefix, url: candidateUrl } = candidates[i];
          const timeoutMs = !prefix && isGitHub ? 10000 : 45000;
          try {
            const res = await withTimeout(
              baseHttp.request({
                ...req,
                url: candidateUrl,
                headers: { 'User-Agent': 'git/2.43.0 SillyClient', ...(req.headers || {}) },
                body: bufferedBody ? [Buffer.from(bufferedBody[0])] : undefined,
              }),
              timeoutMs
            );
            if (res && res.statusCode >= 200 && res.statusCode < 400) {
              if (prefix) preferredMirror = prefix;
              return { ...res, url: req.url };
            }
            if (prefix && preferredMirror === prefix) preferredMirror = '';
            lastError = new Error('HTTP ' + (res && res.statusCode) + ' from ' + candidateUrl);
          } catch (err) {
            if (prefix && preferredMirror === prefix) preferredMirror = '';
            lastError = err;
          }
        }
        throw lastError || new Error('Git HTTP request failed: ' + req.url);
      }
    };
    function needsBridgeForDir(baseDir) {
      if (!realSg) return true;
      const treeMeta = pathMod.join(baseDir, '.git/sillyclient-tree.json');
      if (fsMod.existsSync(treeMeta)) return true;
      const headFile = pathMod.join(baseDir, '.git/HEAD');
      if (!fsMod.existsSync(headFile) && fsMod.existsSync(pathMod.join(baseDir, 'manifest.json'))) return true;
      if (fsMod.existsSync(headFile) && !fsMod.existsSync(pathMod.join(baseDir, '.git/index'))) {
        try {
          const packDir = pathMod.join(baseDir, '.git/objects/pack');
          if (!fsMod.existsSync(packDir) || fsMod.readdirSync(packDir).length === 0) return true;
        } catch (_) {}
      }
      return false;
    }
    function readTrackedTreeFile(baseDir) {
      try {
        const p = pathMod.join(baseDir, '.git/sillyclient-tree.json');
        if (!fsMod.existsSync(p)) return null;
        const parsed = JSON.parse(fsMod.readFileSync(p, 'utf8'));
        return parsed && Array.isArray(parsed.files) ? parsed : null;
      } catch (_) { return null; }
    }
    function writeTrackedTreeFile(baseDir, commit, files) {
      try {
        const p = pathMod.join(baseDir, '.git/sillyclient-tree.json');
        if (!fsMod.existsSync(pathMod.dirname(p))) return;
        fsMod.writeFileSync(p, JSON.stringify({ commit, files }) + '\n');
      } catch (_) {}
    }
    async function collectTrackedFiles(baseDir, ref) {
      if (typeof isoGit.listFiles === 'function') {
        try {
          const files = await isoGit.listFiles({ fs: fsMod, dir: baseDir, ref });
          if (Array.isArray(files) && files.length > 0) return files;
        } catch (_) {}
      }
      const meta = readTrackedTreeFile(baseDir);
      return meta ? meta.files : [];
    }
    function cleanupStaleFiles(baseDir, previousFiles, nextFiles) {
      if (!previousFiles.length || !nextFiles.length || typeof fsMod.unlinkSync !== 'function') return;
      const keep = new Set(nextFiles.map(f => String(f).replace(/\\/g, '/').replace(/^\/+/, '')));
      const resolvedBase = pathMod.resolve(baseDir);
      for (const rel of previousFiles) {
        const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!norm || norm === '.git' || norm.startsWith('.git/') || keep.has(norm)) continue;
        const target = pathMod.resolve(resolvedBase, norm);
        if (!target.startsWith(resolvedBase + pathMod.sep)) continue;
        try {
          if (fsMod.existsSync(target) && fsMod.statSync(target).isFile()) {
            fsMod.unlinkSync(target);
            let dir = pathMod.dirname(target);
            while (dir.startsWith(resolvedBase + pathMod.sep) && dir !== resolvedBase) {
              if (typeof fsMod.readdirSync === 'function' && fsMod.readdirSync(dir).length === 0) {
                if (typeof fsMod.rmdirSync === 'function') fsMod.rmdirSync(dir);
              } else break;
              dir = pathMod.dirname(dir);
            }
          }
        } catch (_) {}
      }
    }
    function writeGitFiles(baseDir, remoteUrl, branch, commit) {
      const gitDir = pathMod.join(baseDir, '.git');
      fsMod.mkdirSync(pathMod.join(gitDir, 'refs/heads'), { recursive: true });
      fsMod.mkdirSync(pathMod.join(gitDir, 'refs/remotes/origin'), { recursive: true });
      fsMod.mkdirSync(pathMod.join(gitDir, 'objects/info'), { recursive: true });
      fsMod.mkdirSync(pathMod.join(gitDir, 'objects/pack'), { recursive: true });
      fsMod.writeFileSync(pathMod.join(gitDir, 'HEAD'), 'ref: refs/heads/' + branch + '\n');
      fsMod.writeFileSync(
        pathMod.join(gitDir, 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n' +
        '[remote "origin"]\n\turl = ' + remoteUrl + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
        '[branch "' + branch + '"]\n\tremote = origin\n\tmerge = refs/heads/' + branch + '\n'
      );
      fsMod.writeFileSync(pathMod.join(gitDir, 'refs/heads', branch), commit + '\n');
      fsMod.writeFileSync(pathMod.join(gitDir, 'refs/remotes/origin', branch), commit + '\n');
    }
    function ensureExtensionGitRepo(baseDir) {
      if (!baseDir || typeof baseDir !== 'string') return;
      if (fsMod.existsSync(pathMod.join(baseDir, '.git/HEAD'))) return;
      const manifestFile = pathMod.join(baseDir, 'manifest.json');
      if (!fsMod.existsSync(manifestFile)) return;
      try {
        const manifest = JSON.parse(fsMod.readFileSync(manifestFile, 'utf8'));
        const dirName = pathMod.basename(baseDir);
        const known = KNOWN_REPOS[dirName];
        let remoteUrl = '';
        let commit = '1111111111111111111111111111111111111111';
        if (known) {
          remoteUrl = 'https://github.com/' + known.repo + '.git';
          if (manifest.version === known.version) commit = known.commit;
        } else {
          const rawRepo = manifest.homePage || manifest.homepage ||
            (manifest.repository && typeof manifest.repository === 'object' ? manifest.repository.url : manifest.repository) || '';
          const parsed = new URL(String(rawRepo).trim());
          if (parsed.hostname.toLowerCase() === 'github.com') {
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) remoteUrl = 'https://github.com/' + parts[0] + '/' + stripGitSuffix(parts[1]) + '.git';
          }
        }
        if (remoteUrl) writeGitFiles(baseDir, remoteUrl, 'main', commit);
      } catch (_) {}
    }
    function readRef(baseDir, refPath) {
      const full = pathMod.join(baseDir, '.git', refPath);
      if (fsMod.existsSync(full) && fsMod.statSync(full).isFile()) {
        const val = fsMod.readFileSync(full, 'utf8').trim();
        if (val.startsWith('ref: ')) return readRef(baseDir, val.slice(5).trim());
        if (isSha(val)) return val.toLowerCase();
      }
      const packed = pathMod.join(baseDir, '.git/packed-refs');
      if (fsMod.existsSync(packed)) {
        for (const line of fsMod.readFileSync(packed, 'utf8').split(/\r?\n/)) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue;
          const [oid, ref] = line.trim().split(/\s+/);
          if (ref === refPath && isSha(oid)) return oid.toLowerCase();
        }
      }
      return '';
    }
    function getHeadInfo(baseDir) {
      const headFile = pathMod.join(baseDir, '.git/HEAD');
      if (!fsMod.existsSync(headFile)) return { detached: false, current: '', oid: '' };
      const raw = fsMod.readFileSync(headFile, 'utf8').trim();
      if (raw.startsWith('ref: ')) {
        const ref = raw.slice(5).trim();
        const branch = ref.replace(/^refs\/heads\//, '');
        return { detached: false, current: branch, oid: readRef(baseDir, ref) };
      }
      return { detached: true, current: 'HEAD', oid: raw.toLowerCase() };
    }
    function getOriginUrl(baseDir) {
      const cfgFile = pathMod.join(baseDir, '.git/config');
      if (!fsMod.existsSync(cfgFile)) return '';
      const text = fsMod.readFileSync(cfgFile, 'utf8');
      const m = text.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(\S+)/m);
      return m ? m[1].trim() : '';
    }
    function listRefFiles(rootDir, prefix = '') {
      if (!fsMod.existsSync(rootDir)) return [];
      const results = [];
      for (const entry of fsMod.readdirSync(rootDir, { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        const full = pathMod.join(rootDir, entry.name);
        if (entry.isDirectory()) results.push(...listRefFiles(full, rel));
        else if (entry.isFile() && entry.name !== 'HEAD') {
          const oid = fsMod.readFileSync(full, 'utf8').trim();
          if (isSha(oid)) results.push({ name: rel, oid: oid.toLowerCase() });
        }
      }
      return results;
    }
    const fetchCache = new Map();
    const CheckRepoActions = { IS_REPO_ROOT: 'root', IS_REPO_HOME: 'home', BARE: 'bare', IN_TREE: 'tree' };
    function simpleGit(optionsOrPath) {
      const requestedBaseDir = typeof optionsOrPath === 'string'
        ? optionsOrPath
        : (optionsOrPath && optionsOrPath.baseDir) || process.cwd();
      let baseDir = pathMod.resolve(requestedBaseDir);
      try { baseDir = fsMod.realpathSync(baseDir); } catch (_) {}
      if (realSg && !needsBridgeForDir(baseDir)) {
        return typeof realSg === 'function' ? realSg(optionsOrPath) : realSg.simpleGit(optionsOrPath);
      }
      ensureExtensionGitRepo(baseDir);
      async function doFetch() {
        const url = getOriginUrl(baseDir);
        if (!url) { fetchCache.delete(baseDir); return; }
        const now = Date.now();
        const cached = fetchCache.get(baseDir);
        if (cached && cached.url === url) {
          if (cached.promise) return cached.promise;
          if (now >= cached.time && now - cached.time < 3000) return cached.refs;
        }
        const entry = { url, promise: null, time: 0, refs: null };
        fetchCache.set(baseDir, entry);
        entry.promise = (async () => {
          try {
            const refs = await isoGit.listServerRefs({ http, url, symrefs: true, prefix: 'refs/heads/' });
            if (fetchCache.get(baseDir) !== entry || getOriginUrl(baseDir) !== url) return refs;
            for (const r of refs) {
              if (r.ref && r.ref.startsWith('refs/heads/') && isSha(r.oid)) {
                const branchName = r.ref.slice('refs/heads/'.length);
                const dest = pathMod.join(baseDir, '.git/refs/remotes/origin', branchName);
                fsMod.mkdirSync(pathMod.dirname(dest), { recursive: true });
                fsMod.writeFileSync(dest, r.oid.toLowerCase() + '\n');
              }
            }
            const head = getHeadInfo(baseDir);
            if (!head.detached && head.current && refs.length > 0 && !refs.some(r => r.ref === 'refs/heads/' + head.current)) {
              const fallbackRef = refs.find(r => r.ref === 'refs/heads/master') || refs[0];
              const fallbackBranch = fallbackRef.ref.slice('refs/heads/'.length);
              const oldHeadOid = head.oid || '1111111111111111111111111111111111111111';
              const newHeadPath = pathMod.join(baseDir, '.git/refs/heads', fallbackBranch);
              fsMod.mkdirSync(pathMod.dirname(newHeadPath), { recursive: true });
              if (!fsMod.existsSync(newHeadPath)) fsMod.writeFileSync(newHeadPath, oldHeadOid + '\n');
              fsMod.writeFileSync(pathMod.join(baseDir, '.git/HEAD'), 'ref: refs/heads/' + fallbackBranch + '\n');
              const aliasDest = pathMod.join(baseDir, '.git/refs/remotes/origin', head.current);
              fsMod.mkdirSync(pathMod.dirname(aliasDest), { recursive: true });
              fsMod.writeFileSync(aliasDest, fallbackRef.oid.toLowerCase() + '\n');
            }
            entry.refs = refs;
            entry.time = Date.now();
            return refs;
          } finally {
            if (fetchCache.get(baseDir) === entry) {
              if (entry.refs) entry.promise = null;
              else fetchCache.delete(baseDir);
            }
          }
        })();
        return entry.promise;
      }
      return {
        async checkIsRepo() { ensureExtensionGitRepo(baseDir); return fsMod.existsSync(pathMod.join(baseDir, '.git/HEAD')); },
        async revparse(args) {
          const arr = Array.isArray(args) ? args : [args];
          if (arr.includes('--is-shallow-repository')) return 'false';
          if (arr.includes('--show-toplevel')) return baseDir;
          const head = getHeadInfo(baseDir);
          if (arr.includes('--abbrev-ref')) {
            if (arr.includes('@{u}')) return 'origin/' + (head.current || 'main');
            return head.detached ? 'HEAD' : (head.current || 'main');
          }
          if (arr.includes('--short')) return (head.oid || '').slice(0, 7);
          const target = arr[arr.length - 1] || 'HEAD';
          if (target === 'HEAD') {
            if (!head.oid) throw new Error('HEAD cannot be resolved');
            return head.oid;
          }
          if (target.startsWith('origin/')) return readRef(baseDir, 'refs/remotes/' + target) || head.oid;
          return readRef(baseDir, 'refs/heads/' + target) || head.oid;
        },
        async status() {
          const head = getHeadInfo(baseDir);
          const branch = head.current || 'main';
          return {
            isClean: () => true,
            modified: [],
            not_added: [],
            created: [],
            deleted: [],
            conflicted: [],
            files: [],
            current: branch,
            tracking: 'origin/' + branch,
            ahead: 0,
            behind: 0,
          };
        },
        async branch(args) {
          const arr = Array.isArray(args) ? args : [];
          if (arr.includes('-r')) {
            const remotes = listRefFiles(pathMod.join(baseDir, '.git/refs/remotes/origin'));
            const branches = {}; const all = [];
            for (const r of remotes) {
              const name = 'origin/' + r.name;
              all.push(name);
              branches[name] = { current: false, name, commit: r.oid.slice(0, 7), label: r.oid.slice(0, 7) };
            }
            return { detached: false, current: '', all, branches };
          }
          const head = getHeadInfo(baseDir);
          const locals = listRefFiles(pathMod.join(baseDir, '.git/refs/heads'));
          const branches = {}; const all = [];
          for (const l of locals) {
            all.push(l.name);
            branches[l.name] = { current: !head.detached && l.name === head.current, name: l.name, commit: l.oid.slice(0, 7), label: l.oid.slice(0, 7) };
          }
          if (head.current && !branches[head.current] && head.oid) {
            all.push(head.current);
            branches[head.current] = { current: !head.detached, name: head.current, commit: head.oid.slice(0, 7), label: head.oid.slice(0, 7) };
          }
          return { detached: head.detached, current: head.current, all, branches };
        },
        async branchLocal() { return this.branch([]); },
        async fetch() { await doFetch(); return {}; },
        async log(options = {}) {
          const head = getHeadInfo(baseDir);
          const fromRef = options.from || head.oid;
          const toSpec = options.to || ('origin/' + (head.current || 'main'));
          const fromOid = isSha(fromRef) ? fromRef.toLowerCase() : (readRef(baseDir, 'refs/heads/' + fromRef) || head.oid);
          const toOid = toSpec.startsWith('origin/')
            ? readRef(baseDir, 'refs/remotes/' + toSpec)
            : (isSha(toSpec) ? toSpec.toLowerCase() : readRef(baseDir, 'refs/heads/' + toSpec));
          if (!toOid || !fromOid || fromOid === toOid) return { all: [], total: 0, latest: null };
          const entry = { hash: toOid, date: '', message: 'Update available', refs: '', body: '', author_name: '', author_email: '' };
          return { all: [entry], total: 1, latest: entry };
        },
        async getRemotes() {
          const cleanUrl = stripGitSuffix(getOriginUrl(baseDir));
          return cleanUrl ? [{ name: 'origin', refs: { fetch: cleanUrl, push: cleanUrl } }] : [];
        },
        async pull(_remote = 'origin', branch) {
          fetchCache.delete(baseDir);
          try {
            const head = getHeadInfo(baseDir);
            const targetBranch = branch || head.current || 'main';
            const url = getOriginUrl(baseDir);
            if (!url) throw new Error('No origin remote configured');
            const hadTrackedTree = Boolean(readTrackedTreeFile(baseDir));
            const previousFiles = await collectTrackedFiles(baseDir, 'HEAD');
            const fetchRes = await isoGit.fetch({ fs: fsMod, http, dir: baseDir, url, ref: targetBranch, depth: 1, singleBranch: true, tags: false });
            const latestOid = (fetchRes && fetchRes.fetchHead) || readRef(baseDir, 'refs/remotes/origin/' + targetBranch);
            if (!latestOid) throw new Error('Unable to resolve remote HEAD for ' + targetBranch);
            const localRefFile = pathMod.join(baseDir, '.git/refs/heads', targetBranch);
            fsMod.mkdirSync(pathMod.dirname(localRefFile), { recursive: true });
            fsMod.writeFileSync(localRefFile, latestOid + '\n');
            const remoteRefFile = pathMod.join(baseDir, '.git/refs/remotes/origin', targetBranch);
            fsMod.mkdirSync(pathMod.dirname(remoteRefFile), { recursive: true });
            fsMod.writeFileSync(remoteRefFile, latestOid + '\n');
            fsMod.writeFileSync(pathMod.join(baseDir, '.git/HEAD'), 'ref: refs/heads/' + targetBranch + '\n');
            await isoGit.checkout({ fs: fsMod, dir: baseDir, ref: targetBranch, force: true });
            const nextFiles = await collectTrackedFiles(baseDir, targetBranch);
            cleanupStaleFiles(baseDir, previousFiles, nextFiles);
            if (hadTrackedTree && nextFiles.length > 0) writeTrackedTreeFile(baseDir, latestOid, nextFiles);
            return {};
          } finally { fetchCache.delete(baseDir); }
        },
        async remote() { return ''; },
        async checkout(branch) {
          fetchCache.delete(baseDir);
          try {
            const targetBranch = String(branch).replace(/^origin\//, '');
            const url = getOriginUrl(baseDir);
            const hadTrackedTree = Boolean(readTrackedTreeFile(baseDir));
            const previousFiles = await collectTrackedFiles(baseDir, 'HEAD');
            let latestOid = '';
            if (url) {
              const fetchRes = await isoGit.fetch({ fs: fsMod, http, dir: baseDir, url, ref: targetBranch, depth: 1, singleBranch: true, tags: false });
              latestOid = (fetchRes && fetchRes.fetchHead) || readRef(baseDir, 'refs/remotes/origin/' + targetBranch);
              if (latestOid) {
                const localRefFile = pathMod.join(baseDir, '.git/refs/heads', targetBranch);
                fsMod.mkdirSync(pathMod.dirname(localRefFile), { recursive: true });
                fsMod.writeFileSync(localRefFile, latestOid + '\n');
              }
            }
            fsMod.writeFileSync(pathMod.join(baseDir, '.git/HEAD'), 'ref: refs/heads/' + targetBranch + '\n');
            await isoGit.checkout({ fs: fsMod, dir: baseDir, ref: targetBranch, force: true });
            const nextFiles = await collectTrackedFiles(baseDir, targetBranch);
            cleanupStaleFiles(baseDir, previousFiles, nextFiles);
            if (hadTrackedTree && nextFiles.length > 0 && latestOid) writeTrackedTreeFile(baseDir, latestOid, nextFiles);
          } finally { fetchCache.delete(baseDir); }
        },
        async checkoutBranch(localBranch, startPoint) { await this.checkout(localBranch || startPoint); },
        async clone(url, localPath, options) {
          const arr = Array.isArray(options) ? options : [];
          const bIdx = arr.indexOf('-b') >= 0 ? arr.indexOf('-b') : arr.indexOf('--branch');
          let ref = bIdx >= 0 && arr[bIdx + 1] ? arr[bIdx + 1] : undefined;
          if (!ref) {
            const eqArg = arr.find(a => typeof a === 'string' && a.startsWith('--branch='));
            if (eqArg) ref = eqArg.slice('--branch='.length);
          }
          await isoGit.clone({ fs: fsMod, http, dir: localPath, url, ref, depth: 1, singleBranch: Boolean(ref) });
        },
        async show() { return ''; },
      };
    }
    return { http, CheckRepoActions, simpleGit };
  };

  const bridge = initBridge(fs, path, isomorphicGit, origHttp, realSimpleGit);
  const simpleGitExport = Object.assign(
    function simpleGitProxy() { return bridge.simpleGit.apply(null, arguments); },
    { simpleGit: bridge.simpleGit, CheckRepoActions: bridge.CheckRepoActions, default: bridge.simpleGit }
  );
  const httpExport = { request: (req) => bridge.http.request(req), default: bridge.http };

  globalThis.__SILLYCLIENT_GIT_BRIDGE_EXPORTS__ = {
    simpleGit: simpleGitExport,
    http: httpExport,
    isomorphicGit,
  };

  const origLoad = Module._load;
  let bypassCjs = false;
  Module._load = function(request, parent, isMain) {
    if (!bypassCjs) {
      if (request === 'simple-git' || request === 'simple-git/promise') return simpleGitExport;
      if (request === 'isomorphic-git/http/node') return httpExport;
      if (request === 'isomorphic-git') {
        bypassCjs = true;
        try { return origLoad.apply(this, arguments); }
        catch (_) { return isomorphicGit; }
        finally { bypassCjs = false; }
      }
    }
    return origLoad.apply(this, arguments);
  };

  if (typeof Module.register === 'function') {
    const isoNamedKeys = Object.keys(isomorphicGit).filter(
      k => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) && k !== 'default'
    );
    const isoNamedExports = isoNamedKeys
      .map(k => `export const ${k} = _g[${JSON.stringify(k)}];`)
      .join(' ');
    const preloadUrlLiteral = JSON.stringify(pathToFileURL(__filename).href);
    const preloadPathLiteral = JSON.stringify(__filename);
    const ensureExportsSnippet =
      'import { createRequire } from "node:module"; if (!globalThis.__SILLYCLIENT_GIT_BRIDGE_EXPORTS__) createRequire(' +
      preloadUrlLiteral +
      ')(' +
      preloadPathLiteral +
      '); ';
    const loaderSource = `
      const ENSURE_EXPORTS = ${JSON.stringify(ensureExportsSnippet)};
      const ISO_NAMED = ${JSON.stringify(isoNamedExports)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'simple-git' || specifier === 'simple-git/promise') {
          return { url: 'sillyclient://simple-git-bridge.mjs', shortCircuit: true };
        }
        if (specifier === 'isomorphic-git/http/node') {
          return { url: 'sillyclient://git-http-bridge.mjs', shortCircuit: true };
        }
        if (specifier === 'isomorphic-git') {
          try { return await nextResolve(specifier, context); }
          catch (_) { return { url: 'sillyclient://isomorphic-git-fallback.mjs', shortCircuit: true }; }
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url === 'sillyclient://simple-git-bridge.mjs') {
          return {
            format: 'module',
            source: ENSURE_EXPORTS + 'const b = globalThis.__SILLYCLIENT_GIT_BRIDGE_EXPORTS__.simpleGit; export const CheckRepoActions = b.CheckRepoActions; export const simpleGit = b.simpleGit; export default b.simpleGit;',
            shortCircuit: true,
          };
        }
        if (url === 'sillyclient://git-http-bridge.mjs') {
          return {
            format: 'module',
            source: ENSURE_EXPORTS + 'const h = globalThis.__SILLYCLIENT_GIT_BRIDGE_EXPORTS__.http; export const request = h.request; export default h;',
            shortCircuit: true,
          };
        }
        if (url === 'sillyclient://isomorphic-git-fallback.mjs') {
          return {
            format: 'module',
            source: ENSURE_EXPORTS + 'const _g = globalThis.__SILLYCLIENT_GIT_BRIDGE_EXPORTS__.isomorphicGit; ' + ISO_NAMED + ' export default _g;',
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      }
    `;
    Module.register(
      'data:text/javascript;base64,' + Buffer.from(loaderSource).toString('base64'),
      pathToFileURL(__filename).href
    );
  }
}

installGitBridge();
