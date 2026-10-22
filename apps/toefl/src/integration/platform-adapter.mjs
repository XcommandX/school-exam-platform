// Draft mappings for docs/architecture.md. These are not published API routes.
// The caller must obtain context.userId from a validated server-side identity;
// values from request JSON, query strings or arbitrary headers are not trusted.
export const contractVersion = 'toefl-intake-draft-1';
const id = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new TypeError('Invalid identifier');
  return value;
};
const moduleName = value => {
  if (!/^(reading-t[123]|listening-t[1234]|speaking-t[12]|writing-t[123])$/.test(value)) throw new TypeError('Unknown TOEFL module');
  return value;
};
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
};
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), b => b.toString(16).padStart(2, '0')).join('');
const timestamp = value => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Number.isNaN(new Date(value).getTime())) throw new TypeError('Invalid UTC timestamp');
  return new Date(value).toISOString();
};

export async function mapQuestion(record) {
  const sourceId = id(record.id), module = moduleName(record.module);
  if (!Array.isArray(record.items) || !record.items.length) throw new TypeError('Question items are required');
  const seen = new Set();
  for (const item of record.items) {
    const itemId = id(item.id);
    if (seen.has(itemId)) throw new TypeError('Duplicate item identifier');
    seen.add(itemId);
  }
  return {
    contractVersion, examType: 'toefl',
    questionId: `toefl:${module}:${encodeURIComponent(sourceId)}`,
    questionVersion: 'sha256:' + await digest(record),
    source: { provider: id(record.source), module, id: sourceId },
    legacyKey: `${module}:${sourceId}`,
    occurrenceDates: [...(record.occurrenceDates || [])],
    payload: structuredClone(record)
  };
}

export async function mapAttempt(attempt, context, questions) {
  const userId = id(context?.userId), attemptId = id(attempt.id);
  const revision = context.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('A nonnegative revision is required');
  if (!Array.isArray(attempt.queue) || !attempt.queue.length) throw new TypeError('Attempt queue is required');
  const lookup = new Map(questions.map(q => [q.legacyKey, q]));
  const references = attempt.queue.map(key => {
    const question = lookup.get(key);
    if (!question) throw new TypeError(`Unresolved question reference: ${key}`);
    return { legacyKey: key, questionId: question.questionId, questionVersion: question.questionVersion };
  });
  const finishedAt = timestamp(attempt.finished);
  return {
    contractVersion, examType: 'toefl', userId,
    attemptId: `toefl:${encodeURIComponent(attemptId)}`,
    status: finishedAt === null ? 'in_progress' : 'submitted',
    startedAt: timestamp(attempt.started), finishedAt, revision,
    idempotencyKey: 'toefl:' + await digest({ userId, attemptId, revision }),
    questions: references,
    // Retain the original snapshot during a future migration. Objective scores
    // inside it are client-reported until a server recalculates them.
    scoreAuthority: 'client_reported',
    legacy: structuredClone(attempt)
  };
}
