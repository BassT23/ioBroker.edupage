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

    // Captcha / Backoff
    this.pausedUntil = 0; // timestamp ms
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    await this.ensureStates();

    // HTTP + Client (Cookies bleiben erhalten)
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // 1x sofort
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    // Intervall
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  // ---------------- states ----------------

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.captchaUrl', 'string', 'Captcha URL if login is blocked'],
      ['meta.pausedUntil', 'number', 'Paused until timestamp (ms)'],

      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],

      // Ferien extra
      ['today.holiday', 'boolean', 'Today is holiday/vacation'],
      ['today.holidayName', 'string', 'Holiday/vacation name today'],
      ['tomorrow.holiday', 'boolean', 'Tomorrow is holiday/vacation'],
      ['tomorrow.holidayName', 'string', 'Holiday/vacation name tomorrow'],

      ['next.when', 'string', 'today|tomorrow'],
      ['next.subject', 'string', 'Next subject'],
      ['next.room', 'string', 'Next room'],
      ['next.teacher', 'string', 'Next teacher'],
      ['next.start', 'string', 'Next start'],
      ['next.end', 'string', 'Next end'],
      ['next.changed', 'boolean', 'Next changed'],
      ['next.canceled', 'boolean', 'Next canceled'],
      ['next.changeText', 'string', 'Next change text'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }

    for (const day of ['today', 'tomorrow']) {
      for (let i = 0; i < this.maxLessons; i++) {
        await this.ensureLessonStates(`${day}.lessons.${i}`);
      }
    }
  }

  async ensureLessonStates(base) {
    const defs = [
      ['exists', 'boolean', 'Lesson exists'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  // ---------------- main sync ----------------

  async syncOnce() {
    // Pause aktiv?
    const now = Date.now();
    if (this.pausedUntil && now < this.pausedUntil) {
      // ruhig bleiben, kein Spam
      return;
    }

    try {
      await this.setStateAsync('meta.lastError', '', true);
      await this.setStateAsync('meta.captchaUrl', '', true);

      // 0) getData (optional)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school, // subdomain
      });

      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // 2) login
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: '',
        tu: md?.tu ?? null,
        gu: md?.gu ?? this.eduClient.getTimetableRefererPath(),
        au: md?.au ?? null,
      });

      // Captcha / suspicious activity?
      // EduPage liefert oft res.needCaptcha / captchaSrc / oder error_text
      const captchaSrc = loginRes?.captchaSrc || loginRes?.err?.captchaSrc;
      const needCaptcha = loginRes?.needCaptcha === '1' || /captcha|verdächt/i.test(String(loginRes?.err?.error_text || ''));

      if (needCaptcha || captchaSrc) {
        const url = captchaSrc
          ? (captchaSrc.startsWith('http') ? captchaSrc : (this.eduHttp.baseUrl.replace(/\/+$/, '') + captchaSrc))
          : '';

        await this.handleCaptchaBlock(url, loginRes?.err?.error_text || 'Captcha required');
        return;
      }

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) timetable warm-up (wichtig gegen "404")
      await this.eduClient.warmUpTimetable();

      // 4) _gsh
      const gsh = await this.eduClient.getGsh();

      // 5) args bauen (Option A: Wochenansicht via enableWeek)
      const model = this.emptyModel();
      const weekView = !!this.config.enableWeek;

      let dateFrom = model.today.date;
      let dateTo = model.tomorrow.date;

      if (weekView) {
        // Mo..So der aktuellen Woche
        const d = new Date();
        const day = (d.getDay() + 6) % 7; // Mo=0
        const monday = new Date(d);
        monday.setDate(d.getDate() - day);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        dateFrom = monday.toISOString().slice(0, 10);
        dateTo = sunday.toISOString().slice(0, 10);
      }

      // studentId aus config (kein Log!)
      const studentId = (this.config.studentId || '').toString().trim();
      if (!studentId) {
        throw new Error('studentId missing. Please set it in the adapter settings.');
      }

      const args = [
        null,
        {
          year: Number(dateFrom.slice(0, 4)),
          datefrom: dateFrom,
          dateto: dateTo,
          table: 'students',
          id: String(studentId),
          showColors: true,
          showIgroupsInClasses: false,
          showOrig: true,
          log_module: 'CurrentTTView',
        },
      ];

      // 6) currentttGetData
      const tt = await this.eduClient.currentttGetData({ args, gsh });

      // 7) model bauen + states schreiben (hier erstmal minimal: Ferien + next/today/tomorrow leer, weil deine Response gerade Ferien-Events zeigt)
      const built = this.buildModelFromTT(tt);

      await this.writeModel(built);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

    } catch (e) {
      this.setState('info.connection', false, true);
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      throw e;
    }
  }

  async handleCaptchaBlock(url, reasonText) {
    // Pause 60 Minuten, Timer stoppen
    const pauseMs = 60 * 60 * 1000;
    this.pausedUntil = Date.now() + pauseMs;

    await this.setStateAsync('meta.pausedUntil', this.pausedUntil, true);
    await this.setStateAsync('meta.captchaUrl', url || '', true);
    await this.setStateAsync('meta.lastError', String(reasonText || 'Captcha required'), true);

    this.setState('info.connection', false, true);

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (url) {
      this.log.error(
        `Captcha nötig / verdächtige Aktivität erkannt. Öffne diese URL im Browser, logge dich neu ein und tippe den Text aus dem Bild ein: ${url}`
      );
    } else {
      this.log.error(
        'Captcha nötig / verdächtige Aktivität erkannt. Öffne EduPage im Browser, logge dich neu ein und löse die Captcha-Abfrage.'
      );
    }

    this.log.warn(`[Backoff] Captcha required by EduPage. Adapter paused for ~60 min. Please restart adapter after solving captcha.`);
  }

  // ---------------- model building ----------------

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [], holiday: false, holidayName: '' },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [], holiday: false, holidayName: '' },
      next: null,
    };
  }

  buildModelFromTT(tt) {
    const model = this.emptyModel();
    const r = tt?.r || tt; // manchmal kommt {r:{...}}

    // Ferien aus ttitems ableiten (type=event, ganztägig)
    const items = Array.isArray(r?.ttitems) ? r.ttitems : [];
    const today = model.today.date;
    const tomorrow = model.tomorrow.date;

    const tHoliday = items.find(x => x?.type === 'event' && x?.date === today && typeof x?.name === 'string' && x.name.toLowerCase().includes('ferien'));
    const tmHoliday = items.find(x => x?.type === 'event' && x?.date === tomorrow && typeof x?.name === 'string' && x.name.toLowerCase().includes('ferien'));

    if (tHoliday) {
      model.today.holiday = true;
      model.today.holidayName = tHoliday.name || '';
    }
    if (tmHoliday) {
      model.tomorrow.holiday = true;
      model.tomorrow.holidayName = tmHoliday.name || '';
    }

    // Lessons Parsing: kommt bei dir später, wenn "normale" Stunden da sind.
    // Für jetzt lassen wir lessons leer (exists=false States werden gesetzt).

    return model;
  }

  // ---------------- state writing ----------------

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);

    await this.setStateAsync('today.holiday', !!model.today.holiday, true);
    await this.setStateAsync('today.holidayName', model.today.holidayName || '', true);
    await this.setStateAsync('tomorrow.holiday', !!model.tomorrow.holiday, true);
    await this.setStateAsync('tomorrow.holidayName', model.tomorrow.holidayName || '', true);

    await this.writeLessons('today', model.today.lessons || []);
    await this.writeLessons('tomorrow', model.tomorrow.lessons || []);

    const n = model.next || {};
    await this.setStateAsync('next.when', n.when || '', true);
    await this.setStateAsync('next.subject', n.subject || '', true);
    await this.setStateAsync('next.room', n.room || '', true);
    await this.setStateAsync('next.teacher', n.teacher || '', true);
    await this.setStateAsync('next.start', n.start || '', true);
    await this.setStateAsync('next.end', n.end || '', true);
    await this.setStateAsync('next.changed', !!n.changed, true);
    await this.setStateAsync('next.canceled', !!n.canceled, true);
    await this.setStateAsync('next.changeText', n.changeText || '', true);
  }

  async writeLessons(dayKey, lessons) {
    for (let i = 0; i < this.maxLessons; i++) {
      const base = `${dayKey}.lessons.${i}`;
      const l = lessons[i] || null;

      await this.setStateAsync(`${base}.exists`, !!l, true);
      await this.setStateAsync(`${base}.start`, l?.start || '', true);
      await this.setStateAsync(`${base}.end`, l?.end || '', true);
      await this.setStateAsync(`${base}.subject`, l?.subject || '', true);
      await this.setStateAsync(`${base}.room`, l?.room || '', true);
      await this.setStateAsync(`${base}.teacher`, l?.teacher || '', true);
      await this.setStateAsync(`${base}.changed`, !!l?.changed, true);
      await this.setStateAsync(`${base}.canceled`, !!l?.canceled, true);
      await this.setStateAsync(`${base}.changeText`, l?.changeText || '', true);
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
