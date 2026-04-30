// ─── CONFIG ───────────────────────────────────────────
const NS_SUPABASE_URL = 'https://rayuxgfjmhmyblksmuta.supabase.co';
const NS_SUPABASE_KEY = 'sb_publishable_b07esV7lw3LZp2aq_pRKZg_BxlmudB3';
const NS_LOGIN_URL = '/login';
const NS_JOIN_URL = '/become-a-member';
const NS_PAID_GATE = 'ns-members'; // matches data-ms-content value
// ──────────────────────────────────────────────────────

(async function NormalSportAnnotations() {
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

  // ─── Member badge (Normal Sport mark) ──────────────
  const NS_MARK_SVG =
    '<svg class="ns-member-badge" viewBox="0 0 60 62" xmlns="http://www.w3.org/2000/svg" aria-label="Normal Sport member" role="img">' +
    '<path d="M59.0842 32.0971C57.9598 29.544 56.5798 27.4283 54.9823 25.8078C53.6668 24.4733 52.2028 23.4699 50.6306 22.8245C50.2489 22.6677 49.8602 22.5327 49.468 22.4195C49.7419 22.2319 50.1104 22.032 50.6041 21.7775C51.7744 21.1741 53.1007 20.4901 53.2447 19.0575C53.3778 17.7355 52.3553 16.7496 51.5748 16.1228C49.3163 14.3094 46.2174 11.9894 42.2722 10.1331C37.7793 8.01895 33.0385 6.91867 28.1686 6.85915C28.4336 5.88454 28.3974 4.85079 28.055 3.87501C27.6087 2.60432 26.6944 1.58302 25.4805 0.99981C24.2663 0.4166 22.8979 0.341121 21.6272 0.78738C19.0038 1.7083 17.6187 4.59167 18.5396 7.21514C18.6291 7.47037 18.7384 7.71626 18.866 7.95203C17.3347 8.35122 15.871 8.85778 14.5046 9.462C11.1975 10.9237 8.43827 12.9866 6.73572 15.2704C5.1137 17.446 4.52504 19.6952 5.07791 21.6036C5.68835 23.7104 6.82637 24.8885 7.74106 25.8347C8.36785 26.4833 8.71217 26.8715 8.86119 27.2875C8.2628 27.5474 7.6792 27.8625 7.12128 28.2274C5.56113 29.248 4.19823 30.6513 3.0711 32.3986C1.70237 34.5198 0.679512 37.1585 0.0301602 40.2414C-0.0235309 40.4959 -0.00524478 40.7597 0.0826842 41.004C0.651888 42.5863 3.39247 43.6808 3.93639 43.8842C5.32263 44.4029 6.80186 44.6768 8.21495 44.6768H8.2414C8.61763 44.676 8.99191 44.6558 9.36036 44.6165C9.32184 44.7725 9.28877 44.9301 9.26037 45.0896C8.96001 46.7847 9.26543 48.5301 10.0984 49.8778C11.224 51.699 12.9005 52.8429 14.698 53.0156C14.9516 53.0401 15.2053 53.0448 15.4582 53.0304C15.2889 54.456 15.706 55.7593 16.6845 56.8367C17.6284 57.8758 19.1831 58.5548 20.8429 58.6528C21.9361 58.7174 23.0216 58.5314 24.0176 58.1124C24.2651 58.6793 24.6114 59.1909 25.0518 59.6387C25.8813 60.4818 27.0189 61.0701 28.3425 61.3393C28.867 61.4459 29.4159 61.5 29.9739 61.5C30.9874 61.5 31.9986 61.321 32.8989 60.9822C34.0929 60.5328 35.0648 59.8247 35.7309 58.9228C36.0129 58.9571 36.337 58.9874 36.7 59.0139C37.8945 59.101 39.243 59.1158 40.4973 59.0559C43.1585 58.9279 46.7878 58.4015 48.9646 56.6192C49.7303 55.9924 50.28 55.2446 50.5987 54.3972C50.9741 53.3985 51.0173 52.285 50.727 51.082C51.1391 50.7482 51.4904 50.3412 51.7744 49.8681C52.4491 48.7445 52.7506 47.3022 52.7514 45.1931V45.1923V45.1756V45.1608C52.7444 43.7068 52.2483 42.3412 51.2352 40.9861C50.7204 40.2974 50.1263 39.6854 49.5466 39.1443C52.0184 38.9731 53.9368 38.0864 55.1822 37.302C57.4237 35.8909 58.843 33.9926 59.1348 33.0954C59.2414 32.7675 59.2239 32.413 59.0846 32.0975L59.0842 32.0971Z" fill="#484037"/>' +
    '<path d="M56.8791 32.647C55.896 30.5021 54.7229 28.7307 53.3896 27.3779C52.2874 26.2597 51.0735 25.4236 49.7818 24.8937C47.6606 24.023 46.0296 24.2794 46.0137 24.2821C45.7553 24.3284 45.4908 24.2506 45.2982 24.0724C45.1056 23.8942 45.008 23.6359 45.0344 23.3748C45.1184 22.5387 44.8033 21.4948 44.1298 21.1953C42.8284 20.6159 42.1145 21.0439 40.7504 21.9878C40.2835 22.3107 39.754 22.6768 39.1576 22.9857C38.7564 23.1935 38.2627 23.0453 38.0425 22.6508C37.8223 22.2562 37.9553 21.7578 38.3429 21.5256C39.7486 20.6829 40.2477 19.9296 40.1236 18.8387C39.9081 16.9432 38.8809 16.763 38.5436 16.7039C37.6608 16.549 36.4123 16.8887 35.2035 17.6135C34.0028 18.3333 33.0119 19.3149 32.5532 20.2389C32.3711 20.6054 31.9501 20.7863 31.5591 20.6665C31.1677 20.5467 30.9206 20.1611 30.9751 19.7553C31.0914 18.8881 30.9751 17.2622 29.8032 16.6708C29.329 16.4315 28.8656 16.4463 28.3446 16.7167C26.7685 17.5353 25.4799 20.244 25.3037 21.4458C25.2484 21.8236 24.9442 22.1158 24.5649 22.1563C24.1859 22.1967 23.8264 21.9749 23.6926 21.6178C23.628 21.4454 23.5646 21.2692 23.4969 21.0828C23.1774 20.1992 22.8152 19.1974 22.3157 18.5103C21.7266 17.7007 21.1955 17.6777 20.7536 17.7621C19.9832 17.9092 19.4074 18.6231 19.0596 19.1958C17.9892 20.9603 17.6939 23.5565 18.0896 24.8747C18.2223 25.317 17.9714 25.7835 17.529 25.9162C17.0862 26.0489 16.6201 25.7979 16.4875 25.3555C16.4875 25.3555 16.4875 25.3552 16.4875 25.3548C16.2525 24.5724 15.7424 23.9491 15.1565 23.7277C14.8001 23.5931 14.4554 23.6269 14.1313 23.8285C13.4154 24.2739 12.7583 25.3645 12.666 26.2593C12.6205 26.7013 12.7108 27.0336 12.9341 27.2464C13.1843 27.4849 13.2664 27.8526 13.1341 28.1716C13.0022 28.4899 12.6944 28.6949 12.349 28.6883C12.2797 28.6891 10.3993 28.7217 8.25559 30.1574C6.97634 31.0141 5.84961 32.1988 4.90651 33.6784C3.75604 35.4837 2.87636 37.7349 2.29004 40.3739C2.63047 40.7431 3.67045 41.4823 5.30647 41.9866C6.70516 42.4177 9.43719 42.9219 12.0564 41.4738C15.3739 39.2149 15.8381 34.4531 16.061 32.1611C16.0805 31.9619 16.0988 31.7736 16.1171 31.6098C16.1676 31.1507 16.5808 30.8192 17.0403 30.8702C17.4994 30.9207 17.8305 31.3343 17.7799 31.7934C17.7628 31.9467 17.7461 32.1214 17.7262 32.3233C17.6115 33.5003 17.4197 35.4705 16.7796 37.4376C15.9863 39.8751 14.7048 41.7045 12.9703 42.8752C12.9703 42.8752 12.9695 42.876 12.9691 42.876C11.3518 43.9891 10.8725 46.8736 12.0007 48.6995C12.7555 49.9208 13.8165 50.6814 14.9117 50.7869C15.8572 50.8779 16.7649 50.4834 17.5379 49.6457C17.8379 49.3209 18.3386 49.2855 18.6814 49.5652C19.0238 49.8445 19.0899 50.3425 18.832 50.7017C18.2106 51.5665 17.8188 52.412 17.6994 53.1465C17.5621 53.9908 17.7718 54.7051 18.3398 55.3308C19.4113 56.5104 22.3149 57.0683 24.4263 55.258C24.6746 55.0452 25.0236 54.9966 25.3204 55.1331C25.6173 55.2697 25.8075 55.5665 25.8075 55.893C25.8075 56.6886 26.0978 58.5978 28.7882 59.1452C30.8101 59.5568 33.4745 58.8654 34.2534 57.031C34.3464 56.8119 34.5281 56.6431 34.7533 56.5661C34.956 56.4968 35.1766 56.5085 35.3696 56.5964C35.7618 56.7092 38.1203 56.975 40.9002 56.7905C44.1929 56.5719 46.6537 55.805 47.8291 54.6316C48.6375 53.8243 48.8663 52.7964 48.5247 51.4969C48.1006 51.5895 47.6408 51.6377 47.1451 51.6409C45.6441 51.6506 44.182 51.6728 42.7681 51.6945C40.9068 51.723 39.1486 51.7498 37.3107 51.7506C37.285 51.7506 37.2589 51.7506 37.2332 51.7506C35.3116 51.7506 33.557 51.7202 31.8711 51.6576C31.4093 51.6405 31.049 51.2522 31.0662 50.7907C31.0833 50.3289 31.4708 49.9687 31.933 49.9858C33.5982 50.0476 35.3327 50.0776 37.2332 50.0776C37.2589 50.0776 37.2842 50.0776 37.3103 50.0776C39.1358 50.0768 40.8877 50.05 42.7428 50.022C44.1602 50.0006 45.6258 49.978 47.1342 49.9683C48.9064 49.9566 49.5363 49.2473 49.8561 48.7147C50.158 48.2116 50.3514 47.5385 50.4455 46.6452C49.96 45.9652 48.2399 46.1262 47.1066 46.0967C45.8269 46.0632 41.6997 46.0189 41.5667 43.507C41.3951 40.2685 45.4814 42.7274 46.5171 42.8153C48.1131 42.9511 48.4204 42.5492 48.8216 41.9574C48.8854 41.8632 48.8982 41.7547 48.8776 41.6411C48.2746 40.9758 47.5855 40.377 46.9576 39.8311C46.5249 39.4553 46.1168 39.1005 45.7845 38.7635C44.2718 37.2291 43.4182 36.0451 42.9307 34.804C42.3421 33.3061 42.3304 31.7246 42.8942 29.9706C43.1692 29.0256 43.7493 28.2051 44.5625 27.6238C45.5211 26.9383 46.6895 26.6675 47.852 26.8608C49.0146 27.0542 50.0323 27.6888 50.7175 28.6474C51.403 29.6061 51.6738 30.7745 51.4805 31.937C51.1221 34.0928 49.2476 35.6257 47.1307 35.6257C46.891 35.6257 46.6486 35.6063 46.4047 35.5654C45.8612 35.4752 45.3492 35.288 44.8881 35.0168C45.1939 35.546 45.5888 36.0704 46.0631 36.6128C47.6081 36.9812 49.1126 37.0341 50.5374 36.768C51.747 36.542 52.9013 36.0887 53.9685 35.4203C55.5625 34.422 56.5387 33.1995 56.8795 32.6451L56.8791 32.647ZM33.1733 34.7507C32.7839 37.0929 30.7475 38.7581 28.4477 38.7581C28.1875 38.7581 27.9241 38.7367 27.6591 38.6927C25.052 38.2593 23.2837 35.7856 23.7171 33.1785C23.9272 31.9156 24.6162 30.8099 25.6577 30.0656C26.6993 29.3209 27.9684 29.0268 29.2313 29.2365C31.8384 29.6699 33.6068 32.1436 33.1733 34.7507Z" fill="#FFFDFB"/>' +
    '<path d="M45.6454 33.5198C45.9551 33.719 46.3045 33.8552 46.6784 33.9175C48.1681 34.1649 49.582 33.1545 49.8298 31.6648C49.9496 30.943 49.7816 30.2178 49.3559 29.6226C48.9303 29.0273 48.2988 28.6335 47.5771 28.5133C47.425 28.488 47.2729 28.4756 47.1219 28.4756C46.5554 28.4756 46.0049 28.6511 45.5349 28.9872C45.2789 29.1701 45.0606 29.3914 44.8848 29.6412C45.7368 29.8467 46.4165 30.5279 46.5531 31.422C46.6803 32.2538 46.3037 33.0494 45.6454 33.5194V33.5198Z" fill="#FFFDFB"/>' +
    '<path d="M28.9567 30.8869C28.7836 30.8581 28.6104 30.8438 28.4385 30.8438C27.7934 30.8438 27.1658 31.0437 26.6305 31.4262C26.3453 31.6301 26.1014 31.8759 25.9033 32.1533C27.1409 32.1199 28.2323 32.9789 28.4179 34.1936C28.582 35.267 27.9879 36.2872 27.0254 36.7432C27.304 36.8856 27.6086 36.9887 27.9331 37.0427C29.6298 37.3248 31.2401 36.1736 31.5226 34.4769C31.8047 32.7797 30.6538 31.1694 28.9567 30.8873V30.8869Z" fill="#FFFDFB"/>' +
    '</svg>';

  // For now, treat any logged-in member as a "member" for badge display purposes.
  // TODO: switch this to hasPaidAccess() once we can test as a paying member.
  function isMember(ann) {
    return !!(ann && ann.member_id);
  }
  function memberBadgeHtml(ann) {
    return isMember(ann) ? NS_MARK_SVG : '';
  }

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
    #ns-panel { position: fixed; top: 0; right: -400px; width: 380px; height: 100vh; background: #fff7ee; border-left: 1px solid #484037; z-index: 9997; overflow-y: auto; padding: 24px; transition: right 0.35s cubic-bezier(0.4,0,0.2,1); font-family: inherit; box-sizing: border-box; }
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
    .ns-card-footer-author .ns-author { font-size: 13px; font-weight: 600; color: #484037; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
    .ns-card-footer-author .ns-date { font-size: 11px; color: #675b4e; line-height: 1.2; }
    .ns-member-badge { width: 14px; height: 14px; flex-shrink: 0; display: inline-block; vertical-align: middle; }
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
    .ns-reply-author { font-size: 12px; font-weight: 600; color: #484037; margin-bottom: 3px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .ns-reply-author .ns-member-badge { width: 12px; height: 12px; }
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

    .ns-signin-prompt { padding: 14px; margin: 0 0 12px; background: #fffdfb; border: 1px dashed #484037; border-radius: 12px; font-size: 13px; color: #484037; line-height: 145%; }
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
  toggleLabel.textContent = 'Annotations';
  panelToggle.appendChild(toggleLabel);
  const toggleBadge = document.createElement('span');
  toggleBadge.className = 'ns-toggle-badge';
  toggleBadge.dataset.count = '0';
  toggleBadge.textContent = '0';
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
    toggleBadge.textContent = n;
    toggleBadge.dataset.count = n;
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
      memberBadgeHtml(reply) +
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
                      memberBadgeHtml(r) +
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
            memberBadgeHtml(a) +
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
    }
  }

  loadAnnotations();
  console.log('[NS Annotations] Initialized for slug:', slug);
})();
