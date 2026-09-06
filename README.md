# Super app

A personal app starting with loyalty cards. Plain HTML, CSS, and JavaScript. No frameworks,
third-party packages, or build step.

## Local development

Built with [Vite+](https://viteplus.dev), which bundles Rolldown, Vitest, Oxlint and Oxfmt
behind one `vp` CLI. Install with `bun install`, then:

| Command           | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `bun run dev`     | Development server on http://127.0.0.1:5173/super-app/ |
| `bun run build`   | Production build into `dist/`                          |
| `bun run preview` | Serve the built output                                 |
| `bun test`        | Run the barcode test suite                             |
| `bun run check`   | Format, lint and type-check                            |

Sources are TypeScript with `strict` on, and type checking runs through tsgolint as part of
`vp check`. Styles are split by concern under `src/styles/`, using native CSS nesting — Safari
has supported it since 16.5, and the build lowers it for older targets anyway.

## What a card stores

| Field                 | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `payload`             | Exactly what the barcode encodes                                              |
| `format`              | `code128`, `ean13`, `ean8`, `upca`, `code39`, `itf`, `qr`, `pdf417` or `none` |
| `display`             | The number the shop prints, when it differs from `payload`                    |
| `rule`                | A rotating-code rule id, when the payload must be rebuilt from the clock      |
| `live`                | The shop issues a new code each visit and it cannot be reproduced offline     |
| `link`                | The shop to open for a live card (https only)                                 |
| `order`               | Manual priority, set by dragging; ties fall back to name                      |
| `name`, `color`, `id` | Presentation and identity                                                     |

Three things that real cards do, all easy to get wrong, drove this shape:

- **The printed number is not always the payload.** One shop prints one number above a
  barcode that encodes a different one, confirmed by comparing bar patterns. Typing what you
  can read produces a card that will not scan, so `payload` and `display` are kept apart and
  scanning is the reliable way to add a card.
- **Some codes are rebuilt from the clock.** They interleave the card number with the current
  time, so a stored copy dies within minutes. Such a card stores its number plus a pattern the
  holder writes — `YYYY####MM####DD####HH####mmss`, say — and the code is rebuilt every time
  the card is opened. Nothing about any shop is hard-coded; the pattern comes from the user.
- **Some codes cannot be reproduced at all.** Others append a server-issued token that changes
  on every visit and is not derived from the clock. Those are marked `live`: the stable card
  number is kept and the code is fetched from the shop, rather than drawing a barcode that
  will fail at the till.

A plastic card cannot rotate, so a shop issuing one must also accept a static code. Where a
plastic card exists, scanning it beats a live card.

## Current scope

- Add, edit and delete cards in IndexedDB, with a full-screen viewer for the till.
- Card and dense-list views, search across name and number, and drag reordering.
- Barcode rendering for Code 128, EAN-13, EAN-8, UPC-A, Code 39, Interleaved 2 of 5 and QR.
- Rotating-code rules, applied per card, refreshed while the card is on screen.
- JSON export and import; the share sheet is used on iOS, where downloads are unreliable.
- Installable and offline via a service worker; system, light and dark appearance.
- Native colour picker, with automatic black/white text contrast.

Reordering uses pointer events rather than HTML drag-and-drop, which never fires on iOS, and
the same reordering is available from the keyboard with the arrow keys on a card's handle. It
is disabled while a search filter is active, since the resulting order would not be visible.
Search appears once there are five cards. The barcode format is deliberately not shown on the
home screen; only a live card is marked, because opening it gives a link rather than a code.

Not implemented yet: **scanning by camera or photo**.

## Verifying the encoders

The encoders are hand-written, so they are checked two ways. `npm test` asserts the structural
invariants of every pattern table (Code 128 characters span 11 modules, EAN `R` is the
complement of `L` and `G` its reverse, Code 39 characters have exactly three wide elements)
and round-trips every format back to its input. Separately, generated symbols were rendered to
PNG and read back with macOS Vision, covering QR versions 1-10 at all four error-correction
levels, which is what caught a reversed Reed-Solomon polynomial and two module-placement bugs.

## Still to build

- **Scanning.** Safari exposes no `BarcodeDetector`, so decoding has to be hand-written:
  1D and QR from the camera or a photo.

PDF417 rendering was dropped rather than deferred. The only card needing it turned out to be one whose
code cannot be reproduced offline, so a drawn PDF417 would never scan. That removes the
2787-entry symbol table, which was the largest remaining piece of work.

## Hosting

The build output in `dist/` is static, for GitHub Pages under `/super-app/`.

The service worker is written by hand rather than generated, because it is deliberately
cache-first: a card has to open at the till whatever the signal is like. What it cannot track
by hand is content-hashed filenames, or remembering to invalidate the previous cache — that
was forgotten five times before the build existed, each time shipping a stale app. A plugin in
`vite.config.ts` derives both the file list and the cache name from what was actually emitted,
so the worker's version changes exactly when its contents do. Records never leave the
device. Safari can evict IndexedDB after about a week of not opening the site, and
`navigator.storage.persist()` is a no-op there, so installing to the Home Screen and keeping an
export both matter. An installed app has storage separate from Safari; there is no device sync.

Source repository: https://github.com/bixente4669/super-app
