# MeshPay verification status

This file separates checks actually run during package preparation from checks that still require a complete dependency install and a MongoDB runtime.

## Checks run in the preparation environment

- `node --check` passed for all 27 JavaScript (`.js`) files present after updates.
- TypeScript's JS/JSX transpiler parsed `client/src/App.jsx` and `client/src/main.jsx` without syntax diagnostics. (Checked after the final code edits.)
- `npm run test:crypto` passed: server and WebCrypto Ed25519 signature verification, signed-payload tamper rejection, RSA-OAEP + AES-256-GCM round trip, modified-ciphertext rejection, and recipient-device binding rejection.
- JSON parsing passed for `package.json` and the PWA manifest; PyYAML parsed `docker-compose.yml`, `render.yaml`, and the GitHub Actions workflow. A static relative-import target check also passed. ZIP integrity and package file listing are validated in the final archive step.

## Changes made during this pass

- MongoDB startup now verifies that the deployment supports transactions (replica set or sharded cluster) instead of silently accepting a standalone server.
- `/api/health/ready` verifies database reachability and transaction-capable topology.
- Malformed JSON and oversized bodies return explicit `400` / `413` errors rather than generic `500` responses.
- Added integration coverage for authentication and origin checks, cross-site Fetch Metadata blocking, baseline security headers, malformed/oversized JSON, idempotent offline reserve, cross-channel concurrent spending, changed-content voucher-ID reuse, wrong-recipient claims, concurrent replay of one offline voucher, and valid vouchers rejected for insufficient reserve.
- Added a standalone cryptographic regression test and wired it into `npm run check`.
- Recipient devices now verify voucher signature and exact payload shape locally before storing a voucher for sync; local JSON/envelope sizes are bounded and generation validates amount/TTL/handle shape.
- Added cross-site Fetch Metadata blocking for state-changing requests and updated the service-worker cache version. The ESLint command uses explicit file globs so the flat-config run targets both JavaScript and JSX source. The Docker build keeps development tooling out of the final runtime image.

## Still not verified here

- `npm install --include=dev --no-audit --no-fund` was attempted again during the final pass but timed out. No dependency installation, ESLint execution, Vitest integration run, or Vite production build is claimed to have passed. A `package-lock.json` could not be generated here; create and commit it after the first successful dependency install.
- Docker and MongoDB executables are unavailable in this environment, so Compose startup, replica-set initialization, database transaction behavior, and live HTTP flows were not run here.
- Deployment to Render / MongoDB Atlas and production HTTPS/cookie behavior remain to be tested after dependencies are available.

## Required next verification on a machine with npm registry access

Run `npm install --include=dev`, copy `.env.example` to `.env` and set a random `JWT_SECRET`, then run `npm run check`. Prefer `docker compose up --build` for local end-to-end testing; confirm both health endpoints, create two sandbox accounts, retry an online transfer with the same idempotency key, settle one encrypted offline voucher, replay it, test a stale epoch and check ledger reconciliation. Do not use real money or describe the application as connected to UPI rails.
