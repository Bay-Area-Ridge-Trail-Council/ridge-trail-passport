# Ridge Trail Passport

A lightweight web application for exploring the Bay Area Ridge Trail and tracking personal completion progress.

The Passport reads the authoritative public Ridge Trail route directly from ArcGIS Online. It does not maintain a second copy of the trail geometry.

## Architecture

- **Frontend:** Vite + plain JavaScript
- **Mapping:** MapLibre GL JS
- **Basemap:** OpenFreeMap Liberty vector style
- **Trail data:** public ArcGIS Online Feature Layer
- **Persistent trail identity:** permanent `Segment_ID`
- **Completion storage:** browser `localStorage`
- **Hosting:** GitHub Pages
- **Checks:** GitHub Actions + Node tests

There is no application server, user-account system, database, API key, or secret required for the current beta.

## Development

Use the Node version in `.node-version`.

```bash
npm install
npm run dev
```

Run the automated tests and production build:

```bash
npm run check
```

The production site is written to `dist/`.

## ArcGIS data contract

The app requests only the public fields it uses. The most important field is `Segment_ID`, which provides permanent identity for saved completion progress.

Every main-route feature should have a unique, nonblank `Segment_ID`. Once assigned, an ID should not be changed or reused solely because route order or section numbering changes.

Normal GIS edits do not require an app redeploy. The Passport queries the live public Feature Layer whenever it loads.

## Completion data and privacy

Completion is stored only in the visitor's current browser/device using `localStorage`.

- There are no Passport user accounts.
- Completion is not sent to the repository or an application database.
- Clearing browser data can erase saved completion progress.
- Progress does not automatically sync across devices.
- Users can manually export a versioned JSON progress backup and import it on another browser, device, or Passport web address. Imports merge with existing progress and do not remove completed sections.

## Deployment

Pushes to `main` are tested, built, and deployed through the GitHub Pages workflow in `.github/workflows/pages.yml`.

The Vite build uses relative asset paths so the project works at the repository Pages URL and can later move to a custom Ridge Trail hostname without restructuring the app.

## Current beta limitations

- No user accounts or automatic cross-device sync
- No offline basemap support
- The public OpenFreeMap tiles are for normal interactive viewing only; bulk/offline tile downloading should not be added
- No dedicated client-side error-monitoring service
- Install-to-home-screen/PWA support remains basic

## Dependencies

The production JavaScript dependency footprint is intentionally small: MapLibre GL JS is the only runtime package.

Dependabot checks npm and GitHub Actions dependencies monthly and proposes updates through pull requests.

## Public source and branding

This repository is public for transparency, maintainability, and collaboration. No open-source license has been granted at this time; normal copyright protections therefore remain in effect.

Bay Area Ridge Trail names, logos, and other organizational branding are separate from the source-code visibility and remain the property of their respective rights holders.
