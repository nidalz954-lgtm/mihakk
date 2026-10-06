/** A conservative script gate, not automatic English language identification. */
export const CONTEXT_LANGUAGE_GUARD = Object.freeze({
  method: 'latin-script-only-conservative/v1',
  detectsEnglish: false,
  limitation: 'English is user-declared. Latin text may be another language; mixed-script English is conservatively excluded.',
});

export function inspectContextScript(text) {
  const letters = typeof text === 'string' ? [...text.matchAll(/\p{L}/gu)].map(match => match[0]) : [];
  const nonLatinLetters = letters.filter(letter => !/\p{Script_Extensions=Latin}/u.test(letter)).length;
  return {
    compatible: letters.length > 0 && nonLatinLetters === 0,
    reason: !letters.length ? 'no_letter_evidence' : nonLatinLetters ? 'non_latin_letters' : 'latin_script_only',
    letters: letters.length, nonLatinLetters,
    detectsEnglish: false,
  };
}

export function inspectContextPair(reference, candidate) {
  const premise = inspectContextScript(reference), hypothesis = inspectContextScript(candidate);
  return { ...CONTEXT_LANGUAGE_GUARD, compatible: premise.compatible && hypothesis.compatible, reference: premise, candidate: hypothesis };
}

// Multilingual model gate: both texts must be in the SAME declared language and written in that language's script.
// Cross-language pairs (for example a translation against the Arabic Quran text) are never sent to the model.
const SCRIPT_BY_LANGUAGE = Object.freeze({
  en: 'Latin', fr: 'Latin', es: 'Latin', id: 'Latin', tr: 'Latin', de: 'Latin', it: 'Latin', pt: 'Latin', nl: 'Latin', sw: 'Latin', ms: 'Latin',
  ar: 'Arabic', ur: 'Arabic', fa: 'Arabic', ps: 'Arabic',
  ru: 'Cyrillic', uk: 'Cyrillic',
});
export const MULTILINGUAL_CONTEXT_LANGUAGES = Object.freeze(Object.keys(SCRIPT_BY_LANGUAGE));
export const MULTILINGUAL_LANGUAGE_GUARD = Object.freeze({
  method: 'declared-same-language-script-gate/v1',
  detectsLanguage: false,
  limitation: 'Both languages are user-declared and must match. The gate only checks that letters belong to the declared language\'s script; it does not identify the language. Cross-language pairs are never compared.',
});
const SCRIPT_PATTERN = { Latin: /\p{Script_Extensions=Latin}/u, Arabic: /\p{Script_Extensions=Arabic}/u, Cyrillic: /\p{Script_Extensions=Cyrillic}/u };

export function inspectScriptForLanguage(text, language) {
  const script = SCRIPT_BY_LANGUAGE[language];
  const letters = typeof text === 'string' ? [...text.matchAll(/\p{L}/gu)].map(match => match[0]) : [];
  if (!script) return { compatible: false, reason: 'unsupported_language', letters: letters.length, outsideScriptLetters: null, expectedScript: null, detectsLanguage: false };
  const outside = letters.filter(letter => !SCRIPT_PATTERN[script].test(letter)).length;
  return {
    compatible: letters.length > 0 && outside === 0,
    reason: !letters.length ? 'no_letter_evidence' : outside ? 'letters_outside_declared_script' : 'declared_script_only',
    letters: letters.length, outsideScriptLetters: outside, expectedScript: script, detectsLanguage: false,
  };
}

export function inspectContextPairForLanguage(language, reference, candidate) {
  const premise = inspectScriptForLanguage(reference, language), hypothesis = inspectScriptForLanguage(candidate, language);
  return { ...MULTILINGUAL_LANGUAGE_GUARD, language, compatible: premise.compatible && hypothesis.compatible, reference: premise, candidate: hypothesis };
}
