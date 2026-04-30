// ─── CONFIG ───────────────────────────────────────────
const NS_SUPABASE_URL = 'https://rayuxgfjmhmyblksmuta.supabase.co';
const NS_SUPABASE_KEY = 'sb_publishable_b07esV7lw3LZp2aq_pRKZg_BxlmudB3';
const NS_LOGIN_URL = '/login';
const NS_JOIN_URL = '/become-a-member';
const NS_PAID_GATE = 'ns-members'; // matches data-ms-content value
// ──────────────────────────────────────────────────────

(async function NormalSportAnnotations() {
  // ─── Feature flag ──────────────────────────────────
  // Annotations are only enabled when the URL has an "annotated" query param
  // (e.g. ?annotated). Bail early otherwise so no UI is injected and no
  // Supabase calls are made.
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('annotated')) return;
  } catch (e) {
    return;
  }

  // ─── Browser ID for like tracking ──────────────────
  function getBrowserId() {
    let id = null;
    try {
      id = localStorage.getItem('ns_browser_id');
    } catch (e) {}
    if (!id) {
      id = 'b_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        localStorage.setItem('ns_browser_id', id);
      } catch (e) {}
    }
    return id;
  }
  const BROWSER_ID = getBrowserId();

  // ─── Memberstack auth ──────────────────────────────
  let currentMember = null;

  async function loadMember() {
    try {
      if (
        window.$memberstackDom &&
        typeof window.$memberstackDom.getCurrentMember === 'function'
      ) {
        const res = await window.$memberstackDom.getCurrentMember();
        currentMember = (res && res.data) || null;
      } else if (
        window.MemberStack &&
        typeof window.MemberStack.onReady === 'object'
      ) {
        const m = await window.MemberStack.onReady;
        currentMember = m && m.loggedIn ? m : null;
      }
    } catch (e) {
      console.warn('[NS] Memberstack lookup failed:', e);
      currentMember = null;
    }
  }

  function isLoggedIn() {
    return !!currentMember;
  }

  function hasPaidAccess() {
    if (!currentMember) return false;

    // 1. Check Memberstack data: planConnections / permissions / contentGroups
    const planConnections = currentMember.planConnections || [];
    for (const pc of planConnections) {
      if (pc.status && pc.status !== 'ACTIVE' && pc.status !== 'TRIALING')
        continue;
      const groups = pc.contentGroups || pc.contentGroupIds || [];
      if (Array.isArray(groups)) {
        for (const g of groups) {
          const name = typeof g === 'string' ? g : g && (g.name || g.id);
          if (name === NS_PAID_GATE) return true;
        }
      }
    }
    const perms = currentMember.permissions || [];
    if (Array.isArray(perms) && perms.includes(NS_PAID_GATE)) return true;

    // 2. Fallback: trust Memberstack's own DOM gating. If a non-hidden
    //    element with data-ms-content="ns-members" exists, the member has access.
    const gated = document.querySelectorAll(
      '[data-ms-content="' + NS_PAID_GATE + '"]',
    );
    for (const el of gated) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') return true;
    }
    return false;
  }

  function memberId() {
    if (!currentMember) return null;
    return currentMember.id || currentMember.memberId || null;
  }

  function memberName() {
    if (!currentMember) return null;
    const cf = currentMember.customFields || {};
    const fullName = [cf['first-name'], cf['last-name']]
      .filter(Boolean)
      .join(' ');
    return (
      cf.name ||
      fullName ||
      cf['first-name'] ||
      currentMember.auth?.email ||
      currentMember.email ||
      'Member'
    );
  }

  async function refreshAuthAndUI() {
    const before = memberId();
    await loadMember();
    const after = memberId();
    applyAuthState();
    if (before !== after) renderAnnotations();
  }

  function watchForLogin(durationMs = 60000, intervalMs = 1000) {
    const start = Date.now();
    const tick = async () => {
      const wasLoggedIn = isLoggedIn();
      await refreshAuthAndUI();
      if (!wasLoggedIn && isLoggedIn()) return;
      if (Date.now() - start < durationMs) setTimeout(tick, intervalMs);
    };
    setTimeout(tick, intervalMs);
  }

  function redirectTo(url) {
    const returnTo =
      window.location.pathname + window.location.search + window.location.hash;
    const sep = url.includes('?') ? '&' : '?';
    window.location.href = url + sep + 'returnTo=' + encodeURIComponent(returnTo);
  }
  function openMemberstackLogin() { redirectTo(NS_LOGIN_URL); }
  function openJoinPage() { redirectTo(NS_JOIN_URL); }
  function promptForAccess() {
    if (!isLoggedIn()) openMemberstackLogin();
    else openJoinPage();
  }

  await loadMember();
  if (
    window.$memberstackDom &&
    typeof window.$memberstackDom.onAuthChange === 'function'
  ) {
    try {
      window.$memberstackDom.onAuthChange(() => refreshAuthAndUI());
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAuthAndUI();
  });
  window.addEventListener('focus', () => refreshAuthAndUI());

  // ─── Supabase helper with proper error handling ────
  async function supa(method, path, body) {
    const headers = {
      apikey: NS_SUPABASE_KEY,
      Authorization: 'Bearer ' + NS_SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    };
    let res;
    try {
      res = await fetch(NS_SUPABASE_URL + '/rest/v1/' + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      console.error('[NS] Network error on', method, path, err);
      throw new Error('Network error: ' + err.message);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('[NS] HTTP', res.status, 'on', method, path, '—', txt);
      throw new Error('Supabase ' + method + ' ' + path + ' ' + res.status);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // ─── Wrapper detection ─────────────────────────────
  const wrappers = document.querySelectorAll('.ns-annotatable');
  if (!wrappers.length) {
    console.warn(
      '[NS Annotations] No .ns-annotatable wrapper found. Aborting.',
    );
    return;
  }
  let wrapper = wrappers[0];
  let maxParas = wrapper.querySelectorAll('p').length;
  wrappers.forEach((w) => {
    const count = w.querySelectorAll('p').length;
    if (count > maxParas) {
      wrapper = w;
      maxParas = count;
    }
  });
  const slug = wrapper.dataset.newsletter || window.location.pathname;

  // ─── Hash-based paragraph IDs ──────────────────────
  function hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  const blockSelectors = 'p, h1, h2, h3, h4, h5, h6, blockquote, li';
  const seenHashes = {};

  function tagBlock(el) {
    if (el.dataset.pid) return el.dataset.pid;
    const text = (el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!text) return null;
    let hash = hashString(text);
    if (seenHashes[hash] != null) {
      seenHashes[hash] += 1;
      hash = hash + '-' + seenHashes[hash];
    } else {
      seenHashes[hash] = 0;
    }
    el.dataset.pid = 'h-' + hash;
    return el.dataset.pid;
  }

  function tagAllBlocks() {
    let count = 0;
    wrapper.querySelectorAll(blockSelectors).forEach((el) => {
      if (tagBlock(el)) count++;
    });
    return count;
  }

  // ─── State ─────────────────────────────────────────
  let pending = null;
  let allAnnotations = [];
  const likedAnnotations = new Set();
  const pendingDeletes = new Map();

  // ─── Helpers ───────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  }

  function formatTime(d) {
    return d
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      .replace(/\s?([AP]M)$/i, (_, p) => ' ' + p.toUpperCase());
  }

  function formatRelativeDate(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfDate = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
    );
    const dayDiff = Math.round(
      (startOfToday - startOfDate) / 86400000,
    );

    if (dayDiff <= 0) return 'Today ' + formatTime(d);
    if (dayDiff === 1) return 'Yesterday ' + formatTime(d);
    if (dayDiff <= 6) return dayDiff + ' days ago';

    const weekDiff = Math.floor(dayDiff / 7);
    if (weekDiff <= 4) return weekDiff + (weekDiff === 1 ? ' Week Ago' : ' Weeks Ago');

    let monthDiff =
      (now.getFullYear() - d.getFullYear()) * 12 +
      (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) monthDiff -= 1;
    if (monthDiff < 1) monthDiff = 1;
    if (monthDiff <= 12) return monthDiff + (monthDiff === 1 ? ' Month Ago' : ' Months Ago');

    return 'Over a year ago';
  }

  // ─── Inject styles ─────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ns-highlight { background: #ff869033; border-bottom: 1.5px solid #ff8690; cursor: pointer; color: #484037; padding: 1px 2px; transition: background 0.15s; }
    .ns-highlight:hover, .ns-highlight.ns-active { background: #ff869066; }
    .ns-badge { display: inline-flex; align-items: center; justify-content: center; background: #ff8690; color: #5f2126; border: 1px solid #5f2126; font-size: 10px; font-weight: 600; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 10px; vertical-align: super; margin-left: 3px; cursor: pointer; line-height: 100%; transition: transform 0.15s; }
    .ns-badge:hover { transform: scale(1.15); }
    .ns-annotatable.ns-highlights-hidden .ns-highlight { background: transparent; border-bottom: none; color: inherit; padding: 0; cursor: text; }
    .ns-annotatable.ns-highlights-hidden .ns-badge { display: none; }
    #ns-toolbar { position: fixed; display: none; gap: 4px; background: #fffdfb; border: 1px solid #484037; border-radius: 40px; padding: 4px; z-index: 9999; transform: translateX(-50%); box-shadow: 0 4px 12px #48403726; }
    #ns-toolbar.ns-visible { display: flex; }
    .ns-toolbar-btn { background: #ff8690; border: 1px solid #5f2126; color: #5f2126; font-family: inherit; font-size: 13px; font-weight: 500; padding: 8px 16px; border-radius: 40px; cursor: pointer; line-height: 100%; }
    .ns-toolbar-btn.secondary { background: transparent; border-color: #484037; color: #484037; }
    #ns-fab { position: fixed; bottom: 20px; right: 20px; background: #ff8690; color: #5f2126; border: 1px solid #5f2126; font-family: inherit; font-size: 14px; font-weight: 500; padding: 12px 20px; border-radius: 40px; display: none; align-items: center; gap: 8px; cursor: pointer; z-index: 9999; opacity: 0; transform: translateY(20px) scale(0.95); transition: opacity 0.2s, transform 0.2s cubic-bezier(0.34,1.56,0.64,1); box-shadow: 0 4px 16px #48403740; }
    #ns-fab.ns-visible { display: flex; opacity: 1; transform: translateY(0) scale(1); }
    @media (hover: none) and (pointer: coarse) { #ns-toolbar { display: none !important; } }
    @media (hover: hover) and (pointer: fine) { #ns-fab { display: none !important; } }
    #ns-modal-overlay { position: fixed; inset: 0; background: #48403780; z-index: 9998; display: none; align-items: center; justify-content: center; padding: 16px; }
    #ns-modal-overlay.ns-visible { display: flex; }
    #ns-modal { background: #fffdfb; border: 1px solid #484037; border-radius: 24px; width: 100%; max-width: 520px; padding: 32px 28px; box-shadow: 0 20px 60px #48403740; }
    #ns-modal .ns-label { font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #ff8690; font-weight: 600; margin-bottom: 12px; }
    #ns-modal-quote { background: #ff869033; border-left: 2px solid #ff8690; padding: 12px 16px; font-style: italic; font-size: 15px; line-height: 140%; color: #5f2126; margin-bottom: 20px; border-radius: 0 12px 12px 0; max-height: 80px; overflow: hidden; }
    #ns-modal label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; color: #675b4e; margin-bottom: 8px; }
    #ns-modal input, #ns-modal textarea { width: 100%; border: 1px solid #484037; background: #fff7ee; padding: 12px 16px; font-family: inherit; font-size: 15px; color: #484037; border-radius: 12px; outline: none; margin-bottom: 16px; line-height: 150%; resize: vertical; box-sizing: border-box; }
    #ns-modal input:focus, #ns-modal textarea:focus { border-color: #5f2126; }
    .ns-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .ns-btn-cancel, .ns-btn-submit { font-family: inherit; font-size: 14px; font-weight: 500; padding: 10px 20px; border-radius: 40px; cursor: pointer; border: 1px solid #484037; line-height: 100%; }
    .ns-btn-cancel { background: transparent; color: #484037; }
    .ns-btn-submit { background: #ff8690; color: #5f2126; border-color: #5f2126; }
    .ns-btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
    #ns-panel { position: fixed; top: 0; right: -400px; width: 380px; height: 100vh; background: #fff7ee; border-left: 1px solid #484037; z-index: 9997; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; touch-action: pan-y; padding: 24px; transition: right 0.35s cubic-bezier(0.4,0,0.2,1); font-family: inherit; box-sizing: border-box; }
    #ns-panel.ns-open { right: 0; }
    #ns-panel-toggle { position: fixed; top: 50%; right: 0; background: #fffdfb; color: #484037; border: 1px solid #484037; border-right: none; padding: 16px 8px; cursor: pointer; z-index: 9996; font-family: inherit; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; writing-mode: vertical-rl; transform: translateY(-50%); transition: right 0.35s cubic-bezier(0.4,0,0.2,1); display: flex; align-items: center; gap: 8px; border-radius: 16px 0 0 16px; }
    #ns-panel-toggle.ns-panel-open { right: 380px; }
    .ns-toggle-badge { display: inline-flex; align-items: center; justify-content: center; background: #ff8690; color: #5f2126; border: 1px solid #5f2126; font-size: 10px; font-weight: 600; padding: 2px 6px; min-width: 18px; box-sizing: border-box; letter-spacing: 0; text-indent: 0; border-radius: 10px; writing-mode: horizontal-tb; line-height: 100%; }
    .ns-toggle-badge[data-count="0"] { display: none; }
    .ns-panel-close { background: transparent; border: 1px solid #484037; color: #484037; width: 28px; height: 28px; border-radius: 14px; font-size: 16px; cursor: pointer; line-height: 1; float: right; }
    .ns-panel-title { font-size: 12px; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; color: #675b4e; margin-bottom: 16px; }

    .ns-highlight-toggle { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #48403726; cursor: pointer; user-select: none; }
    .ns-highlight-toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .ns-toggle-slider { position: relative; width: 32px; height: 18px; background: #48403733; border-radius: 9px; flex-shrink: 0; transition: background 0.2s; }
    .ns-toggle-slider::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: #fffdfb; border-radius: 50%; transition: transform 0.2s; box-shadow: 0 1px 2px #48403740; }
    .ns-highlight-toggle input:checked + .ns-toggle-slider { background: #ff8690; }
    .ns-highlight-toggle input:checked + .ns-toggle-slider::after { transform: translateX(14px); }
    .ns-highlight-toggle input:focus-visible + .ns-toggle-slider { outline: 2px solid #9ed5fe; outline-offset: 2px; }
    .ns-toggle-label { font-size: 13px; color: #484037; font-weight: 500; }

    .ns-card { border: 1px solid #484037; background: #fffdfb; border-radius: 16px; margin-bottom: 12px; cursor: pointer; overflow: hidden; transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s; animation: ns-slidein 0.25s ease; }
    .ns-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px #48403726; }
    .ns-card.ns-focused { border-color: #5f2126; box-shadow: 0 0 0 3px #ff869040, 0 6px 16px #48403726; transform: translateY(-2px); }
    .ns-card.ns-focused .ns-card-quote { background: #ff869055; }
    @keyframes ns-slidein { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .ns-card-quote { background: #ff869033; border-left: 2px solid #ff8690; padding: 10px 14px; font-size: 13px; font-style: italic; color: #5f2126; line-height: 140%; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; position: relative; }
    .ns-card-quote:not(.ns-expanded)::after { content: ""; position: absolute; left: 2px; right: 0; bottom: 0; height: 0.8em; background: linear-gradient(to bottom, rgba(255,134,144,0) 0%, rgba(255,218,221,0.95) 70%, rgba(255,218,221,1) 100%); pointer-events: none; }
    .ns-card-quote.ns-expanded { -webkit-line-clamp: unset; display: block; }
    .ns-quote-toggle { display: block; background: #ff869033; border: none; border-left: 2px solid #ff8690; padding: 6px 14px 10px; margin: 0; font-family: inherit; font-size: 12px; font-weight: 600; color: #5f2126; cursor: pointer; line-height: 1.3; text-align: left; width: 100%; }
    .ns-quote-toggle:hover { color: #484037; }
    .ns-card-body { padding: 14px; font-size: 14px; color: #484037; line-height: 150%; }
    .ns-card-footer { padding: 10px 14px; border-top: 1px solid #48403726; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .ns-card-footer-author { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .ns-card-footer-author .ns-author { font-size: 13px; font-weight: 600; color: #484037; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ns-card-footer-author .ns-date { font-size: 11px; color: #675b4e; line-height: 1.2; }
    .ns-card-footer-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

    .ns-action-btn { background: transparent; border: none; color: #675b4e; font-family: inherit; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; line-height: 100%; }
    .ns-action-btn:hover { background: #48403712; color: #484037; }
    .ns-action-btn svg { width: 14px; height: 14px; stroke-width: 2; }
    .ns-action-btn.ns-liked { color: #5f2126; }
    .ns-action-btn.ns-liked svg { fill: #ff8690; stroke: #5f2126; }
    .ns-action-btn.ns-delete-btn:hover { background: #ff869033; color: #5f2126; }
    .ns-action-btn.ns-delete-btn.ns-confirming { background: #ff8690; color: #5f2126; border: 1px solid #5f2126; }

    .ns-replies-toggle { width: 100%; background: transparent; border: none; border-top: 1px solid #48403726; color: #675b4e; font-family: inherit; font-size: 12px; font-weight: 500; padding: 10px 14px; cursor: pointer; display: flex; align-items: center; gap: 6px; text-align: left; transition: background 0.15s, color 0.15s; }
    .ns-replies-toggle:hover { background: #48403712; color: #484037; }
    .ns-replies-toggle svg { width: 12px; height: 12px; transition: transform 0.2s; }
    .ns-replies-toggle.ns-open svg { transform: rotate(90deg); }
    .ns-replies { border-top: 1px solid #48403726; background: #f5ead9; display: none; }
    .ns-replies.ns-open { display: block; }
    .ns-reply { padding: 10px 14px 10px 28px; border-bottom: 1px solid #48403714; position: relative; }
    .ns-reply:last-child { border-bottom: none; }
    .ns-reply::before { content: ""; position: absolute; left: 14px; top: 18px; width: 8px; height: 1px; background: #675b4e; opacity: 0.4; }
    .ns-reply-author { font-size: 12px; font-weight: 600; color: #484037; margin-bottom: 3px; }
    .ns-reply-date { font-weight: 400; color: #675b4e; margin-left: 6px; }
    .ns-reply-text { font-size: 13px; line-height: 145%; color: #484037; }

    .ns-reply-form { padding: 10px 14px; border-top: 1px solid #48403726; background: #fff7ee; display: none; }
    .ns-reply-form.ns-open { display: block; }
    .ns-reply-form input, .ns-reply-form textarea { width: 100%; border: 1px solid #484037; background: #fffdfb; padding: 8px 12px; font-family: inherit; font-size: 13px; color: #484037; border-radius: 10px; outline: none; margin-bottom: 8px; resize: none; box-sizing: border-box; }
    .ns-reply-form input { height: 34px; }
    .ns-reply-form textarea { line-height: 140%; min-height: 60px; }
    .ns-reply-form input:focus, .ns-reply-form textarea:focus { border-color: #5f2126; }
    .ns-reply-form-actions { display: flex; gap: 6px; justify-content: flex-end; }
    .ns-reply-btn-cancel, .ns-reply-btn-submit { font-family: inherit; font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 20px; cursor: pointer; border: 1px solid #484037; line-height: 100%; }
    .ns-reply-btn-cancel { background: transparent; color: #484037; }
    .ns-reply-btn-submit { background: #ff8690; color: #5f2126; border-color: #5f2126; }

    .ns-signin-prompt { padding: 14px; margin: 0 0 12px; background: #fffdfb; border: 1px dashed #484037; border-radius: 12px; font-size: 13px; color: #484037; line-height: 145%; text-align: center; }
    .ns-signin-prompt button { background: #ff8690; color: #5f2126; border: 1px solid #5f2126; font-family: inherit; font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 20px; cursor: pointer; margin-top: 8px; line-height: 100%; }
    .ns-locked-msg { font-size: 12px; color: #675b4e; padding: 10px 14px; border-top: 1px solid #48403726; }
    .ns-locked-msg a { color: #5f2126; cursor: pointer; text-decoration: underline; font-weight: 600; }
    .ns-action-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  // ─── Build toolbar ─────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.id = 'ns-toolbar';
  const annotateBtn = document.createElement('button');
  annotateBtn.className = 'ns-toolbar-btn';
  annotateBtn.textContent = '✎ Annotate';
  toolbar.appendChild(annotateBtn);
  const viewBtn = document.createElement('button');
  viewBtn.className = 'ns-toolbar-btn secondary';
  viewBtn.textContent = 'View all';
  toolbar.appendChild(viewBtn);
  document.body.appendChild(toolbar);

  // ─── Mobile FAB ────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'ns-fab';
  fab.textContent = '✎ Annotate';
  document.body.appendChild(fab);

  const isTouch = window.matchMedia(
    '(hover: none) and (pointer: coarse)',
  ).matches;

  // ─── Modal ─────────────────────────────────────────
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'ns-modal-overlay';
  const modalBox = document.createElement('div');
  modalBox.id = 'ns-modal';
  const modalLabel = document.createElement('div');
  modalLabel.className = 'ns-label';
  modalLabel.textContent = 'Annotating';
  modalBox.appendChild(modalLabel);
  const modalQuote = document.createElement('div');
  modalQuote.id = 'ns-modal-quote';
  modalBox.appendChild(modalQuote);
  const textLabel = document.createElement('label');
  textLabel.textContent = 'Your annotation';
  modalBox.appendChild(textLabel);
  const textArea = document.createElement('textarea');
  textArea.placeholder = "What's your take on this?";
  textArea.rows = 4;
  textArea.maxLength = 600;
  modalBox.appendChild(textArea);
  const modalActions = document.createElement('div');
  modalActions.className = 'ns-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ns-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  modalActions.appendChild(cancelBtn);
  const submitBtn = document.createElement('button');
  submitBtn.className = 'ns-btn-submit';
  submitBtn.textContent = 'Publish →';
  modalActions.appendChild(submitBtn);
  modalBox.appendChild(modalActions);
  modalOverlay.appendChild(modalBox);
  document.body.appendChild(modalOverlay);

  // ─── Panel ─────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'ns-panel';
  const panelClose = document.createElement('button');
  panelClose.className = 'ns-panel-close';
  panelClose.textContent = '×';
  panel.appendChild(panelClose);
  const panelTitle = document.createElement('div');
  panelTitle.className = 'ns-panel-title';
  panelTitle.textContent = 'Annotations ';
  const panelBadgeCount = document.createElement('span');
  panelTitle.appendChild(panelBadgeCount);
  panel.appendChild(panelTitle);

  // Highlight toggle
  const highlightToggleWrap = document.createElement('label');
  highlightToggleWrap.className = 'ns-highlight-toggle';
  const highlightToggleInput = document.createElement('input');
  highlightToggleInput.type = 'checkbox';
  highlightToggleInput.checked = false;
  const highlightToggleSlider = document.createElement('span');
  highlightToggleSlider.className = 'ns-toggle-slider';
  const highlightToggleLabel = document.createElement('span');
  highlightToggleLabel.className = 'ns-toggle-label';
  highlightToggleLabel.textContent = 'Show highlights in article';
  highlightToggleWrap.appendChild(highlightToggleInput);
  highlightToggleWrap.appendChild(highlightToggleSlider);
  highlightToggleWrap.appendChild(highlightToggleLabel);
  panel.appendChild(highlightToggleWrap);

  // Restore preference from localStorage (default off)
  try {
    const stored = localStorage.getItem('ns_show_highlights');
    if (stored === 'true') {
      highlightToggleInput.checked = true;
    } else {
      wrapper.classList.add('ns-highlights-hidden');
    }
  } catch (e) {
    wrapper.classList.add('ns-highlights-hidden');
  }

  highlightToggleInput.addEventListener('change', () => {
    const on = highlightToggleInput.checked;
    wrapper.classList.toggle('ns-highlights-hidden', !on);
    try {
      localStorage.setItem('ns_show_highlights', on ? 'true' : 'false');
    } catch (e) {}
  });

  const panelList = document.createElement('div');
  panel.appendChild(panelList);
  document.body.appendChild(panel);

  // ─── Panel toggle tab ──────────────────────────────
  const panelToggle = document.createElement('button');
  panelToggle.id = 'ns-panel-toggle';
  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = 'Loading...';
  panelToggle.appendChild(toggleLabel);
  const toggleBadge = document.createElement('span');
  toggleBadge.className = 'ns-toggle-badge';
  toggleBadge.dataset.count = '0';
  toggleBadge.textContent = '0';
  toggleBadge.style.display = 'none';
  panelToggle.appendChild(toggleBadge);
  document.body.appendChild(panelToggle);

  function openPanel() {
    panel.classList.add('ns-open');
    panelToggle.classList.add('ns-panel-open');
  }
  function closePanel() {
    panel.classList.remove('ns-open');
    panelToggle.classList.remove('ns-panel-open');
  }
  function togglePanel() {
    panel.classList.contains('ns-open') ? closePanel() : openPanel();
  }
  panelToggle.addEventListener('click', togglePanel);
  panelClose.addEventListener('click', closePanel);

  function updateToggleBadge() {
    const n = allAnnotations.length;
    toggleLabel.textContent = 'Annotations';
    toggleBadge.textContent = n;
    toggleBadge.dataset.count = n;
    toggleBadge.style.display = '';
  }

  // ─── Selection handling ────────────────────────────
  let selTimer = null;
  function handleSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(processSelection, isTouch ? 350 : 10);
  }
  function processSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideSelectionUI();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 5) {
      hideSelectionUI();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!wrapper.contains(range.commonAncestorContainer)) {
      hideSelectionUI();
      return;
    }

    const blockTags = new Set([
      'P',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'BLOCKQUOTE',
      'LI',
    ]);
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;
    let para = null;
    while (node && node !== wrapper) {
      if (blockTags.has(node.tagName)) {
        para = node;
        break;
      }
      node = node.parentElement;
    }
    if (!para) {
      hideSelectionUI();
      return;
    }
    const pid = tagBlock(para);
    if (!pid) {
      hideSelectionUI();
      return;
    }

    pending = { text, paragraphId: pid };
    if (isTouch) {
      fab.classList.add('ns-visible');
    } else {
      const rect = range.getBoundingClientRect();
      let top = rect.top - 56;
      if (top < 8) top = rect.bottom + 8;
      toolbar.style.left = rect.left + rect.width / 2 + 'px';
      toolbar.style.top = top + 'px';
      toolbar.classList.add('ns-visible');
    }
  }
  document.addEventListener('selectionchange', handleSelection);
  document.addEventListener('mousedown', (e) => {
    if (
      !toolbar.contains(e.target) &&
      !modalOverlay.contains(e.target) &&
      !fab.contains(e.target)
    ) {
      hideSelectionUI();
    }
  });
  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (!isTouch) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideSelectionUI();
      }, 150);
    },
    { passive: true },
  );
  function hideSelectionUI() {
    toolbar.classList.remove('ns-visible');
    fab.classList.remove('ns-visible');
  }

  // ─── Compose ───────────────────────────────────────
  function openCompose() {
    if (!pending) return;
    if (!hasPaidAccess()) {
      hideSelectionUI();
      promptForAccess();
      return;
    }
    hideSelectionUI();
    modalQuote.textContent = '"' + pending.text + '"';
    textArea.value = '';
    modalOverlay.classList.add('ns-visible');
    if (!isTouch) textArea.focus();
    window.getSelection()?.removeAllRanges();
  }
  function applyAuthState() {
    const paid = hasPaidAccess();
    const label = paid
      ? '✎ Annotate'
      : isLoggedIn()
        ? '✎ Join the Normal Club to post'
        : '✎ Log in to post';
    annotateBtn.textContent = label;
    fab.textContent = label;
  }
  applyAuthState();

  annotateBtn.addEventListener('click', openCompose);
  fab.addEventListener('click', openCompose);
  viewBtn.addEventListener('click', () => {
    hideSelectionUI();
    openPanel();
  });
  cancelBtn.addEventListener('click', () => {
    modalOverlay.classList.remove('ns-visible');
    pending = null;
  });
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.classList.remove('ns-visible');
      pending = null;
    }
  });

  submitBtn.addEventListener('click', async () => {
    const text = textArea.value.trim();
    if (!text || !pending) return;
    if (!hasPaidAccess()) {
      promptForAccess();
      return;
    }
    const author = memberName();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
    try {
      const rows = await supa('POST', 'annotations', {
        newsletter_slug: slug,
        paragraph_id: pending.paragraphId,
        selected_text: pending.text,
        annotation_text: text,
        author_name: author,
        member_id: memberId(),
        likes: 0,
      });
      if (Array.isArray(rows) && rows[0]) {
        allAnnotations.push({ ...rows[0], replies: [] });
        renderAnnotations();
        applyHighlights();
        updateToggleBadge();
      }
    } catch (err) {
      console.error('[NS] Save failed:', err);
      alert('Failed to save annotation. Please try again.');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publish →';
    modalOverlay.classList.remove('ns-visible');
    pending = null;
    openPanel();
  });

  // ─── Like ──────────────────────────────────────────
  function updateLikeButton(annId) {
    const ann = allAnnotations.find((a) => a.id === annId);
    if (!ann) return;
    const btn = panel.querySelector('[data-like-btn="' + annId + '"]');
    if (!btn) return;
    const liked = likedAnnotations.has(annId);
    btn.classList.toggle('ns-liked', liked);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
    const count = btn.querySelector('span');
    if (count) count.textContent = ann.likes || 0;
  }

  async function toggleLike(annId) {
    if (!hasPaidAccess()) {
      promptForAccess();
      return;
    }
    const ann = allAnnotations.find((a) => a.id === annId);
    if (!ann) return;
    const wasLiked = likedAnnotations.has(annId);
    if (wasLiked) {
      likedAnnotations.delete(annId);
      ann.likes = Math.max(0, ann.likes - 1);
    } else {
      likedAnnotations.add(annId);
      ann.likes += 1;
    }
    updateLikeButton(annId);
    const mid = memberId();
    try {
      if (wasLiked) {
        await supa(
          'DELETE',
          'annotation_likes?annotation_id=eq.' +
            encodeURIComponent(annId) +
            '&member_id=eq.' +
            encodeURIComponent(mid),
        );
      } else {
        await supa('POST', 'annotation_likes', {
          annotation_id: annId,
          member_id: mid,
          browser_id: BROWSER_ID,
        });
      }
      await supa('PATCH', 'annotations?id=eq.' + encodeURIComponent(annId), {
        likes: ann.likes,
      });
    } catch (err) {
      console.warn('[NS] Like sync failed:', err);
    }
  }

  // ─── Delete ────────────────────────────────────────
  function deleteAnnotation(annId, btnEl) {
    const ann = allAnnotations.find((a) => a.id === annId);
    const mid = memberId();
    if (!ann || !mid || ann.member_id !== mid) {
      if (!isLoggedIn()) openMemberstackLogin();
      return;
    }
    if (pendingDeletes.has(annId)) {
      clearTimeout(pendingDeletes.get(annId));
      pendingDeletes.delete(annId);
      allAnnotations = allAnnotations.filter((a) => a.id !== annId);
      likedAnnotations.delete(annId);
      (async () => {
        try {
          await supa(
            'DELETE',
            'annotations?id=eq.' + encodeURIComponent(annId),
          );
        } catch (err) {
          console.warn('[NS] Delete sync failed:', err);
        }
      })();
      const card = btnEl.closest('.ns-card');
      if (card) {
        card.style.transition = 'opacity 0.2s, transform 0.2s';
        card.style.opacity = '0';
        card.style.transform = 'translateX(-12px)';
        setTimeout(() => {
          renderAnnotations();
          applyHighlights();
          updateToggleBadge();
        }, 180);
      }
      return;
    }
    btnEl.classList.add('ns-confirming');
    const span = document.createElement('span');
    span.textContent = 'Confirm?';
    span.style.marginLeft = '4px';
    btnEl.appendChild(span);
    const timer = setTimeout(() => {
      btnEl.classList.remove('ns-confirming');
      if (span.parentNode === btnEl) btnEl.removeChild(span);
      pendingDeletes.delete(annId);
    }, 3000);
    pendingDeletes.set(annId, timer);
  }

  // ─── Reply form ────────────────────────────────────
  function toggleReplyForm(annId) {
    if (!hasPaidAccess()) {
      promptForAccess();
      return;
    }
    const form = panel.querySelector('[data-reply-form="' + annId + '"]');
    if (!form) return;
    const wasOpen = form.classList.contains('ns-open');
    panel
      .querySelectorAll('.ns-reply-form.ns-open')
      .forEach((f) => f.classList.remove('ns-open'));
    if (!wasOpen) {
      form.classList.add('ns-open');
      form.querySelector('textarea').focus();
    }
  }

  function cancelReply(annId) {
    const form = panel.querySelector('[data-reply-form="' + annId + '"]');
    if (!form) return;
    form.classList.remove('ns-open');
    const ti = form.querySelector('textarea');
    if (ti) ti.value = '';
  }

  function toggleReplies(annId) {
    const container = panel.querySelector('[data-replies="' + annId + '"]');
    const tog = panel.querySelector('[data-replies-toggle="' + annId + '"]');
    if (!container || !tog) return;
    const isOpen = container.classList.toggle('ns-open');
    tog.classList.toggle('ns-open', isOpen);
    const ann = allAnnotations.find((a) => a.id === annId);
    const count = ann ? ann.replies.length : 0;
    const label = tog.querySelector('span');
    if (label) {
      label.textContent = isOpen
        ? 'Hide ' + count + ' ' + (count === 1 ? 'reply' : 'replies')
        : 'Show ' + count + ' ' + (count === 1 ? 'reply' : 'replies');
    }
  }

  async function submitReply(annId) {
    if (!hasPaidAccess()) {
      promptForAccess();
      return;
    }
    const form = panel.querySelector('[data-reply-form="' + annId + '"]');
    if (!form) return;
    const textIn = form.querySelector('textarea');
    const text = textIn.value.trim();
    const author = memberName();
    if (!text) return;
    const ann = allAnnotations.find((a) => a.id === annId);
    if (!ann) return;
    const sBtn = form.querySelector('.ns-reply-btn-submit');
    sBtn.disabled = true;
    sBtn.textContent = 'Saving...';
    let reply;
    try {
      const rows = await supa('POST', 'annotation_replies', {
        annotation_id: annId,
        reply_text: text,
        author_name: author,
        member_id: memberId(),
      });
      if (!Array.isArray(rows) || !rows[0]) throw new Error('no row');
      reply = rows[0];
    } catch (err) {
      console.error('[NS] Reply save failed:', err);
      alert('Failed to save reply. Please try again.');
      sBtn.disabled = false;
      sBtn.textContent = 'Reply →';
      return;
    }
    ann.replies.push(reply);
    sBtn.disabled = false;
    sBtn.textContent = 'Reply →';

    const card = form.closest('.ns-card');
    let repliesContainer = card.querySelector('[data-replies="' + annId + '"]');
    let togBtn = card.querySelector('[data-replies-toggle="' + annId + '"]');

    if (!repliesContainer) {
      togBtn = document.createElement('button');
      togBtn.className = 'ns-replies-toggle ns-open';
      togBtn.dataset.repliesToggle = annId;
      togBtn.onclick = (e) => {
        e.stopPropagation();
        toggleReplies(annId);
      };
      togBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>' +
        '<span>Hide 1 reply</span>';
      repliesContainer = document.createElement('div');
      repliesContainer.className = 'ns-replies ns-open';
      repliesContainer.dataset.replies = annId;
      card.insertBefore(togBtn, form);
      card.insertBefore(repliesContainer, form);
    } else {
      const isOpen = repliesContainer.classList.contains('ns-open');
      const count = ann.replies.length;
      const label = togBtn.querySelector('span');
      if (label) {
        label.textContent = isOpen
          ? 'Hide ' + count + ' ' + (count === 1 ? 'reply' : 'replies')
          : 'Show ' + count + ' ' + (count === 1 ? 'reply' : 'replies');
      }
    }

    const replyEl = document.createElement('div');
    replyEl.className = 'ns-reply';
    replyEl.innerHTML =
      '<div class="ns-reply-author">' +
      escapeHtml(reply.author_name) +
      '<span class="ns-reply-date">· ' +
      escapeHtml(formatRelativeDate(reply.created_at)) +
      '</span></div>' +
      '<div class="ns-reply-text">' +
      escapeHtml(reply.reply_text) +
      '</div>';
    repliesContainer.appendChild(replyEl);

    const replyBtnLabel = card.querySelector(
      '[data-reply-btn="' + annId + '"] span',
    );
    if (replyBtnLabel)
      replyBtnLabel.textContent = 'Reply · ' + ann.replies.length;

    nameIn.value = '';
    textIn.value = '';
    form.classList.remove('ns-open');
  }

  // ─── Click-to-focus ────────────────────────────────
  function focusAnnotationsForParagraph(pid) {
    panel
      .querySelectorAll('.ns-card.ns-focused')
      .forEach((c) => c.classList.remove('ns-focused'));
    const ids = allAnnotations
      .filter((a) => a.paragraph_id === pid)
      .map((a) => a.id);
    if (!ids.length) return;
    setTimeout(() => {
      const firstCard = panel.querySelector(
        '[data-annotation-id="' + ids[0] + '"]',
      );
      ids.forEach((id) => {
        const card = panel.querySelector('[data-annotation-id="' + id + '"]');
        if (card) card.classList.add('ns-focused');
      });
      if (firstCard)
        firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        ids.forEach((id) => {
          const card = panel.querySelector('[data-annotation-id="' + id + '"]');
          if (card) card.classList.remove('ns-focused');
        });
      }, 2400);
    }, 100);
  }

  // ─── Highlights ────────────────────────────────────
  function applyHighlights() {
    wrapper.querySelectorAll('.ns-highlight').forEach((el) => {
      const p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
      p.normalize();
    });
    wrapper.querySelectorAll('.ns-badge').forEach((el) => el.remove());

    const byPara = {};
    allAnnotations.forEach((a) => {
      (byPara[a.paragraph_id] = byPara[a.paragraph_id] || []).push(a);
    });

    Object.entries(byPara).forEach(([pid, anns]) => {
      const para = wrapper.querySelector('[data-pid="' + pid + '"]');
      if (!para) return;

      const target = anns[0].selected_text;
      const count = anns.length;

      const textNodes = [];
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      let fullText = '';
      const posMap = [];
      for (const tn of textNodes) {
        for (let i = 0; i < tn.nodeValue.length; i++)
          posMap.push({ node: tn, offset: i });
        fullText += tn.nodeValue;
      }

      const normalize = (s) => {
        let out = '';
        const origIdx = [];
        let prev = false;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (/\s/.test(ch)) {
            if (!prev && out.length > 0) {
              out += ' ';
              origIdx.push(i);
            }
            prev = true;
          } else {
            out += ch;
            origIdx.push(i);
            prev = false;
          }
        }
        while (out.endsWith(' ')) {
          out = out.slice(0, -1);
          origIdx.pop();
        }
        return { norm: out, origIdx };
      };

      const { norm: nF, origIdx: fMap } = normalize(fullText);
      const { norm: nT } = normalize(target);
      const nIdx = nF.indexOf(nT);
      if (nIdx === -1) {
        console.warn('[NS] Could not locate selected_text in paragraph:', pid);
        return;
      }
      const sIdx = fMap[nIdx];
      const eIdx = fMap[nIdx + nT.length - 1] + 1;
      if (sIdx == null || eIdx == null) return;
      if (!posMap[sIdx] || !posMap[eIdx - 1]) return;

      const range = document.createRange();
      range.setStart(posMap[sIdx].node, posMap[sIdx].offset);
      range.setEnd(posMap[eIdx - 1].node, posMap[eIdx - 1].offset + 1);

      const mark = document.createElement('mark');
      mark.className = 'ns-highlight';
      mark.dataset.pid = pid;

      try {
        range.surroundContents(mark);
      } catch (e) {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }

      const badge = document.createElement('sup');
      badge.className = 'ns-badge';
      badge.dataset.pid = pid;
      badge.textContent = count;
      mark.parentNode.insertBefore(badge, mark.nextSibling);

      [mark, badge].forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openPanel();
          focusAnnotationsForParagraph(pid);
        });
      });
    });
  }

  // ─── Render annotations panel ──────────────────────
  function addQuoteToggles() {
    panel.querySelectorAll('.ns-card-quote').forEach((q) => {
      if (
        q.nextElementSibling &&
        q.nextElementSibling.classList.contains('ns-quote-toggle')
      )
        return;
      if (q.scrollHeight - q.clientHeight > 1) {
        const btn = document.createElement('button');
        btn.className = 'ns-quote-toggle';
        btn.type = 'button';
        btn.textContent = 'Show more';
        btn.onclick = (e) => {
          e.stopPropagation();
          const expanded = q.classList.toggle('ns-expanded');
          btn.textContent = expanded ? 'Show less' : 'Show more';
        };
        q.insertAdjacentElement('afterend', btn);
      }
    });
  }

  function renderAnnotations(filterPid = null) {
    const shown = filterPid
      ? allAnnotations.filter((a) => a.paragraph_id === filterPid)
      : allAnnotations;
    panelBadgeCount.textContent = '(' + allAnnotations.length + ')';

    const signinPromptHtml = !hasPaidAccess()
      ? '<div class="ns-signin-prompt">' +
        (isLoggedIn()
          ? 'Join the Normal Club to post.' +
            '<br><button type="button" data-ns-signin>Join</button>'
          : 'Log in to post.' +
            '<br><button type="button" data-ns-signin>Log in</button>') +
        '</div>'
      : '';

    if (!shown.length) {
      panelList.innerHTML =
        signinPromptHtml +
        '<p style="color:#675b4e;font-size:14px;text-align:center;padding:2rem 0">' +
        (filterPid
          ? 'No annotations on this paragraph yet.'
          : hasPaidAccess()
            ? 'No annotations yet. Highlight text to start.'
            : 'No annotations yet.') +
        '</p>';
      panelList.querySelectorAll('[data-ns-signin]').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          promptForAccess();
        });
      });
      return;
    }

    const mid = memberId();
    panelList.innerHTML =
      signinPromptHtml +
      shown
        .map((a) => {
          const liked = likedAnnotations.has(a.id);
          const aid = String(a.id);
          const isOwner = mid && a.member_id && a.member_id === mid;
          const repliesHtml =
            a.replies && a.replies.length
              ? '<button class="ns-replies-toggle" data-replies-toggle="' +
                escapeHtml(aid) +
                '">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>' +
                '<span>Show ' +
                a.replies.length +
                ' ' +
                (a.replies.length === 1 ? 'reply' : 'replies') +
                '</span>' +
                '</button>' +
                '<div class="ns-replies" data-replies="' +
                escapeHtml(aid) +
                '">' +
                a.replies
                  .map(
                    (r) =>
                      '<div class="ns-reply">' +
                      '<div class="ns-reply-author">' +
                      escapeHtml(r.author_name) +
                      '<span class="ns-reply-date">· ' +
                      escapeHtml(formatRelativeDate(r.created_at)) +
                      '</span>' +
                      '</div>' +
                      '<div class="ns-reply-text">' +
                      escapeHtml(r.reply_text) +
                      '</div>' +
                      '</div>',
                  )
                  .join('') +
                '</div>'
              : '';

          return (
            '<div class="ns-card" data-annotation-id="' +
            escapeHtml(aid) +
            '">' +
            '<div class="ns-card-quote">"' +
            escapeHtml(a.selected_text) +
            '"</div>' +
            '<div class="ns-card-body">' +
            escapeHtml(a.annotation_text) +
            '</div>' +
            '<div class="ns-card-footer">' +
            '<div class="ns-card-footer-author">' +
            '<span class="ns-author">' +
            escapeHtml(a.author_name) +
            '</span>' +
            '<span class="ns-date">' +
            escapeHtml(formatRelativeDate(a.created_at)) +
            '</span>' +
            '</div>' +
            '<div class="ns-card-footer-actions">' +
            '<button class="ns-action-btn' +
            (liked ? ' ns-liked' : '') +
            '" data-like-btn="' +
            escapeHtml(aid) +
            '" aria-label="Like">' +
            '<svg viewBox="0 0 24 24" fill="' +
            (liked ? 'currentColor' : 'none') +
            '" stroke="currentColor">' +
            '<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>' +
            '</svg>' +
            '<span>' +
            (a.likes || 0) +
            '</span>' +
            '</button>' +
            '<button class="ns-action-btn" data-reply-btn="' +
            escapeHtml(aid) +
            '" aria-label="Reply">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
            '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>' +
            '</svg>' +
            '<span>' +
            (a.replies && a.replies.length
              ? 'Reply · ' + a.replies.length
              : 'Reply') +
            '</span>' +
            '</button>' +
            (isOwner
              ? '<button class="ns-action-btn ns-delete-btn" data-delete-btn="' +
                escapeHtml(aid) +
                '" aria-label="Delete">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
                '<polyline points="3 6 5 6 21 6"/>' +
                '<path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>' +
                '<path d="M10 11v6M14 11v6"/>' +
                '<path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/>' +
                '</svg>' +
                '</button>'
              : '') +
            '</div>' +
            '</div>' +
            repliesHtml +
            '<div class="ns-reply-form" data-reply-form="' +
            escapeHtml(aid) +
            '">' +
            '<textarea placeholder="Write a reply..." maxlength="400"></textarea>' +
            '<div class="ns-reply-form-actions">' +
            '<button class="ns-reply-btn-cancel" data-reply-cancel="' +
            escapeHtml(aid) +
            '">Cancel</button>' +
            '<button class="ns-reply-btn-submit" data-reply-submit="' +
            escapeHtml(aid) +
            '">Reply →</button>' +
            '</div>' +
            '</div>' +
            '</div>'
          );
        })
        .join('');

    panelList.querySelectorAll('[data-like-btn]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLike(btn.dataset.likeBtn);
      });
    });
    panelList.querySelectorAll('[data-reply-btn]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReplyForm(btn.dataset.replyBtn);
      });
    });
    panelList.querySelectorAll('[data-delete-btn]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAnnotation(btn.dataset.deleteBtn, btn);
      });
    });
    panelList.querySelectorAll('[data-replies-toggle]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReplies(btn.dataset.repliesToggle);
      });
    });
    panelList.querySelectorAll('[data-reply-cancel]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelReply(btn.dataset.replyCancel);
      });
    });
    panelList.querySelectorAll('[data-reply-submit]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        submitReply(btn.dataset.replySubmit);
      });
    });
    panelList.querySelectorAll('[data-ns-signin]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openMemberstackLogin();
      });
    });

    requestAnimationFrame(addQuoteToggles);
  }

  // ─── Initial load ──────────────────────────────────
  async function loadAnnotations() {
    try {
      const annotations = await supa(
        'GET',
        'annotations?newsletter_slug=eq.' +
          encodeURIComponent(slug) +
          '&order=created_at.asc',
      );
      if (!Array.isArray(annotations) || !annotations.length) {
        allAnnotations = [];
        tagAllBlocks();
        renderAnnotations();
        applyHighlights();
        updateToggleBadge();
        return;
      }
      const ids = annotations.map((a) => '"' + a.id + '"').join(',');
      const [replies, myLikes] = await Promise.all([
        supa(
          'GET',
          'annotation_replies?annotation_id=in.(' +
            ids +
            ')&order=created_at.asc',
        ).catch(() => []),
        supa(
          'GET',
          'annotation_likes?annotation_id=in.(' +
            ids +
            ')&browser_id=eq.' +
            encodeURIComponent(BROWSER_ID),
        ).catch(() => []),
      ]);
      const repliesByAnn = {};
      (Array.isArray(replies) ? replies : []).forEach((r) => {
        (repliesByAnn[r.annotation_id] =
          repliesByAnn[r.annotation_id] || []).push(r);
      });
      likedAnnotations.clear();
      (Array.isArray(myLikes) ? myLikes : []).forEach((l) =>
        likedAnnotations.add(l.annotation_id),
      );

      allAnnotations = annotations.map((a) => ({
        ...a,
        likes: a.likes || 0,
        replies: repliesByAnn[a.id] || [],
      }));

      tagAllBlocks();
      renderAnnotations();
      applyHighlights();
      updateToggleBadge();
    } catch (err) {
      console.error('[NS] Load failed:', err);
      updateToggleBadge();
    }
  }

  loadAnnotations();
  console.log('[NS Annotations] Initialized for slug:', slug);
})();
