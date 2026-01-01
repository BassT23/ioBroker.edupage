'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    // subdomain automatisch aus baseUrl ableiten: https://rs-kollnau.edupage.org -> rs-kollnau
    const m = (http?.baseUrl || '').match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || '';
  }

  // ----- Login: getData -----
  async getLoginData() {
    return await this.http.get('/login/?cmd=MainLogin&akcia=getData');
  }

  // AscHttp.rpc Nachbau:
  // POST /login/?cmd=MainLogin&akcia=<method>
  // body: rpcparams=<JSON.stringify(params)> (x-www-form-urlencoded)
  async rpcMainLogin(method, params, options = {}) {
    const url = `/login/?cmd=MainLogin${method ? `&akcia=${encodeURIComponent(method)}` : ''}`;
    return await this.http.postForm(url, { rpcparams: JSON.stringify(params || {}) }, options);
  }

  async getToken({ username, edupage }) {
    return await this.rpcMainLogin('getToken', { username, edupage });
  }

  async login({ username, password, userToken, edupage, ctxt, tu, gu, au }) {
    return await this.rpcMainLogin('login', {
      username,
      password,
      userToken,
      edupage,
      ctxt: ctxt || '',
      tu: tu ?? null,
      gu: gu ?? null,
      au: au ?? null,
    }, { timeout: 25000 });
  }

  // ----- _gsh holen -----
  // In deinen DevTools sieht man: "_gsh": "b0c9d101"
  // Der Wert ist oft im HTML/JS der Timetable-Seite eingebettet.
  async getGsh() {
    // Versuche 1: timetable page (häufig)
    const tryUrls = [
      '/timetable/',
      '/timetable',
      '/dashboard/eb.php?eqa=' + encodeURIComponent(Buffer.from('mode=timetable').toString('base64')),
    ];

    for (const u of tryUrls) {
      try {
        const html = await this.http.get(u, { headers: { 'Accept': 'text/html,*/*' } });
        const s = typeof html === 'string' ? html : JSON.stringify(html);
        const m = s.match(/["_']_gsh["_']\s*:\s*["']([0-9a-f]+)["']/i) || s.match(/_gsh\s*=\s*["']([0-9a-f]+)["']/i);
        if (m && m[1]) return m[1];
      } catch (e) {
        // ignore
      }
    }
    throw new Error('Could not detect _gsh automatically (open timetable in browser once and try again).');
  }

  // ----- Timetable: currentttGetData -----
  // POST JSON: { args: [...], _gsh: "...." }  (bei dir genau so)
  async currentttGetData({ args, gsh }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    return await this.http.postJson('/timetable/server/currentttjs?_func=currentttGetData', payload, {
      timeout: 25000,
      headers: { 'Accept': 'application/json,*/*' },
    });
  }
}

module.exports = { EdupageClient };
