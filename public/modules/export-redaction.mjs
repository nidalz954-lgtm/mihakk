/** Live reference text stays with its provider: exports keep locators, hashes and results, never the text. */
const TEXT_KEYS = new Set(['referenceExcerpt','referenceText','referenceTranslation','referenceNegations','removedTokens','footnotes','rawHTML','rawText','rawTranslation','rawResponse','rawPayload','rawProof']);
// Lists whose items are fragments cut from the reference text (numbers, markers).
const REFERENCE_FRAGMENT_LISTS = new Set(['referenceQuantities','referenceMarkers']);

function scrub(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && item.role === 'reference' && 'text' in item) { delete item.text; item.textOmittedFromExport = true; }
      scrub(item);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (TEXT_KEYS.has(key)) { delete value[key]; value.referenceTextOmittedFromExport = true; continue; }
    if (REFERENCE_FRAGMENT_LISTS.has(key) && Array.isArray(value[key])) {
      for (const item of value[key]) if (item && typeof item === 'object' && 'text' in item) { delete item.text; item.textOmittedFromExport = true; }
    }
    scrub(value[key]);
  }
}

/** Returns a redacted copy for live (Quranpedia) sources; other sources are returned as a plain copy. */
export function redactLiveReferenceText(report) {
  const copy = structuredClone(report);
  if (copy?.provenance?.reference?.sourceKind !== 'quranpedia-api') return copy;
  copy.provenance.reference.exportNote = 'Live reference text omitted. Source locators, retrieval timestamps, fingerprints and review results retained; use source URLs to consult the original.';
  for (const row of copy.rows || []) {
    if (row.reference) { delete row.reference.translation; row.reference.textOmittedFromExport = true; }
    scrub(row);
  }
  for (const finding of copy.findings || []) scrub(finding);
  return copy;
}
