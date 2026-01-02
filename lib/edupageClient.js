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

  /**
   * IMPORTANT:
   * Browser referer for timetable API is usually:
   * /dashboard/eb.php?mode=timetable
   * (NOT the base64 eqa variant)
   */
  getDashboardTimetableRefererPath() {
    return '/dashboard/eb.php?mode=timetable';
  }

  /**
   * Load timetable context like the browser does.
   * This helps set cookies/context before calling currentttGetData.
   */
  async warmUpTimetable({ guPath } = {}) {
    const p = guPath || this.getDashboardTimetableRefererPath();
    return await this.http.get(p, { headers: { Accept: 'text/html,*/*' } });
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
    const html = await this.warmUpTimetable({ guPath });
    const gsh = this.extractGshFromHtml(html);
    if (gsh) return gsh;

    throw new Error('Could not detect _gsh automatically (open timetable in browser once and try again).');
  }

  /**
   * EXACT browser endpoint from your DevTools:
   * /timetable/server/currenttt.js?__func=curentttGetData
   */
  getCurrentTtPath() {
    return '/timetable/server/currenttt.js?__func=curentttGetData';
  }

  /**
   * Browser payload:
   * { "__args": [...], "__gsh": "...." }
   */
  async currentttGetData({ args, gsh, guPath }) {
    // Ensure the correct referer page was loaded in this session
    const refererPath = guPath || this.getDashboardTimetableRefererPath();
    await this.warmUpTimetable({ guPath: refererPath });

    const payload = {
      __args: args,
      __gsh: gsh,
    };

    const baseUrl = this.baseUrlNoSlash();
    const referer = baseUrl + refererPath;

    const headers = {
      Accept: '*/*',
      Referer: referer,
      Origin: baseUrl,
      'Content-Type': 'application/json; charset=UTF-8',
    };

    return await this.http.postJson(this.getCurrentTtPath(), payload, { timeout: 25000, headers });
  }
}

module.exports = { EdupageClient };
