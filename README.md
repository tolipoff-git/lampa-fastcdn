# FastCDN — Lampa plugin

Standalone online-source plugin for [Lampa](https://github.com/yumata/lampa-source).
Resolves streams directly from fast public CDNs (no proxy).

## Install
Lampa → Settings → Extensions → Add plugin by URL:

```
https://cdn.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@latest/fastcdn.js
```

Install once — this URL is stable and always serves the latest release.

## Updates
The plugin updates itself: Lampa re-fetches every plugin on each app start, and
the plugin also checks `@latest` while running and reloads when a newer version is
live (never during playback). `@latest` resolves to the newest release tag, so a
fresh push (with a bumped `VERSION` and matching tag) is visible immediately — no
need to change the URL or reinstall.

To publish a release (repo owner):

```
./release.sh "fix: ..."   # commit + push + tag from VERSION + purge jsDelivr
```

## Optional sources via Lampac gateway

FastCDN can list **Collaps**, **VideoSeed**, and **FanCDN** when a separate Lampac server
is configured. These are **not** anonymous/free direct CDN APIs: the server-side
providers may require upstream tokens, cookies or Playwright and are subject to
their providers' access requirements. No credentials or anti-bot bypass are
bundled into FastCDN.

Configure a Lampac instance you administer, with these provider modules enabled,
then set its origin in Lampa:

```js
Lampa.Storage.set('fastcdn_lampac_url', 'https://your-lampac-host.example');
```

**Requirements:** Lampac `/lite/{collaps,videoseed,fancdn}?rjson=true` endpoints must
be reachable from the Lampa WebView and return JSON with the standard `type` /
`data` fields. If cross-origin, configure CORS on your own gateway. Use HTTPS
unless you explicitly operate in a trusted local network. The server itself,
its authentication, provider enablement and upstream connectivity are not
installed or managed by this JavaScript plugin.

When `fastcdn_lampac_url` is empty or invalid, only the original CDNVideoHub and
Filmix sources are queried. Empty or failing optional providers are hidden; they
do not prevent the original sources from loading. Season listings are fetched
from the gateway with at most four concurrent requests. Only stream playback is
exposed; server-side media preparation is not enabled for optional providers.

Disable the optional providers without reinstalling:

```js
Lampa.Storage.set('fastcdn_lampac_url', '');
```

**Validation:** The regression tests cover JSON conversion, season/episode paths,
source gating, and URL restrictions. Live source availability, upstream quality,
and speed are environment-dependent and must be tested with your Lampac server.

## Source lookup cache
Successful source listings are cached for 45 seconds (up to 12 entries). Stream
URLs are still resolved when played. To disable or tune the cache:

```js
Lampa.Storage.set('fastcdn_cache_seconds', 0); // disabled; default 45, max 120
```

## Sources
- CDNVideoHub (VK CDN backend) — always plays HLS through the relay; its
  progressive MP4s are cross-origin without CORS, so they are only a fallback.
- Filmix (PRO+ supported)

Sources that return no video are hidden; the CDN picker lists only sources that
actually have streams, ranked by response speed (fastest first).

## Optional server-side HLS relay
Plays `.m3u8` streams through a server relay that prefetches chunks in parallel
(faster start, fewer stalls). Enable in the Lampa console:

```
Lampa.Storage.set('fastcdn_relay', 'http://<host>:8080/hls');
Lampa.Storage.set('fastcdn_relay_token', '<token>');
```

Clear with `Lampa.Storage.set('fastcdn_relay', '')` to play directly.

If the Lampa page itself is served from the relay host (our server), it may set
`window.FASTCDN_RELAY = location.origin + '/hls'` (e.g. in `lampainit.js`); the
plugin then uses the relay by default with no per-device setup.

## Track menu
Pressing a track opens a menu:
- **Смотреть в браузере** — play via the relay (HLS).
- **Открыть в MPV (bridge)** — hand the stream to the desktop MPV bridge.
- **Подготовить на сервере** — only for downloadable sources (below).

## Prepare (download whole episode on the server)
**Prepare** downloads the whole stream on the server and stores it under
`/hls/media/`; a progress bar shows download %, then transcoding:

- `fastcdn_prepare_profile = 'copy'` (default) — remux to **MKV**, streams copied
  as-is (quality untouched, keeps all audio/subtitle tracks).
- `fastcdn_prepare_profile = 'h264'` — transcode to **H.264/AAC MP4** (CRF 18) for
  devices that cannot play HEVC/AV1.

```
Lampa.Storage.set('fastcdn_prepare_profile', 'copy'); // or 'h264'
```

## Ad filtering
The relay strips SCTE-35 ad breaks (`EXT-X-CUE-OUT` .. `EXT-X-CUE-IN`) from HLS
media playlists by default (`HLS_STRIP_CUE_ADS=1`) and can drop ad-host
segments via the `HLS_BLOCK` regex.

## MPV bridge
"Открыть в MPV" hands the stream to the desktop bridge
(`~/.local/bin/mpv-bridge`). The plugin calls the bridge's local endpoint
`http://127.0.0.1:12777/play` first — Chromium refuses to launch the `mpv://`
scheme without user activation (and rewrites it into `http://mpv//…`) — and
falls back to the `mpv://` scheme for machines without the endpoint.

Settings:
- `fastcdn_mpv = false` — hide the MPV option (browser only).
- `fastcdn_mpv_auto = true` — after prepare, auto-hand to MPV instead of asking
  (off by default; the programmatic launch is often blocked by the browser).

```
Lampa.Storage.set('fastcdn_mpv_auto', true);
```

After playback the bridge deletes the prepared file (`DELETE /hls/media/<file>`,
only on a full watch); the relay GCs by TTL/size as a safety net.

## Server storage
Prepared files live under `/hls/media/` on the relay and are removed when fully
watched or by the relay's GC — TTL and total-size caps via `HLS_MEDIA_TTL_HOURS`
and `HLS_MEDIA_MAX_MB` (this deployment: 30 min / 20 GB).

Playerjs-style Filmix links carry a quality template (`.../1080p_[,,1080,720,480,].mp4`);
the plugin expands it to a concrete quality for both playback and prepare (the raw
template is not a real file and returns 400). Links that still cannot be downloaded
server-side (VK CDN, unresolved `%s`) are not offered for prepare.

## Security boundaries (deployment audit)

This repository contains only the Lampa client plugin. The HLS relay and local
MPV bridge are separate services; their authentication and filesystem behavior
cannot be verified from this repository alone.

- **Relay:** The optional token is sent in URL query parameters (including HLS
  playlist requests). Keep the relay behind HTTPS and access controls; redact
  query strings in proxy logs. Moving credentials to request headers requires a
  coordinated server/client change, particularly for player playlist requests.
- **Download API:** The relay must authenticate POST `/dl`, job polling,
  `/media` access and deletion; validate destination names, remote URL targets,
  redirect chains and response sizes; restrict outbound fetches to prevent SSRF.
- **MPV bridge:** `127.0.0.1:12777/play` is invoked via GET and receives an
  arbitrary stream URL. Bind only to loopback, reject untrusted browser origins,
  and require explicit authorization or a short-lived nonce to prevent local
  cross-origin invocation. This needs changes in the bridge service, not only
  the plugin.
- **Prepared media:** Verify same-origin media paths and authentication at the
  relay. The client accepts media URLs returned by the relay; never treat that
  response as an authorization decision.

These are server-side checks and risk mitigations, **not** claims that the
currently deployed relay or bridge is vulnerable or already hardened.
