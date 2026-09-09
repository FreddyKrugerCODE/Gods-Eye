/**
 * CCTV area-discovery pure helpers.
 *
 * This module holds the side-effect-free logic behind the "point at an area →
 * discover the public cameras in it → register them" feature. It is imported
 * by the dev-server discovery route (`/api/cctv/discover` in `vite.config.js`)
 * and is unit-tested in isolation (`cctvDiscovery.test.mjs`). It never touches
 * the network, the filesystem, or Cesium — only plain objects in and out.
 *
 * SAFETY POSTURE: discovery only ever *selects and relabels cameras that were
 * already published by an open-data provider* (the Austin / Caltrans / TfL
 * packs and any file/env catalog the operator configured). It does not scan
 * networks, guess URLs, or grant access to anything private. Candidates come
 * from the existing `/api/cctv/sources` list; this module just filters that
 * list to the chosen area and shapes the survivors into registrable records.
 *
 * @module data/cctvDiscovery
 */

/** Hard ceiling on cameras returned by one discovery call (keeps a whole-globe
 * bounding box from registering the entire catalog at once). */
export const DISCOVERY_DEFAULT_MAX = 40;
/** Absolute cap regardless of a caller-supplied limit. */
export const DISCOVERY_HARD_MAX = 120;

/**
 * Coerce a value to a finite number, or return `fallback`.
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */
function toFinite(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize a variety of area inputs into a plain degree-space bounding box.
 *
 * Accepts either an object with `south/west/north/east` (degrees) or a
 * comma-separated string `"south,west,north,east"`. An optional `label` is
 * carried through for naming and for AAIOS context. Returns `null` when the
 * input cannot be read as a valid, non-degenerate box.
 *
 * @param {object|string|null} input
 * @returns {{south:number, west:number, north:number, east:number, label:string}|null}
 */
export function normalizeArea(input) {
  let raw = input;
  if (typeof input === 'string') {
    const parts = input.split(',').map((p) => p.trim());
    if (parts.length < 4) return null;
    raw = { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
  }
  if (!raw || typeof raw !== 'object') return null;

  let south = toFinite(raw.south);
  let west = toFinite(raw.west);
  let north = toFinite(raw.north);
  let east = toFinite(raw.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;

  // Clamp to valid geographic ranges.
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  west = Math.max(-180, Math.min(180, west));
  east = Math.max(-180, Math.min(180, east));

  // Tolerate swapped corners rather than rejecting them.
  if (south > north) [south, north] = [north, south];
  if (west > east) [west, east] = [east, west];

  // Reject a degenerate (zero-area) box.
  if (south === north || west === east) return null;

  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 120) : '';
  return { south, west, north, east, label };
}

/**
 * True when a lat/lon point lies inside the (already-normalized) area box.
 * Antimeridian-crossing boxes are out of scope for v1 and are treated as the
 * plain west≤east span produced by {@link normalizeArea}.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{south:number, west:number, north:number, east:number}} area
 * @returns {boolean}
 */
export function pointInArea(lat, lon, area) {
  if (!area) return false;
  const la = toFinite(lat);
  const lo = toFinite(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  return la >= area.south && la <= area.north && lo >= area.west && lo <= area.east;
}

/**
 * Geographic center of an area box.
 * @param {{south:number, west:number, north:number, east:number}} area
 * @returns {{lat:number, lon:number}}
 */
export function areaCenter(area) {
  return { lat: (area.south + area.north) / 2, lon: (area.west + area.east) / 2 };
}

/**
 * Approximate great-circle distance in kilometers (haversine). Good enough for
 * ranking nearby cameras; not used for anything safety-critical.
 *
 * @param {number} aLat @param {number} aLon @param {number} bLat @param {number} bLon
 * @returns {number}
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * De-duplicate a list of camera-like objects by `id` (last write wins, matching
 * the backend source-merge convention). Items without a usable id are dropped.
 *
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function dedupeById(list) {
  const byId = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = item && item.id != null ? String(item.id).trim() : '';
    if (!id) continue;
    byId.set(id, item);
  }
  return Array.from(byId.values());
}

/**
 * Filter a candidate camera list to those inside the area, de-duplicate, and
 * rank by distance from the area center (closest first), then cap.
 *
 * @param {Array<object>} candidates - Objects with numeric `lat`/`lon`/`id`.
 * @param {{south:number, west:number, north:number, east:number}} area
 * @param {{max?:number}} [options]
 * @returns {Array<object>} Filtered, de-duplicated, distance-sorted, capped.
 */
export function filterCandidatesToArea(candidates, area, options = {}) {
  if (!area) return [];
  const max = Math.max(1, Math.min(DISCOVERY_HARD_MAX, Math.floor(toFinite(options.max, DISCOVERY_DEFAULT_MAX))));
  const center = areaCenter(area);
  const inside = dedupeById(candidates).filter((c) => pointInArea(c?.lat, c?.lon, area));
  inside.sort((a, b) => (
    haversineKm(center.lat, center.lon, a.lat, a.lon)
    - haversineKm(center.lat, center.lon, b.lat, b.lon)
  ));
  return inside.slice(0, max);
}

/**
 * Shape a public candidate into a registrable "discovered" camera record.
 *
 * This is the DETERMINISTIC fallback used when AAIOS is not configured or does
 * not answer — it simply passes the published fields through with a stable id
 * and a `sourceKind: 'discovered'` tag. Pose fields are copied verbatim (they
 * are the provider's priors, which the operator can still fine-tune with the
 * on-camera calibration gizmo). No field is invented.
 *
 * @param {object} candidate - A public source object (from /api/cctv/sources).
 * @param {{label?:string}} [area]
 * @returns {object|null} A record compatible with the source registry, or null.
 */
export function toRegisteredRecord(candidate, area = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = candidate.id != null ? String(candidate.id).trim() : '';
  const lat = toFinite(candidate.lat);
  const lon = toFinite(candidate.lon);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const areaLabel = area && typeof area.label === 'string' ? area.label.trim() : '';
  const baseName = String(candidate.name || candidate.id || 'Camera').trim();

  const record = {
    id,
    name: baseName,
    city: String(candidate.city || areaLabel || ''),
    cityId: String(candidate.cityId || ''),
    provider: String(candidate.provider || 'Discovered public camera'),
    lat,
    lon,
    headingDeg: toFinite(candidate.headingDeg),
    pitchDeg: toFinite(candidate.pitchDeg),
    fovDeg: toFinite(candidate.fovDeg),
    rangeM: toFinite(candidate.rangeM),
    mountHeightM: toFinite(candidate.mountHeightM),
    groundElevationM: toFinite(candidate.groundElevationM),
    feedType: String(candidate.feedType || 'image'),
    url: typeof candidate.url === 'string' ? candidate.url : '',
    snapshotUrl: typeof candidate.snapshotUrl === 'string' ? candidate.snapshotUrl : '',
    license: String(candidate.license || ''),
    // Mark provenance so the UI/health layer can tell discovered cameras from
    // the always-on packs, and so a later run can find/replace them.
    sourceKind: 'discovered',
  };
  // Drop NaN numeric fields so the backend normalizer keeps its own defaults.
  for (const key of ['headingDeg', 'pitchDeg', 'fovDeg', 'rangeM', 'mountHeightM', 'groundElevationM']) {
    if (!Number.isFinite(record[key])) delete record[key];
  }
  return record;
}

/**
 * Restrict AAIOS-returned records to real candidate ids (an anti-hallucination
 * guard): the model may only clean/rank cameras we handed it, never add new
 * ones. Each surviving AAIOS record is merged onto its candidate so published
 * feed URLs and coordinates always win over anything the model rephrased.
 *
 * @param {Array<object>} aiRecords - Records returned by AAIOS.
 * @param {Array<object>} candidates - The candidates AAIOS was given.
 * @param {{label?:string}} [area]
 * @returns {Array<object>} Registrable records limited to known candidate ids.
 */
export function reconcileAiRecords(aiRecords, candidates, area = {}) {
  const candidateById = new Map(
    dedupeById(candidates).map((c) => [String(c.id).trim(), c]),
  );
  const out = [];
  const seen = new Set();
  for (const ai of Array.isArray(aiRecords) ? aiRecords : []) {
    const id = ai && ai.id != null ? String(ai.id).trim() : '';
    if (!id || seen.has(id)) continue;
    const candidate = candidateById.get(id);
    if (!candidate) continue; // ignore any id we did not supply
    seen.add(id);
    // Start from the trusted published candidate, then let AAIOS override only
    // presentational/pose hints — never the identity, coordinates, or feed URL.
    const merged = {
      ...candidate,
      name: typeof ai.name === 'string' && ai.name.trim() ? ai.name.trim() : candidate.name,
    };
    for (const key of ['headingDeg', 'pitchDeg', 'fovDeg', 'rangeM']) {
      // Only a genuine finite number overrides the published prior. Using
      // Number() here would coerce null/''/[]/false to 0 (all finite) and let an
      // AAIOS "headingDeg": null clobber the candidate's real pose with zero.
      if (typeof ai[key] === 'number' && Number.isFinite(ai[key])) merged[key] = ai[key];
    }
    const record = toRegisteredRecord(merged, area);
    if (record) out.push(record);
  }
  return out;
}
