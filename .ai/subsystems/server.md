# Self-hosted server

Status: planned

## Scope

`gripread-server` serves one reader's library to a browser (the web version) and, in later stages, to the app on their devices as the replacement for WebDAV while they are connected. It runs the same core as the app ([shared core decision](../notes/implemented/2026-10-13-shared-core.md)), so the web version reads, searches sources, downloads, and backs up exactly as a device does. It is single-user. Long-running work that devices cannot keep doing in the background, scheduled 更新目录 and RSS polling, belongs to the server once those stages begin. Pages that need the Android WebView, the Android notification, and system pickers are device features.

## Interfaces

Configuration comes from the environment: `GRIPREAD_DATA` (the data folder, `/data` in the image), `GRIPREAD_PORT` (8080), `GRIPREAD_WEB` (the built page), and `GRIPREAD_PASSWORD` (sets the password on first run only). The data folder holds `library/` (the core's data folder), `server.json` (the account and sessions), and `uploads/`.

- `POST /api/rpc/{name}` runs a core command with the page's `{ request }` arguments and answers JSON, raw bytes for fonts and covers, or the core's error as JSON with status 400.
- `GET /api/events` is a WebSocket carrying the core's events as `{ event, payload }`.
- `POST /api/upload?name=` stores one file and answers an `upload:<id>/<name>` path; `GET /api/export` downloads, once, the file the last command saved for the reader.
- `POST /api/sync/push` (`{ device, changes }`) and `GET /api/sync/pull?since=` carry sync records ([decision](../notes/implemented/2026-10-13-native-sync-records.md)); a push answers the book files and covers the server lacks, and every new record is announced on the event socket as `sync { head }`.
- `PUT`/`GET /api/blobs/book/{sha256}` and `/api/blobs/cover/{sha256}.{ext}` send and fetch original book files and covers, checked against their hash.
- `/api/auth/status`, `setup`, `login`, `logout`, `password`, and `sessions` manage the account; everything else under `/api` needs a session.
- Other paths serve the built page, with `index.html` for unknown routes.

The page talks to these through `src/services/transport.ts` and `src/services/files.ts`; the account screens use `src/services/server.ts`.

## Behavior

The first visit sets the password (at least six characters) unless `GRIPREAD_PASSWORD` set it; the password is kept as an argon2 hash. Signing in creates a session named after the browser or device, kept only as the SHA-256 of a random token: the page holds it in an HttpOnly, SameSite=Strict cookie, marked Secure behind a proxy that reports HTTPS, and devices send it as a Bearer token. Five failed sign-ins within a minute refuse further attempts for the rest of that minute. 设置 › 服务器账号 lists sessions with their last use, signs one out, changes the password (signing the others out), and signs this page out. TLS belongs to a reverse proxy in front of the server.

A command's file fields must be upload paths, which the server turns into the uploaded file's location; any other path is refused, so requests reach no other file on the host. Uploads older than a day are removed at start, since imports copy what they keep. Batch folder import uploads a folder's TXT files from the browser; local backup folders are device-only. Exports (a backup, book sources) are downloaded by the page right after the command saves them.

The server's library is the canonical copy for sync: it applies the records devices push, logs them in order, and logs the web version's own edits two seconds after they pause (at most ten during continuous edits). A book file it receives is imported, and the records waiting for it apply. Once a day, when records arrived, it writes a recovery point of the library; the newest five are kept.

The image is built from the repository's `Dockerfile` (the page, then a release build of the server, on Debian slim as a non-root user with the data folder as a volume). The `Build` workflow publishes it to `ghcr.io/<owner>/gripread` from every push to `dev` (tag `dev`) and `main` (tag `latest`), as [versions and releases](../engineering/workflow.md#versions-and-releases) describes.

## Acceptance

- A fresh data folder asks for a password, refuses short ones and a second setup, and keeps the account across restarts without storing tokens.
- Commands, uploads, exports, and events need a session; a revoked or forged token is refused.
- Upload paths import a TXT that reads and turns pages in the browser; other paths are refused.
- A second browser signs in and sees the same shelf; an export downloads once.
- The image starts with a volume, serves the page, and keeps data across container recreation.
