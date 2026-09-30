# Agent Monitor

An Obsidian desktop plugin showing local AI agent sessions and services. Current automatic detection supports macOS. Runtime UI is Chinese.

- `src/`: readable frontend, Obsidian adapter and standard-library Python detector.
- `tests/`: state parsing, session navigation and standalone plugin loading tests.
- `images/`: public demo screenshot and explicitly authorized community QR codes.
- `main.js`: generated release entry containing the frontend and detector.

Build: `npm run build`. Check: `npm test`, `node --check main.js`, `git diff --check`.

Do not commit local snapshots, real chat titles, private project paths, credentials or app configuration. Do not change external app records. Keep release assets self-contained: community installs only main.js, manifest.json and styles.css.

## Token savings and reading boundaries

Read only task-related files after inspecting the first directory level. Do not recursively scan dependencies, output, caches, logs or large binaries. Scope searches to relevant paths. Git ignore rules do not define AI reading boundaries.

Project records live in `.agents/project/`.
