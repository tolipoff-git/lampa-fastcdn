/**
 * FastCDN — standalone online-source plugin for Lampa.
 *
 * Adds its own source button on the movie card and resolves streams directly
 * from fast public CDNs (no proxy). First source: CDNVideoHub (VK CDN backend).
 *
 * The CDNVideoHub flow:
 *   1. GET playlist?pub=12&aggr=kp&id=<kinopoisk_id>   -> voices / episodes
 *   2. GET video/<vkId>                                -> { sources: {mpeg*Url, hlsUrl} }
 *
 * @version 0.1.0
 */
(function () {
    'use strict';

    var VERSION = '0.1.0';
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

    var net = new Lampa.Reguest();

    function getJSON(url, ok, err) {
        net.clear();
        net.timeout(15000);
        net.native(url, function (json) {
            ok(json);
        }, function (a, c) {
            log('request failed', url, a && a.status);
            if (err) err(a, c);
        }, false, { dataType: 'json' });
    }

    /* ------------------------------------------------------------------ *
     * Source registry. Each source implements:
     *   id, title
     *   list(ids, ok)   -> ok([{ title, info, quality, play }])
     * where play(quality, ok) resolves a stream url.
     * ------------------------------------------------------------------ */

    var CDNVideoHub = {
        id: 'cdnvideohub',
        title: 'CDNVideoHub',
        base: 'https://plapi.cdnvideohub.com/api/v1/player/sv/',

        list: function (ids, ok, err) {
            var id = ids.kp;
            if (!id) { err('no kinopoisk id'); return; }
            var url = this.base + 'playlist?pub=12&aggr=kp&id=' + encodeURIComponent(id);
            getJSON(url, function (json) {
                if (!json || !json.items || !json.items.length) { err('empty'); return; }
                var items = json.items;
                items.sort(function (a, b) {
                    var c = (a.season || 0) - (b.season || 0);
                    if (c) return c;
                    c = (a.episode || 0) - (b.episode || 0);
                    if (c) return c;
                    var va = a.voiceStudio || a.voiceType || '';
                    var vb = b.voiceStudio || b.voiceType || '';
                    return va < vb ? -1 : va > vb ? 1 : 0;
                });
                ok({
                    title: json.titleName || '',
                    isSerial: !!json.isSerial,
                    entries: items.map(function (d) {
                        var voice = d.voiceStudio || d.voiceType || '';
                        var label = voice;
                        if (d.season != null) label = 'S' + d.season + 'E' + d.episode + ' · ' + voice;
                        return {
                            title: label,
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
                if (!json || !json.sources) { err('no sources'); return; }
                var s = json.sources;
                var order = quality === '1080p'
                    ? ['mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl', 'hlsUrl']
                    : quality === '720p'
                        ? ['mpegHighUrl', 'mpegMediumUrl', 'mpegFullHdUrl', 'hlsUrl']
                        : quality === '480p'
                            ? ['mpegMediumUrl', 'mpegHighUrl', 'hlsUrl']
                            : ['hlsUrl', 'mpegFullHdUrl', 'mpegHighUrl', 'mpegMediumUrl'];
                var url = null;
                for (var i = 0; i < order.length; i++) {
                    if (s[order[i]]) { url = s[order[i]]; break; }
                }
                if (!url) { err('no url'); return; }
                ok(url);
            }, err);
        }
    };

    var SOURCES = [CDNVideoHub];

    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    function pickQuality(entry, cb, back) {
        var items = ['1080p', '720p', '480p', 'Auto'].map(function (q) {
            return {
                title: q,
                onSelect: function () { cb(q); }
            };
        });
        Lampa.Select.show({
            title: 'FastCDN · ' + entry.title,
            items: items,
            onBack: back || function () { Lampa.Controller.toggle('content'); }
        });
    }

    function playEntry(source, entry, back) {
        pickQuality(entry, function (quality) {
            Lampa.Noty.show('FastCDN: получение потока...');
            source.resolve(entry, quality, function (url) {
                Lampa.Select.close();
                log('play', url);
                Lampa.Player.play({ title: entry.title, url: url });
                Lampa.Player.playlist([{ title: entry.title, url: url }]);
            }, function () {
                Lampa.Noty.show('FastCDN: поток не получен');
            });
        }, back);
    }

    function showEntries(results, back) {
        var items = [];
        results.forEach(function (r) {
            r.entries.forEach(function (entry) {
                items.push({
                    title: entry.title,
                    subtitle: entry.quality + ' · ' + r.source.title,
                    onSelect: function () { playEntry(r.source, entry, back); }
                });
            });
        });
        if (!items.length) {
            Lampa.Noty.show('FastCDN: ничего не найдено');
            return;
        }
        Lampa.Select.show({
            title: 'FastCDN',
            items: items,
            onBack: back || function () { Lampa.Controller.toggle('content'); }
        });
    }

    function idsOf(movie) {
        var src = Lampa.Storage.get('source') || '';
        var kp = movie.kinopoisk_id || movie.kp_id || movie.kinopoiskId || null;
        if (!kp && src === 'cub') kp = movie.id;
        if (!kp && movie.id && String(movie.id).length >= 5) kp = movie.id;
        return { kp: kp, imdb: movie.imdb_id || movie.imdb || null };
    }

    function load(movie) {
        var ids = idsOf(movie);
        log('ids', ids, 'title', movie.title);
        if (!ids.kp) { Lampa.Noty.show('FastCDN: нет Kinopoisk ID'); return; }

        var back = function () { Lampa.Controller.toggle('content'); };
        Lampa.Noty.show('FastCDN: поиск...');
        var pending = SOURCES.length;
        var results = [];
        SOURCES.forEach(function (source) {
            source.list(ids, function (res) {
                if (res && res.entries && res.entries.length) {
                    results.push({ source: source, entries: res.entries });
                }
                if (--pending === 0) showEntries(results, back);
            }, function () {
                if (--pending === 0) showEntries(results, back);
            });
        });
    }

    function addButton(e) {
        var movie = e.data && e.data.movie;
        if (!movie) return;
        var btn = $('<div class="full-start__button selector view--fastcdn">' +
            '<span>Fast CDN</span></div>');
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