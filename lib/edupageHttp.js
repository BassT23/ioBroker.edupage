'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const qs = require('querystring');

function sha1Hex(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

function b64encode(buf) {
  return Buffer.from(buf).toString('base64');
}
function b64decodeToBuf(s) {
  return Buffer.from(s, 'base64');
}

function encodeEqapFromForm(formObj, useZip) {
  // wie in JS: $.param(data)
  const cs = qs.stringify(formObj);

  if (useZip) {
    const deflated = zlib.deflateRawSync(Buffer.from(cs, 'utf8'));
    return 'dz:' + b64encode(deflated);
  }
  // “ohne zip” ist im Browser Base64.encode(cs,true) — das ist im Kern base64 von UTF-8
  return b64encode(Buffer.from(cs, 'utf8'));
}

function decodeEqzResponseToText(bodyText) {
  // Browser: wenn eqaz=1 und response beginnt mit "eqz:" => Base64.decode(...)
  if (typeof bodyText !== 'string') return bodyText;
  if (bodyText.startsWith('eqz:')) {
    const raw = bodyText.slice(4);
    return b64decodeToBuf(raw).toString('utf8');
  }
  return bodyText;
}

class EdupageHttp {
  /**
   * @param {{ http: import('axios').AxiosInstance, log?: any }} opts
   */
  constructor(opts) {
    this.http = opts.http;
    this.log = opts.log || console;
    this.maxEqav = 7;
  }

  /**
   * post like EduPage wrapper with eqav retry
   * @param {string} url full url
   * @param {object} formObj object that would normally be sent as form data
   * @param {{ eqaz?: boolean, timeoutMs?: number }} options
   */
  async postWrapped(url, formObj, options = {}) {
    const eqaz = options.eqaz !== false; // default true
    const timeout = options.timeoutMs || 20000;

    // try eqav 1..maxEqav
    for (let eqav = 1; eqav <= this.maxEqav; eqav++) {
      const useZip = (eqav % 2) === 1;      // wie JS: useZip = eqav % 2 == 1
      const useEncryption = eqaz;           // wie JS: useEncryption = !MobileAppBridge.isActive()  -> bei uns: true

      const eqap = encodeEqapFromForm(formObj, useZip);
      const payload = {
        eqap,
        eqacs: sha1Hex(eqap),
        eqaz: useEncryption ? '1' : '0',
      };

      const finalUrl = url + (url.includes('?') ? '&' : '?') + `eqav=${eqav}&maxEqav=${this.maxEqav}`;

      let res;
      try {
        res = await this.http.post(finalUrl, new URLSearchParams(payload), {
          timeout,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          responseType: 'text',
          transformResponse: (r) => r, // kein auto-json
        });
      } catch (e) {
        // Netzwerk/Timeout -> nächster Versuch
        this.log.debug?.(`postWrapped eqav=${eqav} request failed: ${e?.message || e}`);
        if (eqav === this.maxEqav) throw e;
        continue;
      }

      let text = typeof res.data === 'string' ? res.data : String(res.data ?? '');

      // wrongData handling: server kann "eqwd:" voranstellen
      if (text.startsWith('eqwd:')) {
        // Browser: strip + retry next eqav
        this.log.debug?.(`postWrapped eqav=${eqav} got eqwd:, retrying...`);
        continue;
      }

      text = decodeEqzResponseToText(text);

      // jetzt JSON versuchen
      try {
        return JSON.parse(text);
      } catch (e) {
        // manchmal kommt HTML (z.B. redirect) -> retry bzw. Fehler
        this.log.debug?.(`postWrapped eqav=${eqav} JSON parse failed (first 120): ${text.slice(0, 120)}`);
        if (eqav === this.maxEqav) {
          const err = new Error('Unexpected (non-JSON) response from EduPage');
          err.details = text.slice(0, 500);
          throw err;
        }
      }
    }

    throw new Error('postWrapped failed (exhausted eqav retries)');
  }

  // Hilfsfunktion zum Debuggen: eqap -> original querystring
  decodeEqapToQuerystring(eqap) {
    if (!eqap) return '';
    const s = decodeURIComponent(eqap);
    if (s.startsWith('dz:')) {
      const b64 = s.slice(3);
      const buf = b64decodeToBuf(b64);
      const inflated = zlib.inflateRawSync(buf);
      return inflated.toString('utf8'); // das ist dann "rpcparams=....&foo=bar"
    }
    // sonst: plain base64 von utf8 querystring
    return b64decodeToBuf(s).toString('utf8');
  }
}

module.exports = { EdupageHttp };
