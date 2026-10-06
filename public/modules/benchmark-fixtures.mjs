/**
 * Original, NONRELIGIOUS development examples authored for this project.
 * These are not Quran translations, independent gold labels, or expert review.
 * Keep all cases visible, including false positives, misses and abstentions.
 */
export const BENCHMARK_DATASET = Object.freeze({
  id: 'mihakk-context-dev-18-v1',
  label: 'Authored nonreligious development fixtures',
  license: 'MIT',
  developmentFixture: true,
  independentDomainValidation: false,
  religiousText: false,
  expectedKnownRiskCases: 8,
  expectedKnownSafeCases: 8,
  expectedUnknownCases: 2,
  caveat: 'Author-assigned software-test expectations; not independent linguistic or religious validation. No threshold tuning on these cases followed by a claim of held-out performance.',
});

export const BENCHMARK_CASES = Object.freeze([
  { id: 'role-1', type: 'relational_swap', premise: 'Alice lends a bicycle to Bob. Bob does not lend a bicycle to Alice.', hypothesis: 'Bob lends a bicycle to Alice. Alice does not lend a bicycle to Bob.', expectedRisk: true, expected: 'risk', explanation: 'The named lender and recipient are reversed despite shared vocabulary.' },
  { id: 'role-2', type: 'relational_swap', premise: 'The nurse helps the teacher, and the teacher does not help the nurse.', hypothesis: 'The teacher helps the nurse, and the nurse does not help the teacher.', expectedRisk: true, expected: 'risk', explanation: 'The direction of the action and the associated negation change.' },
  { id: 'scope-1', type: 'negation_scope', premise: 'Alice does not approve Bob but Bob approves Alice.', hypothesis: 'Alice approves Bob but Bob does not approve Alice.', expectedRisk: true, expected: 'risk', explanation: 'The same words express a different scope for negation.' },
  { id: 'scope-2', type: 'negation_scope', premise: 'The manager did not sign the contract, but the assistant signed it.', hypothesis: 'The manager signed the contract, but the assistant did not sign it.', expectedRisk: true, expected: 'risk', explanation: 'The person excluded by negation changes.' },
  { id: 'negative-1', type: 'negation_change', premise: 'The museum is open on Monday.', hypothesis: 'The museum is not open on Monday.', expectedRisk: true, expected: 'risk', explanation: 'An explicit affirmation becomes a negation.' },
  { id: 'negative-2', type: 'negation_change', premise: 'The student never submitted the report.', hypothesis: 'The student submitted the report.', expectedRisk: true, expected: 'risk', explanation: 'The explicit negation is removed.' },
  { id: 'omission-1', type: 'information_omission', premise: 'The package contains a book and a red pen.', hypothesis: 'The package contains a book.', expectedRisk: true, expected: 'risk', explanation: 'One explicitly asserted item is absent; this is a review signal, not proof that shorter phrasing is always wrong.' },
  { id: 'omission-2', type: 'information_omission', premise: 'Maya arrived on Tuesday and brought the signed form.', hypothesis: 'Maya arrived on Tuesday.', expectedRisk: true, expected: 'risk', explanation: 'The asserted delivery of a form is absent.' },
  { id: 'paraphrase-1', type: 'legitimate_paraphrase', premise: 'The child is riding a bicycle.', hypothesis: 'A child is cycling.', expectedRisk: false, expected: 'no_signal', explanation: 'An ordinary contextual paraphrase.' },
  { id: 'paraphrase-2', type: 'legitimate_paraphrase', premise: 'The meeting begins at nine in the morning.', hypothesis: 'The meeting starts at 9 a.m.', expectedRisk: false, expected: 'no_signal', explanation: 'Equivalent time notation and ordinary synonyms.' },
  { id: 'paraphrase-3', type: 'legitimate_paraphrase', premise: 'The door was closed by Nora.', hypothesis: 'Nora closed the door.', expectedRisk: false, expected: 'no_signal', explanation: 'Passive and active phrasing preserve the named role.' },
  { id: 'paraphrase-4', type: 'legitimate_paraphrase', premise: 'The train reached the station before noon.', hypothesis: 'The train arrived at the station prior to midday.', expectedRisk: false, expected: 'no_signal', explanation: 'Ordinary synonyms preserve the event and timing.' },
  { id: 'same-1', type: 'identical', premise: 'The archive contains three folders.', hypothesis: 'The archive contains three folders.', expectedRisk: false, expected: 'no_signal', explanation: 'Identical text is included in this benchmark to verify model behavior, though routine batch inference skips it.' },
  { id: 'same-2', type: 'identical', premise: 'The laboratory did not open on Sunday.', hypothesis: 'The laboratory did not open on Sunday.', expectedRisk: false, expected: 'no_signal', explanation: 'Identical explicit negation.' },
  { id: 'preserved-1', type: 'role_preserving_rephrase', premise: 'Alice gave the key to Bob.', hypothesis: 'Bob received the key from Alice.', expectedRisk: false, expected: 'no_signal', explanation: 'Verb direction changes while the giver and recipient remain the same.' },
  { id: 'preserved-2', type: 'role_preserving_rephrase', premise: 'The artist painted the portrait of the doctor.', hypothesis: 'The portrait of the doctor was painted by the artist.', expectedRisk: false, expected: 'no_signal', explanation: 'The same roles are preserved across passive phrasing.' },
  { id: 'unknown-1', type: 'unknown_context', premise: 'Alex went to the bank.', hypothesis: 'Alex waited beside the river bank.', expectedRisk: null, expected: 'abstain', explanation: 'The sense of bank is underspecified; do not invent the missing context.' },
  { id: 'unknown-2', type: 'unknown_context', premise: 'Sam visited a friend.', hypothesis: 'Sam visited Jordan.', expectedRisk: null, expected: 'abstain', explanation: 'The premise does not identify the friend or specify whether Jordan is a person or place.' },
].map(Object.freeze));
