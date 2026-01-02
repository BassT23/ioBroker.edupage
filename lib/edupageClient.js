'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    this.gu = null; // ← WICHTIG
  }

  async getLoginData() {
    return await this.http.get('/login/?cmd=MainLogin&akcia=getData');
  }

  async rpcMainLogin(method, params, options = {}) {
    const url = `/login/?cmd=MainLogin&akcia=${encodeURIComponent(method)}`;
    return await this.http.postForm(url, { rpcparams: JSON.stringify(params) }, options);
  }

  async getToken({ username, edupage }) {
    return await this.rpcMainLogin('getToken', { username, edupage });
  }

  async login({ username, password, userToken, edupage, ctxt, tu, gu, au }) {
    const res = await this.rpcMainLogin(
      'login',
      { username, password, userToken, edupage, ctxt, tu, gu, au },
      { timeout: 25000 }
    );

    // 🔑 gu aus Login merken
    if (res?.gu) {
      this.gu = res.gu;
      this.log.debug(`Using timetable referer from login: ${this.gu}`);
    }

    return res;
  }

  async warmUpTimetable() {
    if (!this.gu) throw new Error('No timetable referer (gu) available');

    // GENAU wie Browser
    await this.http.get(this.gu, { headers: { Accept: 'text/html,*/*' } });
  }

  async currentttGetData({ args, gsh }) {
    if (!this.gu) throw new Error('No timetable referer (gu) available');

    const origin = this.http.baseUrl.replace(/\/+$/, '');
    const referer = origin + this.gu;

    return await this.http.postJson(
      '/timetable/server/currentttjs?_func=currentttGetData',
      { args, _gsh: gsh },
      {
        timeout: 25000,
        headers: {
          Accept: 'application/json,*/*',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: origin,
          Referer: referer,
        },
      }
    );
  }
}

module.exports = { EdupageClient };
