// Claude Switchboard: a side panel docked beside claude.ai that lists every
// Cowork task by what it needs from you, and switches tasks inside the same tab.
// It only reads your own task list from claude.ai, with your existing sign-in.
// Everything it remembers (drafts, done, layout) stays in this browser.
(() => {
  if (window.__claudeSwitchboardLoaded) return;
  window.__claudeSwitchboardLoaded = true;

  const POLL_MS = 15000;
  const PANEL_W = 320;
  const STALE_MS = 7 * 24 * 3600 * 1000;
  const FINISHED_MS = 24 * 3600 * 1000;
  const RETURN_AFTER_MS = 2 * 60 * 1000;
  const LABELS = {
    needs: 'Needs you',
    draft: 'Drafts',
    working: 'Working',
    review: 'Finished',
    stale: 'Waiting for over a week',
    recent: 'Recent',
    scheduled: 'Scheduled',
    done: 'Done',
  };
  const DEFAULT_ORDER = ['needs', 'draft', 'working', 'review', 'stale', 'recent', 'scheduled', 'done'];
  const CAPPED = { recent: 8 }; // sections that show the newest few, with "Show more"
  const DEFAULT_COLLAPSED = { stale: true, done: true };

  // ---------- storage (chrome.storage, with a page fallback for testing) ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(k, d) {
      try {
        if (hasChrome) return (await chrome.storage.local.get(k))[k] ?? d;
        const v = localStorage.getItem('tq.' + k);
        return v ? JSON.parse(v) : d;
      } catch { return d; }
    },
    async set(k, v) {
      try {
        if (hasChrome) await chrome.storage.local.set({ [k]: v });
        else localStorage.setItem('tq.' + k, JSON.stringify(v));
      } catch { /* storage is a convenience */ }
    },
  };

  // ---------- state ----------
  let org = null;
  let sessions = [];      // tasks built from Claude's lists
  let chats = [];         // normal claude.ai chats
  const chatWasWorking = new Set();
  let finishedChats = {}; // chat id -> when we saw it stop replying (until you open it)
  let tasks = [];         // what the panel shows (sessions + new-task drafts, done applied)
  let drafts = {};        // key -> { chars, text, at, title?, path? }
  let done = {};          // doneKey -> time marked done
  let lastLoad = 0;
  let lastError = '';
  let loading = false;
  let dragging = null;
  const ui = { open: true, q: '', sel: null, showAll: {}, needCursor: 0, order: DEFAULT_ORDER.slice(), collapsed: { ...DEFAULT_COLLAPSED } };

  // ---------- Claude's task lists ----------
  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getOrg() {
    if (org) return org;
    org = readCookie('lastActiveOrg');
    if (!org) {
      const r = await fetch('/api/organizations', { credentials: 'include' });
      const list = await r.json();
      org = Array.isArray(list) && list[0] ? list[0].uuid : null;
    }
    return org;
  }

  const headers = o => ({
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'anthropic-client-feature': 'ccr',
    'anthropic-client-platform': 'web_claude_ai',
    'x-organization-uuid': o,
    'content-type': 'application/json',
  });

  const bareId = id => String(id || '').replace(/^(session|cse)_/, '');
  const timeOf = s => Date.parse(s.last_event_at || s.updated_at || '') || 0;
  const snippet = t => (t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const draftNote = d => d && d.text ? '“' + d.text + (d.chars > d.text.length ? '…' : '') + '”' : 'You started a reply and haven’t sent it';

  function classify(s) {
    const id = 'session_' + bareId(s.id);
    const bucket = s.status_bucket;
    const worker = s.worker_status;
    const at = timeOf(s);
    const needs = bucket === 'blocked' || worker === 'requires_action';
    const working = !needs && (bucket === 'working' || worker === 'running');
    let group;
    if (needs) group = at && Date.now() - at > STALE_MS ? 'stale' : 'needs';
    else if (working) group = 'working';
    else if (bucket === 'review_ready' || (at && Date.now() - at < FINISHED_MS)) group = 'review';
    else group = 'recent';
    const note = {
      needs: 'Waiting for your answer or approval',
      stale: 'Still waiting for your answer or approval',
      working: 'Working…',
      review: bucket === 'review_ready' ? 'Finished, ready for you to look at' : 'Finished',
      recent: '',
    }[group];
    return { id, path: '/cowork/cse_' + bareId(s.id), title: s.title || 'Untitled task', group, baseGroup: group, note, baseNote: note, unread: s.unread === true, at };
  }

  // Scheduled tasks: every run is its own session, so group runs by their schedule.
  function groupSchedules(runs) {
    const by = new Map();
    for (const s of runs) {
      const key = s.trigger_id || s.title || s.id;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(s);
    }
    return [...by.entries()].map(([key, list]) => {
      list.sort((a, b) => timeOf(b) - timeOf(a));
      const latest = list[0];
      const blocked = list.find(s => s.status_bucket === 'blocked' || s.worker_status === 'requires_action');
      const running = list.some(s => s.status_bucket === 'working' || s.worker_status === 'running');
      const unread = list.filter(s => s.unread).length;
      const target = blocked || latest;
      const parts = [];
      if (blocked) parts.push('A run needs you');
      else if (running) parts.push('Running now');
      if (unread) parts.push(unread + ' new');
      parts.push(list.length + (list.length === 1 ? ' run' : ' runs'));
      return {
        id: 'session_' + bareId(target.id),
        path: '/cowork/cse_' + bareId(target.id),
        doneKey: 'sched:' + key,
        runIds: list.map(s => 'session_' + bareId(s.id)),
        title: latest.title || 'Scheduled task',
        group: 'scheduled',
        baseGroup: 'scheduled',
        schedule: true,
        needs: !!blocked,
        running,
        note: parts.join(' · '),
        unread: unread > 0,
        at: timeOf(latest),
      };
    });
  }

  // Normal chats: running while a reply streams, needs you when it waits for input.
  function classifyChat(c) {
    const id = 'chat:' + c.uuid;
    const at = Date.parse(c.updated_at || c.created_at || '') || 0;
    const needs = !!c.needs_input;
    const working = !needs && !!c.live_status;
    if (working) chatWasWorking.add(id);
    else if (chatWasWorking.has(id)) { chatWasWorking.delete(id); finishedChats[id] = Date.now(); store.set('finishedChats', finishedChats); }
    let group;
    if (needs) group = at && Date.now() - at > STALE_MS ? 'stale' : 'needs';
    else if (working) group = 'working';
    else if ((finishedChats[id] && Date.now() - finishedChats[id] < FINISHED_MS) || (at && Date.now() - at < FINISHED_MS)) group = 'review';
    else group = 'recent';
    const project = c.project && c.project.name ? c.project.name : '';
    const note = {
      needs: 'Waiting for your answer or approval',
      stale: 'Still waiting for your answer or approval',
      working: 'Working\u2026',
      review: finishedChats[id] ? 'Finished, ready for you to look at' : 'Finished',
      recent: '',
    }[group] + (project && (group === 'review' || group === 'recent') ? (group === 'recent' ? project : ' \u00b7 ' + project) : '');
    const out = c.latest_assistant_output_at ? Date.parse(c.latest_assistant_output_at) : 0;
    const read = c.last_read_at ? Date.parse(c.last_read_at) : 0;
    return { id, path: '/chat/' + c.uuid, title: c.name || 'Untitled chat', group, baseGroup: group, note, baseNote: note, unread: !!out && out > read, at, chat: true };
  }

  async function loadChats(o) {
    try {
      const r = await fetch('/api/organizations/' + o + '/chat_conversations_v2?limit=50&offset=0&archived=false&consistency=eventual', {
        credentials: 'include',
        headers: { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      });
      if (!r.ok) return chats;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.data || []);
      return list.filter(c => c && c.uuid && !c.is_temporary && !c.session_id).map(classifyChat);
    } catch {
      return chats; // keep the last list if this poll fails
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const o = await getOrg();
      if (!o) throw new Error('Sign in to Claude to see your tasks.');
      const opts = { credentials: 'include', headers: headers(o) };
      const [r, rs, cl] = await Promise.all([
        fetch('/v1/code/sessions?limit=100&tags=product:cowork-remote', opts),
        fetch('/v1/code/sessions?tags=cowork-remote&limit=100&only_trigger_sessions=true&statuses=active&statuses=paused&statuses=failed', opts),
        loadChats(o),
      ]);
      chats = cl;
      if (r.status === 401 || r.status === 403) throw new Error('Sign in to Claude to see your tasks.');
      if (!r.ok) throw new Error('Claude didn’t return your task list (error ' + r.status + '). Retrying shortly.');
      const j = await r.json();
      const runs = rs.ok ? ((await rs.json()).data || []) : [];
      const runIds = new Set(runs.map(s => bareId(s.id)));
      sessions = (j.data || [])
        .filter(s => !runIds.has(bareId(s.id)) && s.config?.origin !== 'scheduled_trigger')
        .map(classify)
        .concat(groupSchedules(runs));
      lastLoad = Date.now();
      lastError = '';
    } catch (e) {
      lastError = e && e.message ? e.message : 'Couldn’t load your tasks. Retrying shortly.';
    } finally {
      loading = false;
      rebuild();
    }
  }

  // ---------- build the shown list: drafts and done on top of Claude's data ----------
  const keyOf = t => t.doneKey || t.id;

  function rebuild() {
    const list = sessions.concat(chats).map(t => {
      if (t.schedule) return t;
      const d = drafts[t.id];
      if (d && d.chars > 0 && t.baseGroup !== 'needs' && t.baseGroup !== 'working') {
        return { ...t, group: 'draft', note: draftNote(d) };
      }
      return { ...t, group: t.baseGroup, note: t.baseNote };
    });
    // Drafts of tasks you haven't sent yet: a new task, or a new task in a project.
    for (const [key, d] of Object.entries(drafts)) {
      if (!key.startsWith('new:') || !(d.chars > 0)) continue;
      list.push({ id: key, path: d.path, title: d.title || 'New task', group: 'draft', baseGroup: 'draft', note: draftNote(d), unread: false, at: d.at, newDraft: true });
    }
    let doneChanged = false;
    tasks = list.map(t => {
      if (t.newDraft) return t;
      const at = done[keyOf(t)];
      if (!at) return t;
      if (t.at > at + RETURN_AFTER_MS) { delete done[keyOf(t)]; doneChanged = true; return t; }
      return { ...t, group: 'done', note: '' };
    });
    if (doneChanged) store.set('done', done);
    render();
  }

  function markDone(id, on) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    if (t.newDraft) {
      delete drafts[id];
      store.set('drafts', drafts);
      flash('Draft removed from the queue');
    } else {
      if (on) done[keyOf(t)] = Math.max(Date.now(), t.at);
      else delete done[keyOf(t)];
      store.set('done', done);
      flash(on ? 'Moved to Done' : 'Back in the queue');
    }
    rebuild();
  }

  // ---------- drafts: watch the reply box ----------
  const NEW_PATH = /^\/(new|project\/[0-9a-f-]{36}|cowork\/project\/[0-9a-f-]{36})\/?$/;
  function draftKeyFor(path) {
    const m = path.match(/^\/cowork\/cse_([A-Za-z0-9]+)/);
    if (m) return 'session_' + m[1];
    const c = path.match(/^\/chat\/([0-9a-f-]{36})/);
    if (c) return 'chat:' + c[1];
    if (NEW_PATH.test(path)) return 'new:' + path.replace(/\/$/, '');
    return null;
  }
  const currentId = () => {
    const k = draftKeyFor(location.pathname);
    return k && (k.startsWith('session_') || k.startsWith('chat:')) ? k : null;
  };
  function newTaskTitle() {
    if (/^\/new\/?$/.test(location.pathname)) return 'New task';
    const name = document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim();
    return name && name !== 'Claude' ? 'New task in ' + name : 'New task in a project';
  }

  let lastPath = location.pathname;
  let settleUntil = 0;
  let saveTimer = 0;
  let pendingSend = null; // { key, at } set when you press Enter or Send in a new task

  function composerText() {
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(el => el.closest('#tq-host') === null);
    const ed = eds.find(el => el.classList.contains('ProseMirror')) || eds[eds.length - 1];
    return ed ? (ed.innerText || '').trim() : '';
  }

  function saveDrafts() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('drafts', drafts), 400);
  }

  function watchDraft() {
    if (location.pathname !== lastPath) {
      const prevKey = draftKeyFor(lastPath);
      // A new task you just sent turns into a session page: drop its draft.
      if (pendingSend && pendingSend.key === prevKey && Date.now() - pendingSend.at < 15000 && drafts[prevKey]) {
        delete drafts[prevKey];
        saveDrafts();
        rebuild();
      }
      pendingSend = null;
      lastPath = location.pathname;
      const opened = currentId();
      if (opened && finishedChats[opened]) {
        delete finishedChats[opened];
        store.set('finishedChats', finishedChats);
        chats = chats.map(c => c.id === opened && c.baseGroup === 'review' ? { ...c, baseNote: 'Finished', note: 'Finished' } : c);
        rebuild();
      }
      settleUntil = Date.now() + 1500; // let the new page's reply box load first
      render();
      return;
    }
    if (Date.now() < settleUntil) return;
    const key = draftKeyFor(location.pathname);
    if (!key) return;
    const text = composerText();
    const prev = drafts[key];
    if (!text) {
      if (prev) { delete drafts[key]; saveDrafts(); rebuild(); }
      return;
    }
    const snip = snippet(text);
    if (prev && prev.text === snip && prev.chars === text.length) return;
    const wasDraft = !!prev;
    drafts[key] = { chars: text.length, text: snip, at: Date.now() };
    if (key.startsWith('new:')) { drafts[key].title = newTaskTitle(); drafts[key].path = location.pathname.replace(/\/$/, ''); }
    saveDrafts();
    if (!wasDraft || key.startsWith('new:')) rebuild();
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!e.target || !e.target.closest || !e.target.closest('[contenteditable="true"]')) return;
    const key = draftKeyFor(location.pathname);
    if (key && key.startsWith('new:')) pendingSend = { key, at: Date.now() };
  }, true);
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('button');
    if (!b || b.closest('#tq-host')) return;
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
    if (!/send|submit/i.test(label)) return;
    const key = draftKeyFor(location.pathname);
    if (key && key.startsWith('new:')) pendingSend = { key, at: Date.now() };
  }, true);

  // ---------- switching in the same tab ----------
  function switchTo(t) {
    const path = t.path;
    if (!path || location.pathname === path) return;
    const link = [...document.querySelectorAll('a[href="' + path + '"]')].find(a => a.closest('#tq-host') === null);
    if (link) {
      link.click();
    } else {
      const st = history.state || {};
      const idx = (typeof st.__TSR_index === 'number' ? st.__TSR_index : 0) + 1;
      const key = Math.random().toString(36).slice(2, 10);
      history.pushState({ __TSR_index: idx, key, __TSR_key: key }, '', path);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }
    setTimeout(() => { if (location.pathname !== path) location.assign(path); }, 1200);
  }

  function nextNeed() {
    const need = tasks.filter(t => t.group === 'needs');
    if (!need.length) { flash('Nothing is waiting for you'); return; }
    const t = need[ui.needCursor % need.length];
    ui.needCursor += 1;
    ui.sel = t.id;
    switchTo(t);
    render();
  }

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = 'tq-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;top:0;right:0;font-family:inherit;';
  const root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .wrap{--bg:#faf9f5;--panel:#ffffff;--hover:#f0eee6;--sel:#e8e6dc;--ink:#141413;--text:#3d3d3a;--muted:#73726c;--line:#e5e3da;--accent:#d97757;--accent-ink:#c6613f;--draft:#8a6fb5;
    font:14px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
  .wrap.dark{--bg:#262624;--panel:#30302e;--hover:#3a3a37;--sel:#454541;--ink:#faf9f5;--text:#e5e3da;--muted:#a6a39a;--line:#45453f;--accent:#d97757;--accent-ink:#e8926f;--draft:#b8a3dc}
  button{font:inherit;color:inherit;cursor:pointer}
  :focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .panel{position:fixed;top:0;right:0;bottom:0;width:${PANEL_W}px;background:var(--bg);border-left:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
  .head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 16px}
  .head h1{margin:0;font:500 16px/1.2 "Source Serif 4",Georgia,serif;color:var(--ink);flex:1}
  .count{font-size:12px;color:var(--accent-ink);font-weight:500}
  .icon{border:0;background:transparent;border-radius:8px;width:28px;height:28px;display:grid;place-items:center;color:var(--muted)}
  .icon:hover{background:var(--hover);color:var(--ink)}
  .search{margin:0 12px 6px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:6px 10px;background:var(--panel)}
  .search input{flex:1;min-width:0;border:0;background:transparent;font:inherit;color:var(--ink);outline:none}
  .search input::placeholder{color:var(--muted)}
  kbd{font-family:inherit;font-size:10.5px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
  .search kbd{font-size:10px;font-weight:400;border:0;padding:0;opacity:.55;letter-spacing:.02em}
  .list{flex:1;overflow:auto;padding:0 6px 10px}
  .sec{border-top:2px solid transparent;border-bottom:2px solid transparent}
  .sec.drop-before{border-top-color:var(--accent)}
  .sec.drop-after{border-bottom-color:var(--accent)}
  .sec.dragging{opacity:.4}
  .wrap.reordering, .wrap.reordering *{cursor:grabbing!important;user-select:none}
  .sh{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;text-align:left;font-size:12px;font-weight:500;color:var(--muted);padding:8px 8px 4px;margin-top:2px;border-radius:8px;cursor:grab;user-select:none}
  .sh:hover{color:var(--ink)}
  .sh:active{cursor:grabbing}
  .sh .chev{width:10px;transition:transform .15s}
  .sec.collapsed .sh .chev{transform:rotate(-90deg)}
  .sh .grip{margin-left:auto;opacity:0;font-size:11px;letter-spacing:-1px}
  .sh:hover .grip{opacity:.7}
  .sec.needs .sh{color:var(--accent-ink)}
  .row{position:relative;display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:8px;align-items:start;width:100%;text-align:left;border-radius:10px;padding:7px 8px;cursor:pointer}
  .row:hover{background:var(--hover)}
  .row.sel{background:var(--sel)}
  .row.cur .t{color:var(--accent-ink)}
  .mk{width:16px;height:20px;display:grid;place-items:center}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .ring{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--muted);border-top-color:transparent;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.ring{animation:none}.sh .chev{transition:none}}
  .hollow{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--muted)}
  .filled{width:8px;height:8px;border-radius:50%;background:var(--muted);opacity:.45}
  .t{color:var(--ink);font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px}
  .n{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .needs .n{color:var(--text)}
  .row.attn .n{color:var(--accent-ink)}
  .side{position:relative;height:20px;min-width:34px;display:flex;align-items:center;justify-content:flex-end}
  .age{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;display:flex;gap:5px;align-items:center;white-space:nowrap}
  .unread{width:6px;height:6px;border-radius:50%;background:var(--accent)}
  .ghost{position:absolute;right:0;top:0;height:20px;display:none;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:7px;padding:0 8px;font-size:11.5px;line-height:18px;white-space:nowrap}
  .ghost:hover{border-color:var(--muted);color:var(--ink)}
  .row:hover .ghost{display:block}
  .row:hover .age{visibility:hidden}
  .sec.done .t{color:var(--muted)}
  .more{border:0;background:transparent;color:var(--muted);font-size:12.5px;padding:6px 10px;border-radius:8px;margin-left:2px}
  .more:hover{background:var(--hover)}
  .empty{color:var(--muted);font-size:12.5px;padding:2px 10px 6px 30px}
  .blank{color:var(--muted);font-size:13px;padding:16px 12px;text-align:center}
  .foot{border-top:1px solid var(--line);padding:8px 14px;font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .err{color:var(--accent-ink)}
  .pill{position:fixed;right:16px;bottom:88px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:7px 12px 7px 10px;
    box-shadow:0 4px 18px rgba(20,20,19,.14);font-size:13px;font-weight:500}
  .pill:hover{background:var(--hover)}
  .badge{min-width:18px;height:18px;border-radius:9px;background:var(--accent);color:#fff;font-size:11px;font-weight:600;display:grid;place-items:center;padding:0 5px}
  .toast{position:fixed;right:24px;bottom:24px;background:var(--ink);color:var(--panel);padding:7px 12px;border-radius:9px;font-size:12.5px}
  `;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = ms => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  };
  const CLOCK = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="color:var(--muted)"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const PEN = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="color:var(--draft)"><path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const CHECK = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="color:var(--muted)"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function markFor(t) {
    if (t.group === 'done') return CHECK;
    if (t.group === 'draft') return PEN;
    if (t.schedule) return t.needs ? '<span class="dot"></span>' : t.running ? '<span class="ring"></span>' : CLOCK;
    if (t.group === 'needs' || t.group === 'stale') return '<span class="dot"></span>';
    if (t.group === 'working') return '<span class="ring"></span>';
    if (t.group === 'review') return '<span class="hollow"></span>';
    return '<span class="filled"></span>';
  }

  function isDark() {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!c) return matchMedia('(prefers-color-scheme: dark)').matches;
    const [r, g, b] = c.map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }

  function matches(t, q) {
    if (!q) return true;
    const h = (t.title + ' ' + (t.note || '')).toLowerCase();
    let i = 0;
    for (const ch of q) { i = h.indexOf(ch, i); if (i < 0) return false; i += 1; }
    return true;
  }

  // Rows in display order, honoring section order, collapsed sections and the Recent cap.
  function sectionRows(key, q) {
    const rows = tasks.filter(t => t.group === key && matches(t, q)).sort((a, b) => b.at - a.at);
    if (CAPPED[key] && !q && !ui.showAll[key]) return { rows: rows.slice(0, CAPPED[key]), total: rows.length };
    return { rows, total: rows.length };
  }
  function navigable() {
    const q = ui.q.toLowerCase().trim();
    return ui.order.flatMap(k => (ui.collapsed[k] && !q) ? [] : sectionRows(k, q).rows);
  }

  let toastTimer = 0;
  function flash(msg) {
    const t = root.querySelector('.toast') || Object.assign(document.createElement('div'), { className: 'toast' });
    t.textContent = msg;
    root.querySelector('.wrap')?.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 1800);
  }

  // Docking: narrow Claude's page so the panel sits beside it, not over it.
  function dock(open) {
    let st = document.getElementById('tq-dock');
    if (open && !st) {
      st = document.createElement('style');
      st.id = 'tq-dock';
      st.textContent = 'html{width:calc(100% - ' + PANEL_W + 'px)!important;}body{width:100%!important;}';
      (document.head || document.documentElement).appendChild(st);
      dispatchEvent(new Event('resize'));
    } else if (!open && st) {
      st.remove();
      dispatchEvent(new Event('resize'));
    }
  }

  function rowHtml(t, cur) {
    const isCur = t.id === cur || (t.runIds && t.runIds.includes(cur));
    const btn = t.group === 'done'
      ? `<button class="ghost" data-undone="${esc(t.id)}" title="Put back in the queue">Restore</button>`
      : t.newDraft
        ? `<button class="ghost" data-done="${esc(t.id)}" title="Remove from the queue (the text stays in Claude)">Dismiss</button>`
        : `<button class="ghost" data-done="${esc(t.id)}" title="Take out of the queue until there's new activity">Done</button>`;
    return `<div role="button" tabindex="0" class="row${t.schedule && t.needs ? ' attn' : ''}${t.id === ui.sel ? ' sel' : ''}${isCur ? ' cur' : ''}" data-id="${esc(t.id)}" title="${esc(t.title)}">
      <span class="mk">${markFor(t)}</span>
      <span style="min-width:0"><div class="t">${esc(t.title)}</div>${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}</span>
      <span class="side"><span class="age">${t.unread ? '<span class="unread" title="Unread"></span>' : ''}${ago(t.at)}</span>${btn}</span>
    </div>`;
  }

  function render() {
    if (dragging) return; // don't rebuild under the pointer mid-drag
    dock(ui.open && innerWidth > 900);
    const needN = tasks.filter(t => t.group === 'needs').length;
    const cur = currentId();
    const dark = isDark() ? ' dark' : '';
    if (!ui.open) {
      root.innerHTML = `<style>${CSS}</style><div class="wrap${dark}"><button class="pill" data-act="open" title="Open Switchboard (Alt+J)">
        Tasks ${needN ? `<span class="badge">${needN}</span>` : ''}</button></div>`;
      return;
    }
    const q = ui.q.toLowerCase().trim();
    if (!navigable().find(t => t.id === ui.sel)) ui.sel = null;
    const listScroll = root.querySelector('.list')?.scrollTop || 0;
    const sections = ui.order.map(k => {
      const { rows, total } = sectionRows(k, q);
      if (!total && (q || k === 'done' || k === 'stale' || k === 'draft')) return '';
      const collapsed = ui.collapsed[k] && !q;
      const more = CAPPED[k] && !collapsed && !q && !ui.showAll[k] && total > CAPPED[k]
        ? `<button class="more" data-act="more" data-sec="${k}">Show ${total - CAPPED[k]} more</button>` : '';
      const body = collapsed ? '' : (rows.length ? rows.map(t => rowHtml(t, cur)).join('') : '<div class="empty">Nothing here</div>') + more;
      return `<section class="sec ${k}${collapsed ? ' collapsed' : ''}" data-sec="${k}">
        <button class="sh" data-sec="${k}" aria-expanded="${!collapsed}" title="Click to ${collapsed ? 'expand' : 'collapse'}, drag to move">
          <svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${LABELS[k]} · ${total}<span class="grip">⋮⋮</span>
        </button>${body}</section>`;
    }).join('');
    const status = lastError ? `<span class="err">${esc(lastError)}</span>` : lastLoad ? `<span>Updated ${ago(lastLoad) === 'now' ? 'just now' : ago(lastLoad) + ' ago'}</span>` : '<span>Loading your tasks…</span>';
    const focused = root.activeElement && root.activeElement.id === 'tq-q';
    const caret = focused ? root.activeElement.selectionStart : null;
    root.innerHTML = `<style>${CSS}</style><div class="wrap${dark}"><div class="panel" role="complementary" aria-label="Claude Switchboard">
      <div class="head"><h1>Switchboard</h1>${needN ? `<span class="count">${needN} need${needN === 1 ? 's' : ''} you</span>` : ''}
        <button class="icon" data-act="refresh" title="Refresh" aria-label="Refresh"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="icon" data-act="close" title="Hide (Alt+J)" aria-label="Hide Switchboard"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
      <label class="search"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="color:var(--muted)"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input id="tq-q" placeholder="Search tasks and chats" autocomplete="off" value="${esc(ui.q)}" aria-label="Search tasks and chats"><kbd title="Alt+J opens search from anywhere">\u2325J</kbd></label>
      <div class="list">${sections || `<div class="blank">${lastLoad ? (q ? 'No tasks match.' : 'No tasks or chats yet.') : ''}</div>`}</div>
      <div class="foot">${status}<span><kbd>Alt N</kbd> next that needs you</span></div>
    </div></div>`;
    const list = root.querySelector('.list');
    if (list) list.scrollTop = listScroll;
    if (focused) {
      const inp = root.getElementById('tq-q');
      inp.focus();
      if (caret !== null) inp.setSelectionRange(caret, caret);
    }
  }

  function move(d) {
    const v = navigable();
    if (!v.length) return;
    let i = v.findIndex(t => t.id === ui.sel);
    i = i < 0 ? (d > 0 ? 0 : v.length - 1) : Math.max(0, Math.min(v.length - 1, i + d));
    ui.sel = v[i].id;
    render();
    root.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function setOpen(open, focusSearch) {
    ui.open = open;
    store.set('open', open);
    render();
    if (open && focusSearch) root.getElementById('tq-q')?.focus();
  }

  function saveLayout() {
    store.set('order', ui.order);
    store.set('collapsed', ui.collapsed);
  }

  root.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const act = a.dataset.act;
      if (act === 'open') setOpen(true, false);
      else if (act === 'close') setOpen(false);
      else if (act === 'refresh') load();
      else if (act === 'more') { ui.showAll[a.dataset.sec] = true; render(); }
      return;
    }
    const sh = e.target.closest('.sh');
    if (sh && suppressClick) return;
    if (sh) {
      const k = sh.dataset.sec;
      ui.collapsed[k] = !ui.collapsed[k];
      saveLayout();
      render();
      return;
    }
    const dn = e.target.closest('[data-done]');
    if (dn) { e.stopPropagation(); markDone(dn.dataset.done, true); return; }
    const un = e.target.closest('[data-undone]');
    if (un) { e.stopPropagation(); markDone(un.dataset.undone, false); return; }
    const r = e.target.closest('.row');
    if (r) {
      const t = tasks.find(x => x.id === r.dataset.id);
      if (t) { ui.sel = t.id; switchTo(t); render(); }
    }
  });

  // Drag a section header up or down to reorder sections (pointer-based, so it works on buttons).
  let press = null;       // { sec, y, id } while the mouse is down on a header
  let suppressClick = false;
  function clearDropMarks() {
    root.querySelectorAll('.drop-before,.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  }
  root.addEventListener('pointerdown', e => {
    const sh = e.target.closest && e.target.closest('.sh');
    if (!sh || e.button !== 0) return;
    press = { sec: sh.dataset.sec, y: e.clientY, id: e.pointerId };
  });
  root.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (!dragging) {
      if (Math.abs(e.clientY - press.y) < 6) return;
      dragging = press.sec;
      root.querySelector('.wrap')?.classList.add('reordering');
      root.querySelector('.sec[data-sec="' + dragging + '"]')?.classList.add('dragging');
    }
    e.preventDefault();
    clearDropMarks();
    const secs = [...root.querySelectorAll('.sec')].filter(el => el.dataset.sec !== dragging);
    let target = null, before = true;
    for (const el of secs) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + Math.min(r.height / 2, 18)) { target = el; before = true; break; }
      target = el; before = false;
    }
    if (target) target.classList.add(before ? 'drop-before' : 'drop-after');
  });
  function endPress(e) {
    if (!press || (e && e.pointerId !== press.id)) return;
    if (dragging) {
      const mark = root.querySelector('.drop-before,.drop-after');
      if (mark) {
        const order = ui.order.filter(k => k !== dragging);
        let i = order.indexOf(mark.dataset.sec);
        if (mark.classList.contains('drop-after')) i += 1;
        order.splice(i, 0, dragging);
        ui.order = order;
        saveLayout();
      }
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      dragging = null;
      press = null;
      render();
      return;
    }
    press = null;
  }
  root.addEventListener('pointerup', endPress);
  root.addEventListener('pointercancel', endPress);
  window.addEventListener('pointerup', e => { if (press) endPress(e); }, true);

  root.addEventListener('input', e => {
    if (e.target.id === 'tq-q') { ui.q = e.target.value; ui.sel = null; render(); }
  });

  root.addEventListener('keydown', e => {
    if (e.target.classList && e.target.classList.contains('row') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const t = tasks.find(x => x.id === e.target.dataset.id);
      if (t) { ui.sel = t.id; switchTo(t); render(); }
      return;
    }
    if (e.target.id !== 'tq-q') return;
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const t = tasks.find(x => x.id === ui.sel) || navigable()[0];
      if (t) { switchTo(t); ui.q = ''; ui.sel = t.id; e.target.blur(); render(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (ui.q) { ui.q = ''; render(); } else e.target.blur();
    }
  });

  // Alt+J: open the panel and search. Alt+N: next task that needs you.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyJ') {
      e.preventDefault(); e.stopPropagation();
      const inp = root.getElementById('tq-q');
      if (ui.open && inp && root.activeElement === inp) setOpen(false);
      else setOpen(true, true);
    } else if (e.code === 'KeyN') {
      e.preventDefault(); e.stopPropagation();
      nextNeed();
    }
  }, true);

  // ---------- start ----------
  (async () => {
    drafts = await store.get('drafts', {});
    done = await store.get('done', {});
    finishedChats = await store.get('finishedChats', {});
    ui.open = await store.get('open', true);
    const order = await store.get('order', null);
    if (Array.isArray(order)) ui.order = order.filter(k => LABELS[k]).concat(DEFAULT_ORDER.filter(k => !order.includes(k)));
    ui.collapsed = { ...DEFAULT_COLLAPSED, ...(await store.get('collapsed', {})) };
    rebuild();
    load();
    setInterval(load, POLL_MS);
    setInterval(watchDraft, 700);
    setInterval(() => { if (ui.open) render(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  })();
})();
