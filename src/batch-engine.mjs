import {
  INDEX_PROVENANCE, SURAH_AYAH_COUNTS, isValidVerseId, normalizeDigits,
  normalizeScope, strictInteger, verseOrdinal,
} from './quran-index.mjs';

/**
 * Browser-compatible full-file structural audit and transparent lexical triage.
 * These rules do NOT evaluate religious correctness, translation quality, or
 * semantic equivalence. "no_signal" is not approval. Human review is required.
 * No network calls, trained-model claims, or religious text corpus are hidden
 * in this module. Optional model findings must be appended separately.
 */
export const BATCH_SCHEMA_VERSION = 'mihakk-batch/1';
const MAX_ROWS = 100000;
const FORMAT_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const ENGLISH_NEGATIONS = new Set([
  'no', 'not', 'never', 'neither', 'nor', 'without', 'cannot', "can't", "don't",
  "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "won't",
  "wouldn't", "shouldn't", "couldn't", "mustn't", "hasn't", "haven't", "hadn't",
]);
const ARABIC_NEGATIONS = new Set(['لا', 'ليس', 'ليست', 'لم', 'لن', 'بدون', 'ولا', 'فلا', 'ولم', 'فلم', 'ولن', 'فلن', 'وليس', 'فليس', 'وليست', 'فليست', 'لست', 'لسنا', 'لستم', 'لستما', 'لستن', 'ليسا', 'ليستا', 'ليسوا', 'لسن', 'ولست', 'فلست', 'ولسنا', 'فلسنا', 'ولستم', 'فلستم', 'وليسا', 'فليسا', 'وليسوا', 'فليسوا', 'ولسن', 'فلسن']);
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['\u2019][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;
// Compare Arabic vocalization and tatweel consistently while keeping offsets
// into the original text. Preserve accents in other scripts (e.g. French).
function tokenValue(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\u2019/g, "'");
  return /\p{Script=Arabic}/u.test(normalized)
    ? normalized.replace(/[\p{M}\u0640]/gu, '')
    : normalized;
}

function meaningfulText(text) { return text.replace(FORMAT_CONTROLS, '').trim(); }
function textValue(value) { return typeof value === 'string' ? value : ''; }
function languageBase(value) {
  const language = String(value ?? '').trim().toLowerCase();
  if (language === 'english') return 'en';
  if (language === 'arabic' || language === 'العربية') return 'ar';
  return language.split(/[-_]/)[0];
}
function tokens(text) {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => ({
    value: tokenValue(match[0]),
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
}
function normalizedText(text) { return tokens(text).map((token) => token.value).join(' '); }

// Bounded quantity inventory, not a meaning model. Offsets always address the
// original string. Exact rational arithmetic avoids decimal conversion drift.
const QUANTITY_TOKEN = /[+\-\u2212]?\p{Nd}+(?:[.,\u066b\u066c]\p{Nd}+)*(?:[eE][+\-]?\p{Nd}+)?|[\p{L}][\p{L}\p{M}\p{N}]*(?:['\u2019][\p{L}\p{M}]*)*|[%\u066a]|\S/gu;
const SMALL_EN = new Map(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'].map((word, value) => [word,value]));
const TENS_EN = new Map(['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].map((word,index) => [word,(index+2)*10]));
const CARDINAL_AR = new Map([
  ['صفر',0],['واحد',1],['واحدة',1],['اثنان',2],['اثنين',2],['اثنتان',2],['اثنتين',2],
  ['ثلاثة',3],['ثلاث',3],['أربعة',4],['اربعة',4],['أربع',4],['اربع',4],['خمسة',5],['خمس',5],
  ['ستة',6],['ست',6],['سبعة',7],['سبع',7],['ثمانية',8],['ثمان',8],['ثماني',8],['تسعة',9],['تسع',9],
  ['عشرة',10],['عشر',10],['عشرون',20],['عشرين',20],['ثلاثون',30],['ثلاثين',30],['أربعون',40],['اربعون',40],['أربعين',40],['اربعين',40],
  ['خمسون',50],['خمسين',50],['ستون',60],['ستين',60],['سبعون',70],['سبعين',70],['ثمانون',80],['ثمانين',80],['تسعون',90],['تسعين',90],
  ['مئة',100],['مائة',100],['ألف',1000],['الف',1000],
]);
const UNSUPPORTED_CARDINAL_EN = new Set(['half','halves','quarter','quarters','dozen','million','millions','billion','billions','trillion','trillions']);
const UNSUPPORTED_CARDINAL_AR = new Set(['أحد','احد','إحدى','احدى','اثنا','اثني','اثنتا','اثنتي','نصف','ثلث','ربع','مليون','ملايين','مليار','مليارات']);
const QUANTITY_UNITS = new Map();
function defineQuantityUnit(aliases, dimension, numerator, denominator = 1) {
  for (const alias of aliases.split('|')) QUANTITY_UNITS.set(tokenValue(alias),{ dimension, numerator:BigInt(numerator), denominator:BigInt(denominator) });
}
defineQuantityUnit('mm|millimeter|millimeters|millimetre|millimetres|ملليمتر|مليمتر','length',1,1000);
defineQuantityUnit('cm|centimeter|centimeters|centimetre|centimetres|سنتيمتر','length',1,100);
defineQuantityUnit('m|meter|meters|metre|metres|متر|أمتار|امتار','length',1);
defineQuantityUnit('km|kilometer|kilometers|kilometre|kilometres|كيلومتر|كيلومترات','length',1000);
defineQuantityUnit('mg|milligram|milligrams|مليغرام|ملليغرام','mass',1,1000);
defineQuantityUnit('g|gram|grams|غرام|جرام','mass',1);
defineQuantityUnit('kg|kilogram|kilograms|كيلوغرام|كيلوجرام|كغ','mass',1000);
defineQuantityUnit('ml|milliliter|milliliters|millilitre|millilitres|مليلتر|ملليلتر','volume',1,1000);
defineQuantityUnit('l|liter|liters|litre|litres|لتر|لترات','volume',1);
defineQuantityUnit('s|second|seconds|ثانية|ثوان|ثواني','duration',1);
defineQuantityUnit('minute|minutes|دقيقة|دقائق','duration',60);
defineQuantityUnit('hour|hours|ساعة|ساعات','duration',3600);
defineQuantityUnit('day|days|يوم|أيام|ايام','duration',86400);
defineQuantityUnit('%|٪|percent|percentage|بالمئة|بالمائة','percent',1);
const UNSUPPORTED_UNITS = new Set(['pound','pounds','lb','lbs','ounce','ounces','oz','inch','inches','foot','feet','yard','yards','mile','miles','cup','cups','celsius','fahrenheit','square','cubic','sqm','sqft','درجة','درجات','فهرنهايت','مئوية','مربع','مكعب']);
const APPROXIMATE_QUANTITY = new Set(['about','approximately','around','roughly','nearly','almost','circa','حوالي','تقريبا','نحو','قرابة']);
const QUANTITY_SYMBOL_CASE = new Map([['mm',['mm']],['cm',['cm']],['m',['m']],['km',['km']],['mg',['mg']],['g',['g']],['kg',['kg']],['ml',['ml','mL']],['l',['l','L']],['s',['s']]]);
function unsupportedQuantityUnit(value) {return UNSUPPORTED_UNITS.has(value)||/^(?:mm|cm|m|km|mg|g|kg|ml|l|s)[23²³]$/.test(value??'');}
function quantityTokens(text) {
  return [...text.matchAll(QUANTITY_TOKEN)].map(match => ({text:match[0],value:tokenValue(match[0]),start:match.index,end:match.index+match[0].length}));
}
function cardinalValue(value, language) {
  if (language === 'ar') return CARDINAL_AR.has(value) || UNSUPPORTED_CARDINAL_AR.has(value) || (value.startsWith('و') && (CARDINAL_AR.has(value.slice(1))||UNSUPPORTED_CARDINAL_AR.has(value.slice(1))));
  return language === 'en' || !language ? SMALL_EN.has(value) || TENS_EN.has(value) || value === 'hundred' || value === 'thousand' || UNSUPPORTED_CARDINAL_EN.has(value) : false;
}
function digitQuantity(token) { return /^[+\-\u2212]?\p{Nd}/u.test(token.text); }
function numberLike(token,language) { return token && (digitQuantity(token) || cardinalValue(token.value,language)); }
function rational(numerator, denominator = 1n) {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b) [a,b] = [b,a % b];
  const divisor = a || 1n;
  return { numerator:numerator/divisor, denominator:denominator/divisor };
}
function literalQuantity(text) {
  if ([...text].some(character=>/\p{Nd}/u.test(character)&&!/[0-9\u0660-\u0669\u06f0-\u06f9]/u.test(character))) return {reason:'unicode_numeral_alphabet_not_supported'};
  let value = normalizeDigits(text).replace(/\u2212/g,'-');
  if (value.length > 42) return {reason:'numeric_literal_exceeds_bound'};
  if (/[eE]/.test(value)) return {reason:'scientific_notation_not_supported'};
  if (value.includes(',')) return {reason:'western_comma_locale_ambiguous'};
  if (value.includes('\u066c')) {
    if (!/^[+\-]?\d{1,3}(?:\u066c\d{3})+(?:\u066b\d+)?$/.test(value)) return {reason:'invalid_arabic_grouping'};
    value = value.replace(/\u066c/g,'');
  }
  value = value.replace(/\u066b/g,'.');
  if (!/^[+\-]?\d+(?:\.\d+)?$/.test(value)) return {reason:'numeric_literal_not_supported'};
  const [whole,fraction = ''] = value.split('.');
  return rational(BigInt(whole+fraction),10n**BigInt(fraction.length));
}
function englishUnderHundred(words) {
  if (words.length === 1 && SMALL_EN.has(words[0])) return SMALL_EN.get(words[0]);
  if (TENS_EN.has(words[0]) && (words.length === 1 || (words.length === 2 && SMALL_EN.get(words[1]) > 0 && SMALL_EN.get(words[1]) < 10))) return TENS_EN.get(words[0])+(words.length===2?SMALL_EN.get(words[1]):0);
  return null;
}
function englishUnderThousand(words) {
  const hundred = words.indexOf('hundred');
  if (hundred < 0) return englishUnderHundred(words);
  if (hundred !== 1 || !(SMALL_EN.get(words[0]) > 0 && SMALL_EN.get(words[0]) < 10)) return null;
  let tail = words.slice(2);
  if (tail[0] === 'and') tail = tail.slice(1);
  const remainder = tail.length ? englishUnderHundred(tail) : 0;
  return remainder === null ? null : SMALL_EN.get(words[0])*100+remainder;
}
function writtenQuantity(items,language) {
  const words = items.filter(token => token.value !== '-').map(token => token.value);
  if (language === 'ar') {
    if (words.length !== 1 || words[0].startsWith('و') || !CARDINAL_AR.has(words[0])) return {reason:'arabic_compound_cardinal_not_supported'};
    return rational(BigInt(CARDINAL_AR.get(words[0])));
  }
  const thousand = words.indexOf('thousand');
  let value;
  if (thousand >= 0) {
    const head = englishUnderThousand(words.slice(0,thousand));
    let tail = words.slice(thousand+1);
    if (tail[0] === 'and') tail = tail.slice(1);
    const remainder = tail.length ? englishUnderThousand(tail) : 0;
    value = head !== null && head > 0 && remainder !== null ? head*1000+remainder : null;
  } else value = englishUnderThousand(words);
  return value === null ? {reason:'written_cardinal_composition_ambiguous'} : rational(BigInt(value));
}
function numericInventory(text,language) {
  const items = quantityTokens(text), quantities = [], reasons = [];
  const problem = (reason,token) => reasons.push({reason,start:token.start,end:token.end,text:token.text});
  for (let index=0; index<items.length; index++) {
    const first = items[index];
    if (!numberLike(first,language)) continue;
    const previous = items[index-1];
    // Identifiers such as A12 are one word token. 12A, .5, time/date/range
    // syntax and unsupported numeric compositions are explicit abstentions.
    if (previous && previous.end === first.start && /[\p{L}/:\-\.]/u.test(previous.text)) problem('adjacent_identifier_or_compound_syntax',first);
    let last = index, numeric;
    if (digitQuantity(first)) numeric = literalQuantity(first.text);
    else {
      while (last+1 < items.length) {
        const next = items[last+1];
        if (cardinalValue(next.value,language)) { last++; continue; }
        if ((next.value === 'and' || next.value === 'و' || next.value === '-') && cardinalValue(items[last+2]?.value??'',language)) { last+=2; continue; }
        break;
      }
      numeric = writtenQuantity(items.slice(index,last+1),language);
    }
    if (numeric.reason) problem(numeric.reason,{...first,end:items[last].end,text:text.slice(first.start,items[last].end)});
    const next = items[last+1], following = items[last+2];
    if (next && numberLike(next,language)) problem('adjacent_numeric_components_not_supported',next);
    if (next && (next.value === 'and' || next.value === 'و') && numberLike(following,language)) problem('separate_numeric_conjunction_ambiguous',next);
    if (next && ((['/',':','-','–','—'].includes(next.value) && !(next.value==='-'&&QUANTITY_UNITS.has(following?.value))) || (digitQuantity(next) && next.start === items[last].end))) problem('fraction_range_date_or_time_not_supported',next);
    if (next && next.start === items[last].end && /^[\p{L}]/u.test(next.text) && !QUANTITY_UNITS.has(next.value) && !unsupportedQuantityUnit(next.value)) problem('adjacent_identifier_or_compound_syntax',next);
    if (previous && APPROXIMATE_QUANTITY.has(previous.value)) problem('approximate_quantity_not_exact',previous);
    const prior=items.slice(Math.max(0,index-3),index).map(token=>token.value).join(' ');
    if (/(?:at least|at most|more than|less than|between|على الأقل|على الاقل|أكثر من|اكثر من|أقل من|اقل من)$/.test(prior) || ['<','>','≤','≥'].includes(previous?.value)) problem('bounded_quantity_not_exact',previous??first);
    let unitToken = next;
    if (next?.value === '-' && QUANTITY_UNITS.has(following?.value)) unitToken = following;
    const unit = QUANTITY_UNITS.get(unitToken?.value);
    if (unsupportedQuantityUnit(unitToken?.value) || unitToken?.value === '°') problem('unit_conversion_not_supported',unitToken);
    if (unit && QUANTITY_SYMBOL_CASE.has(unitToken.value) && !QUANTITY_SYMBOL_CASE.get(unitToken.value).includes(unitToken.text)) problem('unit_symbol_case_ambiguous',unitToken);
    const afterUnit = items[unitToken === following ? last+3 : last+2];
    if (unit && afterUnit && (['/','^','²','³'].includes(afterUnit.value) || (digitQuantity(afterUnit) && afterUnit.start === unitToken.end))) problem('compound_or_power_unit_not_supported',afterUnit);
    if (!numeric.reason) {
      const amount = rational(numeric.numerator*(unit?.numerator??1n),numeric.denominator*(unit?.denominator??1n));
      const end = unit ? unitToken.end : items[last].end;
      quantities.push({dimension:unit?.dimension??'unitless',numerator:amount.numerator.toString(),denominator:amount.denominator.toString(),start:first.start,end,text:text.slice(first.start,end),unit:unitToken && unit ? unitToken.text : null});
    }
    index = last;
  }
  return { quantities, reasons };
}
function numericRawSignature(text,language) {
  const items = quantityTokens(text);
  return items.flatMap((token,index) => {
    if(!numberLike(token,language))return [];
    const prior=items.slice(Math.max(0,index-3),index).map(part=>part.value).join(' ');
    const context=/(?:at least|at most|more than|less than|between|على الأقل|على الاقل|أكثر من|اكثر من|أقل من|اقل من)$/.test(prior) || APPROXIMATE_QUANTITY.has(items[index-1]?.value) || ['<','>','≤','≥'].includes(items[index-1]?.value) ? prior : '';
    return [[token.text,items[index-1] && !/[\p{L}\p{N}]/u.test(items[index-1].text) ? items[index-1].text : '',items[index+1] && (!/[\p{L}\p{N}]/u.test(items[index+1].text) || QUANTITY_UNITS.has(items[index+1].value) || unsupportedQuantityUnit(items[index+1].value) || items[index+1].start===token.end) ? items[index+1].text : '',context]];
  });
}
function inventoryKey(quantities) { return quantities.map(q => `${q.dimension}:${q.numerator}/${q.denominator}`).sort(); }
function comparisonEvidence(row,method) {
  return { method,potentialOnly:true,humanReviewRequired:true,candidateExcerpt:row.translation,referenceExcerpt:row.reference.translation,referenceProvenance:row.reference.provenance,referenceRowNumber:row.reference.rowNumber };
}
function compareQuantities(row,language,addFinding) {
  if (row.translation === row.reference.translation) { row.numericReview={state:'unchanged',method:'identical original text; no quantity interpretation'}; return; }
  if (JSON.stringify(numericRawSignature(row.translation,language)) === JSON.stringify(numericRawSignature(row.reference.translation,language))) {
    const present = numericRawSignature(row.translation,language).length > 0;
    row.numericReview={state:present?'unchanged':'none',method:'unchanged raw numeric inventory; does not bind numbers to entities'}; return;
  }
  const candidate = numericInventory(row.translation,language), reference = numericInventory(row.reference.translation,language);
  const reasons = [...candidate.reasons.map(r=>({...r,role:'candidate'})),...reference.reasons.map(r=>({...r,role:'reference'}))];
  const method = 'bounded cardinal and literal quantity inventory; exact rational SI/time factors; no meaning or entity binding';
  const evidence = {...comparisonEvidence(row,method),candidateQuantities:candidate.quantities,referenceQuantities:reference.quantities,reasons,supportedWrittenLanguage:language==='ar'?'ar (single cardinal words only)':language==='en'||!language?'en (bounded cardinal grammar)':'none; digit literals only',inventoryOnly:true};
  if (reasons.length) {
    row.numericReview={state:'abstain',...evidence};
    addFinding({code:'numeric_comparison_abstain',type:'evidence',severity:'info',message:'امتناع عن تفسير تركيب عددي ملتبس أو غير مدعوم؛ راجع النص الأصلي، ولم يثبت اختلاف عددي.',reason:'No numeric-change verdict is emitted when either side has unsupported or ambiguous numeric syntax.',spans:reasons.map(r=>({field:'translation',...r})),evidence},[row]);
    return;
  }
  const different = JSON.stringify(inventoryKey(candidate.quantities)) !== JSON.stringify(inventoryKey(reference.quantities));
  row.numericReview={state:different?'difference':'equivalent',...evidence};
  if (different) addFinding({code:'potential_numeric_change',type:'comparison',severity:'high',message:'اختلاف محتمل في قائمة الأعداد أو الكميات بعد تحويل الوحدات المدعومة؛ يحتاج قراءة ومراجعة بشرية.',reason:'Exact supported quantity inventories differ. Counts are not linked to subjects, scope or meaning; this is a transparent potential signal.',spans:[...candidate.quantities.map(q=>({field:'translation',start:q.start,end:q.end,text:q.text,role:'candidate'})),...reference.quantities.map(q=>({field:'translation',start:q.start,end:q.end,text:q.text,role:'reference'}))],evidence},[row]);
}

// Small English marker families. Canonical inventory equality never proves
// equivalence. Ambiguous negation, epistemic constructions and scope abstain.
const QUALIFIER_MARKERS = new Map([
  ['all',['quantifier','universal']],['every',['quantifier','universal']],['each',['quantifier','universal']],['some',['quantifier','some']],
  ['must',['modality','obligation']],['required',['modality','obligation']],['mandatory',['modality','obligation']],['may',['modality','may']],
  ['allowed',['permission','allowed']],['permitted',['permission','allowed']],['authorized',['permission','allowed']],['forbidden',['permission','forbidden']],['prohibited',['permission','forbidden']],['disallowed',['permission','forbidden']],
  ['before',['order','before']],['after',['order','after']],
]);
function qualifierInventory(text) {
  const parts = tokens(text), markers = [], reasons = [];
  for (let index=0; index<parts.length; index++) {
    const token=parts[index], definition=QUALIFIER_MARKERS.get(token.value);
    if (!definition) continue;
    const [family,originalValue]=definition; let value=originalValue, start=token.start;
    const previous=parts[index-1], next=parts[index+1];
    const ambiguous = reason => reasons.push({reason,start:token.start,end:token.end,text:token.text});
    if (token.text === 'May') ambiguous('capitalized_May_month_or_modality_ambiguous');
    if ((token.value==='must'||token.value==='may') && next?.value==='have') ambiguous('epistemic_modal_construction_not_supported');
    if (next && ENGLISH_NEGATIONS.has(next.value)) ambiguous('following_negation_scope_not_supported');
    if (family==='quantifier' && ['but','except'].includes(next?.value)) ambiguous('quantifier_exception_scope_not_supported');
    if (family==='quantifier' && APPROXIMATE_QUANTITY.has(previous?.value)) ambiguous('approximate_quantifier_scope_not_supported');
    if (token.value==='all' && previous?.value==='in') ambiguous('idiomatic_all_not_supported');
    if (token.value==='after' && previous?.value==='day' && next?.value==='day') ambiguous('idiomatic_order_marker_not_supported');
    if (previous && ENGLISH_NEGATIONS.has(previous.value)) {
      if (previous.value==='not' && family==='permission' && value==='allowed') { value='forbidden'; start=previous.start; }
      else ambiguous('negated_marker_scope_not_supported');
    }
    // A separated negation may have scope over this marker. Only the bounded
    // adjacent "not permitted/allowed" form above is canonicalized.
    if (parts.slice(0,index-1).some(part=>ENGLISH_NEGATIONS.has(part.value))) ambiguous('nonadjacent_negation_scope_not_supported');
    markers.push({family,value,start,end:token.end,text:text.slice(start,token.end)});
  }
  for (const family of ['quantifier','modality','permission','order']) {
    const group=markers.filter(marker=>marker.family===family);
    if (group.length>1) for(const marker of group) reasons.push({reason:'multiple_markers_require_scope_binding',start:marker.start,end:marker.end,text:marker.text});
  }
  return {markers,reasons};
}
function compareQualifiers(row,language,addFinding) {
  if (row.translation===row.reference.translation) {row.qualifierReview={state:'unchanged',method:'identical original text'};return;}
  if (language && language!=='en') {row.qualifierReview={state:'unsupported',supportedMarkerLanguage:'en'};return;}
  const candidate=qualifierInventory(row.translation),reference=qualifierInventory(row.reference.translation);
  const reasons=[...candidate.reasons.map(r=>({...r,role:'candidate'})),...reference.reasons.map(r=>({...r,role:'reference'}))];
  const evidence={...comparisonEvidence(row,'bounded English quantifier/modality/permission/order marker inventory; no meaning or scope model'),candidateMarkers:candidate.markers,referenceMarkers:reference.markers,reasons,supportedMarkerLanguage:language||'en (undeclared language)',inventoryOnly:true};
  if (!candidate.markers.length&&!reference.markers.length) {row.qualifierReview={state:'none',...evidence};return;}
  if (reasons.length) {
    row.qualifierReview={state:'abstain',...evidence};
    addFinding({code:'qualifier_comparison_abstain',type:'evidence',severity:'info',message:'امتناع عن مقارنة مؤشر إنجليزي بسبب غموض النطاق أو النفي أو الاستعمال؛ يحتاج قراءة.',reason:'Unsupported scope or ambiguous marker usage prevents a qualifier-change assertion.',spans:reasons.map(r=>({field:'translation',...r})),evidence},[row]);return;
  }
  const key=markers=>markers.map(m=>`${m.family}:${m.value}`).sort();
  const different=JSON.stringify(key(candidate.markers))!==JSON.stringify(key(reference.markers));
  row.qualifierReview={state:different?'difference':'equivalent',...evidence};
  if(different) addFinding({code:'potential_qualifier_change',type:'comparison',severity:'high',message:'اختلاف محتمل في مؤشر إنجليزي للكمّ أو الإلزام أو الإذن أو الترتيب؛ يحتاج قراءة للسياق.',reason:'A bounded English marker inventory differs. Synonyms are normalized only within stated families; this is not a semantic verdict.',spans:[...candidate.markers.map(m=>({field:'translation',start:m.start,end:m.end,text:m.text,role:'candidate'})),...reference.markers.map(m=>({field:'translation',start:m.start,end:m.end,text:m.text,role:'reference'}))],evidence},[row]);
}
function textSpan(text, role = 'candidate') {
  return { field: 'translation', start: 0, end: text.length, text, role };
}

// Character-level hygiene, not a meaning check: markup, invisible controls, look-alike letters and another
// script's text should not reach expert review unnoticed. Arabic-script languages legitimately use ZWNJ/ZWJ/RLM/LRM.
const LATIN_SCRIPT_LANGUAGES = new Set(['en', 'fr', 'id', 'tr', 'es', 'ms', 'de', 'it', 'nl', 'pt', 'sw', 'ha', 'so', 'sq', 'bs', 'az', 'uz']);
const HIDDEN_CONTROLS = /[\u00ad\u034f\u180e\u200b\u2060-\u2064\ufeff\ufff9-\ufffb\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/gu;
const JOINERS_AND_MARKS = /[\u200c-\u200f]/gu;
const MARKUP = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|&(?:[a-z]{2,8}|#\d{2,6}|#x[0-9a-f]{2,5});/giu;
const ARABIC_SCRIPT_RUN = /\p{Script=Arabic}[\p{Script=Arabic}\p{M}]{2,}/gu;
const WORD = /[\p{L}\p{M}]+/gu;
const codePoint = (character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
export function textHygieneIssues(text, language) {
  const value = textValue(text), base = languageBase(language), issues = [], spans = [];
  const collect = (kind, pattern, describe = (match) => match[0]) => {
    const matches = [...value.matchAll(pattern)];
    if (!matches.length) return;
    issues.push({ kind, count: matches.length, examples: [...new Set(matches.slice(0, 5).map(describe))] });
    for (const match of matches.slice(0, 10)) spans.push({ field: 'translation', start: match.index, end: match.index + match[0].length, text: match[0], kind });
  };
  collect('markup', MARKUP);
  collect('hidden_controls', HIDDEN_CONTROLS, (match) => codePoint(match[0]));
  if (LATIN_SCRIPT_LANGUAGES.has(base)) {
    collect('directional_marks', JOINERS_AND_MARKS, (match) => codePoint(match[0]));
    collect('foreign_script', ARABIC_SCRIPT_RUN, () => 'Arabic script');
  }
  const mixed = [...value.matchAll(WORD)].filter((match) => /\p{Script=Latin}/u.test(match[0]) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(match[0]));
  if (mixed.length) {
    issues.push({ kind: 'mixed_script_word', count: mixed.length, examples: [...new Set(mixed.slice(0, 5).map((match) => [...match[0]].filter((character) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(character)).map(codePoint).join(' ')))] });
    for (const match of mixed.slice(0, 10)) spans.push({ field: 'translation', start: match.index, end: match.index + match[0].length, text: match[0], kind: 'mixed_script_word' });
  }
  return { issues, spans };
}
const HYGIENE_LABELS = { markup: 'وسوم HTML أو رموز ترميز', hidden_controls: 'محارف خفية أو محارف تحكم بالاتجاه', directional_marks: 'علامات اتجاه أو وصل خفية في نص لاتيني', foreign_script: 'نص بالحرف العربي داخل ترجمة بحرف لاتيني', mixed_script_word: 'كلمة تخلط حروفًا من خطين مختلفين (حرف شبيه)' };
const hygieneList = (issues) => issues.map((issue) => HYGIENE_LABELS[issue.kind]).join('، ');
function rowNumber(value, fallback) {
  const number = strictInteger(value);
  return number != null && number > 0 ? number : fallback;
}
function referenceProvenance(metadata) {
  const input = metadata.reference && typeof metadata.reference === 'object' ? metadata.reference : {};
  const sourceKind = String(input.sourceKind ?? 'user-upload');
  return {
    title: String(input.title ?? 'User-supplied comparison reference'),
    edition: String(input.edition ?? ''),
    url: String(input.url ?? ''),
    verificationStatus: input.verificationStatus === 'verified' ? 'verified' : 'unverified',
    licenseNote: String(input.licenseNote ?? ''),
    language: String(input.language ?? ''),
    sourceKind,
    sourceURL: String(input.sourceURL ?? input.url ?? ''),
    bookId: Number.isInteger(input.bookId) ? input.bookId : null,
    provider: String(input.provider ?? ''),
    author: String(input.author ?? ''),
    translator: String(input.translator ?? ''),
    publisher: String(input.publisher ?? ''),
    bibliographicURL: String(input.bibliographicURL ?? ''),
    bibliographicRetrievedAt: String(input.bibliographicRetrievedAt ?? ''),
    bibliographicSha256: String(input.bibliographicSha256 ?? ''),
    recordedProvenanceConsistent: input.recordedProvenanceConsistent === true,
    liveTransportVerified: input.liveTransportVerified === true,
    verificationNote: String(input.verificationNote ?? ''),
    policyURL: String(input.policyURL ?? ''),
    licenseURL: String(input.licenseURL ?? ''),
    retention: String(input.retention ?? ''),
    publicationReady: false,
    trustChecks: Array.isArray(input.trustChecks) ? input.trustChecks : [],
    authorityStatus: String(input.authorityStatus ?? 'not-independently-certified'),
    retrievedAt: String(input.retrievedAt ?? ''),
    rawSha256: String(input.rawSha256 ?? ''),
    normalizedSha256: String(input.normalizedSha256 ?? ''),
    version: String(input.version ?? input.edition ?? ''),
    authority: sourceKind === 'quranpedia-api'
      ? 'Retrieved Quranpedia API provenance and recorded hashes; not scholarly certification or independently authenticated by this engine.'
      : 'User-declared provenance; not independently authenticated by this engine or scholarly certification.',
  };
}
function rowReferenceProvenance(raw, globalProvenance) {
  const provenance = { ...globalProvenance };
  for (const field of ['sourceURL', 'retrievedAt', 'rawSha256', 'normalizedSha256', 'sourceKind', 'version', 'verificationNote', 'authorityStatus']) {
    if (typeof raw[field] === 'string') provenance[field] = raw[field];
  }
  if (raw.verificationStatus === 'unverified') provenance.verificationStatus = 'unverified';
  for (const field of ['allowNoSignal','trustedSourceProvenance','recordedProvenanceConsistent']) if (typeof raw[field] === 'boolean') provenance[field] = raw[field];
  if (raw.provenanceChecks && typeof raw.provenanceChecks === 'object') provenance.provenanceChecks = raw.provenanceChecks;
  return provenance;
}
function parseMergedRange(value) {
  if (typeof value !== 'string') return null;
  const match = normalizeDigits(value).trim().match(/^(\d+)\s*[-\u2013\u2014]\s*(\d+)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}
function compactRanges(numbers) {
  if (numbers.length === 0) return [];
  const ranges = [];
  let start = numbers[0];
  let end = start;
  for (const number of numbers.slice(1)) {
    if (number === end + 1) end = number;
    else { ranges.push({ start, end }); start = number; end = number; }
  }
  ranges.push({ start, end });
  return ranges;
}

/**
 * @param {{rows:Array,referenceRows?:Array,scope?:object|string,metadata?:object}} input
 * Rows: {surah,ayah,translation,rowNumber?}. Scope is complete Quran or complete
 * selected surahs ({type:'selected',surahs:[1,112,113,114]}), or only declared
 * uploaded rows ({type:'provided'}). Provided scope makes no completeness
 * assertion about any entire surah or the Quran.
 */
export function auditBatch({ rows, referenceRows = [], scope = { type: 'full' }, metadata = {} } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  if (!Array.isArray(referenceRows)) throw new TypeError('referenceRows must be an array.');
  if (rows.length > MAX_ROWS || referenceRows.length > MAX_ROWS) {
    throw new RangeError(`Audit is limited to ${MAX_ROWS} candidate/reference rows.`);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('metadata must be an object.');
  }
  const normalizedScope = normalizeScope(scope);
  const providedScope = normalizedScope.type === 'provided';
  const providedIds = new Set();
  if (providedScope) {
    const observedSurahs = new Set();
    for (const input of rows) {
      const surah = strictInteger(input?.surah);
      const ayah = strictInteger(input?.ayah);
      if (isValidVerseId(surah, ayah)) {
        providedIds.add(`${surah}:${ayah}`);
        observedSurahs.add(surah);
      }
    }
    normalizedScope.surahs = [...observedSurahs].sort((left, right) => left - right);
    normalizedScope.expectedVerses = providedIds.size;
  }
  const coverageIsDeclaredRows = providedScope;
  const scopeDefinition = providedScope
    ? 'Only unique valid verse IDs declared in the uploaded rows. Gaps outside those rows are not tested; no complete-surah or full-Quran assertion.'
    : normalizedScope.type === 'full'
      ? 'All 6,236 IDs in the declared standard Kufic numbering index.'
      : 'Every indexed verse ID in each explicitly selected complete surah.';
  const completenessAssertion = providedScope ? 'provided-rows-only' : normalizedScope.type === 'full' ? 'full-index' : 'selected-surahs';
  const scopeSet = new Set(normalizedScope.surahs);
  const provenance = {
    index: { ...INDEX_PROVENANCE },
    candidate: {
      name: String(metadata.candidate?.name ?? metadata.fileName ?? 'Candidate file'),
      language: String(metadata.candidate?.language ?? ''),
      synthetic: metadata.candidate?.synthetic === true,
    },
    reference: referenceProvenance(metadata),
    analysis: {
      mode: 'structural-and-lexical-rules',
      requestedMode: String(metadata.analysisMode ?? 'structural-and-lexical-rules'),
      trainedModelExecuted: false,
      limitations: [
        'Lexical changes and negation markers are potential review signals, not semantic judgments.',
        'Numeric and English marker inventories are bounded; equality does not bind quantities to entities or prove semantic equivalence.',
        'No signal does not certify accuracy, completeness of meaning, or religious approval.',
        'Reference authority and licensing are supplied by the user and not authenticated by this engine.',
        'Structural coverage uses the declared 6,236-verse numbering convention.',
      ],
    },
  };
  const report = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scope: normalizedScope,
    scopeDefinition,
    coverageIsDeclaredRows,
    completenessAssertion,
    provenance,
    summary: {},
    rows: [],
    findings: [],
  };
  const addFinding = (input, affectedRows = []) => {
    const finding = {
      id: `finding-${report.findings.length + 1}`,
      code: input.code,
      type: input.type,
      severity: input.severity ?? 'medium',
      message: input.message,
      reason: input.reason,
      rowNumbers: affectedRows.map((row) => row.rowNumber),
      verseIds: affectedRows.map((row) => row.verseId).filter(Boolean),
      spans: input.spans ?? [],
      evidence: input.evidence ?? {},
      ...input,
    };
    report.findings.push(finding);
    for (const row of affectedRows) { row.findingIds.push(finding.id); row.findings.push(finding); }
    return finding;
  };

  const referenceMap = new Map();
  const referenceIssues = { invalidRows: 0, emptyRows: 0, duplicateVerseIds: [], validUniqueVerses: 0 };
  referenceRows.forEach((input, index) => {
    const raw = input && typeof input === 'object' ? input : {};
    const surah = strictInteger(raw.surah);
    const ayah = strictInteger(raw.ayah);
    if (!isValidVerseId(surah, ayah)) { referenceIssues.invalidRows += 1; return; }
    const verseId = `${surah}:${ayah}`;
    const rowProvenance = rowReferenceProvenance(raw, provenance.reference);
    const reference = {
      surah, ayah, verseId,
      rowNumber: rowNumber(raw.rowNumber, index + 1),
      translation: textValue(raw.translation),
      provenance: rowProvenance,
      sourceURL: String(raw.sourceURL ?? provenance.reference.url),
      retrievedAt: rowProvenance.retrievedAt,
      rawSha256: rowProvenance.rawSha256,
      normalizedSha256: rowProvenance.normalizedSha256,
      footnotes: Array.isArray(raw.footnotes) ? raw.footnotes.filter(note=>typeof note==='string').slice(0,100) : [],
    };
    if (!meaningfulText(reference.translation)) referenceIssues.emptyRows += 1;
    if (!referenceMap.has(verseId)) referenceMap.set(verseId, []);
    referenceMap.get(verseId).push(reference);
  });
  for (const [verseId, references] of referenceMap) {
    if (references.length > 1) referenceIssues.duplicateVerseIds.push(verseId);
    else if (meaningfulText(references[0].translation)) referenceIssues.validUniqueVerses += 1;
  }
  if (referenceIssues.invalidRows || referenceIssues.emptyRows || referenceIssues.duplicateVerseIds.length) {
    addFinding({
      code: 'reference_integrity', type: 'evidence', severity: 'high',
      message: 'ملف المقارنة يحتوي على معرّفات غير صالحة أو نصوص فارغة أو مكررة؛ يتوقف التحليل عند الدليل الملتبس.',
      reason: 'Reference integrity defects are disclosed; duplicate reference IDs never resolve to an arbitrary first row.',
      evidence: referenceIssues,
    });
  }

  const candidatesById = new Map();
  let previousValid = null;
  rows.forEach((input, index) => {
    const raw = input && typeof input === 'object' ? input : {};
    const surah = strictInteger(raw.surah);
    const ayah = strictInteger(raw.ayah);
    const validId = isValidVerseId(surah, ayah);
    const translation = textValue(raw.translation);
    const row = {
      key: `row-${index + 1}`,
      rowNumber: rowNumber(raw.rowNumber, index + 1),
      surah, ayah,
      rawSurah: typeof raw.surah === 'string' || typeof raw.surah === 'number' ? raw.surah : null,
      rawAyah: typeof raw.ayah === 'string' || typeof raw.ayah === 'number' ? raw.ayah : null,
      verseId: validId ? `${surah}:${ayah}` : null,
      translation,
      reference: null,
      status: 'abstain',
      comparisonStatus: 'abstain',
      numericReview: { state: 'not_compared', reason: 'reference_or_row_gate' },
      qualifierReview: { state: 'not_compared', reason: 'reference_or_row_gate' },
      comparisonReason: 'missing_reference',
      findingIds: [],
      findings: [],
    };
    report.rows.push(row);
    const range = parseMergedRange(raw.ayah);
    if (range) {
      addFinding({
        code: 'suspected_merged_range', type: 'structural', severity: 'high',
        message: 'الصف يحمل نطاق آيات؛ يلزم فصله أو تأكيد طريقة المحاذاة يدويًا.',
        reason: 'A range is not one verse ID and is not counted as individual verse coverage.',
        spans: [{ field: 'ayah', start: 0, end: String(raw.ayah).length, text: String(raw.ayah), role: 'candidate' }],
        evidence: { surah, range, validRange: isValidVerseId(surah, range.start) && isValidVerseId(surah, range.end) && range.end >= range.start },
      }, [row]);
    }
    if (!validId) {
      addFinding({
        code: 'invalid_verse_id', type: 'structural', severity: 'high',
        message: 'رقم السورة أو الآية غير صالح وفق ترقيم العد الكوفي المحدد.',
        reason: 'Verse identifiers must be positive integers inside the declared chapter verse bounds.',
        evidence: { surah, ayah, maxAyah: surah >= 1 && surah <= 114 ? SURAH_AYAH_COUNTS[surah - 1] : null, countingConvention: provenance.index.countingConvention },
      }, [row]);
    } else {
      if (!scopeSet.has(surah)) {
        addFinding({
          code: 'out_of_scope', type: 'structural',
          message: 'الصف خارج السور التي اخترتها لهذا الفحص.',
          reason: 'A valid verse outside the declared scope is reported but excluded from scope coverage.',
          evidence: { selectedSurahs: normalizedScope.surahs },
        }, [row]);
      }
      if (!candidatesById.has(row.verseId)) candidatesById.set(row.verseId, []);
      candidatesById.get(row.verseId).push(row);
      const ordinal = verseOrdinal(surah, ayah);
      if (previousValid && ordinal < previousValid.ordinal) {
        addFinding({
          code: 'out_of_order', type: 'structural',
          message: 'ترتيب هذا الصف يسبق الصف الصحيح السابق؛ راجع ترتيب الملف.',
          reason: 'Valid candidate verse IDs decrease in source-file order.',
          evidence: { previousVerseId: previousValid.row.verseId, previousRowNumber: previousValid.row.rowNumber, previousOrdinal: previousValid.ordinal, currentOrdinal: ordinal },
        }, [row]);
      }
      previousValid = { ordinal, row };
    }
    if (typeof raw.translation !== 'string' && raw.translation != null) {
      addFinding({
        code: 'invalid_translation_type', type: 'structural', severity: 'high',
        message: 'محتوى الترجمة ليس نصًا؛ راجع تنسيق العمود.',
        reason: 'Non-text values are not silently converted into translation text.',
        evidence: { receivedType: typeof raw.translation },
      }, [row]);
    }
    if (!meaningfulText(translation)) {
      addFinding({
        code: 'empty_translation', type: 'structural', severity: 'high',
        message: 'نص الترجمة فارغ أو يحتوي على فراغات فقط.',
        reason: 'The candidate row has no usable translation text.',
        spans: [textSpan(translation)],
      }, [row]);
    } else {
      const hygiene = textHygieneIssues(translation, provenance.candidate.language);
      if (hygiene.issues.length) {
        addFinding({
          code: 'text_hygiene', type: 'structural', severity: 'medium',
          message: `في نص الترجمة شوائب تقنية تحتاج تنظيفًا أو تأكيدًا: ${hygieneList(hygiene.issues)}. قد يكون بعضها مقصودًا، مثل مصطلح عربي.`,
          reason: 'Character-level hygiene only: markup, invisible controls, look-alike letters or another script were found. Meaning is not judged.',
          spans: hygiene.spans.map((span) => ({ ...span, role: 'candidate' })),
          evidence: { issues: hygiene.issues, declaredLanguage: provenance.candidate.language || null },
        }, [row]);
      }
    }
  });

  let duplicateRows = 0;
  for (const [verseId, candidateRows] of candidatesById) {
    if (candidateRows.length > 1) {
      duplicateRows += candidateRows.length - 1;
      addFinding({
        code: 'duplicate_verse', type: 'structural', severity: 'high',
        message: 'تكرر معرّف الآية في أكثر من صف؛ راجع النسخ قبل اعتماد المحاذاة.',
        reason: 'All candidate copies are flagged; duplicates count as one covered ID.',
        evidence: { verseId, occurrences: candidateRows.length, conflictingText: new Set(candidateRows.map((row) => normalizedText(row.translation))).size > 1 },
      }, candidateRows);
    }
  }
  let coveredVerses = 0;
  let missingVerses = 0;
  const missingBySurah = [];
  for (const surah of providedScope ? [] : normalizedScope.surahs) {
    const missing = [];
    for (let ayah = 1; ayah <= SURAH_AYAH_COUNTS[surah - 1]; ayah += 1) {
      if (candidatesById.has(`${surah}:${ayah}`)) coveredVerses += 1;
      else missing.push(ayah);
    }
    if (missing.length) {
      missingVerses += missing.length;
      const group = { surah, count: missing.length, ranges: compactRanges(missing), verseIds: missing.map((ayah) => `${surah}:${ayah}`) };
      missingBySurah.push(group);
      addFinding({
        code: 'missing_verses', type: 'structural', severity: 'high',
        message: `السورة ${surah}: ${missing.length} معرّف آية غير موجود في الملف ضمن نطاق الفحص.`,
        reason: 'Absence is an ID-coverage finding, not a statement that religious text has been omitted from a merged passage.',
        verseIds: group.verseIds,
        evidence: { surah, missingCount: group.count, ranges: group.ranges },
      });
    }
  }
  if (providedScope) coveredVerses = providedIds.size;

  let comparedRows = 0;
  let lexicalComparedRows = 0;
  let unverifiedReferenceRows = 0;
  let referenceMissingRows = 0;
  let referenceAmbiguousRows = 0;
  let languageLimitedRows = 0;
  const candidateLanguage = languageBase(provenance.candidate.language);
  const referenceLanguage = languageBase(provenance.reference.language);
  const languagesDiffer = candidateLanguage && referenceLanguage && candidateLanguage !== referenceLanguage;
  for (const row of report.rows) {
    if (!row.verseId || !scopeSet.has(row.surah) || !meaningfulText(row.translation)) {
      row.comparisonReason = !row.verseId ? 'invalid_verse_id' : !scopeSet.has(row.surah) ? 'out_of_scope' : 'empty_translation';
    } else if (candidatesById.get(row.verseId).length > 1) {
      row.comparisonReason = 'duplicate_candidate';
    } else {
      const references = referenceMap.get(row.verseId) ?? [];
      if (references.length > 1) {
        referenceAmbiguousRows += 1;
        row.comparisonReason = 'ambiguous_reference';
        addFinding({
          code: 'ambiguous_reference', type: 'evidence', severity: 'high',
          message: 'معرّف الآية مكرر في ملف المقارنة؛ امتنع الفحص المقارن عن اختيار نسخة عشوائية.',
          reason: 'Multiple source rows claim the same reference verse ID.',
          evidence: { referenceRowNumbers: references.map((reference) => reference.rowNumber) },
        }, [row]);
      } else if (references.length === 0 || !meaningfulText(references[0].translation)) {
        referenceMissingRows += 1;
        row.comparisonReason = references.length ? 'empty_reference' : 'missing_reference';
      } else {
        row.reference = references[0];
        const referenceHygiene = textHygieneIssues(row.reference.translation, row.reference.provenance.language || provenance.reference.language);
        if (referenceHygiene.issues.length) {
          addFinding({
            code: 'reference_text_hygiene', type: 'evidence', severity: 'medium',
            message: `نص المرجع لهذا الموضع يحمل شوائب تقنية: ${hygieneList(referenceHygiene.issues)}. تحقّق من المصدر قبل الاعتماد على المقارنة.`,
            reason: 'The reference row itself carries markup, invisible controls, look-alike letters or another script; comparison evidence may be distorted by the source.',
            spans: referenceHygiene.spans.map((span) => ({ ...span, role: 'reference' })),
            evidence: { issues: referenceHygiene.issues.map(({ kind, count }) => ({ kind, count })) },
          }, [row]);
        }
        if (languagesDiffer) {
          row.comparisonReason = 'language_mismatch';
        } else {
          const teaching = row.reference.provenance.sourceKind === 'synthetic-teaching' && row.reference.translation.startsWith('SYNTHETIC TRAINING TEXT');
          const verified = row.reference.provenance.verificationStatus === 'verified' && (row.reference.provenance.allowNoSignal !== false || teaching);
          row.comparisonStatus = verified ? 'compared' : 'abstain';
          row.comparisonReason = verified ? null : 'unverified_reference';
          lexicalComparedRows += 1;
          if (verified) comparedRows += 1;
          else unverifiedReferenceRows += 1;
          compareLexically(row, candidateLanguage || referenceLanguage, addFinding);
          if (row.qualifierReview.reason === 'language_checks_unsupported') languageLimitedRows += 1;
        }
      }
    }
    const structuralOrComparison = row.findings.some((finding) => finding.type === 'structural' || finding.type === 'comparison');
    const ruleAbstained = row.numericReview.state === 'abstain' || row.qualifierReview.state === 'abstain';
    row.status = structuralOrComparison ? 'needs_review' : row.comparisonStatus === 'abstain' || ruleAbstained ? 'abstain' : 'no_signal';
  }
  if (referenceMissingRows || referenceAmbiguousRows || unverifiedReferenceRows || referenceRows.length === 0 || languagesDiffer) {
    addFinding({
      code: 'reference_coverage', type: 'evidence', severity: 'info',
      message: 'الصفوف التي تفتقر إلى دليل صالح للمقارنة تبقى في حالة امتناع؛ الفحص البنيوي وحده لا يعتمد الترجمة.',
      reason: 'Per-row comparison abstention is explicit. Structural checks remain available independently.',
      evidence: { referenceRows: referenceRows.length, comparedRows, lexicalComparedRows, unverifiedRows: unverifiedReferenceRows, missingRows: referenceMissingRows, ambiguousRows: referenceAmbiguousRows, languagesDiffer: Boolean(languagesDiffer), referenceProvenance: provenance.reference },
    });
  }
  if (referenceRows.length && (provenance.reference.verificationStatus !== 'verified' || unverifiedReferenceRows)) {
    addFinding({
      code: 'unverified_reference', type: 'evidence', severity: 'info',
      message: 'المقارنة تستخدم ملفًا مرفوعًا غير متحقق من سلطته؛ لا تُعد اختلافاته أحكامًا دينية.',
      reason: 'User-supplied reference provenance is unverified; lexical comparison remains a transparent review aid.',
      evidence: { referenceProvenance: provenance.reference },
    });
  }
  const languageChecksInfo = languageChecks(candidateLanguage || referenceLanguage);
  const languageAbstainedRows = report.rows.filter((row) => row.status === 'abstain' && row.comparisonReason === 'language_checks_unsupported').length;
  if (languageLimitedRows > 0) {
    addFinding({
      code: 'language_checks_limited', type: 'evidence', severity: 'info',
      message: `فحص النفي والأعداد المكتوبة بالحروف يعمل للعربية والإنجليزية فقط، وفحص الكلمات المؤثرة (مثل «كل» و«بعض» و«يجب») للإنجليزية وحدها. لغة هذا الملف (${languageChecksInfo.language}) خارجها، فغياب الإشارة هنا لا يعني أن هذه الفحوص جرت. الأرقام المكتوبة بالأرقام تُقارَن في كل اللغات. عدد الصفوف التي اختلف نصها عن المرجع: ${languageLimitedRows}؛ ما لم تظهر فيه إشارة أخرى بقي «ممتنعًا» ليقرأه مراجع.`,
      reason: 'Negation markers (ar, en), written-number grammar (ar single cardinals, en) and qualifier markers (en) do not exist for the declared language, so rows whose words differ cannot be cleared by these checks; absence of an alert is not evidence that the check ran.',
      evidence: { ...languageChecksInfo, supportedLanguages: { negation: [...NEGATION_LANGUAGES], writtenNumbers: [...WRITTEN_NUMBER_LANGUAGES], qualifierMarkers: [...QUALIFIER_LANGUAGES] }, rowsLimited: languageLimitedRows, rowsAbstained: languageAbstainedRows, humanReviewRequired: true },
    });
  }
  const countCode = (code) => report.rows.filter((row) => row.findings.some((finding) => finding.code === code)).length;
  const countStatus = (status) => report.rows.filter((row) => row.status === status).length;
  report.summary = {
    totalRows: rows.length,
    validRows: report.rows.filter((row) => row.verseId !== null).length,
    expectedVerses: normalizedScope.expectedVerses,
    coveredVerses,
    coveragePercent: normalizedScope.expectedVerses ? Number((coveredVerses / normalizedScope.expectedVerses * 100).toFixed(2)) : 0,
    coverageIsDeclaredRows,
    scopeDefinition,
    completenessAssertion,
    missingVerses,
    missingBySurah,
    duplicateRows,
    duplicateVerseIds: [...candidatesById].filter(([, values]) => values.length > 1).length,
    invalidRows: countCode('invalid_verse_id'),
    emptyRows: countCode('empty_translation'),
    outOfOrderRows: countCode('out_of_order'),
    outOfScopeRows: countCode('out_of_scope'),
    suspectedMergedRows: countCode('suspected_merged_range'),
    textHygieneRows: countCode('text_hygiene'),
    referenceHygieneRows: countCode('reference_text_hygiene'),
    comparedRows,
    lexicalComparedRows,
    unverifiedReferenceRows,
    referenceMissingRows,
    referenceAmbiguousRows,
    needsReviewRows: countStatus('needs_review'),
    noSignalRows: countStatus('no_signal'),
    abstainRows: countStatus('abstain'),
    findingsCount: report.findings.length,
    structuralFindingCount: report.findings.filter((finding) => finding.type === 'structural').length,
    comparisonFindingCount: report.findings.filter((finding) => finding.type === 'comparison').length,
    numericChangeRows: countCode('potential_numeric_change'),
    numericAbstainRows: countCode('numeric_comparison_abstain'),
    qualifierChangeRows: countCode('potential_qualifier_change'),
    qualifierAbstainRows: countCode('qualifier_comparison_abstain'),
    negationCountChangeRows: countCode('potential_negation_count_change'),
    lexicalDifferenceRows: countCode('lexical_difference'),
    structuralComplete: rows.length > 0 && missingVerses === 0 && report.findings.every((finding) => finding.type !== 'structural'),
    referenceIntegrity: referenceIssues,
    languageLimits: { ...languageChecksInfo, rowsLimited: languageLimitedRows },
    certification: 'none',
  };
  return report;
}

// Which meaning checks exist per declared language. Digit literals are compared in every language.
// Negation: ar, en. Written numbers: ar (single cardinals), en. English quantifier/modality markers: en only.
const NEGATION_LANGUAGES = new Set(['ar', 'en']);
const WRITTEN_NUMBER_LANGUAGES = new Set(['ar', 'en']);
const QUALIFIER_LANGUAGES = new Set(['en']);
// An undeclared language keeps the historical behaviour (English rules are applied and labelled as such).
function languageChecks(language) {
  const any = !language;
  return {
    language: language || '',
    negationChecked: any || NEGATION_LANGUAGES.has(language),
    quantifierChecked: any || QUALIFIER_LANGUAGES.has(language),
    writtenNumbersChecked: any || WRITTEN_NUMBER_LANGUAGES.has(language),
    digitsChecked: true,
  };
}
// Rows are turned into abstentions only for languages where NONE of the word-based meaning checks exists
// (every declared language except ar and en); Arabic and English behave exactly as before.
const meaningChecksUnavailable = (checks) => Boolean(checks.language) && !checks.negationChecked && !checks.writtenNumbersChecked && !checks.quantifierChecked;

// Negation markers of `own` that have no same-value partner in `other` (counted per value, in reading order).
function unpairedNegations(own, other) {
  const available = new Map();
  for (const token of other) available.set(token.value, (available.get(token.value) ?? 0) + 1);
  return own.filter((token) => {
    const left = available.get(token.value) ?? 0;
    if (left > 0) { available.set(token.value, left - 1); return false; }
    return true;
  });
}
// A count-only difference (both sides negate) is much noisier across legitimate translations than a presence difference
// (measured on a different clean translation), so it is emitted as its own medium-priority code; presence stays high.
const NEGATION_COUNT_CODE = 'potential_negation_count_change';
const NEGATION_COUNT_SEVERITY = 'medium';

function compareLexically(row, language, addFinding) {
  compareQuantities(row, language, addFinding);
  compareQualifiers(row, language, addFinding);
  const candidateTokens = tokens(row.translation);
  const referenceTokens = tokens(row.reference.translation);
  if (normalizedText(row.translation) === normalizedText(row.reference.translation)) return;
  const checks = languageChecks(language);
  if (meaningChecksUnavailable(checks)) {
    // The words differ but negation, written numbers and qualifier markers cannot be checked in this language:
    // never let such a row end as "no_signal". The qualifierReview hook is the one status/context code already treats as abstention.
    row.qualifierReview = {
      state: 'abstain', reason: 'language_checks_unsupported', declaredLanguage: checks.language, supportedMarkerLanguage: 'en',
      unsupportedChecks: ['negation', 'written_numbers', 'qualifier_markers'], digitsChecked: true, inventoryOnly: true, humanReviewRequired: true,
    };
    if (!row.comparisonReason) row.comparisonReason = 'language_checks_unsupported';
  }
  const evidence = {
    method: 'transparent lexical rules; no trained model',
    potentialOnly: true,
    humanReviewRequired: true,
    candidateExcerpt: row.translation,
    referenceExcerpt: row.reference.translation,
    referenceProvenance: row.reference.provenance,
    referenceRowNumber: row.reference.rowNumber,
  };
  // Same-language English/Arabic marker lists are deliberately narrow. Unknown
  // languages get lexical comparison only, never a fabricated negation result.
  const negationSet = language === 'ar' ? ARABIC_NEGATIONS : language === 'en' || !language ? ENGLISH_NEGATIONS : null;
  if (negationSet) {
    const candidateNegations = candidateTokens.filter((token) => negationSet.has(token.value));
    const referenceNegations = referenceTokens.filter((token) => negationSet.has(token.value));
    const countOnlyDifference = candidateNegations.length > 0 && referenceNegations.length > 0 && candidateNegations.length !== referenceNegations.length;
    if (countOnlyDifference) {
      // Both sides negate, but one has more markers (e.g. "not ... not" vs "not"). Markers are paired by value in
      // reading order; the unpaired ones are the added (candidate) or removed (reference) markers.
      const added = unpairedNegations(candidateNegations, referenceNegations);
      const removed = unpairedNegations(referenceNegations, candidateNegations);
      addFinding({
        code: NEGATION_COUNT_CODE, type: 'comparison', severity: NEGATION_COUNT_SEVERITY,
        message: 'اختلاف محتمل في عدد أدوات النفي: النفي موجود في النصين لكن عدد مرّاته مختلف؛ راجع السياق والمعنى مع الدليل.',
        reason: 'Explicit negation markers are present on both sides but their counts differ. This is a potential lexical signal, not proof of changed meaning; legitimate translations may negate differently.',
        spans: [
          ...added.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'candidate', change: 'added' })),
          ...removed.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'reference', change: 'removed' })),
        ],
        evidence: {
          ...evidence, countOnly: true,
          candidateNegations: candidateNegations.map((token) => token.text), referenceNegations: referenceNegations.map((token) => token.text),
          candidateNegationCount: candidateNegations.length, referenceNegationCount: referenceNegations.length,
          addedNegations: added.map((token) => token.text), removedNegations: removed.map((token) => token.text),
          supportedMarkerLanguage: language || 'en (undeclared language)',
        },
      }, [row]);
    } else if (Boolean(candidateNegations.length) !== Boolean(referenceNegations.length)) {
      addFinding({
        code: 'potential_negation_change', type: 'comparison', severity: 'high',
        message: 'اختلاف محتمل في وجود أداة نفي؛ راجع السياق والمعنى مع الدليل.',
        reason: 'An explicit negation marker is present on one side only. This is a potential lexical signal, not proof of changed meaning.',
        spans: [
          ...candidateNegations.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'candidate' })),
          ...referenceNegations.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'reference' })),
        ],
        evidence: { ...evidence, candidateNegations: candidateNegations.map((token) => token.text), referenceNegations: referenceNegations.map((token) => token.text), supportedMarkerLanguage: language || 'en (undeclared language)' },
      }, [row]);
    }
  }
  const candidateSet = new Set(candidateTokens.map((token) => token.value));
  const referenceSet = new Set(referenceTokens.map((token) => token.value));
  const union = new Set([...candidateSet, ...referenceSet]);
  const shared = [...candidateSet].filter((value) => referenceSet.has(value)).length;
  const similarity = union.size ? shared / union.size : 1;
  const added = candidateTokens.filter((token) => !referenceSet.has(token.value));
  const removed = referenceTokens.filter((token) => !candidateSet.has(token.value));
  // A reference is a comparison point, not a mandated wording. Significant
  // lexical difference merits review; legitimate paraphrases may be flagged.
  if (similarity < 0.65 && (candidateTokens.length >= 3 || referenceTokens.length >= 3)) {
    addFinding({
      code: 'lexical_difference', type: 'comparison', severity: 'low',
      message: 'اختلاف صياغة يحتاج قراءة؛ قد يكون إعادة صياغة سليمة، وكل الألفاظ المختلفة معروضة للمراجعة.',
      reason: 'Token-set overlap is below the transparent heuristic threshold. Similarity is not semantic equivalence or an accuracy score.',
      spans: [
        ...added.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'candidate' })),
        ...removed.map((token) => ({ field: 'translation', start: token.start, end: token.end, text: token.text, role: 'reference' })),
      ],
      evidence: { ...evidence, lexicalOverlap: Number(similarity.toFixed(4)), threshold: 0.65, addedTokens: [...new Set(added.map((token) => token.value))], removedTokens: [...new Set(removed.map((token) => token.value))] },
    }, [row]);
  }
}

/** Complete selected-surah teaching reference; NOT Quran text or a translation. */
export function generateDemoReferenceRows() {
  return [1, 112, 113, 114].flatMap((surah) => Array.from(
    { length: SURAH_AYAH_COUNTS[surah - 1] },
    (_, index) => ({
      surah, ayah: index + 1,
      translation: `SYNTHETIC TRAINING TEXT ${surah}:${index + 1}. The sample process does not allow an unchecked action.`,
    }),
  )).map((row, index) => ({ ...row, rowNumber: index + 2 }));
}

/**
 * 24 educational rows with deliberate defects across 22 expected verse IDs. Recommended scope:
 * {type:'selected',surahs:[1,112,113,114]}. All texts visibly state SYNTHETIC.
 * Metadata must disclose candidate.synthetic and unverified teaching reference.
 */
export function generateDemoRows() {
  const rows = generateDemoReferenceRows().filter((row) => !(row.surah === 1 && row.ayah === 3));
  const empty = rows.find((row) => row.surah === 1 && row.ayah === 4);
  empty.translation = '';
  const negation = rows.find((row) => row.surah === 112 && row.ayah === 2);
  negation.translation = `SYNTHETIC TRAINING TEXT 112:2. The sample process does allow an unchecked action.`;
  rows.push({ ...rows.find((row) => row.surah === 113 && row.ayah === 1), translation: 'SYNTHETIC TRAINING TEXT. A duplicated row for the file-review exercise.' });
  rows.push({ surah: 114, ayah: '2-3', translation: 'SYNTHETIC TRAINING TEXT. A merged range requiring manual alignment.' });
  rows.push({ surah: 115, ayah: 1, translation: 'SYNTHETIC TRAINING TEXT. An intentionally invalid chapter identifier.' });
  [rows[0], rows[1]] = [rows[1], rows[0]];
  return rows.map((row, index) => ({ ...row, rowNumber: index + 2 }));
}
