'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const baseUrl = (http?.baseUrl || '').trim();
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || ''; // do not log
  }

  baseUrlNoSlash() {
    return (this.http?.baseUrl || '').replace(/\/+$/, '');
  }

  // The page EduPage expects as context for timetable API calls
  getTimetablePagePath() {
    return '/timetable/';
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

  // ---- legacy "gu" path (dashboard embed) ----
  getTimetableRefererPath() {
    const eqa = Buffer.from('mode=timetable').toString('base64');
    return `/dashboard/eb.php?eqa=${encodeURIComponent(eqa)}`;
  }

  /**
   * Critical: establish correct timetable view context.
   * EduPage often returns {reload:true} if /timetable/ was never loaded in this session.
   */
  async loadTimetableContext({ guPath } = {}) {
    const baseUrl = this.baseUrlNoSlash();
    const rootRef = `${baseUrl}/`;
    const ttPath = this.getTimetablePagePath();
    const ttRef = baseUrl + ttPath;

    // 1) Root (sometimes sets cookies / locale)
    await this.http.get('/', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }).catch(() => {});

    // 2) Timetable page (the important one)
    await this.http.get(ttPath, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: rootRef,
      },
    });

    // 3) Optional: also hit guPath if provided (some schools use it), but AFTER /timetable/
    if (guPath) {
      await this.http.get(guPath, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: ttRef,
        },
      }).catch(() => {});
    }

    // Return the /timetable/ html for _gsh parsing
    const html = await this.http.get(ttPath, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: rootRef,
      },
    });

    return html;
  }

  async warmUpTimetable({ guPath } = {}) {
    // Keep backward compatibility: warmUp now really means "load proper timetable context"
    return await this.loadTimetableContext({ guPath });
  }

  extractGshFromHtml(html) {
    const s = typeof html === 'string' ? html : JSON.stringify(html);

    const m =
      s.match(/["_']_gsh["_']\s*:\s*["']([0-9a-f]+)["']/i) ||
      s.match(/\b_gsh\b\s*=\s*["']([0-9a-f]+)["']/i) ||
      s.match(/data-gsh=["']([0-9a-f]+)["']/i);

    return m?.[1] || '';
  }

  async getGsh({ guPath } = {}) {
    // 1) Prefer _gsh from /timetable/ context
    const htmlTt = await this.loadTimetableContext({ guPath });
    let gsh = this.extractGshFromHtml(htmlTt);
    if (gsh) return gsh;

    // 2) Fallback: try guPath html (if any)
    if (guPath) {
      const htmlGu = await this.http.get(guPath, { headers: { Accept: 'text/html,*/*' } }).catch(() => null);
      gsh = this.extractGshFromHtml(htmlGu);
      if (gsh) return gsh;
    }

    throw new Error('Could not detect _gsh automatically. Open timetable in browser and copy _gsh from DevTools.');
  }

  // ---- Timetable endpoint candidates ----
  getCurrentTtCandidates() {
    return [
      // Most common (matches DevTools in many cases)
      { path: '/timetable/server/currenttt.js?_func=currentttGetData', label: 'currenttt.js + _func + currentttGetData' },

      // Variants seen in the wild
      { path: '/timetable/server/currenttt.js?__func=currentttGetData', label: 'currenttt.js + __func + currentttGetData' },
      { path: '/timetable/server/currentttjs?_func=currentttGetData', label: 'currentttjs + _func + currentttGetData' },
      { path: '/timetable/server/currentttjs?__func=currentttGetData', label: 'currentttjs + __func + currentttGetData' },
    ];
  }

  /**
   * POST JSON: { args: [...], _gsh: "...." }
   * Important: use /timetable/ as referer context.
   */
  async currentttGetData({ args, gsh, guPath }) {
    // Ensure context before calling API (prevents {reload:true})
    await this.loadTimetableContext({ guPath });

    const payload = { args };
    if (gsh) payload._gsh = gsh;

    const baseUrl = this.baseUrlNoSlash();
    const referer = baseUrl + this.getTimetablePagePath();

    const headers = {
      Accept: 'application/json,*/*',
      Referer: referer,
      Origin: baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
    };

    const candidates = this.getCurrentTtCandidates();

    let lastErr = null;
    for (const c of candidates) {
      try {
        const res = await this.http.postJson(c.path, payload, { timeout: 25000, headers });

        // If EduPage says "reload", do one forced context refresh here as well
        if (res?.reload) {
          await this.loadTimetableContext({ guPath });
        }

        return res;
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error('Timetable request failed (unknown error)');
  }
}

module.exports = { EdupageClient };
