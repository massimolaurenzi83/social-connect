// ═══════════════════════════════════════════════════════
// Social Connect — applicazione principale
// ═══════════════════════════════════════════════════════

const App = {
  catalog: null,
  feeds: {},        // categoria -> [items]
  notifItems: [],
  currentView: 'home',
  editingPlatforms: false,
  selectedPlatform: null,

  // URL di logout noti (fallback: home della piattaforma)
  LOGOUT_URLS: {
    youtube: 'https://www.youtube.com/logout',
    x: 'https://x.com/logout',
    instagram: 'https://www.instagram.com/accounts/logout/',
    tiktok: 'https://www.tiktok.com/logout',
    reddit: 'https://www.reddit.com/logout',
    facebook: 'https://www.facebook.com/settings?tab=security',
    bluesky: 'https://bsky.app/settings',
    mastodon: 'https://mastodon.uno/auth/sign_out'
  },

  // URL di ricerca per gli interessi ("AS Roma" → profili da collegare)
  SEARCH_URLS: {
    youtube: q => `https://www.youtube.com/results?search_query=${q}`,
    instagram: q => `https://www.instagram.com/explore/search/keyword/?q=${q}`,
    x: q => `https://x.com/search?q=${q}&f=user`,
    tiktok: q => `https://www.tiktok.com/search/user?q=${q}`,
    facebook: q => `https://www.facebook.com/search/pages?q=${q}`,
    reddit: q => `https://www.reddit.com/search/?q=${q}&type=sr`,
    bluesky: q => `https://bsky.app/search?q=${q}`,
    telegram: q => `https://t.me/s/${q.replace(/\s+/g, '')}`
  },

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

    // dashboard dinamica: refresh automatico ogni 3 minuti (quando la scheda è visibile)
    this.REFRESH_MS = 3 * 60 * 1000;
    this._lastAuto = Date.now();
    setInterval(() => {
      if (document.visibilityState === 'visible' && Store.get().onboarded) {
        this._lastAuto = Date.now();
        this.refresh();
      }
    }, this.REFRESH_MS);
    // tornando sull'app dopo un po', aggiorna subito
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Store.get().onboarded &&
          Date.now() - this._lastAuto > this.REFRESH_MS) {
        this._lastAuto = Date.now();
        this.refresh();
      }
    });
  },

  // ─────────────────────── caricamento feed ───────────────────────
  async loadFeeds() {
    const prefs = Store.get();
    // con interessi attivi carichiamo tutte le categorie, per cercare ovunque
    const cats = prefs.interests.length
      ? this.catalog.categories.map(c => c.id)
      : prefs.topics;
    const needSocial = cats.includes('social') || prefs.interests.length > 0;

    const jobs = cats.filter(c => c !== 'social').map(async cat => {
      try {
        const res = await fetch(`data/feeds/${cat}.json`, { cache: 'no-cache' });
        const data = await res.json();
        this.feeds[cat] = data.items || [];
      } catch { this.feeds[cat] = this.feeds[cat] || []; }
    });
    if (needSocial) jobs.push(this.loadSocialLive());
    await Promise.allSettled(jobs);
    this.computeNotifications();
    this.stampUpdated();
    this.maybeSystemNotify();
  },

  isNew(item) {
    return new Date(item.date).getTime() > (Store.get().lastRead || 0);
  },

  // notifica di sistema reale quando arrivano novità (se l'utente l'ha attivata)
  async maybeSystemNotify() {
    const prefs = Store.get();
    if (!prefs.sysNotif || !('Notification' in window) || Notification.permission !== 'granted') return;
    const fresh = this.notifItems.filter(i => new Date(i.date).getTime() > (prefs.lastNotified || 0));
    if (!fresh.length) return;
    Store.set({ lastNotified: Date.now() });
    const title = 'Social Connect';
    const body = `${fresh.length} ${I18N.t('sysnotif.body')}\n${(fresh[0].title || '').slice(0, 90)}`;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg?.showNotification) {
        reg.showNotification(title, { body, icon: 'assets/icon.svg', badge: 'assets/icon.svg', tag: 'sc-news' });
      } else {
        new Notification(title, { body, icon: 'assets/icon.svg' });
      }
    } catch { /* notifiche non disponibili */ }
  },

  async refresh() {
    const btn = document.getElementById('btnRefresh');
    btn.classList.add('spin');
    try {
      await this.loadFeeds();
      this.renderAll();
    } finally {
      btn.classList.remove('spin');
    }
  },

  stampUpdated() {
    const el = document.getElementById('updatedNote');
    const t = new Date().toLocaleTimeString(I18N.lang === 'it' ? 'it-IT' : 'en-GB',
      { hour: '2-digit', minute: '2-digit' });
    el.textContent = `${I18N.t('home.updated')} · ${t}`;
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

  // ──────────────── priorità piattaforme (ordine tile) ────────────────
  getPlatformOrder() {
    const saved = Store.get().platformOrder;
    const all = this.catalog.platforms.map(p => p.id);
    // ordine salvato + eventuali piattaforme nuove in coda
    return [...saved.filter(id => all.includes(id)), ...all.filter(id => !saved.includes(id))];
  },

  platformRank(id) {
    const i = this.getPlatformOrder().indexOf(id);
    return i < 0 ? this.catalog.platforms.length : i;
  },

  // ─────────── profilo dinamico: impara da ciò che l'utente apre ───────────
  trackAffinity(item) {
    const a = structuredClone(Store.get().affinity || { platforms: {}, sources: {}, categories: {} });
    a.platforms[item.platform] = (a.platforms[item.platform] || 0) + 1;
    if (item.sourceId) a.sources[item.sourceId] = (a.sources[item.sourceId] || 0) + 1;
    if (item.category) a.categories[item.category] = (a.categories[item.category] || 0) + 1;
    Store.set({ affinity: a });
  },

  // punteggio dinamico: recenza + ordine piattaforme scelto dall'utente
  // + app connesse + affinità con fonti/categorie/piattaforme già visitate
  itemScore(item) {
    const prefs = Store.get();
    const a = prefs.affinity || {};
    const ageHours = (Date.now() - new Date(item.date).getTime()) / 3600000;
    let bonus = 0;
    bonus += Math.log2(1 + (a.platforms?.[item.platform] || 0)) * 1.2;
    bonus += Math.log2(1 + (a.sources?.[item.sourceId] || 0)) * 1.6;
    bonus += Math.log2(1 + (a.categories?.[item.category] || 0)) * 0.8;
    if ((prefs.connected || {})[item.platform]) bonus += 2;
    return ageHours + this.platformRank(item.platform) * 1.5 - bonus;
  },

  // categorie ordinate per interesse dimostrato (click precedenti)
  topicsByAffinity() {
    const a = Store.get().affinity?.categories || {};
    return [...Store.get().topics].sort((x, y) => (a[y] || 0) - (a[x] || 0));
  },

  scored(items) {
    return [...items].sort((a, b) => this.itemScore(a) - this.itemScore(b));
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
  everyLoadedItem() {
    const seen = new Set();
    const out = [];
    for (const arr of Object.values(this.feeds)) {
      for (const i of arr) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
    }
    return out;
  },

  renderHero() {
    const el = document.getElementById('hero');
    const candidates = this.scored(
      this.allItems().filter(i => i.image && i.platform !== 'bluesky' && i.platform !== 'mastodon')
    );
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

  // ──────────── riga piattaforme: ordine, stato connesso, drag ────────────
  renderPlatformRow() {
    const row = document.getElementById('platformRow');
    row.innerHTML = '';
    const connected = Store.get().connected || {};
    for (const id of this.getPlatformOrder()) {
      const p = this.platInfo(id);
      if (!p || p.id === 'rss') continue;
      const a = document.createElement('a');
      a.className = 'ptile' + (connected[p.id] ? ' connected' : '');
      a.dataset.pid = p.id;
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.draggable = false;
      a.title = `${p.name} — ${I18N.t(p.level === 1 ? 'platform.level1' : 'platform.level3')}`;
      a.innerHTML = `<img src="${this.logo(p.id)}" alt="${this.esc(p.name)}" draggable="false">
                     <span class="dot"></span>
                     <span class="lvl">${p.level === 1 ? '◉' : '↗'}</span>`;
      a.addEventListener('click', e => {
        if (this.editingPlatforms) {
          e.preventDefault();
          this.selectTileForMove(a, row);
          return;
        }
        this.markConnected(p.id);
      });
      row.appendChild(a);
    }
    row.classList.toggle('editing', this.editingPlatforms);
    this.enablePlatformDrag(row);
    this.paintSelection(row);

    const btn = document.getElementById('btnEditPlatforms');
    btn.textContent = I18N.t(this.editingPlatforms ? 'home.done' : 'home.edit');
    document.querySelector('.hint').hidden = !this.editingPlatforms;
  },

  // primo accesso: la tile viene marcata come "connesso" (la sessione resta nel browser)
  markConnected(platformId) {
    const connected = { ...(Store.get().connected || {}) };
    if (!connected[platformId]) {
      connected[platformId] = Date.now();
      Store.set({ connected });
      this.renderPlatformRow();
      this.renderAccounts();
    }
  },

  disconnect(platformId) {
    const connected = { ...(Store.get().connected || {}) };
    delete connected[platformId];
    Store.set({ connected });
    this.renderPlatformRow();
    this.renderAccounts();
    // apre la pagina di logout ufficiale della piattaforma
    const url = this.LOGOUT_URLS[platformId] || this.platInfo(platformId)?.url;
    if (url) window.open(url, '_blank', 'noopener');
  },

  // Click su un logo = lo seleziono; click su un altro logo = ci sposto il
  // selezionato (prima o dopo, secondo la direzione). Il trascinamento resta
  // disponibile come scorciatoia: parte solo dopo 8px di movimento, così il
  // click semplice continua a funzionare.
  selectTileForMove(tile, row) {
    const pid = tile.dataset.pid;
    if (this.selectedPlatform === pid) {
      this.selectedPlatform = null;          // secondo click: deseleziona
    } else if (this.selectedPlatform) {
      this.moveSelectedTo(pid, row);
      return;
    } else {
      this.selectedPlatform = pid;
    }
    this.paintSelection(row);
  },

  moveSelectedTo(targetPid, row) {
    const order = [...row.querySelectorAll('.ptile')].map(t => t.dataset.pid);
    const from = order.indexOf(this.selectedPlatform);
    const to = order.indexOf(targetPid);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, this.selectedPlatform);
    this.applyOrder(order);
  },

  // ◀ / ▶ : sposta di una posizione il logo selezionato
  nudgeSelected(delta) {
    if (!this.selectedPlatform) return;
    const row = document.getElementById('platformRow');
    const order = [...row.querySelectorAll('.ptile')].map(t => t.dataset.pid);
    const from = order.indexOf(this.selectedPlatform);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(from, 1);
    order.splice(to, 0, this.selectedPlatform);
    this.applyOrder(order);
  },

  applyOrder(visibleOrder) {
    const rest = this.getPlatformOrder().filter(id => !visibleOrder.includes(id));
    Store.set({ platformOrder: [...visibleOrder, ...rest] });
    this.renderPlatformRow();
    this.renderRows();
    this.renderHero();
  },

  paintSelection(row) {
    row.querySelectorAll('.ptile').forEach(t => {
      t.classList.toggle('selected', t.dataset.pid === this.selectedPlatform);
    });
    const bar = document.getElementById('sortBar');
    bar.hidden = !this.editingPlatforms;
    if (!this.editingPlatforms) return;
    const p = this.selectedPlatform ? this.platInfo(this.selectedPlatform) : null;
    bar.querySelector('.sb-label').innerHTML = p
      ? `<img src="${this.logo(p.id)}" alt=""> <b>${this.esc(p.name)}</b>`
      : I18N.t('sort.select');
    bar.querySelectorAll('button').forEach(b => { b.disabled = !p; });
  },

  enablePlatformDrag(row) {
    let dragEl = null, startX = 0, moved = false;
    row.querySelectorAll('.ptile').forEach(tile => {
      tile.addEventListener('pointerdown', e => {
        if (!this.editingPlatforms) return;
        dragEl = tile; startX = e.clientX; moved = false;
      });
      tile.addEventListener('pointermove', e => {
        if (!dragEl || dragEl !== tile) return;
        if (!moved) {
          if (Math.abs(e.clientX - startX) < 8) return;   // sotto soglia: è un click
          moved = true;
          tile.classList.add('dragging');
          try { tile.setPointerCapture(e.pointerId); } catch {}
        }
        e.preventDefault();
        const others = [...row.querySelectorAll('.ptile:not(.dragging)')];
        const after = others.find(t => {
          const r = t.getBoundingClientRect();
          return e.clientX < r.left + r.width / 2;
        });
        if (after) row.insertBefore(dragEl, after);
        else row.appendChild(dragEl);
      });
      const end = e => {
        if (!dragEl || dragEl !== tile) return;
        const wasDrag = moved;
        tile.classList.remove('dragging');
        dragEl = null; moved = false;
        if (wasDrag) {
          e.preventDefault();
          this.selectedPlatform = tile.dataset.pid;
          this.applyOrder([...row.querySelectorAll('.ptile')].map(t => t.dataset.pid));
        }
      };
      tile.addEventListener('pointerup', end);
      tile.addEventListener('pointercancel', end);
    });
  },

  toggleEditPlatforms() {
    this.editingPlatforms = !this.editingPlatforms;
    if (!this.editingPlatforms) this.selectedPlatform = null;
    this.renderPlatformRow();
  },

  // ─────────────── righe home: interessi prima, poi argomenti ───────────────
  renderRows() {
    const wrap = document.getElementById('rows');
    wrap.innerHTML = '';

    // riga "Novità per te": tutto ciò che è nuovo secondo le preferenze
    // (argomenti seguiti + interessi), ordinato per priorità piattaforme
    const newSeen = new Set();
    const newItems = this.scored([
      ...this.allItems().filter(i => this.isNew(i)),
      ...Store.get().interests.flatMap(n => this.interestMatches(n).filter(i => this.isNew(i)))
    ].filter(i => !newSeen.has(i.id) && newSeen.add(i.id))).slice(0, 16);
    if (newItems.length) {
      const h3 = document.createElement('h3');
      h3.className = 'row-title';
      h3.innerHTML = `<span class="cat-ico">🆕</span> ${I18N.t('home.newrow')}
                      <button class="see-all">${I18N.t('nav.notifications')} →</button>`;
      h3.querySelector('.see-all').onclick = () => this.switchView('notifications');
      const row = document.createElement('div');
      row.className = 'hrow';
      for (const item of newItems) row.appendChild(this.cardFor(item));
      wrap.appendChild(h3);
      wrap.appendChild(row);
    }

    // righe degli interessi (⭐)
    for (const name of Store.get().interests) {
      const items = this.scored(this.interestMatches(name)).slice(0, 16);
      const h3 = document.createElement('h3');
      h3.className = 'row-title';
      h3.innerHTML = `<span class="cat-ico">⭐</span> ${this.esc(name)}
                      <button class="see-all">${I18N.t('interests.explore').split(' ')[0]} →</button>`;
      h3.querySelector('.see-all').onclick = () => this.openInterest(name);
      wrap.appendChild(h3);
      if (items.length) {
        const row = document.createElement('div');
        row.className = 'hrow';
        for (const item of items) row.appendChild(this.cardFor(item));
        wrap.appendChild(row);
      } else {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = `0 ${I18N.t('interests.matched')}`;
        wrap.appendChild(p);
      }
    }

    // righe degli argomenti, ordinate per interesse dimostrato
    for (const cat of this.topicsByAffinity()) {
      const items = this.scored(this.feeds[cat] || []).slice(0, 16);
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
          ${this.isNew(item) ? `<span class="newbadge">${I18N.t('badge.new')}</span>` : ''}
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
          ${this.isNew(item) ? `<span class="newbadge">${I18N.t('badge.new')}</span>` : ''}
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
    const items = this.scored(this.feeds[cat] || []);
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
      <div class="vthumb">${thumb}${this.isNew(item) ? `<span class="newbadge">${I18N.t('badge.new')}</span>` : ''}</div>
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

  // ─────────────────────────── interessi ───────────────────────────
  interestMatches(name) {
    const q = name.toLowerCase();
    return this.everyLoadedItem().filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.summary || '').toLowerCase().includes(q));
  },

  addInterest(name) {
    name = name.trim();
    if (!name) return;
    const interests = Store.get().interests;
    if (interests.length >= Store.MAX_INTERESTS) {
      alert(I18N.t('interests.limit'));
      return;
    }
    if (interests.some(i => i.toLowerCase() === name.toLowerCase())) return;
    Store.set({ interests: [...interests, name] });
    this.renderInterests();
    // servono tutte le categorie per cercare ovunque
    this.loadFeeds().then(() => {
      this.renderAll();
      this.openInterest(name);
    });
  },

  removeInterest(name) {
    Store.set({ interests: Store.get().interests.filter(i => i !== name) });
    this.renderInterests();
    this.computeNotifications();
    this.renderRows();
  },

  renderInterests() {
    const list = document.getElementById('interestList');
    list.innerHTML = '';
    for (const name of Store.get().interests) {
      const ch = document.createElement('button');
      ch.className = 'chip sel';
      ch.innerHTML = `⭐ ${this.esc(name)}<span class="x">✕</span>`;
      ch.title = name;
      ch.onclick = e => {
        if (e.target.classList.contains('x')) this.removeInterest(name);
        else this.openInterest(name);
      };
      list.appendChild(ch);
    }
  },

  // esplora un interesse: profili da collegare + ricerche sulle piattaforme
  async openInterest(name) {
    const modal = document.getElementById('interestModal');
    const box = document.getElementById('interestContent');
    const q = encodeURIComponent(name);
    const matched = this.interestMatches(name).length;

    const searchGrid = Object.entries(this.SEARCH_URLS).map(([pid, fn]) => `
      <a href="${this.esc(fn(q))}" target="_blank" rel="noopener">
        <img src="${this.logo(pid)}" alt="">${this.esc(this.platInfo(pid)?.name || pid)}
      </a>`).join('');

    box.innerHTML = `
      <h2 class="pa-title">⭐ ${I18N.t('interests.explore')} «${this.esc(name)}»</h2>
      <p class="int-matched">📥 ${matched} ${I18N.t('interests.matched')}</p>
      <div class="int-section">${I18N.t('interests.bsky')}</div>
      <div id="bskyProfiles"><p class="muted">${I18N.t('interests.bsky.loading')}</p></div>
      <div class="int-section">${I18N.t('interests.search')}</div>
      <div class="search-grid">${searchGrid}</div>`;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    // ricerca profili Bluesky in diretta (API pubblica)
    const target = box.querySelector('#bskyProfiles');
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${q}&limit=6`);
      const data = await res.json();
      const actors = data.actors || [];
      if (!actors.length) {
        target.innerHTML = `<p class="muted">${I18N.t('interests.none')}</p>`;
      } else {
        target.innerHTML = actors.map(a => `
          <a class="profile-row" href="https://bsky.app/profile/${this.esc(a.handle)}" target="_blank" rel="noopener">
            <img class="avatar" src="${this.esc(a.avatar || 'assets/logos/bluesky.svg')}" alt="" loading="lazy">
            <div>
              <div class="pr-name">${this.esc(a.displayName || a.handle)}</div>
              <div class="pr-handle">@${this.esc(a.handle)}</div>
              ${a.description ? `<div class="pr-desc">${this.esc(a.description)}</div>` : ''}
            </div>
            <span class="go">${I18N.t('feed.follow')} ↗</span>
          </a>`).join('');
      }
    } catch {
      target.innerHTML = `<p class="muted">${I18N.t('interests.none')}</p>`;
    }
  },

  closeInterest() {
    document.getElementById('interestModal').hidden = true;
    document.body.style.overflow = '';
  },

  // ─────────────────────────── notifiche ───────────────────────────
  computeNotifications() {
    const prefs = Store.get();
    const lastRead = prefs.lastRead || 0;
    const isNew = i => new Date(i.date).getTime() > lastRead;

    const seen = new Set();
    const out = [];

    // prima gli interessi (priorità massima)
    for (const name of prefs.interests) {
      for (const i of this.interestMatches(name).filter(isNew)) {
        if (!seen.has(i.id)) { seen.add(i.id); out.push({ ...i, _interest: name }); }
      }
    }
    // poi le novità degli argomenti seguiti
    for (const i of this.allItems().filter(isNew)) {
      if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
    }

    // priorità: interessi, poi punteggio dinamico (app collegate, ordine tile, affinità)
    out.sort((a, b) =>
      (b._interest ? 1 : 0) - (a._interest ? 1 : 0) || this.itemScore(a) - this.itemScore(b));
    this.notifItems = out.slice(0, 80);
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
    // gruppi: prima gli interessi (⭐), poi le piattaforme (con logo)
    const groups = new Map();
    for (const i of this.notifItems) {
      const key = i._interest ? `⭐ ${i._interest}` : `p:${i.platform}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    for (const [key, items] of groups) {
      const h = document.createElement('div');
      h.className = 'notif-day';
      if (key.startsWith('p:')) {
        const pid = key.slice(2);
        const p = this.platInfo(pid);
        h.innerHTML = `<img src="${this.logo(pid)}" alt="">
          ${this.esc(p?.name || pid)} — ${items.length} ${I18N.t('notif.new')}`;
      } else {
        h.textContent = `${key} — ${items.length} ${I18N.t('notif.new')}`;
      }
      list.appendChild(h);
      for (const item of items.slice(0, 6)) list.appendChild(this.vitemFor(item, true));
    }
  },

  // ─────────────────────────── apertura contenuti ───────────────────────────
  // Video YouTube: player interno. Tutto il resto: si va dritti alla pagina
  // dell'informazione nella stessa scheda — il tasto indietro riporta all'app.
  openItem(item) {
    this.trackAffinity(item);
    if (item.videoId) {
      const modal = document.getElementById('playerModal');
      const box = document.getElementById('playerContent');
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
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      return;
    }
    if (item.platform !== 'rss') this.markConnected(item.platform);
    window.location.href = item.url;
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
        this.stampUpdated();
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

    // interessi
    this.renderInterests();
    const input = document.getElementById('interestInput');
    input.placeholder = I18N.t('interests.placeholder');
    document.getElementById('btnAddInterest').onclick = () => {
      this.addInterest(input.value);
      input.value = '';
    };
    input.onkeydown = e => {
      if (e.key === 'Enter') { this.addInterest(input.value); input.value = ''; }
    };

    // notifiche di sistema
    this.renderSysNotifButton();

    // blocco biometrico
    this.renderLockButton();

    // account (stato connesso + logout)
    this.renderAccounts();

    document.getElementById('btnReset').onclick = () => {
      Store.set({ onboarded: false });
      this.showOnboarding();
    };
  },

  renderAccounts() {
    const acc = document.getElementById('accountsList');
    acc.innerHTML = '';
    const connected = Store.get().connected || {};
    for (const p of this.catalog.platforms.filter(p => p.id !== 'rss')) {
      const isOn = !!connected[p.id];
      const d = document.createElement('div');
      d.className = 'acc';
      d.innerHTML = `
        <img src="${this.logo(p.id)}" alt=""> ${this.esc(p.name)}
        <span class="acc-state${isOn ? ' on' : ''}">${isOn ? '● ' + I18N.t('accounts.connected') : I18N.t('accounts.notconnected')}</span>
        ${isOn ? `<button class="btn-mini">${I18N.t('accounts.logout')}</button>` : ''}`;
      const btn = d.querySelector('.btn-mini');
      if (btn) btn.onclick = () => this.disconnect(p.id);
      acc.appendChild(d);
    }
  },

  renderSysNotifButton() {
    const btn = document.getElementById('btnSysNotif');
    const msg = document.getElementById('sysNotifMsg');
    if (!('Notification' in window)) { btn.disabled = true; return; }
    const on = Store.get().sysNotif && Notification.permission === 'granted';
    btn.textContent = I18N.t(on ? 'settings.sysnotif.disable' : 'settings.sysnotif.enable');
    btn.onclick = async () => {
      msg.hidden = true;
      if (on) {
        Store.set({ sysNotif: false });
      } else {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          Store.set({ sysNotif: true, lastNotified: Date.now() });
        } else {
          msg.hidden = false;
          msg.textContent = I18N.t('settings.sysnotif.denied');
        }
      }
      this.renderSysNotifButton();
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
    document.getElementById('btnCloseInterest').onclick = () => this.closeInterest();
    document.getElementById('interestModal').addEventListener('click', e => {
      if (e.target.id === 'interestModal') this.closeInterest();
    });
    document.getElementById('btnRefresh').onclick = () => this.refresh();
    document.getElementById('btnRefresh').title = I18N.t('refresh.title');
    document.getElementById('btnEditPlatforms').onclick = () => this.toggleEditPlatforms();
    document.getElementById('btnMoveBefore').onclick = () => this.nudgeSelected(-1);
    document.getElementById('btnMoveAfter').onclick = () => this.nudgeSelected(1);
    document.getElementById('btnMarkRead').onclick = () => {
      Store.set({ lastRead: Date.now() });
      this.computeNotifications();
      this.renderNotifications();
    };
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.closePlayer(); this.closeInterest(); }
    });
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
