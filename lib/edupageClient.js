'use strict';

const { EdupageHttp } = require('./edupageHttp');

class EdupageClient {
  /**
   * @param {{ http: import('axios').AxiosInstance, baseUrl: string, log?: any }} opts
   */
  constructor(opts) {
    this.baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
    this.log = opts.log || console;
    this.ehttp = new EdupageHttp({ http: opts.http, log: this.log });
  }

  async getToken({ username, edupage }) {
    const url = `${this.baseUrl}/login/?cmd=MainLogin&akcia=getToken`;
    // AscHttp.rpc schickt: { rpcparams: JSON.stringify(params) }
    return this.ehttp.postWrapped(url, {
      rpcparams: JSON.stringify({ username, edupage: edupage || '' })
    });
  }

  async login({ username, password, userToken, edupage, ctxt, tu, gu, au }) {
    const url = `${this.baseUrl}/login/?cmd=MainLogin&akcia=login`;
    return this.ehttp.postWrapped(url, {
      rpcparams: JSON.stringify({
        username,
        password,
        userToken,
        edupage: edupage || '',
        ctxt: ctxt || '',
        tu: tu ?? null,
        gu: gu ?? null,
        au: au ?? null,
      })
    });
  }

  async getCurrentTimetable() {
    // du hast es im Network: /timetable/server/currenttt.js?_func=currentttGetData
    const url = `${this.baseUrl}/timetable/server/currenttt.js?_func=currentttGetData`;

    // ⚠️ WICHTIG:
    // Welche POST-Parameter genau erwartet werden hängt von der Seite ab.
    // Oft ist es leer oder sowas wie { "__args": ... }.
    // Deshalb erstmal "leer" probieren.
    //
    // Wenn es bei dir nicht klappt, müssen wir den decoded eqap anschauen (siehe Anleitung unten).
    return this.ehttp.postWrapped(url, {});
  }

  async getTTViewerData() {
    const url = `${this.baseUrl}/timetable/server/ttviewer.js?_func=getTTViewerData`;
    return this.ehttp.postWrapped(url, {});
  }
}

module.exports = { EdupageClient };
