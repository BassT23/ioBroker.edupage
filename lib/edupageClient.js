'use strict';

class EdupageClient {
  /**
   * @param {object} opts
   * @param {import('./edupageHttp').EdupageHttp} opts.http
   * @param {import('@iobroker/adapter-core').Logger} opts.log
   * @param {string} opts.schoolSubdomain e.g. "rs-kollnau"
   */
  constructor({ http, log, schoolSubdomain }) {
    this.http = http;
    this.log = log;
    this.school = schoolSubdomain;
  }

  /**
   * Optional: holt Login-Metadaten (manchmal sind tu/gu/au da drin)
   */
  async getLoginData() {
    // In deiner React-App wird das so geladen:
    // /login/?cmd=MainLogin&akcia=getData
    return await this.http.get(`/login/?cmd=MainLogin&akcia=getData`);
  }

  async getToken({ username, edupage }) {
    return await this.http.rpc('MainLogin', 'getToken', {
      username,
      edupage: edupage || this.school || '',
    });
  }

  /**
   * Login
   */
  async login({ username, password, userToken, edupage, ctxt = '', tu = null, gu = null, au = null }) {
    const payload = {
      username,
      password,
      userToken,
      edupage: edupage || this.school || '',
      ctxt: ctxt || '',
      tu: tu ?? null,
      gu: gu ?? null,
      au: au ?? null,
    };
    return await this.http.rpc('MainLogin', 'login', payload);
  }

  /**
   * Timetable (du hast diesen Endpoint gefunden):
   * POST /timetable/server/currenttt.js?_func=currentttGetData
   *
   * WICHTIG: Falls "empty POST" nicht reicht, musst du den Payload aus DevTools dekodieren
   * und hier als data übergeben. Viele Schulen akzeptieren {} oder "id=..." etc.
   */
  async currentttGetData(data = {}) {
    return await this.http.postForm(`/timetable/server/currenttt.js?_func=currentttGetData`, data);
  }

  /**
   * Viewer Data:
   * POST /timetable/server/tviewer.js?_func=getTTViewerData
   */
  async getTTViewerData(data = {}) {
    return await this.http.postForm(`/timetable/server/tviewer.js?_func=getTTViewerData`, data);
  }
}

module.exports = { EdupageClient };
