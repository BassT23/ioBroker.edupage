'use strict';

const utils = require('@iobroker/adapter-core');
const { EdupageHttp } = require('./lib/edupageHttp');
const { EdupageClient } = require('./lib/edupageClient');

class Edupage extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'edupage' });

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.timer = null;
    this.maxLessons = 12;

    this.eduHttp = null;
    this.eduClient = null;
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      this.log.error('Please set baseUrl (e.g. https://rs-kollnau.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // subdomain aus baseUrl ableiten (rs-kollnau aus https://rs-kollnau.edupage.org)
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';
    if (!schoolSubdomain) {
      this.log.warn('Could not detect school subdomain from baseUrl. Example: https://rs-kollnau.edupage.org');
    }

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    // States anlegen (damit ensureStates existiert und Adapter nicht crasht)
    await this.ensureStates();

    // http+client einmalig erzeugen, Cookies bleiben erhalten
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({
      http: this.eduHttp,
      log: this.log,
      schoolSubdomain,
    });

    // Initial sync
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    // Interval
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  async syncOnce() {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      // 0) optional: getData (liefert z.B. request_code, storedUsers, ssoLogins, evtl tu/gu/au)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school, // subdomain (z.B. rs-kollnau)
      });

      if (!tokRes?.token) {
        throw new Error(tokRes?.err?.error_text || 'No token');
      }

      // 2) login (gu/au ggf aus md)
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: '',
        tu: md?.tu ?? null,
        // gu ist meist die Zielseite, wo nach login hingeleitet wird
        gu:
          md?.gu ??
          `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`,
        // au ist oft so ein hash/token (kann auch null gehen)
        au: md?.au ?? null,
      });

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) timetable test: currentttGetData (nur loggen!)
      // Du hast im DevTools Payload gesehen: args=[null,{year,datefrom,dateto,table,id},...]
      // -> wir rufen erstmal ohne args auf (oder minimal), Client kann defaulten.
      const tt = await this.eduClient.currentttGetData({});
      const keys =
        tt && typeof tt === 'object' ? Object.keys(tt).slice(0, 30).join(',') : '';

      this.log.info(`currentttGetData OK. type=${typeof tt} keys=${keys}`);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  onUnload(callback) {
    try {
      if (this.timer) clearInterval(this.timer);
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Edupage(options);
} else {
  new Edupage();
}
