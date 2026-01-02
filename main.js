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

    // Backoff / stop logic
    this.captchaBackoffUntil = 0;
    this.stopOnCaptcha = true; // requested: stop adapter when captcha happens
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      // IMPORTANT: do not use real school name in example text
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // derive subdomain from baseUrl -> "myschool" (do NOT log the real one)
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';

    // config
    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    const weekView = !!this.config.enableWeek;

    // IMPORTANT: avoid logging private IDs; use placeholder in logs
    const studentId = (this.config.studentId ?? '').toString().trim();
    const gsh = (this.config.gsh ?? '').toString().trim();

    await this.ensureStates();

    // init http+client (cookies persist)
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // one-time first sync
    await this.syncOnce({ schoolSubdomain, weekView, studentId, gsh }).catch(e =>
      this.log.warn(`Initial sync failed: ${e?.message || e}`)
    );

    // periodic
    this.timer = setInterval(() => {
      this.syncOnce({ schoolSubdomain, weekView, studentId, gsh }).catch(e =>
        this.log.warn(`Sync failed: ${e?.message || e}`)
      );
    }, intervalMin * 60 * 1000);
  }

  // ----- STATES -----

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.captchaRequired', 'boolean', 'Captcha required by EduPage'],
      ['meta.captchaUrl', 'string', 'Captcha URL (open in browser)'],
      ['meta.captchaUntil', 'number', 'Backoff until timestamp (ms)'],

      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],

      ['week.dateFrom', 'string', 'Week range start (YYYY-MM-DD)'],
      ['week.dateTo', 'string', 'Week range end (YYYY-MM-DD)'],

      ['next.when', 'string', 'today|tomorrow|week'],
      ['next.subject', 'string', 'Next subject'],
      ['next.room', 'string', 'Next room'],
      ['next.teacher', 'string', 'Next teacher'],
      ['next.start', 'string', 'Next start'],
      ['next.end', 'string', 'Next end'],
      ['next.changed', 'boolean', 'Next changed'],
      ['next.canceled', 'boolean', 'Next canceled'],
      ['next.changeText', 'string', 'Next change text'],

      // extra: show holidays/ferien as single datapoint
      ['today.ferien', 'string', 'Holiday/event text if present (today)'],
      ['tomorrow.ferien', 'string', 'Holiday/event text if present (tomorrow)'],
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

    // optional: week view states (reuse today/tomorrow structure; week is handled in model)
    for (let i = 0; i < this.maxLessons; i++) {
      await this.ensureLessonStates(`week.lessons.${i}`);
    }
  }

  async ensureLessonStates(base) {
    const defs = [
      ['exists', 'boolean', 'Lesson exists'],
      ['date', 'string', 'YYYY-MM-DD (for week)'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text'],
      ['type', 'string', 'lesson|event'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  // ----- SYNC -----

  async syncOnce({ schoolSubdomain, weekView, studentId, gsh }) {
    // captcha backoff?
    if (this.captchaBackoffUntil && Date.now() < this.captchaBackoffUntil) {
      const mins = Math.ceil((this.captchaBackoffUntil - Date.now()) / 60000);
      this.log.warn(`[Backoff] Captcha required by EduPage. Next try in ~${mins} min.`);
      return;
    }

    try {
      await this.setStateAsync('meta.lastError', '', true);
      await this.setStateAsync('meta.captchaRequired', false, true);
      await this.setStateAsync('meta.captchaUrl', '', true);

      // 0) getData
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: schoolSubdomain,
      });
      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // 2) login
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: schoolSubdomain,
        ctxt: '',
        tu: md?.tu ?? null,
        gu: md?.gu ?? null,
        au: md?.au ?? null,
      });

      // captcha detection (German message you saw)
      const errText = loginRes?.err?.error_text || '';
      const needCaptcha = /verdächtige|zusätzlich überprüfen|Text aus dem Bild|captcha/i.test(errText);

      if (needCaptcha || loginRes?.needCaptcha === '1' || loginRes?.captchaSrc) {
        const captchaUrl = this.makeAbsoluteUrl(loginRes?.captchaSrc || '');
        await this.handleCaptcha(captchaUrl || null);
        return;
      }

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) warm up timetable (required for endpoint access)
      await this.eduClient.warmUpTimetable();

      // 4) build date range
      const model = this.emptyModel();
      const today = new Date();
      const yyyy = today.getFullYear();

      let dateFrom = model.today.date;
      let dateTo = model.tomorrow.date;

      if (weekView) {
        // Mo..So of current week
        const d = new Date();
        const day = (d.getDay() + 6) % 7; // Mon=0
        const monday = new Date(d);
        monday.setDate(d.getDate() - day);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        dateFrom = monday.toISOString().slice(0, 10);
        dateTo = sunday.toISOString().slice(0, 10);

        await this.setStateAsync('week.dateFrom', dateFrom, true);
        await this.setStateAsync('week.dateTo', dateTo, true);
      }

      // 5) timetable call
      // IMPORTANT: do not log real studentId
      if (!studentId) {
        this.log.warn('No studentId set yet. Please add it in adapter settings (example: 1234).');
        // still set connection true because login worked
        this.setState('info.connection', true, true);
        await this.setStateAsync('meta.lastSync', Date.now(), true);
        return;
      }

      if (!gsh) {
        // tell user to copy from DevTools (do not expose private values)
        throw new Error(
          'Could not detect _gsh automatically. Please copy it from DevTools and put it into adapter settings.'
        );
      }

      const args = [
        null,
        {
          year: yyyy,
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

      const ttRes = await this.eduClient.currentttGetData({ args, gsh });

      // 6) parse model (minimal: holidays/events + next)
      const parsed = this.parseCurrentTt(ttRes, { dateFrom, dateTo, weekView });
      await this.writeModel(parsed);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      const msg = String(e?.message || e);

      await this.setStateAsync('meta.lastError', msg, true);
      this.setState('info.connection', false, true);

      // If 404 on timetable endpoint, log full URL (already safe) but not IDs
      if (msg.includes('404')) {
        this.log.error('Timetable request returned HTTP 404. This usually means missing/invalid referer context.');
      }

      throw e;
    }
  }

  makeAbsoluteUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.eduHttp?.baseUrl || '').replace(/\/+$/, '');
    return base + (path.startsWith('/') ? path : `/${path}`);
  }

  async handleCaptcha(captchaUrl) {
    // store as state (requested)
    await this.setStateAsync('meta.captchaRequired', true, true);
    await this.setStateAsync('meta.captchaUrl', captchaUrl || '', true);

    // backoff 60 minutes
    this.captchaBackoffUntil = Date.now() + 60 * 60 * 1000;
    await this.setStateAsync('meta.captchaUntil', this.captchaBackoffUntil, true);

    if (captchaUrl) {
      this.log.error(
        `Captcha nötig / verdächtige Aktivität erkannt. Öffne diese URL im Browser, gib das Passwort erneut ein und tippe den Text aus dem Bild ein: ${captchaUrl}`
      );
    } else {
      this.log.error(
        'Captcha nötig / verdächtige Aktivität erkannt. Bitte im Browser bei EduPage erneut anmelden und Captcha lösen.'
      );
    }

    // requested: stop adapter automatically when captcha occurs
    if (this.stopOnCaptcha) {
      this.log.warn('Stopping adapter due to captcha requirement (manual restart after captcha solved).');
      // clear timer to stop further retries
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      // terminate adapter
      this.terminate?.('Captcha required by EduPage').catch(() => {});
    }
  }

  // ----- MODEL -----

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [], ferien: '' },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [], ferien: '' },
      week: { dateFrom: '', dateTo: '', lessons: [] },
      next: null,
    };
  }

  parseCurrentTt(ttRes, { weekView }) {
    const model = this.emptyModel();
    const r = ttRes?.r || ttRes?.data?.r || ttRes || {};
    const items = r?.ttitems || [];

    // Ferien / events: pick first matching per day
    const byDateEvents = new Map();
    for (const it of items) {
      if (it?.type === 'event' && it?.date && it?.name) {
        if (!byDateEvents.has(it.date)) byDateEvents.set(it.date, it.name);
      }
    }

    model.today.ferien = byDateEvents.get(model.today.date) || '';
    model.tomorrow.ferien = byDateEvents.get(model.tomorrow.date) || '';

    // For now: store only events as "lessons" so user sees something + next
    // (Real lesson parsing can be added later once non-holiday periods appear.)
    const lessonsToday = [];
    const lessonsTomorrow = [];

    for (const it of items) {
      if (it?.date === model.today.date) lessonsToday.push(this.mapItemToLesson(it));
      if (it?.date === model.tomorrow.date) lessonsTomorrow.push(this.mapItemToLesson(it));
    }

    model.today.lessons = lessonsToday.slice(0, this.maxLessons);
    model.tomorrow.lessons = lessonsTomorrow.slice(0, this.maxLessons);

    // "next" = next item from now (very simple)
    const now = new Date();
    const upcoming = items
      .map(it => {
        if (!it?.date || !it?.starttime) return null;
        const dt = new Date(`${it.date}T${it.starttime}:00`);
        return { it, dt };
      })
      .filter(Boolean)
      .filter(x => x.dt.getTime() >= now.getTime())
      .sort((a, b) => a.dt - b.dt)[0];

    if (upcoming?.it) {
      const it = upcoming.it;
      model.next = {
        when: it.date === model.today.date ? 'today' : it.date === model.tomorrow.date ? 'tomorrow' : weekView ? 'week' : '',
        subject: it.subjectid || it.name || '',
        room: (it.classroomids && it.classroomids[0]) || '',
        teacher: (it.teacherids && it.teacherids[0]) || '',
        start: it.starttime || '',
        end: it.endtime || '',
        changed: false,
        canceled: false,
        changeText: it.type === 'event' ? it.name : '',
      };
    }

    return model;
  }

  mapItemToLesson(it) {
    if (!it) return null;

    if (it.type === 'event') {
      return {
        type: 'event',
        date: it.date || '',
        start: it.starttime || '',
        end: it.endtime || '',
        subject: it.name || '',
        room: '',
        teacher: '',
        changed: false,
        canceled: false,
        changeText: it.name || '',
      };
    }

    // fallback for lesson-like data
    return {
      type: 'lesson',
      date: it.date || '',
      start: it.starttime || '',
      end: it.endtime || '',
      subject: it.subjectid || '',
      room: (it.classroomids && it.classroomids[0]) || '',
      teacher: (it.teacherids && it.teacherids[0]) || '',
      changed: false,
      canceled: false,
      changeText: '',
    };
  }

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);

    await this.setStateAsync('today.ferien', model.today.ferien || '', true);
    await this.setStateAsync('tomorrow.ferien', model.tomorrow.ferien || '', true);

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
      await this.setStateAsync(`${base}.type`, l?.type || '', true);
      await this.setStateAsync(`${base}.date`, l?.date || '', true);
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

  // ----- UNLOAD -----

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
  module.exports = options => new Edupage(options);
} else {
  new Edupage();
}
