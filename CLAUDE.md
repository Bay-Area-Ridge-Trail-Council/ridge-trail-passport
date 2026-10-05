# Ridge Trail Passport — Working Notes for Claude Code

The Ridge Trail Passport is a public beta web app for the Bay Area Ridge Trail
Council, a small nonprofit. It lets visitors explore the Ridge Trail and track
which main-route sections they have completed.

The people maintaining this are not full-time software developers. Favor simple,
readable, conventional solutions over clever ones. If a change would be hard for
a non-developer to understand six months from now, it is probably the wrong
change.

## How to work in this repository

**Never commit directly to `main`.** Pushes to `main` deploy straight to the live
public site with no human review step. Always create a branch and open a pull
request. `.github/workflows/build.yml` runs the tests and build on every pull
request.

**One change per pull request.** Do not batch unrelated fixes together. A pull
request that touches data fetching, storage, and CI at once cannot be
meaningfully reviewed by this team.

**Add a test with every behavior change.** `tests/core.test.js` already has a
`MemoryStorage` stub and covers the important logic. Write a test that fails
before the fix and passes after it. Run `npm test` before opening the pull
request.

**Explain the change in plain language.** The pull request description should
say what was wrong, what changed, and how to verify it — written for a reader
who does not code.

**Ask before doing anything not requested.** Do not refactor, reformat,
restructure, or "improve" code that was not part of the task. If something
looks wrong but is outside the current scope, mention it and move on.

## Architecture constraints

These are deliberate decisions, not oversights. Do not change them without
asking:

- **No server, no database, no API keys, no secrets.** This is a static site on
  GitHub Pages. The absence of any backend is what makes it maintainable by a
  small nonprofit. Do not introduce one.
- **Leaflet is intentionally the only runtime dependency.** Do not add npm
  packages. Ask first, with a reason, if you believe one is genuinely needed.
- **Trail data is read live from the public ArcGIS feature layer.** The app does
  not keep a second copy of the route geometry. GIS edits must appear without a
  redeploy.
- **The basemap stays swappable.** All basemap settings live in a single object
  in `src/config.js`. Keep it that way — a migration to MapLibre and a different
  tile source is planned.
- **`src/map.js` is the only file that should use Leaflet directly.** `src/ui.js`
  currently uses it in one small place; do not spread it further.

## User data rules — treat these as hard requirements

Completion progress lives only in the visitor's browser. There is no backup on
any server. If this app loses someone's data, it is gone permanently.

- **`Segment_ID` is a permanent user-facing identifier.** Saved progress is keyed
  to it. Never change how storage keys are derived from it. Never reuse or
  renumber IDs in code.
- **Never silently drop saved progress.** Completions for segments that no longer
  appear in the feature layer must be retained, not deleted. This is current
  behavior and it is correct.
- **Never let a failed save look like a successful one.** If writing to storage
  fails, the user must be told.
- **Importing a backup merges.** It must never remove existing completions.
- **Progress backup files must stay importable forever.** If the backup schema
  version changes, write a migration path. Users have exported files sitting on
  their devices.

## Things that are already correct — do not "fix" these

- All values interpolated into `innerHTML` go through `escapeHtml` in
  `src/utils.js`. External URLs go through `normalizeUrl`, which rejects
  anything that is not http or https. Keep both patterns.
- Storage keys are prefixed `segment-`, which prevents prototype-pollution via
  imported files. Keep the prefix.
- `src/data.js` requests only the fields listed in `CONFIG.featureFields`. Keep
  the list minimal.
- `public/sw.js` deliberately caches same-origin files only. It must not cache
  OpenStreetMap tiles or ArcGIS responses — that would violate the tile usage
  policy.
- Accessibility attributes (`aria-pressed`, `aria-expanded`,
  `role="progressbar"`, keyboard handlers, focus management,
  `prefers-reduced-motion`) are intentional. Preserve them in any markup change.

## Commands

```bash
npm install     # install dependencies
npm run dev     # local dev server
npm test        # run the test suite
npm run check   # tests + production build (what CI runs)
```

Node version is pinned in `.node-version`.

## Context worth knowing

- Known issue: iOS Safari deletes localStorage, IndexedDB, and service worker
  caches after seven days without interaction. Home-screen installs are exempt.
  This is why the install flow matters and why storage failures must be visible.
- The repository is owned by the Bay Area Ridge Trail Council organization
  account on GitHub.
- Ridge Trail names and logos are Council property and are separate from the
  source code. Do not add, alter, or remove branding assets.
