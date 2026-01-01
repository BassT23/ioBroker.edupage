'use strict';

/*
  ioBroker.edupage – main.js (komplett)
  - Login via /login/?cmd=MainLogin (rpcparams)
  - Captcha/verdächtige Aktivität -> Backoff + States + deutlicher Log
  - Timetable: /timetable/server/currentttjs?_func=currentttGetData
  - Schreibt today/tomorrow lessons + next*
*/

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

    // Backoff wenn Captcha aktiv
    this.backoffUntil = 0;

    // cached
    this.eduHttp = null;
    this.eduClient = null;
    this.cachedGsh = null;
  }

  async onReady() {
    this.setState('info.connection', false, true);

    // config
    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      // WICHTIG: Beispieltext soll "myschool" zeigen
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }
    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    await this.ensureStates();

    // http+client erzeugen
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // Initial sync
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    // interval
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  // ---------------- STATES ----------------

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.backoffUntil', 'number', 'Backoff until timestamp (ms)'],
      ['meta.captchaRequired', 'boolean', 'Captcha required by EduPage'],
      ['meta.captchaUrl', 'string', 'Captcha URL (open in browser)'],

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

  // ---------------- CORE ----------------

  captchaTextHit(txt) {
    const s = String(txt || '').toLowerCase();
    return (
      s.includes('captcha') ||
      s.includes('verdächt') ||
      s.includes('zusätzlich überprüfen') ||
      s.includes('text aus dem bild') ||
      s.includes('suspicious')
    );
  }

  async setCaptchaBackoff(captchaUrlMaybe, reason) {
    const backoffMs = 60 * 60 * 1000; // 60 min
    this.backoffUntil = Date.now() + backoffMs;

    const url = captchaUrlMaybe ? String(captchaUrlMaybe) : '';

    this.log.error(
      `Captcha nötig / verdächtige Aktivität erkannt. ` +
      `Ich mache jetzt Backoff (~60 min) und versuche KEIN Login mehr.\n` +
      (url ? `👉 Öffne diese URL im Browser, gib Passwort erneut ein und tippe den Text aus dem Bild ein: ${url}\n` : '') +
      (reason ? `Reason: ${reason}` : '')
    );

    await this.setStateAsync('info.connection', false, true);
    await this.setStateAsync('meta.captchaRequired', true, true);
    await this.setStateAsync('meta.captchaUrl', url, true);
    await this.setStateAsync('meta.backoffUntil', this.backoffUntil, true);
  }

  async clearCaptchaFlags() {
    this.backoffUntil = 0;
    await this.setStateAsync('meta.captchaRequired', false, true);
    await this.setStateAsync('meta.captchaUrl', '', true);
    await this.setStateAsync('meta.backoffUntil', 0, true);
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

  async syncOnce() {
    // Backoff aktiv?
    const now = Date.now();
    if (this.backoffUntil && now < this.backoffUntil) {
      const mins = Math.ceil((this.backoffUntil - now) / 60000);
      this.log.warn(`[Backoff] Captcha active. Skipping sync. Next try in ~${mins} min.`);
      await this.setStateAsync('meta.backoffUntil', this.backoffUntil, true);
      return;
    }

    try {
      await this.setStateAsync('meta.lastError', '', true);

      // 0) login getData (hilft manchmal für tu/gu/au)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school, // aus baseUrl abgeleitet
      });
      if (!tokRes?.token) {
        const msg = tokRes?.err?.error_text || 'No token';
        if (this.captchaTextHit(msg)) {
          await this.setCaptchaBackoff('', msg);
          return;
        }
        throw new Error(msg);
      }

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

      // Captcha-Flag aus Response?
      if (loginRes?.needCaptcha == '1' || loginRes?.captchaSrc) {
        const captchaUrl = loginRes?.captchaSrc
          ? (String(loginRes.captchaSrc).startsWith('http')
              ? String(loginRes.captchaSrc)
              : `${this.eduHttp.baseUrl}${loginRes.captchaSrc}`)
          : '';
        await this.setCaptchaBackoff(captchaUrl, 'loginRes.needCaptcha');
        return;
      }

      if (this.captchaTextHit(loginRes?.err?.error_text)) {
        await this.setCaptchaBackoff('', loginRes?.err?.error_text);
        return;
      }

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // login ok => Captcha flags resetten
      await this.clearCaptchaFlags();

      // 3) _gsh holen (einmal cachen)
      if (!this.cachedGsh) {
        this.cachedGsh = await this.eduClient.getGsh();
        this.log.info(`Detected _gsh=${this.cachedGsh}`);
      }

      // 4) timetable holen
      const model = this.emptyModel();

      // Option A: Woche oder nur Today+Tomorrow (du hast Checkbox "Wochenansicht")
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

      // WICHTIG: "id" kommt aus deinem DevTools Request (bei dir z.B. "-2528")
      // -> Wenn du keinen festen Wert hast, nimm erstmal den aus dem Browser.
      // Du kannst später einen Config-Parameter draus machen.
      const targetId = (this.config.targetId || '').trim() || '-2528';
      const year = Number((dateFrom || '').slice(0, 4)) || new Date().getFullYear();

      const args = [
        null,
        {
          year,
          datefrom: dateFrom,
          dateto: dateTo,
          table: 'students',
          id: targetId,
          showColors: true,
          showIgroupsInClasses: false,
          showOrig: true,
          log_module: 'CurrentTTView',
        },
      ];

      let tt;
      try {
        tt = await this.eduClient.currentttGetData({ args, gsh: this.cachedGsh });
      } catch (e) {
        // 404 sehr häufig: Session/Endpoint/Redirect -> sauber loggen
        const msg = String(e?.message || e || '');
        if (msg.includes('404')) {
          this.log.error(`HTTP 404 on timetable call. URL likely wrong OR not logged in for timetable endpoint.`);
        }
        throw e;
      }

      // 5) in Model umwandeln (minimal: events + lessons)
      // Antwortstruktur: { r: { ttitems:[...] } }
      const items = tt?.r?.ttitems || [];

      // Für dich: Wenn Ferien -> nur events, passt.
      // Wir nehmen "lesson"-ähnliche Einträge (type != event) und mappen grob.
      const lessonsToday = [];
      const lessonsTomorrow = [];

      for (const it of items) {
        const date = it?.date;
        const type = it?.type;

        // Ferien/Event ignorieren als "lesson"
        if (!date || type === 'event') continue;

        const lesson = {
          start: it?.starttime || '',
          end: it?.endtime || '',
          subject: it?.subjectname || it?.name || '',
          room: (it?.classroom || it?.classroomname || '') || '',
          teacher: (it?.teacher || it?.teachername || '') || '',
          changed: !!it?.changed,
          canceled: !!it?.canceled,
          changeText: it?.changetext || '',
        };

        if (date === model.today.date) lessonsToday.push(lesson);
        if (date === model.tomorrow.date) lessonsTomorrow.push(lesson);
      }

      model.today.lessons = lessonsToday.slice(0, this.maxLessons);
      model.tomorrow.lessons = lessonsTomorrow.slice(0, this.maxLessons);

      // next bestimmen (erste kommende lesson heute sonst morgen)
      const pickNext = (arr, when) => {
        if (!arr?.length) return null;
        const n = arr[0];
        return { when, ...n };
      };
      model.next = pickNext(model.today.lessons, 'today') || pickNext(model.tomorrow.lessons, 'tomorrow');

      await this.writeModel(model);

      await this.setStateAsync('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      const msg = String(e?.message || e || '');

      // Captcha auch im Catch erkennen
      if (this.captchaTextHit(msg)) {
        await this.setCaptchaBackoff('', msg);
        return; // nicht werfen => kein Spam
      }

      await this.setStateAsync('meta.lastError', msg, true);
      await this.setStateAsync('info.connection', false, true);
      throw e;
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
