(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const say = (sel, text, ok) => { const e = $(sel); e.textContent = text || ''; e.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : ''); };

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/admin/login') { showLogin(); throw new Error('Please login again'); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  let titles = [];
  let editingId = null;

  // ---------- login ----------
  function showLogin() { $('#appView').hidden = true; $('#loginView').hidden = false; $('#pw').focus(); }
  async function login() {
    say('#loginMsg', '');
    try {
      await api('POST', '/api/admin/login', { password: $('#pw').value });
      $('#pw').value = '';
      await start();
    } catch (e) { say('#loginMsg', e.message); }
  }
  $('#loginBtn').addEventListener('click', login);
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#logoutBtn').addEventListener('click', async () => { await api('POST', '/api/admin/logout', {}).catch(() => {}); showLogin(); });

  // ---------- tabs ----------
  function view(v) {
    ['list', 'form', 'site', 'pass'].forEach((x) => { $('#v-' + x).hidden = x !== v; });
    $('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    if (b.dataset.v === 'form') openForm(null); else view(b.dataset.v);
  });

  // ---------- list ----------
  async function loadTitles() {
    titles = await fetch('/api/titles').then((r) => r.json());
    $('#count').textContent = titles.length;
    const list = $('#list');
    list.replaceChildren();
    if (!titles.length) list.append(h('p', { class: 'note', text: 'No titles yet. Click "+ Add title".' }));
    titles.forEach((t) => {
      const thumb = h('div', { class: 'thumb' });
      if (t.poster) thumb.append(h('img', { src: t.poster, alt: '', style: 'width:100%;height:100%;object-fit:cover', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }));
      else thumb.textContent = t.name.charAt(0).toUpperCase();
      list.append(h('div', { class: 'item' },
        thumb,
        h('div', null,
          h('h3', { text: t.name }),
          h('p', { text: [t.year, t.type === 'series' ? 'Web Series' : 'Movie', t.language].filter(Boolean).join(' · ') }),
          h('p', null,
            t.featured ? h('span', { class: 'tag', text: 'Featured' }) : null,
            t.inReels ? h('span', { class: 'tag', text: 'In Reels' }) : null,
            h('span', { class: 'tag', text: (t.watch || []).length + ' watch link(s)' }))),
        h('div', { class: 'row' },
          h('a', { class: 'btn small', href: '/title/' + t.id, target: '_blank', rel: 'noopener', text: 'View' }),
          h('button', { class: 'btn small', text: 'Edit', onclick: () => openForm(t) }),
          h('button', { class: 'btn small danger', text: 'Delete', onclick: () => del(t) }))));
    });
  }
  async function del(t) {
    if (!confirm('Delete "' + t.name + '"? This cannot be undone.')) return;
    try { await api('DELETE', '/api/titles/' + t.id); await loadTitles(); } catch (e) { alert(e.message); }
  }
  $('#newBtn').addEventListener('click', () => openForm(null));

  // ---------- form ----------
  function watchRow(w) {
    const row = h('div', { class: 'watch-row' },
      h('input', { type: 'text', placeholder: 'Netflix', maxlength: '40', 'data-k': 'platform', value: w.platform || '' }),
      h('input', { type: 'url', placeholder: 'https://www.netflix.com/title/…', 'data-k': 'url', value: w.url || '' }),
      h('button', { type: 'button', class: 'btn small danger', text: '✕', 'aria-label': 'Remove link', onclick: () => row.remove() }));
    $('#watchRows').append(row);
  }
  $('#addWatch').addEventListener('click', () => { if ($('#watchRows').children.length < 6) watchRow({}); });

  function ytThumb() {
    const v = $('#f-youtube').value.trim();
    let id = '';
    if (/^[\w-]{11}$/.test(v)) id = v;
    else {
      const m = v.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([\w-]{11})/);
      if (m) id = m[1];
    }
    const img = $('#ytPrev');
    img.hidden = !id;
    if (id) img.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  }
  $('#f-youtube').addEventListener('input', ytThumb);

  function openForm(t) {
    editingId = t ? t.id : null;
    $('#formTitle').textContent = t ? 'Edit title' : 'Add title';
    $('#f-name').value = t ? t.name : '';
    $('#f-type').value = t ? t.type : 'movie';
    $('#f-year').value = t && t.year ? t.year : '';
    $('#f-language').value = t ? t.language || '' : '';
    $('#f-rating').value = t && t.rating != null ? t.rating : '';
    $('#f-genres').value = t ? (t.genres || []).join(', ') : '';
    $('#f-description').value = t ? t.description || '' : '';
    $('#f-poster').value = t ? t.poster || '' : '';
    $('#f-youtube').value = t && t.youtube ? 'https://www.youtube.com/watch?v=' + t.youtube : '';
    $('#f-inReels').checked = !!(t && t.inReels);
    $('#f-featured').checked = !!(t && t.featured);
    $('#watchRows').replaceChildren();
    ((t && t.watch) || []).forEach(watchRow);
    if (!t) watchRow({});
    say('#formMsg', '');
    ytThumb();
    view('form');
    window.scrollTo(0, 0);
  }
  $('#cancelBtn').addEventListener('click', () => view('list'));

  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('#formMsg', '');
    const watch = [...$('#watchRows').children].map((r) => ({
      platform: r.querySelector('[data-k=platform]').value.trim(),
      url: r.querySelector('[data-k=url]').value.trim()
    })).filter((w) => w.platform || w.url);
    if (watch.some((w) => !w.platform || !w.url)) return say('#formMsg', 'Each watch link needs both a platform name and a full https:// link.');
    const body = {
      name: $('#f-name').value, type: $('#f-type').value, year: $('#f-year').value,
      language: $('#f-language').value, rating: $('#f-rating').value, genres: $('#f-genres').value,
      description: $('#f-description').value, poster: $('#f-poster').value, youtube: $('#f-youtube').value,
      inReels: $('#f-inReels').checked, featured: $('#f-featured').checked, watch
    };
    if (body.poster && !/^https?:\/\//i.test(body.poster)) return say('#formMsg', 'Poster link must start with https://');
    $('#saveBtn').disabled = true;
    try {
      if (editingId) await api('PUT', '/api/titles/' + editingId, body);
      else await api('POST', '/api/titles', body);
      await loadTitles();
      view('list');
    } catch (err) { say('#formMsg', err.message); }
    $('#saveBtn').disabled = false;
  });

  // ---------- site / ads ----------
  async function loadConfig() {
    const c = await api('GET', '/api/admin/config');
    $('#s-name').value = c.siteName || '';
    $('#s-tagline').value = c.tagline || '';
    $('#s-email').value = c.contactEmail || '';
    $('#s-client').value = c.adsenseClient || '';
    $('#s-top').value = (c.slots || {}).top || '';
    $('#s-inline').value = (c.slots || {}).inline || '';
    $('#s-detail').value = (c.slots || {}).detail || '';
  }
  $('#siteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('#siteMsg', '');
    try {
      await api('PUT', '/api/admin/config', {
        siteName: $('#s-name').value, tagline: $('#s-tagline').value, contactEmail: $('#s-email').value,
        adsenseClient: $('#s-client').value.trim(),
        slots: { top: $('#s-top').value.trim(), inline: $('#s-inline').value.trim(), detail: $('#s-detail').value.trim() }
      });
      say('#siteMsg', 'Saved. Refresh your site to see the changes.', true);
    } catch (err) { say('#siteMsg', err.message); }
  });

  // ---------- password ----------
  $('#passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('#passMsg', '');
    try {
      await api('POST', '/api/admin/password', { current: $('#p-cur').value, next: $('#p-new').value });
      $('#p-cur').value = ''; $('#p-new').value = '';
      say('#passMsg', 'Password changed.', true);
    } catch (err) { say('#passMsg', err.message); }
  });

  // ---------- start ----------
  async function start() {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    try {
      await Promise.all([loadTitles(), loadConfig()]);
      const me = await fetch('/api/admin/me').then((r) => r.json());
      $('#passEnv').hidden = !me.passwordFromEnv;
      $('#storageWarn').hidden = !me.ephemeralRisk;
      view('list');
    } catch (e) { /* api() already showed login if needed */ }
  }
  (async () => {
    const me = await fetch('/api/admin/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
    if (me.authed) start(); else showLogin();
  })();
})();
