import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditBatch} from '../public/modules/batch-engine.mjs';
import {appendContextResults, aggregateContextScores} from '../public/modules/context-risk.mjs';
import {appendSemanticResults} from '../public/modules/semantic-ai.mjs';
import {canonicalStringify, sha256Canonical, createRunManifest, appendRunHistory, parseRunHistory, stringifyRunHistory, RUN_MANIFEST_METHOD, RUN_HISTORY_LIMIT} from '../public/modules/run-manifest.mjs';

// Authored NONRELIGIOUS fixtures and injected model scores verify engineering
// protocol only. No model download, actual inference, or domain validation.
const entail={contradiction:0.04,entailment:0.9,neutral:0.06};
const uncertain={contradiction:0.05,entailment:0.05,neutral:0.9};
function fixture({count=2,scope={type:'provided'},verified=true,mode='structural-and-lexical-rules',candidateLanguage='en',referenceLanguage='en'}={}) {
  return {rows:Array.from({length:count},(_,i)=>({surah:112,ayah:i+1,translation:`NONRELIGIOUS authored candidate ${i+1} has changed wording.`})),referenceRows:Array.from({length:count},(_,i)=>({surah:112,ayah:i+1,translation:`NONRELIGIOUS authored reference ${i+1} uses original wording.`})),scope,metadata:{candidate:{name:'Authored fixture',language:candidateLanguage,synthetic:true},reference:{title:'NONRELIGIOUS authored fixture',language:referenceLanguage,verificationStatus:verified?'verified':'unverified',sourceKind:'synthetic-teaching',author:'Fixture author',publisher:'Fixture publisher',edition:'fixture-1',licenseNote:'MIT'},analysisMode:mode}};
}
function rawScore(key,distribution=entail,extra={}) {return aggregateContextScores(distribution,distribution,{key,modelCalls:2,pairTokens:18,usedPairTokens:18,truncated:false,...extra});}
function contextReport(input,{processed=input.rows.length,completed=true,cancelled=false,error=null,uncertainFirst=false,truncatedFirst=false,actualInference=true}={}) {
  const base=auditBatch(input);const results=base.rows.slice(0,processed).map((row,i)=>rawScore(row.key,uncertainFirst&&i===0?uncertain:entail,{truncated:truncatedFirst&&i===0}));
  return appendContextResults(base,results,{actualInference,completed,cancelled,error});
}

test('provided scope has unknown expectation and never displays global 100 percent coverage',async()=>{
  const input=fixture();const report=auditBatch(input);assert.equal(report.summary.coveragePercent,100);
  const result=await createRunManifest({report,input});
  assert.equal(result.counts.expected,null);assert.equal(result.scopeIdCoverage.expected,null);assert.equal(result.scopeIdCoverage.percent,null);assert.equal(result.scopeIdCoverage.complete,null);
  assert.equal(result.declaredScope.completenessAssertion,'provided-rows-only');assert.equal(result.declaredScope.observedUniqueIds,2);
  for(const layer of Object.values(result.layers))assert.equal(layer.expected,null);
  assert.equal(result.safety.certificate,false);assert.equal(result.safety.publicationAuthorized,false);
});

test('selected/full expectation comes from pinned index rather than report counters',async()=>{
  for(const [scope,expected] of [[{type:'selected',surahs:[112]},4],[{type:'full'},6236]]){
    const input=fixture({count:1,scope});const report=auditBatch(input);report.summary.expectedVerses=1;report.scope.expectedVerses=1;
    const result=await createRunManifest({report,input});assert.equal(result.counts.expected,expected);assert.equal(result.scopeIdCoverage.missing,expected-1);assert.equal(result.scopeIdCoverage.complete,false);
  }
});

test('structural read/valid counts disclose duplicates, invalid, empty and out-of-scope rows',async()=>{
  const input=fixture({count:1,scope:{type:'selected',surahs:[112]}});
  input.rows.push({...input.rows[0]},{surah:112,ayah:2,translation:' '},{surah:115,ayah:1,translation:'Invalid fixture'},{surah:113,ayah:1,translation:'Outside fixture'});
  const result=await createRunManifest({report:auditBatch(input),input});
  assert.deepEqual(result.sources.candidate,{read:5,valid:3,invalid:1,outOfScope:1,empty:1,uniqueValidIds:2,duplicateRows:1,usableUniqueIds:0});
  assert.equal(result.layers.structure.processed,5);assert.equal(result.layers.structure.notProcessed,0);assert.equal(result.layers.structure.passed,false);
  assert.equal(result.layers.lexical.comparable,0);assert.equal(result.layers.lexical.abstained,5);
});

test('ambiguous reference and missing reference are abstention rather than fabricated processing',async()=>{
  const input=fixture({count:3});input.referenceRows=[input.referenceRows[0],{...input.referenceRows[0]},input.referenceRows[1],{surah:120,ayah:1,translation:'Invalid reference'}];
  const result=await createRunManifest({report:auditBatch(input),input});
  assert.equal(result.sources.reference.read,4);assert.equal(result.sources.reference.invalid,1);assert.equal(result.sources.reference.duplicateRows,1);assert.equal(result.sources.reference.usableUniqueIds,1);
  assert.equal(result.layers.lexical.comparable,1);assert.equal(result.layers.lexical.processed,1);assert.equal(result.layers.lexical.abstained,2);
});

test('unverified reference permits disclosed lexical inspection and contextual eligibility only',async()=>{
  const input=fixture({verified:false,mode:'context-requested'});const result=await createRunManifest({report:auditBatch(input),input});
  assert.equal(result.layers.lexical.comparable,2);assert.equal(result.layers.lexical.authorityUnresolved,2);assert.equal(result.layers.context.modelEligible,2);assert.equal(result.layers.context.processed,0);assert.equal(result.layers.context.notProcessed,2);assert.equal(result.layers.context.state,'not_run');
  assert.equal(result.layers.embedding.modelEligible,0);assert.equal(result.layers.embedding.state,'not_requested');
});

test('English context and multilingual embedding eligibility remain separate',async()=>{
  const input=fixture({candidateLanguage:'ar',referenceLanguage:'ar',mode:'embedding-requested'});const result=await createRunManifest({report:auditBatch(input),input});
  assert.equal(result.layers.context.modelEligible,0);assert.equal(result.layers.embedding.modelEligible,2);assert.equal(result.layers.embedding.state,'not_run');
});

test('pre-model language abstention is disclosed separately from processed model abstentions',async()=>{
  const input=fixture({count:1,mode:'context-requested'}); input.rows[0].translation='هذا نص عربي.';
  const report=appendContextResults(auditBatch(input),[],{actualInference:false,completed:true});
  const manifest=await createRunManifest({report,input});
  assert.equal(manifest.layers.context.modelEligible,0);
  assert.equal(manifest.layers.context.processed,0);
  assert.equal(manifest.layers.context.abstained,0);
  assert.equal(manifest.layers.context.languageBlocked,1);
  assert.equal(manifest.layers.context.state,'no_pairs');
  const history=parseRunHistory(stringifyRunHistory(appendRunHistory([],manifest)));
  assert.equal(history[0].layers.context.languageBlocked,1);
  assert.equal(manifest.safety.publicationAuthorized,false);
});

test('language mismatch and identical texts create no eligible model pairs',async()=>{
  for(const crossLanguage of [true,false]){
    const input=fixture({mode:'context-requested',referenceLanguage:crossLanguage?'ar':'en'});if(!crossLanguage)input.referenceRows=input.rows.map(row=>({...row}));
    const report=contextReport(input,{processed:0,completed:false});const result=await createRunManifest({report,input});
    assert.equal(result.layers.context.modelEligible,0);assert.equal(result.layers.context.processed,0);assert.equal(result.layers.context.state,'no_pairs');
    if(crossLanguage)assert.equal(result.layers.lexical.abstained,2);
  }
});

test('context run records actual row evidence and model abstentions separately',async()=>{
  const input=fixture({mode:'context-requested'});const report=contextReport(input,{uncertainFirst:true});const result=await createRunManifest({report,input});
  assert.equal(result.layers.context.state,'complete');assert.equal(result.layers.context.modelEligible,2);assert.equal(result.layers.context.processed,2);assert.equal(result.layers.context.abstained,1);assert.equal(result.layers.context.notProcessed,0);
  assert.equal(result.layers.context.executionVerification,'recorded-report-state-only');assert.equal(result.layers.context.model.declaredOnly,true);assert.equal(result.layers.context.model.religiousDomainValidated,false);
});

test('partial context run retains remaining pairs rather than masking them as abstentions',async()=>{
  const input=fixture({count:3,mode:'context-requested'});const result=await createRunManifest({report:contextReport(input,{processed:1,completed:false}),input});
  assert.equal(result.layers.context.state,'partial');assert.equal(result.layers.context.processed,1);assert.equal(result.layers.context.notProcessed,2);assert.equal(result.layers.context.abstained,0);
});

test('cancelled and failed runs preserve actual processed evidence and remaining pairs',async()=>{
  for(const [extra,state] of [[{cancelled:true},'cancelled'],[{error:'SECRET source text from a malicious failure'},'failed']]){
    const input=fixture({count:3,mode:'context-requested'});const result=await createRunManifest({report:contextReport(input,{processed:1,completed:false,...extra}),input});
    assert.equal(result.layers.context.state,state);assert.equal(result.layers.context.processed,1);assert.equal(result.layers.context.notProcessed,2);assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('matching counters cannot override explicit incomplete context flag',async()=>{
  const input=fixture({mode:'context-requested'});const report=contextReport(input,{completed:false});const result=await createRunManifest({report,input});
  assert.equal(result.layers.context.processed,2);assert.equal(result.layers.context.state,'inconsistent');assert.ok(result.layers.context.issues.includes('explicit_incomplete'));
});

test('nested incomplete flag also blocks full processing even when top-level complete is true',async()=>{
  const input=fixture({mode:'context-requested'});const report=contextReport(input);report.provenance.analysis.contextExecution.completed=false;
  const result=await createRunManifest({report,input});assert.equal(result.layers.context.state,'inconsistent');assert.equal(result.layers.context.explicitIncomplete,true);
});

test('simulated results never become actual processed rows when actualInference is false',async()=>{
  const input=fixture({mode:'context-requested'});const report=contextReport(input,{actualInference:false});const result=await createRunManifest({report,input});
  assert.equal(result.layers.context.processed,0);assert.equal(result.layers.context.notProcessed,2);assert.equal(result.layers.context.state,'not_run');
});

test('truncation is disclosed as abstention and limited completed processing',async()=>{
  const input=fixture({mode:'context-requested'});const result=await createRunManifest({report:contextReport(input,{truncatedFirst:true}),input});
  assert.equal(result.layers.context.state,'truncated');assert.equal(result.layers.context.processed,2);assert.equal(result.layers.context.abstained,1);assert.equal(result.layers.context.truncated,1);
});

test('forged counters, negative counts, duplicates and results outside eligible rows cannot establish completion',async()=>{
  const input=fixture({mode:'context-requested'});
  for(const mutate of [report=>{report.provenance.analysis.contextProcessedRows=2;},report=>{report.provenance.analysis.contextEligibleRows=-1;},report=>{report.rows[1].key=report.rows[0].key;},report=>{report.rows[0].nli={actuallyInferred:true};report.rows[0].contextStatus='risk';report.rows[0].comparisonStatus='abstain';report.rows[0].comparisonReason='missing_reference';}]){
    const report=auditBatch(input);mutate(report);const result=await createRunManifest({report,input});assert.equal(result.layers.context.state,'inconsistent');assert.equal(result.layers.context.processed,0);
  }
});

test('embedding report records processed scores, truncated abstention and counters safely',async()=>{
  const input=fixture({mode:'embedding-requested'});const base=auditBatch(input);const report=appendSemanticResults(base,[{key:base.rows[0].key,similarity:.98},{key:base.rows[1].key,similarity:.9,candidateTruncated:true}],{actualInference:true,completed:true});
  const result=await createRunManifest({report,input});assert.equal(result.layers.embedding.processed,2);assert.equal(result.layers.embedding.state,'truncated');assert.equal(result.layers.embedding.abstained,1);
  report.provenance.analysis.execution.completed=false;const contradicted=await createRunManifest({report,input});assert.equal(contradicted.layers.embedding.state,'inconsistent');
});

test('input/report count, text, scope and linked-reference mismatches are explicit',async()=>{
  const input=fixture();
  for(const mutate of [report=>report.rows.pop(),report=>{report.rows[0].translation='Unrelated candidate';},report=>{report.scope={type:'full'};},report=>{report.rows[0].reference.translation='Unrelated reference';}]){
    const report=auditBatch(input);mutate(report);const result=await createRunManifest({report,input});assert.equal(result.layers.structure.state,'inconsistent');assert.equal(result.layers.structure.passed,false);assert.equal(result.layers.context.state,'inconsistent');
  }
});

test('canonical SHA256 matches standard implementation while property order remains irrelevant',async()=>{
  const first={b:['raw punctuation!',null],a:{x:'حُروف'}};const second={a:{x:'حُروف'},b:['raw punctuation!',null]};
  const expected=createHash('sha256').update(canonicalStringify(first)).digest('hex');assert.equal(await sha256Canonical(first),expected);assert.equal(await sha256Canonical(first),await sha256Canonical(second));
  assert.notEqual(await sha256Canonical('word!'),await sha256Canonical('word'));assert.notEqual(await sha256Canonical('Case'),await sha256Canonical('case'));assert.notEqual(await sha256Canonical('حروف'),await sha256Canonical('حُروف'));
});

test('repeated report timestamps do not change output/context fingerprints or replay reasons',async()=>{
  const input=fixture({mode:'context-requested'});const report=contextReport(input);const first=await createRunManifest({report,input});
  report.generatedAt='2030-01-01T00:00:00.000Z';report.provenance.reference.retrievedAt='2030-01-01T00:00:00.000Z';report.provenance.analysis.contextExecution.elapsedMS=99999;report.provenance.analysis.contextExecution.inferredAt='2030-01-01T00:00:00.000Z';
  const second=await createRunManifest({report,input,previous:first});assert.notEqual(second.runId,first.runId);assert.equal(second.fingerprints.outputSha256,first.fingerprints.outputSha256);assert.equal(second.fingerprints.contextSha256,first.fingerprints.contextSha256);assert.deepEqual(second.changeReasons,['same_evidence']);
});

test('raw mapped input and optional original file hashes remain distinct and punctuation changes invalidate replay',async()=>{
  const input=fixture();input.candidateFileSha256='A'.repeat(64);const first=await createRunManifest({report:auditBatch(input),input});assert.equal(first.fingerprints.candidateFileSha256,'a'.repeat(64));assert.notEqual(first.fingerprints.candidateRowsSha256,first.fingerprints.candidateFileSha256);
  input.rows[0].translation+='!';const second=await createRunManifest({report:auditBatch(input),input,previous:first});assert.notEqual(second.fingerprints.candidateRowsSha256,first.fingerprints.candidateRowsSha256);assert.ok(second.changeReasons.includes('input_changed'));assert.ok(second.changeReasons.includes('output_changed'));
  input.candidateFileSha256='b'.repeat(64);const third=await createRunManifest({report:auditBatch(input),input,previous:second});assert.ok(third.changeReasons.includes('input_changed'));
});

test('source identity, thresholds, language and method changes remain visible',async()=>{
  const input=fixture();const base=auditBatch(input);const first=await createRunManifest({report:base,input});
  for(const mutate of [report=>{report.provenance.reference.author='Different author';},report=>{report.provenance.reference.publisher='Different publisher';},report=>{report.provenance.reference.edition='edition-2';},report=>{report.provenance.analysis.contextThresholds={contradiction:.7};},report=>{report.provenance.candidate.language='fr';}]){
    const report=structuredClone(base);mutate(report);const result=await createRunManifest({report,input,previous:first});assert.ok(result.changeReasons.includes('context_changed'));assert.ok(result.changeReasons.includes('output_changed'));
  }
  const previous={...first,methodVersion:'mihakk-coverage-replay/0.9.0'};assert.ok((await createRunManifest({report:base,input,previous})).changeReasons.includes('method_changed'));assert.equal(first.methodVersion,RUN_MANIFEST_METHOD);
});

test('changed model score cannot hide behind unchanged input or wall clock',async()=>{
  const input=fixture({mode:'context-requested'});const first=await createRunManifest({report:contextReport(input),input});const second=await createRunManifest({report:contextReport(input,{uncertainFirst:true}),input,previous:first});
  assert.equal(first.fingerprints.inputSha256,second.fingerprints.inputSha256);assert.ok(second.changeReasons.includes('output_changed'));assert.ok(second.changeReasons.includes('execution_changed'));
});

test('bounded replay history retains hashes/counts and never persists source texts or free-form fields',async()=>{
  const input=fixture();input.rows[0].translation='SECRET candidate text';input.referenceRows[0].translation='SECRET reference text';input.metadata.candidate.name='SECRET filename';input.metadata.reference.title='SECRET title';
  const manifest=await createRunManifest({report:auditBatch(input),input});manifest.oldText='SECRET leaked baseline';manifest.layers.context.error='SECRET error';manifest.decisions={note:'SECRET decision'};
  const serialized=stringifyRunHistory(appendRunHistory([],manifest));assert.ok(!serialized.includes('SECRET'));assert.ok(!serialized.includes('translation'));assert.ok(!serialized.includes('oldText'));assert.equal(parseRunHistory(serialized)[0].fingerprints.outputSha256,manifest.fingerprints.outputSha256);assert.equal(parseRunHistory(serialized)[0].safety.sourceTextStored,false);
  let history=[];for(let i=0;i<RUN_HISTORY_LIMIT+4;i++)history=appendRunHistory(history,{...manifest,runId:crypto.randomUUID()});assert.equal(history.length,RUN_HISTORY_LIMIT);history=appendRunHistory(history,history.at(-1));assert.equal(history.length,RUN_HISTORY_LIMIT);
});

test('malformed/replayed history drops invalid entries and hostile payloads safely',async()=>{
  const input=fixture();const manifest=await createRunManifest({report:auditBatch(input),input});
  for(const source of ['',null,'{bad','{}','null','[]'.repeat(600000)])assert.deepEqual(parseRunHistory(source),[]);
  const poisoned={...manifest,translation:'SECRET',layers:{...manifest.layers,context:{...manifest.layers.context,model:{id:'SECRET',revision:'SECRET'},issues:['SECRET']}}};
  const parsed=parseRunHistory(JSON.stringify([manifest,poisoned,{...manifest,runId:'SECRET'},{...manifest,fingerprints:{...manifest.fingerprints,outputSha256:'BAD'}}]));assert.equal(parsed.length,1);assert.ok(!JSON.stringify(parsed).includes('SECRET'));assert.equal(parsed[0].layers.context.model.id,'unknown');
  assert.throws(()=>appendRunHistory([],{}),TypeError);assert.throws(()=>parseRunHistory('[]',{limit:0}),RangeError);assert.throws(()=>stringifyRunHistory([],{limit:51}),RangeError);
});

test('canonical data and manifest shape limits reject cycles, nonfinite values and unsupported objects',async()=>{
  const cyclic={};cyclic.self=cyclic;assert.throws(()=>canonicalStringify(cyclic),TypeError);assert.throws(()=>canonicalStringify({value:Infinity}),TypeError);assert.throws(()=>canonicalStringify(new Date()),TypeError);assert.throws(()=>canonicalStringify({value:1n}),TypeError);
  assert.equal(canonicalStringify({skip:undefined,value:[undefined]}),'{"value":[null]}');
  await assert.rejects(createRunManifest({report:{rows:[],findings:[]},input:{rows:[]}}),TypeError);
  const input=fixture();await assert.rejects(createRunManifest({report:auditBatch(input),input:{...input,rows:Array(100001).fill(null)}}),RangeError);
});

test('manifest snapshots inputs and report before WebCrypto yields to caller mutation',async()=>{
  const input=fixture({count:1});const report=auditBatch(input);
  const expectedCandidate=await sha256Canonical(input.rows);const expectedOutput=await sha256Canonical(report,{semantic:true});
  const pending=createRunManifest({report,input});
  input.rows[0].translation='MUTATED WHILE HASHING';input.metadata.reference.author='MUTATED AUTHOR';report.rows[0].translation='MUTATED WHILE HASHING';report.provenance.reference.author='MUTATED AUTHOR';
  const manifest=await pending;assert.equal(manifest.fingerprints.candidateRowsSha256,expectedCandidate);assert.equal(manifest.fingerprints.outputSha256,expectedOutput);
});
