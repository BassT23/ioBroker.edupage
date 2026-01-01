'use strict';

const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const qs = require('querystring');

class EdupageHttp {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl e.g. https://rs-kollnau.edupage.org
   * @param {import('@iobroker/adapter-core').Logger} opts.log
   */
  constructor({ baseUrl, log }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.log = log;

    this.jar = new CookieJar();
    this.http = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': 'ioBroker.edupage/0.0.1',
        'Accept': 'application/json, text/plain, */*',
      },
      // EduPage antwortet manchmal mit text/html, obwohl JSON drin ist:
      validateStatus: (s) => s >= 200 && s < 400,
    }));
  }

  /**
   * POST application/x-www-form-urlencoded
   */
  async postForm(path, data, extra = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const body = qs.stringify(data || {});
    const res = await this.http.post(url, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      ...extra,
    });

    // axios versucht JSON automatisch nur wenn content-type json ist.
    // EduPage liefert aber manchmal text/html; wir parsen dann manuell.
    return this._maybeJson(res.data);
  }

  async get(path, extra = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await this.http.get(url, extra);
    return this._maybeJson(res.data);
  }

  /**
   * EduPage RPC: POST /login/?cmd=MainLogin&akcia=<method> with rpcparams=JSON
   */
  async rpc(cmd, method, params, options = {}) {
    const url = `/login/?cmd=${encodeURIComponent(cmd)}&akcia=${encodeURIComponent(method)}`;
    const payload = { rpcparams: JSON.stringify(params || {}) };
    return await this.postForm(url, payload, options);
  }

  _maybeJson(data) {
    if (data == null) return data;
    if (typeof data === 'object') return data;

    const s = String(data).trim();

    // manchmal kommt ")]}'," oder ähnliches nicht; meistens direkt JSON
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.parse(s); } catch { /* ignore */ }
    }
    return s;
  }
}

module.exports = { EdupageHttp };
