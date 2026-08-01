// Social Connect — internazionalizzazione
// Le stringhe vivono in i18n/<lang>.json; l'HTML usa data-i18n="chiave".

const I18N = {
  lang: 'it',
  strings: {},

  async load(lang) {
    const res = await fetch(`i18n/${lang}.json`);
    this.strings = await res.json();
    this.lang = lang;
    document.documentElement.lang = lang;
    this.apply();
  },

  t(key) {
    return this.strings[key] || key;
  },

  apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
  },

  // "5 min fa", "2 h fa", ...
  timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return this.t('time.now');
    if (s < 3600) return `${Math.round(s / 60)} ${this.t('time.min')}`;
    if (s < 86400) return `${Math.round(s / 3600)} ${this.t('time.hours')}`;
    return `${Math.round(s / 86400)} ${this.t('time.days')}`;
  }
};
