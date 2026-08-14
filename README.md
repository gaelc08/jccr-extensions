# jccr-extensions

Miroir public de scripts distribués publiquement pour le club (JC Cattenom Rodemack). Ce repo n'existe que pour héberger des fichiers qui doivent être accessibles par URL brute (userscripts, etc.) — le code source et le développement se font dans le repo principal (privé) [`jccr-gestion`](https://github.com/gaelc08/jccr-gestion).

## Contenu

| Fichier | Source | Usage |
|---------|--------|-------|
| `ffjda-autofill.user.js` | **assemblé** par `jccr-gestion` → `npm run build:userscript` | Userscript mobile (iOS Safari / Tampermonkey) — préremplissage licences FFJDA |
| `ffjda-loader.user.js` | `jccr-gestion/userscripts/ffjda-loader.user.js` | Chargeur à installer sur le téléphone : récupère le script ci-dessus à chaque chargement de page |

## ⚠️ Ce repo est un miroir, pas la source

Ne pas éditer les fichiers ici directement. `ffjda-autofill.user.js` est un **artefact de build** : il assemble `extension/lib/ffjda-flow.js` (source partagée avec l'extension Chrome) et le panneau du userscript. Toute modification se fait dans `jccr-gestion`, puis `npm run build:userscript`, puis copie de `dist/userscripts/` ici. Ce repo n'a qu'un rôle de distribution publique (nécessaire pour `@updateURL`/`@downloadURL`, qui exigent une URL `raw.githubusercontent.com` accessible sans authentification — `jccr-gestion` est privé).
