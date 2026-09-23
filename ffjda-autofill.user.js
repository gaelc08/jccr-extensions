// ==UserScript==
// @name         JCCR Saisie FFJDA (mobile / Safari)
// @namespace    https://github.com/gaelc08/jccr-gestion
// @version      1.9.2
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
   *                         | 'clickCreate' | 'etape1' | 'etape2' | 'checkError'
   *                         | 'showAddress' | 'addressStatus' | 'nameOnPage'
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

    // ── Étape 1 nouvelle licence : identité ──────────────────────────────────

    if (action === 'etape1') {
      // adherent.date_naissance arrive au format ISO (YYYY-MM-DD, tel que
      // stocké côté API). Le champ FFJDA attend du DD/MM/YYYY — l'y envoyer
      // tel quel produit une date aberrante (ex. "20/09/0925" vu en prod sur
      // Nardi) si le champ a un masque de saisie, ce qui a pu contribuer aux
      // échecs constatés sur les nouvelles licences (jamais reproduits en
      // renouvellement, qui ne passe pas par ce champ).
      const isoDob = adherent.date_naissance || '';
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDob);
      const dob = m ? `${m[3]}/${m[2]}/${m[1]}` : isoDob;

      let f = 0;
      if (setByName('nom',       adherent.nom))                       f++;
      if (setByName('prenom',    adherent.prenom))                    f++;
      if (setByName('sexe',      adherent.sexe === 'F' ? 'F' : 'M')) f++;
      if (setByName('naissance', dob))                                 f++;

      await wait(400);

      const state = {
        nom: readByName('nom'), prenom: readByName('prenom'), naissance: readByName('naissance'),
      };
      const btn = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find(b => ((b.textContent || b.value || '').trim().toLowerCase()).includes('valider'));
      if (btn) realClick(btn);

      // Filet de sécurité : si le champ naissance n'a pas la forme
      // DD/MM/YYYY attendue après saisie (masque de saisie qui a mal
      // interprété la valeur envoyée, ou tout autre souci), on ne déclare
      // pas succès — mieux vaut un échec explicite ici qu'une date
      // aberrante silencieusement soumise plus loin dans le formulaire.
      const dobOk = !dob || /^\d{2}\/\d{2}\/\d{4}$/.test(state.naissance || '');

      return Object.assign(
        { step: 1, success: f > 0 && !!state.nom && !!state.prenom && dobOk, filled: f, submitted: !!btn },
        state
      );
    }

    // ── Adresse HelloAsso vs adresse préremplie par FFJDA ────────────────────

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
    function showAddressBox(addr) {
      const old = document.getElementById('jcc-address-box');
      if (old) old.remove();
      const box = document.createElement('div');
      box.id = 'jcc-address-box';
      box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
        + 'width:min(440px,calc(100vw - 24px));background:#fff8e1;color:#222;border:2px solid #f57c00;'
        + 'border-radius:10px;padding:12px 14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
      const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const line = (label, value) => value ? `<div style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <div style="flex:1"><small style="color:#666">${label}</small><br><b>${esc(value)}</b></div>
          <button type="button" data-copy="${esc(value)}" style="padding:4px 10px;border:1px solid #f57c00;
            border-radius:6px;background:#fff;cursor:pointer">Copier</button></div>` : '';
      const cpVille = [addr.ha.code_postal, addr.ha.ville].filter(Boolean).join(' ');
      box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b style="color:#e65100">✋ Adresse à mettre à jour</b>
          <button type="button" data-close style="border:none;background:none;font-size:18px;cursor:pointer">×</button></div>
        <div style="margin:4px 0 8px">L'adresse déclarée sur HelloAsso diffère de celle de la licence précédente.
          Corrigez le <b>code postal</b> puis l'<b>adresse</b> ci-dessous, puis cliquez sur <b>SUIVANT</b>.</div>
        ${line('Adresse HelloAsso', addr.ha.adresse)}
        ${line('Code postal / ville HelloAsso', cpVille)}
        <div style="margin-top:8px;color:#666;font-size:12px">Actuellement sur FFJDA :
          ${esc([addr.ffjda.adresse, addr.ffjda.cp].filter(Boolean).join(' — ') || '(vide)')}</div>`;
      box.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.dataset && t.dataset.copy != null) {
          const done = () => { t.textContent = 'Copié ✓'; setTimeout(() => { t.textContent = 'Copier'; }, 1500); };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t.dataset.copy).then(done, () => {});
          }
        } else if (t && t.dataset && t.dataset.close != null) {
          box.remove();
        }
      });
      document.body.appendChild(box);
      // Met en évidence les champs à corriger et note le clic sur SUIVANT
      // (lu par l'orchestrateur via l'action 'addressStatus').
      ['cp', 'adresse'].forEach((n) => {
        const el = document.querySelector(`[name="${n}"]`);
        const target = (el && el.nextElementSibling && el.nextElementSibling.classList
          && el.nextElementSibling.classList.contains('select2')) ? el.nextElementSibling : el;
        if (target) target.style.outline = '3px solid #f57c00';
      });
      delete document.documentElement.dataset.jccAddrSubmitted;
      const suivant = Array.from(document.querySelectorAll('button.big-btn[type="submit"]'))
        .find(b => b.textContent.trim().toLowerCase().includes('suivant'));
      if (suivant && !suivant.dataset.jccWatched) {
        suivant.dataset.jccWatched = '1';
        suivant.addEventListener('click', () => { document.documentElement.dataset.jccAddrSubmitted = '1'; });
      }
      const cp = document.querySelector('[name="cp"]');
      if (cp && cp.scrollIntoView) cp.scrollIntoView({ block: 'center' });
    }

    // Réaffiche l'encadré (page rechargée pendant la correction manuelle),
    // sans rien remplir ni valider.
    if (action === 'showAddress') {
      const addr = addressCheck();
      showAddressBox(addr);
      return { shown: true, mismatch: addr.mismatch };
    }
    // L'utilisateur a-t-il cliqué SUIVANT après correction ?
    if (action === 'addressStatus') {
      return { submitted: document.documentElement.dataset.jccAddrSubmitted === '1' };
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

      // fillSelect2() (remplissage scripté du CP/adresse via select2) a été
      // retirée : quelle que soit la variante testée (séquence de clic,
      // délai avant soumission, choix de l'option en majuscule, clic humain
      // vs scripté sur "Suivant"...), elle a systématiquement fini par faire
      // boucler indéfiniment un handler jQuery du site FFJDA lui-même
      // (main.js:1768). Cause exacte non identifiée après investigation
      // poussée — un remplissage manuel de bout en bout, lui, n'a jamais
      // reproduit le crash. Ces deux champs sont donc désormais laissés à
      // l'utilisateur quand ils diffèrent de HelloAsso (voir addressCheck /
      // showAddressBox : encadré avec l'adresse HelloAsso, pas de validation auto).

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
                const nt = (targetText || '').toUpperCase().replace(/-/g, ' ');
                const norm = (s) => (s || '').toUpperCase().replace(/-/g, ' ');
                const candidates = Array.from(opts).filter(o => norm(o.textContent).includes(nt));
                // Le premier résultat est souvent un simple écho de la saisie
                // libre (texte tel que tapé) — la vraie adresse de la base
                // FFJDA apparaît juste en dessous, en MAJUSCULES. Préférée ici,
                // même si le vrai coupable des échecs passés était ailleurs
                // (date de naissance non reformatée, voir etape1).
                const upper = candidates.find(o => {
                  const t = o.textContent.trim();
                  return t.length > 0 && t === t.toUpperCase() && t !== t.toLowerCase();
                });
                let match = upper || candidates[0];
                if (!match && opts[0]) match = opts[0];
                if (match) { realClick(match); setTimeout(() => resolve(true), 400); }
                else { $sel.select2('close'); resolve(false); }
              }, 1500);
            }, 500);
          }, 200);
        });
      }

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

      // Renouvellement : FFJDA préremplit l'ADRESSE DE LA SAISON PASSÉE (CP
      // déjà présent, donc rien n'est rempli ci-dessus). Si elle diffère de
      // celle déclarée sur HelloAsso, on ne valide PAS à la place de
      // l'utilisateur : on lui montre l'adresse HelloAsso et il corrige
      // lui-même (le remplissage scripté du select2 fait planter le site).
      const addr = addressCheck();
      if (addr.mismatch) {
        restoreBelt(beltSnap);
        ensureIAC();
        showAddressBox(addr);
        return { step: 2, success: true, filled: f, submitted: false, needsAddress: true,
          ffjdaAddress: addr.ffjda, haAddress: addr.ha };
      }

      await wait(800);
      restoreBelt(beltSnap);
      ensureIAC();
      await wait(400);

      // Dernière vérification avant de valider : "Oui" (value=0) bien actif.
      const oui = document.querySelector('input[name="souscription"][value="0"]');
      if (!oui || !oui.checked) ensureIAC();

      const suivant = Array.from(document.querySelectorAll('button.big-btn[type="submit"]'))
        .find(b => b.textContent.trim().toLowerCase().includes('suivant'));
      if (suivant) { suivant.click(); f++; }
      return { step: 2, success: f > 0, filled: f, submitted: !!suivant };
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

    return { error: `Action inconnue : ${action}` };
  }

  root.FfjdaFlow = { detectStep, applyStep };
})(typeof self !== 'undefined' ? self : this);



(function () {
  'use strict';

  // Affiché dans l'en-tête du panneau : permet de vérifier d'un coup d'œil
  // quelle version tourne réellement (l'app Userscripts peut servir une
  // copie en cache). À garder synchro avec @version en tête de fichier.
  const SCRIPT_VERSION = '1.9.2';

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
    flow.results.push({
      nom: adherent.nom, prenom: adherent.prenom, mode: modeOf(adherent, flow), ok, reason: reason || null,
    });
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

  // Adresse HelloAsso différente de celle préremplie par FFJDA (cas du
  // renouvellement) : applyStep('etape2') n'a PAS validé et affiche l'adresse
  // HelloAsso dans la page. On attend que l'utilisateur corrige et clique
  // SUIVANT lui-même. Si SUIVANT recharge la page, ce contexte disparaît et
  // resumeManualAddress() (au chargement suivant) prend le relais.
  async function waitManualAddress(flow, adherent, startUrl, idx, total) {
    flow.manual = { url: startUrl, item_id: adherent.item_id || null };
    await storeSet('flow', flow);
    await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — ✋ adresse à corriger sur la page, puis cliquez SUIVANT. La file reprendra ensuite.`, 'info');
    renderManualControls(flow);
    for (;;) {
      await new Promise(r => setTimeout(r, 1000));
      const cur = await storeGet('flow', null);
      if (!cur || !cur.manual) return;               // annulé / passé à la main
      if (location.href !== startUrl) return;         // navigation : la page suivante reprend
      const st = await applyStep('addressStatus', adherent);
      if (st && st.submitted) {
        await new Promise(r => setTimeout(r, 2500));
        if (location.href !== startUrl) return;
        const err = await applyStep('checkError', adherent);
        if (err && err.hasError) {
          await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — erreur FFJDA : ${err.errorText}. Corrigez puis cliquez à nouveau SUIVANT.`, 'error');
          await applyStep('showAddress', adherent);
          continue;
        }
        await completeManualAddress(cur, adherent, 'Adresse corrigée à la main — page inchangée, à vérifier dans le panier FFJDA');
        return;
      }
    }
  }

  async function completeManualAddress(flow, adherent, reason) {
    delete flow.manual;
    await storeSet('flow', flow);
    await setStatus(`${adherent.nom} ✅ (adresse corrigée)`, 'success');
    apiMarkSaisie(adherent);
    await finishAdherent(flow, adherent, true, reason, 2000);
  }

  // Au chargement d'une page pendant une correction d'adresse manuelle.
  async function resumeManualAddress(flow, adherent) {
    const idx = flow.current, total = flow.queue.length;
    if (location.href === flow.manual.url) {
      // Page rechargée sur le formulaire (erreur, retour…) : on ne remplit
      // rien, on réaffiche juste l'adresse HelloAsso.
      await new Promise(r => setTimeout(r, 1200));
      await applyStep('showAddress', adherent);
      await waitManualAddress(flow, adherent, location.href, idx, total);
      return;
    }
    const err = await applyStep('checkError', adherent);
    if (err && err.hasError && !/d[ée]j[àa]\s+dans\s+le\s+panier/i.test(err.errorText)) {
      delete flow.manual;
      await storeSet('flow', flow);
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — erreur FFJDA : ${err.errorText}`, 'error');
      await finishAdherent(flow, adherent, false, `Erreur FFJDA à l'enregistrement : ${err.errorText}`, 3000);
      return;
    }
    await completeManualAddress(flow, adherent, 'Adresse corrigée à la main');
  }

  // Boutons du panneau pendant la pause « adresse » : reprise manuelle si
  // FFJDA valide sans changer de page, ou abandon de cet adhérent.
  function renderManualControls(flow) {
    const content = document.getElementById('jcc-ffjda-content');
    if (!content || content.querySelector('#jcc-manual-done')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button class="jcc-btn" id="jcc-manual-done">✅ Adresse validée, adhérent suivant</button>
      <button class="jcc-btn secondary" id="jcc-manual-skip">⏭ Passer cet adhérent</button>`;
    content.prepend(wrap);
    const adherent = flow.queue[flow.current];
    wrap.querySelector('#jcc-manual-done').addEventListener('click', async () => {
      const cur = await storeGet('flow', null);
      if (cur && cur.manual) { wrap.remove(); await completeManualAddress(cur, adherent, 'Adresse corrigée à la main (validée par l\'utilisateur)'); }
    });
    wrap.querySelector('#jcc-manual-skip').addEventListener('click', async () => {
      const cur = await storeGet('flow', null);
      if (!cur || !cur.manual) return;
      wrap.remove();
      delete cur.manual;
      await storeSet('flow', cur);
      await finishAdherent(cur, adherent, false, 'Adresse à corriger — passé, à saisir à la main', 500);
    });
  }

  async function handleStep(flowArg) {
    const flow = flowArg || await storeGet('flow', null);
    if (!flow) return;
    if (flow.manual) {
      const a = flow.queue[flow.current];
      if (a) { await resumeManualAddress(flow, a); return; }
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
      await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — formulaire renouvellement...`, 'info');
      await new Promise(r => setTimeout(r, 1200));
      try {
        const r = await applyStep('etape2', adherent);
        if (!r) {
          await setStatus(`Renouvellement [${idx + 1}] : pas de réponse.`, 'error');
          await finishAdherent(flow, adherent, false, 'Pas de réponse du formulaire');
          return;
        }
        if (r.needsAddress) {
          await waitManualAddress(flow, adherent, startUrl, idx, total);
          return;
        }
        if (r.success) {
          await new Promise(res => setTimeout(res, 1500));
          const err = await applyStep('checkError', adherent);
          if (err && err.hasError) {
            // "Licence déjà dans le panier du club" : l'objectif (licence en
            // file d'attente pour ce club) est déjà atteint — souvent parce
            // qu'une tentative précédente a réussi mais a été signalée à
            // tort en échec (voir plus bas). Ce n'est pas un échec.
            if (/d[ée]j[àa]\s+dans\s+le\s+panier/i.test(err.errorText)) {
              await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — déjà dans le panier FFJDA, rien à faire.`, 'success');
              apiMarkSaisie(adherent);
              await finishAdherent(flow, adherent, true, 'Déjà dans le panier FFJDA (aucune action nécessaire)', 2500);
              return;
            }
            await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — erreur FFJDA : ${err.errorText}`, 'error');
            await finishAdherent(flow, adherent, false, `Erreur FFJDA à l'enregistrement : ${err.errorText}`, 3000);
            return;
          }
          if (location.href === startUrl) {
            // Observé en prod (lot du 19/09/2026) : FFJDA valide parfois SANS
            // naviguer ni afficher d'erreur — 4 cas de cette forme se sont
            // tous avérés être de VRAIS succès une fois vérifiés dans le
            // panier. On ne peut donc plus le traiter comme un échec par
            // défaut : compté en succès, avec un avertissement à vérifier
            // plutôt qu'un échec alarmant qui pousserait à ressaisir (et
            // créer un doublon).
            await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — page inchangée, succès probable (à vérifier dans le panier).`, 'success');
            apiMarkSaisie(adherent);
            await finishAdherent(flow, adherent, true, 'Page inchangée après soumission — succès probable, à vérifier dans le panier FFJDA', 2500);
            return;
          }
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
        if (r.needsAddress) {
          await waitManualAddress(flow, adherent, startUrl, idx, total);
          return;
        }
        if (r.success) {
          await new Promise(res => setTimeout(res, 1500));
          const err = await applyStep('checkError', adherent);
          if (err && err.hasError) {
            // Voir le même cas dans le bloc renouvellement plus haut.
            if (/d[ée]j[àa]\s+dans\s+le\s+panier/i.test(err.errorText)) {
              await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — déjà dans le panier FFJDA, rien à faire.`, 'success');
              apiMarkSaisie(adherent);
              await finishAdherent(flow, adherent, true, 'Déjà dans le panier FFJDA (aucune action nécessaire)', 2500);
              return;
            }
            await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — erreur FFJDA : ${err.errorText}`, 'error');
            await finishAdherent(flow, adherent, false, `Erreur FFJDA à l'enregistrement : ${err.errorText}`, 3000);
            return;
          }
          if (location.href === startUrl) {
            // Voir le même cas dans le bloc renouvellement plus haut (4/4
            // vrais succès observés en prod pour cette combinaison "pas
            // d'erreur, pas de navigation").
            await setStatus(`[${idx + 1}/${total}] ${adherent.nom} — page inchangée, succès probable (à vérifier dans le panier).`, 'success');
            apiMarkSaisie(adherent);
            await finishAdherent(flow, adherent, true, 'Page inchangée après soumission — succès probable, à vérifier dans le panier FFJDA', 2500);
            return;
          }
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
      : "historique FFJDA inconnu";
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
      // Garde-fou : une NOUVELLE licence n'est créée que si l'on SAIT que la
      // personne n'en a jamais eu (exports FFJDA de la saison précédente
      // importés). Sinon c'est peut-être un renouvellement → doublon FFJDA.
      const blocked = queue.filter(a => a._mode === 'nouvelle' && a.licence_history_known !== true);
      const runnable = queue.filter(a => !blocked.includes(a));
      if (blocked.length) {
        await setStatus(`⛔ ${blocked.length} nouvelle(s) licence(s) bloquée(s) : ${blockedReason(blocked)} — `
          + blocked.map(a => `${a.nom} ${a.prenom}`).join(', '), 'error');
        if (!runnable.length) return;
        if (!window.confirm(`${blocked.length} nouvelle(s) licence(s) bloquée(s) (${blockedReason(blocked)}).\nLancer quand même les ${runnable.length} autre(s) ?`)) return;
      }
      await startQueue(runnable);
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
