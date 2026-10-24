// Dynamic v1 SAT imports only. Static/shared new-pack assets are deliberately
// not reachable from this store. Worker owns public Origin/account/CSRF checks;
// this Durable Object independently rechecks the actual auth session and role.
import { createHash, randomUUID } from 'node:crypto';
import { InputError, fail } from './json-stream.mjs';
import {
  BankJSON, isRecord, parseBankJSON, normalizeQuestionSet, toSATLegacy, jsonFragments,
} from './bank-schema.mjs';

export const BANK_CHUNK_BYTES = 256 * 1024;
export const MAX_BANK_REQUEST_BYTES = 20 * 1024 * 1024;
export const MAX_BANK_BYTES = 512 * 1024 * 1024;
// Logical payload quota above is separate from SQLite pages/index overhead.
// Leave generous headroom below the free-plan 1GiB per-object database ceiling.
export const MAX_BANK_DATABASE_BYTES = 896 * 1024 * 1024;
const encoder = new TextEncoder();
const headers = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const limit = () => fail('共享旧版题库空间已满（上限 512 MiB，含规范化内容及兼容副本），本次导入未保存。请联系管理员先导出并整理题库。', 413, 'bank_storage_limit');
const tooLarge = () => fail('题库导入请求超过 20 MiB，本次导入未保存。请拆分 JSON 文件后重试。', 413, 'bank_request_limit');
const unavailable = () => fail('题库服务暂不可用，请保留原文件并稍后重试。', 503, 'bank_unavailable');
const filename = hash => `sat-${hash}.json`;

function responseStream(generator, status = 200) {
  const iterator = generator[Symbol.asyncIterator]();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(typeof next.value === 'string' ? encoder.encode(next.value) : next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  }), { status, headers });
}

async function importDocument(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail('题库导入必须使用 application/json。', 415, 'json_required');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BANK_REQUEST_BYTES)) tooLarge();
  if (!request.body) fail('题库导入请求不能为空。');
  // The compatibility envelope can itself contain a nearly-20MiB text string.
  // ProjectedJSON's normal account-state 8MiB string ceiling is not used here.
  let parser = new BankJSON({ select: path => !path.length || ['name', 'text'].includes(path[0]) }), size = 0;
  for await (const bytes of request.body) {
    size += bytes.byteLength;
    if (size > MAX_BANK_REQUEST_BYTES) tooLarge();
    parser.write(bytes);
  }
  let envelope = parser.end(); parser = null;
  if (!isRecord(envelope) || typeof envelope.name !== 'string' || !envelope.name.toLowerCase().endsWith('.json') ||
      /[/\\\x00-\x1f]/.test(envelope.name)) fail('Use a plain JSON filename.', 400, 'invalid_question_bank');
  if (typeof envelope.text !== 'string') fail('Question content must be JSON text.', 400, 'invalid_question_bank');
  let raw = parseBankJSON(envelope.text); envelope = null;
  const document = normalizeQuestionSet(raw, 'sat'); raw = null;
  return document;
}

/** SQLite adapter matching DurableObjectStorage.sql/transactionSync. Tests use
 * in-memory node:sqlite, never the private/local Python database.
 * Only sanitized JSON variants enter SQL. Both representations plus summaries
 * are charged against 512MiB; the original filename/envelope are never stored.
 */
export class BankStore {
  constructor(storage, { clock = Date.now } = {}) {
    this.storage = storage; this.sql = storage.sql; this.clock = clock;
    this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS bank_uploads (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, size INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS bank_chunks (
        upload_id TEXT NOT NULL, variant TEXT NOT NULL, sequence INTEGER NOT NULL, body BLOB NOT NULL,
        PRIMARY KEY(upload_id, variant, sequence)
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS bank_documents (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, source_hash TEXT NOT NULL,
        upload_id TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, size INTEGER NOT NULL,
        canonical_size INTEGER NOT NULL, legacy_size INTEGER NOT NULL, summary_size INTEGER NOT NULL
      )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS bank_sources ON bank_documents(source_hash, hash)');
      // A new DO instance has no live import from the old instance. Remove only
      // unreachable, sanitized staging rows left by an interrupted upload.
      this.sql.exec('DELETE FROM bank_chunks WHERE upload_id NOT IN (SELECT upload_id FROM bank_documents)');
      this.sql.exec('DELETE FROM bank_uploads WHERE id NOT IN (SELECT upload_id FROM bank_documents)');
    });
  }
  rows(query, ...args) { return [...this.sql.exec(query, ...args)]; }
  one(query, ...args) { return this.rows(query, ...args)[0]; }
  bytes() { return this.one('SELECT COALESCE(SUM(size),0) AS bytes FROM bank_uploads').bytes; }
  databaseHeadroom(additionalBytes = 0) {
    const physical = this.sql.databaseSize;
    if (typeof physical === 'number' && physical + additionalBytes + 4 * 1024 * 1024 > MAX_BANK_DATABASE_BYTES) {
      fail('共享旧版题库数据库接近容量上限，本次导入未保存。请联系管理员先导出并整理题库。', 413, 'bank_database_limit');
    }
  }
  removeStaged(id) {
    this.storage.transactionSync(() => {
      if (this.one('SELECT 1 AS found FROM bank_documents WHERE upload_id=?', id)) return;
      this.sql.exec('DELETE FROM bank_chunks WHERE upload_id=?', id);
      this.sql.exec('DELETE FROM bank_uploads WHERE id=?', id);
    });
  }
  measure(value, hash = null) {
    let bytes = 0;
    for (const part of jsonFragments(value)) {
      bytes += Buffer.byteLength(part, 'utf8');
      if (bytes > MAX_BANK_BYTES) limit();
      hash?.update(part, 'utf8');
    }
    return bytes;
  }
  writeVariant(upload, variant, value) {
    let buffer = new Uint8Array(BANK_CHUNK_BYTES), used = 0, sequence = 0;
    const flush = () => {
      if (!used) return;
      this.sql.exec('INSERT INTO bank_chunks(upload_id,variant,sequence,body) VALUES (?,?,?,?)', upload, variant, sequence++, buffer.slice(0, used));
      buffer = new Uint8Array(BANK_CHUNK_BYTES); used = 0;
    };
    for (const part of jsonFragments(value)) {
      const bytes = encoder.encode(part);
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(BANK_CHUNK_BYTES - used, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + length), used); used += length; offset += length;
        if (used === BANK_CHUNK_BYTES) flush();
      }
    }
    flush();
  }
  stage(document) {
    // toSATLegacy also performs the complete canonical/metadata validation.
    const legacy = toSATLegacy(document), summary = {
      id: document.id, title: document.title, questionCount: document.questions.length, section: document.section,
      defaultDurationSeconds: document.defaultDurationSeconds,
      moduleCount: document.moduleQuestionCounts?.length || 1,
    };
    const hasher = createHash('sha256'), canonicalSize = this.measure(document, hasher), hash = hasher.digest('hex');
    const known = this.one('SELECT * FROM bank_documents WHERE hash=?', hash);
    if (known) return { known, hash }; // Still requires the fresh admin check.
    const legacySize = this.measure(legacy), summarySize = this.measure(summary), size = canonicalSize + legacySize + summarySize;
    const id = randomUUID(), sourceHash = digest(document.id);
    try {
      this.storage.transactionSync(() => {
        if (this.bytes() + size > MAX_BANK_BYTES) limit();
        this.databaseHeadroom(size);
        // Reserve before writing: staged, not just committed bytes count.
        this.sql.exec('INSERT INTO bank_uploads(id,created_at,size) VALUES (?,?,?)', id, this.clock(), size);
        this.writeVariant(id, 'canonical', document);
        this.writeVariant(id, 'legacy', legacy);
        this.writeVariant(id, 'summary', summary);
      });
    } catch (error) { this.removeStaged(id); throw error; }
    return { id, hash, sourceHash, size, canonicalSize, legacySize, summarySize };
  }
  async import(request, verify) {
    if (typeof verify !== 'function') throw new TypeError('A fresh authorization callback is required');
    let document = await importDocument(request);
    const staged = this.stage(document); document = null;
    try {
      await verify();
      // No await between the fresh admin decision and the atomic quota/dedup
      // commit. In-flight demotion/logout/expiry therefore cannot use a cached
      // initial role. Session revocation after this check affects later writes.
      const row = this.storage.transactionSync(() => {
        const known = this.one('SELECT * FROM bank_documents WHERE hash=?', staged.hash);
        if (known) return known;
        if (this.bytes() > MAX_BANK_BYTES) limit();
        this.databaseHeadroom();
        this.sql.exec(`INSERT INTO bank_documents(hash,source_hash,upload_id,updated_at,size,canonical_size,legacy_size,summary_size)
          VALUES (?,?,?,?,?,?,?,?)`, staged.hash, staged.sourceHash, staged.id, this.clock(), staged.size,
        staged.canonicalSize, staged.legacySize, staged.summarySize);
        return this.one('SELECT * FROM bank_documents WHERE hash=?', staged.hash);
      });
      return this.fileResponse(row, 201);
    } finally { if (staged.id) this.removeStaged(staged.id); }
  }
  async *raw(row, variant) {
    const size = row[variant + '_size']; let total = 0;
    for (let sequence = 0; total < size; sequence++) {
      const found = this.one('SELECT body FROM bank_chunks WHERE upload_id=? AND variant=? AND sequence=?', row.upload_id, variant, sequence);
      if (!found) throw new Error('Incomplete committed question bank');
      const bytes = new Uint8Array(found.body);
      if (!bytes.length || bytes.length > BANK_CHUNK_BYTES || total + bytes.length > size) throw new Error('Invalid question bank chunk');
      total += bytes.length; yield bytes;
    }
  }
  async *file(row) {
    yield '{"name":' + JSON.stringify(filename(row.hash)) + ',"lastModified":' + row.updated_at + ',"text":"';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const bytes of this.raw(row, 'legacy')) {
      const text = decoder.decode(bytes, { stream: true });
      // Escape a sequence of small fragments into the outer text JSON string.
      // Skip jsonFragments' first and last quote, including for an empty chunk.
      const fragments = jsonFragments(text); fragments.next();
      let previous = fragments.next();
      for (let next = fragments.next(); !next.done; next = fragments.next()) {
        yield previous.value; previous = next;
      }
    }
    const tail = decoder.decode();
    if (tail) yield JSON.stringify(tail).slice(1, -1);
    yield '"}';
  }
  fileResponse(row, status = 200) { return responseStream(this.file(row), status); }
  *catalogRows(cutoff) {
    let after = '';
    while (true) {
      const page = this.rows('SELECT * FROM bank_documents WHERE hash>? AND sequence<=? ORDER BY hash LIMIT 32', after, cutoff);
      if (!page.length) return;
      for (const row of page) yield row;
      after = page.at(-1).hash;
    }
  }
  list() {
    const self = this, cutoff = this.one('SELECT COALESCE(MAX(sequence),0) AS n FROM bank_documents').n;
    return responseStream((async function* () {
      yield '{"files":['; let comma = false;
      for (const row of self.catalogRows(cutoff)) { if (comma) yield ','; comma = true; yield* self.file(row); }
      yield '],"errors":[]}';
    })());
  }
  sources() {
    const self = this, cutoff = this.one('SELECT COALESCE(MAX(sequence),0) AS n FROM bank_documents').n;
    return responseStream((async function* () {
      yield '{"schemaVersion":1,"exam":"sat","sources":['; let comma = false;
      for (const row of self.catalogRows(cutoff)) { if (comma) yield ','; comma = true; yield* self.raw(row, 'summary'); }
      yield '],"errors":[]}';
    })());
  }
  source(id) {
    if (typeof id !== 'string' || !/^sat:[A-Za-z0-9._-]+$(?![\s\S])/.test(id)) fail('Source not found.', 404, 'not_found');
    // Like sorted Python filenames, a repeated explicit source ID resolves to
    // the lexicographically first document hash. Imports never overwrite other
    // revisions or mutate static/new-pack content.
    const row = this.one('SELECT * FROM bank_documents WHERE source_hash=? ORDER BY hash LIMIT 1', digest(id));
    if (!row) fail('Source not found.', 404, 'not_found');
    return responseStream(this.raw(row, 'canonical'));
  }
}

export class PlatformBankStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.store = new BankStore(ctx.storage); this.busy = false; }
  async verify(request, admin = false) {
    const token = request.headers.get('X-Platform-Token'), owner = request.headers.get('X-Platform-User');
    if (!token || !owner) fail('请先登录。', 401, 'session_expired');
    let response, session;
    try {
      response = await this.env.AUTH.getByName('platform-auth-v1').fetch('https://internal/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      session = await response.json();
    } catch { unavailable(); }
    if (!response.ok) {
      if (response.status >= 500) unavailable();
      fail('登录已失效，请重新登录。', 401, 'session_expired');
    }
    if (session?.authenticated !== true || !session.user || typeof session.user.id !== 'string' || session.user.active === false) {
      fail('登录已失效，请重新登录。', 401, 'session_expired');
    }
    if (session.user.id !== owner) fail('当前账号已切换，请重新打开页面。', 409, 'account_changed');
    if (admin && session.user.role !== 'admin') fail('只有管理员可以修改共享题库。', 403, 'admin_required');
    return session.user;
  }
  async fetch(request) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      const bank = path === '/question-bank' || path === '/api/question-bank';
      await this.verify(request, bank && method === 'POST');
      if (url.search) fail('题库接口不接受查询参数。');
      if (bank) {
        if (method === 'GET') return this.store.list();
        if (method === 'POST') {
          if (this.busy) fail('正在导入另一份题库，请稍后重试。', 429, 'bank_import_busy', { retryAfter: 2 });
          this.busy = true;
          try { return await this.store.import(request, () => this.verify(request, true)); }
          finally { this.busy = false; }
        }
        fail('此接口不支持该操作。', 405, 'method_not_allowed');
      }
      if (path === '/sources') {
        if (method !== 'GET') fail('此接口不支持该操作。', 405, 'method_not_allowed');
        return this.store.sources();
      }
      if (path.startsWith('/sources/')) {
        if (method !== 'GET') fail('此接口不支持该操作。', 405, 'method_not_allowed');
        let id; try { id = decodeURIComponent(path.slice('/sources/'.length)); } catch { fail('Source not found.', 404, 'not_found'); }
        return this.store.source(id);
      }
      fail('题库接口不存在。', 404, 'not_found');
    } catch (error) {
      if (error instanceof InputError) {
        const response = json({ error: error.message, code: error.code, ...error.extra }, error.status);
        if (error.status === 429) response.headers.set('Retry-After', String(error.extra?.retryAfter || 2));
        return response;
      }
      // Never return or log SQL exceptions: bindings may contain content.
      return json({ error: '题库服务暂不可用，请保留原文件并稍后重试。', code: 'bank_unavailable' }, 503);
    }
  }
}
