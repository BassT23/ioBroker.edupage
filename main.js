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

    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';
    if (!schoolSubdomain) {
      this.log.warn('Could not detect school subdomain from baseUrl. Expected https://<school>.edupage.org');
    }

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

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],

      // NEU: damit du siehst was erkannt wurde
      ['meta.ttTable', 'string', 'Timetable table (students/classes/teachers/...)'],
      ['meta.ttId', 'string', 'Timetable item id (e.g. student id)'],

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

  async syncOnce() {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      // 0) optional: getData (manchmal hilfreich)
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
        gu: md?.gu ?? `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`,
        au: md?.au ?? null,
      });

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) Ziel (table/id) automatisch finden (als Elternteil wichtig)
      const target = await this.detectTimetableTarget();
      await this.setStateAsync('meta.ttTable', target.table, true);
      await this.setStateAsync('meta.ttId', String(target.id), true);

      // 4) currentttGetData abrufen
      const datefrom = this.isoDate(addDays(new Date(), -3));
      const dateto = this.isoDate(addDays(new Date(), +7));

      const ttRes = await this.eduClient.currentttGetData({
        year: Number(datefrom.slice(0, 4)),
        datefrom,
        dateto,
        table: target.table,
        id: String(target.id),
        showColors: true,
        showOrig: true,
        showIgroupsInClasses: false,
        log_module: 'CurrentTTView',
      });

      const items = ttRes?.r?.ttitems || [];
      this.log.info(`Timetable: got ${items.length} ttitems (first type=${items[0]?.type || 'n/a'})`);

      // Für jetzt: Ferien/Events zeigen funktioniert → später parsen wir Unterricht
      // (Du hast ja schon gesehen: Weihnachtsferien sind korrekt)

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  /**
   * Versucht automatisch "table" und "id" zu finden.
   * Bei Eltern kommt oft "students" + eine negative ID (z.B. -2528).
   */
  async detectTimetableTarget() {
    // 1) Wenn wir es schon mal gespeichert haben → wiederverwenden
    const stTable = await this.getStateAsync('meta.ttTable').catch(() => null);
    const stId = await this.getStateAsync('meta.ttId').catch(() => null);
    if (stTable?.val && stId?.val) {
      return { table: String(stTable.val), id: String(stId.val) };
    }

    // 2) Aus TTViewerData holen
    const v = await this.eduClient.getTTViewerData({}).catch(() => null);
    const r = v?.r || v || null;

    // Häufige Strukturen: allow_my_items / my_items / defaults / etc.
    // Wir suchen irgendeine Liste von "students" und nehmen den ersten Eintrag.
    const cand =
      r?.allow_my_items?.students ||
      r?.allow_my_items?.student ||
      r?.my_items?.students ||
      r?.my_items?.student ||
      r?.students ||
      null;

    if (Array.isArray(cand) && cand.length > 0) {
      // Kandidaten können Objekte sein ({id, name, ...}) oder direkt IDs
      const first = cand[0];
      const id = typeof first === 'object' ? (first.id ?? first.value ?? first.studentid) : first;
      if (id !== undefined && id !== null && String(id).length > 0) {
        this.log.info(`Auto-detected timetable target: table=students id=${id}`);
        return { table: 'students', id: String(id) };
      }
    }

    // 3) Wenn nichts gefunden → klare Fehlermeldung
    this.log.warn(`Could not auto-detect student id from getTTViewerData(). We'll need one manual value once.`);
    throw new Error(
      'Kann Student-ID nicht automatisch finden. Bitte im Browser in Network bei currentttGetData die "table" und "id" aus args[1] kopieren.'
    );
  }

  isoDate(d) {
    return d.toISOString().slice(0, 10);
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

function addDays(d, days) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + days);
  return x;
}

if (require.main !== module) {
  module.exports = (options) => new Edupage(options);
} else {
  new Edupage();
}
