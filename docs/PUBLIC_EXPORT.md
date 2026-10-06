# Public export record

This repository folder was produced by `make-public-repo.mjs` from the project tree at version **0.4.2**. It was prepared locally and has not been published by any agent.

- Source fingerprint (sha256 over relative path + file sha256 of the source tree): `2567dfdd9e8b310cb3219b4b01e89b3ee3d207b7ec37935f364e6ad2aacf9ad6`
- `package.json`: `cbcd2775a1512410040cbe25b44278a0511edc55a0c0afb3f75edddd6526b9c8`
- `public/index.html`: `b04ec0569c464d12b800e826bacfdf745eb4df84e3651b330c55c876e9c3e201`
- `public/app.js`: `994fd0cc5365906e5e71db6ab74a793ac797b69a73f0f43db1199c5b31c6d731`
- `src/batch-engine.mjs`: `55944830938eb8b86bb354b5a2f51e6ef8f73e4549347a571d9a8c6e22eb1689`
- `public/modules/batch-engine.mjs`: `55944830938eb8b86bb354b5a2f51e6ef8f73e4549347a571d9a8c6e22eb1689`
- `public/modules/context-risk.mjs`: `fdfbb964ec11ecf6117a0356ae50119f3fad7803a472a99183d54d334853d202`
- `public/modules/export-redaction.mjs`: `e58a89e5ca3fe3af57d2870513635862316e7d8dbce1fd078dd18ac8d25bb761`

## Excluded on purpose

- `src/data-store.mjs` — legacy 0.1 private-corpus code path (never reactivated)
- `src/http-app.mjs` — legacy 0.1 private-corpus code path (never reactivated)
- `src/review-engine.mjs` — legacy 0.1 private-corpus code path (never reactivated)
- `src/semantic-scorer.mjs` — legacy 0.1 private-corpus code path (never reactivated)
- `src/text.mjs` — legacy 0.1 private-corpus code path (never reactivated)
- `scripts/build-demo.mjs` — separate demo build that embeds the founder ElevenLabs agent id; not part of the submission build (founder decision pending)
- `scripts/package-local.mjs` — local packaging tool; writes into ../07-verification and reads ../delivery
- `test/api.test.mjs` — legacy private-corpus test (test:legacy-private)
- `test/critical-gates.test.mjs` — legacy private-corpus test (test:legacy-private)
- `test/data-integrity.test.mjs` — legacy private-corpus test (test:legacy-private)
- `test/engine.test.mjs` — legacy private-corpus test (test:legacy-private)
- `test/semantic-scorer.test.mjs` — legacy private-corpus test (test:legacy-private)
- Everything outside `project/` (private corpus, `outputs/`, `07-verification/`, `delivery/`, `release/`, `video-studio/`, session logs, internal real-text test files).

## Changes made only in this public copy

- `package.json`: removed script "test:legacy-private" (refers to excluded test/api.test.mjs, test/critical-gates.test.mjs, test/data-integrity.test.mjs, test/engine.test.mjs, test/semantic-scorer.test.mjs)
- `package.json`: removed script "build:demo" (refers to excluded scripts/build-demo.mjs)
- `package.json`: removed script "start:demo" (refers to excluded scripts/build-demo.mjs)
- `scripts/generate-qa-fixtures.mjs`: replaced a hard-coded personal runtime path with env MIHAKK_XLSX_AUTHOR_MODULES (used only when regenerating XLSX fixtures locally)
- `package.json`: package.json from source minus scripts that refer to excluded files
- `SOURCE_AND_RIGHTS.md`: copied from SOURCE_AND_RIGHTS.public.md (sha256 ce12d61072a079c1859e80d04b4a3831f492400e2380813d061295c3db57e49e)
- `README.md`: generated from templates/README.md (version, models and Quran-text credit read from the source)
- `CHANGELOG.md`: generated from templates/CHANGELOG.md
- `.gitignore`: public .gitignore (root-anchored so public/data is kept)
- `.gitattributes`: keeps pinned data bytes unchanged
- `.github/workflows/pages.yml`: GitHub Actions: npm test + npm run build, deploy dist/ to Pages (Node 20, no npm install)

Optional AI models referenced in code: Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7, Xenova/multilingual-e5-small, Xenova/nli-deberta-v3-small. Quran display text: public/data/quran-hafs-quranpedia.json (sha256 c414b5e5d4ae38bb99cf9c66ea44cb2b1a7aaa7053c2a5c4fa155cab17d15de8). SOURCE_AND_RIGHTS.md: included.
