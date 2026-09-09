import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeArea,
  pointInArea,
  areaCenter,
  dedupeById,
  filterCandidatesToArea,
  toRegisteredRecord,
  reconcileAiRecords,
  DISCOVERY_DEFAULT_MAX,
} from './cctvDiscovery.js';

import {
  AAIOS_TASK_CLASS,
  AAIOS_QUALITY,
  buildAaiosRequest,
  parseAaiosCameras,
  aaiosNormalizeCameras,
  isAaiosConfigured,
} from '../server/aaios.js';

const AUSTIN = { south: 30.20, west: -97.80, north: 30.32, east: -97.68, label: 'Austin' };

test('normalizeArea reads objects and strings, clamps, and rejects degenerate boxes', () => {
  assert.deepEqual(
    normalizeArea({ south: 30.2, west: -97.8, north: 30.3, east: -97.7, label: 'Austin' }),
    { south: 30.2, west: -97.8, north: 30.3, east: -97.7, label: 'Austin' },
  );
  // Comma string form.
  const fromStr = normalizeArea('30.3,-97.8,30.2,-97.7');
  assert.equal(fromStr.south, 30.2); // swapped corners fixed
  assert.equal(fromStr.north, 30.3);
  // Degenerate (zero-area) rejected.
  assert.equal(normalizeArea({ south: 1, west: 1, north: 1, east: 2 }), null);
  // Garbage rejected.
  assert.equal(normalizeArea('nope'), null);
  assert.equal(normalizeArea(null), null);
  // Out-of-range clamped.
  const clamped = normalizeArea({ south: -200, west: -400, north: 200, east: 400 });
  assert.deepEqual(
    [clamped.south, clamped.west, clamped.north, clamped.east],
    [-90, -180, 90, 180],
  );
});

test('pointInArea and areaCenter', () => {
  assert.equal(pointInArea(30.26, -97.74, AUSTIN), true);
  assert.equal(pointInArea(40.0, -97.74, AUSTIN), false); // north of box
  assert.equal(pointInArea('x', 'y', AUSTIN), false);
  assert.deepEqual(areaCenter(AUSTIN), { lat: (30.20 + 30.32) / 2, lon: (-97.80 + -97.68) / 2 });
});

test('dedupeById keeps last write and drops id-less items', () => {
  const out = dedupeById([
    { id: 'a', v: 1 },
    { id: 'a', v: 2 },
    { id: '', v: 3 },
    { v: 4 },
    { id: 'b', v: 5 },
  ]);
  assert.deepEqual(out.map((x) => x.id), ['a', 'b']);
  assert.equal(out.find((x) => x.id === 'a').v, 2);
});

test('filterCandidatesToArea filters, sorts by distance to center, and caps', () => {
  const center = areaCenter(AUSTIN);
  const candidates = [
    { id: 'far-but-inside', lat: AUSTIN.north - 0.001, lon: AUSTIN.east - 0.001 },
    { id: 'outside', lat: 45, lon: 10 },
    { id: 'dead-center', lat: center.lat, lon: center.lon },
    { id: 'no-coords' },
  ];
  const out = filterCandidatesToArea(candidates, AUSTIN, { max: 10 });
  assert.deepEqual(out.map((c) => c.id), ['dead-center', 'far-but-inside']);
  // Cap is honored.
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, lat: center.lat, lon: center.lon }));
  assert.equal(filterCandidatesToArea(many, AUSTIN, { max: 5 }).length, 5);
  // Default cap applies when unspecified.
  assert.equal(filterCandidatesToArea(many, AUSTIN).length, DISCOVERY_DEFAULT_MAX);
});

test('toRegisteredRecord passes public fields through, tags provenance, drops NaN pose', () => {
  const rec = toRegisteredRecord({
    id: 'cam1', name: ' Congress & 6th ', lat: 30.26, lon: -97.74,
    provider: 'Austin', url: 'https://example/img.jpg', feedType: 'image',
    headingDeg: 120, fovDeg: 'oops',
  }, AUSTIN);
  assert.equal(rec.id, 'cam1');
  assert.equal(rec.name, 'Congress & 6th');
  assert.equal(rec.sourceKind, 'discovered');
  assert.equal(rec.headingDeg, 120);
  assert.equal('fovDeg' in rec, false); // NaN pose field removed
  assert.equal(rec.url, 'https://example/img.jpg');
  // Invalid input rejected.
  assert.equal(toRegisteredRecord({ id: 'x' }), null);
  assert.equal(toRegisteredRecord(null), null);
});

test('reconcileAiRecords only keeps supplied ids and never lets AI override coords/url', () => {
  const candidates = [
    { id: 'real', name: 'Raw name', lat: 30.26, lon: -97.74, url: 'https://real/feed', feedType: 'image' },
  ];
  const ai = [
    { id: 'real', name: 'Pretty Name', lat: 0, lon: 0, url: 'https://evil/override', headingDeg: 200 },
    { id: 'hallucinated', name: 'Ghost cam', lat: 10, lon: 10 },
  ];
  const out = reconcileAiRecords(ai, candidates, AUSTIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'real');
  assert.equal(out[0].name, 'Pretty Name');   // AI may relabel
  assert.equal(out[0].lat, 30.26);            // but not move it
  assert.equal(out[0].lon, -97.74);
  assert.equal(out[0].url, 'https://real/feed'); // nor change the feed URL
  assert.equal(out[0].headingDeg, 200);       // pose hint accepted
});

test('AAIOS enums are exactly the pinned allow-list values', () => {
  assert.equal(AAIOS_TASK_CLASS, 'extract');
  assert.equal(AAIOS_QUALITY, 'standard');
  const validClasses = ['auto', 'classify', 'extract', 'qa', 'chat', 'summarize', 'translate', 'code', 'research', 'creative'];
  const validQuality = ['auto', 'economy', 'standard', 'premium'];
  assert.ok(validClasses.includes(AAIOS_TASK_CLASS));
  assert.ok(validQuality.includes(AAIOS_QUALITY));
});

test('buildAaiosRequest sends only the pinned enums and bearer auth', () => {
  const { url, init } = buildAaiosRequest(
    { baseUrl: 'http://aaios.local', path: '/v1/run', apiKey: 'secret' },
    'prompt text',
  );
  assert.equal(url, 'http://aaios.local/v1/run');
  const body = JSON.parse(init.body);
  assert.equal(body.task_class, 'extract');
  assert.equal(body.quality, 'standard');
  assert.equal(init.headers.Authorization, 'Bearer secret');
});

test('parseAaiosCameras tolerates arrays, envelopes, and embedded JSON text', () => {
  assert.equal(parseAaiosCameras([{ id: 'a' }]).length, 1);
  assert.equal(parseAaiosCameras({ cameras: [{ id: 'a' }, { id: 'b' }] }).length, 2);
  assert.equal(parseAaiosCameras({ data: [{ id: 'a' }] }).length, 1);
  assert.equal(parseAaiosCameras({ output: 'Here you go: [{"id":"a"},{"id":"b"}] done' }).length, 2);
  assert.equal(parseAaiosCameras('[{"id":"z"}]').length, 1);
  assert.equal(parseAaiosCameras({ nope: true }).length, 0);
  assert.equal(parseAaiosCameras('not json').length, 0);
});

test('isAaiosConfigured reflects AAIOS_BASE_URL only', () => {
  assert.equal(isAaiosConfigured({}), false);
  assert.equal(isAaiosConfigured({ AAIOS_BASE_URL: '' }), false);
  assert.equal(isAaiosConfigured({ AAIOS_BASE_URL: 'http://x' }), true);
});

test('aaiosNormalizeCameras returns configured:false when unset (deterministic fallback path)', async () => {
  const res = await aaiosNormalizeCameras({ area: AUSTIN, candidates: [{ id: 'a', lat: 30.26, lon: -97.74 }], env: {} });
  assert.equal(res.configured, false);
  assert.equal(res.ok, false);
  assert.deepEqual(res.cameras, []);
});

test('aaiosNormalizeCameras parses a stubbed successful response', async () => {
  const env = { AAIOS_BASE_URL: 'http://aaios.local', AAIOS_API_KEY: 'k' };
  const fetchImpl = async (url, init) => {
    // Assert we only ever send the pinned enums, even through the live path.
    const body = JSON.parse(init.body);
    assert.equal(body.task_class, 'extract');
    assert.equal(body.quality, 'standard');
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ cameras: [{ id: 'real', name: 'Clean' }] }),
    };
  };
  const res = await aaiosNormalizeCameras({
    area: AUSTIN,
    candidates: [{ id: 'real', lat: 30.26, lon: -97.74 }],
    fetchImpl,
    env,
  });
  assert.equal(res.configured, true);
  assert.equal(res.ok, true);
  assert.equal(res.cameras[0].id, 'real');
});

test('aaiosNormalizeCameras never throws on HTTP error', async () => {
  const env = { AAIOS_BASE_URL: 'http://aaios.local' };
  const fetchImpl = async () => ({ ok: false, status: 422, headers: { get: () => 'application/json' } });
  const res = await aaiosNormalizeCameras({ area: AUSTIN, candidates: [{ id: 'a', lat: 1, lon: 1 }], fetchImpl, env });
  assert.equal(res.ok, false);
  assert.match(res.error, /422/);
});
