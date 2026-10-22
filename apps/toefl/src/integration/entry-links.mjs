const views = new Set(['home', 'practice', 'mock', 'plan', 'wrongBook', 'report', 'history', 'progress', 'vocab']);
const sections = new Set(['reading', 'listening', 'speaking', 'writing']);
const relativeOrigin = 'https://toefl-entry.invalid';

/** Build a navigation link from a trusted module base; this does not authenticate a user. */
export function buildToeflEntryUrl(baseUrl, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Entry options must be an object.');
  }
  if (Reflect.ownKeys(options).some(key => key !== 'view' && key !== 'section')) {
    throw new TypeError('Only view and section entry options are supported.');
  }
  const { view = 'home', section } = options;
  if (!views.has(view)) throw new TypeError('Invalid TOEFL entry view.');
  if (section !== undefined && !sections.has(section)) throw new TypeError('Invalid TOEFL section.');
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new TypeError('A trusted module base URL is required.');
  if (/[\u0000-\u001f\u007f]/.test(baseUrl)) throw new TypeError('Invalid module base URL.');
  const base = baseUrl.trim();
  if (/[\\\u0000-\u0020\u007f]/.test(base)) throw new TypeError('Invalid module base URL.');
  const relative = base.startsWith('/') && !base.startsWith('//');
  if (!relative && !/^https?:\/\//i.test(base)) {
    throw new TypeError('Use an absolute HTTP(S) URL or a same-origin root path.');
  }
  let url;
  try { url = new URL(base, relativeOrigin); }
  catch { throw new TypeError('Invalid module base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Module base URLs cannot contain credentials or unsupported protocols.');
  }
  // Do not forward a stale query, fragment, token or redirect from caller configuration.
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', view);
  if (section !== undefined) url.searchParams.set('section', section);
  return relative ? url.pathname + url.search : url.href;
}
