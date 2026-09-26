# FastCDN — Lampa plugin

Standalone online-source plugin for [Lampa](https://github.com/yumata/lampa-source).
Resolves streams directly from fast public CDNs (no proxy).

## Install
Lampa → Settings → Extensions → Add plugin by URL:

```
https://cdn.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@v0.8.2/fastcdn.js
```

## Sources
- CDNVideoHub (VK CDN backend)
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

## Prepare (download whole episode on the server)
Pressing a track when a relay is configured offers two actions: **watch** or
**prepare on the server**. Prepare downloads the whole stream with
N_m3u8DL-RE (parallel) and stores it under `/hls/media/`:

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
After a prepared file is ready the plugin **hands it straight to MPV** via the `mpv://`
scheme handled by `~/.local/bin/mpv-bridge` (desktop handler) — the pipeline is
"server finished -> MPV plays the server file". Settings:

- `fastcdn_mpv = false` — play in the browser instead of MPV.
- `fastcdn_mpv_auto = false` — show the "Open in MPV / Watch here" prompt instead of
  auto-opening MPV.

```
Lampa.Storage.set('fastcdn_mpv_auto', false);
```

After playback `mpv-bridge` deletes the prepared file from the server
(`DELETE /hls/media/<file>`; the relay also GCs by TTL/size as a safety net).

Links that cannot be downloaded server-side (VK CDN, `%s` segment templates) are
not offered for prepare.
