// ==UserScript==
// @name         JCCR Saisie FFJDA (mobile / Safari)
// @namespace    https://github.com/gaelc08/jccr-gestion
// @version      1.3.0
// @description  Portage mobile de l'extension Chrome JCCR — pré-remplit le formulaire de licence FFJDA depuis les adhérents synchronisés HelloAsso. Panneau flottant, queue batch, fonctionne avec l'app "Userscripts" sur iOS Safari.
// @author       Gaël CANTARERO
// @match        https://moncompte.ffjudo.com/*
// @updateURL    https://raw.githubusercontent.com/gaelc08/jccr-extensions/main/ffjda-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/gaelc08/jccr-extensions/main/ffjda-autofill.user.js
// @run-at       document-idle
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      sync.judo-cattenom.fr
// ==/UserScript==

// ─────────────────────────────────────────────────────────────────────────────
// GÉNÉRÉ — ne pas éditer ce fichier.
// Assemblé par scripts/build-userscript.js depuis :
//   • extension/lib/ffjda-flow.js          (partagé avec l'extension Chrome)
//   • userscripts/ffjda-autofill.user.js   (panneau, file d'attente, API)
// Toute correction se fait dans ces sources, puis rebuild.
// ─────────────────────────────────────────────────────────────────────────────
// ffjda-flow.js — SOURCE UNIQUE de l'automatisation du portail FFJDA.
//
// Consommé par les deux surfaces :
//   • extension Chrome  — `importScripts('/lib/ffjda-flow.js')` dans le service
//     worker, puis injection via chrome.scripting.executeScript({ func })
//   • userscript mobile — concaténé dans ffjda-autofill.user.js au build
//     (scripts/build-userscript.js), qui l'appelle directement : il s'exécute
//     déjà dans le contexte de la page
//
// ── Pourquoi UNE seule grosse fonction `applyStep` ? ──────────────────────────
// chrome.scripting.executeScript({ func }) SÉRIALISE la fonction (via
// Function.prototype.toString) pour l'exécuter dans la page : elle ne peut donc
// référencer AUCUNE variable de sa portée englobante. Découper en petites
// fonctions obligerait à redéfinir les helpers (setNativeValue, norm…) dans
// chacune — c'est exactement la duplication qui a fait diverger l'extension et
// le userscript. Une fonction unique et auto-suffisante les partage en interne.
//
// `detectStep` reste à part : elle est pure et n'est jamais injectée (le service
// worker l'appelle chez lui, le userscript aussi).

(function (root) {
  'use strict';

  /**
   * Étape du parcours FFJDA déduite de l'URL courante.
   * Retourne null si la page n'appartient pas au parcours.
   */
  function detectStep(url) {
    if (!url) return null;
    // Renouvellement
    if (/\/fiche-licence\/select\//.test(url))                              return 'renew_fiche';
    if (url.includes('/achat-licence/renouvellement-licence-club/etape_1')) return 'renew_form';
    if (url.includes('/renouvellement-licencie-club')) {
      // "RECHERCHER" ne remplit pas la page en place : il NAVIGUE vers cette
      // même URL avec les critères en query string (?nom=…&prenom=…) puis
      // charge les résultats en asynchrone. Sans distinguer les deux états,
      // on re-remplirait le formulaire en boucle au lieu d'attendre.
      return (/[?&]nom=[^&#]/.test(url) || url.includes('resultats_recherche'))
        ? 'renew_results'
        : 'renew_search';
    }
    // Nouvelle licence
    if (url.includes('/achat-licence/creation-licence-club/etape_1'))       return 'etape2';
    if (url.includes('/saisir-licence/etape-2'))                            return 'intermediaire';
    if (url.includes('/saisir-licence'))                                     return 'etape1';
    if (url.includes('/prise-licence'))                                      return 'depart';
    return null;
  }

  /**
   * Exécute une action dans la page FFJDA. AUTO-SUFFISANTE : ne référence rien
   * hors de son propre corps (contrainte de sérialisation, voir en-tête).
   *
   * @param {string} action  'search' | 'findLink' | 'clickLink' | 'clickRenew'
   *                         | 'clickCreate' | 'etape1' | 'etape2'
   * @param {object} adherent
   */
  async function applyStep(action, adherent) {
    adherent = adherent || {};

    // ── Helpers partagés par toutes les actions ──────────────────────────────

    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    // MAJUSCULES, sans accents, espaces normalisés — pour comparer des noms.
    function normName(s) {
      return (s || '').toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[\s-]+/g, ' ').trim();
    }
    // minuscules sans accents — pour comparer des libellés.
    function normText(s) {
      return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    }
    // Comparaison des options select2 (tirets assimilés à des espaces).
    function normOpt(s) { return (s || '').toUpperCase().replace(/-/g, ' '); }

    // Affecter `el.value` ne suffit pas : les formulaires FFJDA sont pilotés
    // par un framework qui suit sa propre copie de la valeur et ignore une
    // écriture directe — il soumettrait alors un champ vide. Le setter natif
    // du prototype déclenche son tracking, comme une vraie frappe clavier.
    function setNativeValue(el, val) {
      const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
                  : (el instanceof HTMLSelectElement)   ? HTMLSelectElement.prototype
                  : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      try { el.focus(); } catch (e) {}
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    }

    // Séquence de clic complète : certains handlers FFJDA écoutent
    // mousedown/mouseup plutôt que click.
    function realClick(el) {
      ['mousedown', 'mouseup', 'click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
      );
    }

    function setByName(name, val) {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el || val == null) return false;
      setNativeValue(el, val);
      return true;
    }
    function readByName(name) {
      const el = document.querySelector(`[name="${name}"]`);
      return el ? el.value : null;
    }
    // Radio : un vrai clic est nécessaire, le framework ignore 'change' seul.
    function setRadio(name, val) {
      const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
      if (!el) return false;
      if (!el.checked) el.click();
      el.checked = true;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    function setCheck(id, checked) {
      const el = document.getElementById(id) || document.querySelector(`input[name="${id}"]`);
      if (!el) return false;
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // Sélectionne l'option d'un <select> dont le TEXTE contient `text`.
    function selectByText(name, text) {
      const sel = document.querySelector(`select[name="${name}"]`);
      if (!sel) return false;
      const nt = normText(text);
      const opt = Array.from(sel.options).find(o => normText(o.textContent).includes(nt));
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    // Le lien PORTANT LE NOM ("FICHET CELINE") ouvre la fiche de
    // renouvellement. Le lien "Fiche licence" de la même ligne mène à la
    // consultation — une impasse qui ne se rend pas (page blanche). Pas de
    // filtre sur [href] : ce lien peut n'en porter aucun, son action étant en JS.
    function findNameLink() {
      const nomA    = normName(adherent.nom);
      const prenomA = normName(adherent.prenom);
      return Array.from(document.querySelectorAll('a')).find(a => {
        const t = normName(a.textContent);
        return t.includes(nomA) && t.includes(prenomA);
      }) || null;
    }

    // jQuery de la PAGE. `unsafeWindow` n'existe que sous un gestionnaire de
    // userscripts ; dans le monde MAIN de l'extension, `window` suffit.
    function pageJQuery() {
      const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
      return w.jQuery;
    }

    // ── Actions simples ──────────────────────────────────────────────────────

    if (action === 'findLink') {
      if (findNameLink()) return { found: true };
      const noResult = Array.from(document.querySelectorAll('p, div, span'))
        .some(el => el.textContent.toLowerCase().includes('aucun licencié'));
      return { found: false, noResult };
    }

    if (action === 'clickLink') {
      const el = findNameLink();
      if (!el) return false;
      el.click();
      return true;
    }

    if (action === 'clickRenew') {
      const candidates = Array.from(document.querySelectorAll('a, button'));
      const btn = candidates.find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t.includes('renouveler') || t.includes('renouvellement');
      });
      if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
      // Renvoie les libellés présents, pour diagnostiquer un sélecteur obsolète.
      return {
        clicked: false,
        available: candidates
          .filter(el => el.textContent.trim().length > 1 && el.textContent.trim().length < 60)
          .map(el => el.textContent.trim())
          .slice(0, 10),
      };
    }

    if (action === 'clickCreate') {
      const btn = Array.from(document.querySelectorAll('a.big-btn'))
        .find(a => a.textContent.trim().toLowerCase().includes('créer une licence'));
      if (btn) { btn.click(); return true; }
      return false;
    }

    // ── Recherche d'un licencié à renouveler ─────────────────────────────────

    if (action === 'search') {
      setByName('nom',    adherent.nom);
      setByName('prenom', adherent.prenom);

      // Laisse au framework le temps d'enregistrer la saisie avant de soumettre.
      await wait(350);

      // Le bouton peut être un <button> ou un <input type="submit"> ; on ignore
      // "AFFICHER TOUTES LES LICENCES" (qui ne contient pas "RECHERCHER").
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(b => ((b.textContent || b.value || '').trim().toUpperCase()).includes('RECHERCHER'));

      // Champs relus : si le framework a ignoré la saisie, la recherche
      // partirait à vide et l'appelant peut le signaler immédiatement plutôt
      // que d'attendre un timeout sur une page de résultats vide.
      const state = { nom: readByName('nom'), prenom: readByName('prenom') };
      if (!btn) return Object.assign({ clicked: false, reason: 'Bouton RECHERCHER introuvable' }, state);

      realClick(btn);
      return Object.assign({ clicked: true, btn: (btn.textContent || btn.value || '').trim() }, state);
    }

    // ── Étape 1 nouvelle licence : identité ──────────────────────────────────

    if (action === 'etape1') {
      let f = 0;
      if (setByName('nom',       adherent.nom))                       f++;
      if (setByName('prenom',    adherent.prenom))                    f++;
      if (setByName('sexe',      adherent.sexe === 'F' ? 'F' : 'M')) f++;
      if (setByName('naissance', adherent.date_naissance || ''))      f++;

      await wait(400);

      const state = {
        nom: readByName('nom'), prenom: readByName('prenom'), naissance: readByName('naissance'),
      };
      const btn = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find(b => ((b.textContent || b.value || '').trim().toLowerCase()).includes('valider'));
      if (btn) realClick(btn);

      return Object.assign(
        { step: 1, success: f > 0 && !!state.nom && !!state.prenom, filled: f, submitted: !!btn },
        state
      );
    }

    // ── Étape 2, commune aux nouvelles licences et aux renouvellements ───────

    if (action === 'etape2') {
      // Assurance IAC — TOUJOURS "Oui". Le mapping FFJDA est INVERSÉ :
      // value="0" = « Oui » (souscrire), value="1" = « Non » (refus, qui OUVRE
      // un modal Bootstrap). On coche donc value="0" et on désélectionne
      // value="1" SANS JAMAIS le cliquer, pour ne pas déclencher ce modal.
      // Ré-appliqué avant "Suivant" : remplir le CP/l'adresse (select2)
      // déclenche un recalcul FFJDA qui remet la souscription sur "Non".
      function ensureIAC() {
        const oui = document.querySelector('input[name="souscription"][value="0"]');
        const non = document.querySelector('input[name="souscription"][value="1"]');
        if (non) non.checked = false;
        let okRadio = false;
        if (oui) {
          if (!oui.checked) oui.click();   // clic réel : réveille le handler
          oui.checked = true;              // puis verrouille l'état
          const lbl = oui.id && document.querySelector(`label[for="${oui.id}"]`);
          if (lbl) lbl.dispatchEvent(new MouseEvent('click', { bubbles: true })); // idempotent sur un radio
          oui.checked = true;
          oui.dispatchEvent(new Event('input',  { bubbles: true }));
          oui.dispatchEvent(new Event('change', { bubbles: true }));
          okRadio = oui.checked;
        } else {
          console.log('[JCCR] IAC: radio input[name="souscription"][value="0"] introuvable');
        }
        // Case "assurance" : pas de clic sur le label, il RE-BASCULERAIT la case.
        let okCase = false;
        const ass = document.querySelector('input[name="assurance"]');
        if (ass) {
          if (!ass.checked) ass.click();
          ass.checked = true;
          ass.dispatchEvent(new Event('input',  { bubbles: true }));
          ass.dispatchEvent(new Event('change', { bubbles: true }));
          okCase = ass.checked;
        } else {
          console.log('[JCCR] IAC: case input[name="assurance"] introuvable');
        }
        return okRadio || okCase;
      }

      function clickOpt(el) {
        ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(type =>
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
        );
      }

      // Champs adresse : select2 alimenté en AJAX, il faut ouvrir, taper, attendre.
      function fillSelect2(selectName, searchText, targetText) {
        return new Promise(resolve => {
          const jq = pageJQuery();
          if (!jq) { resolve(false); return; }
          jq('.select2-container--open [name]').each(function () {
            try { jq(this).select2('close'); } catch (e) {}
          });
          const $sel = jq(`[name="${selectName}"]`);
          if (!$sel.length || !$sel.data('select2')) { resolve(false); return; }
          setTimeout(() => {
            $sel.select2('open');
            setTimeout(() => {
              const input = document.querySelector('.select2-container--open .select2-search__field');
              if (!input) { $sel.select2('close'); resolve(false); return; }
              input.focus(); input.value = searchText;
              input.dispatchEvent(new Event('input',         { bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              setTimeout(() => {
                const opts = document.querySelectorAll(
                  '.select2-container--open .select2-results__option:not(.select2-results__option--disabled):not(.select2-results__option--loading)'
                );
                const nt = normOpt(targetText);
                let match = Array.from(opts).find(o => normOpt(o.textContent).includes(nt));
                if (!match && opts[0]) match = opts[0];
                if (match) { clickOpt(match); setTimeout(() => resolve(true), 400); }
                else { $sel.select2('close'); resolve(false); }
              }, 1500);
            }, 500);
          }, 200);
        });
      }

      // Garde ceinture/grade : on n'y touche JAMAIS, mais un autre champ
      // (discipline, adresse…) peut la réinitialiser par effet de bord côté
      // framework. On mémorise son état avant saisie pour le restaurer avant
      // de valider l'étape.
      function snapshotBelt() {
        return Array.from(document.querySelectorAll('[name*="ceinture"], [name*="grade"]'))
          .map(el => ({ el, value: el.value, checked: el.checked }));
      }
      function restoreBelt(snap) {
        snap.forEach(({ el, value, checked }) => {
          let changed = false;
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked !== checked) { el.checked = checked; changed = true; }
          } else if (el.value !== value) {
            el.value = value; changed = true;
          }
          if (changed) el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }

      let f = 0;
      const beltSnap = snapshotBelt();

      if (adherent.telephone) setByName('portable', adherent.telephone) && f++;
      if (adherent.email) {
        setByName('mail',         adherent.email) && f++;
        setByName('mail-confirm', adherent.email) && f++;
      }
      // Dojo (A ou B) — Dojo A par défaut
      if (adherent.dojo && setByName('dojo-code', adherent.dojo)) f++;
      if (setByName('pratiques_1', adherent.pratique || '1')) f++;
      // Loisir/Compétition découle de la DISCIPLINE (règle président), pas de
      // la donnée individuelle : judo ('1') et iaïdo ('13') → 'C' ;
      // taïso ('3') et tout autre → 'L'.
      const tpl = (adherent.pratique === '1' || adherent.pratique === '13') ? 'C' : 'L';
      if (setRadio('type_pratique_1', tpl)) f++;
      setRadio('handicap', '0');
      // Certificat médical : découle aussi de la discipline, JAMAIS "En attente".
      // `adherent.certificat` est un STATUT d'upload ('UPLOADED'…), inutilisable
      // comme valeur du select. Taïso → 'SP' ; judo, iaïdo et tout autre → 'SC'.
      const cert = (adherent.pratique === '3') ? 'SP' : 'SC';
      if (setByName('certificat', cert) || selectByText('certificat', cert === 'SP' ? 'sportif' : 'compétition')) f++;
      if (adherent.certificat === 'QU') setCheck('chk_questionnaire', true);
      if (setRadio('fonction', adherent.fonction || '4')) f++;
      setCheck('newsletter', false);
      if (ensureIAC()) f++;
      setCheck('rgpd', true);

      const cpEl  = document.querySelector('[name="cp"]');
      const hasCP = cpEl && cpEl.value && cpEl.value.trim().length > 0;

      if (!hasCP && adherent.code_postal) {
        const cpTarget = adherent.ville
          ? `${adherent.code_postal} ${adherent.ville}`
          : adherent.code_postal;
        if (await fillSelect2('cp', adherent.code_postal, cpTarget)) f++;
        await wait(1200);
        if (adherent.adresse) {
          if (await fillSelect2('adresse', adherent.adresse, adherent.adresse)) f++;
        }
      }

      await wait(400);
      restoreBelt(beltSnap);
      ensureIAC();
      await wait(300);

      // Dernière vérification avant de valider : "Oui" (value=0) bien actif.
      const oui = document.querySelector('input[name="souscription"][value="0"]');
      if (!oui || !oui.checked) ensureIAC();

      const suivant = Array.from(document.querySelectorAll('button.big-btn[type="submit"]'))
        .find(b => b.textContent.trim().toLowerCase().includes('suivant'));
      if (suivant) { suivant.click(); f++; }
      return { step: 2, success: f > 0, filled: f, submitted: !!suivant };
    }

    return { error: `Action inconnue : ${action}` };
  }

  root.FfjdaFlow = { detectStep, applyStep };
})(typeof self !== 'undefined' ? self : this);



(function () {
  'use strict';

  // Affiché dans l'en-tête du panneau : permet de vérifier d'un coup d'œil
  // quelle version tourne réellement (l'app Userscripts peut servir une
  // copie en cache). À garder synchro avec @version en tête de fichier.
  const SCRIPT_VERSION = '1.3.0';

  // ================================================================
  // Stockage — GM.* (async, moderne) avec repli GM_* (sync, legacy)
  // puis localStorage si le gestionnaire ne fournit aucune des deux.
  // ================================================================
  const NS = 'jcc_ffjda_';

  async function storeGet(key, def) {
    try {
      if (typeof GM !== 'undefined' && GM.getValue) return await GM.getValue(NS + key, def);
    } catch (e) {}
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(NS + key, def);
    } catch (e) {}
    try {
      const v = localStorage.getItem(NS + key);
      return v != null ? JSON.parse(v) : def;
    } catch (e) { return def; }
  }

  async function storeSet(key, val) {
    try {
      if (typeof GM !== 'undefined' && GM.setValue) { await GM.setValue(NS + key, val); return; }
    } catch (e) {}
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(NS + key, val); return; }
    } catch (e) {}
    try { localStorage.setItem(NS + key, JSON.stringify(val)); } catch (e) {}
  }

  // ================================================================
  // Client API sync.judo-cattenom.fr — GM.xmlHttpRequest pour
  // contourner le CORS depuis l'origine moncompte.ffjudo.com.
  // ================================================================
  const API_BASE = 'https://sync.judo-cattenom.fr';

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      const handler = (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest
        : (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
      if (handler) {
        handler(Object.assign({}, opts, {
          onload: (res) => resolve(res),
          onerror: (err) => reject(new Error((err && err.error) || 'Erreur réseau (GM.xmlHttpRequest)')),
          ontimeout: () => reject(new Error('Timeout requête API')),
        }));
      } else {
        // Repli fetch() — peut échouer en cross-origin si le serveur ne
        // renvoie pas Access-Control-Allow-Origin pour moncompte.ffjudo.com.
        fetch(opts.url, { method: opts.method || 'GET', headers: opts.headers, body: opts.data })
          .then(async (r) => resolve({ status: r.status, responseText: await r.text() }))
          .catch(reject);
      }
    });
  }

  async function apiCall(endpoint, { method = 'GET', body } = {}) {
    const token = await storeGet('token', null);
    if (!token) {
      return { status: 401, data: { detail: 'Token API non configuré.' }, ok: false, missingToken: true };
    }
    try {
      const res = await gmRequest({
        url: `${API_BASE}${endpoint}`,
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
      });
      let data;
      try { data = JSON.parse(res.responseText); } catch (e) { data = { detail: res.responseText }; }
      return { status: res.status, data, ok: res.status >= 200 && res.status < 300 };
    } catch (err) {
      return { status: 0, data: { detail: err.message }, ok: false, networkError: true };
    }
  }

  const Api = {
    getAdherents: (campaign) => apiCall(`/adherents${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ''}`),
    getCampaigns: () => apiCall('/campaigns'),
    triggerSync: (formSlug) => apiCall('/sync', { method: 'POST', body: formSlug ? { form_slug: formSlug } : undefined }),
    markSaisie: (itemId) => apiCall('/mark-saisie', { method: 'POST', body: { item_id: itemId, value: true } }),
  };

  // "adhesion-2026-2027-sport" → "Saison 2026/2027"
  function campaignLabel(slug) {
    return (slug || '')
      .replace(/^adhesion-(\d{4})-(\d{4})-sport$/, 'Saison $1/$2')
      .replace(/^stage-judo-printemps$/, 'Stage Printemps');
  }

  // ================================================================
  // Automatisation FFJDA — voir lib/ffjda-flow.js (source unique)
  // ================================================================
  // detectStep() et applyStep() sont partagés avec l'extension Chrome et
  // concaténés ici au build (scripts/build-userscript.js). Un correctif sur
  // le parcours FFJDA ne s'écrit donc qu'une fois.
  const { detectStep, applyStep } = (self.FfjdaFlow || {});
  if (!detectStep) {
    console.error('[JCCR] lib/ffjda-flow.js absent — script mal construit.');
    return;
  }

  async function pollForResults(adherent, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await applyStep('findLink', adherent);
        if (r && r.found)    return r;
        if (r && r.noResult) return { found: false, noResult: true };
      } catch (e) {}
    }
    return { found: false, timeout: true };
  }

  // ================================================================
  // Queue — équivalent de flowState / nextInQueue / finishAdherent
  // côté extension, mais persisté via storeGet/storeSet puisqu'une
  // navigation de page recharge intégralement le script.
  // ================================================================
  function modeOf(adherent, flow) {
    return (adherent && adherent._mode) || (flow && flow.mode) || 'nouvelle';
  }

  function apiMarkSaisie(adherent) {
    if (!adherent.item_id) return;
    Api.markSaisie(adherent.item_id).catch(() => {});
  }

  // Délai de garde après un clic censé faire naviguer la page (valider,
  // créer une licence, renouveler, ouvrir une fiche). Si la navigation ne
  // vient pas, l'adhérent est marqué en échec et la file avance, au lieu de
  // rester bloquée indéfiniment sur un message d'attente figé.
  // Si la navigation a bien lieu, ce contexte de script est détruit et la
  // boucle disparaît avec lui — elle n'a donc pas besoin de la détecter.
  async function failIfNoNavigation(flow, adherent, reason, timeoutMs = 12000) {
    const from = location.href;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
      if (location.href !== from) return;   // navigation en cours
    }
    await setStatus(`${adherent.nom} — ${reason}`, 'error');
    await finishAdherent(flow, adherent, false, reason, 1500);
  }

  async function finishAdherent(flow, adherent, ok, reason, delay = 2000) {
    flow.results.push({ nom: adherent.nom, prenom: adherent.prenom, mode: modeOf(adherent, flow), ok, reason: reason || null });
    await storeSet('flow', flow);
    setTimeout(() => { nextInQueue(); }, delay);
  }

  async function nextInQueue() {
    const flow = await storeGet('flow', null);
    if (!flow) return;
    flow.current++;

    if (flow.current >= flow.queue.length) {
      const results = flow.results;
      const okCount = results.filter(r => r.ok).length;
      const failed  = results.filter(r => !r.ok);
      let msg = `✅ ${okCount}/${flow.queue.length} licence(s) traitée(s) avec succès.`;
      if (failed.length) {
        msg += `\n❌ ${failed.length} échec(s) :\n` +
          failed.map(r => `• ${r.nom} ${r.prenom} — ${r.reason || 'erreur inconnue'}`).join('\n');
      }
      await storeSet('flow', null);
      await setStatus(msg, failed.length ? 'error' : 'success');
      return;
    }

    await storeSet('flow', flow);
    const adherent = flow.queue[flow.current];
    const mode = modeOf(adherent, flow);
    await setStatus(`[${flow.current + 1}/${flow.queue.length}] ${adherent.nom} ${adherent.prenom}...`, 'info');
    const targetUrl = mode === 'renouvellement'
      ? 'https://moncompte.ffjudo.com/espace-club/prise-licence/renouvellement-licencie-club'
      : 'https://moncompte.ffjudo.com/espace-club/prise-licence/saisir-licence';
    location.href = targetUrl;
  }

  async function startQueue(queue) {
    const adherent = queue[0];
    const flow = { queue, current: 0, results: [] };
    await storeSet('flow', flow);
    await setStatus(`[1/${queue.length}] ${adherent.nom} ${adherent.prenom}...`, 'info');
    const firstMode = modeOf(adherent, flow);
    const targetUrl = firstMode === 'renouvellement'
      ? 'https://moncompte.ffjudo.com/espace-club/prise-licence/renouvellement-licencie-club'
      : 'https://moncompte.ffjudo.com/espace-club/prise-licence/saisir-licence';
    const step = detectStep(location.href);
    if (firstMode !== 'renouvellement' && step && step !== 'depart') {
      await handleStep(flow);
    } else {
      location.href = targetUrl;
    }
  }

  async function handleStep(flowArg) {
    const flow = flowArg || await storeGet('flow', null);
    if (!flow) return;
    const step = detectStep(location.href);
    if (!step) return;
    const adherent = flow.queue[flow.current];
    if (!adherent) return;
    const idx = flow.current, total = flow.queue.length;

    // ---------------- RENOUVELLEMENT ----------------

    if (step === 'renew_search' || step === 'renew_results') {
      // Deux états de la MÊME URL :
      //  - renew_search  : formulaire vierge → remplir et soumettre. Le clic
      //    NAVIGUE (query string + #resultats_recherche), ce qui détruit ce
      //    contexte de script ; la page suivante repasse ici en renew_results.
      //  - renew_results : résultats en cours de chargement → on attend le lien.
      if (step === 'renew_search') {
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — recherche...`, 'info');
        await new Promise(r => setTimeout(r, 1000));
        try {
          const r = await applyStep('search', adherent);
          if (!r || !r.clicked) {
            const why = (r && r.reason) || 'Bouton RECHERCHER introuvable';
            await setStatus(`[${idx + 1}/${total}] ${why}.`, 'error');
            await finishAdherent(flow, adherent, false, why);
            return;
          }
          // Si le framework a ignoré la saisie, la recherche partirait à vide :
          // on le détecte en relisant les champs plutôt que d'attendre un
          // timeout de 15 s sur une page de résultats vide.
          if (!r.nom || !r.prenom) {
            const why = `Champs de recherche non pris en compte (nom="${r.nom || ''}", prénom="${r.prenom || ''}")`;
            await setStatus(`[${idx + 1}/${total}] ${why}.`, 'error');
            await finishAdherent(flow, adherent, false, why);
            return;
          }
        } catch (e) {
          await setStatus('Erreur formulaire recherche : ' + e.message, 'error');
          await finishAdherent(flow, adherent, false, 'Erreur formulaire recherche : ' + e.message);
          return;
        }
      }
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — attente des résultats...`, 'info');
      const res = await pollForResults(adherent);
      if (res.found) {
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — ouverture fiche...`, 'info');
        // Clic (et non navigation) : c'est le geste humain, et il fonctionne
        // que le lien porte une vraie URL ou qu'il soit piloté en JS.
        await applyStep('clickLink', adherent);
        await failIfNoNavigation(flow, adherent, 'Clic sur le nom sans effet (fiche non ouverte)');
      } else if (res.noResult) {
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — non trouvé (pas de licence active ?).`, 'error');
        await finishAdherent(flow, adherent, false, 'Non trouvé (pas de licence active FFJDA)', 3000);
      } else {
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — timeout recherche.`, 'error');
        await finishAdherent(flow, adherent, false, 'Timeout recherche', 3000);
      }
      return;
    }

    if (step === 'renew_fiche') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — fiche licence, clic renouveler...`, 'info');
      await new Promise(r => setTimeout(r, 1200));
      try {
        const r = await applyStep('clickRenew', adherent);
        if (r && r.clicked) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — renouvellement en cours...`, 'info');
          await failIfNoNavigation(flow, adherent, 'Clic "Renouveler" sans effet');
        } else {
          const available = (r && r.available && r.available.join(' | ')) || '';
          await setStatus(`[${idx + 1}/${total}] Bouton renouveler introuvable. Disponible : ${available}`, 'error');
          await finishAdherent(flow, adherent, false, 'Bouton renouveler introuvable');
        }
      } catch (e) {
        await setStatus('Erreur fiche licence : ' + e.message, 'error');
        await finishAdherent(flow, adherent, false, 'Erreur fiche licence : ' + e.message);
      }
      return;
    }

    if (step === 'renew_form') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — formulaire renouvellement...`, 'info');
      await new Promise(r => setTimeout(r, 1200));
      try {
        const r = await applyStep('etape2', adherent);
        if (!r) {
          await setStatus(`Renouvellement [${idx + 1}] : pas de réponse.`, 'error');
          await finishAdherent(flow, adherent, false, 'Pas de réponse du formulaire');
          return;
        }
        if (r.success) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} ✅`, 'success');
          apiMarkSaisie(adherent);
          await finishAdherent(flow, adherent, true, null, 2500);
        } else {
          await setStatus(`Renouvellement [${idx + 1}] : échec (${r.error || 'inconnu'}).`, 'error');
          await finishAdherent(flow, adherent, false, r.error || 'Échec remplissage formulaire');
        }
      } catch (e) {
        await setStatus('Erreur formulaire renouvellement : ' + e.message, 'error');
        await finishAdherent(flow, adherent, false, 'Erreur formulaire renouvellement : ' + e.message);
      }
      return;
    }

    // ---------------- NOUVELLE LICENCE ----------------

    if (step === 'etape1') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 1...`, 'info');
      await new Promise(r => setTimeout(r, 800));
      try {
        const r = await applyStep('etape1', adherent);
        if (!r || !r.success) {
          const why = (r && (!r.nom || !r.prenom))
            ? `Étape 1 : champs non pris en compte (nom="${(r && r.nom) || ''}", prénom="${(r && r.prenom) || ''}")`
            : 'Étape 1 : aucun champ rempli';
          await setStatus(`[${idx + 1}/${total}] ${why}.`, 'error');
          await finishAdherent(flow, adherent, false, why);
          return;
        }
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 1 ✅ → Validation...`, 'info');
        await failIfNoNavigation(flow, adherent, 'Étape 1 validée sans effet (formulaire refusé ?)');
      } catch (e) {
        await setStatus('Erreur étape 1 : ' + e.message, 'error');
        await finishAdherent(flow, adherent, false, 'Erreur étape 1 : ' + e.message);
      }
      return;
    }

    if (step === 'intermediaire') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — création licence...`, 'info');
      await new Promise(r => setTimeout(r, 1000));
      try {
        const ok = await applyStep('clickCreate', adherent);
        if (!ok) {
          await setStatus('Bouton "créer une licence" introuvable.', 'error');
          await finishAdherent(flow, adherent, false, 'Bouton "créer une licence" introuvable');
          return;
        }
        await failIfNoNavigation(flow, adherent, 'Clic "Créer une licence" sans effet');
      } catch (e) {
        await setStatus('Erreur intermédiaire : ' + e.message, 'error');
        await finishAdherent(flow, adherent, false, 'Erreur intermédiaire : ' + e.message);
      }
      return;
    }

    if (step === 'etape2') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 2...`, 'info');
      await new Promise(r => setTimeout(r, 1200));
      try {
        const r = await applyStep('etape2', adherent);
        if (!r) {
          await setStatus(`Étape 2 [${idx + 1}] : pas de réponse.`, 'error');
          await finishAdherent(flow, adherent, false, 'Pas de réponse du formulaire');
          return;
        }
        if (r.success) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} ✅`, 'success');
          apiMarkSaisie(adherent);
          await finishAdherent(flow, adherent, true, null, 2500);
        } else {
          await setStatus(`Étape 2 [${idx + 1}] : échec (${r.error || 'inconnu'}).`, 'error');
          await finishAdherent(flow, adherent, false, r.error || 'Échec remplissage formulaire');
        }
      } catch (e) {
        await setStatus('Erreur étape 2 : ' + e.message, 'error');
        await finishAdherent(flow, adherent, false, 'Erreur étape 2 : ' + e.message);
      }
      return;
    }
  }

  // ================================================================
  // Panneau flottant (UI)
  // ================================================================
  let adherents = [];
  let selected = new Set();
  let currentFilter = 'judo';
  let campaigns = [];
  let currentCampaign = null;   // slug de la saison affichée
  let unsaisieOnly = false;

  function isIaido(a) {
    const tier = (a.tier || '').toLowerCase();
    return a.pratique === '13' || tier.includes('iaido') || tier.includes('iaïdo') || tier.includes('cercle');
  }
  function hasLicenceFFJDA(a) {
    return !!a.ffjda_licence || a.recon_status === 'matched' || a.recon_status === 'corrected';
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #jcc-ffjda-panel {
        position: fixed; bottom: 16px; right: 16px; z-index: 999999;
        background: #1c2b3a; color: #e8f0f7; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); font-family: -apple-system, 'Segoe UI', sans-serif;
        font-size: 13px; width: min(340px, calc(100vw - 32px)); max-height: 80vh;
        overflow: hidden; display: flex; flex-direction: column;
      }
      #jcc-ffjda-header {
        background: #0d3b5e; padding: 10px 14px; display: flex;
        align-items: center; justify-content: space-between; cursor: pointer; user-select: none; flex: none;
      }
      #jcc-ffjda-header span.title { font-weight: 600; font-size: 14px; color: #fff; }
      #jcc-ffjda-body { padding: 10px 14px; overflow-y: auto; }
      #jcc-ffjda-status { margin: 0 0 10px; padding: 7px 9px; border-radius: 6px; font-size: 12px; line-height: 1.4; white-space: pre-line; }
      #jcc-ffjda-status.info    { background: #103a5c; color: #9fd3ff; }
      #jcc-ffjda-status.success { background: #16401f; color: #8fe3a0; }
      #jcc-ffjda-status.error   { background: #4a1414; color: #ff9d9d; max-height: 160px; overflow-y: auto; }
      #jcc-ffjda-status:empty { display: none; }
      .jcc-f-row { display: flex; gap: 6px; margin-bottom: 8px; }
      .jcc-f-row input[type="text"], .jcc-f-row input[type="password"], .jcc-f-row select {
        flex: 1; background: #0f2233; border: 1px solid #2c4864; color: #e8f0f7;
        border-radius: 6px; padding: 6px 8px; font-size: 13px; min-width: 0;
      }
      .jcc-btn {
        border: none; border-radius: 7px; padding: 8px; font-size: 13px; font-weight: 600;
        cursor: pointer; margin-bottom: 6px; width: 100%; color: #fff; background: #1a6fa8;
      }
      .jcc-btn:disabled { background: #555; cursor: default; }
      .jcc-btn.secondary { background: #2d4a3e; color: #7ec8a0; }
      .jcc-btn-row { display: flex; gap: 6px; }
      .jcc-btn-row .jcc-btn { width: auto; flex: 1; }
      #jcc-ffjda-list { max-height: 220px; overflow-y: auto; border: 1px solid #2c4864; border-radius: 6px; margin-bottom: 8px; }
      .jcc-adh-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; }
      .jcc-adh-item:last-child { border-bottom: none; }
      .jcc-adh-item.saisie { opacity: 0.5; }
      .jcc-counter { font-size: 11px; color: #a8c8e8; margin-bottom: 6px; text-align: right; line-height: 1.5; }
      .jcc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #a8c8e8; margin-bottom: 8px; }
      #jcc-ffjda-progress { height: 5px; background: #0f2233; border-radius: 3px; margin-bottom: 8px; overflow: hidden; }
      #jcc-ffjda-progress-fill { height: 100%; background: #1a6fa8; width: 0%; transition: width .3s; }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    injectStyle();
    const panel = document.createElement('div');
    panel.id = 'jcc-ffjda-panel';
    panel.innerHTML = `
      <div id="jcc-ffjda-header">
        <span class="title">🥋 JCCR → FFJDA</span>
        <span style="font-size:11px;opacity:.7">v${SCRIPT_VERSION} ▾</span>
      </div>
      <div id="jcc-ffjda-body">
        <div id="jcc-ffjda-status"></div>
        <div id="jcc-ffjda-progress"><div id="jcc-ffjda-progress-fill"></div></div>
        <div id="jcc-ffjda-content"></div>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#jcc-ffjda-header').addEventListener('click', () => {
      const b = panel.querySelector('#jcc-ffjda-body');
      b.style.display = b.style.display === 'none' ? '' : 'none';
    });
    return panel;
  }

  function renderStatus(msg, type) {
    const el = document.getElementById('jcc-ffjda-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = type || 'info';
  }

  async function setStatus(msg, type = 'info') {
    await storeSet('status', { msg, type, ts: Date.now() });
    renderStatus(msg, type);
  }

  function renderProgress(current, total) {
    const fill = document.getElementById('jcc-ffjda-progress-fill');
    if (!fill) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    fill.style.width = pct + '%';
  }

  function renderTokenForm(content) {
    content.innerHTML = `
      <div class="jcc-f-row">
        <input type="password" id="jcc-token-input" placeholder="Token API sync.judo-cattenom.fr">
      </div>
      <button class="jcc-btn" id="jcc-token-save">💾 Enregistrer le token</button>
    `;
    content.querySelector('#jcc-token-save').addEventListener('click', async () => {
      const val = content.querySelector('#jcc-token-input').value.trim();
      if (val.length < 16) { await setStatus('Token trop court (min. 16 caractères).', 'error'); return; }
      await storeSet('token', val);
      await setStatus('✅ Token enregistré.', 'success');
      renderPicker(content);
    });
  }

  function getFiltered() {
    return adherents.map((a, idx) => ({ a, idx })).filter(({ a }) => {
      if (currentFilter === 'iaido') return isIaido(a);
      if (currentFilter === 'judo')  return !isIaido(a);
      return true;
    }).filter(({ a }) => !unsaisieOnly || !a.saisie_ffjda);
  }

  function renderList(listEl, filterText) {
    const ft = (filterText || '').toLowerCase();
    const filtered = getFiltered().filter(({ a }) =>
      !ft || `${a.nom} ${a.prenom}`.toLowerCase().includes(ft)
    );
    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="padding:10px;text-align:center;color:#8aa;font-size:11px">Aucun adhérent (essayez 🔄 pour synchroniser cette saison).</div>';
      return;
    }
    listEl.innerHTML = filtered.map(({ a, idx }) => {
      // 🔑 = licence FFJDA connue → renouvellement ; ✨ = pas de licence → création.
      // C'est exactement la règle qui décidera du mode au lancement.
      const modeBadge = hasLicenceFFJDA(a)
        ? '<span title="Renouvellement">🔑</span>'
        : '<span title="Nouvelle licence">✨</span>';
      return `
      <label class="jcc-adh-item${a.saisie_ffjda ? ' saisie' : ''}">
        <input type="checkbox" data-idx="${idx}" ${selected.has(idx) ? 'checked' : ''}>
        <span>${modeBadge} ${a.nom} ${a.prenom}${a.saisie_ffjda ? ' ✓' : ''}</span>
      </label>`;
    }).join('');
    listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        if (e.target.checked) selected.add(idx); else selected.delete(idx);
        updateCounter();
      });
    });
    updateCounter();
  }

  function updateCounter() {
    const visible = getFiltered();
    const nRenew = visible.filter(({ a }) => hasLicenceFFJDA(a)).length;
    const nNew   = visible.length - nRenew;
    const nTodo  = visible.filter(({ a }) => !a.saisie_ffjda).length;
    const counterEl = document.getElementById('jcc-counter');
    if (counterEl) {
      counterEl.innerHTML =
        `${visible.length} affiché(s) · 🔑 ${nRenew} renouv. · ✨ ${nNew} nouv.<br>` +
        `${nTodo} à saisir · <b>${selected.size} sélectionné(s)</b>`;
    }
    const launchBtn = document.getElementById('jcc-launch-btn');
    if (launchBtn) launchBtn.disabled = selected.size === 0;
  }

  function renderPicker(content) {
    selected = new Set();
    content.innerHTML = `
      <div class="jcc-f-row">
        <select id="jcc-discipline">
          <option value="judo">🥋 Judo &amp; Taïso</option>
          <option value="iaido">⚔️ Iaïdo / Cercle</option>
          <option value="all">Tous</option>
        </select>
      </div>
      <div class="jcc-f-row">
        <select id="jcc-campaign"><option value="">Saison : chargement…</option></select>
      </div>
      <div class="jcc-f-row">
        <input type="text" id="jcc-search" placeholder="Filtrer par nom...">
      </div>
      <label class="jcc-check"><input type="checkbox" id="jcc-unsaisie"> Non saisis seulement</label>
      <div class="jcc-btn-row" style="margin-bottom:8px">
        <button class="jcc-btn secondary" id="jcc-btn-reload" title="Recharger depuis l'API">↺</button>
        <button class="jcc-btn secondary" id="jcc-btn-sync" title="Synchroniser cette saison depuis HelloAsso">🔄 Sync</button>
        <button class="jcc-btn secondary" id="jcc-btn-all">Tout</button>
        <button class="jcc-btn secondary" id="jcc-btn-none">Aucun</button>
      </div>
      <div class="jcc-counter" id="jcc-counter">—</div>
      <div id="jcc-ffjda-list"></div>
      <button class="jcc-btn" id="jcc-launch-btn" disabled>▶ Lancer la saisie</button>
    `;
    const listEl = content.querySelector('#jcc-ffjda-list');
    const searchEl = content.querySelector('#jcc-search');
    const campaignEl = content.querySelector('#jcc-campaign');
    const unsaisieEl = content.querySelector('#jcc-unsaisie');
    unsaisieEl.checked = unsaisieOnly;
    renderList(listEl, '');

    content.querySelector('#jcc-discipline').addEventListener('change', (e) => {
      currentFilter = e.target.value;
      selected.clear();
      renderList(listEl, searchEl.value);
    });
    unsaisieEl.addEventListener('change', (e) => {
      unsaisieOnly = e.target.checked;
      selected.clear();
      renderList(listEl, searchEl.value);
    });
    campaignEl.addEventListener('change', async (e) => {
      // Changer de saison REMPLACE la liste : on veut voir qui est inscrit
      // pour CETTE saison-là, pas un mélange de toutes les saisons.
      currentCampaign = e.target.value || null;
      await storeSet('campaign', currentCampaign);
      selected.clear();
      await loadAdherents(content);
    });
    searchEl.addEventListener('input', () => renderList(listEl, searchEl.value));
    content.querySelector('#jcc-btn-all').addEventListener('click', () => {
      getFiltered().forEach(({ idx }) => selected.add(idx));
      renderList(listEl, searchEl.value);
    });
    content.querySelector('#jcc-btn-none').addEventListener('click', () => {
      selected.clear();
      renderList(listEl, searchEl.value);
    });
    content.querySelector('#jcc-btn-reload').addEventListener('click', () => loadAdherents(content));
    content.querySelector('#jcc-btn-sync').addEventListener('click', async () => {
      const label = campaignLabel(currentCampaign) || 'la saison courante';
      await setStatus(`🔄 Synchronisation HelloAsso — ${label}...`, 'info');
      const res = await Api.triggerSync(currentCampaign || undefined);
      if (!res.ok) {
        await setStatus(`❌ Sync échouée : ${res.data.detail || res.status}`, 'error');
        return;
      }
      await setStatus(`✅ ${res.data.paid ?? '?'} adhérent(s) payé(s) synchronisé(s).`, 'success');
      await loadAdherents(content);
    });
    content.querySelector('#jcc-launch-btn').addEventListener('click', async () => {
      if (selected.size === 0) return;
      const queue = [...selected].sort((a, b) => a - b)
        .map(i => adherents[i])
        .map(a => Object.assign({}, a, { _mode: hasLicenceFFJDA(a) ? 'renouvellement' : 'nouvelle' }));
      await startQueue(queue);
    });

    loadCampaigns(content).then(() => {
      if (adherents.length === 0) loadAdherents(content);
    });
  }

  // Remplit le sélecteur de saison. Par défaut on sélectionne la campagne
  // marquée "current" côté API (ou celle mémorisée), pour que le panneau
  // ouvre directement sur la saison en cours de traitement.
  async function loadCampaigns(content) {
    const res = await Api.getCampaigns();
    if (!res.ok || !res.data.campaigns) return;
    campaigns = res.data.campaigns.filter(
      c => (c.type || 'Membership') === 'Membership' &&
           (c.slug.includes('adhesion') || c.slug === 'stage-judo-printemps')
    );
    const saved = await storeGet('campaign', null);
    currentCampaign = saved || res.data.current || (campaigns[0] && campaigns[0].slug) || null;

    const el = content.querySelector('#jcc-campaign');
    if (!el) return;
    el.innerHTML = campaigns.map(c =>
      `<option value="${c.slug}"${c.slug === currentCampaign ? ' selected' : ''}>${campaignLabel(c.slug)}</option>`
    ).join('');
  }

  async function loadAdherents(content) {
    const label = campaignLabel(currentCampaign);
    await setStatus(`↺ Chargement ${label || 'des adhérents'}...`, 'info');
    const res = await Api.getAdherents(currentCampaign || undefined);
    if (!res.ok) {
      if (res.missingToken) { renderTokenForm(content); return; }
      await setStatus(`❌ Erreur chargement : ${res.data.detail || res.status}`, 'error');
      return;
    }
    adherents = res.data.adherents || [];
    selected.clear();
    if (adherents.length === 0) {
      await setStatus(`⚠️ Aucun adhérent pour ${label || 'cette saison'} — lancez 🔄 Sync pour la récupérer depuis HelloAsso.`, 'error');
    } else {
      const nRenew = adherents.filter(hasLicenceFFJDA).length;
      await setStatus(
        `✅ ${label} : ${adherents.length} adhérent(s) — 🔑 ${nRenew} à renouveler, ✨ ${adherents.length - nRenew} à créer.`,
        'success'
      );
    }
    const listEl = document.getElementById('jcc-ffjda-list');
    const searchEl = document.getElementById('jcc-search');
    if (listEl) renderList(listEl, searchEl ? searchEl.value : '');
  }

  // ================================================================
  // Init
  // ================================================================
  async function init() {
    // Garde anti-double-exécution : si le loader ET une copie installée en
    // direct tournent tous les deux, on n'affiche qu'un seul panneau (sinon
    // deux files concurrentes piloteraient la même page).
    if (document.getElementById('jcc-ffjda-panel')) {
      console.warn('[JCCR] Panneau déjà présent — seconde instance ignorée.');
      return;
    }
    const panel = buildPanel();
    const content = panel.querySelector('#jcc-ffjda-content');

    const savedStatus = await storeGet('status', null);
    if (savedStatus) renderStatus(savedStatus.msg, savedStatus.type);

    const flow = await storeGet('flow', null);
    if (flow) {
      renderProgress(flow.current, flow.queue.length);
      content.innerHTML = `
        <button class="jcc-btn secondary" id="jcc-cancel-btn">⏹ Annuler la file</button>
      `;
      content.querySelector('#jcc-cancel-btn').addEventListener('click', async () => {
        await storeSet('flow', null);
        await setStatus('Flux annulé.', 'info');
        renderPicker(content);
      });
      await handleStep(flow);
      return;
    }

    const token = await storeGet('token', null);
    if (!token) { renderTokenForm(content); return; }
    renderPicker(content);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
