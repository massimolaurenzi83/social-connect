// ═══════════════════════════════════════════════════════
// Social Connect — applicazione principale
// ═══════════════════════════════════════════════════════

const App = {
  catalog: null,
  feeds: {},        // categoria -> [items]
  notifItems: [],
  currentView: 'home',

  // ─────────────────────────── avvio ───────────────────────────
  async init() {
    const prefs = Store.get();
    const lang = prefs.lang || (navigator.language || 'it').slice(0, 2);
    await I18N.load(['it', 'en'].includes(lang) ? lang : 'en');

    this.catalog = await (await fetch('data/catalog.json')).json();

    if (prefs.lock) await this.showLock();

    this.bindNav();
    this.renderPlatformRow();
    this.renderSettings();

    if (!prefs.onboarded) {
      this.showOnboarding();
    } else {
      await this.loadFeeds();
      this.renderAll();
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  },

  // ─────────────────────── caricamento feed ───────────────────────
  async loadFeeds() {
    const topics = Store.get().topics;
    const jobs = topics.map(async cat => {
      if (cat === 'social') return this.loadSocialLive();
      try {
        const res = await fetch(`data/feeds/${cat}.json`, { cache: 'no-cache' });
        const data = await res.json();
        this.feeds[cat] = data.items || [];
      } catch { this.feeds[cat] = []; }
    });
    await Promise.allSettled(jobs);
    this.computeNotifications();
  },

  // Bluesky + Mastodon vengono letti in diretta dal browser (API pubbliche con CORS)
  async loadSocialLive() {
    const items = [];
    const bskySrc = this.catalog.sources.find(s => s.platform === 'bluesky');
    const mastoSrc = this.catalog.sources.find(s => s.platform === 'mastodon');

    const jobs = [];
    if (bskySrc) jobs.push((async () => {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(bskySrc.feed)}&limit=20`;
      const data = await (await fetch(url)).json();
      for (const f of data.feed || []) {
        const p = f.post;
        if (!p?.record?.text) continue;
        items.push({
          id: 'bsky:' + p.uri, sourceId: bskySrc.id, source: 'Bluesky',
          platform: 'bluesky', category: 'social',
          title: p.record.text,
          url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`,
          image: p.embed?.images?.[0]?.thumb || null,
          author: p.author.displayName || p.author.handle,
          handle: '@' + p.author.handle,
          avatar: p.author.avatar || null,
          likes: p.likeCount || 0, reposts: p.repostCount || 0,
          date: p.record.createdAt
        });
      }
    })());
    if (mastoSrc) jobs.push((async () => {
      const url = `https://${mastoSrc.instance}/api/v1/timelines/public?local=true&limit=20`;
      const data = await (await fetch(url)).json();
      for (const s of data) {
        const text = this.stripHtml(s.content);
        if (!text) continue;
        items.push({
          id: 'masto:' + s.id, sourceId: mastoSrc.id, source: 'Mastodon',
          platform: 'mastodon', category: 'social',
          title: text, url: s.url,
          image: s.media_attachments?.find(m => m.type === 'image')?.preview_url || null,
          author: s.account.display_name || s.account.acct,
          handle: '@' + s.account.acct,
          avatar: s.account.avatar || null,
          likes: s.favourites_count || 0, reposts: s.reblogs_count || 0,
          date: s.created_at
        });
      }
    })());

    await Promise.allSettled(jobs);
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    this.feeds.social = items;
  },

  // ─────────────────────────── rendering ───────────────────────────
  renderAll() {
    this.renderHero();
    this.renderRows();
    this.renderCategories();
    this.renderNotifications();
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  stripHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').trim();
  },
  catInfo(id) { return this.catalog.categories.find(c => c.id === id); },
  platInfo(id) { return this.catalog.platforms.find(p => p.id === id); },
  logo(platform) { return `assets/logos/${platform}.svg`; },

  allItems() {
    return Store.get().topics.flatMap(t => this.feeds[t] || []);
  },

  renderHero() {
    const el = document.getElementById('hero');
    const candidates = this.allItems()
      .filter(i => i.image && i.platform !== 'bluesky' && i.platform !== 'mastodon')
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const item = candidates[0];
    el.classList.remove('skeleton');
    if (!item) { el.hidden = true; return; }
    el.hidden = false;
    const cta = item.videoId ? I18N.t('home.watch') : I18N.t('home.readmore');
    el.innerHTML = `
      <img class="hero-bg" src="${this.esc(item.image)}" alt="" loading="eager">
      <div class="hero-shade"></div>
      <div class="hero-content">
        <span class="hero-badge">✦ ${I18N.t('home.hero.badge')}</span>
        <h2 class="hero-title">${this.esc(item.title)}</h2>
        <div class="hero-meta">
          <img src="${this.logo(item.platform)}" alt="">
          <span>${this.esc(item.source)} · ${I18N.timeAgo(item.date)}</span>
        </div>
        <span class="hero-cta">${item.videoId ? '▶' : '📖'} ${cta}</span>
      </div>`;
    el.onclick = () => this.openItem(item);
  },

  renderPlatformRow() {
    const row = document.getElementById('platformRow');
    row.innerHTML = '';
    for (const p of this.catalog.platforms) {
      if (p.id === 'rss') continue;
      const a = document.createElement('a');
      a.className = 'ptile';
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `${p.name} — ${I18N.t(p.level === 1 ? 'platform.level1' : 'platform.level3')}`;
      a.innerHTML = `<img src="${this.logo(p.id)}" alt="${this.esc(p.name)}">
                     <span class="lvl">${p.level === 1 ? '◉' : '↗'}</span>`;
      row.appendChild(a);
    }
  },

  renderRows() {
    const wrap = document.getElementById('rows');
    wrap.innerHTML = '';
    for (const cat of Store.get().topics) {
      const items = (this.feeds[cat] || []).slice(0, 16);
      if (!items.length) continue;
      const info = this.catInfo(cat);
      const h3 = document.createElement('h3');
      h3.className = 'row-title';
      h3.innerHTML = `<span class="cat-ico">${info?.icon || ''}</span> ${I18N.t('cat.' + cat)}
                      <button class="see-all">${I18N.t('home.open')} →</button>`;
      h3.querySelector('.see-all').onclick = () => this.openCategory(cat);
      const row = document.createElement('div');
      row.className = 'hrow';
      for (const item of items) row.appendChild(this.cardFor(item));
      wrap.appendChild(h3);
      wrap.appendChild(row);
    }
  },

  cardFor(item) {
    const card = document.createElement('button');
    card.className = 'card-item';
    const isPost = item.platform === 'bluesky' || item.platform === 'mastodon';
    if (isPost) {
      card.innerHTML = `
        <div class="post-head">
          ${item.avatar ? `<img class="avatar" src="${this.esc(item.avatar)}" alt="" loading="lazy">` : ''}
          <div><div class="ph-name">${this.esc(item.author)}</div>
          <div class="ph-handle">${this.esc(item.handle)} · ${I18N.timeAgo(item.date)}</div></div>
          <img src="${this.logo(item.platform)}" alt="" style="width:20px;height:20px;margin-left:auto">
        </div>
        ${item.image ? `<div class="card-thumb"><img src="${this.esc(item.image)}" alt="" loading="lazy"></div>` : ''}
        <div class="post-text">${this.esc(item.title)}</div>
        <div class="post-stats"><span>❤️ ${item.likes}</span><span>🔁 ${item.reposts}</span></div>`;
    } else {
      const thumb = item.image
        ? `<img src="${this.esc(item.image)}" alt="" loading="lazy">`
        : `<div class="thumb-fallback">${this.catInfo(item.category)?.icon || '📄'}</div>`;
      card.innerHTML = `
        <div class="card-thumb">
          ${thumb}
          <span class="pbadge"><img src="${this.logo(item.platform)}" alt="${this.esc(item.platform)}"></span>
          ${item.videoId ? '<span class="play">▶</span>' : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${this.esc(item.title)}</div>
          <div class="card-meta"><span class="src">${this.esc(item.source)}</span> · ${I18N.timeAgo(item.date)}</div>
        </div>`;
    }
    card.onclick = () => this.openItem(item);
    return card;
  },

  renderCategories() {
    const grid = document.getElementById('catGrid');
    grid.innerHTML = '';
    for (const c of this.catalog.categories) {
      const nSources = this.catalog.sources.filter(s => s.category === c.id).length;
      const b = document.createElement('button');
      b.className = 'cat-card';
      b.style.setProperty('--cc', c.color);
      b.innerHTML = `<span class="ico">${c.icon}</span>
                     <span class="name">${I18N.t('cat.' + c.id)}</span>
                     <span class="cnt">${nSources} fonti</span>`;
      b.onclick = () => this.openCategory(c.id);
      grid.appendChild(b);
    }
  },

  async openCategory(cat) {
    if (!this.feeds[cat]) {
      if (cat === 'social') await this.loadSocialLive();
      else {
        try {
          const data = await (await fetch(`data/feeds/${cat}.json`, { cache: 'no-cache' })).json();
          this.feeds[cat] = data.items || [];
        } catch { this.feeds[cat] = []; }
      }
    }
    const info = this.catInfo(cat);
    document.getElementById('catTitle').textContent = `${info?.icon || ''} ${I18N.t('cat.' + cat)}`;
    const list = document.getElementById('catFeed');
    list.innerHTML = '';
    const items = this.feeds[cat] || [];
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><span class="big">🛰️</span>${I18N.t('feed.empty')}</div>`;
    }
    for (const item of items) list.appendChild(this.vitemFor(item));
    this.switchView('category');
  },

  vitemFor(item, isNew = false) {
    const el = document.createElement('button');
    el.className = 'vitem';
    const thumb = item.image
      ? `<img src="${this.esc(item.image)}" alt="" loading="lazy">`
      : `<div class="thumb-fallback">${this.catInfo(item.category)?.icon || '📄'}</div>`;
    el.innerHTML = `
      <div class="vthumb">${thumb}</div>
      <div class="vbody">
        ${isNew ? '<span class="notif-new-dot"></span>' : ''}
        <div class="vtitle">${this.esc(item.title)}</div>
        ${item.summary ? `<div class="vsummary">${this.esc(item.summary)}</div>` : ''}
        <div class="card-meta">
          <img src="${this.logo(item.platform)}" alt="" style="width:14px;height:14px">
          <span class="src">${this.esc(item.source)}</span> · ${I18N.timeAgo(item.date)}
        </div>
      </div>`;
    el.onclick = () => this.openItem(item);
    return el;
  },

  // ─────────────────────────── notifiche ───────────────────────────
  computeNotifications() {
    const lastRead = Store.get().lastRead || 0;
    this.notifItems = this.allItems()
      .filter(i => new Date(i.date).getTime() > lastRead)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 60);
    this.updateBadges();
  },

  updateBadges() {
    const n = this.notifItems.length;
    for (const id of ['notifBadge', 'notifBadgeTop']) {
      const b = document.getElementById(id);
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : n;
    }
  },

  renderNotifications() {
    const list = document.getElementById('notifList');
    list.innerHTML = '';
    if (!this.notifItems.length) {
      list.innerHTML = `<div class="empty-state"><span class="big">🔔</span>${I18N.t('notif.empty')}</div>`;
      return;
    }
    // raggruppa per fonte
    const bySource = {};
    for (const i of this.notifItems) (bySource[i.source] ??= []).push(i);
    for (const [source, items] of Object.entries(bySource)) {
      const h = document.createElement('div');
      h.className = 'notif-day';
      h.textContent = `${source} — ${items.length} ${I18N.t('notif.new')}`;
      list.appendChild(h);
      for (const item of items.slice(0, 5)) list.appendChild(this.vitemFor(item, true));
    }
  },

  // ─────────────────────────── player ───────────────────────────
  openItem(item) {
    const modal = document.getElementById('playerModal');
    const box = document.getElementById('playerContent');
    if (item.videoId) {
      box.innerHTML = `
        <div class="player-video">
          <iframe src="https://www.youtube-nocookie.com/embed/${this.esc(item.videoId)}?autoplay=1&rel=0"
                  allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
        </div>
        <div class="pa-body">
          <div class="pa-meta"><img src="${this.logo('youtube')}" alt="">
            <span>${this.esc(item.source)} · ${I18N.timeAgo(item.date)}</span></div>
          <h2 class="pa-title">${this.esc(item.title)}</h2>
          <div class="pa-actions">
            <a class="btn btn-ghost" href="${this.esc(item.url)}" target="_blank" rel="noopener">${I18N.t('player.opennative')} ↗</a>
          </div>
        </div>`;
    } else {
      box.innerHTML = `
        <div class="player-article">
          ${item.image ? `<img class="pa-img" src="${this.esc(item.image)}" alt="">` : ''}
          <div class="pa-body">
            <div class="pa-meta"><img src="${this.logo(item.platform)}" alt="">
              <span>${this.esc(item.author || item.source)} · ${I18N.timeAgo(item.date)}</span></div>
            <h2 class="pa-title">${this.esc(item.title)}</h2>
            ${item.summary ? `<p class="pa-summary">${this.esc(item.summary)}</p>` : ''}
            <div class="pa-actions">
              <a class="btn btn-primary" href="${this.esc(item.url)}" target="_blank" rel="noopener">${I18N.t('player.openoriginal')} ↗</a>
            </div>
          </div>
        </div>`;
    }
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  },

  closePlayer() {
    document.getElementById('playerModal').hidden = true;
    document.getElementById('playerContent').innerHTML = '';
    document.body.style.overflow = '';
  },

  // ─────────────────────────── onboarding ───────────────────────────
  showOnboarding() {
    const grid = document.getElementById('onbTopics');
    const btn = document.getElementById('btnOnbStart');
    const count = document.getElementById('onbCount');
    const sel = new Set(Store.get().topics);
    grid.innerHTML = '';
    for (const c of this.catalog.categories) {
      const t = document.createElement('button');
      t.className = 'topic' + (sel.has(c.id) ? ' sel' : '');
      t.innerHTML = `<span class="t-ico">${c.icon}</span>${I18N.t('cat.' + c.id)}`;
      t.onclick = () => {
        sel.has(c.id) ? sel.delete(c.id) : sel.add(c.id);
        t.classList.toggle('sel');
        count.textContent = sel.size;
        btn.disabled = sel.size < 2;
      };
      grid.appendChild(t);
    }
    count.textContent = sel.size;
    btn.disabled = sel.size < 2;
    btn.onclick = async () => {
      Store.set({ topics: [...sel], onboarded: true, lastRead: Date.now() - 86400000 });
      document.getElementById('onboarding').hidden = true;
      document.getElementById('hero').classList.add('skeleton');
      await this.loadFeeds();
      this.renderAll();
      this.renderSettings();
    };
    document.getElementById('onboarding').hidden = false;
  },

  // ─────────────────────────── impostazioni ───────────────────────────
  renderSettings() {
    // lingua
    document.querySelectorAll('.lang-chip').forEach(ch => {
      ch.classList.toggle('sel', ch.dataset.lang === I18N.lang);
      ch.onclick = async () => {
        Store.set({ lang: ch.dataset.lang });
        await I18N.load(ch.dataset.lang);
        this.renderSettings();
        this.renderAll();
        this.renderPlatformRow();
      };
    });

    // argomenti
    const topicsEl = document.getElementById('setTopics');
    topicsEl.innerHTML = '';
    const topics = new Set(Store.get().topics);
    for (const c of this.catalog.categories) {
      const ch = document.createElement('button');
      ch.className = 'chip' + (topics.has(c.id) ? ' sel' : '');
      ch.textContent = `${c.icon} ${I18N.t('cat.' + c.id)}`;
      ch.onclick = async () => {
        topics.has(c.id) ? topics.delete(c.id) : topics.add(c.id);
        if (topics.size < 2) { topics.add(c.id); return; }
        Store.set({ topics: [...topics] });
        ch.classList.toggle('sel');
        await this.loadFeeds();
        this.renderAll();
      };
      topicsEl.appendChild(ch);
    }

    // blocco biometrico
    this.renderLockButton();

    // account collegati (roadmap)
    const acc = document.getElementById('accountsList');
    acc.innerHTML = '';
    for (const p of this.catalog.platforms.filter(p => p.level === 1 && p.id !== 'rss')) {
      const d = document.createElement('div');
      d.className = 'acc';
      d.innerHTML = `<img src="${this.logo(p.id)}" alt=""> ${p.name}
                     <span class="soon">${I18N.t('settings.accounts.soon')}</span>`;
      acc.appendChild(d);
    }

    document.getElementById('btnReset').onclick = () => {
      Store.set({ onboarded: false });
      this.showOnboarding();
    };
  },

  // ─────────────────────── blocco biometrico (WebAuthn) ───────────────────────
  lockSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials);
  },

  renderLockButton() {
    const btn = document.getElementById('btnAppLock');
    const msg = document.getElementById('applockMsg');
    const enabled = !!Store.get().lock;
    btn.textContent = I18N.t(enabled ? 'settings.applock.disable' : 'settings.applock.enable');
    if (!this.lockSupported()) {
      btn.disabled = true;
      msg.hidden = false;
      msg.textContent = I18N.t('settings.applock.unsupported');
      return;
    }
    btn.onclick = async () => {
      if (Store.get().lock) {
        Store.set({ lock: null });
      } else {
        try {
          const cred = await navigator.credentials.create({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rp: { name: 'Social Connect' },
              user: {
                id: crypto.getRandomValues(new Uint8Array(16)),
                name: 'utente@socialconnect',
                displayName: 'Utente Social Connect'
              },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
              authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
              timeout: 60000
            }
          });
          const id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
          Store.set({ lock: { credentialId: id } });
        } catch { return; }
      }
      this.renderLockButton();
    };
  },

  showLock() {
    return new Promise(resolve => {
      const screen = document.getElementById('lockScreen');
      const err = document.getElementById('lockError');
      screen.hidden = false;
      const tryUnlock = async () => {
        err.hidden = true;
        try {
          const raw = Uint8Array.from(atob(Store.get().lock.credentialId), c => c.charCodeAt(0));
          await navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              allowCredentials: [{ type: 'public-key', id: raw }],
              userVerification: 'required',
              timeout: 60000
            }
          });
          screen.hidden = true;
          resolve();
        } catch {
          err.hidden = false;
        }
      };
      document.getElementById('btnUnlock').onclick = tryUnlock;
      tryUnlock();
    });
  },

  // ─────────────────────────── navigazione ───────────────────────────
  bindNav() {
    document.querySelectorAll('[data-view]').forEach(b => {
      b.addEventListener('click', () => this.switchView(b.dataset.view));
    });
    document.getElementById('btnBackCat').onclick = () => this.switchView('categories');
    document.getElementById('btnClosePlayer').onclick = () => this.closePlayer();
    document.getElementById('playerModal').addEventListener('click', e => {
      if (e.target.id === 'playerModal') this.closePlayer();
    });
    document.getElementById('btnMarkRead').onclick = () => {
      Store.set({ lastRead: Date.now() });
      this.computeNotifications();
      this.renderNotifications();
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.closePlayer(); });
  },

  switchView(view) {
    this.currentView = view;
    for (const v of ['home', 'categories', 'category', 'notifications', 'settings']) {
      document.getElementById('view-' + v).hidden = v !== view;
    }
    const navTarget = view === 'category' ? 'categories' : view;
    document.querySelectorAll('.tab, .bnav').forEach(b => {
      b.classList.toggle('active', b.dataset.view === navTarget);
    });
    if (view === 'notifications') this.renderNotifications();
    window.scrollTo({ top: 0 });
  }
};

App.init();
