import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SURAH_AYAH_COUNTS} from '../src/quran-index.mjs';

// Pins every surah count (Kufan counting, Tanzil metadata 1.0): swapping two counts must fail.
test('verse index has 114 surahs, 6236 verses and the exact per-surah counts', () => {
  assert.equal(SURAH_AYAH_COUNTS.length, 114);
  assert.equal(SURAH_AYAH_COUNTS.reduce((sum, count) => sum + count, 0), 6236);
  assert.deepEqual([SURAH_AYAH_COUNTS[0], SURAH_AYAH_COUNTS[1], SURAH_AYAH_COUNTS[8], SURAH_AYAH_COUNTS[111], SURAH_AYAH_COUNTS[113]], [7, 286, 129, 4, 6]);
  assert.equal(createHash('sha256').update(SURAH_AYAH_COUNTS.join(',')).digest('hex'), 'cf0ec4a35ad191454cb75480d9e3aa008cd482b1b2998378aee3ea420b351cd5');
});
