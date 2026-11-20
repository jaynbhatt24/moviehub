(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);

  // tiny DOM helper - always uses textContent, so admin-entered text can never inject HTML
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  let cfg = {};
  let titles = [];
  const st = { tab: 'home', q: '', genre: '' };
  const origTitle = document.title;

  // ---------- helpers ----------
  const typeLabel = (t) => (t.type === 'series' ? 'Web Series' : 'Movie');
  const metaLine = (t) => [t.year, typeLabel(t), t.language].filter(Boolean).join(' · ');

  function placeholder(t) {
    let hash = 0;
    for (const c of t.name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const d = h('div', { class: 'ph' }, h('span', { text: t.name.trim().charAt(0).toUpperCase() }));
    d.style.background = `linear-gradient(160deg,hsl(${hue} 45% 28%),hsl(${(hue + 40) % 360} 50% 12%))`;
    return d;
  }
  function posterImg(t) {
    if (!t.poster) return placeholder(t);
    const img = h('img', { src: t.poster, alt: t.name + ' poster', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(placeholder(t)));
    return img;
  }
  const watchBtn = (w, cls = 'btn') =>
    h('a', { class: cls, href: w.url, target: '_blank', rel: 'noopener noreferrer sponsored', text: 'Watch on ' + w.platform });

  // ---------- AdSense ----------
  function loadAdsense() {
    if (!cfg.adsenseClient) return;
    const s = h('script', { async: true, crossorigin: 'anonymous', src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(cfg.adsenseClient) });
    document.head.append(s);
  }
  function adEl(slot) {
    if (!cfg.adsenseClient || !slot) return null;
    return h('div', { class: 'ad' },
      h('small', { text: 'Advertisement' }),
      h('ins', { class: 'adsbygoogle', style: 'display:block', 'data-ad-client': cfg.adsenseClient, 'data-ad-slot': slot, 'data-ad-format': 'auto', 'data-full-width-responsive': 'true' }));
  }
  function activateAds() {
    requestAnimationFrame(() => {
      document.querySelectorAll('ins.adsbygoogle:not([data-ads-done])').forEach((ins) => {
        if (!ins.offsetWidth) return; // hidden: try again later
        ins.setAttribute('data-ads-done', '1');
        try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* ad blocked */ }
      });
    });
  }

  // ---------- routing ----------
  function go(url) {
    history.pushState({ nav: 1 }, '', url);
    route();
  }
  function back(fallback) {
    if (history.state && history.state.nav) history.back();
    else { history.replaceState(null, '', fallback); route(); }
  }
  function route() {
    const m = location.pathname.match(/^\/title\/([\w-]+)/);
    if (m) showTitle(m[1]); else hideTitle();
    if (location.hash === '#reels') showReels(); else hideReels();
    $('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.tab));
    document.body.classList.toggle('lock', !$('#modal').hidden || !$('#reels').hidden);
    activateAds();
  }
  window.addEventListener('popstate', route);

  // ---------- home grid ----------
  function filtered() {
    const q = st.q.trim().toLowerCase();
    let list = titles.filter((t) => st.tab === 'movies' ? t.type === 'movie' : st.tab === 'series' ? t.type === 'series' : true);
    const forChips = list;
    if (st.genre) list = list.filter((t) => (t.genres || []).includes(st.genre));
    if (q) list = list.filter((t) => [t.name, t.language, t.description, ...(t.genres || [])].join(' ').toLowerCase().includes(q));
    if (st.tab === 'home' && !q && !st.genre) list = [...list].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    return { list, forChips };
  }

  function render() {
    const { list, forChips } = filtered();

    // hero
    const hero = $('#hero');
    hero.replaceChildren();
    if (st.tab === 'home' && !st.q.trim() && !st.genre && titles.length) {
      const t = titles.find((x) => x.featured) || titles[0];
      const first = (t.watch || [])[0];
      hero.append(h('div', { class: 'hero' },
        t.poster ? h('img', { class: 'hero-bg', src: t.poster, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
        h('div', { class: 'hero-in' },
          h('span', { class: 'tag', text: t.featured ? 'Featured' : 'Latest' }),
          h('h1', { text: t.name }),
          h('p', { class: 'meta', text: [metaLine(t), t.rating ? '★ ' + t.rating : ''].filter(Boolean).join(' · ') }),
          t.description ? h('p', { class: 'desc', text: t.description }) : null,
          h('div', { class: 'row' },
            h('a', { class: 'btn primary', href: '/title/' + t.id, text: 'View details', onclick: (e) => { e.preventDefault(); go('/title/' + t.id); } }),
            first ? watchBtn(first, 'btn ghost') : null))));
    }

    // top ad
    const adTop = $('#adTop');
    adTop.replaceChildren();
    const a = adEl(cfg.slots && cfg.slots.top);
    if (a) adTop.append(a);

    // genre chips
    const counts = {};
    forChips.forEach((t) => (t.genres || []).forEach((g) => { counts[g] = (counts[g] || 0) + 1; }));
    const gs = Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, 14);
    const chips = $('#chips');
    chips.replaceChildren();
    if (gs.length) {
      chips.append(h('button', { class: 'chip' + (st.genre ? '' : ' on'), text: 'All', onclick: () => { st.genre = ''; render(); } }));
      gs.forEach((g) => chips.append(h('button', { class: 'chip' + (st.genre === g ? ' on' : ''), text: g, onclick: () => { st.genre = g; render(); } })));
    }

    // grid (+ inline ads every 12 cards)
    const grid = $('#grid');
    grid.replaceChildren();
    list.forEach((t, i) => {
      grid.append(h('a', { class: 'card', href: '/title/' + t.id, onclick: (e) => { e.preventDefault(); go('/title/' + t.id); } },
        h('div', { class: 'poster' },
          posterImg(t),
          h('span', { class: 'badge', text: t.type === 'series' ? 'SERIES' : 'MOVIE' }),
          t.rating ? h('span', { class: 'badge star', text: '★ ' + t.rating }) : null),
        h('h3', { text: t.name }),
        h('p', { text: [t.year, (t.genres || [])[0]].filter(Boolean).join(' · ') })));
      if ((i + 1) % 12 === 0 && i + 1 < list.length) {
        const ad = adEl(cfg.slots && cfg.slots.inline);
        if (ad) grid.append(ad);
      }
    });
    const empty = $('#empty');
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = titles.length ? 'Nothing matches your search.' : 'No titles yet. Add some from the admin panel (/admin).';
    activateAds();
  }

  // ---------- title popup ----------
  function showTitle(id) {
    const t = titles.find((x) => x.id === id);
    if (!t) return;
    const body = $('#modalBody');
    body.replaceChildren();
    document.title = t.name + (t.year ? ' (' + t.year + ')' : '') + ' - ' + (cfg.siteName || '');

    const facts = h('div', { class: 'facts' },
      t.year ? h('span', { class: 'fact', text: t.year }) : null,
      h('span', { class: 'fact', text: typeLabel(t) }),
      t.language ? h('span', { class: 'fact', text: t.language }) : null,
      t.rating ? h('span', { class: 'fact star', text: '★ ' + t.rating + '/10' }) : null,
      (t.genres || []).map((g) => h('span', { class: 'fact', text: g })));

    body.append(h('div', { class: 'd-top' },
      h('div', { class: 'poster' }, posterImg(t)),
      h('div', { class: 'd-info' },
        h('h2', { id: 'mTitle', text: t.name }),
        facts,
        t.description ? h('p', { text: t.description }) : null,
        (t.watch || []).length
          ? h('div', null,
              h('div', { class: 'sec-h', text: 'Where to watch' }),
              h('div', { class: 'row' }, t.watch.map((w, i) => watchBtn(w, i === 0 ? 'btn primary' : 'btn'))))
          : null)));

    if (t.youtube) {
      const box = h('div', { class: 'trailer' });
      box.append(
        h('img', { src: `https://i.ytimg.com/vi/${t.youtube}/hqdefault.jpg`, alt: '', loading: 'lazy' }),
        h('button', {
          class: 'play', 'aria-label': 'Play trailer',
          onclick: () => box.replaceChildren(h('iframe', {
            src: `https://www.youtube-nocookie.com/embed/${t.youtube}?autoplay=1&rel=0`,
            allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, title: 'Trailer'
          }))
        }, h('span', { text: '▶' })));
      body.append(h('div', { class: 'sec-h', text: 'Trailer / clip' }), box);
    }
    const ad = adEl(cfg.slots && cfg.slots.detail);
    if (ad) body.append(ad);

    $('#modal').hidden = false;
    $('#modal .sheet').scrollTop = 0;
  }
  function hideTitle() {
    if ($('#modal').hidden) return;
    $('#modal').hidden = true;
    $('#modalBody').replaceChildren();
    document.title = origTitle;
  }
  $('#modalClose').addEventListener('click', () => back(location.hash === '#reels' ? '/#reels' : '/'));
  $('#modalBg').addEventListener('click', () => back(location.hash === '#reels' ? '/#reels' : '/'));

  // ---------- reels ----------
  const reels = { muted: true, io: null };
  const YT = 'https://www.youtube-nocookie.com';
  const cmd = (ifr, func) => { try { ifr.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), YT); } catch (e) { /* ignore */ } };

  function loadSlide(sl) {
    if (sl._ifr) return;
    const id = sl.dataset.yt;
    const ifr = h('iframe', {
      src: `${YT}/embed/${id}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${id}&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`,
      allow: 'autoplay; encrypted-media; picture-in-picture', title: 'Video', referrerpolicy: 'strict-origin-when-cross-origin'
    });
    ifr.addEventListener('load', () => { if (!reels.muted) setTimeout(() => cmd(ifr, 'unMute'), 600); });
    sl.querySelector('.player').append(ifr);
    sl._ifr = ifr;
    sl.classList.remove('paused');
  }
  function unloadSlide(sl) {
    if (!sl._ifr) return;
    sl._ifr.remove();
    sl._ifr = null;
    sl.classList.remove('paused');
  }
  function buildSlide(t) {
    const first = (t.watch || [])[0];
    const sl = h('section', { class: 'slide', 'data-yt': t.youtube },
      h('img', { class: 'thumb', src: `https://i.ytimg.com/vi/${t.youtube}/hqdefault.jpg`, alt: '' }),
      h('div', { class: 'player' }),
      h('div', { class: 'tap', 'aria-label': 'Tap to play or pause' }),
      h('div', { class: 'paused-mark', text: '▶' }),
      h('div', { class: 'info' },
        h('h3', { text: t.name }),
        h('p', { class: 'meta', text: metaLine(t) }),
        t.description ? h('p', { class: 'desc', text: t.description }) : null,
        h('div', { class: 'row' },
          first ? h('a', { class: 'btn primary', href: first.url, target: '_blank', rel: 'noopener noreferrer sponsored', text: t.type === 'series' ? '▶ Watch Full Series' : '▶ Watch Full Movie' }) : null,
          h('button', { class: 'btn ghost', text: 'Details', onclick: () => go('/title/' + t.id + '#reels') })),
        first ? h('p', { class: 'avail', text: 'Opens on ' + first.platform }) : null));
    sl.querySelector('.tap').addEventListener('click', () => {
      if (!sl._ifr) return;
      const paused = sl.classList.toggle('paused');
      cmd(sl._ifr, paused ? 'pauseVideo' : 'playVideo');
    });
    return sl;
  }
  function showReels() {
    const root = $('#reels');
    if (!root.hidden) return;
    root.hidden = false;
    const list = $('#reelList');
    list.replaceChildren();
    const items = titles.filter((t) => t.inReels && t.youtube);
    if (!items.length) {
      list.append(h('div', { class: 'reels-empty', text: 'No clips yet. Add a YouTube clip and tick "Show in Reels" from the admin panel.' }));
      return;
    }
    reels.io = new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? loadSlide(e.target) : unloadSlide(e.target))), { root: list, threshold: 0.7 });
    items.forEach((t) => { const sl = buildSlide(t); list.append(sl); reels.io.observe(sl); });
    $('#reelMute').textContent = reels.muted ? '🔇' : '🔊';
  }
  function hideReels() {
    const root = $('#reels');
    if (root.hidden) return;
    root.hidden = true;
    if (reels.io) { reels.io.disconnect(); reels.io = null; }
    $('#reelList').replaceChildren();
  }
  $('#reelsClose').addEventListener('click', () => back('/'));
  $('#reelMute').addEventListener('click', () => {
    reels.muted = !reels.muted;
    $('#reelMute').textContent = reels.muted ? '🔇' : '🔊';
    document.querySelectorAll('.slide').forEach((sl) => { if (sl._ifr) cmd(sl._ifr, reels.muted ? 'mute' : 'unMute'); });
  });

  // ---------- wiring ----------
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    if (b.dataset.tab === 'reels') { go('/#reels'); return; }
    st.tab = b.dataset.tab;
    st.genre = '';
    if (location.pathname !== '/' || location.hash) history.pushState({ nav: 1 }, '', '/');
    route();
    render();
  });
  $('#brand').addEventListener('click', (e) => {
    e.preventDefault();
    st.tab = 'home'; st.q = ''; st.genre = ''; $('#q').value = '';
    if (location.pathname !== '/' || location.hash) history.pushState({ nav: 1 }, '', '/');
    route();
    render();
  });
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { st.q = e.target.value; render(); }, 150);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) back(location.hash === '#reels' ? '/#reels' : '/');
    else if (!$('#reels').hidden) back('/');
  });

  // ---------- start ----------
  async function init() {
    try {
      const [c, t] = await Promise.all([fetch('/api/config').then((r) => r.json()), fetch('/api/titles').then((r) => r.json())]);
      cfg = c;
      titles = Array.isArray(t) ? t : [];
    } catch (e) {
      $('#empty').hidden = false;
      $('#empty').textContent = 'Could not load. Please refresh.';
      return;
    }
    $('#siteName').textContent = cfg.siteName || 'MovieHub';
    if (cfg.contactEmail) $('#footMail').append(h('a', { href: 'mailto:' + cfg.contactEmail, text: cfg.contactEmail }));
    loadAdsense();
    render();
    route();
  }
  init();
})();
