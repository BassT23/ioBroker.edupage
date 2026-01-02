'use strict';

const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

class EdupageHttp {
  constructor({ baseUrl, log }) {
    this.baseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
    this.log = log;

    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        baseURL: this.baseUrl,
        jar: this.jar,
        withCredentials: true,
        timeout: 25000,
        headers: {
          'User-Agent': 'ioBroker.edupage/0.0.2',
          Accept: 'application/json, text/plain, */*',
        },
        validateStatus: (s) => s >= 200 && s < 400, // 302/303 ok (manchmal beim Login)
        maxRedirects: 5,
      })
    );
  }

  _fmtErr(e) {
    const status = e?.response?.status;
    const url = e?.config?.baseURL ? (e.config.baseURL + (e.config.url || '')) : (e?.config?.url || '');
    if (status) return `HTTP ${status} on ${e?.config?.method?.toUpperCase?.() || ''} ${url}`.trim();
    return e?.message || String(e);
  }

  async get(url, options = {}) {
    try {
      const res = await this.http.get(url, options);
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }

  async postJson(url, data, options = {}) {
    try {
      const res = await this.http.post(url, data, {
        ...options,
        headers: {
          ...(options.headers || {}),
          'Content-Type': 'application/json; charset=UTF-8',
        },
      });
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }

  async postForm(url, formObj, options = {}) {
    try {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(formObj || {})) body.append(k, String(v));

      const res = await this.http.post(url, body.toString(), {
        ...options,
        headers: {
          ...(options.headers || {}),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
        },
      });
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }
}

module.exports = { EdupageHttp };
