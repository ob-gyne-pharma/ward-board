# Ward Board v1.1

OB-Gyne ward patient board — clinical workflow tool for shift handover, patient tracking, and team communication.

## File structure

```
ward-board/
├── index.html          — HTML templates and modals
├── app.css             — All styles (design tokens, components, dark mode, RTL)
├── app.js              — All application logic (28 features)
├── firebase-sync.js    — Firebase Realtime Database module (isolated)
├── sw.js               — Service Worker (offline cache, FCM-ready push)
├── manifest.json       — PWA manifest (install to home screen)
├── icons/
│   ├── icon.svg        — Source icon (convert to PNG for production)
│   ├── icon-192.png    — Required for PWA install (generate from SVG)
│   └── icon-512.png    — Required for splash screen (generate from SVG)
└── README.md
```

## Deployment (GitHub Pages)

```bash
# Clone your repo
git clone https://github.com/ob-gyne-pharma/ward-board.git
cd ward-board

# Copy all files from this folder into the repo root
# Then:
git add .
git commit -m "v1.1 — multi-file split, Service Worker, PWA manifest"
git push origin main
```

GitHub Pages serves everything automatically. The app will be at:
`https://ob-gyne-pharma.github.io/ward-board/`

## Generate PNG icons (required for PWA install prompt)

Using any SVG-to-PNG tool (Inkscape, SVGOMG, or online converter):
- `icons/icon.svg` → `icons/icon-192.png` (192×192)
- `icons/icon.svg` → `icons/icon-512.png` (512×512)

Or use a free online tool: https://realfavicongenerator.net

## Firebase security rules (IMPORTANT — do this now)

In Firebase Console → Realtime Database → Rules, paste:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "wardBoardState": {
      "v3": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

This blocks the root path and limits access to only the node your app uses.
Full security (with Firebase Auth) is planned for v2.0.

## What's new in v1.1

- Multi-file architecture (HTML / CSS / JS / Firebase / SW separated)
- Service Worker: offline cache (app works without internet after first load)
- Service Worker: FCM-ready push notification handler
- Proper manifest.json (no longer inline data URI)
- Background sync hook (ready for failed-save retry queue)

## Next steps for v2.0

- [ ] Firebase Auth (email/password or Google SSO)
- [ ] Updated Firebase rules (require auth)
- [ ] Firebase Cloud Messaging (push to locked devices)
- [ ] Background sync for failed writes
- [ ] Arabic UI translation (labels — RTL layout already done)
- [ ] Gestational age auto-calc from EDD
- [ ] Diagnosis autocomplete
