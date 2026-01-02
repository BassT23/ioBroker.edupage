'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const m = (http?.baseUrl || '').match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || '';
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
      { username, password, userToken, edupage, ctxt: ctxt || '', tu: tu ?? null, gu: gu ?? null, au: au ?? null },
      { timeout: 25000 }
    );
  }

  getTimetableRefererPath() {
    const eqa = Buffer.from('mode=timetable').toString('base64');
    return `/dashboard/eb.php?eqa=${encodeURIComponent(eqa)}`;
  }

  async warmUpTimetable() {
    // wichtig: in DER adapter-session einmal timetableseiten anfassen (setzt manchmal serverseitige flags)
    await this.http.get(this.getTimetableRefererPath(), { headers: { Accept: 'text/html,*/*' } }).catch(() => null);
    await this.http.get('/timetable/', { headers: { Accept: 'text/html,*/*' } }).catch(() => null);
  }

  async getGsh({ gshOverride } = {}) {
    if (gshOverride && /^[0-9a-f]{8}$/i.test(String(gshOverride))) {
      return String(gshOverride).toLowerCase();
    }
    throw new Error('Could not detect _gsh automatically. Please copy it from DevTools and put it into adapter settings.');
  }

  async currentttGetData({ args, gsh }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    const origin = this.http.baseUrl.replace(/\/+$/, '');
    const referer = origin + this.getTimetableRefererPath();

    return await this.http.postJson('/timetable/server/currentttjs?_func=currentttGetData', payload, {
      timeout: 25000,
      headers: {
        Accept: 'application/json,*/*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: origin,
        Referer: referer,
      },
    });
  }
}

module.exports = { EdupageClient };
