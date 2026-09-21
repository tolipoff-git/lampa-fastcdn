/**
 * FastCDN — standalone online-source plugin for Lampa.
 *
 * Adds its own source button on the movie card and resolves streams directly
 * from fast public CDNs (no proxy).
 *
 * Sources:
 *   - CDNVideoHub  (playlist -> video/<vkId> -> VK CDN)
 *   - Filmix       (search -> post/<id> -> player_links; PRO+ token supported)
 *
 * @version 0.2.0
 */
(function () {
    'use strict';

    var VERSION = '0.2.0';
    var LOG = '[FastCDN] ';

    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift(LOG);
        console.log.apply(console, a);
    }

    function ready(fn) {
        if (window.appready) { fn(); return; }
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') fn();
        });
    }

    function norm(s) {
        return (s || '').toString().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
    }

    function randomHex(n) {
        var s = '';
        var h = '0123456789abcdef';
        for (var i = 0; i < n; i++) s += h[Math.floor(Math.random() * 16)];
        return s;
    }

    function qualityOf(url) {
        if (!url) return 0;
        var m = url.match(/\[[,\d]*?(\d{3,4})[,\d]*?\]/) || url.match(/(\d{3,4})p/) || url.match(/\/(\d{3,4})\b/);
        return m ? parseInt(m[1]) : 0;
    }

    function getJSON(url, ok, err, headers) {
        var net = new Lampa.Reguest();
        net.timeout(15000);
        net.native(url, function (json) { ok(json); }, function (a, c) {
            log('request failed', url, a && a.status);
            if (err) err(a, c);
        }, false, headers ? { dataType: 'json', headers: headers } : { dataType: 'json' });
    }

    /* ------------------------------------------------------------------ *
     * Source: CDNVideoHub (VK CDN backend)
     * ------------------------------------------------------------------ */

    var CDNVideoHub = {
        id: 'cdnvideohub',
        title: 'CDNVideoHub',
        base: 'https://plapi.cdnvideohub.com/api/v1/player/sv/',

        list: function (ids, ok, err) {
            if (!ids.kp) { err('no kp id'); return; }
            getJSON(this.base + 'playlist?pub=12&aggr=kp&id=' + encodeURIComponent(ids.kp), function (json) {
                if (!json || !json.items || !json.items.length) { err('empty'); return; }
                var items = json.items.slice().sort(function (a, b) {
                    var c = (a.season || 0) - (b.season || 0);
                    if (c) return c;
                    c = (a.episode || 0) - (b.episode || 0);
                    if (c) return c;
                    var va = a.voiceStudio || a.voiceType || '', vb = b.voiceStudio || b.voiceType || '';
                    return va < vb ? -1 : va > vb ? 1 : 0;
                });
                ok({
                    entries: items.map(function (d) {
                        var voice = d.voiceStudio || d.voiceType || '';
                        return {
                            title: d.season != null ? 'S' + d.season + 'E' + d.episode + ' · ' + voice : voice,
                            info: 'CDNVideoHub',
                            quality: '360p ~ 1080p',
                            media: d
                        };
                    })
                });
            }, err);
        },

        resolve: function (entry, quality, ok, err) {
            var vkId = entry.media && entry.media.vkId;
            if (!vkId) { err('no id'); return; }
            getJSON(this.base + 'video/' + vkId, function (json) {
                var s = json && json.sources;
                if (!s) { err('no sources'); return; }
                var order = quality === '1080p' ? ['mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl', 'hlsUrl']
                    : quality === '720p' ? ['mpegHighUrl', 'mpegMediumUrl', 'mpegFullHdUrl', 'hlsUrl']
                        : quality === '480p' ? ['mpegMediumUrl', 'mpegHighUrl', 'hlsUrl']
                            : ['hlsUrl', 'mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl'];
                var url = null;
                for (var i = 0; i < order.length; i++) if (s[order[i]]) { url = s[order[i]]; break; }
                url ? ok(url) : err('no url');
            }, err);
        }
    };

    /* ------------------------------------------------------------------ *
     * Source: Filmix (filmixapp.cyou). PRO+ token from Storage 'filmix_token'.
     * ------------------------------------------------------------------ */

    var Filmix = {
        id: 'filmix',
        title: 'Filmix',
        // relative: resolved against the Lampa origin, where our nginx proxy sets the
        // app User-Agent Filmix requires (browsers cannot set User-Agent themselves).
        app: '/filmix/',

        dev: function () {
            var token = Lampa.Storage.get('filmix_token', '') + '';
            return '?user_dev_id=' + randomHex(16) +
                '&user_dev_name=Xiaomi&user_dev_token=' + (token || 'aaaabbbbccccddddeeeeffffaaaabbbb') +
                '&user_dev_vendor=Xiaomi&user_dev_os=14&user_dev_apk=2.2.0&app_lang=ru-rRU';
        },

        // normalize player_links.movie (array or object) into [{link, translation, quality}]
        movieEntries: function (pl) {
            var out = [];
            var push = function (file, key) {
                if (!file || !file.link) return;
                var q = qualityOf(file.link) || (file.qualities && Math.max.apply(null, file.qualities.filter(function (x) { return !isNaN(x); })));
                out.push({ link: file.link, translation: file.translation || (key ? 'Озвучка ' + key : 'Озвучка'), quality: q || 0 });
            };
            if (Array.isArray(pl)) pl.forEach(function (f) { push(f, null); });
            else if (pl && typeof pl === 'object') Object.keys(pl).forEach(function (k) { push(pl[k], k); });
            // keep the best quality per translation
            var best = {};
            out.forEach(function (e) {
                var k = e.translation;
                if (!best[k] || e.quality > best[k].quality) best[k] = e;
            });
            return Object.keys(best).map(function (k) { return best[k]; });
        },

        serialEntries: function (pl) {
            var out = [];
            Object.keys(pl).forEach(function (sid) {
                var season = pl[sid];
                Object.keys(season).forEach(function (vid) {
                    var eps = season[vid];
                    Object.keys(eps).forEach(function (eid) {
                        var file = eps[eid];
                        if (!file || !file.link) return;
                        var qs = (file.qualities || []).filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return b - a; });
                        out.push({
                            title: 'S' + sid + 'E' + eid,
                            info: 'Filmix',
                            quality: qs[0] ? qs[0] + 'p' : 'auto',
                            url: file.link
                        });
                    });
                });
            });
            return out;
        },

        list: function (ids, ok, err) {
            var self = this;
            var title = ids.title;
            if (!title) { err('no title'); return; }
            var url = self.app + 'search' + self.dev() + '&story=' + encodeURIComponent(title);
            getJSON(url, function (cards) {
                if (!cards || !cards.length) { err('no cards'); return; }
                var n = norm(title);
                var year = ids.year;
                var scored = cards.map(function (c) {
                    var s = 0;
                    if (norm(c.title) === n || norm(c.original_title) === n) s += 5;
                    else if (norm(c.title).indexOf(n) !== -1 || norm(c.original_title).indexOf(n) !== -1) s += 2;
                    if (year && c.year == year) s += 3;
                    return { c: c, s: s };
                }).sort(function (a, b) { return b.s - a.s; });
                var pick = scored[0].c;
                log('filmix pick', pick.id, pick.title, pick.year);
                var post = self.app + 'post/' + pick.id + self.dev();
                getJSON(post, function (data) {
                    var pl = (data && data.player_links) || {};
                    var entries = [];
                    if (pl.playlist && Object.keys(pl.playlist).length) {
                        entries = self.serialEntries(pl.playlist);
                    } else {
                        entries = self.movieEntries(pl.movie).map(function (e) {
                            return {
                                title: e.translation,
                                info: 'Filmix',
                                quality: e.quality ? e.quality + 'p' : 'auto',
                                url: e.link
                            };
                        });
                    }
                    if (!entries.length) { err('empty'); return; }
                    ok({ entries: entries });
                }, err);
            }, err);
        }
    };

    var SOURCES = [CDNVideoHub, Filmix];

    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    function playEntry(source, entry, back) {
        var play = function (url) {
            Lampa.Select.close();
            log('play', url);
            Lampa.Player.play({ title: entry.title, url: url });
            Lampa.Player.playlist([{ title: entry.title, url: url }]);
        };
        if (entry.url) { play(entry.url); return; }
        var items = ['1080p', '720p', '480p', 'Auto'].map(function (q) {
            return { title: q, onSelect: function () {
                Lampa.Noty.show('FastCDN: получение потока...');
                source.resolve(entry, q, play, function () {
                    Lampa.Noty.show('FastCDN: поток не получен');
                });
            } };
        });
        Lampa.Select.show({ title: 'FastCDN · ' + entry.title, items: items, onBack: back || function () { Lampa.Controller.toggle('content'); } });
    }

    function showEntries(results, back) {
        var items = [];
        results.forEach(function (r) {
            r.entries.forEach(function (entry) {
                items.push({
                    title: entry.title,
                    subtitle: entry.quality + ' · ' + entry.info,
                    onSelect: function () { playEntry(r.source, entry, back); }
                });
            });
        });
        if (!items.length) { Lampa.Noty.show('FastCDN: ничего не найдено'); return; }
        Lampa.Select.show({ title: 'FastCDN', items: items, onBack: back || function () { Lampa.Controller.toggle('content'); } });
    }

    function idsOf(movie) {
        var src = Lampa.Storage.get('source') || '';
        var kp = movie.kinopoisk_id || movie.kp_id || movie.kinopoiskId || null;
        if (!kp && src === 'cub') kp = movie.id;
        if (!kp && movie.id && String(movie.id).length >= 5) kp = movie.id;
        var date = movie.release_date || movie.first_air_date || movie.last_air_date || '';
        return {
            kp: kp,
            imdb: movie.imdb_id || movie.imdb || null,
            title: movie.title || movie.name || '',
            original: movie.original_title || movie.original_name || '',
            year: parseInt((date + '').slice(0, 4)) || movie.year || null
        };
    }

    function load(movie) {
        var ids = idsOf(movie);
        log('ids', ids);
        var back = function () { Lampa.Controller.toggle('content'); };
        Lampa.Noty.show('FastCDN: поиск...');
        var pending = SOURCES.length;
        var results = [];
        SOURCES.forEach(function (source) {
            source.list(ids, function (res) {
                if (res && res.entries && res.entries.length) results.push({ source: source, entries: res.entries });
                if (--pending === 0) showEntries(results, back);
            }, function (e) {
                log('source failed', source.id, e);
                if (--pending === 0) showEntries(results, back);
            });
        });
    }

    function addButton(e) {
        var movie = e.data && e.data.movie;
        if (!movie) return;
        var btn = $('<div class="full-start__button selector view--fastcdn"><span>Fast CDN</span></div>');
        btn.on('hover:enter', function () { load(movie); });
        var host = e.object.activity.render().find('.view--online_mod');
        if (!host.length) host = e.object.activity.render().find('.view--torrent');
        if (host.length) host.after(btn);
        else e.object.activity.render().find('.full-start__buttons').append(btn);
    }

    ready(function () {
        log('v' + VERSION + ' ready; sources:', SOURCES.map(function (s) { return s.id; }).join(','));
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') addButton(e);
        });
    });
})();