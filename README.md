# StrobeIT-Pro Firmware Updater

A browser-based firmware updater for StrobeIT-Pro modules. Firmware files are selected locally and processed in the browser.

## Use the updater

Open the hosted updater in Chrome or Edge:

https://teravolt-labs.github.io/StrobeFlasher/

Connect a compatible USB serial programmer to the powered module, select its serial port, choose an Intel HEX or raw BIN firmware file, and start the update. Keep the module powered until verification finishes.

## Browser requirements

- Chrome or Edge with Web Serial support
- HTTPS or localhost
- A compatible USB serial programmer

## Build and test

Requires Node.js 20 or newer.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

The production build is a single self-contained file at `dist/index.html`.

## Hosting

GitHub Actions deploys `dist` to GitHub Pages when changes are pushed to `main`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
