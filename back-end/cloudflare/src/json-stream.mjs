// Bounded-memory JSON validation/projection. Large snapshot strings are hashed,
// not materialized. The original UTF-8 bytes are stored separately in chunks.
import { createHash } from 'node:crypto';
export class InputError extends Error {
  constructor(message, status = 400, code = 'invalid_request', extra = {}) {
    super(message); Object.assign(this, {status, code, extra});
  }
}
export const fail = (message, status = 400, code = 'invalid_request', extra = {}) => { throw new InputError(message, status, code, extra); };
const OMIT = Symbol('omitted');
const digest = (type, value) => createHash('sha256').update(type + '\0').update(value).digest('hex');
const own = (object, key, value) => Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});
// Exact decimal normalization prevents distinct raw JSON numbers above 2^53
// from sharing a mutation/immutability hash through JavaScript rounding.
function numberHash(literal) {
  const match=literal.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  let digits=(match[2]+(match[3]||'')).replace(/^0+/,''),exponent=BigInt(match[4]||'0')-BigInt((match[3]||'').length);
  if(!digits)return digest('number','0');
  const zeros=digits.match(/0+$/)?.[0].length||0;
  if(zeros){digits=digits.slice(0,-zeros);exponent+=BigInt(zeros);}
  return digest('number',match[1]+digits+'e'+exponent);
}

export class ProjectedJSON {
  constructor({select = () => true, capture = 'value', maxCapturedString = 8 * 1024 * 1024} = {}) {
    Object.assign(this, {select, capture, maxCapturedString, stack: [], mode: 'value', offset: 0, root: undefined,
      ended: false, retainedKeys: 0, retainedKeyBytes: 0, retainedWeight: 0, nodes: 0});
    this.decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  }
  path() {
    const parent = this.stack.at(-1);
    return parent ? [...parent.path, parent.kind === 'array' ? parent.count : parent.key] : [];
  }
  bad(message = 'JSON 内容无效。') { fail(message); }
  retain(weight) {
    this.retainedWeight+=weight;
    if(this.retainedWeight>24*1024*1024)this.bad('记录可验证结构过大，请减少单条记录的复杂度。');
  }
  start(ch) {
    const path = this.path(), keep = Boolean(this.select(path));
    if(keep)this.retain(96);
    if (++this.nodes > 2_000_000) this.bad('记录结构过于复杂。');
    if (path.length === 1 && path[0] === this.capture) this.captureStart = this.offset;
    if (ch === '{' || ch === '[') {
      if (this.stack.length >= 128) this.bad('JSON 嵌套过深。');
      const kind = ch === '{' ? 'object' : 'array';
      this.stack.push({kind, path, keep, value: keep ? (kind === 'object' ? {} : []) : OMIT,
        count: 0, entries: [], keys: new Set(), keyBytes: 0,
        hash: createHash('sha256').update(kind + '\0')});
      this.mode = kind === 'object' ? 'key-or-end' : 'value-or-end';
    } else if (ch === '"') this.string(path, keep, false);
    else if (ch === '-' || /[0-9]/.test(ch)) { this.mode = 'number'; this.literal = ch; this.scalar = {path, keep}; }
    else if ('tfn'.includes(ch)) { this.mode = 'literal'; this.literal = ch; this.scalar = {path, keep}; }
    else this.bad();
  }
  string(path, keep, key) {
    this.mode = 'string'; this.scalar = {path, keep, key, text: '', size: 0, hash: createHash('sha256').update('string\0')};
    this.escape = ''; this.highSurrogate = null;
  }
  append(text) {
    if (!text) return;
    const s = this.scalar;
    s.hash.update(text);
    if (s.keep || s.key) {
      const bytes=Buffer.byteLength(text);s.size += bytes;
      if(s.keep&&!s.key)this.retain(2*bytes);
      if (s.size > (s.key ? 4096 : this.maxCapturedString)) this.bad('JSON 字段过大。');
      s.text += text;
    }
  }
  complete(value, hash, path, end) {
    if (path.length === 1 && path[0] === this.capture) { this.captureEnd = end; this.captureHash = hash; }
    const parent = this.stack.at(-1);
    if (!parent) { this.root = value; this.hash = hash; this.ended = true; this.mode = 'done'; return; }
    if (parent.kind === 'object') {
      parent.entries.push([parent.key, hash]);
      if (parent.keep && value !== OMIT) {this.retain(64+2*Buffer.byteLength(parent.key));own(parent.value, parent.key, value);}
    } else {
      parent.hash.update(hash);
      if (parent.keep && value !== OMIT) parent.value.push(value);
    }
    parent.count++; this.mode = 'comma-or-end';
  }
  close() {
    const frame = this.stack.pop();
    if (frame.kind === 'object') {
      frame.entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      for (const [key, hash] of frame.entries) frame.hash.update(JSON.stringify(key) + ':' + hash + ';');
      this.retainedKeys -= frame.keys.size; this.retainedKeyBytes -= frame.keyBytes;
    }
    this.complete(frame.value, frame.hash.digest('hex'), frame.path, this.offset + 1);
  }
  finishScalar() {
    const {path, keep} = this.scalar;
    let value;
    if (this.mode === 'number') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.literal)) this.bad();
      value = Number(this.literal);
      if (!Number.isFinite(value)) this.bad('JSON 数字必须有限。');
    } else {
      if (!['true', 'false', 'null'].includes(this.literal)) this.bad();
      value = JSON.parse(this.literal);
    }
    const hash = this.mode==='number'?numberHash(this.literal):digest(typeof value, JSON.stringify(value));
    this.complete(keep ? value : OMIT, hash, path, this.offset);
  }
  write(bytes) {
    let text;
    try { text = this.decoder.decode(bytes, {stream: true}); } catch { this.bad('请求不是有效的 UTF-8。'); }
    this.consume(text);
  }
  consume(text) {
    for (let i = 0; i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      const length = ch.length, byteLength = Buffer.byteLength(ch);
      if (this.mode === 'string') {
        if (this.escape.startsWith('u')) {
          if (!/^[a-fA-F0-9]$/.test(ch)) this.bad();
          this.escape += ch;
          if (this.escape.length === 5) {
            const code = parseInt(this.escape.slice(1), 16); this.escape = '';
            if (this.highSurrogate !== null) {
              if (code < 0xdc00 || code > 0xdfff) this.bad('JSON 包含无效的 Unicode。');
              this.append(String.fromCharCode(this.highSurrogate, code)); this.highSurrogate = null;
            } else if (code >= 0xd800 && code <= 0xdbff) this.highSurrogate = code;
            else if (code >= 0xdc00 && code <= 0xdfff) this.bad('JSON 包含无效的 Unicode。');
            else this.append(String.fromCharCode(code));
          }
        } else if (this.escape === '\\') {
          if (ch === 'u') this.escape = 'u';
          else {
            if (this.highSurrogate !== null) this.bad();
            const escaped = {'"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t'};
            if (!Object.hasOwn(escaped, ch)) this.bad();
            this.append(escaped[ch]); this.escape = '';
          }
        } else if (ch === '\\') this.escape = '\\';
        else if (this.highSurrogate !== null) this.bad('JSON 包含无效的 Unicode。');
        else if (ch === '"') {
          const s = this.scalar;
          if (s.key) {
            const frame = this.stack.at(-1);
            if (frame.keys.has(s.text)) this.bad('JSON 包含重复字段。');
            frame.keys.add(s.text); frame.keyBytes += s.size;
            this.retainedKeyBytes += s.size; this.retainedKeys++;
            if (this.retainedKeys*160+this.retainedKeyBytes*2 > 16*1024*1024) this.bad('记录结构过于复杂。');
            frame.key = s.text; this.mode = 'colon';
          } else this.complete(s.keep ? s.text : OMIT, s.hash.digest('hex'), s.path, this.offset + 1);
          this.scalar = null;
        } else if (ch.codePointAt(0) < 32) this.bad();
        else {
          // Process ordinary string runs in bulk, including huge base64 snapshots.
          const tail = text.slice(i), found = /["\\\x00-\x1f]/.exec(tail);
          const run = found ? tail.slice(0, found.index) : tail;
          this.append(run); i += run.length; this.offset += Buffer.byteLength(run); continue;
        }
      } else if (this.mode === 'number' || this.mode === 'literal') {
        if (/[\s,\]}]/.test(ch)) { this.finishScalar(); continue; }
        this.literal += ch;
        if (this.literal.length > 1024) this.bad('JSON 数字或常量过长。');
      } else if (/^[ \t\r\n]$/.test(ch)) { /* whitespace */ }
      else if (this.mode === 'done') this.bad('JSON 后存在额外内容。');
      else if (this.mode === 'colon') { if (ch !== ':') this.bad(); this.mode = 'value'; }
      else if (this.mode === 'key' || this.mode === 'key-or-end') {
        if (ch === '}' && this.mode === 'key-or-end') this.close();
        else if (ch === '"') this.string(this.path(), true, true);
        else this.bad();
      } else if (this.mode === 'comma-or-end') {
        const frame = this.stack.at(-1);
        if (ch === (frame.kind === 'object' ? '}' : ']')) this.close();
        else if (ch === ',') this.mode = frame.kind === 'object' ? 'key' : 'value';
        else this.bad();
      } else if (this.mode === 'value-or-end' && ch === ']') this.close();
      else this.start(ch);
      i += length; this.offset += byteLength;
    }
  }
  end() {
    try { this.consume(this.decoder.decode()); } catch (error) { if (error instanceof InputError) throw error; this.bad('请求不是有效的 UTF-8。'); }
    if (this.mode === 'number' || this.mode === 'literal') this.finishScalar();
    if (!this.ended || this.stack.length) this.bad('JSON 内容不完整。');
    return this.root;
  }
}

export async function readJSON(request, maximum = 8 * 1024 * 1024) {
  const parser = new ProjectedJSON(); let size = 0;
  if (!request.body) fail('请求不能为空。');
  for await (const bytes of request.body) {
    size += bytes.byteLength;
    if (size > maximum) fail('请求内容过大。', 413);
    parser.write(bytes);
  }
  const value = parser.end();
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求需为 JSON 对象。');
  return value;
}
