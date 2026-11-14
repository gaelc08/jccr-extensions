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

Ne jamais modifier les userscripts directement dans ce dépôt : ils sont écrasés à la publication suivante.

La mise à jour est automatique. À chaque push sur `main` de `jccr-gestion` qui touche aux sources des userscripts, le workflow `publish-userscripts.yml` de ce dépôt lance les tests, assemble les fichiers et les pousse ici (commits `Sync: … (jccr-gestion <sha>)` signés `github-actions[bot]`). Il refuse de publier un fichier modifié dont la `@version` n'a pas augmenté.

L'accès en écriture passe par une clé de déploiement de ce dépôt (**Settings → Deploy keys**), dont la partie privée est le secret `EXTENSIONS_DEPLOY_KEY` de `jccr-gestion`.
