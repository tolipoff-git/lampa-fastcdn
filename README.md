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
