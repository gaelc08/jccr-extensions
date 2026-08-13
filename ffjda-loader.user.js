// ==UserScript==
// @name         JCCR Saisie FFJDA — Loader
// @namespace    https://github.com/gaelc08/jccr-gestion
// @version      1.0.0
// @description  Chargeur : télécharge et exécute la dernière version de ffjda-autofill.user.js à chaque chargement de page. À installer UNE fois — les mises à jour du script principal sont ensuite automatiques, sans réinstallation.
// @author       Gaël CANTARERO
// @match        https://moncompte.ffjudo.com/*
// @updateURL    https://raw.githubusercontent.com/gaelc08/jccr-extensions/main/ffjda-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/gaelc08/jccr-extensions/main/ffjda-loader.user.js
// @run-at       document-idle
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      sync.judo-cattenom.fr
// @connect      raw.githubusercontent.com
// ==/UserScript==

/*
 * Pourquoi ce loader ?
 * L'app Userscripts (iOS) ne re-télécharge pas fiablement un script distant :
 * chaque correctif imposait une réinstallation manuelle sur le téléphone.
 * Ce fichier-ci ne change (presque) jamais — il ne fait que récupérer le vrai
 * script et l'exécuter. Tout le code métier vit dans ffjda-autofill.user.js.
 *
 * Le code téléchargé s'exécute dans CE contexte, donc il hérite des @grant
 * déclarés ci-dessus (GM.*, unsafeWindow) : ils doivent rester alignés avec
 * ceux de ffjda-autofill.user.js, y compris les @connect.
 */

(function () {
  'use strict';

  const SRC = 'https://raw.githubusercontent.com/gaelc08/jccr-extensions/main/ffjda-autofill.user.js';
  const CACHE_KEY = 'jcc_ffjda_loader_cache';

  function request(url) {
    return new Promise((resolve, reject) => {
      const handler = (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest
        : (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
      if (!handler) {
        fetch(url, { cache: 'no-store' })
          .then(async (r) => resolve(await r.text()))
          .catch(reject);
        return;
      }
      handler({
        url: `${url}?t=${Date.now()}`,   // casse le cache CDN de GitHub
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('Erreur réseau')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  async function cacheGet() {
    try {
      if (typeof GM !== 'undefined' && GM.getValue) return await GM.getValue(CACHE_KEY, null);
      if (typeof GM_getValue === 'function') return GM_getValue(CACHE_KEY, null);
    } catch (e) {}
    try { return localStorage.getItem(CACHE_KEY); } catch (e) { return null; }
  }

  async function cacheSet(code) {
    try {
      if (typeof GM !== 'undefined' && GM.setValue) { await GM.setValue(CACHE_KEY, code); return; }
      if (typeof GM_setValue === 'function') { GM_setValue(CACHE_KEY, code); return; }
    } catch (e) {}
    try { localStorage.setItem(CACHE_KEY, code); } catch (e) {}
  }

  function banner(msg, color) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:999999;background:${color};
      color:#fff;padding:10px 14px;border-radius:10px;font:13px -apple-system,sans-serif;
      max-width:calc(100vw - 32px);box-shadow:0 8px 32px rgba(0,0,0,.4)`;
    document.body.appendChild(el);
    return el;
  }

  (async () => {
    let code = null;
    try {
      code = await request(SRC);
      await cacheSet(code);          // dernier code connu, pour le mode hors-ligne
    } catch (e) {
      // Réseau indisponible : on retombe sur la dernière version téléchargée.
      code = await cacheGet();
      if (!code) {
        banner('🥋 JCCR : script indisponible (réseau) — ' + e.message, '#8a1c1c');
        return;
      }
      banner('🥋 JCCR : hors-ligne, version en cache utilisée', '#7a4706')
        .style.opacity = '.9';
    }
    try {
      // eval DIRECT (et non `(0, eval)`) : indispensable pour préserver la
      // chaîne de portées. Les gestionnaires de scripts injectent souvent
      // GM.*/unsafeWindow comme variables de closure et non comme globales ;
      // un eval indirect s'exécuterait dans la portée globale et le code
      // chargé ne les verrait pas.
      eval(code);
    } catch (e) {
      banner('🥋 JCCR : erreur d\'exécution — ' + e.message, '#8a1c1c');
      console.error('[JCCR loader]', e);
    }
  })();
})();
