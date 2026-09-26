/**
 * FastCDN — standalone online-source plugin for Lampa.
 *
 * Registers its own online component (like online_mod), so the movie card gets a
 * "Fast CDN" button that opens a full source view with filters:
 *   CDN (sort) -> Voice -> Quality, plus Season for serials.
 *
 * Sources:
 *   - CDNVideoHub  (playlist -> video/<vkId> -> VK CDN)
 *   - Filmix       (search -> post/<id>; via /filmix/ nginx proxy that sets the
 *                   app User-Agent Filmix requires; PRO+ token supported)
 *
 * Sources that return nothing are hidden; the CDN picker lists only sources
 * that actually have video, ranked by response speed (fastest first).
 *
 * Optional server-side HLS relay (parallel chunk prefetch) can be enabled with:
 *   Lampa.Storage.set('fastcdn_relay', 'http://host:8080/hls')
 *   Lampa.Storage.set('fastcdn_relay_token', '<token>')   // if the relay needs it
 * When set, .m3u8 streams are played through the relay.
 * If the Lampa page defines window.FASTCDN_RELAY (e.g. served from our server),
 * it is used as the default relay without any per-device setup.
 * Via the relay a track can also be "prepared": downloaded whole and remuxed
 * (profile=copy -> .mkv, quality untouched) or transcoded (profile=h264 -> .mp4)
 * by the server, then played from /hls/media/… (Lampa.Storage 'fastcdn_prepare_profile').
 *
 * 0.8.7 changes:
 *   - Install/self-update URL switched to jsDelivr @latest. @master is stuck
 *     behind jsDelivr's 12 h branch cache (stale code even after a cache purge),
 *     while @latest follows the newest release tag immediately.
 *
 * 0.8.6 changes:
 *   - Auto-update: install once from the stable jsDelivr URL; the plugin checks
 *     that URL on start and reloads itself when a newer version is live (never
 *     during playback). Releases purge the jsDelivr cache, so the update is
 *     picked up immediately without changing the install URL.
 *
 * 0.8.5 fixes:
 *   - CDNVideoHub now falls back to aggr=imdb when no Kinopoisk id is available.
 *     With a TMDB content source the CDN was silently hidden: movie.id is a TMDB
 *     id and querying it as kp returns nothing, so Interstellar & co. looked
 *     "missing" even though the CDN has them.
 *
 * 0.8.4 fixes:
 *   - Filmix device id is now generated once and cached (was regenerated on
 *     every single request, which breaks any per-device session/PRO+ binding).
 *   - Filmix search now requires an actual title/year match; a 0-score top
 *     result is treated as "not found" instead of silently opening a
 *     different title.
 *   - idsOf() no longer guesses a Kinopoisk id from digit length alone
 *     (collided with TMDB ids of the same length, e.g. "Inception" = 27205).
 *   - Saved CDN choice (fastcdn_balanser) is now loaded on start instead of
 *     being write-only.
 *   - Switching the CDN source reuses already-fetched data instead of
 *     re-querying every source over the network again.
 *   - MPV bridge link no longer produces a double "?" when the source URL
 *     already has a query string.
 *   - Movie-card button now carries the FastCDN logo (circled play mark).
 *
 * @version 0.8.7
 */
(function () {
    'use strict';

    var VERSION = '0.8.7';
    var LOG = '[FastCDN] ';

    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift(LOG);
        console.log.apply(console, a);
    }

    function norm(s) {
        return (s || '').toString().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
    }

    function randomHex(n) {
        var s = '', h = '0123456789abcdef';
        for (var i = 0; i < n; i++) s += h[Math.floor(Math.random() * 16)];
        return s;
    }

    function qualityOf(url) {
        if (!url) return 0;
        var m = url.match(/\[[,\d]*?(\d{3,4})[,\d]*?\]/) || url.match(/(\d{3,4})p/) || url.match(/\/(\d{3,4})\b/);
        return m ? parseInt(m[1]) : 0;
    }

    // Playerjs-style CDN links carry a quality template, e.g.
    //   .../1080p_[,,1080,720,480,].mp4   or   .../s01e06_%s.mp4
    // They are not real files until the placeholder is replaced by a quality.
    function linkQualities(url) {
        if (!url) return [];
        var out = [], m = url.match(/\[([,\d]*)\]/);
        if (m) m[1].split(',').forEach(function (x) { var n = parseInt(x); if (n >= 300 && n <= 4320) out.push(n); });
        if (!out.length) { var q = qualityOf(url); if (q) out.push(q); }
        out.sort(function (a, b) { return b - a; });
        return out;
    }

    function expandLink(url, quality) {
        if (!url) return url;
        var pick = parseInt(quality) || 0;
        var b = url.match(/\[([,\d]*)\]/);
        if (b) {
            var list = b[1].split(',').map(function (x) { return parseInt(x); })
                .filter(function (n) { return n >= 300 && n <= 4320; });
            if (list.length) {
                var chosen = (pick && list.indexOf(pick) !== -1) ? pick : Math.max.apply(null, list);
                return url.replace(/\[[,\d]*\]/, String(chosen));
            }
        }
        if (/%[sd]/.test(url)) return url.replace(/%[sd]/g, pick ? String(pick) : '1');
        return url;
    }

    function getJSON(url, ok, err) {
        var net = new Lampa.Reguest();
        net.timeout(15000);
        net.native(url, function (json) { ok(json); }, function (a, c) {
            log('request failed', url, a && a.status);
            if (err) err(a, c);
        }, false, { dataType: 'json' });
    }

    /* ================================================================== *
     * Server-side HLS relay (optional)
     * ================================================================== */

    function relayBase() {
        var base = Lampa.Storage.get('fastcdn_relay', '') + '';
        if (!base && window.FASTCDN_RELAY) base = window.FASTCDN_RELAY + '';
        return base.replace(/\/+$/, '');
    }

    function relayToken() {
        return Lampa.Storage.get('fastcdn_relay_token', '') + '';
    }

    // NOTE: intentionally kept on the escape/unescape trick instead of
    // TextEncoder — Lampa also runs on old Tizen/webOS/Android TV WebViews
    // where TextEncoder isn't guaranteed to exist, while escape/unescape is
    // deprecated but universally still supported for exactly that reason.
    function b64url(str) {
        return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function relayUrl(url, headers) {
        var base = relayBase();
        if (!base || !url || !/\.m3u8($|\?)/i.test(url)) return url;
        var h = headers ? b64url(JSON.stringify(headers)) : '';
        var out = base + '/playlist.m3u8?u=' + b64url(url) + '&h=' + h;
        if (relayToken()) out += '&token=' + encodeURIComponent(relayToken());
        return out;
    }

    function relayFetch(path, opts) {
        return fetch(path, opts || {}).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    function isVkUrl(url) {
        return /vkuser\.net|vk\.com|vkvideo|okcdn|mycdn\.me|vk-cdn/i.test(url || '');
    }

    /* ================================================================== *
     * Sources. Each fetch(ids, ok, err) returns { isSerial, tracks: [...] }
     * track = { voice, season, episode, title, qualities:[..], url?, headers?, noPrepare?, resolve?(q,cb,err) }
     * ================================================================== */

    var CDNVideoHub = {
        id: 'cdnvideohub',
        title: 'CDNVideoHub',
        base: 'https://plapi.cdnvideohub.com/api/v1/player/sv/',

        fetch: function (ids, ok, err) {
            var self = this;
            // The API accepts aggr=kp (Kinopoisk) as well as aggr=imdb. Preferring
            // Kinopoisk but falling back to IMDb makes the source work on any
            // Lampa content source: movie.id is a TMDB id when the balancer is
            // TMDB, and querying it as kp returns nothing (a TMDB id is not a
            // Kinopoisk id). IMDb is available on the movie object regardless.
            var aggr = ids.kp ? 'kp' : (ids.imdb ? 'imdb' : '');
            var id = ids.kp || ids.imdb;
            if (!aggr) { err('no kp/imdb'); return; }
            getJSON(self.base + 'playlist?pub=12&aggr=' + aggr + '&id=' + encodeURIComponent(id), function (json) {
                if (!json || !json.items || !json.items.length) { err('empty'); return; }
                var tracks = json.items.map(function (d) {
                    var voice = d.voiceStudio || d.voiceType || '';
                    return {
                        voice: voice,
                        season: d.season != null ? d.season : null,
                        episode: d.episode != null ? d.episode : null,
                        title: d.season != null ? 'S' + d.season + 'E' + d.episode + (voice ? ' · ' + voice : '') : voice,
                        qualities: ['1080p', '720p', '480p', 'Auto'],
                        noPrepare: true, // VK CDN rejects server-side downloads
                        resolve: function (q, cb, e2) {
                            getJSON(self.base + 'video/' + d.vkId, function (r) {
                                var s = r && r.sources;
                                if (!s) { e2('no sources'); return; }
                                var order = q === '1080p' ? ['mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl', 'hlsUrl']
                                    : q === '720p' ? ['mpegHighUrl', 'mpegMediumUrl', 'mpegFullHdUrl', 'hlsUrl']
                                        : q === '480p' ? ['mpegMediumUrl', 'mpegHighUrl', 'hlsUrl']
                                            : ['hlsUrl', 'mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl'];
                                for (var i = 0; i < order.length; i++) if (s[order[i]]) { cb(s[order[i]]); return; }
                                e2('no url');
                            }, e2);
                        }
                    };
                });
                ok({ isSerial: !!json.isSerial, tracks: tracks });
            }, err);
        }
    };

    var Filmix = {
        id: 'filmix',
        title: 'Filmix',
        app: '/filmix/', // nginx proxy on the Lampa origin (sets app User-Agent + CORS)

        // Device id must stay stable across requests within one Lampa install —
        // regenerating it per-request made every search/post call look like a
        // brand new device to Filmix, which breaks any session/PRO+ binding
        // tied to user_dev_id.
        devId: function () {
            var id = Lampa.Storage.get('fastcdn_filmix_dev_id', '') + '';
            if (!id) {
                id = randomHex(16);
                Lampa.Storage.set('fastcdn_filmix_dev_id', id);
            }
            return id;
        },

        dev: function () {
            var token = Lampa.Storage.get('filmix_token', '') + '';
            return '?user_dev_id=' + this.devId() +
                '&user_dev_name=Xiaomi&user_dev_token=' + (token || 'aaaabbbbccccddddeeeeffffaaaabbbb') +
                '&user_dev_vendor=Xiaomi&user_dev_os=14&user_dev_apk=2.2.0&app_lang=ru-rRU';
        },

        isBlocked: function (file) {
            var link = (file && file.link ? file.link : '') + '';
            var tr = (file && (file.translation || file.translations) ? (file.translation || file.translations) : '') + '';
            return /abuse_/i.test(link) || /заблокирован/i.test(tr) || /заблокирован/i.test(link);
        },

        movieTracks: function (pl) {
            var out = [], self = this;
            var push = function (file, key) {
                if (!file || !file.link) return;
                if (self.isBlocked(file)) return;
                var qs = linkQualities(file.link);
                if (!qs.length && file.qualities) qs = file.qualities.filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return b - a; });
                var best = qs[0] || qualityOf(file.link) || 0;
                out.push({
                    voice: file.translation || (key ? 'Озвучка ' + key : 'Озвучка'),
                    season: null, episode: null,
                    title: file.translation || 'Озвучка',
                    qualities: qs.length ? qs.map(function (x) { return x + 'p'; }) : [best ? best + 'p' : 'auto'],
                    url: expandLink(file.link, best),
                    resolve: function (q, cb) { cb(expandLink(file.link, q)); }
                });
            };
            if (Array.isArray(pl)) pl.forEach(function (f) { push(f, null); });
            else if (pl && typeof pl === 'object') Object.keys(pl).forEach(function (k) { push(pl[k], k); });
            var best = {};
            out.forEach(function (e) { if (!best[e.voice]) best[e.voice] = e; });
            return Object.keys(best).map(function (k) { return best[k]; });
        },

        serialTracks: function (pl) {
            var out = [], self = this;
            Object.keys(pl).forEach(function (sid) {
                var season = pl[sid];
                Object.keys(season).forEach(function (vid) {
                    var eps = season[vid];
                    Object.keys(eps).forEach(function (eid) {
                        var file = eps[eid];
                        if (!file || !file.link) return;
                        if (self.isBlocked(file)) return;
                        var qs = linkQualities(file.link);
                        if (!qs.length) qs = (file.qualities || []).filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return b - a; });
                        var best = qs[0] || qualityOf(file.link) || 0;
                        out.push({
                            voice: (file.translation || ('Озвучка ' + vid)),
                            season: parseInt(sid), episode: parseInt(eid),
                            title: 'S' + sid + 'E' + eid + ' · ' + (file.translation || 'озвучка'),
                            qualities: qs.length ? qs.map(function (x) { return x + 'p'; }) : [best ? best + 'p' : 'auto'],
                            url: expandLink(file.link, best),
                            resolve: function (q, cb) { cb(expandLink(file.link, q)); }
                        });
                    });
                });
            });
            return out;
        },

        fetch: function (ids, ok, err) {
            var self = this;
            if (!ids.title) { err('no title'); return; }
            getJSON(self.app + 'search' + self.dev() + '&story=' + encodeURIComponent(ids.title), function (cards) {
                if (!cards || !cards.length) { err('no cards'); return; }
                var n = norm(ids.title), year = ids.year;
                var scored = cards.map(function (c) {
                    var s = 0;
                    if (norm(c.title) === n || norm(c.original_title) === n) s += 5;
                    else if (norm(c.title).indexOf(n) !== -1 || norm(c.original_title).indexOf(n) !== -1) s += 2;
                    if (year && c.year == year) s += 3;
                    return { c: c, s: s };
                }).sort(function (a, b) { return b.s - a.s; })[0];
                // A score of 0 means nothing actually matched title or year —
                // taking cards[0] anyway used to silently serve an unrelated
                // title instead of reporting "not found".
                if (!scored || scored.s <= 0) { err('no match'); return; }
                var pick = scored.c;
                getJSON(self.app + 'post/' + pick.id + self.dev(), function (data) {
                    var pl = (data && data.player_links) || {};
                    var tracks = (pl.playlist && Object.keys(pl.playlist).length)
                        ? self.serialTracks(pl.playlist)
                        : self.movieTracks(pl.movie);
                    if (!tracks.length) { err('empty'); return; }
                    ok({ isSerial: !!(pl.playlist && Object.keys(pl.playlist).length), tracks: tracks });
                }, err);
            }, err);
        }
    };

    var SOURCES = [CDNVideoHub, Filmix];
    var byId = {};
    SOURCES.forEach(function (s) { byId[s.id] = s; });

    /* ================================================================== *
     * UI template
     * ================================================================== */

    // Brand mark — circled play glyph. Shared by the movie-card button and the
    // track list; currentColor keeps it readable in both (both are white text).
    function logoSvg(size) {
        return '<svg style="height:' + size + ';width:' + size + '" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="64" cy="64" r="56" stroke="currentColor" stroke-width="16"/>' +
            '<path d="M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z" fill="currentColor"/></svg>';
    }

    Lampa.Template.add('fastcdn_item',
        '<div class="online selector">' +
        '<div class="online__body">' +
        '<div style="position:absolute;left:0;top:-0.3em;width:2.4em;height:2.4em">' +
        logoSvg('2.4em') + '</div>' +
        '<div class="online__title" style="padding-left:2.1em">{title}</div>' +
        '<div class="online__quality" style="padding-left:3.4em">{quality}{info}</div>' +
        '</div></div>');

    /* ================================================================== *
     * Component
     * ================================================================== */

    function Component(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = Lampa.Explorer ? new Lampa.Explorer(object) : new Lampa.Files(object);
        var filter = new Lampa.Filter(object);
        var last;
        var data = {};       // sourceId -> { isSerial, tracks, speed }
        var order = [];      // available sourceIds, fastest first
        var balanser = Lampa.Storage.get('fastcdn_balanser', '') + ''; // restore last choice; falls back to fastest if unavailable
        var choice = { voice: 0, season: 0, quality: 0 };
        var filter_state = {};

        this.activity = null;
        this.create = function () {
            var _this = this;
            this.activity.loader(true);

            filter.onSearch = function (value) {
                Lampa.Activity.replace({ search: value, search_date: '', clarification: true });
            };
            filter.onBack = function () { _this.start(); };
            filter.render().find('.selector').on('hover:focus', function (e) {
                last = e.target;
                scroll.update($(e.target), true);
            });
            filter.onSelect = function (type, a, b) {
                if (type === 'sort') {
                    balanser = a.source;
                    Lampa.Storage.set('fastcdn_balanser', balanser);
                    choice.voice = 0; choice.season = 0; choice.quality = 0;
                    // Sources are already fetched once in this.search(); switching
                    // the balanser only needs to rebuild the list from cached
                    // `data`, not hit the network again for every source.
                    _this.buildList(order);
                    setTimeout(Lampa.Select.close, 10);
                } else if (type === 'filter') {
                    if (a.reset) { choice.voice = 0; choice.season = 0; choice.quality = 0; }
                    else if (a.stype === 'voice') choice.voice = b.index;
                    else if (a.stype === 'season') choice.season = b.index;
                    else if (a.stype === 'quality') choice.quality = b.index;
                    _this.applyFilter();
                }
            };
            filter.render().find('.filter--sort span').text('Балансер');
            filter.render().find('.filter--filter span').text('Озвучка / Качество');
            filter.render();
            if (typeof files.appendHead === 'function' && typeof files.appendFiles === 'function') {
                // Explorer layout: filter into the header, track list into the
                // files body, sized below the header so it scrolls.
                scroll.minus(files.render().find('.explorer__files-head'));
                files.appendHead(filter.render());
                files.appendFiles(scroll.render());
            } else {
                files.append(scroll.render());
                scroll.append(filter.render());
            }
            this.search();
            return this.render();
        };

        this.search = function () {
            var _this = this;
            this.activity.loader(true);
            var pending = SOURCES.length, results = {};
            SOURCES.forEach(function (src) {
                var started = Date.now();
                src.fetch(idsOf(object.movie), function (res) {
                    res = res || {};
                    res.speed = Date.now() - started;
                    results[src.id] = res;
                    if (--pending === 0) _this.ready(results);
                }, function () {
                    if (--pending === 0) _this.ready(results);
                });
            });
        };

        this.ready = function (results) {
            data = results;
            order = SOURCES.map(function (s) { return s.id; })
                .filter(function (id) { return data[id] && data[id].tracks && data[id].tracks.length; })
                .sort(function (a, b) { return (data[a].speed || 0) - (data[b].speed || 0); });
            if (!order.length) { this.empty('FastCDN: ничего не найдено'); return; }
            if (order.indexOf(balanser) === -1) balanser = order[0];
            log('sources available (fastest first):', order.map(function (id) { return id + ' ' + (data[id].speed || 0) + 'ms'; }).join(', '));
            this.buildList(order);
        };

        this.buildList = function (keys) {
            var tracks = (data[balanser] || {}).tracks || [];
            var voices = unique(tracks.map(function (t) { return t.voice; }));
            var seasons = unique(tracks.filter(function (t) { return t.season != null; }).map(function (t) { return t.season; }));
            var qualities = unique(flatten(tracks.map(function (t) { return t.qualities; })));

            if (choice.voice >= voices.length) choice.voice = 0;
            if (choice.season >= seasons.length) choice.season = 0;
            if (choice.quality >= qualities.length) choice.quality = 0;

            var select = [{ title: Lampa.Lang.translate('torrent_parser_reset') || 'Сброс', reset: true }];
            if (voices.length) select.push(group('voice', 'Озвучка', voices, choice.voice));
            if (seasons.length) select.push(group('season', 'Сезон', seasons.map(function (s) { return 'Сезон ' + s; }), choice.season));
            if (qualities.length) select.push(group('quality', 'Качество', qualities, choice.quality));
            filter.set('filter', select);
            filter.set('sort', keys.map(function (id) {
                var ms = (data[id] && data[id].speed) ? ' · ' + data[id].speed + ' мс' : '';
                return { title: byId[id].title + ms, source: id, selected: id === balanser };
            }));
            filter.chosen('sort', [byId[balanser].title]);
            filter.chosen('filter', chosenText(voices, seasons, qualities));

            this.appendList(tracks, voices, seasons, qualities);
            this.activity.loader(false);
            Lampa.Controller.toggle('content');
        };

        this.applyFilter = function () { this.buildList(order); };

        this.appendList = function (tracks, voices, seasons, qualities) {
            scroll.body().find('.online').remove();
            var _this = this;
            var list = tracks.filter(function (t) {
                if (voices.length && t.voice !== voices[choice.voice]) return false;
                if (seasons.length && t.season != null && t.season !== seasons[choice.season]) return false;
                return true;
            });
            if (!list.length) { this.empty('FastCDN: пусто'); return; }
            list.forEach(function (t) {
                var item = Lampa.Template.get('fastcdn_item', {
                    title: t.title,
                    quality: (qualities[choice.quality] || (t.qualities[0] || 'auto')),
                    info: ' / ' + byId[balanser].title
                });
                item.on('hover:enter', function () {
                    if (!relayBase() || t.noPrepare) { _this.play(t, qualities); return; }
                    Lampa.Select.show({
                        title: 'FastCDN',
                        items: [
                            { title: '▶ Смотреть', action: 'play' },
                            { title: '⬇ Подготовить на сервере (без рекламы)', action: 'prep' }
                        ],
                        onSelect: function (a) {
                            Lampa.Controller.toggle('content');
                            if (a.action === 'prep') _this.prepare(t, qualities);
                            else _this.play(t, qualities);
                        },
                        onBack: function () { Lampa.Controller.toggle('content'); }
                    });
                });
                item.on('hover:focus', function (e) { last = e.target; scroll.update($(e.target), true); });
                _this.append(item);
            });

        };

        this.append = function (item) { scroll.append(item); };

        this.play = function (t, qualities) {
            var q = qualities[choice.quality] || t.qualities[0] || 'Auto';
            Lampa.Noty.show('FastCDN: получение потока...');
            var done = function (url) {
                url = relayUrl(url, t.headers);
                log('play url', url);
                Lampa.Player.play({ title: t.title, url: url });
                Lampa.Player.playlist([{ title: t.title, url: url }]);
            };
            if (t.resolve) { t.resolve(q, done, function () { Lampa.Noty.show('FastCDN: поток не получен'); }); return; }
            if (t.url) { done(t.url); return; }
        };

        this.prepare = function (t, qualities) {
            var base = relayBase();
            if (!base || t.noPrepare) { this.play(t, qualities); return; }
            var q = qualities[choice.quality] || t.qualities[0] || 'Auto';
            var name = (t.title || 'video').replace(/[^A-Za-z0-9\u0400-\u04FF\-. ]+/g, '_').slice(0, 100);
            var profile = Lampa.Storage.get('fastcdn_prepare_profile', 'copy') + '';
            Lampa.Noty.show('FastCDN: подготовка на сервере...');
            var start = function (url) {
                if (isVkUrl(url)) {
                    Lampa.Noty.show('FastCDN: VK-поток нельзя скачать — смотрите через релей');
                    return;
                }
                if (/%[sd]/i.test(url)) {
                    // CDN segment template (e.g. s01e06_%s.mp4) — not a real file,
                    // the downloader would get 400 and leave nothing to play.
                    Lampa.Noty.show('FastCDN: ссылка-шаблон (%s) — подготовка невозможна');
                    return;
                }
                var h = t.headers ? b64url(JSON.stringify(t.headers)) : '';
                var path = base + '/dl?u=' + b64url(url) + '&h=' + h +
                    '&profile=' + encodeURIComponent(profile) + '&name=' + encodeURIComponent(name);
                if (relayToken()) path += '&token=' + encodeURIComponent(relayToken());
                relayFetch(path, { method: 'POST' }).then(function (job) {
                    if (!job || !job.id) { Lampa.Noty.show('FastCDN: не удалось запустить'); return; }
                    var tries = 0;
                    var poll = function () {
                        tries++;
                        relayFetch(base + '/dl/' + job.id).then(function (s) {
                            if (s && s.status === 'done' && s.file) {
                                Lampa.Noty.show('FastCDN: готово');
                                var abs = /^https?:/i.test(s.file) ? s.file : (location.origin + s.file);
                                var toMpv = function () {
                                    // `abs` can already carry its own query string (e.g. a relay
                                    // token), so blindly appending "?title=" produced an invalid
                                    // URL with two "?" once url-decoded on the MPV bridge side.
                                    var sep = abs.indexOf('?') === -1 ? '?' : '&';
                                    var payload = abs + sep + 'title=' + (t.title || '');
                                    var a = document.createElement('a');
                                    a.href = 'mpv://' + encodeURIComponent(payload);
                                    a.target = '_top';
                                    document.body.appendChild(a);
                                    a.click();
                                    a.remove();
                                };
                                var playHere = function () {
                                    Lampa.Player.play({ title: t.title, url: abs });
                                    Lampa.Player.playlist([{ title: t.title, url: abs }]);
                                };
                                if (Lampa.Storage.get('fastcdn_mpv', true) === false) {
                                    playHere();
                                } else if (Lampa.Storage.get('fastcdn_mpv_auto', true) !== false) {
                                    // pipeline: server finished preparing -> hand straight to MPV
                                    toMpv();
                                } else {
                                    Lampa.Select.show({
                                        title: 'FastCDN: воспроизведение',
                                        items: [
                                            { title: '▶ Открыть в MPV (bridge)' },
                                            { title: 'Смотреть здесь' }
                                        ],
                                        onSelect: function (a) {
                                            Lampa.Controller.toggle('content');
                                            if (/MPV/i.test(a.title)) toMpv();
                                            else playHere();
                                        },
                                        onBack: function () { Lampa.Controller.toggle('content'); }
                                    });
                                }
                            } else if (s && s.status === 'error') {
                                log('prepare error', s.error);
                                Lampa.Noty.show('FastCDN: ' + String(s.error || 'ошибка подготовки').slice(0, 90));
                            } else if (tries < 600) {
                                setTimeout(poll, 3000);
                            }
                        }).catch(function () { if (tries < 600) setTimeout(poll, 3000); });
                    };
                    poll();
                }).catch(function (e) { log('prepare start fail', e); Lampa.Noty.show('FastCDN: сервер недоступен'); });
            };
            if (t.resolve) { t.resolve(q, start, function () { Lampa.Noty.show('FastCDN: поток не получен'); }); return; }
            if (t.url) { start(t.url); return; }
        };

        this.loading = function (status) { this.activity.loader(status); };
        this.empty = function (text) {
            this.activity.loader(false);
            scroll.body().find('.online').remove();
            var box = $('<div class="online selector"><div class="online__body"><div class="online__title">' + text + '</div></div></div>');
            scroll.append(box);

        };
        this.reset = function () {};
        this.saveChoice = function () {};
        this.pause = function () {};
        this.stop = function () {};
        this.render = function () { return files.render(); };
        this.destroy = function () { scroll.destroy(); files.destroy(); };
        this.back = function () { Lampa.Activity.backward(); };

        this.start = function () {
            var _this = this;
            if (Lampa.Activity.active().activity !== this.activity) return;
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { Navigator.move('down'); },
                right: function () {
                    if (Navigator.canmove('right')) Navigator.move('right');
                    else filter.show('Фильтр', 'filter');
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                back: this.back.bind(this)
            });
            Lampa.Controller.toggle('content');
        };

        /* helpers */
        function unique(arr) { var o = []; arr.forEach(function (v) { if (v != null && o.indexOf(v) === -1) o.push(v); }); return o; }
        function flatten(a) { var o = []; a.forEach(function (x) { (x || []).forEach(function (v) { if (o.indexOf(v) === -1) o.push(v); }); }); return o; }
        function group(stype, title, items, selIndex) {
            return {
                title: title, stype: stype, subtitle: items[selIndex],
                items: items.map(function (t, i) { return { title: t, selected: i === selIndex, index: i }; })
            };
        }
        function chosenText(voices, seasons, qualities) {
            var out = [];
            if (voices.length) out.push('Озвучка: ' + voices[choice.voice]);
            if (seasons.length) out.push('Сезон: ' + seasons[choice.season]);
            if (qualities.length) out.push('Качество: ' + qualities[choice.quality]);
            return out;
        }
    }

    function idsOf(movie) {
        var src = (Lampa.Storage.get('source') || '') + '';
        var kp = movie.kinopoisk_id || movie.kp_id || movie.kinopoiskId || null;
        // Only trust movie.id as a Kinopoisk id on sources that are actually
        // Kinopoisk-based. The old "5+ digits" guess was unsafe: TMDB ids are
        // just as often 5 digits (e.g. "Inception" = tmdb id 27205) and would
        // silently query CDNVideoHub for a completely different title.
        if (!kp && /^(cub|kp|kinopoisk)$/i.test(src)) kp = movie.id;
        var date = movie.release_date || movie.first_air_date || movie.last_air_date || '';
        return {
            kp: kp,
            imdb: movie.imdb_id || movie.imdb || null,
            title: movie.title || movie.name || '',
            original: movie.original_title || movie.original_name || '',
            year: parseInt((date + '').slice(0, 4)) || movie.year || null
        };
    }

    /* ================================================================== *
     * Registration: own component + button on the movie card
     * ================================================================== */

    Lampa.Component.add('fastcdn', Component);

    function loadOnline(movie) {
        Lampa.Activity.push({
            url: '',
            title: 'FastCDN',
            component: 'fastcdn',
            search: movie.title || movie.name,
            search_one: movie.title || movie.name,
            movie: movie,
            page: 1
        });
    }

    function addButton() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;
            var btn = $('<div class="full-start__button selector view--fastcdn">' + logoSvg('1.7em') + '<span>Fast CDN</span></div>');
            btn.on('hover:enter', function () { loadOnline(e.data.movie); });
            var host = e.object.activity.render().find('.view--online_mod');
            if (!host.length) host = e.object.activity.render().find('.view--torrent');
            if (host.length) host.after(btn);
            else e.object.activity.render().find('.full-start__buttons').append(btn);
        });
    }

    if (window.appready) addButton();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') addButton(); });

    /* ================================================================== *
     * Self-update
     * ================================================================== */

    // Lampa re-fetches every plugin on each app start, so a released version is
    // picked up on the next launch. This additionally updates a *running*
    // session: we read the canonical @master URL back (cache-busted) and reload
    // once when it is newer. The release flow purges jsDelivr's @master cache,
    // so the reload really gets the new file. The install URL stays @master
    // forever — no reinstall and no per-version URL changes for the user.
    var UPDATE_URL = 'https://cdn.jsdelivr.net/gh/tolipoff-git/lampa-fastcdn@latest/fastcdn.js';

    function checkUpdate() {
        if (typeof fetch !== 'function') return;
        fetch(UPDATE_URL + '?ts=' + Date.now(), { cache: 'no-store' }).then(function (r) {
            return r.ok ? r.text() : '';
        }).then(function (code) {
            var m = (code || '').match(/VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/);
            if (!m || m[1] === VERSION) return;

            var seen = false;
            try { seen = !!sessionStorage.getItem('fastcdn_upd_' + m[1]); } catch (e) {}

            if (seen) return;

            log('update available:', m[1], '(running', VERSION + ')');

            // Never yank the page out from under playback; next app start updates it.
            if (Lampa.Player && Lampa.Player.opened && Lampa.Player.opened()) {
                log('player is open — will update on next start');
                return;
            }

            try { sessionStorage.setItem('fastcdn_upd_' + m[1], '1'); } catch (e) {}
            Lampa.Noty.show('FastCDN: обновление v' + m[1] + ' — перезагрузка...');
            setTimeout(function () { location.reload(); }, 2500);
        }).catch(function () {});
    }

    log('v' + VERSION + ' loaded; sources:', SOURCES.map(function (s) { return s.id; }).join(','));
    setTimeout(checkUpdate, 5000);
})();
