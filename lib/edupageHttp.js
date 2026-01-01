'use strict';

const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

class EdupageHttp {
  constructor({ baseUrl, log }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.log = log;

    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      baseURL: this.baseUrl,
      jar: this.jar,
      withCredentials: true,
      timeout: 25000,
      headers: {
        'User-Agent': 'ioBroker.edupage',
        'Accept': '*/*',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    }));
  }

  async get(path, opts = {}) {
    const res = await this.client.get(path, opts);
    return res.data;
  }

  async postForm(path, formObj, opts = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(formObj || {})) {
      params.set(k, String(v));
    }
    const res = await this.client.post(path, params.toString(), {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });
    return res.data;
  }

  async postJson(path, bodyObj, opts = {}) {
    const res = await this.client.post(path, bodyObj, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        'Content-Type': 'application/json; charset=UTF-8',
      },
    });
    return res.data;
  }
}

module.exports = { EdupageHttp };
