import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { verifyReferenceProvenance } from '../public/modules/trust-protocol.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const time = '2026-10-03T12:00:00.000Z';
const metadata = () => ({ sourceKind: 'quranpedia-api', bookId: 1947, title: 'Recorded official book', url: 'https://api.quranpedia.net/v1/book/1947', retrievedAt: time, verificationStatus: 'verified', edition: 'طبعة الكتاب غير معلنة في قائمة المصدر' });
const sourceRow = (ayah = 1) => ({ surah: 112, ayah, rowNumber: ayah + 1, bookId: 1947, locator: `112:${ayah}`, translation: `Comparison text ${ayah}`, sourceURL: 'https://api.quranpedia.net/v1/translation/1947/112', retrievedAt: time, verificationStatus: 'verified', rawSha256: digest(`raw ${ayah}`), normalizedSha256: digest(`Comparison text ${ayah}`) });
const verify = input => verifyReferenceProvenance({ ...input, cryptoImpl: webcrypto });

test('official provenance consistency remains distinct from author, edition and scholarly approval', async () => {
  const result = await verify({ rows: [sourceRow()], metadata: metadata() });
  assert.equal(result.eligibleForComparison, true);
  assert.equal(result.canCompareText, true);
  assert.equal(result.recordedProvenanceConsistent, true);
  assert.equal(result.trustedSourceProvenance, false);
  assert.equal(result.rows[0].verificationStatus, 'verified');
  assert.equal(result.metadata.authorStatus, 'unknown');
  assert.equal(result.metadata.editionStatus, 'unknown');
  assert.equal(result.metadata.publisherEdition, null);
  assert.equal(result.metadata.scholarlyVerificationStatus, 'unknown');
  assert.equal(result.metadata.scholarlyApproval, 'none');
  assert.equal(result.metadata.transportVerifiedByThisProtocol, false);
  assert.match(result.metadata.trustLimitations, /لا تثبت/);
  assert.equal(result.rows[0].rawHashVerification, 'format-only');
  assert.equal(result.rows[0].provenanceChecks.normalizedHashRecomputed, true);
  assert.equal(result.rows[0].allowNoSignal, false);
});

test('checkbox-verified upload with a forged URL/hash never becomes certified', async () => {
  const result = await verify({ rows: [{ ...sourceRow(), sourceKind: 'user-upload', rawSha256: 'forged-hash' }], metadata: { ...metadata(), sourceKind: 'user-upload', url: 'https://fake.example/source', scholarlyApproval: 'approved by scholar' } });
  assert.equal(result.eligibleForComparison, true);
  assert.equal(result.canCompareText, true);
  assert.equal(result.recordedProvenanceConsistent, false);
  assert.equal(result.metadata.verificationStatus, 'unverified');
  assert.equal(result.rows[0].verificationStatus, 'unverified');
  assert.equal(result.rows[0].comparisonEligibility, 'experimental-text-comparison-only');
  assert.equal(result.rows[0].allowNoSignal, false);
  assert.equal(result.metadata.authorityStatus, 'user-declared');
  assert.equal(result.metadata.scholarlyApproval, 'none');
});

test('lookalike origins, HTTP, credentials, and incompatible book paths fail', async () => {
  for (const url of ['http://api.quranpedia.net/v1/book/1947', 'https://api.quranpedia.net.fake.example/v1/book/1947', 'https://user@api.quranpedia.net/v1/book/1947', 'https://api.quranpedia.net/v1/book/1948']) {
    const result = await verify({ rows: [sourceRow()], metadata: { ...metadata(), url } });
    assert.equal(result.recordedProvenanceConsistent, false, url);
    assert.equal(result.canCompareText, true, 'valid text remains inspectable experimentally');
    assert.ok(result.checks.some(check => check.code === 'official_book_locator_invalid'));
  }
});

test('a correctly shaped hash for different text fails recomputation', async () => {
  const row = { ...sourceRow(), normalizedSha256: digest('Another text') };
  const result = await verify({ rows: [row], metadata: metadata() });
  assert.equal(result.recordedProvenanceConsistent, false);
  assert.ok(result.rows[0].provenanceChecks.failures.includes('normalized_hash_mismatch'));
});

test('partial reference defects do not suppress valid independent rows', async () => {
  const result = await verify({ rows: [sourceRow(1), { ...sourceRow(2), rawSha256: 'made-up' }], metadata: metadata() });
  assert.equal(result.eligibleForComparison, true);
  assert.deepEqual(result.rows.map(row => row.verificationStatus), ['verified', 'unverified']);
  assert.equal(result.metadata.verificationStatus, 'verified');
  assert.deepEqual(result.metadata.trustSummary, { eligibleRows: 1, ineligibleRows: 1, partial: true, inspectableRows: 2 });
  assert.ok(result.checks.some(check => check.scope === 'row' && check.rowNumber === 3 && check.code === 'raw_hash_invalid'));
});

test('verse locator, URL book/surah, per-row book, and timestamp mismatches fail', async () => {
  const alterations = [{ locator: '112:2' }, { sourceURL: 'https://api.quranpedia.net/v1/translation/1948/112' }, { sourceURL: 'https://api.quranpedia.net/v1/translation/1947/113' }, { bookId: 1948 }, { retrievedAt: 'yesterday' }, { sourceKind: 'user-upload' }, { ayah: 5 }];
  for (const altered of alterations) {
    const result = await verify({ rows: [{ ...sourceRow(), ...altered }], metadata: metadata() });
    assert.equal(result.recordedProvenanceConsistent, false, JSON.stringify(altered));
  }
});

test('missing bibliographic data is unknown, and populated data remains recorded but unchecked', async () => {
  const invalid = await verify({ rows: [sourceRow()], metadata: { ...metadata(), author: {}, edition: {}, publisher: 'unknown' } });
  assert.equal(invalid.metadata.authorStatus, 'unknown');
  assert.equal(invalid.metadata.editionStatus, 'unknown');
  assert.equal(invalid.metadata.publisherStatus, 'unknown');
  assert.ok(invalid.checks.some(check => check.code === 'edition_unknown'));
  const recorded = await verify({ rows: [sourceRow()], metadata: { ...metadata(), author: 'Recorded author', publisher: 'Recorded publisher', edition: 'Third edition' } });
  assert.equal(recorded.metadata.authorStatus, 'recorded-unchecked');
  assert.equal(recorded.metadata.editionStatus, 'recorded-unchecked');
  assert.equal(recorded.metadata.scholarlyApproval, 'none');
});

test('raw text presence enables recomputation; a raw mismatch cannot hide behind a valid normalized hash', async () => {
  const row = { ...sourceRow(), rawText: 'Raw response markup', rawSha256: digest('Raw response markup') };
  const valid = await verify({ rows: [row], metadata: metadata() });
  assert.equal(valid.eligibleForComparison, true);
  assert.equal(valid.rows[0].rawHashVerification, 'recomputed');
  const invalid = await verify({ rows: [{ ...row, rawText: 'Modified raw response' }], metadata: metadata() });
  assert.equal(invalid.recordedProvenanceConsistent, false);
  assert.ok(invalid.rows[0].provenanceChecks.failures.includes('raw_hash_mismatch'));
});

test('synthetic teaching requires the declaration and explicit prefix on every row', async () => {
  const rows = [{ surah: 112, ayah: 1, translation: 'SYNTHETIC TRAINING TEXT record 1' }, { surah: 112, ayah: 2, translation: 'SYNTHETIC TRAINING TEXT record 2' }];
  const source = { sourceKind: 'synthetic-teaching', synthetic: true };
  const valid = await verify({ rows, metadata: source });
  assert.equal(valid.eligibleForComparison, true);
  assert.equal(valid.metadata.authorityStatus, 'authored-teaching-only');
  assert.ok(valid.rows.every(row => row.scholarlyApproval === 'none' && row.comparisonEligibility === 'teaching-inspection-only'));
  const undeclared = await verify({ rows, metadata: { sourceKind: 'synthetic-teaching' } });
  assert.equal(undeclared.recordedProvenanceConsistent, false);
  const mixed = await verify({ rows: [...rows, { translation: 'Unlabeled source or religious quotation' }], metadata: source });
  assert.equal(mixed.recordedProvenanceConsistent, false);
  assert.ok(mixed.rows.every(row => row.verificationStatus === 'unverified'));
});

test('source inputs are preserved and metadata cannot declare scholarly certification', async () => {
  const input = { rows: [sourceRow()], metadata: { ...metadata(), scholarlyApproval: 'approved', scholarlyVerificationStatus: 'verified' } };
  const before = JSON.stringify(input);
  const result = await verify(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.metadata.scholarlyApproval, 'none');
  assert.equal(result.metadata.scholarlyVerificationStatus, 'unknown');
});

test('hash verification cannot silently succeed when WebCrypto is unavailable', async () => {
  const result = await verifyReferenceProvenance({ rows: [sourceRow()], metadata: metadata(), cryptoImpl: {} });
  assert.equal(result.recordedProvenanceConsistent, false);
  assert.ok(result.checks.some(check => check.code === 'hash_recomputation_unavailable'));
  assert.equal(result.rows[0].provenanceChecks.normalizedHashRecomputed, false);
});

test('unverified, same-publisher local text is inspectable without certification or no_signal', async () => {
  const row = { surah: 112, ayah: 1, translation: 'Previous publisher text.' };
  const result = await verify({ rows: [row], metadata: { sourceKind: 'user-upload', author: 'Publisher-declared translator', edition: 'Publisher-declared previous edition', verificationStatus: 'verified' } });
  assert.equal(result.canCompareText, true);
  assert.equal(result.eligibleForComparison, true);
  assert.equal(result.recordedProvenanceConsistent, false);
  assert.equal(result.rows[0].verificationStatus, 'unverified');
  assert.equal(result.rows[0].allowNoSignal, false);
  assert.equal(result.metadata.editionStatus, 'recorded-unchecked');
});

test('duplicate and empty reference pairs cannot be selected for text comparison', async () => {
  const duplicates = await verify({ rows: [sourceRow(), sourceRow()], metadata: metadata() });
  assert.equal(duplicates.canCompareText, false);
  assert.equal(duplicates.recordedProvenanceConsistent, false);
  assert.ok(duplicates.checks.some(check => check.code === 'comparison_id_duplicate'));
  const empty = await verify({ rows: [{ ...sourceRow(), translation: '' }], metadata: metadata() });
  assert.equal(empty.canCompareText, false);
  assert.equal(empty.rows[0].provenanceChecks.normalizedHashRecomputed, false);
});

test('failed hash computation becomes per-row evidence, not an aborted audit', async () => {
  const result = await verifyReferenceProvenance({ rows: [sourceRow()], metadata: metadata(), cryptoImpl: { subtle: { digest: async () => { throw new Error('disabled'); } } } });
  assert.equal(result.canCompareText, true);
  assert.equal(result.recordedProvenanceConsistent, false);
  assert.equal(result.rows[0].provenanceChecks.normalizedHashRecomputed, false);
});

test('self-consistent forged JSON cannot acquire actual transport or scholarly authority', async () => {
  const translation = 'A deliberately fabricated source text.';
  const row = { ...sourceRow(), translation, normalizedSha256: digest(translation), trustedSourceProvenance: true, allowNoSignal: true, scholarlyApproval: 'fabricated approval' };
  const forged = { ...metadata(), author: 'Fabricated author', edition: 'Fabricated edition', trustedSourceProvenance: true, transportVerifiedByThisProtocol: true, scholarlyApproval: 'fabricated approval' };
  const result = await verify({ rows: [row], metadata: forged });
  // Payload shape is consistent; only an actual HTTPS client can bind retrieval.
  assert.equal(result.recordedProvenanceConsistent, true);
  assert.equal(result.trustedSourceProvenance, false);
  assert.equal(result.rows[0].trustedSourceProvenance, false);
  assert.equal(result.rows[0].allowNoSignal, false);
  assert.equal(result.metadata.transportVerifiedByThisProtocol, false);
  assert.equal(result.metadata.authorStatus, 'recorded-unchecked');
  assert.equal(result.metadata.scholarlyApproval, 'none');
});
