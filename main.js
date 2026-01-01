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

    // werden in onReady erstellt
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

    // maxLessons
    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    // States anlegen
    await this.ensureStates();

    // HTTP + Client erstellen (CookieJar bleibt erhalten)
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // Initial sync
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    // Timer
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async syncOnce() {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      // 0) optional: Login-getData (liefert manchmal tu/gu/au usw.)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school, // subdomain (z.B. rs-kollnau)
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
        gu: md?.gu ?? null,
        au: md?.au ?? null,
      });
      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) timetable holen (currentTT)
      // Wir bauen den gleichen args-Payload wie im Browser (dein Screenshot)
      const { datefrom, dateto, year } = this.getWeekRangeDates(); // Montag..Sonntag dieser Woche
      const table = 'students';
      const id = this.config.studentId || ''; // <- später automatisch, wenn du willst. Für jetzt: optional in Config.
      if (!id) {
        this.log.warn('No studentId configured yet (e.g. -2528). I will still try, but currenttt may require it.');
      }

      // gsh holen (wichtig!)
      // Falls Edupage ihn nicht findet: wir probieren trotzdem ohne, aber meist braucht man ihn.
      const gsh = await this.eduClient.getGsh().catch(() => null);

      const argsObj = {
        year,
        datefrom,
        dateto,
        table,
        id: id || undefined,
        showColors: true,
        showIgroupsInClasses: false,
        showOrig: true,
        log_module: 'CurrentTTView',
      };

      const ttRes = await this.eduClient.currentttGetData({
        args: [null, argsObj],
        gsh,
      });

      // 4) in Model umwandeln + States schreiben
      const model = this.buildModelFromCurrentTT(ttRes);
      await this.writeModel(model);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  // ---------- Helfer: Woche (Montag..Sonntag) ----------
  getWeekRangeDates() {
    const now = new Date();
    const day = (now.getDay() + 6) % 7; // Mo=0
    const monday = new Date(now);
    monday.setDate(now.getDate() - day);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const iso = d => d.toISOString().slice(0, 10);
    return {
      year: Number(iso(monday).slice(0, 4)),
      datefrom: iso(monday),
      dateto: iso(sunday),
    };
  }

  // ---------- Parser: Response -> Model ----------
  buildModelFromCurrentTT(ttRes) {
    const model = this.emptyModel();

    // Erwartet: { r: { ttitems: [...] } }
    const ttitems = ttRes?.r?.ttitems || [];
    if (!Array.isArray(ttitems)) return model;

    const todayStr = model.today.date;
    const tomorrowStr = model.tomorrow.date;

    // wir unterscheiden grob:
    // - lessons: starttime != 00:00 und endtime != 24:00 und type != 'event'
    // - events (Ferien) sind type:'event' und 00:00-24:00
    const isLessonLike = (it) => {
      if (!it) return false;
      if (it.type === 'event') return false;
      if (it.starttime === '00:00' && it.endtime === '24:00') return false;
      return true;
    };

    const toLesson = (it) => ({
      start: it.starttime || '',
      end: it.endtime || '',
      subject: it.subjectname || it.name || it.subjectid || '',
      room: (Array.isArray(it.classroomids) && it.classroomids.join(',')) || '',
      teacher: (Array.isArray(it.teacherids) && it.teacherids.join(',')) || '',
      changed: !!it.changed,
      canceled: !!it.canceled,
      changeText: it.changetext || it.changeText || '',
    });

    const todayLessons = ttitems.filter(it => it.date === todayStr && isLessonLike(it)).map(toLesson);
    const tomorrowLessons = ttitems.filter(it => it.date === tomorrowStr && isLessonLike(it)).map(toLesson);

    // sort by starttime
    todayLessons.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    tomorrowLessons.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    model.today.lessons = todayLessons;
    model.tomorrow.lessons = tomorrowLessons;

    // next: erste kommende lesson (heute sonst morgen)
    const pickNext = (lessons, when) => {
      const now = new Date();
      const nowHHMM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const next = lessons.find(l => (l.start || '') >= nowHHMM) || lessons[0];
      return next ? { when, ...next } : null;
    };

    model.next = pickNext(todayLessons, 'today') || pickNext(tomorrowLessons, 'tomorrow');

    return model;
  }

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [] },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [] },
      next: null,
    };
  }

  // ---------- States ----------
  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastHash', 'string', 'Hash of last model'],
      ['meta.changedSinceLastSync', 'boolean', 'Changed since last sync'],
      ['meta.lastError', 'string', 'Last error message'],

      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],

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

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);

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
