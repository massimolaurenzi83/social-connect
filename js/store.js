// Social Connect — preferenze utente (localStorage)
// In una fase successiva queste preferenze migreranno sull'account utente (backend).

const Store = {
  KEY: 'socialconnect.prefs.v1',

  defaults: {
    lang: null,          // null = da rilevare dal browser
    topics: [],          // id categorie scelte nell'onboarding
    onboarded: false,
    lastRead: 0,         // timestamp ultima lettura notifiche
    lock: null           // { credentialId } se blocco biometrico attivo
  },

  _cache: null,

  get() {
    if (!this._cache) {
      try {
        this._cache = { ...this.defaults, ...JSON.parse(localStorage.getItem(this.KEY) || '{}') };
      } catch {
        this._cache = { ...this.defaults };
      }
    }
    return this._cache;
  },

  set(patch) {
    this._cache = { ...this.get(), ...patch };
    localStorage.setItem(this.KEY, JSON.stringify(this._cache));
    return this._cache;
  },

  reset() {
    localStorage.removeItem(this.KEY);
    this._cache = null;
  }
};
