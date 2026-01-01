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
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return this.log.error('Please set baseUrl (e.g. https://rs-kollnau.edupage.org)');
    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // subdomain aus baseUrl ableiten (rs-kollnau aus https://rs-kollnau.edupage.org)
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    await this.ensureStates();

    // http+client einmalig erzeugen, Cookies bleiben erhalten
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log, schoolSubdomain });

    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async syncOnce() {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      // 0) optional: getData (manchmal hilfreich)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school,
      });
      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // 2) login (gu/au ggf aus md)
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: '',
        tu: md?.tu ?? null,
        gu: md?.gu ?? `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`,
        au: md?.au ?? null,
      });

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) timetable test (erstmal nur loggen)
      const tt = await this.eduClient.currentttGetData({});
      this.log.info(`currentttGetData type=${typeof tt} keys=${tt && typeof tt === 'object' ? Object.keys(tt).join(',') : ''}`);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  // ... deine ensureStates/writeModel/... bleiben wie sie sind ...

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
