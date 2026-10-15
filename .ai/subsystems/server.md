# Self-hosted server

Status: planned

## Scope

`gripread-server` serves one reader's library to a browser (the web version) and to the app on their devices, which sync with it instead of WebDAV while connected ([Sync](sync.md)). It runs the same core as the app ([shared core decision](../notes/implemented/2026-10-13-shared-core.md)), so the web version reads, searches sources, downloads, and backs up exactly as a device does. It is single-user. Long-running work that devices cannot keep doing in the background, scheduled 更新目录 and RSS polling, belongs to the server once those stages begin. Pages that need the Android WebView, the Android notification, and system pickers are device features.

## Interfaces

Configuration comes from the environment: `GRIPREAD_DATA` (the data folder, `/data` in the image), `GRIPREAD_PORT` (8080), `GRIPREAD_WEB` (the built page), and `GRIPREAD_PASSWORD` (sets the password on first run only). The data folder holds `library/` (the core's data folder), `server.json` (the account and sessions), and `uploads/`.

- `POST /api/rpc/{name}` runs a core command with the page's `{ request }` arguments and answers JSON, raw bytes for fonts and covers, or the core's error as JSON with status 400.
- `GET /api/events` is a WebSocket carrying the core's events as `{ event, payload }`.
- `POST /api/upload?name=` stores one file and answers an `upload:<id>/<name>` path; `GET /api/export` downloads, once, the file the last command saved for the reader.
- `POST /api/sync/push` (`{ device, changes }`) and `GET /api/sync/pull?since=` carry sync records ([decision](../notes/implemented/2026-10-13-native-sync-records.md)); a push answers the book files and covers the server lacks, and every new record is announced on the event socket as `sync { head }`.
- An `/api/` path the server does not have answers a JSON 404 rather than the page.
- `GET /api/sync/wait?since=` is a device's long poll: it answers `{ head }` once a record past `since` is logged, or after 25 seconds.
- `GET /api/cloud/books` lists the shelf's local books whose files the server keeps (SHA-256, title, author, size, added, EPUB or not), for 云书架 on connected devices.
- `PUT`/`GET /api/blobs/book/{sha256}` and `/api/blobs/cover/{sha256}.{ext}` send and fetch original book files and covers, checked against their hash.
- `/api/auth/status`, `setup`, `login`, `logout`, `password`, and `sessions` manage the account; everything else under `/api` needs a session.
- Other paths serve the built page, with `index.html` for unknown routes.

The page talks to these through `src/services/transport.ts` and `src/services/files.ts`; the account screens use `src/services/server.ts`.

Connected devices also check for and download app updates through the server's mirror under `/api/update/` ([Updates](updates.md)).

## Behavior

The first visit sets the password (at least six characters) unless `GRIPREAD_PASSWORD` set it; the password is kept as an argon2 hash. Signing in creates a session named after the browser or device, kept only as the SHA-256 of a random token: the page holds it in an HttpOnly, SameSite=Strict cookie, marked Secure behind a proxy that reports HTTPS, and devices send it as a Bearer token. Five failed sign-ins within a minute refuse further attempts for the rest of that minute. 设置 › 服务器账号 lists sessions with their last use, signs one out, changes the password (signing the others out), and signs this page out; connected apps show the same sections on their 服务器 page. The web version's settings leave out 备份与云端, since the server is what devices sync and back up to. The server writes its own entries to the log (area `server`, shown as 服务器 in 日志, which can filter by area): start, sign-ins and failed sign-ins, sign-outs, removed devices, password changes, each device's sync pushes and pulls (at most one line per device and direction a minute), book files received and fetched, 定时追更 and 更新书架 runs with failed books, and update downloads through the mirror. TLS belongs to a reverse proxy in front of the server.

A command's file fields must be upload paths, which the server turns into the uploaded file's location; any other path is refused, so requests reach no other file on the host. Uploads older than a day are removed at start, since imports copy what they keep. Batch folder import uploads a folder's TXT files from the browser; local backup folders are device-only. Exports (a backup, book sources) are downloaded by the page right after the command saves them.

The server's library is the canonical copy for sync: it applies the records devices push, logs them in order, and logs the web version's own edits two seconds after they pause (at most ten during continuous edits). A book file it receives is imported, and the records waiting for it apply. Once a day, when records arrived, it writes a recovery point of the library; the newest five are kept.

定时追更 (`crates/server/src/jobs.rs`) updates the server's online books on a schedule set on 服务器账号: off, or every 1, 3, 6 (the default), or 12 hours, kept in `jobs.json`. Each run refreshes every updatable book's details and contents with four workers, then fetches up to the chosen number of new chapters ahead (5 by default). The changes are logged for devices like the web version's edits. `GET`/`PUT /api/jobs` read and change the schedule and show the last run. `POST /api/jobs/update` runs an update now, for the books named by sync key or all of them, and answers with each book's new chapters; connected devices send their 更新书架 here. `GET /api/sync/chapter?key=&url=&title=` gives a chapter of the server's copy of a book, matched by address and then by title, from its cache or fetched now; devices read uncached chapters through it, so a source the server reaches serves devices that cannot ([decision](../notes/implemented/2026-10-14-server-chapters.md)).

The image is built from the repository's `Dockerfile` (the page, then a release build of the server, on Debian slim as a non-root user with the data folder as a volume). The `Build` workflow publishes it to `ghcr.io/<owner>/gripread` when a version tag is pushed ([versions and releases](../engineering/workflow.md#versions-and-releases))../engineering/workflow.md#versions-and-releases) describes.

## Acceptance

- A fresh data folder asks for a password, refuses short ones and a second setup, and keeps the account across restarts without storing tokens.
- Commands, uploads, exports, and events need a session; a revoked or forged token is refused.
- Upload paths import a TXT that reads and turns pages in the browser; other paths are refused.
- A second browser signs in and sees the same shelf; an export downloads once.
- The image starts with a volume, serves the page, and keeps data across container recreation.
