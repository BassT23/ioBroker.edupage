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

  // parent domain URL for cookie checks (edusrs is on .edupage.org)
  parentBaseUrl() {
    // works for *.edupage.org
    const base = this.baseUrlNoSlash();
    const m = base.match(/^https?:\/\/([^/]+)\.edupage\.org$/i);
    if (!m) return '';
    return `https://edupage.org`;
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

  // Browser referer for timetable API:
  getDashboardTimetableRefererPath() {
    return '/dashboard/eb.php?mode=timetable';
  }

  async logCookieNames(tag = '') {
    try {
      const jar = this.http?.jar;
      if (!jar?.getCookies) return;

      const base = this.baseUrlNoSlash();
      const cookiesHost = await jar.getCookies(base);
      const namesHost = cookiesHost.map(c => c.key).sort();

      // also check parent domain cookies
      const parent = this.parentBaseUrl();
      let namesParent = [];
      if (parent) {
        const cookiesParent = await jar.getCookies(parent);
        namesParent = cookiesParent.map(c => c.key).sort();
      }

      this.log.info(
        `Cookies${tag ? ' ' + tag : ''}: host=[${namesHost.join(', ')}] parent=[${namesParent.join(', ')}]`
      );
    } catch {
      // ignore
    }
  }

  async hasCookie(name) {
    const jar = this.http?.jar;
    if (!jar?.getCookies) return false;

    const base = this.baseUrlNoSlash();
    const parent = this.parentBaseUrl();

    const cookiesHost = await jar.getCookies(base).catch(() => []);
    if (cookiesHost.some(c => c.key === name)) return true;

    if (parent) {
      const cookiesParent = await jar.getCookies(parent).catch(() => []);
      if (cookiesParent.some(c => c.key === name)) return true;
    }

    return false;
  }

  /**
   * Warmup flow closer to browser:
   * 1) GET /login/           (often sets/refreshes edusrs on .edupage.org)
   * 2) GET /
   * 3) GET /dashboard/
   * 4) GET /dashboard/eb.php?mode=timetable
   *
   * We CHECK edusrs afterwards (warn if missing).
   */
  _extractEduSrsFromHtml(html) {
    const s = typeof html === 'string' ? html : '';

    // Typical patterns:
    // document.cookie="edusrs=....; ..."
    // document.cookie = 'edusrs=....; ...'
    const m1 = s.match(/document\.cookie\s*=\s*["'][^"']*edusrs=([^;"']+)/i);
    if (m1?.[1]) return m1[1];

    // Sometimes split differently
    const m2 = s.match(/\bedusrs=([0-9A-Za-z%._-]+)/i);
    if (m2?.[1]) return m2[1];

    return '';
  }


  async warmUpTimetable() {
    const baseUrl = this.baseUrlNoSlash();
    const rootRef = `${baseUrl}/`;
    const loginRef = `${baseUrl}/login/`;
    const dashRef = `${baseUrl}/dashboard/`;

    await this.http.get('/login/', {
      headers: { Accept: 'text/html,*/*', Referer: rootRef },
    }).catch(() => {});

    await this.http.get('/', {
      headers: { Accept: 'text/html,*/*', Referer: loginRef },
    }).catch(() => {});

    await this.http.get('/dashboard/', {
      headers: { Accept: 'text/html,*/*', Referer: rootRef },
    }).catch(() => {});

    // IMPORTANT: capture HTML from timetable view
    const p = this.getDashboardTimetableRefererPath();
    let timetableHtml = '';
    try {
      timetableHtml = await this.http.get(p, {
        headers: { Accept: 'text/html,*/*', Referer: dashRef },
      });
    } catch {
      // ignore
    }

    await this.logCookieNames('[after warmup]');

    // If edusrs is missing, try to extract it from HTML and set cookie manually
    const ok = await this.hasCookie('edusrs');
    if (!ok && typeof timetableHtml === 'string' && timetableHtml.length) {
      const val = this._extractEduSrsFromHtml(timetableHtml);
      if (val) {
        try {
          // Set for parent domain
          await this.http.jar.setCookie(
            `edusrs=${val}; Domain=.edupage.org; Path=/; Secure; SameSite=None`,
            baseUrl
          );
          this.log.info('edusrs extracted from HTML and stored into cookie jar.');
        } catch (e) {
          this.log.warn(`Failed to store edusrs extracted from HTML: ${e?.message || e}`);
        }

        await this.logCookieNames('[after edusrs inject]');
      } else {
        this.log.warn(
          'Cookie "edusrs" missing and could not be extracted from timetable HTML. ' +
          'Next step: we need to inspect the returned HTML head snippet to find how edusrs is created.'
        );

        // optional: show safe snippet head to debug (no IDs)
        this.log.info(`Timetable HTML head (200 chars): ${timetableHtml.slice(0, 200)}`);
      }
    }

    if (!(await this.hasCookie('edusrs'))) {
      this.log.warn(
        'Cookie "edusrs" is STILL missing after warmup. Timetable API will likely return {"reload":true}.'
      );
    }
  }

  async getGsh() {
    throw new Error('Auto _gsh disabled. Please set _gsh in adapter config from DevTools (8 hex).');
  }

  getCurrentTtPath() {
    return '/timetable/server/currenttt.js?__func=curentttGetData';
  }

  async currentttGetData({ args, gsh, guPath } = {}) {
    // always warmup (creates cookies + context)
    await this.warmUpTimetable({ guPath });

    const payload = {
      __args: args,
      __gsh: gsh,
    };

    const baseUrl = this.baseUrlNoSlash();
    const referer = baseUrl + this.getDashboardTimetableRefererPath();

    // --- DEBUG: what cookies will be sent to this endpoint?
    const cookieNames = await this.http.cookieNamesFor(this.getCurrentTtPath());
    this.log.info(`Cookies [for currenttt]: ${cookieNames.join(', ')}`);

    const cookieStr = await this.http.cookieStringFor(this.getCurrentTtPath());
    const cookieNameList = cookieStr
      .split(';')
      .map(s => s.split('=')[0].trim())
      .filter(Boolean)
      .join(', ');
    this.log.info(`Cookie header [for currenttt] (names): ${cookieNameList}`);
    // --- /DEBUG

    const headers = {
      Accept: '*/*',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      Referer: referer,
      Origin: baseUrl,
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };

    // return RAW: { data, status, headers }
    return await this.http.postJsonRaw(this.getCurrentTtPath(), payload, { timeout: 25000, headers });
  }
}

module.exports = { EdupageClient };
