/*
 * bestModManager.js  -  a full remake of the Sandboxels mod manager.
 *
 * Does NOT modify the game's code. It only:
 *   1. intercepts the "Mods" button so it opens a new blank page instead of the Mods panel,
 *   2. builds a profile-based mod manager in that page (profiles, Browse tab, import/export),
 *   3. writes the active profile's mods into the game's own `enabledMods` setting.
 *
 * Install once: open the normal Mods panel, paste this file's full URL, press Enter, reload.
 * After that the Mods button opens this manager. Shift+click Mods to open the original panel.
 *
 * Data lives in localStorage (key "bmm_v1"). Use Export to back up across devices / data wipes.
 */
(function () {
  'use strict';
  if (window.__bmmGameSide) return;
  window.__bmmGameSide = true;

  var VERSION = '1.0.0';
  var SELF_RE = /bestModManager/i;

  /* ---------------------------------------------------------------------------
   * Stylesheet for the manager page (Sandboxels-like: dark, yellow accent)
   * ------------------------------------------------------------------------- */
  var BMM_CSS = [
    ':root{--bg:#161616;--panel:#222;--panel2:#2b2b2b;--line:#3a3a3a;--text:#f2f2f2;--dim:#9b9b9b;',
    '--accent:#e6d577;--accentText:#1a1a1a;--btn:#383838;--btntext:#fff;--danger:#7a2b2b;--font:Arial}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font),Arial,sans-serif;font-size:15px}',
    'button,input,textarea{font:inherit;color:inherit}',
    'h2{margin:0;font-size:22px}',
    '#head{position:sticky;top:0;z-index:20}',
    '.top{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#0d0d0d;border-bottom:2px solid var(--line);flex-wrap:wrap}',
    '.brand{font-weight:700;color:var(--accent);margin-right:12px;letter-spacing:.5px}',
    '.grow{flex:1}',
    '.tab,.btn{background:var(--btn);color:var(--btntext);border:0;border-radius:6px;padding:8px 14px;cursor:pointer}',
    '.tab:hover,.btn:hover{filter:brightness(1.3)}',
    '.tab.on{background:var(--accent);color:var(--accentText);font-weight:700}',
    '.btn.accent{background:var(--accent);color:var(--accentText);font-weight:700}',
    '.btn.danger{background:var(--danger)}',
    '.btn.big{padding:14px 22px;font-size:17px}',
    '.btn.sm{padding:5px 10px;font-size:13px}',
    '.btn:disabled{opacity:.5;cursor:default;filter:none}',
    '.pulse{animation:pulse 1.2s infinite}',
    '@keyframes pulse{50%{box-shadow:0 0 0 5px rgba(230,213,119,.35)}}',
    '.banner{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#3d3716;border-bottom:2px solid var(--accent)}',
    '.banner b{color:var(--accent)}',
    'main{max-width:980px;margin:0 auto;padding:18px 16px 80px}',
    '.pagehead{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}',
    '.card{display:flex;gap:12px;align-items:center;background:var(--panel);border:2px solid var(--line);border-radius:8px;padding:12px;cursor:pointer;position:relative}',
    '.card:hover{border-color:#666}',
    '.card.active{border-color:var(--accent)}',
    '.cardname{font-weight:700;font-size:16px}',
    '.badge{background:var(--accent);color:var(--accentText);border-radius:4px;font-size:11px;font-weight:700;padding:2px 6px;margin-left:6px}',
    '.badge.dim{background:#444;color:#ddd}',
    '.card .badge{position:absolute;top:8px;right:8px;margin:0}',
    '.ico{flex:none;width:48px;height:48px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;color:#fff}',
    '.ico.lg{width:56px;height:56px}',
    '.meta{color:var(--dim);font-size:13px;margin-top:2px;word-break:break-all}',
    '.empty{text-align:center;color:var(--dim);padding:40px 10px;line-height:1.7}',
    '.hero{display:flex;gap:16px;align-items:center;background:var(--panel);border:2px solid var(--line);border-radius:10px;padding:16px;flex-wrap:wrap}',
    '.hero.active{border-color:var(--accent)}',
    '.hero-main{flex:1;min-width:200px}',
    '.title{width:100%;background:transparent;border:2px solid transparent;border-radius:6px;font-size:26px;font-weight:700;padding:2px 6px;margin-left:-6px}',
    '.title:hover,.title:focus{border-color:var(--line);background:#1a1a1a;outline:none}',
    '.hero-actions{display:flex;gap:10px;flex-wrap:wrap}',
    '.note{margin:12px 0 0;padding:10px 12px;background:#2a2a2a;border-left:4px solid var(--accent);border-radius:4px;color:#ddd;font-size:14px}',
    '.toolbar{display:flex;gap:8px;margin:16px 0 10px;flex-wrap:wrap}',
    '.inp{flex:1;min-width:180px;background:#101010;border:2px solid var(--line);border-radius:6px;padding:9px 12px}',
    '.inp:focus{outline:none;border-color:var(--accent)}',
    '.list{display:flex;flex-direction:column;gap:8px}',
    '.row{display:flex;gap:12px;align-items:center;background:var(--panel);border:2px solid var(--line);border-radius:8px;padding:10px 12px}',
    '.row.off{opacity:.55}',
    '.info{flex:1;min-width:0}',
    '.name{font-weight:700}',
    '.desc{margin-top:6px;padding:8px 10px;background:#161616;border-radius:6px;color:#cfcfcf;font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.acts{display:flex;gap:6px;align-items:center;flex:none;flex-wrap:wrap;justify-content:flex-end}',
    '.sw{position:relative;width:44px;height:24px;display:inline-block;margin:0 4px}',
    '.sw input{opacity:0;width:0;height:0;position:absolute}',
    '.sw span{position:absolute;inset:0;background:#555;border-radius:24px;cursor:pointer;transition:.15s}',
    '.sw span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}',
    '.sw input:checked+span{background:var(--accent)}',
    '.sw input:checked+span:before{transform:translateX(20px);background:#222}',
    '.foot{color:var(--dim);font-size:12px;margin-top:14px;text-align:center}',
    '#modal{display:none}',
    '#modal.on{display:block}',
    '.mback{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:40}',
    '.mbox{position:fixed;z-index:41;top:50%;left:50%;transform:translate(-50%,-50%);width:min(520px,92vw);max-height:86vh;overflow:auto;background:var(--panel);border:2px solid var(--accent);border-radius:10px;padding:18px}',
    '.mbox h3{margin:0 0 12px;font-size:18px}',
    '.mbox .btn{margin:4px 4px 4px 0}',
    '.mbox textarea{width:100%;min-height:100px;background:#101010;border:2px solid var(--line);border-radius:6px;padding:8px;resize:vertical}',
    '.pick{display:flex;width:100%;justify-content:space-between;align-items:center;text-align:left;margin:6px 0 !important}',
    '.srcrow{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}',
    '.mbox .inp{margin:4px 0}',
    '#toasts{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}',
    '.toast{background:#101010;border:2px solid var(--accent);border-radius:8px;padding:10px 16px;max-width:90vw}',
    '.toast.err{border-color:#e85d5d}'
  ].join('\n');

  /* ---------------------------------------------------------------------------
   * The manager app. This function is stringified and injected into the new page,
   * so it runs in that page's own context and keeps working even if the game
   * tab reloads. It must stay fully self-contained (no references to outer vars).
   * ------------------------------------------------------------------------- */
  function bmmApp(boot) {
    'use strict';
    window.__bmmReady = true;

    var STORE = 'bmm_v1', REGKEY = 'bmm_registry_v1', ENABLED = 'enabledMods', LOADED = 'bmm_loaded', SELFKEY = 'bmm_self';
    var SELF_RE = /bestModManager/i;
    var PAGE = 40;
    var DEFAULT_SOURCES = [
      { repo: 'R74nCom/Sandboxels-Mods', path: 'mods', branch: 'main' },
      { repo: 'everybodysim/sandboxels-modded', path: 'mods', branch: 'main' }
    ];

    /* ---------- helpers ---------- */
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var esc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    };
    var uid = function () { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); };
    var fileOf = function (u) {
      var f = String(u).split(/[?#]/)[0].split('/').pop();
      try { return decodeURIComponent(f); } catch (e) { return f; }
    };
    var pretty = function (f) {
      return f.replace(/\.js$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim() || f;
    };
    var hue = function (s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
    var fmtSize = function (b) { return !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; };
    var okUrl = function (u) {
      return typeof u === 'string' && (/^https?:\/\/[^\s]+\.js(\?[^\s]*)?$/i.test(u) || /^[\w\-./]+\.js$/i.test(u));
    };
    var byName = function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; };
    function readJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
    function writeJSON(k, v, silent) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { if (!silent) toast('Could not save (storage full or blocked).', 'err'); return false; }
    }

    /* ---------- data ---------- */
    function mkProfile(name) { return { id: uid(), name: name, createdAt: Date.now(), mods: [] }; }
    function modFromUrl(u) {
      var f = fileOf(u);
      return { id: uid(), name: pretty(f), file: f, url: u, source: 'imported', ref: '', size: 0, enabled: true };
    }
    var db = readJSON(STORE, null);
    if (!db || !Array.isArray(db.profiles)) db = migrate();
    if (!Array.isArray(db.sources) || !db.sources.length) db.sources = DEFAULT_SOURCES.map(function (s) { return Object.assign({}, s); });

    function migrate() {
      var d = { version: 1, activeProfileId: null, lastExport: 0, profiles: [], sources: DEFAULT_SOURCES.map(function (s) { return Object.assign({}, s); }) };
      var cur = readJSON(ENABLED, []);
      var others = (Array.isArray(cur) ? cur : []).filter(function (x) { return typeof x === 'string' && !SELF_RE.test(x); });
      if (others.length) {
        var p = mkProfile('Imported');
        p.mods = others.map(modFromUrl);
        d.profiles.push(p);
        d.activeProfileId = p.id;
      }
      writeJSON(STORE, d, true);
      return d;
    }
    var P = function (id) { return db.profiles.find(function (p) { return p.id === id; }); };
    var activeProfile = function () { return db.activeProfileId ? P(db.activeProfileId) : null; };
    function uniqueName(base, exceptId) {
      var name = base, n = 2;
      while (db.profiles.some(function (p) { return p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(); })) name = base + ' (' + (n++) + ')';
      return name;
    }

    /* Write the active profile's enabled mods into the game's enabledMods (manager always stays in). */
    function applyEnabled() {
      var list = [];
      var self = localStorage.getItem(SELFKEY) || boot.selfUrl || '';
      if (self) list.push(self);
      else readJSON(ENABLED, []).forEach(function (x) { if (typeof x === 'string' && SELF_RE.test(x)) list.push(x); });
      var p = activeProfile();
      if (p) p.mods.forEach(function (m) { if (m.enabled && list.indexOf(m.url) < 0) list.push(m.url); });
      try { localStorage.setItem(ENABLED, JSON.stringify(list)); }
      catch (e) { toast('Could not write the game\'s mod list.', 'err'); }
    }
    function save() { writeJSON(STORE, db); applyEnabled(); }
    function pending() {
      var a = localStorage.getItem(ENABLED) || '[]', b = localStorage.getItem(LOADED);
      if (b == null) return false;
      try { return JSON.stringify(JSON.parse(a)) !== JSON.stringify(JSON.parse(b)); } catch (e) { return a !== b; }
    }
    function installedIn(url) {
      return db.profiles.filter(function (p) { return p.mods.some(function (m) { return m.url === url; }); }).map(function (p) { return p.name; });
    }

    /* ---------- registry (mods from GitHub via jsDelivr CDN) ---------- */
    var registry = readJSON(REGKEY, null);
    var regState = registry && registry.items && registry.items.length ? 'ready' : 'idle';
    var regError = '';
    function indexRegistry() {
      if (!registry || !registry.items) return;
      registry.items.forEach(function (it, i) { it.i = i; it.hay = (it.name + ' ' + it.file + ' ' + it.source).toLowerCase(); });
    }
    indexRegistry();

    async function listFiles(repo, ref) {
      var tries = [
        async function () {
          var r = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + repo + '@' + encodeURIComponent(ref) + '?structure=flat');
          if (!r.ok) throw new Error('jsDelivr ' + r.status);
          var j = await r.json();
          return (j.files || []).map(function (f) { return { name: f.name, size: f.size }; });
        },
        async function () {
          var r = await fetch('https://data.jsdelivr.com/v1/package/gh/' + repo + '@' + encodeURIComponent(ref) + '/flat');
          if (!r.ok) throw new Error('jsDelivr ' + r.status);
          var j = await r.json();
          return (j.files || []).map(function (f) { return { name: f.name, size: f.size }; });
        },
        async function () {
          var r = await fetch('https://api.github.com/repos/' + repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
          if (!r.ok) throw new Error('GitHub ' + r.status);
          var j = await r.json();
          return (j.tree || []).filter(function (t) { return t.type === 'blob'; }).map(function (t) { return { name: '/' + t.path, size: t.size }; });
        }
      ];
      var err;
      for (var i = 0; i < tries.length; i++) { try { return await tries[i](); } catch (e) { err = e; } }
      throw err;
    }
    async function fetchSource(src) {
      var branches = [src.branch || 'main', 'main', 'master'].filter(function (b, i, a) { return a.indexOf(b) === i; });
      var err;
      for (var bi = 0; bi < branches.length; bi++) {
        var br = branches[bi];
        try {
          var ref = br;
          try { /* pin to a commit so CDN caching can't serve stale files */
            var rr = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + src.repo + '/resolved?specifier=' + encodeURIComponent(br));
            if (rr.ok) { var rj = await rr.json(); if (/^[0-9a-f]{40}$/i.test(rj.version || '')) ref = rj.version; }
          } catch (e) { /* fall back to branch name */ }
          var files = (await listFiles(src.repo, ref)).filter(function (f) { return /\.js$/i.test(f.name) && !/\.min\.js$/i.test(f.name) && !SELF_RE.test(f.name); });
          var prefix = src.path ? '/' + String(src.path).replace(/^\/+|\/+$/g, '') + '/' : '';
          var scoped = prefix ? files.filter(function (f) { return f.name.indexOf(prefix) === 0; }) : files;
          if (!scoped.length) scoped = files;
          if (!scoped.length) throw new Error('no .js files found');
          return scoped.map(function (f) {
            var file = f.name.split('/').pop();
            return { name: pretty(file), file: file, url: 'https://cdn.jsdelivr.net/gh/' + src.repo + '@' + ref + f.name, source: src.repo, ref: ref === br ? br : ref.slice(0, 7), size: f.size || 0 };
          });
        } catch (e) { err = e; }
      }
      throw err;
    }
    async function ensureRegistry(force) {
      var sig = JSON.stringify(db.sources);
      if (!force && registry && registry.sig === sig && Date.now() - registry.fetchedAt < 864e5 && registry.items.length) { regState = 'ready'; return; }
      if (regState === 'loading') return;
      regState = 'loading'; regError = ''; refresh();
      var items = [], errs = [];
      await Promise.all(db.sources.map(async function (s) {
        try { items.push.apply(items, await fetchSource(s)); } catch (e) { errs.push(s.repo + ' (' + (e.message || e) + ')'); }
      }));
      if (items.length) {
        items.sort(byName);
        registry = { fetchedAt: Date.now(), sig: sig, items: items };
        writeJSON(REGKEY, registry, true);
        regState = 'ready';
        if (errs.length) toast('Some sources failed: ' + errs.join(', '), 'err');
      } else if (registry && registry.items && registry.items.length) {
        regState = 'ready'; toast('Could not refresh the list; showing saved copy.', 'err');
      } else { regState = 'error'; regError = errs.join('; ') || 'No mods found.'; }
      indexRegistry(); ui.shown = PAGE; refresh();
    }
    var descs = {};
    async function loadDesc(it) {
      if (descs[it.url] !== undefined) return;
      descs[it.url] = null; refresh();
      try {
        var r = await fetch(it.url); if (!r.ok) throw new Error('HTTP ' + r.status);
        var t = await r.text();
        var m = t.match(/^\s*(\/\*[\s\S]*?\*\/|(?:\/\/.*(?:\r?\n|$))+)/);
        var d = m ? m[1].replace(/^\/\*+|\*+\/$/g, '').replace(/^\s*\/\/ ?/gm, '').replace(/^\s*\* ?/gm, '').trim() : '';
        descs[it.url] = (d ? d.slice(0, 500) : 'No description in the file header.') + (m && d.length > 500 ? '…' : '');
      } catch (e) { descs[it.url] = 'Could not load details (' + (e.message || e) + ').'; }
      refresh();
    }

    /* ---------- UI state ---------- */
    var ui = { view: 'profiles', pid: null, target: null, query: '', shown: PAGE, open: {}, pfilter: '' };
    var modalCb = null, pendingItem = null, exportPayload = null;

    function toast(msg, kind) {
      var box = $('#toasts'); if (!box) return;
      var t = document.createElement('div'); t.className = 'toast' + (kind === 'err' ? ' err' : ''); t.textContent = msg;
      box.appendChild(t); setTimeout(function () { t.remove(); }, kind === 'err' ? 5000 : 2800);
    }
    function openModal(html, cb) {
      var m = $('#modal'); m.innerHTML = '<div class="mback" data-a="closeModal"></div><div class="mbox">' + html + '</div>';
      modalCb = cb || null; m.classList.add('on');
      var i = $('#modal [data-val]'); if (i) i.focus();
    }
    function closeModal() { var m = $('#modal'); m.classList.remove('on'); m.innerHTML = ''; modalCb = null; }
    function askName(title, initial, okLabel, cb) {
      openModal('<h3>' + esc(title) + '</h3><input class="inp" type="text" data-val maxlength="60" value="' + esc(initial) + '" style="width:100%">' +
        '<div style="margin-top:10px"><button class="btn accent" data-a="modalOk">' + esc(okLabel) + '</button><button class="btn" data-a="closeModal">Cancel</button></div>', cb);
      var i = $('#modal [data-val]'); if (i) i.select();
    }
    function confirmModal(text, okLabel, cb) {
      openModal('<h3>Are you sure?</h3><p>' + esc(text) + '</p><button class="btn danger" data-a="modalOk">' + esc(okLabel) + '</button><button class="btn" data-a="closeModal">Cancel</button>', cb);
    }

    /* ---------- rendering ---------- */
    function renderTop() {
      var pend = pending(), t = ui.target ? P(ui.target) : null;
      $('#head').innerHTML =
        '<div class="top"><div class="brand">&#9638; MOD MANAGER</div>' +
        '<button class="tab ' + (ui.view === 'browse' ? '' : 'on') + '" data-a="tab" data-v="profiles">Profiles</button>' +
        '<button class="tab ' + (ui.view === 'browse' ? 'on' : '') + '" data-a="tab" data-v="browse">Browse Mods</button>' +
        '<div class="grow"></div>' +
        '<button class="btn ' + (pend ? 'accent pulse' : '') + '" data-a="reload">' + (pend ? 'Reload game to apply changes' : 'Reload game') + '</button></div>' +
        (t ? '<div class="banner">Installing into profile <b>' + esc(t.name) + '</b><div class="grow"></div><button class="btn sm accent" data-a="doneTarget">Done</button></div>' : '');
    }
    function icon(name, cls) { return '<div class="ico ' + (cls || '') + '" style="background:hsl(' + hue(name) + ' 40% 36%)">' + esc((name[0] || '?').toUpperCase()) + '</div>'; }

    function vProfiles() {
      var cards = db.profiles.map(function (p) {
        var on = db.activeProfileId === p.id, en = p.mods.filter(function (m) { return m.enabled; }).length;
        return '<div class="card ' + (on ? 'active' : '') + '" data-a="openProfile" data-id="' + p.id + '">' + icon(p.name, 'lg') +
          '<div><div class="cardname">' + esc(p.name) + '</div><div class="meta">' + p.mods.length + ' mod' + (p.mods.length === 1 ? '' : 's') + ' &middot; ' + en + ' enabled</div></div>' +
          (on ? '<span class="badge">ACTIVE</span>' : '') + '</div>';
      }).join('');
      var back = db.lastExport ? 'Last backup: ' + Math.floor((Date.now() - db.lastExport) / 864e5) + ' day(s) ago.' : 'You have not exported a backup yet.';
      return '<div class="pagehead"><h2>Profiles</h2><div class="grow"></div>' +
        '<button class="btn" data-a="importModal">Import</button><button class="btn" data-a="exportAll">Export all</button>' +
        '<button class="btn accent" data-a="newProfile">+ New profile</button></div>' +
        (cards ? '<div class="grid">' + cards + '</div>' :
          '<div class="empty">No profiles yet.<br>Create one, or open <b>Browse Mods</b> and install something &mdash; a profile is made for you.</div>') +
        '<div class="foot">Only one profile can be active at a time. ' + back + ' Export to keep profiles if you clear browser data.</div>';
    }

    function vProfile() {
      var p = P(ui.pid); if (!p) { ui.view = 'profiles'; return vProfiles(); }
      var on = db.activeProfileId === p.id, en = p.mods.filter(function (m) { return m.enabled; }).length;
      return '<div class="pagehead"><button class="btn" data-a="tab" data-v="profiles">&larr; Profiles</button></div>' +
        '<section class="hero ' + (on ? 'active' : '') + '">' + icon(p.name, 'lg') +
        '<div class="hero-main"><input class="title" data-c="rename" value="' + esc(p.name) + '" maxlength="60" title="Click to rename">' +
        '<div class="meta">' + p.mods.length + ' mod' + (p.mods.length === 1 ? '' : 's') + ' &middot; ' + en + ' enabled' + (on ? ' <span class="badge">ACTIVE</span>' : ' <span class="badge dim">DISABLED</span>') + '</div></div>' +
        '<div class="hero-actions"><button class="btn big ' + (on ? 'danger' : 'accent') + '" data-a="toggleProfile">' + (on ? 'Disable profile' : 'Enable profile') + '</button>' +
        '<button class="btn big" data-a="addContent">+ Add content</button></div></section>' +
        (on ? '' : '<div class="note">This profile is disabled, so none of its mods will load. Press <b>Enable profile</b> to use it (this turns off whichever profile is active).</div>') +
        '<div class="toolbar"><input class="inp" id="pfilter" data-i="pfilter" placeholder="Filter mods in this profile…" value="' + esc(ui.pfilter) + '">' +
        '<button class="btn" data-a="duplicate">Duplicate</button><button class="btn" data-a="exportOne">Export</button><button class="btn danger" data-a="deleteProfile">Delete</button></div>' +
        '<div class="list" id="plist"></div>';
    }
    function renderPList() {
      var box = $('#plist'), p = P(ui.pid); if (!box || !p) return;
      var q = ui.pfilter.trim().toLowerCase();
      var rows = p.mods.map(function (m, i) { return { m: m, i: i }; }).filter(function (x) { return !q || (x.m.name + ' ' + x.m.file).toLowerCase().indexOf(q) >= 0; });
      if (!p.mods.length) { box.innerHTML = '<div class="empty">This profile is empty.<br>Press <b>+ Add content</b> to pick mods to install here.</div>'; return; }
      if (!rows.length) { box.innerHTML = '<div class="empty">No mods match your filter.</div>'; return; }
      box.innerHTML = rows.map(function (x) {
        var m = x.m;
        return '<div class="row ' + (m.enabled ? '' : 'off') + '">' + icon(m.name) +
          '<div class="info"><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(m.file) + ' &middot; ' + esc(m.source) + (m.ref ? ' @ ' + esc(m.ref) : '') + (m.size ? ' &middot; ' + fmtSize(m.size) : '') + '</div></div>' +
          '<div class="acts"><button class="btn sm" data-a="up" data-id="' + m.id + '" title="Load earlier">&#9650;</button><button class="btn sm" data-a="down" data-id="' + m.id + '" title="Load later">&#9660;</button>' +
          '<label class="sw" title="Enable / disable"><input type="checkbox" data-c="toggleMod" data-id="' + m.id + '" ' + (m.enabled ? 'checked' : '') + '><span></span></label>' +
          '<button class="btn sm danger" data-a="removeMod" data-id="' + m.id + '">Remove</button></div></div>';
      }).join('');
    }

    function vBrowse() {
      return '<div class="pagehead"><h2>Browse Mods</h2><div class="grow"></div><button class="btn" data-a="sourcesModal">Sources</button><button class="btn" data-a="refreshReg">Refresh list</button></div>' +
        '<div class="toolbar"><input class="inp" id="q" data-i="query" placeholder="Search mods…" value="' + esc(ui.query) + '" autocomplete="off"></div>' +
        '<div class="toolbar"><input class="inp" id="custom" placeholder="…or paste a mod URL (https://…/mod.js) to add it directly"><button class="btn" data-a="addCustom">Add URL</button></div>' +
        '<div class="list" id="results"></div>';
    }
    function searchResults() {
      var items = registry && registry.items ? registry.items : [];
      var q = ui.query.trim().toLowerCase();
      if (!q) return items;
      var tk = q.split(/\s+/);
      return items.filter(function (it) { return tk.every(function (t) { return it.hay.indexOf(t) >= 0; }); })
        .sort(function (a, b) { var as = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, bs = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1; return as - bs || byName(a, b); });
    }
    function renderResults() {
      var box = $('#results'); if (!box) return;
      var have = registry && registry.items && registry.items.length;
      if (regState === 'loading' && !have) { box.innerHTML = '<div class="empty">Loading the mod list from GitHub…</div>'; return; }
      if (!have) {
        box.innerHTML = '<div class="empty">' + (regState === 'error' ? 'Could not load the mod list.<br>' + esc(regError) + '<br><br><button class="btn accent" data-a="refreshReg">Retry</button>' : 'Loading…') + '</div>';
        return;
      }
      var all = searchResults(), slice = all.slice(0, ui.shown), tgt = ui.target ? P(ui.target) : null;
      if (!all.length) { box.innerHTML = '<div class="empty">No mods match &ldquo;' + esc(ui.query) + '&rdquo;.</div>'; return; }
      box.innerHTML = slice.map(function (it) {
        var where = installedIn(it.url), inT = tgt && tgt.mods.some(function (m) { return m.url === it.url; });
        var d = ui.open[it.url] ? '<div class="desc">' + (descs[it.url] ? esc(descs[it.url]) : 'Loading…') + '</div>' : '';
        return '<div class="row">' + icon(it.name) + '<div class="info"><div class="name">' + esc(it.name) +
          (where.length ? ' <span class="badge dim">IN: ' + esc(where.join(', ')) + '</span>' : '') + '</div>' +
          '<div class="meta">' + esc(it.file) + ' &middot; ' + esc(it.source) + (it.size ? ' &middot; ' + fmtSize(it.size) : '') + '</div>' + d + '</div>' +
          '<div class="acts"><button class="btn sm" data-a="details" data-i="' + it.i + '">' + (ui.open[it.url] ? 'Hide' : 'Details') + '</button>' +
          '<button class="btn accent" data-a="install" data-i="' + it.i + '" ' + (inT ? 'disabled' : '') + '>' + (inT ? 'Added' : 'Install') + '</button></div></div>';
      }).join('') + (all.length > slice.length ? '<button class="btn" data-a="more" style="margin:8px auto">Show more (' + (all.length - slice.length) + ' left)</button>' : '') +
        '<div class="foot">' + all.length + ' mod' + (all.length === 1 ? '' : 's') + ' &middot; mods run with full access to the game &mdash; only install ones you trust.</div>';
    }

    function renderMain() {
      var m = $('#view');
      m.innerHTML = ui.view === 'browse' ? vBrowse() : ui.view === 'profile' ? vProfile() : vProfiles();
      if (ui.view === 'browse') renderResults();
      if (ui.view === 'profile') renderPList();
    }
    function refresh() {
      var y = window.scrollY;
      renderTop();
      if (ui.view === 'browse') renderResults(); else renderMain();
      window.scrollTo(0, y);
    }
    function go(view, pid) {
      ui.view = view; if (pid !== undefined) ui.pid = pid;
      renderTop(); renderMain(); window.scrollTo(0, 0);
      if (view === 'browse') ensureRegistry(false);
    }

    /* ---------- install flow ---------- */
    function addMod(pid, item) {
      var p = P(pid); if (!p) return false;
      if (SELF_RE.test(item.url)) { toast('The manager itself is always enabled.'); return false; }
      if (p.mods.some(function (m) { return m.url === item.url; })) { toast(item.name + ' is already in ' + p.name + '.'); return false; }
      p.mods.push({ id: uid(), name: item.name, file: item.file, url: item.url, source: item.source || 'custom', ref: item.ref || '', size: item.size || 0, enabled: true });
      save();
      toast('Installed ' + item.name + ' into ' + p.name + (db.activeProfileId === p.id ? '' : ' (profile is disabled)'));
      refresh(); return true;
    }
    function startInstall(item) {
      if (ui.target && P(ui.target)) return addMod(ui.target, item);
      if (!db.profiles.length) {
        var d = mkProfile('Default'); db.profiles.push(d); if (!db.activeProfileId) db.activeProfileId = d.id;
        return addMod(d.id, item);
      }
      if (db.profiles.length === 1) return addMod(db.profiles[0].id, item);
      pendingItem = item;
      openModal('<h3>Install ' + esc(item.name) + ' into which profile?</h3>' +
        db.profiles.map(function (p) {
          return '<button class="btn pick" data-a="pickProfile" data-id="' + p.id + '"><span>' + esc(p.name) + '</span><span class="meta">' + p.mods.length + ' mods' + (db.activeProfileId === p.id ? ' &middot; ACTIVE' : '') + '</span></button>';
        }).join('') +
        '<div style="margin-top:12px" class="meta">Or create a new profile:</div><input class="inp" type="text" data-val id="newp" placeholder="Profile name" maxlength="60" style="width:100%">' +
        '<div style="margin-top:8px"><button class="btn accent" data-a="pickNew">Create &amp; install</button><button class="btn" data-a="closeModal">Cancel</button></div>');
    }

    /* ---------- import / export ---------- */
    function profilePayload(list) {
      return { bmm: 1, type: 'profiles', exportedAt: new Date().toISOString(), profiles: list.map(function (p) {
        return { name: p.name, mods: p.mods.map(function (m) { return { name: m.name, file: m.file, url: m.url, source: m.source, ref: m.ref, size: m.size, enabled: m.enabled }; }) };
      }) };
    }
    function exportModal(list, label) {
      exportPayload = profilePayload(list);
      var code = 'BMM1:' + btoa(unescape(encodeURIComponent(JSON.stringify(exportPayload))));
      openModal('<h3>Export ' + esc(label) + '</h3><p class="meta">Save the file somewhere safe &mdash; it lets you restore your profiles after clearing data or on another device.</p>' +
        '<button class="btn accent" data-a="dlExport">Download file</button><button class="btn" data-a="copyCode">Copy share code</button>' +
        '<textarea id="codebox" readonly>' + esc(code) + '</textarea><div style="margin-top:8px"><button class="btn" data-a="closeModal">Close</button></div>');
    }
    function parseImport(text) {
      text = String(text || '').trim(); if (!text) throw new Error('Nothing to import.');
      if (text.indexOf('BMM1:') === 0) text = decodeURIComponent(escape(atob(text.slice(5).replace(/\s+/g, ''))));
      var j = JSON.parse(text), profiles = [];
      if (Array.isArray(j)) j = { profiles: [{ name: 'Imported', mods: j }] };
      if (!j || !Array.isArray(j.profiles)) throw new Error('Not a Mod Manager export.');
      j.profiles.forEach(function (ip) {
        var p = mkProfile(uniqueName(String(ip.name || 'Imported').slice(0, 60)));
        db.profiles.push(p);
        (Array.isArray(ip.mods) ? ip.mods : []).forEach(function (im) {
          var url = typeof im === 'string' ? im : im && im.url;
          if (!okUrl(url) || SELF_RE.test(url) || p.mods.some(function (m) { return m.url === url; })) return;
          var f = fileOf(url);
          p.mods.push({ id: uid(), name: (im && im.name) || pretty(f), file: f, url: url, source: (im && im.source) || 'imported', ref: (im && im.ref) || '', size: (im && im.size) || 0, enabled: !(im && im.enabled === false) });
        });
        profiles.push(p);
      });
      return profiles;
    }
    function doImport(text) {
      var snapshot = db.profiles.slice();
      try {
        var got = parseImport(text);
        save(); closeModal(); toast('Imported ' + got.length + ' profile' + (got.length === 1 ? '' : 's') + '.'); go('profiles');
      } catch (e) { db.profiles = snapshot; toast('Import failed: ' + (e.message || e), 'err'); }
    }

    /* ---------- actions ---------- */
    var A = {
      tab: function (el) { go(el.dataset.v); },
      openProfile: function (el) { go('profile', el.dataset.id); },
      closeModal: closeModal,
      modalOk: function () { var i = $('#modal [data-val]'), v = i ? i.value : '', cb = modalCb; closeModal(); if (cb) cb(v); },
      reload: function () {
        try { if (!window.opener || window.opener.closed) throw 0; window.opener.location.reload(); toast('Reloading the game…'); }
        catch (e) { toast('Could not find the game tab. Reload it manually.', 'err'); }
      },
      newProfile: function () {
        askName('New profile', '', 'Create', function (v) {
          v = (v || '').trim(); if (!v) return;
          var p = mkProfile(uniqueName(v)); db.profiles.push(p); save(); go('profile', p.id);
        });
      },
      toggleProfile: function () {
        var p = P(ui.pid); if (!p) return;
        db.activeProfileId = db.activeProfileId === p.id ? null : p.id; save();
        toast(db.activeProfileId ? 'Enabled ' + p.name + ' (other profiles disabled)' : 'Disabled ' + p.name); refresh();
      },
      addContent: function () { ui.target = ui.pid; go('browse'); },
      doneTarget: function () { var pid = ui.target; ui.target = null; if (pid && P(pid)) go('profile', pid); else go('profiles'); },
      duplicate: function () {
        var p = P(ui.pid); if (!p) return;
        var c = mkProfile(uniqueName(p.name + ' (copy)'));
        c.mods = p.mods.map(function (m) { return Object.assign({}, m, { id: uid() }); });
        db.profiles.push(c); save(); toast('Duplicated.'); go('profile', c.id);
      },
      deleteProfile: function () {
        var p = P(ui.pid); if (!p) return;
        confirmModal('Delete the profile "' + p.name + '" and its ' + p.mods.length + ' mod entries? This cannot be undone (export first to keep a copy).', 'Delete profile', function () {
          db.profiles = db.profiles.filter(function (x) { return x.id !== p.id; });
          if (db.activeProfileId === p.id) db.activeProfileId = null;
          if (ui.target === p.id) ui.target = null;
          save(); toast('Deleted ' + p.name); go('profiles');
        });
      },
      removeMod: function (el) {
        var p = P(ui.pid); if (!p) return;
        p.mods = p.mods.filter(function (m) { return m.id !== el.dataset.id; }); save(); refresh();
      },
      up: function (el) { moveMod(el.dataset.id, -1); },
      down: function (el) { moveMod(el.dataset.id, 1); },
      install: function (el) { var it = registry.items[+el.dataset.i]; if (it) startInstall(it); },
      details: function (el) {
        var it = registry.items[+el.dataset.i]; if (!it) return;
        ui.open[it.url] = !ui.open[it.url];
        if (ui.open[it.url]) loadDesc(it); else refresh();
        if (ui.open[it.url] && descs[it.url] !== undefined) refresh();
      },
      more: function () { ui.shown += PAGE; refresh(); },
      refreshReg: function () { ensureRegistry(true); },
      pickProfile: function (el) { var it = pendingItem; closeModal(); if (it) addMod(el.dataset.id, it); pendingItem = null; },
      pickNew: function () {
        var v = ($('#newp') || {}).value; v = (v || '').trim(); if (!v) { toast('Enter a profile name.', 'err'); return; }
        var it = pendingItem, p = mkProfile(uniqueName(v)); db.profiles.push(p); pendingItem = null; closeModal(); if (it) addMod(p.id, it); else save();
      },
      addCustom: function () {
        var u = (($('#custom') || {}).value || '').trim();
        if (!okUrl(u)) { toast('Enter a link ending in .js (or a mods/ filename).', 'err'); return; }
        if (SELF_RE.test(u)) { toast('That is this manager — it is always installed.', 'err'); return; }
        var f = fileOf(u); $('#custom').value = '';
        startInstall({ name: pretty(f), file: f, url: u, source: 'custom', ref: '', size: 0 });
      },
      exportAll: function () { if (!db.profiles.length) return toast('No profiles to export.', 'err'); exportModal(db.profiles, 'all profiles'); },
      exportOne: function () { var p = P(ui.pid); if (p) exportModal([p], '"' + p.name + '"'); },
      dlExport: function () {
        var blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
        var a = document.createElement('a'), n = exportPayload.profiles.length === 1 ? exportPayload.profiles[0].name.replace(/[^\w\-]+/g, '_') : 'all-profiles';
        a.href = URL.createObjectURL(blob); a.download = 'bestModManager-' + n + '-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        db.lastExport = Date.now(); writeJSON(STORE, db, true); toast('Exported.');
      },
      copyCode: function () {
        var box = $('#codebox'); box.select();
        var done = function () { db.lastExport = Date.now(); writeJSON(STORE, db, true); toast('Share code copied.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(done, function () { document.execCommand('copy'); done(); });
        else { document.execCommand('copy'); done(); }
      },
      importModal: function () {
        openModal('<h3>Import profiles</h3><p class="meta">Imported profiles are added as new profiles &mdash; nothing is overwritten. Only import files from people you trust: mods run with full access to the game.</p>' +
          '<input type="file" accept=".json,application/json" data-c="importFile"><div class="meta" style="margin:10px 0 4px">…or paste a share code / JSON:</div>' +
          '<textarea data-val placeholder="BMM1:…"></textarea><div style="margin-top:8px"><button class="btn accent" data-a="doImport">Import</button><button class="btn" data-a="closeModal">Cancel</button></div>');
      },
      doImport: function () { doImport(($('#modal [data-val]') || {}).value); },
      sourcesModal: function () {
        openModal('<h3>Mod sources</h3><p class="meta">GitHub repos searched in Browse. Mods are loaded through the jsDelivr CDN.</p>' +
          db.sources.map(function (s, i) { return '<div class="srcrow"><span>' + esc(s.repo) + ' <span class="meta">/' + esc(s.path || '') + ' @' + esc(s.branch || 'main') + '</span></span><button class="btn sm danger" data-a="rmSource" data-i="' + i + '">Remove</button></div>'; }).join('') +
          '<div style="margin-top:12px" class="meta">Add a source:</div><input class="inp" id="srepo" placeholder="owner/repo" style="width:100%"><input class="inp" id="spath" placeholder="folder (default: mods)" style="width:49%"> <input class="inp" id="sbranch" placeholder="branch (default: main)" style="width:49%">' +
          '<div style="margin-top:8px"><button class="btn accent" data-a="addSource">Add source</button><button class="btn" data-a="resetSources">Reset to defaults</button><button class="btn" data-a="closeModal">Close</button></div>');
      },
      rmSource: function (el) { db.sources.splice(+el.dataset.i, 1); afterSources(); },
      addSource: function () {
        var repo = (($('#srepo') || {}).value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
        if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) { toast('Use the form owner/repo.', 'err'); return; }
        db.sources.push({ repo: repo, path: (($('#spath') || {}).value || 'mods').trim(), branch: (($('#sbranch') || {}).value || 'main').trim() }); afterSources();
      },
      resetSources: function () { db.sources = DEFAULT_SOURCES.map(function (s) { return Object.assign({}, s); }); afterSources(); }
    };
    function afterSources() { writeJSON(STORE, db); closeModal(); ensureRegistry(true); A.sourcesModal(); }
    function moveMod(id, d) {
      var p = P(ui.pid); if (!p) return;
      var i = p.mods.findIndex(function (m) { return m.id === id; }), j = i + d;
      if (i < 0 || j < 0 || j >= p.mods.length) return;
      var t = p.mods[i]; p.mods[i] = p.mods[j]; p.mods[j] = t; save(); refresh();
    }
    var C = {
      rename: function (el) {
        var p = P(ui.pid); if (!p) return; var v = el.value.trim();
        if (!v) { el.value = p.name; return; }
        if (v !== p.name) { p.name = uniqueName(v, p.id); save(); toast('Renamed.'); }
        refresh();
      },
      toggleMod: function (el) {
        var p = P(ui.pid); if (!p) return; var m = p.mods.find(function (x) { return x.id === el.dataset.id; });
        if (m) { m.enabled = el.checked; save(); refresh(); }
      },
      importFile: function (el) {
        var f = el.files && el.files[0]; if (!f) return;
        f.text().then(doImport, function () { toast('Could not read that file.', 'err'); });
      }
    };
    var I = {
      query: function (el) { ui.query = el.value; ui.shown = PAGE; renderResults(); },
      pfilter: function (el) { ui.pfilter = el.value; renderPList(); }
    };

    /* ---------- boot ---------- */
    var root = document.documentElement;
    if (boot.font) root.style.setProperty('--font', boot.font);
    if (boot.btnBg) root.style.setProperty('--btn', boot.btnBg);
    if (boot.btnColor) root.style.setProperty('--btntext', boot.btnColor);
    document.title = 'Mod Manager - Sandboxels';
    document.body.innerHTML = '<div id="head"></div><main id="view"></main><div id="modal"></div><div id="toasts"></div>';

    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-a]') : null;
      if (el && el.tagName !== 'INPUT' && A[el.dataset.a]) A[el.dataset.a](el, e);
    });
    document.addEventListener('change', function (e) { var el = e.target; if (el && el.dataset && C[el.dataset.c]) C[el.dataset.c](el, e); });
    document.addEventListener('input', function (e) { var el = e.target; if (el && el.dataset && I[el.dataset.i]) I[el.dataset.i](el, e); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('#modal.on')) closeModal();
      if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('#modal input[type=text]')) {
        var ok = $('#modal [data-a=modalOk],#modal [data-a=pickNew]'); if (ok) ok.click();
      }
      if (e.key === 'Enter' && e.target && e.target.id === 'custom') A.addCustom();
    });
    window.addEventListener('storage', function (e) {
      if (e.key === STORE) { db = readJSON(STORE, db); if (ui.view === 'profile' && !P(ui.pid)) ui.view = 'profiles'; renderTop(); renderMain(); }
      else if (e.key === ENABLED || e.key === LOADED) renderTop();
    });
    renderTop(); renderMain();
  }

  /* ---------------------------------------------------------------------------
   * Game side: record state, hook the Mods button, open the manager page.
   * ------------------------------------------------------------------------- */
  var selfSrc = '';
  try { selfSrc = (document.currentScript && document.currentScript.src) || ''; } catch (e) { /* ignore */ }
  if (!selfSrc) {
    var ss = document.scripts;
    for (var i = 0; i < ss.length; i++) { if (ss[i].src && SELF_RE.test(ss[i].src)) { selfSrc = ss[i].src; break; } }
  }

  try {
    var cur = [];
    try { cur = JSON.parse(localStorage.getItem('enabledMods') || '[]'); } catch (e) { cur = []; }
    if (!Array.isArray(cur)) cur = [];
    var entry = '';
    for (var k = 0; k < cur.length; k++) { if (typeof cur[k] === 'string' && SELF_RE.test(cur[k])) { entry = cur[k]; break; } }
    if (!entry && selfSrc) { /* self-heal: the manager must always stay enabled */
      entry = selfSrc; cur.unshift(entry);
      localStorage.setItem('enabledMods', JSON.stringify(cur));
    }
    if (entry) localStorage.setItem('bmm_self', entry);
    localStorage.setItem('bmm_loaded', JSON.stringify(cur)); /* what the game loaded this session */
  } catch (e) { console.warn('[bestModManager] could not record state', e); }

  function themeInfo() {
    var t = {};
    try {
      var cs = getComputedStyle(document.body);
      if (cs.fontFamily) t.font = cs.fontFamily;
      var b = document.querySelector('.controlButton') || document.querySelector('button');
      if (b) {
        var bs = getComputedStyle(b);
        if (bs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(bs.backgroundColor)) t.btnBg = bs.backgroundColor;
        if (bs.color) t.btnColor = bs.color;
      }
    } catch (e) { /* ignore */ }
    return t;
  }
  function fontFaces() { /* copy the game's @font-face rules so the page uses the same font */
    var out = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sh = document.styleSheets[s], rules;
        try { rules = sh.cssRules; } catch (e) { continue; }
        var base = sh.href || location.href;
        for (var r = 0; r < rules.length; r++) {
          if (rules[r].type === 5) {
            out.push(rules[r].cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, function (m, q, u) {
              if (/^(data:|https?:)/i.test(u)) return m;
              try { return 'url("' + new URL(u, base).href + '")'; } catch (e) { return m; }
            }));
          }
        }
      }
    } catch (e) { /* ignore */ }
    return out.join('\n');
  }

  function openManager() {
    var w = null;
    try { w = window.open('', 'bmm_manager_window'); } catch (e) { w = null; }
    if (!w) return false;
    try { if (w.__bmmReady) { w.focus(); return true; } } catch (e) { /* ignore */ }
    var boot = themeInfo();
    boot.selfUrl = selfSrc;
    var js = '(' + bmmApp.toString() + ')(' + JSON.stringify(boot).replace(/</g, '\\u003c') + ');';
    js = js.replace(/<\/script/gi, '<\\/script');
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Mod Manager</title><style>' + fontFaces() + '\n' + BMM_CSS + '</style></head><body><script>' + js + '<\/script></body></html>';
    try { w.document.open(); w.document.write(html); w.document.close(); w.focus(); return true; }
    catch (e) { console.error('[bestModManager] could not build the page', e); return false; }
  }

  var origShow = window.showMods;
  function fallback() {
    try { alert('Best Mod Manager: your browser blocked the new page. Allow pop-ups for this site and try again.'); } catch (e) { /* ignore */ }
    if (typeof origShow === 'function') origShow();
  }
  window.showMods = function () {
    if (!openManager()) fallback();
  };
  document.addEventListener('click', function (e) {
    if (e.shiftKey) return; /* Shift+click opens the original Mods panel */
    var t = e.target; if (!t || !t.closest) return;
    var hit = t.closest('[onclick*="showMods"]');
    if (!hit && !document.querySelector('[onclick*="showMods"]')) {
      var b = t.closest('button');
      if (b && b.textContent.trim() === 'Mods') hit = b;
    }
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!openManager()) fallback();
  }, true);

  window.bmm = { version: VERSION, open: openManager };
  console.log('[bestModManager] v' + VERSION + ' ready. Click Mods to open it (Shift+click for the original panel).');
})();
