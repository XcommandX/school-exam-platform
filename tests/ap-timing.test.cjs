'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const M = require('../apps/ap/ap-model.js');
const fixture = require('../apps/ap/examples/synthetic-practice.json');
const now = Date.UTC(2026, 9, 26);
const section = type => ({ ...M.validateSource(fixture), questions: fixture.questions.filter(q => q.type === type) });
const mcq = section('mcq'), frq = section('free-response');
const draft = (source = frq, timed = true) => M.createDraft(source, now, 'ap-attempt:clock', timed);
test('official sections are 60 and 135 minutes; reading is inside FRQ total', () => {
  assert.deepEqual(M.timingProfile(mcq), { durationSeconds: 3600, readingSeconds: 0, label: 'MCQ · 60 分钟' });
  assert.equal(M.timingProfile(frq).durationSeconds, 8100);
  assert.equal(M.timingProfile(frq).readingSeconds, 900);
  assert.equal(M.timingProfile({ ...mcq, questions: [mcq.questions[0]], defaultDurationSeconds: 999 }).durationSeconds, 3600);
  assert.equal(M.timingProfile({ ...frq, questions: [] }).durationSeconds, 0);
  assert.match(M.timingProfile(fixture).label, /非官方整卷/);
});
test('clock reconciles throttled ticks and reload anchors without double-counting', () => {
  const value = draft();
  M.advanceTiming(value, now + 1500);
  assert.equal(value.elapsedSeconds, 1);
  const restored = M.restoreDraft(frq, JSON.parse(JSON.stringify(value)));
  M.advanceTiming(restored, now + 900000);
  assert.equal(restored.elapsedSeconds, 900);
  M.advanceTiming(restored, now + 900000);
  assert.equal(restored.elapsedSeconds, 900);
  M.advanceTiming(restored, now - 1000);
  assert.equal(restored.elapsedSeconds, 900);
});
test('FRQ changes phase at 15 minutes and expires at 135, never auto-completes', () => {
  const value = draft();
  M.advanceTiming(value, now + 899000);
  assert.equal(M.timerStatus(value).phase, '阅读阶段');
  M.advanceTiming(value, now + 900000);
  assert.equal(M.timerStatus(value).phase, '写作阶段');
  assert.equal(M.timerStatus(value).remaining, 7200);
  M.advanceTiming(value, now + 8100000);
  assert.equal(M.timerStatus(value).expired, true);
  assert.equal(M.timerStatus(value).remaining, 0);
  M.advanceTiming(value, now + 8200000);
  assert.equal(M.timerStatus(value).remaining, 0);
  assert.equal(value.status, 'in-progress');
});
test('explicit pause survives reload; resume never charges paused interval', () => {
  const value = draft(mcq);
  M.advanceTiming(value, now + 30000);
  value.timing.paused = true;
  const restored = M.restoreDraft(mcq, value);
  M.advanceTiming(restored, now + 600000);
  assert.equal(restored.elapsedSeconds, 30);
  restored.timing.paused = false;
  restored.timing.anchorAt = now + 600000;
  M.advanceTiming(restored, now + 605000);
  assert.equal(restored.elapsedSeconds, 35);
});
test('free practice tracks elapsed without expiry, clock settings survive completion', () => {
  const value = draft(mcq, false);
  M.advanceTiming(value, now + 4000000);
  assert.equal(M.timerStatus(value).expired, false);
  assert.equal(M.timerStatus(value).phase, '自由练习');
  const record = M.finish(mcq, value, now + 4000000);
  assert.deepEqual(M.normalizeRecord(record), record);
  assert.equal(record.timing.durationSeconds, 3600);
});
test('legacy drafts and records remain readable without timing metadata', () => {
  const value = draft(); delete value.timing;
  assert.deepEqual(M.restoreDraft(frq, value), value);
  const record = M.finish(frq, value, now + 1000);
  assert.deepEqual(M.normalizeRecord(record), record);
});
test('malformed clock data is rejected without accepting negative or unbounded times', () => {
  for (const change of [{ durationSeconds: -1 }, { durationSeconds: 0 }, { durationSeconds: 86401 }, { readingSeconds: 9000 }, { paused: 'yes' }, { anchorAt: 0 }, { anchorAt: now - 1 }]) {
    const value = draft(); Object.assign(value.timing, change);
    assert.equal(M.normalizeDraft(value), null);
  }
});
