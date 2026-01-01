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

    // _gsh cache
    this._gsh = null;
    this._gshFetchedAt = 0;

    // captcha / backoff
    this.blockedUntil = 0;
    this.blockReason = '';
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      // Beispiel-Host IMMER neutral
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // optional: parent accounts often need a student id for the students-table
    // keep it optional, but we will error if missing when we actually fetch timetable
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    await this.ensureStates();

    // http+client einmalig erzeugen, Cookies bleiben erhalten
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  // ===================== states =====================

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.captchaUrl', 'string', 'Captcha URL (open in browser)'],
      ['meta.blockedUntil', 'number', 'Blocked until timestamp (ms)'],
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

  // ===================== sync =====================

  async syncOnce() {
    // backoff/captcha block
    if (this.blockedUntil && Date.now() < this.blockedUntil) {
      const mins = Math.ceil((this.blockedUntil - Date.now()) / 60000);
      this.log.warn(`[Backoff] ${this.blockReason || 'Blocked'}. Next try in ~${mins} min.`);
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
        edupage: this.eduClient.school,
      });
      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // 2) login
      const guFallback = `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`;
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: '',
        tu: md?.tu ?? null,
        gu: md?.gu ?? guFallback,
        au: md?.au ?? null,
      });

      // Captcha detection (common patterns)
      // - loginRes.needCaptcha == '1' with captchaSrc
      // - loginRes.err.error_text contains captcha message
      if (loginRes?.needCaptcha == '1' || (loginRes?.err?.error_text || '').toLowerCase().includes('captcha')) {
        const captchaUrl = this._makeAbsoluteCaptchaUrl(loginRes?.captchaSrc);
        await this._handleCaptchaBlock(
          captchaUrl,
          loginRes?.err?.error_text ||
            'Captcha required by EduPage (suspicious activity).'
        );
        return;
      }

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) get _gsh via getTTViewerData (NOT via HTML parsing)
      const gsh = await this.getOrFetchGsh(true);

      // 4) choose date range (Option A = enableWeek)
      const weekView = !!this.config.enableWeek;
      const { dateFrom, dateTo, year } = this._computeDateRange(weekView);

      // 5) table/id (for parents usually students + studentId)
      const table = (this.config.table || 'students').trim();
      const id = (this.config.studentId || '').trim();

      if (!id) {
        throw new Error(
          'Missing studentId in adapter config (needed for table "students"). ' +
            'Tip: open timetable in browser → Network → currentttGetData → payload → args[1].id'
        );
      }

      // 6) currentttGetData (retry once on 404 by refreshing _gsh)
      let tt;
      try {
        tt = await this.eduClient.currentttGetData({
          args: [
            null,
            {
              year,
              datefrom: dateFrom,
              dateto: dateTo,
              table,
              id,
              showColors: true,
              showIgroupsInClasses: false,
              showOrig: true,
              log_module: 'CurrentTTView',
            },
          ],
          gsh,
        });
      } catch (e) {
        // If 404, gsh may be stale -> refresh once
        const msg = String(e?.message || e);
        if (msg.includes('404')) {
          this.log.warn('Timetable request got 404, refreshing _gsh once and retrying...');
          const gsh2 = await this.getOrFetchGsh(false); // force refresh
          tt = await this.eduClient.currentttGetData({
            args: [
              null,
              {
                year,
                datefrom: dateFrom,
                dateto: dateTo,
                table,
                id,
                showColors: true,
                showIgroupsInClasses: false,
                showOrig: true,
                log_module: 'CurrentTTView',
              },
            ],
            gsh: gsh2,
          });
        } else {
          throw e;
        }
      }

      // 7) build model (minimal: events/lessons -> today/tomorrow)
      const model = this._buildModelFromCurrentTT(tt, { dateFrom, dateTo });
      await this.writeModel(model);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  async getOrFetchGsh(allowCache = true) {
    // cache 30 min
    const maxAgeMs = 30 * 60 * 1000;
    if (allowCache && this._gsh && Date.now() - this._gshFetchedAt < maxAgeMs) {
      return this._gsh;
    }

    const viewer = await this.eduClient.getTTViewerData();
    this._gsh = viewer.gsh;
    this._gshFetchedAt = Date.now();
    return this._gsh;
  }

  _computeDateRange(weekView) {
    const now = new Date();
    const today = new Date(now);
    const tomorrow = new Date(Date.now() + 86400000);

    let dateFrom = today.toISOString().slice(0, 10);
    let dateTo = tomorrow.toISOString().slice(0, 10);

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

    // year in request seems to be week-year; we use current year of dateFrom
    const year = Number(dateFrom.slice(0, 4));
    return { dateFrom, dateTo, year };
  }

  _buildModelFromCurrentTT(tt, { dateFrom, dateTo }) {
    const model = this.emptyModel();

    // Set dates for today/tomorrow
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    model.today.date = today.toISOString().slice(0, 10);
    model.tomorrow.date = tomorrow.toISOString().slice(0, 10);

    const items = tt?.r?.ttitems || [];
    const todayKey = model.today.date;
    const tomorrowKey = model.tomorrow.date;

    // very simple extraction: create "entries" sorted by starttime
    const perDay = { [todayKey]: [], [tomorrowKey]: [] };

    for (const it of items) {
      const d = it?.date;
      if (!d || (!perDay[d] && d !== todayKey && d !== tomorrowKey)) continue;

      // Skip full-day events unless you want them as lesson entries
      const isFullDay = it?.starttime === '00:00' && it?.endtime === '24:00';
      const entry = {
        start: it?.starttime || '',
        end: it?.endtime || '',
        subject: it?.name || it?.subjectname || it?.subjectid || it?.type || '',
        room: (it?.classroomids || []).join(','),
        teacher: (it?.teacherids || []).join(','),
        changed: !!it?.changed,
        canceled: !!it?.cancelled,
        changeText: it?.changetext || '',
      };

      if (isFullDay) {
        // put as first entry for the day (holiday etc.)
        perDay[d] = perDay[d] || [];
        perDay[d].push({ ...entry, start: '00:00', end: '24:00' });
      } else {
        perDay[d] = perDay[d] || [];
        perDay[d].push(entry);
      }
    }

    // sort by time
    const sortByStart = (a, b) => String(a.start || '').localeCompare(String(b.start || ''));

    model.today.lessons = (perDay[todayKey] || []).sort(sortByStart).slice(0, this.maxLessons);
    model.tomorrow.lessons = (perDay[tomorrowKey] || []).sort(sortByStart).slice(0, this.maxLessons);

    // next: pick next upcoming entry from today then tomorrow
    const now = new Date();
    const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const findNext = (dayKey, list) => {
      for (const l of list) {
        if (l.start && l.start !== '00:00' && l.start >= nowHHMM) {
          return { when: dayKey === todayKey ? 'today' : 'tomorrow', ...l };
        }
      }
      return null;
    };

    model.next = findNext(todayKey, model.today.lessons) || findNext(tomorrowKey, model.tomorrow.lessons) || null;

    return model;
  }

  _makeAbsoluteCaptchaUrl(captchaSrc) {
    if (!captchaSrc) return '';
    if (/^https?:\/\//i.test(captchaSrc)) return captchaSrc;
    // relative -> absolute
    const base = this.eduHttp?.baseUrl || '';
    return `${base}${captchaSrc.startsWith('/') ? '' : '/'}${captchaSrc}`;
  }

  async _handleCaptchaBlock(captchaUrl, reason) {
    const blockMinutes = 60;
    this.blockedUntil = Date.now() + blockMinutes * 60 * 1000;
    this.blockReason = 'Captcha required by EduPage';

    await this.setStateAsync('meta.blockedUntil', this.blockedUntil, true);

    if (captchaUrl) {
      await this.setStateAsync('meta.captchaUrl', captchaUrl, true);
    }

    this.setState('info.connection', false, true);

    this.log.error(
      `Captcha nötig / verdächtige Aktivität erkannt. Öffne diese URL im Browser, gib das Passwort erneut ein und tippe den Text aus dem Bild ein:\n` +
        `${captchaUrl || '(no captcha url provided)'}`
    );
    this.log.warn(`[Backoff] Captcha required by EduPage. Next try in ~${blockMinutes} min.`);

    // stop adapter automatically (user requested)
    try {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      // terminate is supported by adapter-core; fallback to "do nothing further"
      if (typeof this.terminate === 'function') {
        // exitCode 0 so it doesn't look like a crash
        this.terminate('Captcha required - stopped by adapter', 0);
      } else {
        this.log.warn('Adapter cannot terminate programmatically in this environment. It will stay idle.');
      }
    } catch (e) {
      this.log.warn(`Could not stop adapter automatically: ${e?.message || e}`);
    }
  }

  // ===================== writing states =====================

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [] },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [] },
      next: null,
    };
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
  module.exports = options => new Edupage(options);
} else {
  new Edupage();
}
