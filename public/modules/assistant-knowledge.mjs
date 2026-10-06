/**
 * Knowledge base for the on-page guide ("المرشد"). No language model: answers come only from
 * the fixed entries below, matched by normalized keywords. Nothing here leaves the browser.
 * The guide explains how to use Mihakk; it never judges a translation, issues a religious ruling or certifies.
 */

const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;

/** Fold the spelling variants people actually type so «إحالة», «احاله» and «الإحالة» meet. */
export function normalizeArabic(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب'];
function stem(word) {
  for (const prefix of PREFIXES) if (word.startsWith(prefix) && word.length - prefix.length >= 3) return word.slice(prefix.length);
  return word;
}
const tokens = text => normalizeArabic(text).split(' ').filter(Boolean).map(stem);

/**
 * Requests outside the guide's role. They are checked before any help entry so a question like
 * «هل الترجمة صحيحة؟» never gets a how-to answer that could read as approval.
 */
export const BOUNDARIES = [
  {
    id: 'boundary-ruling',
    keywords: ['فتوي', 'حكم شرعي', 'حلال', 'حرام', 'يجوز', 'تفسير الايه', 'فسر', 'معني الايه'],
    answer: 'لا أستطيع الإفتاء ولا تفسير الآيات. أنا مرشد لاستخدام أداة مِحَكّ فقط. اسأل عالماً أو جهة علمية متخصصة.',
  },
  {
    id: 'boundary-verdict',
    keywords: ['الترجمه صحيحه', 'ترجمتي صحيحه', 'صحيحه ولا', 'هل هي صحيحه', 'اعتمد الترجمه', 'اعتماد الترجمه', 'شهاده', 'معتمده', 'ممكن انشر', 'جاهزه للنشر', 'دقه 100', 'خاليه من الاخطاء'],
    answer: 'لا أحكم على صحة الترجمة ولا أعتمدها، ومِحَكّ نفسه لا يعطي شهادة. الأداة تجمع المواضع التي تحتاج قراءة، والقرار للمراجع ثم للجهة العلمية المسؤولة. غياب التنبيه لا يعني أن المعنى صحيح.',
  },
  {
    id: 'boundary-write',
    keywords: ['ترجم لي', 'ترجملي', 'اكتب ترجمه', 'صحح الترجمه', 'صحح لي', 'عدل الترجمه'],
    answer: 'لا أكتب ترجمات ولا أصححها. مِحَكّ يساعدك على إيجاد المواضع التي تحتاج مراجعة، والتصحيح يبقى للمترجم والمراجع.',
  },
];

/**
 * Help entries. `steps` limits an entry to the stages where it applies (empty = anywhere);
 * `action` names a page action the UI may offer as a button.
 */
export const ENTRIES = [
  {
    id: 'what-is',
    title: 'ما هو مِحَكّ؟',
    keywords: ['محك', 'شو بيعمل', 'ماذا يفعل', 'ما فايده', 'فكره الموقع', 'الموقع', 'الاداه', 'تعريف'],
    answer: 'مِحَكّ أداة تساعد على مراجعة ملف ترجمة لمعاني القرآن قبل عرضه على الخبراء. ترفع الملف، فيفحص الصفوف ويجمع المواضع التي تحتاج قراءة في قائمة واحدة، ثم تسجّل قرارك في كل موضع. الأداة لا تكتب ترجمة ولا تعتمدها.',
  },
  {
    id: 'start',
    title: 'من أين أبدأ؟',
    keywords: ['ابدا', 'بدايه', 'اول خطوه', 'كيف ابلش', 'بلش', 'من وين', 'شو اعمل', 'ماذا افعل', 'خطوات', 'كيف استخدم', 'طريقه الاستخدام', 'ساعدني'],
    answer: 'المسار أربع خطوات: ١) ارفع ملف الترجمة. ٢) حدّد النطاق والمرجع. ٣) راجع الحالات وسجّل قرارك. ٤) نزّل ملف المتابعة. إن أردت أن تفهم الأداة أولاً، شغّل المثال التعليمي.',
    action: 'demo',
  },
  {
    id: 'demo',
    title: 'تجربة المثال التعليمي',
    keywords: ['مثال', 'تجربه', 'جرب', 'ديمو', 'تعليمي', 'عينه'],
    answer: 'المثال التعليمي يشغّل المسار كاملاً على نصوص عامة مؤلفة للاختبار. هي ليست آيات ولا ترجمة قرآنية، وهدفها أن ترى كيف تظهر الحالات وكيف تسجّل القرار.',
    action: 'demo',
    steps: [1],
  },
  {
    id: 'file-format',
    title: 'كيف أجهّز ملفي؟',
    keywords: ['ملف', 'جهز', 'صيغه', 'اعمده', 'عمود', 'csv', 'excel', 'اكسل', 'xlsx', 'xml', 'نموذج', 'شكل الملف', 'رفع', 'ارفع'],
    answer: 'يحتاج الملف ثلاثة أعمدة: رقم السورة، رقم الآية، ثم نص الترجمة (surah, ayah, translation). الصيغ المقبولة: CSV أو Excel XLSX أو XML، وحتى 25 MB. تستطيع تنزيل نموذج CSV جاهز من الخطوة الأولى.',
    action: 'template',
  },
  {
    id: 'upload-fail',
    title: 'الملف لم يُقبل',
    keywords: ['ما انقبل', 'رفض', 'خطا في الملف', 'مش راضي', 'ما اشتغل الملف', 'مشكله الملف', 'لا يقبل', 'كبير'],
    answer: 'تأكد من ثلاثة أشياء: أن الصيغة CSV أو XLSX أو XML، وأن الحجم أقل من 25 MB، وأن أعمدة السورة والآية والترجمة موجودة. راجع المعاينة تحت منطقة الرفع، فهي تعرض أول الصفوف كما قُرئت. إن ظهرت الأعمدة بأسماء مختلفة، اربطها يدوياً.',
  },
  {
    id: 'privacy',
    title: 'أين يذهب ملفي؟',
    keywords: ['خصوصيه', 'امان', 'يرسل', 'سيرفر', 'خادم', 'وين بروح', 'بيانات', 'سري', 'محلي', 'ينحفظ'],
    answer: 'ملف الترجمة يُقرأ داخل متصفحك ولا يُرسل إلى خادم الفحص. إذا اخترت المرجع المباشر من Quranpedia، يُرسل رقم الكتاب والسورة فقط. القرارات والملاحظات تُحفظ محلياً على جهازك، ونصوص الترجمة لا تُحفظ في التخزين الدائم.',
  },
  {
    id: 'scope',
    title: 'ما معنى النطاق؟',
    keywords: ['نطاق', 'جزئي', 'كامل', 'سور محدده', 'القران كاملا', 'ناقص', '6236', 'تغطيه'],
    answer: 'النطاق هو ما تقول إن الملف يحتويه. «صفوف محددة» يفحص الموجود فقط ولا يفترض اكتمال شيء. «القرآن كاملاً» يكشف الآيات الناقصة من أصل 6236 آية. «سور محددة» يكشف النقص داخل السور التي تكتب أرقامها.',
    steps: [2],
  },
  {
    id: 'reference',
    title: 'ما هو المرجع المقابل؟',
    keywords: ['مرجع', 'مقارنه', 'quranpedia', 'قرانبيديا', 'نص مقابل', 'مصدر', 'ملف مرجعي'],
    answer: 'المرجع نص تقارن به ترجمتك. لك ثلاثة خيارات: بلا مرجع (فحص بنيوي فقط)، أو قراءة مباشرة من Quranpedia، أو ملف مرجعي ترفعه بنفسك. وصول النص من مصدره لا يعني أن ترجمتك صحيحة؛ المرجع يساعدك على المقارنة فقط.',
    steps: [2],
  },
  {
    id: 'ai',
    title: 'ما هي المؤشرات النموذجية؟',
    keywords: ['ذكاء', 'نموذج', 'ai', 'تجريبي', 'تعارض سياقي', 'تشابه', 'تحميل النموذج', 'سياق'],
    answer: 'خيار إضافي يشغّل نموذجاً لغوياً داخل المتصفح بعد تنزيله أول مرة (نحو 172 MB). يعطي إشارة ترتيب تجريبية، وليست حكماً على المعنى. نسخته الأساسية للإنجليزية، والمتعددة اللغات تحتاج أن يكون النصان بنفس اللغة. قد يمتنع عن الترجيح، وهذا يظهر لك بوضوح.',
    steps: [2],
  },
  {
    id: 'slow',
    title: 'الفحص بطيء أو أريد إيقافه',
    keywords: ['بطيء', 'بطيئ', 'علق', 'واقف', 'ايقاف', 'الغاء', 'وقف', 'طول', 'تحميل'],
    answer: 'أطول جزء عادة هو جلب المرجع أو تنزيل النموذج أول مرة. تستطيع الضغط على «إيقاف القراءة أو الجلب أو النموذج» تحت شريط التقدم. إن أوقفت التحليل، تبقى النتيجة جزئية ويظهر ذلك في التقرير.',
  },
  {
    id: 'findings',
    title: 'كيف أقرأ الحالات؟',
    keywords: ['حاله', 'حالات', 'تنبيه', 'قائمه المراجعه', 'نتايج', 'نتيجه', 'افهم', 'اولويه', 'عاليه', 'متوسطه'],
    answer: 'كل حالة موضع يحتاج قراءتك: رقم السورة والآية، نوع الملاحظة، والأولوية. الأعلى أولوية يظهر أولاً. افتح الحالة لترى النصين والدليل، ثم اختر المتابعة. تستطيع البحث برقم السورة والآية أو التصفية حسب النوع والأولوية.',
    steps: [3],
  },
  {
    id: 'decisions',
    title: 'ماذا أختار في القرار؟',
    keywords: ['قرار', 'تحتاج تصحيح', 'اغلاق', 'احاله', 'متخصص', 'سبب', 'احفظ القرار', 'شو اختار'],
    answer: 'ثلاثة خيارات: «تحتاج تصحيحاً» إذا رأيت خطأ يجب إصلاحه. «إغلاق التنبيه مع سبب» إذا قرأت الموضع ولم تجد مشكلة، واكتب السبب. «إحالة لمتخصص» إذا احتاج الموضع رأي عالم أو خبير. الإغلاق لا يعني اعتماد الترجمة.',
    steps: [3],
  },
  {
    id: 'no-findings',
    title: 'لم تظهر حالات',
    keywords: ['ما في حالات', 'لا توجد حالات', 'فاضي', 'صفر', 'ولا حاله', 'نظيف'],
    answer: 'غياب الحالات يعني أن الفحوص المتاحة لم تجد ما تنبّه عليه، ولا يعني أن المعنى صحيح. راجع حدود الفحص في ملف المتابعة، وتأكد أن المرشحات في أعلى القائمة ليست ضيقة.',
    steps: [3],
  },
  {
    id: 'types',
    title: 'أنواع الملاحظات',
    keywords: ['نوع', 'انواع', 'بنيوي', 'تكرار', 'نفي', 'عدد', 'شوايب', 'ناقصه', 'ترتيب', 'دمج'],
    answer: 'أهم الأنواع: آيات ناقصة، تكرار رقم آية، رقم غير صالح، صف خارج الترتيب، نص فارغ، شوائب تقنية مثل الوسوم والمحارف الخفية، ومع المرجع: اختلاف في النفي أو الأرقام أو كلمات التعميم والإلزام. كلها إشارات للقراءة وليست أحكاماً.',
  },
  {
    id: 'dossier',
    title: 'ما هو ملف المتابعة؟',
    keywords: ['ملف المتابعه', 'تقرير', 'دوسيه', 'الخطوه 4', 'الخطوه الرابعه', 'عوايق', 'جهه علميه'],
    answer: 'ملف المتابعة يلخّص ما فُحص، وقراراتك، والحالات التي بقيت مفتوحة قبل الإحالة للجهة العلمية. هو سجل متابعة، وليس شهادة اعتماد ولا إذن نشر.',
    steps: [3, 4],
  },
  {
    id: 'export',
    title: 'كيف أحفظ التقرير؟',
    keywords: ['احفظ التقرير', 'حفظ التقرير', 'نزل التقرير', 'تنزيل التقرير', 'تنزيل', 'نزل', 'حفظ', 'احفظ', 'json', 'pdf', 'طباعه', 'اطبع', 'تصدير', 'جدول'],
    answer: 'في الخطوة الرابعة: «تنزيل التقرير الكامل JSON» يحفظ الصفوف والقرارات والتتبع. «جدول المتابعة CSV» يعرض الحالات في جدول. «طباعة / PDF» للنسخة الورقية. نزّل تقريرك قبل إغلاق الصفحة.',
    steps: [4],
  },
  {
    id: 'team',
    title: 'العمل مع فريق',
    keywords: ['فريق', 'مراجعين', 'توزيع', 'مشرف', 'زميل', 'اكثر من مراجع'],
    answer: 'في قائمة المراجعة يوجد قسم للعمل مع فريق: يوزّع المدير الحالات على المراجعين بملفات مهام، ثم يستورد قراراتهم ويعتمد ما يراه. كل ذلك بملفات تتبادلونها، دون حسابات أو خادم.',
    steps: [3],
  },
  {
    id: 'revision',
    title: 'مراجعة نسخة مصححة',
    keywords: ['نسخه مصححه', 'نسخه جديده', 'النسخه السابقه', 'مقارنه النسخ', 'تعديل', 'نسختين'],
    answer: 'إذا صحّحت الملف بعد مراجعة سابقة، استعمل «متابعة نسخة مصححة من العمل نفسه» في الخطوة الأولى. اختر النسخة السابقة كأساس، وارفع النسخة المصححة في حقل الملف، فتظهر لك المواضع التي تغيرت.',
    steps: [1],
  },
  {
    id: 'new-audit',
    title: 'بدء فحص جديد',
    keywords: ['فحص جديد', 'من جديد', 'اعاده', 'ملف تاني', 'ملف اخر', 'ابدا من الاول'],
    answer: 'اضغط «فحص جديد» في أعلى الصفحة لتبدأ بملف آخر. نزّل تقرير الفحص الحالي أولاً إن احتجت إليه.',
  },
  {
    id: 'voice',
    title: 'كيف أتكلم مع المرشد؟',
    keywords: ['صوت', 'مايك', 'ميكروفون', 'احكي', 'اتكلم', 'فويس', 'اسمع', 'يقرا'],
    answer: 'اضغط زر الميكروفون وتكلّم بسؤالك. لسماع الجواب بصوت، فعّل زر السماعة. للسماع طريقتان: خدمة الكلام في متصفحك، وهي أسرع لكنها قد ترسل الصوت إلى خدمة المتصفح، أو «اسمع على جهازي فقط»، وهي تنزّل نموذجاً صغيراً مرة واحدة وتبقي صوتك على جهازك. الكتابة تبقى داخل جهازك دائماً.',
  },
  {
    id: 'who',
    title: 'من أنت؟',
    keywords: ['مين انت', 'من انت', 'شو انت', 'انسان', 'روبوت', 'بوت'],
    answer: 'أنا مرشد مِحَكّ. أجيب من دليل مكتوب مسبقاً عن طريقة استخدام الأداة، ولست نموذج ذكاء اصطناعي يفهم كل سؤال. إن لم أجد جواباً، أخبرك بذلك.',
  },
  {
    id: 'greeting',
    title: 'تحية',
    keywords: ['مرحبا', 'السلام عليكم', 'سلام', 'اهلا', 'صباح الخير', 'مساء الخير', 'كيفك'],
    answer: 'أهلاً بك. أنا مرشد مِحَكّ، أساعدك في خطوات الأداة. اسألني مثلاً: كيف أجهّز ملفي؟ أو ماذا أختار في القرار؟',
  },
  {
    id: 'thanks',
    title: 'شكر',
    keywords: ['شكرا', 'يعطيك العافيه', 'مشكور', 'تسلم', 'ممتاز'],
    answer: 'العفو. اسألني متى احتجت.',
  },
];

export const FALLBACK = 'لم أجد جواباً لهذا السؤال في دليلي. أنا أجيب عن طريقة استخدام مِحَكّ فقط. جرّب إحدى الأسئلة المقترحة، أو أعد صياغة سؤالك بكلمات أبسط.';

/** Suggested questions per stage, so a newcomer never faces an empty box. */
export const SUGGESTIONS = {
  1: ['من أين أبدأ؟', 'كيف أجهّز ملفي؟', 'أين يذهب ملفي؟'],
  2: ['ما معنى النطاق؟', 'ما هو المرجع المقابل؟', 'ما هي المؤشرات النموذجية؟'],
  3: ['كيف أقرأ الحالات؟', 'ماذا أختار في القرار؟', 'العمل مع فريق'],
  4: ['ما هو ملف المتابعة؟', 'كيف أحفظ التقرير؟', 'بدء فحص جديد'],
};

function phraseScore(phrase, normalized, words) {
  const key = normalizeArabic(phrase);
  if (!key) return 0;
  if (key.includes(' ')) return normalized.includes(key) ? 3 : 0;
  const keyStem = stem(key);
  // Short endings (ملفي، ملفه، جهزوا) still count; speech transcripts often add or bend them.
  return words.some(word => word === keyStem || (word.startsWith(keyStem) && (keyStem.length >= 4 || word.length - keyStem.length <= 2))) ? 1 : 0;
}

function scoreEntry(entry, normalized, words) {
  let score = 0;
  for (const phrase of entry.keywords) score += phraseScore(phrase, normalized, words);
  if (entry.title && normalizeArabic(entry.title) === normalized) score += 5;
  return score;
}

/**
 * Pick the answer for a question. `step` (1–4) breaks ties toward the current stage.
 * Returns {id, answer, action?, matched:boolean}.
 */
export function answerQuestion(question, {step = 1} = {}) {
  const normalized = normalizeArabic(question);
  if (!normalized) return {id: 'empty', answer: 'اكتب سؤالك أو اختر سؤالاً مقترحاً.', matched: false};
  const words = tokens(question);
  for (const boundary of BOUNDARIES) {
    if (boundary.keywords.some(phrase => phraseScore(phrase, normalized, words) > 0)) return {id: boundary.id, answer: boundary.answer, matched: true};
  }
  let best = null, bestScore = 0;
  for (const entry of ENTRIES) {
    let score = scoreEntry(entry, normalized, words);
    if (score > 0 && entry.steps?.includes(step)) score += 0.5;
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  if (!best) return {id: 'fallback', answer: FALLBACK, matched: false};
  return {id: best.id, answer: best.answer, action: best.action, matched: true};
}

/** Gulf locales, nearest to the Saudi audience after Saudi itself. */
const GULF = ['ar-ae', 'ar-kw', 'ar-qa', 'ar-bh', 'ar-om'];

/**
 * The audience is a Saudi committee: prefer a Saudi voice, then a Gulf one, then any Arabic voice.
 * Device-installed voices win over online ones at each level, so speech works offline.
 */
export function pickSaudiVoice(voices = []) {
  const lang = voice => String(voice.lang || '').toLowerCase().replace('_', '-');
  const rank = voice => {
    const code = lang(voice);
    const level = code === 'ar-sa' ? 0 : GULF.includes(code) ? 1 : code.startsWith('ar') ? 2 : -1;
    return level < 0 ? -1 : level * 2 + (voice.localService ? 0 : 1);
  };
  let best = null, bestRank = Infinity;
  for (const voice of voices) {
    const value = rank(voice);
    if (value >= 0 && value < bestRank) { best = voice; bestRank = value; }
  }
  return best;
}
