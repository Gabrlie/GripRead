# Decision: Chosen sources can reach their sites through the server

Status: implemented

## Problem

Some book sources answer the reader's server but not the reader's phone: a site blocks a network or a country, or is slow from it. The [server chapters decision](2026-10-14-server-chapters.md) already lets connected devices read uncached chapters from the server, but search, Discover, details, contents, and covers of such a source still fail on the device.

## Decision

A source can be set to 通过服务器访问 on a device (its More menu in 书源管理). The switch is device-local, kept in the source cache under `viaServer_<source url>`, and never part of the source's JSON, backups, or sync, since which network reaches a site depends on the device.

The engine sends each request hop through one function (`sources::http::execute`), which builds the hop as the device would send it (headers, User-Agent, and the device's cookies) and, for a source with the switch on while a server is connected, hands that single hop to the server (`POST /api/source/fetch`, with a session). The server sends it without following redirects and answers its status, headers, and body (bodies in base64 both ways); the device stores any `Set-Cookie` and follows redirects itself, so scripts, cookies, and logins stay on the device. The server only sends to `http` and `https` addresses whose every resolved address is public; loopback, private, link-local, and other local addresses are refused, so a device cannot reach the server's own network. When the server cannot be reached or refuses, the hop goes out directly and the log says so once per source. WebView pages stay on the device.

## Alternatives considered

- **Proxying every source request through the server:** rejected in the server chapters decision, as it moves every source's traffic and cookies to the server; a per-source, opt-in switch keeps the rest direct.
- **Running the whole source on the server:** scripts would run where the device's login state and WebView are absent.
- **Following redirects on the server:** each hop's cookies would land on the server instead of the device.

## Consequences

- A relayed request costs a round trip to the server, so the switch suits sources the device cannot reach, not all of them.
- The server becomes able to fetch public addresses for signed-in devices; the address check is the boundary, and it is resolved per hop.
