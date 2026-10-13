// ==UserScript==
// @name         JCCR Saisie FFJDA (mobile / Safari)
// @namespace    https://github.com/gaelc08/jccr-gestion
// @version      1.10.0
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
// `detectStep` et `dobFr` restent à part : pures, jamais injectées (le service
// worker les appelle chez lui, le userscript aussi).

(function (root) {
  'use strict';

  /**
   * Étape du parcours FFJDA déduite de l'URL courante.
   * Retourne null si la page n'appartient pas au parcours.
   */
  function detectStep(url) {
    if (!url) return null;
    // Page d'arrivée après « Suivant » (étape 2 ou renouvellement) : la seule
    // preuve qu'une licence est bien partie au panier (voir pendingSubmit).
    if (/\/modification-panier|\/panier(?:[/?#]|$)/.test(url))              return 'panier';
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
   * Date de naissance de l'adhérent en JJ/MM/AAAA, pour l'affichage ('' si
   * absente ou illisible). Accepte l'ISO de l'API ou du JJ/MM/AAAA. Pure.
   */
  function dobFr(s) {
    s = String(s || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s : '';
  }

  /**
   * Exécute une action dans la page FFJDA. AUTO-SUFFISANTE : ne référence rien
   * hors de son propre corps (contrainte de sérialisation, voir en-tête).
   *
   * @param {string} action  'search' | 'findLink' | 'clickLink' | 'clickRenew'
   *                         | 'clickCreate' | 'etape1' | 'etape2' | 'submitForm'
   *                         | 'watchSubmit' | 'submitStatus' | 'checkError'
   *                         | 'showAddress' | 'nameOnPage' | 'formErrors'
   *                         | 'manualHelp' | 'manualStatus' | 'pauseHelp' | 'pauseStatus'
   * @param {object} adherent
   * @param {object} [extra]  'manualHelp' : { reason } ; 'etape2' : { autoAddress, choices } ;
   *                          'showAddress' / 'pauseHelp' : { reason, mode|kind, choices }
   */
  async function applyStep(action, adherent, extra) {
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
    // Affecter `el.value` ne suffit pas : les formulaires FFJDA sont pilotés
    // par un framework qui suit sa propre copie de la valeur et ignore une
    // écriture directe — il soumettrait alors un champ vide. Le setter natif
    // du prototype déclenche son tracking, comme une vraie frappe clavier.
    function nativeSet(el, val) {
      const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
                  : (el instanceof HTMLSelectElement)   ? HTMLSelectElement.prototype
                  : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    }
    function setNativeValue(el, val) {
      try { el.focus(); } catch (e) {}
      nativeSet(el, val);
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

    // Quand la recherche de renouvellement ne trouve pas de correspondance
    // EXACTE (souvent une ancienne licence, plusieurs saisons sans
    // renouvellement), FFJDA propose parfois une suggestion approximative :
    // "Nous avons trouvé quelqu'un qui lui ressemble beaucoup... Est-ce
    // lui ?" avec un bouton "RENOUVELER CE LICENCIÉ" — PAS un lien sur le nom
    // (que findNameLink() cherche). Sans le détecter, on confond ce cas avec
    // "aucun résultat" et on bascule à tort en création d'une NOUVELLE
    // licence, alors que FFJDA a déjà identifié la bonne personne (juste
    // avec un degré de confiance moindre qu'un match exact) — vu en prod sur
    // Raphaël Cantarero, confirmé par un test manuel : cliquer ce bouton
    // renouvelle correctement sa licence existante.
    function findFuzzyMatchButton() {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(el => normText(el.textContent).includes('renouveler ce licencie'));
      if (!btn) return null;
      // Sécurité minimale : la page doit bien concerner la personne
      // recherchée avant de cliquer quoi que ce soit à sa place.
      const nomA = normName(adherent.nom), prenomA = normName(adherent.prenom);
      const pageText = normName((document.body && document.body.textContent) || '');
      if (!pageText.includes(nomA) || !pageText.includes(prenomA)) return null;
      return btn;
    }

    // ── Actions simples ──────────────────────────────────────────────────────

    if (action === 'findLink') {
      if (findNameLink()) return { found: true };
      // Suggestion approximative AVANT le "aucun résultat" : une page "aucun
      // licencié trouvé (exact)" peut afficher la suggestion juste en
      // dessous — la traiter en trouvé plutôt qu'en échec.
      if (findFuzzyMatchButton()) return { found: true, fuzzy: true };
      // FFJDA formule différemment selon le contexte : "Aucun licencié...",
      // "Aucune licence à renouveler", "Aucune licence trouvée"... On vérifie
      // "aucun" + ("licenc" ou "résultat") plutôt qu'une phrase figée, sinon
      // le polling tourne jusqu'à son timeout de 15s au lieu d'échouer net.
      const noResult = Array.from(document.querySelectorAll('p, div, span'))
        .some(el => {
          const t = el.textContent.toLowerCase();
          return t.includes('aucun') && (t.includes('licenc') || t.includes('résultat') || t.includes('resultat'));
        });
      return { found: false, noResult };
    }

    // Nom et prénom affichés dans les résultats, mais sans lien de
    // renouvellement ni suggestion : typiquement une personne DÉJÀ licenciée
    // pour la saison (rien à renouveler). Sans ce cas, le polling attendait
    // un lien qui ne viendra jamais.
    if (action === 'nameOnPage') {
      const nomA = normName(adherent.nom), prenomA = normName(adherent.prenom);
      const main = document.querySelector('#resultats_recherche') || document.body;
      const t = normName((main && main.textContent) || '');
      return { present: !!nomA && !!prenomA && t.includes(nomA) && t.includes(prenomA) };
    }

    if (action === 'clickLink') {
      const el = findNameLink() || findFuzzyMatchButton();
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
      // Désaccentué SEULEMENT (ni majuscules, ni tirets touchés — pour ne
      // pas risquer de perturber la recherche sur des noms composés type
      // "PASQUER-HERMANS", qui fonctionne déjà). Contrairement à la saisie
      // d'identité (étape 1, où FFJDA doit enregistrer le nom réel), la
      // recherche de renouvellement tolère mal un nom accentué — une saisie
      // manuelle "RAPHAEL" (sans tréma) trouve une correspondance
      // approximative que la même recherche avec "Raphaël" ne trouve pas
      // (vu en prod, Raphaël Cantarero : recherche automatisée bredouille,
      // recherche manuelle sans accent réussit).
      function stripAccents(s) {
        return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
      }
      setByName('nom',    stripAccents(adherent.nom));
      setByName('prenom', stripAccents(adherent.prenom));

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

    // ── Date de naissance (étape 1 nouvelle licence) ─────────────────────────
    // Vu en prod le 13/10/2026 sur iPhone (Safari, userscript) : nom, prénom et
    // sexe remplis, mais le champ date VIDE au moment de « VALIDER » alors que
    // la relecture juste après la saisie était bonne ; FFJDA refuse sans
    // naviguer. Tapée à la main, la même date passe. Le DOM réel n'est pas
    // accessible (site authentifié) : le remplissage doit tenir face à un
    // <input type="date"> (n'accepte que l'ISO, vide le reste en silence), à un
    // masque de saisie (tient sa propre copie de la valeur, ignore le setter
    // natif et vide le champ au blur) ou à un datepicker (jQuery, flatpickr).

    // adherent.date_naissance arrive au format ISO (YYYY-MM-DD, tel que stocké
    // côté API) ; DD/MM/YYYY accepté aussi. null si absente ou illisible.
    function expectedDob() {
      const s = String(adherent.date_naissance || '').trim();
      let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, fr: `${m[3]}/${m[2]}/${m[1]}` };
      m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
      if (m) return { iso: `${m[3]}-${m[2]}-${m[1]}`, fr: s };
      return null;
    }
    // Valeur relue dans le champ, ramenée en ISO ('' si ni DD/MM/YYYY ni
    // YYYY-MM-DD : une date aberrante type "20/09/0925" n'y ressemble pas).
    function dobAsIso(v) {
      const s = String(v || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    }
    // Champ VISIBLE qui double l'input `naissance`, s'il y en a un. Sur un
    // user-agent iPhone/iPad/Android, flatpickr (FFJDA : 4.6.13, d/m/Y) passe
    // en mode mobile : l'input d'origine devient type="hidden" et un
    // <input type="date" class="flatpickr-mobile" required>, sans name, est
    // inséré juste après. C'est lui que l'utilisateur voit et que le
    // navigateur valide : vu le 13/10/2026, input caché rempli, champ mobile
    // vide → « Remplissez ce champ », formulaire jamais soumis. altInput :
    // variante desktop (altInput:true), pas utilisée par FFJDA à ce jour.
    function dobVisible(el) {
      if (!el) return null;
      const fp = el._flatpickr;
      if (fp && fp.mobileInput) return fp.mobileInput;
      const sib = el.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains('flatpickr-mobile')) return sib;
      if (fp && fp.altInput) return fp.altInput;
      return null;
    }
    function isType(el, t) { return String((el && el.type) || '').toLowerCase() === t; }
    // Le champ visible porte-t-il la date ? ISO pour un type=date ; un
    // altInput affiche son altFormat (« 4 octobre 2022 »…) : flatpickr fait foi.
    function visibleHolds(el, vis, exp) {
      if (isType(vis, 'date')) return String(vis.value || '').trim() === exp.iso;
      if (dobAsIso(vis.value) === exp.iso) return true;
      const fp = el._flatpickr;
      const d = fp && fp.selectedDates && fp.selectedDates[0];
      return !!(String(vis.value || '').trim() && d && typeof fp.formatDate === 'function'
        && fp.formatDate(d, 'Y-m-d') === exp.iso);
    }
    // La date tient dans l'input `naissance` (soumis) ET dans le champ visible.
    function dobHolds(el, exp) {
      if (dobAsIso(el.value) !== exp.iso) return false;
      const vis = dobVisible(el);
      return !vis || visibleHolds(el, vis, exp);
    }
    // Motif d'échec affiché tel quel par l'extension et le userscript ('' = OK).
    function dobProblem(el, exp) {
      if (!el) return 'Champ « Date de naissance » introuvable sur la page FFJDA';
      if (!exp) {
        return `Date de naissance absente ou illisible dans les données HelloAsso (« ${adherent.date_naissance || ''} »)`
          + ' — saisissez-la à la main puis VALIDER';
      }
      if (dobHolds(el, exp)) return '';
      const vis = dobVisible(el);
      const bad = (vis && !visibleHolds(el, vis, exp)) ? vis : el;
      const what = bad === vis ? 'calendrier' : 'champ';
      const v = String(bad.value || '').trim();
      return `Date de naissance non prise en compte par le site FFJDA (${v ? `${what} « ${v} » au lieu de ${exp.fr}` : `${what} vide`})`
        + ' — saisissez-la à la main puis VALIDER';
    }

    // Éléments ajoutés par nos soins dans la page (ignorés par les relevés d'erreurs).
    function ours(el) {
      return !!(el.closest && el.closest('#jcc-ffjda-panel, #jcc-address-box, #jcc-etape1-box, #jcc-pause-box'));
    }
    // Libellé d'un champ pour un motif d'erreur. Le champ mobile flatpickr n'a
    // ni name ni label : on prend ceux de l'input qu'il double (juste avant).
    // Un input caché n'a pas de `labels` : repli sur label[for].
    function fieldLabel(el) {
      const src = (el.classList && el.classList.contains('flatpickr-mobile') && el.previousElementSibling) || el;
      const lbl = (src.labels && src.labels[0])
        || (src.id && document.querySelector(`label[for="${src.id}"]`)) || null;
      return String((lbl && lbl.textContent) || (el.getAttribute && el.getAttribute('placeholder'))
        || src.name || (src.getAttribute && src.getAttribute('name')) || '')
        .replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
    }
    // Champs refusés par la validation HTML5 du navigateur, avec son message.
    function invalidMessages(scope) {
      const out = [];
      scope.querySelectorAll('input, select, textarea').forEach((el) => {
        if (ours(el) || !el.willValidate || !el.validity || el.validity.valid) return;
        const lbl = fieldLabel(el);
        out.push(`${lbl ? lbl + ' : ' : ''}${el.validationMessage || 'valeur refusée'}`);
      });
      return out;
    }

    // Dispatch annulable : `false` = un handler a fait preventDefault (un
    // masque qui gère lui-même la frappe, typiquement).
    function fire(el, type, init, Ctor) {
      const opts = Object.assign({ bubbles: true, cancelable: true }, init || {});
      let ev;
      try { ev = new (Ctor || Event)(type, opts); } catch (e) { ev = new Event(type, opts); }
      return el.dispatchEvent(ev);
    }
    function fireKey(el, type, ch) {
      const K = (typeof KeyboardEvent === 'function') ? KeyboardEvent : Event;
      const opts = { bubbles: true, cancelable: true, key: ch,
        code: /\d/.test(ch) ? 'Digit' + ch : (ch === '/' ? 'Slash' : (ch === '-' ? 'Minus' : '')) };
      let ev;
      try { ev = new K(type, opts); } catch (e) { ev = new Event(type, opts); }
      // keyCode/which/charCode valent 0 sur un événement construit ; les
      // masques jQuery les lisent encore pour savoir quelle touche est tapée.
      const char = ch.charCodeAt(0);
      const keyCode = type === 'keypress' ? char : (ch === '/' ? 191 : (ch === '-' ? 189 : char));
      [['keyCode', keyCode], ['which', keyCode], ['charCode', type === 'keypress' ? char : 0]].forEach(([k, v]) => {
        try { Object.defineProperty(ev, k, { get: () => v }); } catch (e) {}
      });
      return el.dispatchEvent(ev);
    }
    // Frappe caractère par caractère, avec l'action par défaut du navigateur
    // (insertion) seulement si aucun handler ne l'a annulée : un masque qui
    // gère la touche lui-même écrit alors la valeur à sa façon.
    async function typeText(el, text, isDate) {
      const IE = (typeof InputEvent === 'function') ? InputEvent : Event;
      nativeSet(el, '');
      fire(el, 'input', { inputType: 'deleteContentBackward' }, IE);
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (fireKey(el, 'keydown', ch) && fireKey(el, 'keypress', ch)
            && fire(el, 'beforeinput', { inputType: 'insertText', data: ch }, IE)) {
          // Un <input type="date"> n'accepte qu'une date complète : on lui
          // pose le préfixe tapé (vidé tant qu'il est incomplet).
          nativeSet(el, isDate ? text.slice(0, i + 1) : (el.value || '') + ch);
          fire(el, 'input', { inputType: 'insertText', data: ch }, IE);
        }
        fireKey(el, 'keyup', ch);
        await wait(20);
      }
      fire(el, 'change');
    }
    // API du widget qui pilote le champ, s'il y en a un. false = aucun.
    function widgetSetDate(el, exp, val) {
      const [y, mo, d] = exp.iso.split('-').map(Number);
      const date = new Date(y, mo - 1, d);
      let used = false;
      try {
        if (el.inputmask && typeof el.inputmask.setValue === 'function') { el.inputmask.setValue(val); used = true; }
      } catch (e) {}
      try {
        if (el._flatpickr && typeof el._flatpickr.setDate === 'function') { el._flatpickr.setDate(date, true); used = true; }
      } catch (e) {}
      const jq = pageJQuery();
      if (jq) {
        try {
          // jQuery UI marque le champ (.hasDatepicker) ; bootstrap-datepicker
          // peut être porté par le conteneur .date / .input-group.
          const $el = jq(el);
          const $host = ($el.hasClass('hasDatepicker') || $el.data('datepicker')) ? $el : $el.closest('.date, .input-group');
          if (typeof $host.datepicker === 'function' && ($host.hasClass('hasDatepicker') || $host.data('datepicker'))) {
            $host.datepicker('setDate', date);
            used = true;
          }
        } catch (e) {}
      }
      if (used) { fire(el, 'input'); fire(el, 'change'); }
      return used;
    }
    // Quitter le champ comme un humain (sur la page, c'est là qu'un masque
    // ou un datepicker revalide, et vide une valeur qu'il n'a pas vue passer).
    function leaveField(el) {
      const focused = document.activeElement === el;
      try { el.blur(); } catch (e) {}
      if (!focused) fire(el, 'blur');
    }

    // Essaie les stratégies dans l'ordre jusqu'à ce que la date TIENNE dans
    // l'input `naissance` ET dans le champ visible : relue ~300 ms après la
    // saisie (sans blur), puis encore après avoir quitté le champ.
    async function fillDob(el, exp) {
      const isDate = isType(el, 'date');
      // Input caché (flatpickr mobile) : ni focus ni frappe, l'utilisateur ne
      // le voit pas et le navigateur ne le valide pas.
      const hidden = isType(el, 'hidden');
      const val = isDate ? exp.iso : exp.fr;
      const fp = (el._flatpickr && typeof el._flatpickr.setDate === 'function') ? el._flatpickr : null;
      const vis = dobVisible(el);
      const mobile = isType(vis, 'date') ? vis : null;
      const [y, mo, d] = exp.iso.split('-').map(Number);

      const strategies = [];
      if (fp || mobile) {
        // API officielle d'abord (met à jour input ET mobileInput), puis le
        // champ mobile comme le ferait le sélecteur natif : ISO + input/change,
        // que flatpickr écoute pour réécrire l'input caché en d/m/Y. Pas de
        // focus sur le champ mobile : sur iOS il ouvrirait la roue de dates.
        const name = !mobile ? 'API flatpickr' : (fp ? 'flatpickr (mode mobile)' : 'champ mobile natif');
        strategies.push([name, () => {
          let used = false;
          if (fp) { try { fp.setDate(new Date(y, mo - 1, d), true); used = true; } catch (e) {} }
          if (mobile) { nativeSet(mobile, exp.iso); fire(mobile, 'input'); fire(mobile, 'change'); used = true; }
          return used;
        }]);
      }
      if (!hidden) {
        strategies.push(
          ['setter natif',        () => { nativeSet(el, val); fire(el, 'input'); fire(el, 'change'); }],
          // Passe par un éventuel setter posé sur l'élément par un masque.
          ['affectation directe', () => { el.value = val; fire(el, 'input'); fire(el, 'change'); }],
          ['API du widget',       () => widgetSetDate(el, exp, val)],
          ['frappe clavier',      () => typeText(el, val, isDate)],
        );
        // Masque qui insère les "/" lui-même : on ne tape que les chiffres.
        if (!isDate) strategies.push(['frappe des chiffres', () => typeText(el, val.replace(/\D/g, ''), false)]);
      } else if (!strategies.length) {
        strategies.push(['setter natif (champ caché)', () => { nativeSet(el, val); fire(el, 'input'); fire(el, 'change'); }]);
      }

      const tried = [];
      for (const [name, run] of strategies) {
        if (!hidden) { try { el.focus(); } catch (e) {} }
        let applied;
        try { applied = await run(); } catch (e) { applied = false; }
        if (applied === false) continue;
        tried.push(name);
        await wait(300);
        if (!dobHolds(el, exp)) continue;
        if (!hidden) leaveField(el);
        await wait(300);
        if (dobHolds(el, exp)) return { ok: true, strategy: name, tried };
      }
      return { ok: false, strategy: null, tried };
    }

    // ── Étape 1 nouvelle licence : identité ──────────────────────────────────

    if (action === 'etape1') {
      // Le champ FFJDA attend du DD/MM/YYYY (ou l'ISO s'il est de type date) :
      // l'ISO de l'API envoyé tel quel à un masque produisait une date
      // aberrante ("20/09/0925", vu en prod sur Nardi).
      const exp = expectedDob();

      let f = 0;
      if (setByName('nom',    adherent.nom))                       f++;
      if (setByName('prenom', adherent.prenom))                    f++;
      if (setByName('sexe',   adherent.sexe === 'F' ? 'F' : 'M')) f++;
      const dobEl = document.querySelector('[name="naissance"]');
      let dob = { ok: false, strategy: null, tried: [] };
      if (dobEl && exp) {
        dob = await fillDob(dobEl, exp);
        if (dob.ok) f++;
      }

      await wait(400);

      // Relecture JUSTE AVANT « VALIDER » : un formulaire incomplet n'est pas
      // soumis. FFJDA le refuserait sans naviguer, et l'échec n'apparaîtrait
      // qu'après 12 s sous un motif vague.
      const state = {
        nom: readByName('nom'), prenom: readByName('prenom'), naissance: readByName('naissance'),
      };
      const res = Object.assign({ step: 1, filled: f, submitted: false, success: false,
        dobExpected: exp ? exp.fr : '', dobStrategy: dob.strategy, dobTried: dob.tried }, state);
      if (!state.nom || !state.prenom) {
        res.reason = `Étape 1 : champs non pris en compte (nom="${state.nom || ''}", prénom="${state.prenom || ''}")`;
        return res;
      }
      const dobMsg = dobProblem(dobEl, exp);
      if (dobMsg) {
        // Page laissée telle quelle, champ date (celui qu'on VOIT) en
        // évidence : l'utilisateur peut taper la date et valider lui-même.
        // Pas de focus sur un input caché, ni sur le champ mobile (sur iOS il
        // ouvrirait la roue de dates sans geste de l'utilisateur).
        res.dobFailed = true;
        res.reason = dobMsg;
        const shown = dobVisible(dobEl) || dobEl;
        if (shown) {
          try { shown.style.outline = '3px solid #f57c00'; } catch (e) {}
          try { if (shown.scrollIntoView) shown.scrollIntoView({ block: 'center' }); } catch (e) {}
          if (!isType(shown, 'hidden') && !isType(shown, 'date')) { try { shown.focus(); } catch (e) {} }
        }
        return res;
      }
      const btn = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find(b => ((b.textContent || b.value || '').trim().toLowerCase()).includes('valider'));
      if (!btn) {
        res.reason = 'Étape 1 : bouton VALIDER introuvable';
        return res;
      }
      // Validation du navigateur AVANT le clic (checkValidity n'affiche rien) :
      // un champ requis invalide bloquerait la soumission sans navigation, et
      // le script ne le verrait qu'au bout de 12 s.
      const form = (dobEl && dobEl.form) || btn.form || document.querySelector('form');
      if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) {
        res.invalid = invalidMessages(form);
        res.reason = 'Étape 1 : formulaire incomplet, VALIDER non cliqué — '
          + (res.invalid.join(' | ') || 'champ requis invalide');
        return res;
      }
      realClick(btn);
      res.submitted = true;
      res.success = true;
      return res;
    }

    // ── Étape 1 à finir à la main (extension Chrome) ─────────────────────────
    // La popup se ferme dès qu'on touche la page : l'encadré montre donc dans
    // la page ce qu'il faut pour finir (surtout la date de naissance, que
    // l'utilisateur n'a pas sous la main). Ses boutons notent le choix, lu par
    // l'orchestrateur via 'manualStatus'. Le userscript affiche la même chose
    // dans son panneau.
    if (action === 'manualHelp') {
      const exp = expectedDob();
      const old = document.getElementById('jcc-etape1-box');
      if (old) old.remove();
      delete document.documentElement.dataset.jccEtape1Choice;
      const box = document.createElement('div');
      box.id = 'jcc-etape1-box';
      box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
        + 'width:min(440px,calc(100vw - 24px));background:#fff8e1;color:#222;border:2px solid #f57c00;'
        + 'border-radius:10px;padding:12px 14px;font:15px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
      const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const btnCss = 'padding:8px 12px;border:1px solid #f57c00;border-radius:6px;background:#fff;cursor:pointer;font-size:14px';
      const reason = (extra && extra.reason) || '';
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b style="color:#e65100">✋ À finir à la main, puis VALIDER</b>
          <button type="button" data-close style="border:none;background:none;font-size:20px;cursor:pointer">×</button></div>
        ${reason ? `<div style="margin:4px 0;font-size:13px;color:#555">${esc(reason)}</div>` : ''}
        <div style="margin:8px 0"><small style="color:#666">Date de naissance</small><br>
          <b style="font-size:26px;letter-spacing:1px;color:#b71c1c">${esc(exp ? exp.fr : 'absente des données HelloAsso')}</b>
          ${exp ? `<button type="button" data-copy="${esc(exp.fr)}" style="${btnCss};margin-left:8px">Copier la date</button>` : ''}</div>
        <div><b>${esc(adherent.nom)}</b> ${esc(adherent.prenom)} — ${adherent.sexe === 'F' ? 'Femme' : 'Homme'}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" data-choice="retry" style="${btnCss};flex:1">↻ Réessayer</button>
          <button type="button" data-choice="skip" style="${btnCss};flex:1">⏭ Passer cet adhérent</button></div>`;
      box.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.dataset) return;
        if (t.dataset.copy != null) {
          const done = (txt) => { t.textContent = txt; setTimeout(() => { t.textContent = 'Copier la date'; }, 1500); };
          try {
            navigator.clipboard.writeText(t.dataset.copy).then(() => done('Copié ✓'), () => done('Copie impossible'));
          } catch (err) { done('Copie impossible'); }
        } else if (t.dataset.choice) {
          document.documentElement.dataset.jccEtape1Choice = t.dataset.choice;
          box.remove();
        } else if (t.dataset.close != null) {
          box.remove();
        }
      });
      document.body.appendChild(box);
      return { shown: true };
    }
    // Choix fait dans l'encadré ('retry' | 'skip' | null), consommé à la lecture.
    if (action === 'manualStatus') {
      const choice = document.documentElement.dataset.jccEtape1Choice || null;
      delete document.documentElement.dataset.jccEtape1Choice;
      return { choice };
    }

    // ── Encadrés dans la page : copie, choix ─────────────────────────────────

    const escHtml = (v) => String(v == null ? '' : v)
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const boxCss = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + 'width:min(440px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:#fff8e1;'
      + 'color:#222;border:2px solid #f57c00;border-radius:10px;padding:12px 14px;'
      + 'font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    const btnCss = 'padding:8px 12px;border:1px solid #f57c00;border-radius:6px;background:#fff;cursor:pointer;font-size:14px';

    // navigator.clipboard absent ou refusé (ancien iOS, page non sécurisée) :
    // repli execCommand, sinon on le dit sans planter.
    function copyText(text, done) {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (e) { return false; }
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true), () => done(fallback()));
          return;
        }
      } catch (e) {}
      done(fallback());
    }

    // Boutons d'une pause (extension : la popup se ferme dès qu'on touche la
    // page, ils vivent donc dans l'encadré). Le choix est noté sur la page et
    // lu par l'orchestrateur via 'pauseStatus'. Le userscript a les mêmes
    // boutons dans son panneau et ne les met pas ici.
    function choicesHtml() {
      return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button type="button" data-choice="done" style="${btnCss};flex:1 1 100%">✓ C'est dans le panier, continuer</button>
          <button type="button" data-choice="retry" style="${btnCss};flex:1">↻ Réessayer</button>
          <button type="button" data-choice="skip" style="${btnCss};flex:1">⏭ Passer</button></div>`;
    }
    function wireBox(box) {
      box.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.dataset) return;
        if (t.dataset.copy != null) {
          const label = t.textContent;
          copyText(t.dataset.copy, (ok) => {
            t.textContent = ok ? 'Copié ✓' : 'Copie impossible';
            setTimeout(() => { t.textContent = label; }, 1500);
          });
        } else if (t.dataset.choice) {
          document.documentElement.dataset.jccPauseChoice = t.dataset.choice;
          box.remove();
        } else if (t.dataset.close != null) {
          box.remove();
        }
      });
    }

    // ── Adresse HelloAsso vs adresse FFJDA ───────────────────────────────────

    function selectedText(name) {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return '';
      if (el.tagName === 'SELECT') {
        const opt = el.options[el.selectedIndex];
        return opt ? (opt.textContent || '').trim() : '';
      }
      return (el.value || '').trim();
    }
    // Majuscules, sans accents ni ponctuation, abréviations de voie courantes.
    function normAddr(s) {
      return (' ' + normName(s).replace(/[^A-Z0-9]+/g, ' ') + ' ')
        .replace(/ (R|RUE) /g, ' RUE ').replace(/ (AV|AVE|AVENUE) /g, ' AVENUE ')
        .replace(/ (BD|BLD|BOULEVARD) /g, ' BOULEVARD ').replace(/ (IMP|IMPASSE) /g, ' IMPASSE ')
        .replace(/ (CHE|CHEM|CHEMIN) /g, ' CHEMIN ').replace(/ (PL|PLACE) /g, ' PLACE ')
        .replace(/ (ALL|ALLEE) /g, ' ALLEE ').replace(/ (RTE|ROUTE) /g, ' ROUTE ')
        .replace(/\s+/g, ' ').trim();
    }
    function addressCheck() {
      const ha = {
        adresse: (adherent.adresse || '').trim(),
        code_postal: (adherent.code_postal || '').trim(),
        ville: (adherent.ville || '').trim(),
      };
      const ffjda = { cp: selectedText('cp'), adresse: selectedText('adresse') };
      if (!ha.adresse && !ha.code_postal) return { mismatch: false, ha, ffjda };
      const cpDiff = !!ha.code_postal && !ffjda.cp.replace(/\s/g, '').includes(ha.code_postal.replace(/\s/g, ''));
      const a = normAddr(ha.adresse), b = normAddr(ffjda.adresse);
      const streetDiff = !!a && !(b && (b.includes(a) || a.includes(b)));
      return { mismatch: cpDiff || streetDiff, ha, ffjda };
    }
    // Encadré « adresse à saisir » : l'adresse HelloAsso COMPLÈTE, champ par
    // champ, avec Copier — l'utilisateur ne l'a pas sous la main.
    // opts : { reason, mode: 'nouvelle' | 'renouvellement', choices }
    function showAddressBox(addr, opts) {
      opts = opts || {};
      const old = document.getElementById('jcc-address-box');
      if (old) old.remove();
      const box = document.createElement('div');
      box.id = 'jcc-address-box';
      box.style.cssText = boxCss;
      const line = (label, value) => value ? `<div style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <div style="flex:1"><small style="color:#666">${label}</small><br><b>${escHtml(value)}</b></div>
          <button type="button" data-copy="${escHtml(value)}" style="${btnCss};padding:4px 10px">Copier</button></div>` : '';
      const intro = opts.mode === 'nouvelle'
        ? `Adresse non remplie automatiquement${opts.reason ? ` (${escHtml(opts.reason)})` : ''}.
          Choisissez le <b>code postal</b> puis l'<b>adresse</b> ci-dessous, puis cliquez sur <b>SUIVANT</b>.`
        : `L'adresse déclarée sur HelloAsso diffère de celle de la licence précédente.
          Corrigez le <b>code postal</b> puis l'<b>adresse</b> ci-dessous, puis cliquez sur <b>SUIVANT</b>.`;
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b style="color:#e65100">✋ Adresse à ${opts.mode === 'nouvelle' ? 'saisir' : 'mettre à jour'}</b>
          <button type="button" data-close style="border:none;background:none;font-size:18px;cursor:pointer">×</button></div>
        <div style="margin:4px 0 8px">${intro}</div>
        <div style="margin-bottom:4px"><b>${escHtml(adherent.nom)}</b> ${escHtml(adherent.prenom)} — adresse HelloAsso :</div>
        ${line('Rue', addr.ha.adresse)}
        ${line('Code postal', addr.ha.code_postal)}
        ${line('Ville', addr.ha.ville)}
        ${!addr.ha.adresse && !addr.ha.code_postal ? '<div><i>(aucune adresse dans les données HelloAsso)</i></div>' : ''}
        <div style="margin-top:8px;color:#666;font-size:12px">Actuellement sur FFJDA :
          ${escHtml([addr.ffjda.adresse, addr.ffjda.cp].filter(Boolean).join(' — ') || '(vide)')}</div>
        ${opts.choices ? choicesHtml() : ''}`;
      wireBox(box);
      document.body.appendChild(box);
      // Met en évidence les champs à corriger.
      ['cp', 'adresse'].forEach((n) => {
        const el = document.querySelector(`[name="${n}"]`);
        const target = (el && el.nextElementSibling && el.nextElementSibling.classList
          && el.nextElementSibling.classList.contains('select2')) ? el.nextElementSibling : el;
        if (target) target.style.outline = '3px solid #f57c00';
      });
      const cp = document.querySelector('[name="cp"]');
      if (cp && cp.scrollIntoView) cp.scrollIntoView({ block: 'center' });
    }

    // Réaffiche l'encadré (page rechargée pendant la correction manuelle),
    // sans rien remplir ni valider.
    if (action === 'showAddress') {
      const addr = addressCheck();
      showAddressBox(addr, extra);
      return { shown: true, mismatch: addr.mismatch };
    }

    // ── Pause après « Suivant » (extension) ──────────────────────────────────
    // Issue inconnue : rien n'est marqué « saisi » ni passé sans que
    // l'utilisateur le dise. extra : { kind, reason }.
    if (action === 'pauseHelp') {
      const old = document.getElementById('jcc-pause-box');
      if (old) old.remove();
      delete document.documentElement.dataset.jccPauseChoice;
      const kind = (extra && extra.kind) || '';
      const title = kind === 'timeout' ? '⏳ Pas de réponse de FFJDA'
        : kind === 'error' ? '⚠️ FFJDA a réaffiché le formulaire'
        : kind === 'nosubmit' ? '✋ Formulaire non envoyé'
        : '✋ En attente';
      const box = document.createElement('div');
      box.id = 'jcc-pause-box';
      box.style.cssText = boxCss;
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b style="color:#e65100">${title}</b>
          <button type="button" data-close style="border:none;background:none;font-size:18px;cursor:pointer">×</button></div>
        <div style="margin:4px 0"><b>${escHtml(adherent.nom)}</b> ${escHtml(adherent.prenom)}</div>
        ${extra && extra.reason ? `<div style="margin:4px 0;font-size:13px;color:#555">${escHtml(extra.reason)}</div>` : ''}
        ${choicesHtml()}`;
      wireBox(box);
      document.body.appendChild(box);
      return { shown: true };
    }
    // Choix fait dans un encadré de pause ('done' | 'retry' | 'skip' | null),
    // consommé à la lecture.
    if (action === 'pauseStatus') {
      const choice = document.documentElement.dataset.jccPauseChoice || null;
      delete document.documentElement.dataset.jccPauseChoice;
      return { choice };
    }

    // ── Envoi du formulaire (« Suivant ») ────────────────────────────────────
    // Vu en prod le 13/10/2026 : le script décidait 1,5–2,5 s après le clic,
    // puis naviguait vers l'adhérent suivant pendant que le POST FFJDA (lent)
    // était encore en vol — la navigation l'annulait, aucune licence au panier
    // sauf pour le DERNIER de la file, qui ne déclenche aucune navigation. Le
    // seul signal fiable qu'une requête part est l'événement `submit` du
    // formulaire, non annulé ; l'issue ne se lit que sur la page suivante.

    function findSuivant() {
      return Array.from(document.querySelectorAll('button.big-btn[type="submit"]'))
        .find(b => (b.textContent || '').trim().toLowerCase().includes('suivant')) || null;
    }
    // Ce qui empêche FFJDA d'envoyer : son disableBtn() (numéro de rue
    // manquant, vérification d'adresse) et le message affiché sous l'adresse.
    function submitBlockers(btn) {
      const out = [];
      const msg = document.getElementById('message_num-all');
      const m = msg ? String(msg.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (m) out.push(`FFJDA : ${m}`);
      if (btn && (btn.disabled || (btn.style && btn.style.pointerEvents === 'none'))) {
        out.push('bouton « Suivant » désactivé par FFJDA');
      }
      return out;
    }

    // Clique « Suivant » et dit si le formulaire est VRAIMENT parti. Le
    // `submit` est synchrone avec le clic (validation HTML5 → pas d'événement ;
    // handler FFJDA qui annule → defaultPrevented) : la réponse est donc sûre
    // dès le retour du clic. L'orchestrateur a noté pendingSubmit AVANT l'appel.
    if (action === 'submitForm') {
      const btn = findSuivant();
      if (!btn) return { clicked: false, submitted: false, reason: 'Bouton « Suivant » introuvable' };
      const blocked = submitBlockers(btn);
      if (blocked.length) return { clicked: false, submitted: false, reason: blocked.join(' — ') };
      let ev = null;
      const spy = (e) => { if (!ev && !ours(e.target)) ev = e; };
      document.addEventListener('submit', spy, true);
      try { btn.click(); } finally { document.removeEventListener('submit', spy, true); }
      if (!ev) {
        const form = btn.form || document.querySelector('form');
        const inv = form ? invalidMessages(form) : [];
        return { clicked: true, submitted: false,
          reason: inv.length ? `Formulaire refusé par le navigateur — ${inv.join(' | ')}`
            : 'Clic sur « Suivant » sans envoi du formulaire' };
      }
      if (ev.defaultPrevented) {
        const b2 = submitBlockers(btn);
        return { clicked: true, submitted: false, prevented: true,
          reason: 'Envoi annulé par la page FFJDA' + (b2.length ? ` — ${b2.join(' — ')}` : '') };
      }
      return { clicked: true, submitted: true };
    }

    // « Suivant » cliqué À LA MAIN pendant une pause. Le userscript écoute
    // lui-même ; le service worker de l'extension ne le peut pas : la page
    // note l'envoi, relevé par 'submitStatus'.
    if (action === 'watchSubmit') {
      const docEl = document.documentElement;
      if (!docEl.dataset.jccSubmitWatch) {
        docEl.dataset.jccSubmitWatch = '1';
        document.addEventListener('submit', (e) => {
          if (ours(e.target)) return;
          if (document.querySelector('input[name="souscription"]')) ensureIAC();
          docEl.dataset.jccSubmitAt = String(Date.now());
          delete docEl.dataset.jccSubmitPrevented;
          // defaultPrevented n'est définitif qu'une fois tous les handlers passés.
          setTimeout(() => { if (e.defaultPrevented) docEl.dataset.jccSubmitPrevented = '1'; }, 0);
        }, true);
      }
      return { watching: true };
    }
    // Envoi relevé depuis le dernier appel (consommé à la lecture).
    if (action === 'submitStatus') {
      const docEl = document.documentElement;
      const at = Number(docEl.dataset.jccSubmitAt || 0);
      if (!at || Date.now() - at < 50) return { submitted: false, prevented: false, at: at || null };
      const prevented = docEl.dataset.jccSubmitPrevented === '1';
      delete docEl.dataset.jccSubmitAt;
      delete docEl.dataset.jccSubmitPrevented;
      return { submitted: !prevented, prevented, at,
        reason: prevented ? (submitBlockers(findSuivant()).join(' — ') || 'envoi annulé par la page FFJDA') : '' };
    }

    // ── Assurance IAC ───────────────────────────────────────────────────────

    // Assurance IAC — TOUJOURS "Oui". Le mapping FFJDA est INVERSÉ :
    // value="0" = « Oui » (souscrire), value="1" = « Non » (refus, qui OUVRE
    // un modal Bootstrap). On coche donc value="0" et on désélectionne
    // value="1" SANS JAMAIS le cliquer, pour ne pas déclencher ce modal.
    // Ré-appliqué avant "Suivant" : remplir le CP/l'adresse (select2)
    // déclenche un recalcul FFJDA qui remet la souscription sur "Non".
    function ensureIAC() {
      // IDEMPOTENT : ne dispatche input/change que si l'état doit vraiment
      // changer. ensureIAC() est appelée jusqu'à 3 fois dans ce flux
      // (avant l'adresse, après — le recalcul FFJDA la remet sur "Non" —,
      // et une dernière vérification). La redéclencher SANS CONDITION à
      // chaque appel, même quand "Oui" était déjà correctement sélectionné,
      // fait boucler indéfiniment un handler jQuery du site FFJDA lui-même
      // ("Uncaught RangeError: Maximum call stack size exceeded" dans leur
      // main.js, au moment de Suivant/submit) — vu en prod sur Nardi/Reniez,
      // confirmé par un test manuel : recommencer proprement ne plante pas.
      const oui = document.querySelector('input[name="souscription"][value="0"]');
      const non = document.querySelector('input[name="souscription"][value="1"]');
      let okRadio = false;
      if (oui) {
        if (!oui.checked || (non && non.checked)) {
          if (non) non.checked = false;
          if (!oui.checked) oui.click();   // clic réel : réveille le handler
          oui.checked = true;              // puis verrouille l'état
          const lbl = oui.id && document.querySelector(`label[for="${oui.id}"]`);
          if (lbl) lbl.dispatchEvent(new MouseEvent('click', { bubbles: true })); // idempotent sur un radio
          oui.checked = true;
          oui.dispatchEvent(new Event('input',  { bubbles: true }));
          oui.dispatchEvent(new Event('change', { bubbles: true }));
        }
        okRadio = oui.checked;
      } else {
        console.log('[JCCR] IAC: radio input[name="souscription"][value="0"] introuvable');
      }
      // Case "assurance" : pas de clic sur le label, il RE-BASCULERAIT la case.
      let okCase = false;
      const ass = document.querySelector('input[name="assurance"]');
      if (ass) {
        if (!ass.checked) {
          ass.click();
          ass.checked = true;
          ass.dispatchEvent(new Event('input',  { bubbles: true }));
          ass.dispatchEvent(new Event('change', { bubbles: true }));
        }
        okCase = ass.checked;
      } else {
        console.log('[JCCR] IAC: case input[name="assurance"] introuvable');
      }
      return okRadio || okCase;
    }

    // Aussi appelée SYNCHRONEMENT pendant l'événement `submit` d'un « Suivant »
    // cliqué à la main (voir watchSubmit et le userscript) : la saisie
    // manuelle de l'adresse déclenche le même recalcul FFJDA, et les données
    // envoyées ne sont lues qu'après ce handler.
    if (action === 'ensureIAC') return { ok: ensureIAC() };

    // ── Étape 2, commune aux nouvelles licences et aux renouvellements ───────

    if (action === 'etape2') {
      // Adresse (nouvelle licence, CP vide) : ni frappe ni ouverture de liste.
      // L'ancienne simulation select2 (ouvrir, taper, cliquer une option) ne
      // marchait pas sur iPhone : le userscript y tourne dans un monde JS
      // isolé où le jQuery de la page est invisible — pageJQuery() rendait
      // undefined et l'adresse restait vide à chaque fois (13/10/2026). Elle
      // retombait en outre sur la 1re commune du CP quand la ville HelloAsso
      // portait un accent (« Beyren-lès-Sierck » → « BASSE RENTGEN »).
      // Désormais : mêmes requêtes que le widget, puis sélection programmatique
      // qui déclenche les handlers FFJDA (setDataVille, getCoordonnees) avec
      // exactement les données qu'il leur passe — voir capAddress.

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

      // Exécutée dans le monde JS de la PAGE (là où vivent jQuery, select2 et
      // les handlers FFJDA) : appelée directement si on y est déjà (extension,
      // monde MAIN), sinon injectée par runInPage. AUTO-SUFFISANTE, donc : elle
      // est sérialisée par toString(). p : { cp, ville, adresse }.
      // Reproduit main.js FFJDA : autocompletion_ville (GET ajax/cap-adresse/cp
      // → {id: postalCode, text: inputOutput, ville: locality, localityid}),
      // autocompletion_adresse (GET ajax/cap-adresse/street → {id/text:
      // streetNumber + ' ' + streetName, forced: false}, filtrés sur le CP).
      const capAddress = async function (p) {
        const $ = window.jQuery;
        if (!$ || !$.fn || !$.fn.select2) return { ok: false, reason: 'jQuery / select2 du site FFJDA introuvables' };
        // `let URL_SITE` dans la page FFJDA : liaison globale, pas window.URL_SITE.
        const site = (typeof URL_SITE !== 'undefined' && URL_SITE) ? URL_SITE : location.origin + '/';
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const norm = (s) => (' ' + String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^A-Z0-9]+/g, ' ') + ' ')
          .replace(/ (R|RUE) /g, ' RUE ').replace(/ (AV|AVE|AVENUE) /g, ' AVENUE ')
          .replace(/ (BD|BLD|BOULEVARD) /g, ' BOULEVARD ').replace(/ (IMP|IMPASSE) /g, ' IMPASSE ')
          .replace(/ (CHE|CHEM|CHEMIN) /g, ' CHEMIN ').replace(/ (PL|PLACE) /g, ' PLACE ')
          .replace(/ (ALL|ALLEE) /g, ' ALLEE ').replace(/ (RTE|ROUTE) /g, ' ROUTE ')
          .replace(/ ST /g, ' SAINT ').replace(/ STE /g, ' SAINTE ')
          .replace(/\s+/g, ' ').trim();
        const numKey = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');
        const list = (d) => {
          const a = d && d.addresses && d.addresses.address;
          return Array.isArray(a) ? a : (a ? [a] : []);
        };
        // Même transport que le widget ($.ajax de la page : même origine,
        // cookies de session, X-Requested-With).
        const get = (path, data) => new Promise((resolve, reject) => {
          $.ajax({ url: site + path, dataType: 'json', type: 'GET', data })
            .done(resolve)
            .fail((x, st) => reject(new Error(`${path} : ${(x && x.status) || st || 'échec'}`)));
        });
        // Sélection comme la ferait le widget : option créée si absente (le
        // CP est la valeur de PLUSIEURS communes : on cible la bonne), valeur,
        // 'change' (rendu select2), puis 'select2:select' avec les données
        // qu'attendent les handlers FFJDA.
        const choose = ($sel, d) => {
          const el = $sel[0];
          let opt = Array.from(el.options).find((o) => o.value === d.id && o.text === d.text);
          if (!opt) { opt = new Option(d.text, d.id, false, false); el.appendChild(opt); }
          $(opt).data('data', d);
          $sel.val(d.id);
          opt.selected = true;
          $sel.trigger('change');
          $sel.trigger($.Event('select2:select', { params: { data: d } }));
        };

        const $cp = $('#cp-selector-all'), $st = $('#street-selector-all');
        const info = document.getElementById('info-cap-adresse-all');
        if (!$cp.length || !$st.length || !info) {
          return { ok: false, reason: 'champs adresse FFJDA introuvables (#cp-selector-all, #street-selector-all)' };
        }

        // 1. Commune
        let found;
        try { found = list(await get('ajax/cap-adresse/cp', { cp: p.cp })); } catch (e) {
          return { ok: false, reason: `recherche du code postal ${p.cp} sur FFJDA impossible (${e.message})` };
        }
        const communes = found
          .map((i) => ({ id: String(i.postalCode), text: i.inputOutput, ville: i.locality, localityid: i.localityId }))
          .filter((c) => c.id === p.cp);
        const v = norm(p.ville);
        let cp = communes.find((c) => norm(c.ville) === v) || null;
        if (!cp && v) {
          const loose = communes.filter((c) => { const n = norm(c.ville); return n && (n.includes(v) || v.includes(n)); });
          if (loose.length === 1) cp = loose[0];
        }
        if (!cp && !v && communes.length === 1) cp = communes[0];
        if (!cp) {
          return { ok: false, reason: communes.length
            ? `commune « ${p.ville} » absente des propositions FFJDA pour ${p.cp} (${communes.map((c) => c.ville).join(', ')})`
            : `code postal ${p.cp} inconnu de FFJDA` };
        }
        choose($cp, { id: cp.id, text: cp.text, ville: cp.ville, localityid: cp.localityid });
        if (info.dataset.cp !== cp.id || String(info.dataset.localityid) !== String(cp.localityid)) {
          return { ok: false, cp: cp.text, reason: 'commune non prise en compte par FFJDA (setDataVille)' };
        }

        // 2. Rue — numéro IDENTIQUE obligatoire.
        const m = /^\s*(\d+)\s*(BIS|TER|QUATER|[A-Z])?\b[\s,]*(.*)$/i.exec(p.adresse);
        const wantNum = m ? numKey(m[1] + (m[2] || '')) : '';
        const wantName = norm(m ? m[3] : p.adresse);
        try {
          found = list(await get('ajax/cap-adresse/street', { adresse: p.adresse, localityid: info.dataset.localityid,
            postalCode: info.dataset.cp, locality: info.dataset.locality }));
        } catch (e) {
          return { ok: false, cp: cp.text, reason: `recherche de l'adresse sur FFJDA impossible (${e.message})` };
        }
        const streets = found.filter((i) => String(i.postalCode) === cp.id).map((i) => {
          const n = i.streetNumber == undefined ? '' : i.streetNumber;
          return { id: n + ' ' + i.streetName, text: n + ' ' + i.streetName, n: numKey(n), name: norm(i.streetName) };
        });
        const sameNum = streets.filter((s) => s.n === wantNum);
        let street = sameNum.find((s) => s.name === wantName) || null;
        if (!street && wantName) {
          const loose = sameNum.filter((s) => s.name && (s.name.includes(wantName) || wantName.includes(s.name)));
          if (loose.length === 1) street = loose[0];
        }
        if (!street) {
          return { ok: false, cp: cp.text, reason: streets.length
            ? `« ${p.adresse} » ne correspond à aucune adresse FFJDA de même numéro (propositions : ${streets.slice(0, 4).map((s) => s.text.trim()).join(', ')})`
            : `aucune adresse trouvée par FFJDA pour « ${p.adresse} » à ${cp.ville}` };
        }
        choose($st, { id: street.id, text: street.text, forced: false });

        // 3. getCoordonnees (AJAX FFJDA) : attendre les coordonnées, ou son
        // message « Des numéros sont disponibles… ».
        const t0 = Date.now();
        const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '') : ''; };
        const msg = () => { const el = document.getElementById('message_num-all'); return el ? el.textContent.trim() : ''; };
        await sleep(50);
        while (Date.now() - t0 < 10000) {
          if (!($.active > 0) && ((val('latitude-all') && val('longitude-all')) || msg())) break;
          await sleep(100);
        }
        return { ok: true, cp: cp.text, street: street.text.trim(),
          coords: !!(val('latitude-all') && val('longitude-all')), codeinsee: val('codeinsee-all'), waitedMs: Date.now() - t0 };
      };

      // Exécute `fn(arg)` dans le monde JS de la page par un <script> inséré
      // (pas de CSP sur moncompte.ffjudo.com) ; résultat rendu via un attribut
      // du DOM, partagé entre mondes.
      function runInPage(fn, arg, timeoutMs) {
        return new Promise((resolve) => {
          const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          const attr = `data-jcc-page-${id}`;
          const docEl = document.documentElement;
          const s = document.createElement('script');
          s.textContent = `(${fn.toString()})(${JSON.stringify(arg)})`
            + `.then((r) => r, (e) => ({ ok: false, reason: 'erreur : ' + ((e && e.message) || e) }))`
            + `.then((r) => document.documentElement.setAttribute('${attr}', JSON.stringify(r || {})));`;
          (document.head || docEl).appendChild(s);
          s.remove();
          const t0 = Date.now();
          (function poll() {
            const v = docEl.getAttribute(attr);
            if (v != null) {
              docEl.removeAttribute(attr);
              try { resolve(JSON.parse(v)); } catch (e) { resolve({ ok: false, reason: 'réponse illisible du script de page' }); }
              return;
            }
            if (Date.now() - t0 > timeoutMs) {
              resolve({ ok: false, reason: 'script de page sans réponse (bloqué par le site ?)' });
              return;
            }
            setTimeout(poll, 100);
          })();
        });
      }

      // Vérification APRÈS coup, dans le DOM (indépendante du monde JS) : ce
      // que FFJDA enverra réellement.
      function addressProblems() {
        const out = [];
        const ville = document.getElementById('ville-all');
        const info = document.getElementById('info-cap-adresse-all');
        const street = document.querySelector('[name="adresse"]');
        if (!ville || !String(ville.value || '').trim()) out.push('ville FFJDA vide');
        if (!info || !info.dataset.cp || !info.dataset.localityid) out.push('commune non enregistrée par FFJDA');
        if (!street || !String(street.value || '').trim()) out.push('adresse FFJDA vide');
        return out.concat(submitBlockers(findSuivant()));
      }

      async function autoAddress() {
        const p = {
          cp: String(adherent.code_postal || '').replace(/\s/g, ''),
          ville: String(adherent.ville || '').trim(),
          adresse: String(adherent.adresse || '').trim(),
        };
        if (!/^\d{5}$/.test(p.cp)) return { ok: false, reason: `code postal HelloAsso inutilisable (« ${adherent.code_postal || ''} »)` };
        if (!p.adresse) return { ok: false, reason: 'adresse absente des données HelloAsso' };
        // window.jQuery et NON pageJQuery() : il faut savoir si NOTRE monde JS
        // est celui de la page. Sous un gestionnaire de userscripts (monde
        // isolé), on passe par un script de page.
        const w = window;
        const here = !!(w.jQuery && w.jQuery.fn && w.jQuery.fn.select2);
        let res;
        if (here) {
          try { res = await capAddress(p); } catch (e) { res = { ok: false, reason: `erreur : ${e.message}` }; }
        } else {
          res = await runInPage(capAddress, p, 25000);
        }
        res = Object.assign({ ok: false, reason: 'pas de réponse' }, res, { via: here ? 'page' : 'script de page' });
        const problems = addressProblems();
        if (res.ok && problems.length) Object.assign(res, { ok: false, reason: problems.join(' — ') });
        return res;
      }

      const opts = extra || {};
      const cpEl  = document.querySelector('[name="cp"]');
      const hasCP = cpEl && cpEl.value && cpEl.value.trim().length > 0;
      let auto = null;
      // Renouvellement : jamais d'adresse automatique (FFJDA préremplit celle
      // de la saison passée ; si elle diffère, l'utilisateur tranche).
      if (opts.autoAddress && !hasCP && (adherent.code_postal || adherent.adresse)) {
        auto = await autoAddress();
        if (auto.ok) f++;
      }

      await wait(300);
      restoreBelt(beltSnap);
      // APRÈS l'adresse : le recalcul FFJDA remet la souscription sur « Non ».
      ensureIAC();

      const addr = addressCheck();
      if ((auto && !auto.ok) || addr.mismatch) {
        const reason = (auto && !auto.ok) ? auto.reason : 'adresse FFJDA différente de celle déclarée sur HelloAsso';
        showAddressBox(addr, { reason, mode: auto ? 'nouvelle' : 'renouvellement', choices: !!opts.choices });
        return { step: 2, success: true, ready: false, filled: f, submitted: false, needsAddress: true,
          addressReason: reason, autoAddress: auto, ffjdaAddress: addr.ffjda, haAddress: addr.ha };
      }

      await wait(400);
      // Dernière vérification avant de valider : "Oui" (value=0) bien actif.
      const oui = document.querySelector('input[name="souscription"][value="0"]');
      if (!oui || !oui.checked) ensureIAC();

      // Pas de clic ici : l'orchestrateur note pendingSubmit PUIS appelle
      // 'submitForm' (une soumission ne doit jamais partir sans trace).
      return { step: 2, success: true, ready: true, filled: f, submitted: false, autoAddress: auto };
    }

    // Après le clic "Suivant" de l'étape 2, FFJDA peut refuser en base (adresse
    // select2 mal résolue, doublon...) et réafficher un modal d'erreur SANS
    // changer d'URL de façon fiable — le comptage `f > 0` de l'étape 2 ne le
    // voit pas puisqu'il ne reflète que "des champs ont été remplis", pas que
    // l'enregistrement serveur a réussi. Vu en prod : "ERREUR LORS DE
    // L'ENREGISTREMENT DE LA LICENCE — An error occurred while updating the
    // entries." (Driouach, Reniez).
    if (action === 'checkError') {
      const el = Array.from(document.querySelectorAll('div, p, span, h1, h2, h3, h4'))
        .find(e => {
          const t = (e.textContent || '').toUpperCase();
          return t.includes('ERREUR') && (t.includes('ENREGISTREMENT') || t.includes('UPDATING THE ENTRIES'));
        });
      return { hasError: !!el, errorText: el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 300) : '' };
    }

    // Formulaire soumis sans navigation : pourquoi FFJDA l'a-t-il refusé ?
    // Messages visibles (classes usuelles, texte rouge près des champs) et
    // validation HTML5 des champs invalides, pour un motif d'échec parlant
    // au lieu de « formulaire refusé ? ».
    if (action === 'formErrors') {
      const msgs = [];
      const add = (t) => {
        t = String(t || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 300 && !msgs.includes(t)) msgs.push(t);
      };
      const shown = (el) => !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));

      document.querySelectorAll('.invalid-feedback, .alert, .help-block, .text-danger, .error, .form-error, '
        + '.field-error, .parsley-errors-list, [role="alert"]').forEach((el) => {
        if (ours(el) || !shown(el)) return;
        if (el.classList && (el.classList.contains('alert-info') || el.classList.contains('alert-success'))) return;
        add(el.textContent);
      });
      invalidMessages(document).forEach(add);
      if (typeof getComputedStyle === 'function') {
        const anchor = document.querySelector('[name="naissance"]') || document.querySelector('[name="nom"]');
        const form = (anchor && anchor.form) || document.querySelector('form');
        if (form) {
          form.querySelectorAll('span, small, p, div, label, li').forEach((el) => {
            if (el.children.length || ours(el) || !shown(el)) return;
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color || '');
            if (m && +m[1] >= 150 && +m[2] <= 90 && +m[3] <= 90) add(el.textContent);
          });
        }
      }

      const dobEl = document.querySelector('[name="naissance"]');
      const dobReason = dobEl ? dobProblem(dobEl, expectedDob()) : '';
      const errors = msgs.slice(0, 6);
      return { errors, text: errors.join(' | '), naissance: dobEl ? dobEl.value : null,
        dobMissing: !!dobReason, dobReason };
    }

    return { error: `Action inconnue : ${action}` };
  }

  root.FfjdaFlow = { detectStep, applyStep, dobFr };
})(typeof self !== 'undefined' ? self : this);



(function () {
  'use strict';

  // Affiché dans l'en-tête du panneau : permet de vérifier d'un coup d'œil
  // quelle version tourne réellement (l'app Userscripts peut servir une
  // copie en cache). À garder synchro avec @version en tête de fichier.
  const SCRIPT_VERSION = '1.10.0';

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
  const { detectStep, applyStep, dobFr } = (self.FfjdaFlow || {});
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
        // Résultats chargés depuis un moment, la personne y figure mais sans
        // lien : déjà licenciée cette saison, inutile d'attendre le timeout.
        if (Date.now() - start > 8000) {
          const n = await applyStep('nameOnPage', adherent);
          if (n && n.present) return { found: false, listedNoLink: true };
        }
      } catch (e) {}
    }
    return { found: false, timeout: true };
  }

  // ================================================================
  // Queue — équivalent de flowState / nextInQueue / finishAdherent
  // côté extension, mais persisté via storeGet/storeSet puisqu'une
  // navigation de page recharge intégralement le script.
  // ================================================================
  const RENEW_SEARCH_URL = 'https://moncompte.ffjudo.com/espace-club/prise-licence/renouvellement-licencie-club';
  const NEW_LICENCE_URL  = 'https://moncompte.ffjudo.com/espace-club/prise-licence/saisir-licence';

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
  async function navigatedWithin(timeoutMs) {
    const from = location.href;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
      if (location.href !== from) return true;   // navigation en cours
    }
    return false;
  }

  async function failIfNoNavigation(flow, adherent, reason, timeoutMs = 12000) {
    if (await navigatedWithin(timeoutMs)) return;
    await setStatus(`${adherent.nom} — ${reason}`, 'error');
    await finishAdherent(flow, adherent, false, reason, 1500);
  }

  async function finishAdherent(flow, adherent, ok, reason, delay = 2000) {
    flow.results.push({
      idx: flow.current,
      nom: adherent.nom, prenom: adherent.prenom, mode: modeOf(adherent, flow), ok, reason: reason || null,
    });
    // Issue déclarée : plus aucune page de création ne doit être traitée pour
    // cet adhérent (voir creationAllowed).
    flow.creationFor = null;
    await storeSet('flow', flow);
    setTimeout(() => { nextInQueue(); }, delay);
  }

  // Une page de création (intermédiaire, étape 2) n'est traitée que si l'étape
  // 1 a été lancée pour l'adhérent COURANT et qu'aucune issue n'a été déclarée
  // depuis. Sinon c'est une navigation tardive : étape 1 déclarée en échec au
  // bout de 12 s alors que FFJDA répondait encore, éventuellement après que la
  // file soit passée à l'adhérent suivant — on compléterait alors la licence
  // d'une personne avec les données d'une autre, et on marquerait « saisi »
  // quelqu'un pour qui rien n'a été créé.
  async function creationAllowed(flow, adherent, idx, total, page) {
    if (flow.creationFor === idx) return true;
    const why = `${page} FFJDA atteinte sans étape 1 en cours pour cet adhérent (navigation tardive) — rien fait, à vérifier sur FFJDA`;
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — ${why}`, 'error');
    if (flow.results.some(r => r.idx === idx)) {
      // Issue déjà enregistrée : ne pas la compter deux fois, juste avancer
      // (le passage au suivant programmé par l'ancienne page a disparu avec elle).
      setTimeout(() => { nextInQueue(); }, 3000);
    } else {
      await finishAdherent(flow, adherent, false, why, 3000);
    }
    return false;
  }

  // Étape 1 en échec SANS navigation (date non prise, validation du
  // navigateur, formulaire refusé, erreur de script) : on ne passe JAMAIS
  // tout seul à l'adhérent suivant — sur iPhone, le président enchaînait
  // ainsi des échecs sans pouvoir finir à la main. La file se met en attente,
  // page laissée remplie, et le panneau affiche ce qu'il faut pour finir
  // (surtout la date de naissance). VALIDER cliqué à la main : la page
  // suivante (intermédiaire) reprend la file via handleStep, comme l'adresse
  // à corriger. Rien n'est marqué saisi ici : seule l'étape 2 le fait.
  async function waitManualEtape1(flow, adherent, idx, total, reason) {
    flow.manualEtape1 = { url: location.href };
    await storeSet('flow', flow);
    const dob = dobFr(adherent.date_naissance);
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} ${adherent.prenom} — ✋ ${reason}.`
      + `\nÀ finir à la main${dob ? ` (date de naissance : ${dob})` : ''} puis VALIDER : la file reprendra ensuite.`, 'error');
    renderManualEtape1Controls(flow);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // navigator.clipboard absent ou refusé (page non sécurisée, ancien iOS) :
  // repli execCommand, sinon on le dit sans planter.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  // Carte « à finir à la main » : données de l'adhérent en clair (la date
  // n'est pas sous la main de l'utilisateur, qui ne veut pas aller la
  // chercher sur HelloAsso), + Copier la date / Réessayer / Passer.
  function renderManualEtape1Controls(flow) {
    const content = document.getElementById('jcc-ffjda-content');
    if (!content) return;
    const old = content.querySelector('#jcc-e1-manual');
    if (old) old.remove();
    const adherent = flow.queue[flow.current];
    if (!adherent) return;
    const dob = dobFr(adherent.date_naissance);
    const wrap = document.createElement('div');
    wrap.id = 'jcc-e1-manual';
    wrap.innerHTML = `
      <div class="jcc-manual">
        <div class="lbl">Date de naissance</div>
        <div class="dob">${dob ? esc(dob) : 'absente des données HelloAsso'}</div>
        <div class="lbl">Nom / Prénom / Sexe</div>
        <div class="val">${esc(adherent.nom)} ${esc(adherent.prenom)} — ${adherent.sexe === 'F' ? 'Femme' : 'Homme'}</div>
      </div>
      ${dob ? '<button class="jcc-btn" id="jcc-e1-copy">📋 Copier la date</button>' : ''}
      <div class="jcc-btn-row">
        <button class="jcc-btn" id="jcc-e1-retry">↻ Réessayer</button>
        <button class="jcc-btn secondary" id="jcc-e1-skip">⏭ Passer cet adhérent</button>
      </div>`;
    content.prepend(wrap);
    // Panneau replié : on le rouvre, c'est là qu'est la date.
    const body = document.getElementById('jcc-ffjda-body');
    if (body) body.style.display = '';

    const copyBtn = wrap.querySelector('#jcc-e1-copy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const ok = await copyText(dob);
      copyBtn.textContent = ok ? '✓ Date copiée' : `Copie impossible — ${dob}`;
      setTimeout(() => { copyBtn.textContent = '📋 Copier la date'; }, 2000);
    });
    wrap.querySelector('#jcc-e1-retry').addEventListener('click', async () => {
      const cur = await storeGet('flow', null);
      if (!cur || !cur.manualEtape1) return;
      wrap.remove();
      delete cur.manualEtape1;
      await storeSet('flow', cur);
      await runEtape1(cur, cur.queue[cur.current], cur.current, cur.queue.length);
    });
    wrap.querySelector('#jcc-e1-skip').addEventListener('click', async () => {
      const cur = await storeGet('flow', null);
      if (!cur || !cur.manualEtape1) return;
      wrap.remove();
      delete cur.manualEtape1;
      await storeSet('flow', cur);
      await setStatus(`${adherent.nom} — passé à la main (étape 1 non validée).`, 'error');
      await finishAdherent(cur, adherent, false, 'Étape 1 non validée (date de naissance / formulaire) — passé à la main, rien créé', 500);
    });
  }

  // Étape 1 nouvelle licence : remplit, VALIDER, et en cas d'échec sans
  // navigation se met en attente (waitManualEtape1) au lieu d'avancer.
  async function runEtape1(flow, adherent, idx, total) {
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 1...`, 'info');
    try {
      // Armé AVANT le clic sur VALIDER : seule une étape 1 lancée pour CET
      // adhérent autorise la suite de la création (voir creationAllowed).
      flow.creationFor = idx;
      await storeSet('flow', flow);
      const r = await applyStep('etape1', adherent);
      if (!r || !r.success) {
        await waitManualEtape1(flow, adherent, idx, total, (r && r.reason) || 'Étape 1 : aucun champ rempli');
        return;
      }
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 1 ✅ → Validation...`, 'info');
      if (await navigatedWithin(12000)) return;
      // Pas de navigation : FFJDA a refusé le formulaire. On lit pourquoi
      // sur la page plutôt que de deviner.
      let fe = null;
      try { fe = await applyStep('formErrors', adherent); } catch (e) {}
      const why = (fe && fe.dobMissing)
        ? fe.dobReason + (fe.text ? ` — message FFJDA : ${fe.text}` : '')
        : 'Étape 1 validée sans effet — '
          + (fe && fe.text ? `FFJDA : ${fe.text}` : 'aucun message d\'erreur visible sur la page');
      await waitManualEtape1(flow, adherent, idx, total, why);
    } catch (e) {
      await waitManualEtape1(flow, adherent, idx, total, 'Erreur étape 1 : ' + e.message);
    }
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
    await setStatus(`[${flow.current + 1}/${flow.queue.length}] ${adherent.nom} ${adherent.prenom}...`, 'info');
    location.href = RENEW_SEARCH_URL;
  }

  async function startQueue(queue) {
    const adherent = queue[0];
    const flow = { queue, current: 0, results: [] };
    await storeSet('flow', flow);
    await setStatus(`[1/${queue.length}] ${adherent.nom} ${adherent.prenom}...`, 'info');
    // Toujours par la recherche de renouvellement, y compris pour une
    // nouvelle licence (vérification qu'aucune licence n'existe déjà).
    location.href = RENEW_SEARCH_URL;
  }

  // ================================================================
  // « Suivant » (étape 2 / renouvellement) : ne JAMAIS perdre un envoi
  // ================================================================
  // Incident du 13/10/2026 (iPhone, file de 3 nouvelles licences) : seule la
  // dernière est arrivée au panier, les deux autres marquées « saisi » sans
  // licence. Le script décidait 1,5–2,5 s après « Suivant », puis naviguait
  // vers l'adhérent suivant alors que le POST FFJDA (lent) était encore en
  // vol : la navigation l'annulait. Le dernier de la file, sans navigation
  // derrière, passait. Désormais :
  //  • flow.pendingSubmit = { id, idx, url, step, at, kind } est noté AVANT
  //    l'envoi automatique, ou dès l'événement `submit` d'un clic manuel ;
  //  • tant qu'il est posé, le script ne navigue pas : seule la page
  //    SUIVANTE décide (resolvePendingSubmit) — panier ou autre page = succès,
  //    même formulaire réaffiché = refus FFJDA ;
  //  • rien après SUBMIT_TIMEOUT_MS : pause (flow.pause), rien n'est marqué ni
  //    passé sans que l'utilisateur le dise (« C'est dans le panier »,
  //    « Réessayer », « Passer »).
  const SUBMIT_TIMEOUT_MS = 60000;
  const PANIER_RE = /d[ée]j[àa]\s+dans\s+le\s+panier/i;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isFormStep(step) { return step === 'etape2' || step === 'renew_form'; }

  // Réglage de test (clé de stockage submit_timeout_ms) ; 60 s sinon.
  async function submitTimeoutMs() {
    const v = Number(await storeGet('submit_timeout_ms', 0));
    return v > 0 ? v : SUBMIT_TIMEOUT_MS;
  }

  // Remplit le formulaire (étape 2 ou renouvellement) puis l'envoie. Adresse
  // automatique en nouvelle licence seulement (voir applyStep 'etape2').
  async function runForm(flow, adherent, idx, total, step) {
    const label = step === 'renew_form' ? 'formulaire renouvellement' : 'étape 2';
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — ${label}...`, 'info');
    await sleep(1200);
    let r;
    try {
      r = await applyStep('etape2', adherent, { autoAddress: step === 'etape2' });
    } catch (e) {
      await enterPause(flow, adherent, 'nosubmit', `Erreur ${label} : ${e.message}`);
      return;
    }
    if (r && r.needsAddress) {
      await enterPause(flow, adherent, 'address', r.addressReason || '');
      return;
    }
    if (!r || !r.ready) {
      await enterPause(flow, adherent, 'nosubmit', `${label} : formulaire non rempli`);
      return;
    }
    const a = r.autoAddress;
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — ${label} remplie`
      + (a && a.ok ? ` (adresse : ${a.street}, ${a.cp})` : '') + ' → Suivant...', 'info');
    await autoSubmit(flow, adherent, idx, total, step);
  }

  let autoSubmitting = false;

  async function autoSubmit(flow, adherent, idx, total, step) {
    const ps = { id: Date.now(), idx, url: location.href, step, at: Date.now(), kind: 'auto' };
    flow.pendingSubmit = ps;
    delete flow.pause;
    await storeSet('flow', flow);                    // AVANT le clic
    let r;
    autoSubmitting = true;
    try { r = await applyStep('submitForm', adherent); }
    catch (e) { r = { submitted: false, reason: 'Erreur : ' + e.message }; }
    finally { autoSubmitting = false; }
    if (!r || !r.submitted) {
      // Rien n'est parti (validation du navigateur, bouton désactivé par
      // FFJDA, message sous l'adresse) : on le dit, on attend l'utilisateur.
      delete flow.pendingSubmit;
      await storeSet('flow', flow);
      let fe = null;
      try { fe = await applyStep('formErrors', adherent); } catch (e) {}
      const why = ((r && r.reason) || 'Formulaire non envoyé') + (fe && fe.text ? ` — FFJDA : ${fe.text}` : '');
      await enterPause(flow, adherent, 'nosubmit', why);
      return;
    }
    await waitSubmitNavigation(adherent, ps, total);
  }

  // Envoi parti : on attend que FFJDA réponde. Si la page change, ce
  // contexte disparaît et la page suivante conclut (resolvePendingSubmit).
  async function waitSubmitNavigation(adherent, ps, total) {
    const timeout = await submitTimeoutMs();
    await setStatus(`[${ps.idx + 1}/${total}] ${adherent.nom} — « Suivant » envoyé à FFJDA, attente de la page suivante`
      + ` (jusqu'à ${Math.round(timeout / 1000)} s)… Ne quittez pas la page.`, 'info');
    const end = Date.now() + timeout;
    const mine = (f) => f && f.pendingSubmit && f.pendingSubmit.id === ps.id;
    while (Date.now() < end) {
      await sleep(500);
      if (!mine(await storeGet('flow', null))) return;   // annulé, remplacé, décidé
    }
    // Toujours sur la même page : ni « succès probable » ni « saisi ».
    // pendingSubmit reste posé : si FFJDA finit par répondre, la page
    // suivante conclura d'elle-même.
    const cur = await storeGet('flow', null);
    if (!mine(cur)) return;
    await enterPause(cur, adherent, 'timeout', `Pas de réponse de FFJDA ${Math.round(timeout / 1000)} s après « Suivant ». `
      + 'Vérifiez le panier FFJDA (la page peut encore changer d\'elle-même).');
  }

  // Au chargement d'une page alors qu'un envoi était en vol pour l'adhérent courant.
  async function resolvePendingSubmit(flow, adherent) {
    const ps = flow.pendingSubmit;
    const idx = flow.current, total = flow.queue.length;
    const step = detectStep(location.href);
    await sleep(800);
    let err = null;
    try { err = await applyStep('checkError', adherent); } catch (e) {}
    const settle = async () => { delete flow.pendingSubmit; delete flow.pause; await storeSet('flow', flow); };
    if (err && err.hasError && PANIER_RE.test(err.errorText)) {
      await settle();
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — déjà dans le panier FFJDA, rien à faire.`, 'success');
      apiMarkSaisie(adherent);
      await finishAdherent(flow, adherent, true, 'Déjà dans le panier FFJDA (aucune action nécessaire)', 2500);
      return;
    }
    if (isFormStep(step) && (step === ps.step || location.href === ps.url)) {
      // Formulaire réaffiché : FFJDA a refusé. Rien de créé, on attend l'utilisateur.
      delete flow.pendingSubmit;
      await storeSet('flow', flow);
      let fe = null;
      try { fe = await applyStep('formErrors', adherent); } catch (e) {}
      const why = (err && err.hasError && err.errorText) || (fe && fe.text) || 'aucun message affiché';
      await enterPause(flow, adherent, 'error', `FFJDA a réaffiché le formulaire après « Suivant » : ${why}`);
      return;
    }
    if (err && err.hasError) {
      await settle();
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — erreur FFJDA : ${err.errorText}`, 'error');
      await finishAdherent(flow, adherent, false, `Erreur FFJDA à l'enregistrement : ${err.errorText} — NON marqué saisi`, 3000);
      return;
    }
    // Page suivante hors formulaire (panier en principe) : la licence est partie.
    await settle();
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} ✅ dans le panier FFJDA`, 'success');
    apiMarkSaisie(adherent);
    await finishAdherent(flow, adherent, true, step === 'panier' ? null : `Page suivante FFJDA : ${location.pathname}`, 2000);
  }

  // ── Pause : adresse à saisir, formulaire refusé ou non envoyé, pas de réponse ──

  async function enterPause(flow, adherent, kind, reason) {
    const step = detectStep(location.href);
    const prev = flow.pause || {};
    const ps = flow.pendingSubmit || {};
    flow.pause = {
      id: Date.now(), idx: flow.current, kind, reason: reason || '',
      formUrl: isFormStep(step) ? location.href : (prev.formUrl || ps.url || null),
      step: isFormStep(step) ? step : (prev.step || ps.step || null),
    };
    await storeSet('flow', flow);
    await showPause(flow, adherent);
  }

  async function showPause(flow, adherent) {
    const p = flow.pause;
    const idx = flow.current, total = flow.queue.length;
    const onForm = isFormStep(detectStep(location.href));
    const head = {
      address: '✋ adresse à saisir sur la page (adresse HelloAsso dans l\'encadré)',
      error: '⚠️ formulaire refusé par FFJDA',
      nosubmit: '✋ formulaire non envoyé',
      timeout: '⏳ pas de réponse de FFJDA',
    }[p.kind] || '✋ en attente';
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} ${adherent.prenom} — ${head}.`
      + (p.reason ? `\n${p.reason}` : '')
      + (onForm ? '\nCorrigez puis cliquez SUIVANT : la file reprendra à la page suivante.' : ''),
    p.kind === 'address' ? 'info' : 'error');
    renderPauseControls();
    if (onForm) armSubmitListener();
  }

  // Au chargement d'une page pendant une pause (aucun envoi en vol connu).
  async function resumePause(flow, adherent) {
    const step = detectStep(location.href);
    if (step === 'panier') {
      // Le panier lui-même : envoi parti sans qu'on l'ait vu (ou validé à la main).
      delete flow.pause;
      await storeSet('flow', flow);
      await setStatus(`[${flow.current + 1}/${flow.queue.length}] ${adherent.nom} ✅ dans le panier FFJDA`, 'success');
      apiMarkSaisie(adherent);
      await finishAdherent(flow, adherent, true, 'Panier FFJDA atteint après validation à la main', 2000);
      return;
    }
    if (isFormStep(step) && flow.pause.kind === 'address') {
      // Formulaire rechargé : on ne remplit rien, on réaffiche l'adresse HelloAsso.
      await sleep(1200);
      try {
        await applyStep('showAddress', adherent, { reason: flow.pause.reason, mode: step === 'etape2' ? 'nouvelle' : 'renouvellement' });
      } catch (e) {}
    }
    await showPause(flow, adherent);
  }

  // « Suivant » cliqué à la main pendant la pause : noté AUSSITÔT (l'envoi
  // peut aboutir avant que ce contexte ait fini quoi que ce soit d'autre).
  let submitListenerArmed = false;
  function armSubmitListener() {
    if (submitListenerArmed) return;
    submitListenerArmed = true;
    document.addEventListener('submit', (ev) => {
      if (autoSubmitting) return;
      const t = ev.target;
      if (t && t.closest && t.closest('#jcc-ffjda-panel, #jcc-address-box')) return;
      // SYNCHRONE : la saisie manuelle de l'adresse remet la souscription IAC
      // sur « Non » (recalcul FFJDA) ; les données envoyées ne sont lues
      // qu'après les handlers de `submit`.
      if (document.querySelector('input[name="souscription"]')) applyStep('ensureIAC', {});
      onManualSubmit(ev);
    }, true);
  }
  async function onManualSubmit(ev) {
    const flow = await storeGet('flow', null);
    if (!flow || !flow.pause || flow.pause.idx !== flow.current) return;
    const adherent = flow.queue[flow.current];
    const ps = { id: Date.now(), idx: flow.current, url: location.href, step: detectStep(location.href),
      at: Date.now(), kind: 'manuel' };
    flow.pendingSubmit = ps;
    await storeSet('flow', flow);
    if (ev.defaultPrevented) {
      // Annulé par la page FFJDA : rien n'est parti.
      const cur = await storeGet('flow', null);
      if (cur && cur.pendingSubmit && cur.pendingSubmit.id === ps.id) {
        delete cur.pendingSubmit;
        await storeSet('flow', cur);
      }
      let fe = null;
      try { fe = await applyStep('formErrors', adherent); } catch (e) {}
      await setStatus(`[${flow.current + 1}/${flow.queue.length}] ${adherent.nom} — « Suivant » bloqué par FFJDA`
        + (fe && fe.text ? ` : ${fe.text}` : '') + '. Corrigez puis cliquez à nouveau SUIVANT.', 'error');
      return;
    }
    await waitSubmitNavigation(adherent, ps, flow.queue.length);
  }

  // Boutons de la pause, dans le panneau.
  function renderPauseControls() {
    const content = document.getElementById('jcc-ffjda-content');
    if (!content) return;
    const old = content.querySelector('#jcc-pause-ctl');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'jcc-pause-ctl';
    wrap.innerHTML = `
      <button class="jcc-btn" id="jcc-pause-done">✓ C'est dans le panier, continuer</button>
      <div class="jcc-btn-row">
        <button class="jcc-btn secondary" id="jcc-pause-retry">↻ Réessayer</button>
        <button class="jcc-btn secondary" id="jcc-pause-skip">⏭ Passer</button>
      </div>`;
    content.prepend(wrap);
    const body = document.getElementById('jcc-ffjda-body');
    if (body) body.style.display = '';
    // Relit la file : l'état a pu changer depuis l'affichage (annulation…).
    const current = async () => {
      const cur = await storeGet('flow', null);
      if (!cur || !cur.pause || cur.pause.idx !== cur.current) return null;
      wrap.remove();
      const pause = cur.pause;
      delete cur.pause;
      delete cur.pendingSubmit;
      await storeSet('flow', cur);
      return { cur, pause, adherent: cur.queue[cur.current] };
    };
    wrap.querySelector('#jcc-pause-done').addEventListener('click', async () => {
      const c = await current();
      if (!c) return;
      await setStatus(`${c.adherent.nom} ✅ (confirmé dans le panier)`, 'success');
      apiMarkSaisie(c.adherent);
      await finishAdherent(c.cur, c.adherent, true, 'Confirmé à la main : dans le panier FFJDA', 1000);
    });
    wrap.querySelector('#jcc-pause-retry').addEventListener('click', async () => {
      const c = await current();
      if (!c) return;
      const step = detectStep(location.href);
      if (isFormStep(step)) {
        await runForm(c.cur, c.adherent, c.cur.current, c.cur.queue.length, step);
      } else {
        await setStatus(`${c.adherent.nom} — retour au formulaire...`, 'info');
        location.href = c.pause.formUrl || RENEW_SEARCH_URL;
      }
    });
    wrap.querySelector('#jcc-pause-skip').addEventListener('click', async () => {
      const c = await current();
      if (!c) return;
      await setStatus(`${c.adherent.nom} — passé (NON marqué saisi).`, 'error');
      await finishAdherent(c.cur, c.adherent, false, 'Passé à la main — NON marqué saisi, à vérifier sur FFJDA', 500);
    });
  }

  async function handleStep(flowArg) {
    const flow = flowArg || await storeGet('flow', null);
    if (!flow) return;
    const cur = flow.queue[flow.current];
    if (flow.manual) {
      // File d'une version ≤ 1.9.5 en pause « adresse » : même attente.
      flow.pause = { id: Date.now(), idx: flow.current, kind: 'address', reason: '',
        formUrl: flow.manual.url, step: detectStep(flow.manual.url) };
      delete flow.manual;
      await storeSet('flow', flow);
    }
    // Un envoi était en vol : c'est CETTE page qui dit s'il a abouti (avant
    // tout le reste, y compris quand la page n'est pas reconnue).
    if (flow.pendingSubmit) {
      if (cur && flow.pendingSubmit.idx === flow.current) { await resolvePendingSubmit(flow, cur); return; }
      delete flow.pendingSubmit;
      await storeSet('flow', flow);
    }
    if (flow.pause) {
      if (cur && flow.pause.idx === flow.current) { await resumePause(flow, cur); return; }
      delete flow.pause;
      await storeSet('flow', flow);
    }
    if (flow.manualEtape1) {
      // En attente de l'étape 1 finie à la main (voir waitManualEtape1).
      const a = flow.queue[flow.current];
      const s = detectStep(location.href);
      if (!a) return;
      if (!s) { renderManualEtape1Controls(flow); return; }   // page hors parcours : on attend
      delete flow.manualEtape1;
      await storeSet('flow', flow);
      if (s !== 'etape1' && s !== 'intermediaire' && s !== 'etape2') {
        // Formulaire quitté sans valider : rien n'a été créé.
        await setStatus(`[${flow.current + 1}/${flow.queue.length}] ${a.nom} — étape 1 non validée, formulaire quitté.`, 'error');
        await finishAdherent(flow, a, false, 'Étape 1 non validée (date de naissance / formulaire) — formulaire quitté sans valider, rien créé', 1500);
        return;
      }
      // VALIDER cliqué à la main (intermédiaire) ou formulaire rechargé
      // (étape 1, nouveau remplissage) : la file reprend normalement.
    }
    const startUrl = location.href;

    const step = detectStep(startUrl);
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
      if (step === 'renew_search' && modeOf(adherent, flow) === 'nouvelle') {
        // Vérification avant création : on ne lit les résultats QUE sur la
        // page de résultats (la page suivante), jamais sur le formulaire.
        await failIfNoNavigation(flow, adherent, 'Recherche FFJDA sans effet — rien créé');
        return;
      }
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — attente des résultats...`, 'info');
      let res = await pollForResults(adherent);
      if (modeOf(adherent, flow) === 'nouvelle' && res.noResult) {
        // « Aucun résultat » doit être stable (résultats chargés en asynchrone).
        await new Promise(r => setTimeout(r, 3000));
        const again = await applyStep('findLink', adherent);
        if (!again || again.found || !again.noResult) res = { found: !!(again && again.found) };
      }
      if (modeOf(adherent, flow) === 'nouvelle') {
        // Vérification avant création : la personne est-elle déjà licenciée
        // du club une saison passée ? Si oui on NE crée RIEN (un homonyme est
        // possible, un humain tranche) ; si non, on passe à la création.
        if (res.found || res.listedNoLink) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — licence existante trouvée sur FFJDA, aucune création.`, 'error');
          await finishAdherent(flow, adherent, false, 'Un licencié de ce nom existe déjà sur FFJDA — renouvellement probable, à vérifier et saisir à la main (rien n\'a été créé)', 3000);
        } else if (res.noResult) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — aucune licence existante, création...`, 'info');
          location.href = NEW_LICENCE_URL;
        } else {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — timeout vérification.`, 'error');
          await finishAdherent(flow, adherent, false, 'Vérification FFJDA impossible (timeout) — rien créé', 3000);
        }
        return;
      }
      if (res.found) {
        await setStatus(
          res.fuzzy
            ? `[${idx + 1}/${total}] ${adherent.nom} — correspondance approximative FFJDA, confirmation...`
            : `[${idx + 1}/${total}] ${adherent.nom} — ouverture fiche...`,
          'info'
        );
        // Clic (et non navigation) : c'est le geste humain, et il fonctionne
        // que le lien porte une vraie URL ou qu'il soit piloté en JS.
        await applyStep('clickLink', adherent);
        await failIfNoNavigation(flow, adherent, 'Clic sur le nom sans effet (fiche non ouverte)');
      } else if (res.listedNoLink) {
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — déjà présent sur FFJDA sans renouvellement possible (déjà licencié ?).`, 'error');
        await finishAdherent(flow, adherent, false, 'Présent dans les résultats FFJDA mais sans lien de renouvellement — probablement déjà licencié cette saison (à vérifier sur FFJDA)', 3000);
      } else if (res.noResult) {
        // On arrive ici UNIQUEMENT quand la réconciliation avait déjà détecté
        // une licence FFJDA pour cette personne (c'est justement ce qui a mis
        // le mode à 'renouvellement' au lancement, voir hasLicenceFFJDA()).
        // Si FFJDA ne la retrouve pas dans sa liste de renouvellement
        // (licence trop ancienne, jamais validée par la ligue, nom
        // orthographié différemment...), on ne bascule JAMAIS en création
        // automatique : FFJDA accepte parfois de créer un second profil sans
        // le signaler, ce qui a produit un vrai doublon en prod (Raphaël
        // Cantarero, 19/09/2026). Un humain doit saisir manuellement via
        // "RENOUVELER UN LICENCIÉ..." (recherche libre, qui propose aussi
        // les correspondances approximatives) plutôt que de risquer un
        // doublon.
        await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — non trouvé au renouvellement malgré une licence FFJDA connue.`, 'error');
        await finishAdherent(flow, adherent, false, 'Non trouvé au renouvellement alors qu\'une licence FFJDA est déjà connue — À SAISIR MANUELLEMENT via "Renouveler un licencié", ne PAS créer de nouvelle licence', 3000);
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
      // Même envoi que l'étape 2 (voir runForm / autoSubmit) : l'ancien « page
      // inchangée = succès probable » au bout de 1,5 s est supprimé — c'était
      // précisément le POST encore en vol que la navigation suivante annulait.
      await runForm(flow, adherent, idx, total, step);
      return;
    }

    // ---------------- NOUVELLE LICENCE ----------------

    if (step === 'etape1') {
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — étape 1...`, 'info');
      await new Promise(r => setTimeout(r, 800));
      await runEtape1(flow, adherent, idx, total);
      return;
    }

    if (step === 'intermediaire') {
      if (!await creationAllowed(flow, adherent, idx, total, 'Page intermédiaire')) return;
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
      if (!await creationAllowed(flow, adherent, idx, total, 'Étape 2')) return;
      await runForm(flow, adherent, idx, total, step);
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
  // `had_licence_any_season` : a déjà eu une licence FFJDA une saison passée,
  // même si pas encore renouvelée pour la saison en cours (recon_status
  // resterait "unmatched" sinon) — sans ce signal la saisie repart en
  // "nouvelle licence" et FFJDA refuse le doublon de profil.
  function hasLicenceFFJDA(a) {
    return !!a.ffjda_licence || a.recon_status === 'matched' || a.recon_status === 'corrected'
      || !!a.had_licence_any_season;
  }

  // Garde-fou d'affichage, INDÉPENDANT de hasLicenceFFJDA() : `previous_licence`
  // et `had_licence_any_season` viennent normalement du même calcul et
  // devraient toujours concorder, mais un cas réel (Raphaël CANTARERO,
  // 19/09/2026) a montré une désynchronisation — probablement l'import FFJDA
  // "toutes saisons" pas encore à jour au moment du calcul. Si l'un des deux
  // signale une licence passée et pas l'autre, on avertit fort plutôt que de
  // laisser filer en "nouvelle licence" (FFJDA peut accepter le doublon sans
  // le signaler).
  function hasSuspiciousNewStatus(a) {
    return !hasLicenceFFJDA(a) && !!a.previous_licence;
  }

  // Doublon d'inscription HelloAsso pour la même personne (même
  // nom+prénom+date de naissance) — typiquement un remboursement fait hors
  // HelloAsso (virement, espèces...) qui laisse l'ancienne inscription
  // visible comme "payée" côté API (aucune trace du remboursement manuel).
  // Vu en prod : famille Hermans, 19/09/2026 — 3 enfants remboursés puis
  // réinscrits, chacun apparu deux fois. Sans ce garde-fou, la saisie batch
  // traite les deux comme deux personnes distinctes et tente de créer une
  // licence FFJDA pour chacune.
  // Pourquoi une nouvelle licence est bloquée (message affiché à l'utilisateur).
  function blockedReason(list) {
    if (list.some(a => a.licence_history_known === undefined)) {
      return "le serveur de synchro ne renvoie pas l'historique FFJDA (serveur pas à jour, ou liste en cache : rechargez la liste)";
    }
    const missing = [...new Set(list.flatMap(a => a.missing_history || []))];
    return missing.length
      ? `export(s) FFJDA manquant(s) côté serveur : ${missing.join(', ')} — à importer dans l'onglet Licences FFJDA de l'app de gestion`
      : "serveur de synchro pas à jour (il ne dit pas quel export manque)";
  }

  function hasDuplicateRegistration(a) {
    return !!a.duplicate_registration;
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
      .jcc-adh-item.suspicious { background: rgba(255,80,80,0.12); border-left: 3px solid #ff5252; }
      .jcc-adh-item.suspicious em { color: #ff9d9d; font-style: normal; font-size: 11px; }
      .jcc-adh-item.duplicate { background: rgba(226,177,60,0.15); border-left: 3px solid #e2b13c; }
      .jcc-adh-item.duplicate em { color: #f0c674; font-style: normal; font-size: 11px; }
      .jcc-counter { font-size: 11px; color: #a8c8e8; margin-bottom: 6px; text-align: right; line-height: 1.5; }
      .jcc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #a8c8e8; margin-bottom: 8px; }
      #jcc-ffjda-progress { height: 5px; background: #0f2233; border-radius: 3px; margin-bottom: 8px; overflow: hidden; }
      #jcc-ffjda-progress-fill { height: 100%; background: #1a6fa8; width: 0%; transition: width .3s; }
      .jcc-manual { background: #fff8e1; color: #222; border: 2px solid #f57c00; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
      .jcc-manual .lbl { font-size: 11px; color: #666; }
      .jcc-manual .dob { font-size: 28px; font-weight: 800; letter-spacing: 1px; color: #b71c1c; margin-bottom: 4px; user-select: all; -webkit-user-select: all; }
      .jcc-manual .val { font-size: 16px; font-weight: 700; }
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
      const suspicious = hasSuspiciousNewStatus(a);
      const duplicate = hasDuplicateRegistration(a);
      const modeBadge = hasLicenceFFJDA(a)
        ? '<span title="Renouvellement">🔑</span>'
        : (suspicious
          ? `<span title="Ancienne licence FFJDA ${a.previous_licence} (${a.previous_saison || 'saison antérieure'}) détectée — vérifier avant de traiter en NOUVELLE licence, risque de doublon">⚠️</span>`
          : '<span title="Nouvelle licence">✨</span>');
      const duplicateNote = duplicate
        ? ` <em title="${a.duplicate_count} inscriptions HelloAsso pour cette personne — souvent un remboursement fait hors HelloAsso. Décochez celle à ne pas traiter.">(🔁 doublon inscription x${a.duplicate_count})</em>`
        : '';
      return `
      <label class="jcc-adh-item${a.saisie_ffjda ? ' saisie' : ''}${suspicious ? ' suspicious' : ''}${duplicate ? ' duplicate' : ''}">
        <input type="checkbox" data-idx="${idx}" ${selected.has(idx) ? 'checked' : ''}>
        <span>${modeBadge} ${a.nom} ${a.prenom}${a.saisie_ffjda ? ' ✓' : ''}${suspicious ? ` <em>(ancienne licence ${a.previous_licence} ?)</em>` : ''}${duplicateNote}</span>
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
    // "Tout" n'inclut PAS les cas suspects (voir hasSuspiciousNewStatus) ni
    // les doublons d'inscription (voir hasDuplicateRegistration) : ils
    // exigent une vérification manuelle avant saisie, pas une sélection en masse.
    content.querySelector('#jcc-btn-all').addEventListener('click', () => {
      getFiltered().filter(({ a }) => !hasSuspiciousNewStatus(a) && !hasDuplicateRegistration(a)).forEach(({ idx }) => selected.add(idx));
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
      // Historique FFJDA incomplet côté serveur : on ne peut pas affirmer que
      // ces personnes n'ont jamais eu de licence. On demande confirmation ; de
      // toute façon chaque nouvelle licence est d'abord cherchée sur le site
      // FFJDA et rien n'est créé si elle y figure.
      const unsure = queue.filter(a => a._mode === 'nouvelle' && a.licence_history_known !== true);
      if (unsure.length && !window.confirm(
        `⚠️ ${unsure.length} nouvelle(s) licence(s) sans historique FFJDA complet côté serveur (${blockedReason(unsure)}) :\n`
        + unsure.map(a => `• ${a.nom} ${a.prenom}`).join('\n')
        + `\n\nChacune sera d'abord cherchée sur FFJDA : si elle y existe, rien ne sera créé.\nContinuer ?`)) {
        await setStatus('Lancement annulé.', 'info');
        return;
      }
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
