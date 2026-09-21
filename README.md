# FastCDN — Lampa plugin

Standalone online-source plugin for [Lampa](https://github.com/yumata/lampa-source).
Resolves streams directly from fast public CDNs (no proxy).

## Install
Lampa → Settings → Extensions → Add plugin by URL:

```
https://cdn.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@master/fastcdn.js
```

## Sources
- CDNVideoHub (VK CDN backend)
- Filmix (PRO+ supported)

Sources that return no video are hidden; the CDN picker lists only sources that
actually have streams, ranked by response speed (fastest first).
