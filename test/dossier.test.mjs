import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewDossier} from '../public/modules/dossier.mjs';
const base=()=>({rows:[{verseId:'1:1',reference:{translation:'x'},findings:[]}],findings:[],scope:{type:'provided'},summary:{structuralFindingCount:0},provenance:{candidate:{},reference:{title:'Reference',author:'Named author',publisher:'Named publisher',edition:'1',licenseNote:'Owner supplied'}}});
test('reference presence cannot hide a comparison refused for language mismatch',()=>{const report=base();report.rows[0].comparisonReason='language_mismatch';const dossier=buildReviewDossier(report);const gate=dossier.gates.find(g=>g.id==='source_coverage');assert.equal(gate.status,'hold');assert.match(gate.detail,/اختلاف اللغة/);assert.equal(dossier.status,'needs_work');});
test('completed engineering review never authorizes religious publication',()=>{const out=buildReviewDossier(base());assert.equal(out.status,'ready_for_expert_review');assert.equal(out.publicationAuthorized,false);assert.equal(out.gates.at(-1).status,'required');assert.equal(out.gates[0].status,'limited');});
test('accepted warning requires source correction, not automatic closure',()=>{const r=base();r.findings=[{id:'f1',type:'comparison'}];const out=buildReviewDossier(r,{f1:{value:'accept'}});assert.equal(out.status,'needs_work');assert.equal(out.counts.acceptedSignals,1);});
test('referrals remain unresolved',()=>{const r=base();r.findings=[{id:'f1',type:'comparison'}];assert.equal(buildReviewDossier(r,{f1:{value:'refer'}}).counts.unresolved,1);});
test('structural problems cannot be dismissed to claim corrected file',()=>{const r=base();r.summary.structuralFindingCount=1;r.findings=[{id:'f1',type:'structural'}];assert.equal(buildReviewDossier(r,{f1:{value:'reject'}}).gates.find(g=>g.id==='structure').status,'hold');});
test('unknown API edition remains visible blocker',()=>{const r=base();r.provenance.reference.edition='طبعة الكتاب غير معلنة في رد المصدر';assert.equal(buildReviewDossier(r).gates.find(g=>g.id==='source_identity').status,'hold');});
const resolvedWithAI=(analysis,findings=[])=>{const r=base();r.findings=findings;r.provenance.analysis=analysis;return r;};
test('failed context model with zero processed pairs is a visible hold, not ready',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:0,contextEligibleRows:4,contextError:'worker failed'}));assert.equal(out.status,'needs_work');const gate=out.gates.find(g=>g.id==='ai_execution');assert.equal(gate.status,'hold');assert.equal(gate.state,'failed');assert.match(gate.detail,/worker failed/);assert.equal(out.aiExecution.state,'failed');});
test('cancelled context run with partial results stays on hold',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:82,contextEligibleRows:393,contextCompleted:false,contextError:'cancelled',contextExecution:{cancelled:true}}));assert.equal(out.status,'needs_work');assert.equal(out.aiExecution.state,'cancelled');assert.match(out.gates.find(g=>g.id==='ai_execution').detail,/82 من 393/);});
test('partial run without an error is still incomplete',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:3,contextEligibleRows:5}));assert.equal(out.aiExecution.state,'partial');assert.equal(out.status,'needs_work');});
test('embedding failure recorded by the UI blocks the dossier',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'embedding-requested',modelError:'download failed'}));assert.equal(out.aiExecution.state,'failed');assert.equal(out.aiExecution.kind,'embedding');assert.equal(out.status,'needs_work');});
test('user cancellation before inference is persisted as cancelled',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'embedding-requested',aiCancelled:true}));assert.equal(out.aiExecution.state,'cancelled');assert.equal(out.status,'needs_work');});
test('requested model skipped after a source failure is not reported as complete',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',aiSkippedReason:'reference fetch failed'}));assert.equal(out.aiExecution.state,'not_run');assert.equal(out.status,'needs_work');});
test('no eligible pairs is disclosed without blocking',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:0,contextEligibleRows:0,contextError:null}));assert.equal(out.aiExecution.state,'no_pairs');assert.equal(out.gates.find(g=>g.id==='ai_execution').status,'limited');assert.equal(out.status,'ready_for_expert_review');});
test('complete run keeps abstentions visible in counts and gate text',()=>{const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:2,contextEligibleRows:2,contextCompleted:true},[{id:'c1',code:'context_uncertain',type:'evidence'}]));assert.equal(out.aiExecution.state,'complete');assert.equal(out.counts.modelAbstentions,1);assert.match(out.gates.find(g=>g.id==='ai_execution').detail,/امتنع النموذج في 1/);assert.equal(out.status,'ready_for_expert_review');assert.equal(out.publicationAuthorized,false);});
test('structural-only run reports that no model was requested',()=>{const out=buildReviewDossier(base());assert.equal(out.aiExecution.state,'not_requested');assert.equal(out.gates.find(g=>g.id==='ai_execution').status,'recorded');});

test('unknown attribution placeholders cannot satisfy dossier identity',()=>{
  for(const [field,value] of [['title','Unknown'],['author','unknown'],['publisher','غير معروف'],['edition','not supplied'],['licenseNote','unchecked']]){
    const r=base();r.provenance.reference[field]=value;
    assert.equal(buildReviewDossier(r).gates.find(g=>g.id==='source_identity').status,'hold',field);
  }
});
test('a recorded translator can supply identity when author is unknown',()=>{
  const r=base();r.provenance.reference.author='unknown';r.provenance.reference.translator='Named translator';
  assert.equal(buildReviewDossier(r).gates.find(g=>g.id==='source_identity').status,'recorded');
});
test('explicit incomplete context execution contradicts full counts and holds dossier',()=>{
  const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:1,contextEligibleRows:1,contextCompleted:false}));
  assert.equal(out.aiExecution.state,'inconsistent');assert.equal(out.status,'needs_work');
});
test('nested incomplete execution cannot be overruled by complete top-level flag',()=>{
  const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:1,contextEligibleRows:1,contextCompleted:true,contextExecution:{completed:false}}));
  assert.equal(out.aiExecution.state,'inconsistent');assert.equal(out.gates.find(g=>g.id==='ai_execution').status,'hold');
});
test('explicit incomplete flag with no eligible pairs remains no inference, not contradiction',()=>{
  const out=buildReviewDossier(resolvedWithAI({requestedMode:'context-requested',contextModel:{id:'m'},contextProcessedRows:0,contextEligibleRows:0,contextCompleted:false}));
  assert.equal(out.aiExecution.state,'no_pairs');assert.equal(out.status,'ready_for_expert_review');
});
test('revision changes need current evidence-bound reasons before expert handoff',()=>{
  const record={recordKey:'1:1',state:'text_change',evidenceFingerprint:'e',contextFingerprint:'c'};
  const revisionReview={records:[record],review:{decisions:[]}};
  assert.equal(buildReviewDossier(base(),{},{revisionReview}).status,'needs_work');
  revisionReview.review.decisions=[{...record,decision:'reviewed',reason:'Read change',status:'stale'}];
  assert.equal(buildReviewDossier(base(),{},{revisionReview}).status,'needs_work');
  revisionReview.review.decisions[0].status='active';
  assert.equal(buildReviewDossier(base(),{},{revisionReview}).gates.find(g=>g.id==='revision_followup').status,'recorded');
});
test('incomplete revision and duplicate evidence cannot close through a decision',()=>{
  assert.equal(buildReviewDossier(base(),{},{revisionReview:{status:'not_processed'}}).status,'needs_work');
  const r={recordKey:'1:1',state:'ambiguous_duplicate',evidenceFingerprint:'e',contextFingerprint:'c'};
  assert.equal(buildReviewDossier(base(),{},{revisionReview:{records:[r],review:{decisions:[{...r,decision:'reviewed',reason:'Seen',status:'active'}]}}}).status,'needs_work');
});
test('inconsistent manifest counters hold expert follow-up independently',()=>{
  assert.equal(buildReviewDossier(base(),{},{runManifest:{layers:{context:{state:'inconsistent'}}}}).gates.find(g=>g.id==='run_integrity').status,'hold');
});

test('embedding full counts without actual inference evidence hold the dossier',()=>{ for(const execution of [{},{actualInference:false},{actualInference:true,completed:false}]) { const out=buildReviewDossier(resolvedWithAI({requestedMode:'embedding-requested',model:{id:'m'},semanticProcessedRows:1,semanticEligibleRows:1,execution})); assert.equal(out.aiExecution.state,'inconsistent'); assert.equal(out.status,'needs_work'); } const out=buildReviewDossier(resolvedWithAI({requestedMode:'embedding-requested',model:{id:'m'},semanticProcessedRows:1,semanticEligibleRows:1,execution:{actualInference:true,completed:true}})); assert.equal(out.aiExecution.state,'complete'); });
