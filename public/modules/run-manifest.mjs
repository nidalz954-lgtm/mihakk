import {normalizeScope, strictInteger, isValidVerseId, INDEX_PROVENANCE} from './quran-index.mjs';
import {getEligibleContextRows, NLI_MODEL, CONTEXT_MODELS} from './context-risk.mjs';
// Pinned context model that matches the recorded id (English or multilingual); unknown ids never pass as pinned.
function pinnedContextModel(id) { return Object.values(CONTEXT_MODELS).find(model => model.id === id) ?? NLI_MODEL; }
import {MODEL as EMBEDDING_MODEL} from './semantic-ai.mjs';

/** A local replay record, never a translation certificate or proof of inference. */
export const RUN_MANIFEST_SCHEMA = 'mihakk-run-manifest/1';
export const RUN_MANIFEST_METHOD = 'mihakk-coverage-replay/1.0.0';
export const RUN_HISTORY_LIMIT = 12;
const MAX_ROWS = 100000;
const MAX_HASH_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const COUNT_FIELDS = ['expected','read','valid','comparable','modelEligible','processed','abstained','notProcessed'];
const STATES = new Set(['complete','partial','not_requested','not_run','no_pairs','cancelled','failed','truncated','inconsistent']);
const CHANGE_REASONS = new Set(['first_run','same_evidence','input_changed','output_changed','context_changed','method_changed','scope_changed','coverage_changed','execution_changed']);
const ISSUE_CODES = new Set(['input_report_row_count_mismatch','input_report_scope_mismatch','report_rows_without_keys','report_row_key_duplicate','report_input_rows_mismatch','report_input_reference_mismatch','reported_eligible_mismatch','reported_processed_mismatch','invalid_reported_count','results_without_execution','explicit_incomplete','completion_not_recorded','results_outside_eligible_set']);
const VOLATILE_KEYS = new Set(['generatedAt','createdAt','retrievedAt','bibliographicRetrievedAt','inferredAt','savedAt','elapsedMS','startedAt','completedAt','runManifest','runHistory']);

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function positiveCount(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROWS; }
function meaningful(value) { return typeof value === 'string' && value.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,'').trim().length > 0; }
function hex(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null; }
function language(value) { const text=String(value ?? '').trim().toLowerCase(); return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/.test(text) ? text.replaceAll('_','-') : text === 'english' ? 'en' : text === 'arabic' || text === 'العربية' ? 'ar' : 'unknown'; }
function keysUnique(rows) { const counts=new Map(); for(const row of rows)counts.set(row?.key,(counts.get(row?.key)||0)+1); return counts; }
function validId(row) { return isValidVerseId(strictInteger(row?.surah),strictInteger(row?.ayah)); }
function idOf(row) { return validId(row) ? `${strictInteger(row.surah)}:${strictInteger(row.ayah)}` : null; }
function inScope(row,scope) { return validId(row) && (scope.type === 'provided' || scope.surahs.includes(strictInteger(row.surah))); }
function safeModel(kind,analysis) {
  const source=kind==='context' ? analysis.contextModel : analysis.model;
  const pinned=kind==='context' ? pinnedContextModel(source?.id) : EMBEDDING_MODEL;
  if(!source)return null;
  return {id:source.id===pinned.id ? pinned.id : 'unknown',revision:source.revision===pinned.revision ? pinned.revision : null,declaredOnly:true,religiousDomainValidated:false};
}

/** JSON canonicalization preserves raw spelling, case, punctuation and row order.
 * Object property order is irrelevant; unsupported/cyclic data is rejected.
 * Optional semantic mode excludes clock/runtime fields, never text or scores.
 */
export function canonicalStringify(value,{semantic=false}={}) {
  const stack=new Set(); let visits=0;
  function encode(item,depth=0,inArray=false) {
    if(depth>60 || ++visits>2000000)throw new RangeError('Canonical input is too deeply nested or too large.');
    if(item===null)return 'null';
    if(typeof item==='string' || typeof item==='boolean')return JSON.stringify(item);
    if(typeof item==='number'){if(!Number.isFinite(item))throw new TypeError('Canonical input contains a nonfinite number.'); return JSON.stringify(item);}
    if(item===undefined)return inArray ? 'null' : undefined;
    if(!Array.isArray(item)&&!plain(item))throw new TypeError('Canonical input must contain plain JSON data only.');
    if(stack.has(item))throw new TypeError('Canonical input contains a cycle.');
    stack.add(item);
    let result;
    if(Array.isArray(item))result=`[${item.map(child=>encode(child,depth+1,true)).join(',')}]`;
    else result=`{${Object.keys(item).sort().filter(key=>!(semantic&&VOLATILE_KEYS.has(key))).map(key=>{const encoded=encode(item[key],depth+1);return encoded===undefined?null:`${JSON.stringify(key)}:${encoded}`;}).filter(item=>item!==null).join(',')}}`;
    stack.delete(item); return result;
  }
  const result=encode(value);
  if(result===undefined)throw new TypeError('Canonical root cannot be undefined.');
  return result;
}

export async function sha256Canonical(value,options={}) {
  if(!globalThis.crypto?.subtle)throw new Error('سجل التشغيل يحتاج WebCrypto في متصفح حديث وHTTPS أو تشغيل محلي.');
  const bytes=new TextEncoder().encode(canonicalStringify(value,options));
  if(bytes.byteLength>MAX_HASH_BYTES)throw new RangeError('Canonical fingerprint input exceeds 128 MiB.');
  const result=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(result)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function sourceCounts(rows,scope) {
  const ids=new Map(); let valid=0,empty=0;
  for(const row of rows){if(inScope(row,scope)){valid++;const id=idOf(row);if(!ids.has(id))ids.set(id,[]);ids.get(id).push(row);}if(!meaningful(row?.translation))empty++;}
  return {read:rows.length,valid,invalid:rows.filter(row=>!validId(row)).length,outOfScope:rows.filter(row=>validId(row)&&!inScope(row,scope)).length,empty,uniqueValidIds:ids.size,duplicateRows:[...ids.values()].reduce((n,list)=>n+Math.max(0,list.length-1),0),usableUniqueIds:[...ids.values()].filter(list=>list.length===1&&meaningful(list[0]?.translation)).length};
}

function contextCounts(analysis,kind,eligibleKeys,rows,base) {
  const requestedMode=String(analysis.requestedMode ?? '');
  const requested=kind==='context' ? requestedMode.startsWith('context') || Boolean(analysis.contextModel) : requestedMode.startsWith('embedding') || Boolean(analysis.model) || analysis.semanticProcessedRows!==undefined;
  const execution=kind==='context' ? analysis.contextExecution ?? {} : analysis.execution ?? {};
  const errorPresent=Boolean(kind==='context' ? analysis.contextError || (requested&&analysis.modelError) || execution.error : (requested&&analysis.modelError) || execution.error);
  const cancelled=requested&&(analysis.aiCancelled===true || execution.cancelled===true);
  const explicitIncomplete=kind==='context' ? analysis.contextCompleted===false || execution.completed===false : execution.completed===false;
  const keyCounts=keysUnique(rows);
  const results=rows.filter(row=>{
    if(!eligibleKeys.has(row.key)||keyCounts.get(row.key)!==1)return false;
    if(kind==='context')return row.nli?.actuallyInferred===true && row.nli.model===pinnedContextModel(analysis.contextModel?.id).id && row.nli.revision===pinnedContextModel(analysis.contextModel?.id).revision && ['contradiction','entailment','neutral','entailmentGap'].every(field=>Number.isFinite(row.nli[field])&&row.nli[field]>=0&&row.nli[field]<=1) && ['risk','no_signal','abstain'].includes(row.contextStatus);
    return Boolean(row.semantic && Number.isFinite(row.semantic.cosineSimilarity) && row.semantic.cosineSimilarity>=-1 && row.semantic.cosineSimilarity<=1 && row.semantic.model===EMBEDDING_MODEL.id && row.semantic.revision===EMBEDDING_MODEL.revision);
  });
  const processed=results.length;
  const truncated=results.filter(row=>kind==='context' ? row.nli?.truncated===true : row.semantic?.candidateTruncated===true || row.semantic?.referenceTruncated===true).length;
  const abstained=results.filter(row=>kind==='context' ? row.contextStatus==='abstain' || row.nli?.truncated===true : row.semantic?.candidateTruncated===true || row.semantic?.referenceTruncated===true).length;
  const reportedProcessed=kind==='context' ? analysis.contextProcessedRows : analysis.semanticProcessedRows;
  const reportedEligible=kind==='context' ? analysis.contextEligibleRows : analysis.semanticEligibleRows;
  const issues=[];
  for(const count of [reportedProcessed,reportedEligible])if(count!==undefined&&!positiveCount(count))issues.push('invalid_reported_count');
  if(reportedEligible!==undefined&&reportedEligible!==eligibleKeys.size)issues.push('reported_eligible_mismatch');
  if(reportedProcessed!==undefined&&reportedProcessed!==processed)issues.push('reported_processed_mismatch');
  if(rows.some(row=>!eligibleKeys.has(row.key)&&(kind==='context'?row.nli?.actuallyInferred===true:Boolean(row.semantic))))issues.push('results_outside_eligible_set');
  if(processed>0&&(!requested||execution.actualInference!==true))issues.push('results_without_execution');
  if(processed>0&&processed===eligibleKeys.size&&explicitIncomplete)issues.push('explicit_incomplete');
  if(kind==='context'&&processed>0&&processed===eligibleKeys.size&&analysis.contextCompleted!==true&&execution.completed!==true&&!explicitIncomplete)issues.push('completion_not_recorded');
  let state;
  if(issues.length)state='inconsistent';
  else if(!requested)state='not_requested';
  else if(cancelled)state='cancelled';
  else if(errorPresent)state='failed';
  else if(analysis.aiSkippedReason)state='not_run';
  else if(eligibleKeys.size===0)state='no_pairs';
  else if(processed===0)state='not_run';
  else if(processed<eligibleKeys.size)state='partial';
  else if(truncated)state='truncated';
  else state='complete';
  const languageBlocked=kind==='context' ? rows.filter(row=>['declared_english_script_incompatible','declared_language_script_incompatible'].includes(row.contextNotEligibleReason)).length : 0;
  return {...base,modelEligible:eligibleKeys.size,processed,abstained,languageBlocked,notProcessed:Math.max(0,eligibleKeys.size-processed),requested,state,truncated,cancelled,errorPresent,explicitIncomplete,issues:[...new Set(issues)],model:safeModel(kind,analysis),executionVerification:'recorded-report-state-only'};
}

/** Build after the final structural/AI report; input is the actual mapped rows.
 * Original file SHA256s are byte hashes, while mapped-input hashes cover JSON.
 * This function performs no network request and writes no browser storage.
 */
export async function createRunManifest({report,input,previous=null}={}) {
  if(!plain(report)||!Array.isArray(report.rows)||!Array.isArray(report.findings))throw new TypeError('A batch report with rows and findings is required.');
  if(!plain(input)||!Array.isArray(input.rows)||!Array.isArray(input.referenceRows))throw new TypeError('Actual mapped candidate and reference rows are required.');
  if(report.rows.length>MAX_ROWS||input.rows.length>MAX_ROWS||input.referenceRows.length>MAX_ROWS)throw new RangeError('Run manifest is limited to 100,000 rows per source.');
  // Freeze the evidence synchronously before the first digest yields. Otherwise
  // callers can alter text/metadata between hashes, creating a mixed-run record.
  const snapshot=value=>{const json=canonicalStringify(value);if(new TextEncoder().encode(json).byteLength>MAX_HASH_BYTES)throw new RangeError('Canonical fingerprint input exceeds 128 MiB.');return JSON.parse(json);};
  report=snapshot(report);input=snapshot(input);
  const before=safeHistoryEntry(previous);
  const scope=normalizeScope(input.scope ?? report.scope);
  const reportScope=normalizeScope(report.scope);
  const expected=scope.type==='provided' ? null : scope.expectedVerses;
  const candidate=sourceCounts(input.rows,scope),reference=sourceCounts(input.referenceRows,scope);
  const analysis=report.provenance?.analysis ?? {};
  const lexicalRows=report.rows.filter(row=>inScope(row,scope)&&meaningful(row.translation)&&meaningful(row.reference?.translation)&&(row.comparisonStatus==='compared'||row.comparisonReason==='unverified_reference'));
  const base={expected,read:input.rows.length,valid:candidate.valid,comparable:lexicalRows.length,modelEligible:0,processed:0,abstained:0,notProcessed:0};
  const issues=[];
  if(report.rows.length!==input.rows.length)issues.push('input_report_row_count_mismatch');
  if(scope.type!==reportScope.type||canonicalStringify(scope.surahs)!==canonicalStringify(reportScope.surahs))issues.push('input_report_scope_mismatch');
  if(report.rows.some(row=>typeof row?.key!=='string'||!row.key))issues.push('report_rows_without_keys');
  if([...keysUnique(report.rows).values()].some(n=>n>1))issues.push('report_row_key_duplicate');
  // The hash alone cannot establish that the supplied report audited these rows.
  // Verify mapped row order/text/IDs and every linked reference against inputs.
  if(report.rows.length===input.rows.length&&report.rows.some((row,index)=>{
    const raw=input.rows[index];return idOf(raw)!==row.verseId || (typeof raw?.translation==='string'?raw.translation:'')!==row.translation;
  }))issues.push('report_input_rows_mismatch');
  const referenceIds=new Map();for(const raw of input.referenceRows){const id=idOf(raw);if(id){if(!referenceIds.has(id))referenceIds.set(id,[]);referenceIds.get(id).push(raw);}}
  if(report.rows.some(row=>{if(!row?.reference)return false;const matches=referenceIds.get(row.verseId)||[];return matches.length!==1||matches[0]?.translation!==row.reference.translation;}))issues.push('report_input_reference_mismatch');
  const contextEligible=new Set(getEligibleContextRows(report).map(row=>row.key));
  const embeddingEligible=new Set(report.rows.filter(row=>row.reference&&row.comparisonStatus==='compared'&&row.translation!==row.reference.translation).map(row=>row.key));
  const layers={
    structure:{...base,comparable:0,processed:Math.min(report.rows.length,input.rows.length),notProcessed:Math.max(0,input.rows.length-report.rows.length),state:issues.length?'inconsistent':'complete',requested:true,issues:[...issues],structuralFindingCount:report.findings.filter(f=>f.type==='structural').length,passed:report.rows.length>0&&issues.length===0&&!report.findings.some(f=>f.type==='structural')},
    lexical:{...base,processed:lexicalRows.length,abstained:Math.max(0,input.rows.length-lexicalRows.length),state:issues.length?'inconsistent':lexicalRows.length?'complete':'no_pairs',requested:true,issues:[...issues],authorityUnresolved:lexicalRows.filter(row=>row.comparisonReason==='unverified_reference').length},
    context:contextCounts(analysis,'context',contextEligible,report.rows,base),
    embedding:contextCounts(analysis,'embedding',embeddingEligible,report.rows,base),
  };
  for(const kind of ['context','embedding'])if(issues.length){layers[kind].issues=[...new Set([...layers[kind].issues,...issues])];layers[kind].state='inconsistent';}
  const context={methodVersion:RUN_MANIFEST_METHOD,reportSchemaVersion:report.schemaVersion??null,scope,index:report.provenance?.index??INDEX_PROVENANCE,metadata:input.metadata??{},provenance:report.provenance??{}};
  const fingerprints={
    candidateRowsSha256:await sha256Canonical(input.rows),referenceRowsSha256:await sha256Canonical(input.referenceRows),
    candidateFileSha256:hex(input.candidateFileSha256),referenceFileSha256:hex(input.referenceFileSha256),
    inputSha256:await sha256Canonical({rows:input.rows,referenceRows:input.referenceRows,scope:input.scope??report.scope,metadata:input.metadata??{},candidateFileSha256:hex(input.candidateFileSha256),referenceFileSha256:hex(input.referenceFileSha256)}),
    outputSha256:await sha256Canonical(report,{semantic:true}),contextSha256:await sha256Canonical(context,{semantic:true}),
  };
  const declaredScope={type:scope.type,surahs:scope.type==='provided'?[...new Set(input.rows.filter(validId).map(row=>strictInteger(row.surah)))].sort((a,b)=>a-b):scope.surahs,expected,observedUniqueIds:candidate.uniqueValidIds,completenessAssertion:scope.type==='provided'?'provided-rows-only':scope.type==='full'?'full-index':'selected-surahs',candidateLanguage:language(report.provenance?.candidate?.language),referenceLanguage:language(report.provenance?.reference?.language)};
  const counts={...base,processed:layers.structure.processed,abstained:layers.lexical.abstained,notProcessed:layers.structure.notProcessed,modelEligible:new Set([...contextEligible,...embeddingEligible]).size};
  const manifest={schemaVersion:RUN_MANIFEST_SCHEMA,methodVersion:RUN_MANIFEST_METHOD,reportSchemaVersion:typeof report.schemaVersion==='string'?report.schemaVersion:null,runId:globalThis.crypto.randomUUID(),createdAt:new Date().toISOString(),fingerprints,declaredScope,counts,sources:{candidate,reference},layers,scopeIdCoverage:{expected,observed:candidate.uniqueValidIds,missing:expected===null?null:Math.max(0,expected-candidate.uniqueValidIds),percent:expected===null?null:Number((candidate.uniqueValidIds/expected*100).toFixed(2)),complete:expected===null?null:candidate.uniqueValidIds===expected},safety:{certificate:false,publicationAuthorized:false,modelScoresAreAccuracy:false,expertReviewRequired:true,sourceTextStored:false},changeReasons:[]};
  if(!before)manifest.changeReasons=['first_run'];
  else{
    for(const [field,reason] of [['inputSha256','input_changed'],['outputSha256','output_changed'],['contextSha256','context_changed']])if(before.fingerprints[field]!==fingerprints[field])manifest.changeReasons.push(reason);
    if(before.methodVersion!==manifest.methodVersion)manifest.changeReasons.push('method_changed');
    if(canonicalStringify(before.declaredScope)!==canonicalStringify(declaredScope))manifest.changeReasons.push('scope_changed');
    if(canonicalStringify(before.counts)!==canonicalStringify(counts))manifest.changeReasons.push('coverage_changed');
    if(canonicalStringify(before.layers)!==canonicalStringify(safeHistoryEntry(manifest).layers))manifest.changeReasons.push('execution_changed');
    if(!manifest.changeReasons.length)manifest.changeReasons=['same_evidence'];
  }
  return manifest;
}

function historyLimit(limit) { if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new RangeError('History limit must be between 1 and 50.');return limit; }
function safeCounts(source) {
  if(!plain(source)||COUNT_FIELDS.some(key=>key==='expected' ? source[key]!==null&&!positiveCount(source[key]) : !positiveCount(source[key])))return null;
  return Object.fromEntries(COUNT_FIELDS.map(key=>[key,source[key]]));
}
function safeHistoryEntry(source) {
  if(!plain(source)||source.schemaVersion!==RUN_MANIFEST_SCHEMA||typeof source.runId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source.runId)||typeof source.createdAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.createdAt)||!Number.isFinite(Date.parse(source.createdAt)))return null;
  if(typeof source.methodVersion!=='string'||!/^mihakk-[a-z0-9-]+\/\d+(?:\.\d+)*$/.test(source.methodVersion)||source.methodVersion.length>80)return null;
  const fp=source.fingerprints;
  if(!plain(fp)||['inputSha256','outputSha256','contextSha256','candidateRowsSha256','referenceRowsSha256'].some(key=>!hex(fp[key])))return null;
  const scope=source.declaredScope;
  if(!plain(scope)||!['full','selected','provided'].includes(scope.type)||!Array.isArray(scope.surahs)||scope.surahs.length>114||scope.surahs.some(n=>!Number.isSafeInteger(n)||n<1||n>114)||!positiveCount(scope.observedUniqueIds)||!['provided-rows-only','full-index','selected-surahs'].includes(scope.completenessAssertion))return null;
  if(scope.type==='provided' ? scope.expected!==null : !positiveCount(scope.expected))return null;
  const counts=safeCounts(source.counts);if(!counts)return null;
  const layers={};
  for(const key of ['structure','lexical','context','embedding']){
    const layer=source.layers?.[key];const layerCounts=safeCounts(layer);
    if(!layerCounts||!STATES.has(layer.state))return null;
    layers[key]={...layerCounts,state:layer.state,requested:layer.requested===true,issues:Array.isArray(layer.issues)?[...new Set(layer.issues.filter(code=>ISSUE_CODES.has(code)))]:[]};
    if(key==='structure'){layers[key].structuralFindingCount=positiveCount(layer.structuralFindingCount)?layer.structuralFindingCount:0;layers[key].passed=layer.passed===true;}
    if(key==='lexical')layers[key].authorityUnresolved=positiveCount(layer.authorityUnresolved)?layer.authorityUnresolved:0;
    if(['context','embedding'].includes(key)){
      for(const field of ['cancelled','errorPresent','explicitIncomplete'])layers[key][field]=layer[field]===true;
      layers[key].truncated=positiveCount(layer.truncated)?layer.truncated:0;
      layers[key].languageBlocked=positiveCount(layer.languageBlocked)?layer.languageBlocked:0;
      const pinned=key==='context'?pinnedContextModel(layer.model?.id):EMBEDDING_MODEL;
      layers[key].model=layer.model?{id:layer.model.id===pinned.id?pinned.id:'unknown',revision:layer.model.revision===pinned.revision?pinned.revision:null,declaredOnly:true,religiousDomainValidated:false}:null;
      layers[key].executionVerification='recorded-report-state-only';
    }
  }
  return {schemaVersion:RUN_MANIFEST_SCHEMA,methodVersion:source.methodVersion,runId:source.runId,createdAt:source.createdAt,fingerprints:Object.fromEntries(['inputSha256','outputSha256','contextSha256','candidateRowsSha256','referenceRowsSha256','candidateFileSha256','referenceFileSha256'].map(key=>[key,hex(fp[key])])),declaredScope:{type:scope.type,surahs:[...scope.surahs],expected:scope.expected,observedUniqueIds:scope.observedUniqueIds,completenessAssertion:scope.completenessAssertion,candidateLanguage:language(scope.candidateLanguage),referenceLanguage:language(scope.referenceLanguage)},counts,layers,safety:{certificate:false,publicationAuthorized:false,modelScoresAreAccuracy:false,expertReviewRequired:true,sourceTextStored:false},changeReasons:Array.isArray(source.changeReasons)?[...new Set(source.changeReasons.filter(reason=>CHANGE_REASONS.has(reason)))]:[]};
}

/** Store only these whitelisted summaries. Text, filenames, titles, free notes,
 * model error strings and raw reports are deliberately not persisted.
 */
export function appendRunHistory(history,manifest,{limit=RUN_HISTORY_LIMIT}={}) {
  const maximum=historyLimit(limit);if(!Array.isArray(history))throw new TypeError('History must be an array.');
  const entry=safeHistoryEntry(manifest);if(!entry)throw new TypeError('Invalid run manifest.');
  const saved=history.slice(-50).map(safeHistoryEntry).filter(Boolean).filter(item=>item.runId!==entry.runId);
  return [...saved,entry].slice(-maximum);
}

/** Union of two histories (for example this tab and what another tab wrote), by run id, oldest first, bounded. */
export function mergeRunHistory(first,second,{limit=RUN_HISTORY_LIMIT}={}) {
  const maximum=historyLimit(limit);if(!Array.isArray(first)||!Array.isArray(second))throw new TypeError('History must be an array.');
  const unique=new Map();for(const source of [...first.slice(-50),...second.slice(-50)]){const entry=safeHistoryEntry(source);if(entry)unique.set(entry.runId,entry);}
  return [...unique.values()].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).slice(-maximum);
}

export function parseRunHistory(serialized,{limit=RUN_HISTORY_LIMIT}={}) {
  const maximum=historyLimit(limit);
  if(typeof serialized!=='string'||serialized.length>MAX_HISTORY_BYTES)return [];
  let data;try{data=JSON.parse(serialized);}catch{return [];}
  if(!Array.isArray(data))return [];
  const unique=new Map();for(const source of data.slice(-50)){const entry=safeHistoryEntry(source);if(entry){unique.delete(entry.runId);unique.set(entry.runId,entry);}}
  return [...unique.values()].slice(-maximum);
}

export function stringifyRunHistory(history,{limit=RUN_HISTORY_LIMIT}={}) {
  const maximum=historyLimit(limit);if(!Array.isArray(history))throw new TypeError('History must be an array.');
  const entries=history.slice(-50).map(safeHistoryEntry).filter(Boolean).slice(-maximum);
  const serialized=JSON.stringify(entries);if(serialized.length>MAX_HISTORY_BYTES)throw new RangeError('Run history exceeds storage limit.');
  return serialized;
}
