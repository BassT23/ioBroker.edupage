'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const baseUrl = (http?.baseUrl || '').trim();
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || ''; // do not log
  }

  async getLoginData() {
    return await this.http.get('/login/?cmd=MainLogin&akcia=getData');
  }

  async rpcMainLogin(method, params, options = {}) {
    const url = `/login/?cmd=MainLogin${method ? `&akcia=${encodeURIComponent(method)}` : ''}`;
    return await this.http.postForm(url, { rpcparams: JSON.stringify(params || {}) }, options);
  }

  async getToken({ username, edupage }) {
    return await this.rpcMainLogin('getToken', { username, edupage });
  }

  async login({ username, password, userToken, edupage, ctxt, tu, gu, au }) {
    return await this.rpcMainLogin(
      'login',
      {
        username,
        password,
        userToken,
        edupage,
        ctxt: ctxt || '',
        tu: tu ?? null,
        gu: gu ?? null,
        au: au ?? null,
      },
      { timeout: 25000 }
    );
  }

  // ---- Option A: Timetable-Referer (gu) ----
  getTimetableRefererPath() {
    const eqa = Buffer.from('mode=timetable').toString('base64');
    return `/dashboard/eb.php?eqa=${encodeURIComponent(eqa)}`;
  }

  async warmUpTimetable({ guPath } = {}) {
    const p = guPath || this.getTimetableRefererPath();
    return await this.http.get(p, { headers: { Accept: 'text/html,*/*' } });
  }

  async getGsh({ guPath } = {}) {
    const html = await this.warmUpTimetable({ guPath });
    const s = typeof html === 'string' ? html : JSON.stringify(html);

    const m =
      s.match(/["_']_gsh["_']\s*:\s*["']([0-9a-f]+)["']/i) ||
      s.match(/\b_gsh\b\s*=\s*["']([0-9a-f]+)["']/i) ||
      s.match(/data-gsh=["']([0-9a-f]+)["']/i);

    if (m?.[1]) return m[1];

    throw new Error('Could not detect _gsh automatically (open timetable in browser once and try again).');
  }

  // ---- Timetable endpoint variations ----
  // EduPage ist nicht überall gleich: .js vs js, _func vs __func, currenttt vs curenttt
  getCurrentTtCandidates() {
    return [
      // dein Browser-Fall (wichtigster)
      { path: '/timetable/server/currenttt.js?__func=curentttGetData', label: 'currenttt.js + __func + curentttGetData' },

      // nahe Varianten
      { path: '/timetable/server/currenttt.js?__func=currentttGetData', label: 'currenttt.js + __func + currentttGetData' },
      { path: '/timetable/server/currenttt.js?_func=currentttGetData', label: 'currenttt.js + _func + currentttGetData' },
      { path: '/timetable/server/currenttt.js?_func=curentttGetData', label: 'currenttt.js + _func + curentttGetData' },

      // ältere/andere Auslieferung ohne Punkt
      { path: '/timetable/server/currentttjs?_func=currentttGetData', label: 'currentttjs + _func + currentttGetData' },
      { path: '/timetable/server/currentttjs?__func=curentttGetData', label: 'currentttjs + __func + curentttGetData' },
    ];
  }

  // POST JSON: { args: [...], _gsh: "...." }
  // Wichtig: Referer & Origin mitschicken.
  async currentttGetData({ args, gsh, guPath }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    const baseUrl = (this.http?.baseUrl || '').replace(/\/+$/, '');
    const refererPath = guPath || this.getTimetableRefererPath();
    const referer = baseUrl + refererPath;
    const origin = baseUrl;

    const headers = {
      Accept: 'application/json,*/*',
      Referer: referer,
      Origin: origin,
    };

    const candidates = this.getCurrentTtCandidates();

    let lastErr = null;
    for (const c of candidates) {
      try {
        const res = await this.http.postJson(c.path, payload, { timeout: 25000, headers });
        // Erfolg -> zurück
        return res;
      } catch (e) {
        lastErr = e;
        const status = e?.response?.status;
        // bei 404 probieren wir weiter; bei anderen Fehlern ebenfalls
        if (status && status !== 404) {
          // trotzdem weiter probieren, aber merken
        }
      }
    }

    // nichts hat geklappt -> saubere Fehlermeldung
    const status = lastErr?.response?.status;
    if (status === 404) {
      throw new Error('HTTP 404 on POST currenttt endpoint (tried multiple variants). Check if timetable is accessible for this account.');
    }
    throw lastErr || new Error('Timetable request failed (unknown error)');
  }
}

module.exports = { EdupageClient };
