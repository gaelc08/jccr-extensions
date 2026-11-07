# JCCR Extensions (`jccr-extensions`)

Miroir public de distribution des userscripts du **Judo Club Cattenom Rodemack** (`https://judo-cattenom.fr/`).

Ce dépôt héberge uniquement les artefacts prêts à l'emploi qui doivent être accessibles par URL brute (`raw.githubusercontent.com`) pour l'installation et la mise à jour automatique sur mobile et navigateur. Le code source, les tests et le développement vivent dans [`jccr-gestion`](https://github.com/gaelc08/jccr-gestion).

---

## Fichiers distribués

| Fichier | Rôle | Source dans `jccr-gestion` |
|---|---|---|
| `ffjda-autofill.user.js` | Userscript complet de préremplissage et traitement en file des licences sur `moncompte.ffjudo.com` (compatible Tampermonkey/Violentmonkey desktop et iOS Safari via l'application **Userscripts**, y compris les champs de date `flatpickr` sur iPhone) | Assemblé par `npm run build:userscript` à partir de `extension/lib/ffjda-flow.js` et `userscripts/ffjda-autofill.user.js` |
| `ffjda-loader.user.js` | Chargeur léger à installer sur iPhone / navigateur : récupère automatiquement la dernière version de `ffjda-autofill.user.js` | `userscripts/ffjda-loader.user.js` |

---

## Mise à jour depuis `jccr-gestion`

Ne jamais modifier `ffjda-autofill.user.js` directement dans ce dépôt :

```bash
# Dans jccr-gestion :
npm test
npm run build:userscript
# Puis copier dist/userscripts/ffjda-autofill.user.js vers jccr-extensions
```
