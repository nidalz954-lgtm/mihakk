import {evaluateBenchmark,cancelContextRisk} from './context-risk.mjs';
const $=id=>document.getElementById(id);
let result;
$('run-context').addEventListener('click',async()=>{
  $('run-context').disabled=true;$('stop').disabled=false;
  $('status').textContent='جارٍ تنزيل النموذج ثم تشغيل الجمل محليًا؛ لا نرسل النصوص إلى مزود النموذج.';
  try {
    result=await evaluateBenchmark(progress=>{
      $('status').textContent=progress?.status==='inference'?`تم تشغيل ${progress.done} من ${progress.total} حالة.`:`تحميل النموذج: ${progress.file??progress.status??''} ${Math.round(progress.progress??0)}%`;
    });
    $('results').textContent=JSON.stringify(result,null,2);
    $('status').textContent=result.trainedModelExecuted?`${result.completed?'اكتمل':'لم يكتمل'} تشغيل الأوزان على ${result.processedCases} من ${result.expectedCases} حالة. هذه نتائج تعليمية هندسية فقط.${result.error?' '+result.error:''}`:`لم يكتمل تشغيل الأوزان: ${result.error??'لا توجد نتائج'}`;
    $('export').disabled=false;
  }catch(error){$('status').textContent=`فشل الاختبار: ${error.message}. لا توجد نتيجة مُدّعاة.`;}
  finally{$('run-context').disabled=false;$('stop').disabled=true;}
});
$('stop').addEventListener('click',()=>cancelContextRisk());
$('export').addEventListener('click',()=>{
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  a.href=url;a.download='mihakk-actual-context-benchmark.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
});
