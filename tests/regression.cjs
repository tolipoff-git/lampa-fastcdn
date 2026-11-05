'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '..', 'fastcdn.js'), 'utf8');
assert.ok(code.endsWith('})();\n'), 'unexpected plugin wrapper');
const exposed = code.replace(/\}\)\(\);\s*$/, 'globalThis.__fastcdnTest = { selectTrackQuality, expandLink, hasQualityPlaceholder, preparedFileUrl, compareVersion, fetchSource, Filmix, Component, SOURCES };})();');
const storage = { fastcdn_relay: 'http://relay.example:8080/hls' };
let response = [];
const Lampa = {
  Storage: { get: (k, d) => Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : d, set: (k, v) => { storage[k] = v; } },
  Template: { add() {} },
  Scroll: function () {},
  Explorer: function () {},
  Filter: function () {},
  Component: { add() {} },
  Listener: { follow() {} },
  Reguest: function () {
    this.timeout = () => {};
    this.native = (url, ok) => ok(url.includes('/search?') ? response : { player_links: { movie: [] } });
  }
};
const sandbox = { Lampa, console: { log() {} }, window: { appready: false }, document: { title: '', querySelector: () => null }, setTimeout() {}, URL, Date, btoa, unescape, encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(exposed, sandbox);
const h = sandbox.__fastcdnTest;
assert.equal(h.selectTrackQuality({ qualities: ['720p'] }, ['1080p', '720p'], 0), '720p');
assert.equal(h.selectTrackQuality({ qualities: ['Auto'] }, ['1080p', 'Auto'], 1), 'Auto');
assert.equal(h.expandLink('https://cdn.example/s01_%s.mp4', 'Auto'), 'https://cdn.example/s01_%s.mp4');
assert.equal(h.expandLink('https://cdn.example/s01_%s.mp4', '720p'), 'https://cdn.example/s01_720.mp4');
assert.equal(h.expandLink('https://cdn.example/1080p_[,,1080,720,].mp4', '720p'), 'https://cdn.example/1080p_720.mp4');
assert.equal(h.hasQualityPlaceholder('https://cdn.example/%D0%B8%D0%B2%D0%B0%D0%BD.m3u8'), false);
assert.equal(h.hasQualityPlaceholder('https://cdn.example/%D1%82%D0%B5%D1%81%D1%82.m3u8'), false);
assert.equal(h.hasQualityPlaceholder('https://cdn.example/episode_%s.mp4'), true);
assert.equal(h.hasQualityPlaceholder('https://cdn.example/episode_%d.mp4'), true);
assert.equal(h.expandLink('https://cdn.example/%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE_720.mp4', '720p'), 'https://cdn.example/%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE_720.mp4');
assert.equal(h.expandLink('https://cdn.example/episode_%d.mp4', '480p'), 'https://cdn.example/episode_480.mp4');
assert.equal(h.preparedFileUrl('/hls/media/test.mkv'), 'http://relay.example:8080/hls/media/test.mkv');
assert.equal(h.preparedFileUrl('media/test.mkv'), 'http://relay.example:8080/hls/media/test.mkv');
assert.equal(h.preparedFileUrl('/hls/media/тест видео.mkv'), 'http://relay.example:8080/hls/media/%D1%82%D0%B5%D1%81%D1%82%20%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE.mkv');
assert.throws(() => h.preparedFileUrl('javascript:alert(1)'));
assert.equal(h.compareVersion('0.8.18', '0.8.17'), 1);
assert.equal(h.compareVersion('0.8.17', '0.8.18'), -1);
assert.equal(h.compareVersion('0.8.18', '0.8.18'), 0);
response = [{ id: 1, title: 'Wrong movie', year: 2024 }];
let rejected = false;
h.Filmix.fetch({ title: 'Right movie', year: 2024 }, () => assert.fail('year alone must not match'), () => { rejected = true; });
assert.equal(rejected, true);
let requests = 0;
const mockSource = {
  id: 'cache-test',
  fetch: (ids, ok) => {
    requests++;
    ok({ isSerial: false, tracks: [{ voice: 'test' }] });
  }
};
let cachedA, cachedB;
h.fetchSource(mockSource, { kp: '10', imdb: null, title: 'Test', year: 2024 }, r => { cachedA = r; }, assert.fail);
h.fetchSource(mockSource, { kp: '10', imdb: null, title: 'Test', year: 2024 }, r => { cachedB = r; }, assert.fail);
assert.equal(requests, 1, 'repeat source lookup should be cached');
assert.equal(cachedA, cachedB);
storage.fastcdn_cache_seconds = 0;
h.fetchSource(mockSource, { kp: '10', imdb: null, title: 'Test', year: 2024 }, () => {}, assert.fail);
assert.equal(requests, 2, 'cache must be disableable');
// Progressive source rendering: the first successful provider must not wait
// for the second; stale callbacks must not overwrite a newer search.
storage.fastcdn_cache_seconds = 0;
const originalFetches = h.SOURCES.map(src => src.fetch);
const callbacks = [];
h.SOURCES.forEach((src, i) => {
  src.fetch = (_ids, ok, err) => { callbacks.push({ i, ok, err }); };
});
const component = new h.Component({ movie: { title: 'Test', year: 2024 } });
const renderEvents = [];
let emptyCount = 0;
component.activity = { loader() {} };
component.ready = (result, incremental) => renderEvents.push({ sources: Object.keys(result).sort(), incremental: !!incremental });
component.empty = () => { emptyCount++; };
component.search();
assert.equal(callbacks.length, 2);
callbacks[0].ok({ tracks: [{ title: 'Fast' }], isSerial: false });
assert.deepEqual(renderEvents, [{ sources: [h.SOURCES[0].id], incremental: false }]);
callbacks[1].ok({ tracks: [{ title: 'Slow' }], isSerial: false });
assert.equal(renderEvents.length, 2);
assert.equal(renderEvents[1].sources.length, 2);
assert.equal(renderEvents[1].incremental, true, 'late source must not rebuild the track list');
callbacks[1].ok({ tracks: [{ title: 'Duplicate' }] });
assert.equal(renderEvents.length, 2, 'duplicate completion must be ignored');
component.search();
assert.equal(callbacks.length, 4);
component.search();
assert.equal(callbacks.length, 6);
callbacks[2].ok({ tracks: [{ title: 'Stale' }] });
assert.equal(renderEvents.length, 2, 'stale search callback must be ignored');
callbacks[4].err();
callbacks[5].err();
assert.equal(emptyCount, 1, 'empty state only after every source finishes');
h.SOURCES.forEach((src, i) => { src.fetch = originalFetches[i]; });

console.log('FastCDN regression checks passed');
