# Decision: Online books update and read through the server

Status: implemented

## Problem

Book sources often answer some networks and not others: the reader's server, in another country, may reach a site their phone cannot, and the other way round. Updating directories needs a device to stay online, which phones do not. Each device also updated and fetched every book on its own, so the same chapters were fetched once per device.

## Decision

The server updates its online books on a schedule and fetches a few new chapters of each ahead. Chapter lists sync as `chapters:online:<key>` records, keyed like `online:` records by title and author, and are applied after the books they belong to.

Connected devices send 更新书架 to the server and read uncached chapters from it (`GET /api/sync/chapter`). Chapters are matched by address, then title, since the two copies' lists may differ until they sync. The relay sits in the core's storage (`ChapterRelay`), before the source in `online_reader::raw_chapter`, so reading, pre-download, and 下载管理 all use it. A device falls back to its own source request whenever the server cannot answer.

## Alternatives considered

- **Syncing only `latest_chapter_title`:** each device would still have to ask the source for the directory.
- **Proxying source requests through the server:** this would move cookies and logins to the server and break sources that run scripts on the device.
- **A process-wide relay:** the server and test devices share one process, and a global relay would make the server ask itself.

## Consequences

A connected shelf updates in one place and reads where the server can reach. Chapter lists add a record per online book that changes whenever the directory grows. A source that only the device can reach still works through the fallback. The server keeps fetched chapters in its own cache, under 数据管理 like a device's.
