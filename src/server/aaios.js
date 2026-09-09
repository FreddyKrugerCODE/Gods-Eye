/**
 * AAIOS client — the single, isolated place God's Eye talks to the operator's
 * AAIOS server (an LLM/Codex-style backend running on their own machine).
 *
 * WHY THIS FILE IS SMALL AND SELF-CONTAINED
 * -----------------------------------------
 * The exact AAIOS request/response shape is operator-specific and was not
 * available when this was written, so every assumption about the wire format
 * lives *here* and nowhere else. If your AAIOS expects a different body or
 * returns a different envelope, you change {@link buildAaiosRequest} and
 * {@link parseAaiosCameras} in this one file — the discovery route, the UI, and
 * the camera registry never need to know.
 *
 * ENUM CONTRACT (do not change to values outside the AAIOS allow-lists)
 * --------------------------------------------------------------------
 *   task_class: 'extract'   — we hand AAIOS candidate camera data + an area and
 *                             ask it to return clean, structured records. That
 *                             is structured extraction, the cheapest reliable
 *                             fit. (Valid classes: auto, classify, extract, qa,
 *                             chat, summarize, translate, code, research,
 *                             creative.)
 *   quality:    'standard'  — adequate for tidying/ranking; not worth premium.
 *                             (Valid: auto, economy, standard, premium.)
 * Sending anything else returns HTTP 422 from AAIOS, so these are pinned as
 * constants and asserted by the unit tests.
 *
 * SAFETY: AAIOS is only ever asked to *clean and rank cameras we already found*
 * from public open-data sources. It is never asked to find, guess, or access
 * cameras on its own — the caller reconciles AAIOS output back against the
 * supplied candidate ids ({@link reconcileAiRecords}) so the model cannot add
 * cameras that were not already public.
 *
 * @module server/aaios
 */

/** The only task_class this integration ever sends. */
export const AAIOS_TASK_CLASS = 'extract';
/** The only quality this integration ever sends. */
export const AAIOS_QUALITY = 'standard';

/** Default endpoint path if AAIOS_API_PATH is unset. ASSUMED — override via env
 * to match your server. */
const DEFAULT_AAIOS_API_PATH = '/v1/run';
/** Default per-call timeout. */
const DEFAULT_AAIOS_TIMEOUT_MS = 20 * 1000;

/**
 * Read AAIOS connection settings from the environment.
 *
 * @returns {{configured:boolean, baseUrl:string, path:string, apiKey:string, timeoutMs:number}}
 */
export function aaiosConfig(env = process.env) {
  const baseUrl = String(env.AAIOS_BASE_URL || '').trim().replace(/\/+$/, '');
  const path = String(env.AAIOS_API_PATH || DEFAULT_AAIOS_API_PATH).trim();
  const apiKey = String(env.AAIOS_API_KEY || '').trim();
  const timeoutMs = Number(env.AAIOS_TIMEOUT_MS) > 0
    ? Math.floor(Number(env.AAIOS_TIMEOUT_MS))
    : DEFAULT_AAIOS_TIMEOUT_MS;
  return { configured: baseUrl.length > 0, baseUrl, path, apiKey, timeoutMs };
}

/** True when AAIOS_BASE_URL is set — otherwise callers use their deterministic
 * fallback and the feature still works without any AI backend. */
export function isAaiosConfigured(env = process.env) {
  return aaiosConfig(env).configured;
}

/**
 * Build the natural-language instruction handed to AAIOS. It is deliberately
 * strict: use only the provided candidates, never invent cameras.
 *
 * @param {{south:number,west:number,north:number,east:number,label?:string}} area
 * @param {Array<object>} candidates
 * @returns {string}
 */
export function buildAaiosPrompt(area, candidates) {
  const where = area?.label
    ? `"${area.label}" (bounding box S${area.south} W${area.west} N${area.north} E${area.east})`
    : `bounding box S${area.south} W${area.west} N${area.north} E${area.east}`;
  const list = JSON.stringify(
    (candidates || []).map((c) => ({
      id: c.id,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      provider: c.provider,
      headingDeg: c.headingDeg,
      pitchDeg: c.pitchDeg,
      fovDeg: c.fovDeg,
      rangeM: c.rangeM,
    })),
  );
  return [
    'You are registering PUBLIC traffic/observation cameras for a 3D map.',
    `Area: ${where}.`,
    'From the CANDIDATES below (already-published public cameras), return the',
    'ones that belong to this area as a JSON array. For each, keep its exact',
    '"id", "lat", and "lon"; you may clean up "name" and, when confident,',
    'suggest numeric pose hints "headingDeg", "pitchDeg", "fovDeg", "rangeM".',
    'Do NOT invent cameras or ids that are not in CANDIDATES. Output JSON only.',
    `CANDIDATES: ${list}`,
  ].join('\n');
}

/**
 * Build the HTTP request (url, headers, body) sent to AAIOS. ASSUMED SCHEMA —
 * change here to match your server's contract.
 *
 * @param {{baseUrl:string, path:string, apiKey:string}} cfg
 * @param {string} prompt
 * @returns {{url:string, init:object}}
 */
export function buildAaiosRequest(cfg, prompt) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    task_class: AAIOS_TASK_CLASS,
    quality: AAIOS_QUALITY,
    input: prompt,
    // A hint that we want machine-readable output; harmless if AAIOS ignores it.
    response_format: 'json',
  };
  return { url: `${cfg.baseUrl}${cfg.path}`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

/**
 * Pull an array of camera-like objects out of whatever envelope AAIOS returns.
 * Tolerates: a bare array; `{cameras|records|results|data: [...]}`; or a text
 * field (`output|text|content|completion|response`) that *contains* a JSON
 * array. Returns `[]` when nothing usable is found.
 *
 * @param {*} payload - Parsed JSON (or a string) from AAIOS.
 * @returns {Array<object>}
 */
export function parseAaiosCameras(payload) {
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : null);

  if (typeof payload === 'string') return extractJsonArray(payload);
  if (!payload || typeof payload !== 'object') return [];

  const direct = asArray(payload) // payload itself is the array
    || asArray(payload.cameras)
    || asArray(payload.records)
    || asArray(payload.results)
    || asArray(payload.data);
  if (direct) return direct;

  for (const key of ['output', 'text', 'content', 'completion', 'response', 'message']) {
    const v = payload[key];
    if (typeof v === 'string') {
      const found = extractJsonArray(v);
      if (found.length) return found;
    } else if (v && typeof v === 'object') {
      const nested = parseAaiosCameras(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

/**
 * Find and parse the first top-level JSON array embedded in a string.
 * @param {string} text
 * @returns {Array<object>}
 */
function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * Ask AAIOS to normalize a set of public candidate cameras for an area.
 *
 * Always resolves (never throws): on any misconfiguration, network error, or
 * unparseable reply it returns `{ok:false}` with an empty `cameras` list so the
 * caller falls back to its deterministic path.
 *
 * @param {object} params
 * @param {object} params.area - Normalized area box (with optional label).
 * @param {Array<object>} params.candidates - Public candidate cameras.
 * @param {typeof fetch} [params.fetchImpl] - Injectable for tests.
 * @param {object} [params.env]
 * @returns {Promise<{configured:boolean, ok:boolean, cameras:Array<object>, error?:string}>}
 */
export async function aaiosNormalizeCameras({ area, candidates, fetchImpl, env } = {}) {
  const cfg = aaiosConfig(env);
  if (!cfg.configured) return { configured: false, ok: false, cameras: [] };
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { configured: true, ok: true, cameras: [] };
  }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const prompt = buildAaiosPrompt(area, candidates);
  const { url, init } = buildAaiosRequest(cfg, prompt);

  try {
    const resp = await doFetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!resp || !resp.ok) {
      return { configured: true, ok: false, cameras: [], error: `AAIOS HTTP ${resp ? resp.status : 'no-response'}` };
    }
    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    const payload = ct.includes('application/json') ? await resp.json() : await resp.text();
    const cameras = parseAaiosCameras(payload);
    return { configured: true, ok: cameras.length > 0, cameras };
  } catch (error) {
    return { configured: true, ok: false, cameras: [], error: String(error && error.message ? error.message : error) };
  }
}
