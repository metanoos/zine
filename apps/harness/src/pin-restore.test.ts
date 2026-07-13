import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restorePins } from './pin-restore.js';
import type { PinnedSpan } from './pins.js';

function pin(text: string, id = 'p1'): PinnedSpan {
  return { id, text, pinnedAt: 0 };
}

test('restorePins: survived pin is left untouched, no conflict', () => {
  const current =
    'The opening line is settled.\n' +
    'The middle is still being rewritten.\n' +
    'The closing line is also settled.';
  const modelOutput =
    'The opening line is settled.\n' +
    'The middle has been polished by the model.\n' +
    'The closing line is also settled.';
  const pins = [pin('The opening line is settled.')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  assert.equal(restored, modelOutput);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'survived');
});

test('restorePins: altered pin is restored to canonical text', () => {
  const current =
    'Intro paragraph here.\n\n' +
    'The title that must not change.\n\n' +
    'Outro paragraph here.';
  // The model rewrote the pinned title.
  const modelOutput =
    'Intro paragraph, lightly revised.\n\n' +
    'THE TITLE THAT MUST NOT CHANGE (altered).\n\n' +
    'Outro paragraph, lightly revised.';
  const pins = [pin('The title that must not change.')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  // Canonical text restored, model's altered version gone, surrounding
  // rewrites (context polishing) preserved.
  assert.ok(restored.includes('The title that must not change.'), 'canonical text restored');
  assert.ok(!restored.includes('THE TITLE THAT MUST NOT CHANGE (altered)'), 'altered version gone');
  assert.ok(restored.includes('Intro paragraph, lightly revised.'), 'surrounding rewrite preserved');
  assert.ok(restored.includes('Outro paragraph, lightly revised.'), 'surrounding rewrite preserved');
  assert.equal(results[0].outcome, 'restored');
});

test('restorePins: pin text absent from pre-rewrite file is a conflict, not silently injected', () => {
  // The file drifted: the pinned text is no longer in currentContent (an
  // external edit changed it). Must NOT guess where to reinsert it.
  const current = 'The file now says something else entirely.';
  const modelOutput = 'The file now says something else entirely, polished.';
  const pins = [pin('The title that must not change.')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  assert.equal(restored, modelOutput, 'conflict pin does not mutate output');
  assert.equal(results[0].outcome, 'conflict');
});

test('restorePins: two pins, one survived and one altered, handled independently', () => {
  const current =
    'First settled line.\n' +
    'Middle being rewritten.\n' +
    'Last settled line.';
  const modelOutput =
    'First settled line.\n' +
    'Middle has been rewritten by the model with extra words.\n' +
    'Last settled line.';
  const pins = [pin('First settled line.', 'a'), pin('Last settled line.', 'b')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  assert.equal(restored, modelOutput, 'both survived → no change');
  assert.equal(results.length, 2);
  assert.equal(results[0].outcome, 'survived');
  assert.equal(results[1].outcome, 'survived');
});

test('restorePins: no pins is a passthrough returning empty results', () => {
  const { restored, results } = restorePins('a', 'b', []);
  assert.equal(restored, 'b');
  assert.deepEqual(results, []);
});

test('restorePins: pin at start of file (no preceding context) restores', () => {
  const current =
    'Pinned opening.\n' +
    'The rest of the file follows from here.';
  const modelOutput =
    'PINNED OPENING (changed).\n' +
    'The rest of the file follows from here, polished.';
  const pins = [pin('Pinned opening.')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  assert.ok(restored.startsWith('Pinned opening.'), 'pin restored at start');
  assert.ok(!restored.includes('PINNED OPENING (changed)'));
  assert.equal(results[0].outcome, 'restored');
});

test('restorePins: pin whose neighborhood was deleted is a conflict', () => {
  const current =
    'Lead-in context for the pin.\n' +
    'The pinned line itself.\n' +
    'Lead-out context for the pin.\n' +
    'Unrelated tail.';
  // The model deleted the pin AND its surrounding context entirely.
  const modelOutput = 'Unrelated tail, polished.';
  const pins = [pin('The pinned line itself.')];

  const { restored, results } = restorePins(current, modelOutput, pins);

  assert.equal(restored, modelOutput, 'conflict does not inject text');
  assert.equal(results[0].outcome, 'conflict');
});
