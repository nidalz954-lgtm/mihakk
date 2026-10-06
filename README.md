# مِحَكّ — فرز مخاطر ملفات ترجمة معاني القرآن قبل مراجعة المختص

الإصدار: **0.4.2** · الترخيص: [MIT](LICENSE) للشفرة فقط · الحقوق والمصادر: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [SOURCE_AND_RIGHTS.md](SOURCE_AND_RIGHTS.md) · [BASELINE.md](BASELINE.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

مِحَكّ أداة فرز تساعد المراجع المختص. تفحص ملف الترجمة كاملًا وتُظهر الحالات التي تحتاج نظرًا، مع نصّها ودليلها ومصدرها. **لا تترجم، ولا تُفتي، ولا تُصدر شهادة، والقرار للمختص.** غياب الإشارة لا يعني أن المعنى صحيح. ملف المتابعة وتقرير JSON يصرّحان بأنهما ليسا شهادة ولا إذن نشر.

طُوِّر بمساعدة أدوات برمجة بالذكاء الاصطناعي (Claude Code وOpenAI Codex) بتوجيه المؤسس. ما قبل 4 أكتوبر 2026 موثّق كنقطة بداية في [BASELINE.md](BASELINE.md) (ويذكر نموذج التشابه)، وتشغيل مؤشر التعارض NLI قبل التحدي مسجّل في سجل 3 أكتوبر خارج هذا المستودع. المراجعات التي أُجريت على المشروع أجراها وكلاء ذكاء اصطناعي، وليست لجانًا بشرية ولا مستقلة، ولم يراجع المنتج أي مختص شرعي أو لغوي بشري بعد.

## جرّبه

- النسخة الحية (GitHub Pages): https://nidalz954-lgtm.github.io/mihakk/ (منشورة وتعمل؛ آخر فحص آلي من الخارج 6 أكتوبر 2026)
- الوثائق: [دليل الاستخدام](docs/USER_GUIDE_AR.md) · [الحدود المعروفة](docs/KNOWN_ISSUES.md) · [الإفصاح عن الذكاء الاصطناعي](docs/AI_DISCLOSURE_AR.md) · [المصادر والحقوق](SOURCE_AND_RIGHTS.md)
- أو محليًا (Node.js 20.12 أو أحدث، بلا `npm install` وبلا مفاتيح):

```sh
node launch.mjs
```

يفتح المشغّل عنوانًا محليًا يبدأ من المنفذ 3200. للتطوير:

```sh
npm test          # الاختبارات الحالية (بلا corpus خاص)
npm run build     # يبني الموقع الثابت في dist/ مع بصمات وفحص أسرار
npm start         # خادم محلي على http://127.0.0.1:3000
```

## ماذا يفحص

- **بدون ذكاء اصطناعي:** أرقام الآيات الناقصة ضمن النطاق المحدد، والأرقام المكررة أو الخارجة عن العدّ الكوفي (6,236 آية)، والخانات الفارغة، والصفوف التي رجع ترتيبها، وشوائب النص. هذا فحص لبنية الملف، وليس لصحة المعنى.
- **مقارنة بمرجع:** بلا مرجع، أو قراءة مباشرة من Quranpedia، أو ملف مرجعي يرفعه المستخدم. وصول النص من مصدره لا يعني اعتماد صحة الترجمة.
- **مقارنة النسخ:** نسخة جديدة مقابل نسختها السابقة من العمل نفسه. هذا أفضل استخدام للأداة.
- **الذكاء الاصطناعي اختياري وتجريبي:** نتيجته إشارة للمراجعة، لا نسبة دقة ولا حكم، وغير مدرَّب على ترجمات القرآن. النماذج المذكورة في الكود: `Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7`، `Xenova/multilingual-e5-small`، `Xenova/nli-deberta-v3-small`.
- الحالات مرتبة حسب أولوية قواعد الفحص. الترتيب لا يقيس خطورة المعنى، والحكم للمراجع.
- **النص القرآني للعرض فقط:** يُعرض بجانب كل حالة ليقرأه المراجع، ولا يقارن البرنامج الترجمة به آليًا. المصدر: [Quranpedia](https://quranpedia.net) (مصحف حفص)، نسخة البيانات 2026-10-06، والملف `public/data/quran-hafs-quranpedia.json` مثبّت ببصمة SHA-256 `c414b5e5d4ae38bb99cf9c66ea44cb2b1a7aaa7053c2a5c4fa155cab17d15de8`. شروط Quranpedia: Quranpedia.net data license, version 2026-10-06: free to use inside apps; republishing as a dataset requires crediting Quranpedia.net with a link and stating the dump version. https://api.quranpedia.net/dumps/LICENSE.md

## الخصوصية والاتصالات الخارجية

ملف ترجمتك لا يُرفع إلى أي خادم، وقراءته وفحصه يجريان داخل متصفحك. يتصل البرنامج بالإنترنت فقط في هذه الحالات:

| متى | العنوان | ماذا يُرسل أو يُنزَّل |
|---|---|---|
| اختيار المرجع المباشر | `api.quranpedia.net` | رقم الكتاب والسورة فقط |
| تشغيل النموذج التجريبي | `huggingface.co` | تنزيل أوزان النموذج أول مرة |
| تشغيل النموذج التجريبي | `cdn.jsdelivr.net` | تنزيل ملفات تشغيل ONNX Runtime (WASM) من jsDelivr، بلا فحص سلامة (SRI) |
| الصوت في «المرشد» (اختياري) | خدمة الكلام في المتصفح، أو `huggingface.co` للنموذج المحلي | خيار «موافق» قد يرسل الصوت إلى خدمة المتصفح (Google أو Microsoft)؛ خيار «اسمع على جهازي فقط» ينزّل نموذجًا صغيرًا نحو 77 ميغابايت ويبقي الصوت على الجهاز |

لذلك لا يعمل وضع الذكاء الاصطناعي بلا إنترنت في أول تشغيل. الصفحة تحمل سياسة أمان (CSP) داخلها مطابقة لترويسة الخادم المحلي (`src/static-app.mjs`)، فتسري أيضًا على GitHub Pages.

## إعادة تشغيل الأدلة

```sh
npm test                                  # كل الاختبارات الحالية
node --test test/fixtures.test.mjs        # اختبارات الملفات الاصطناعية (بعضها يتخطى نفسه إن غابت الملفات المولّدة)
node scripts/benchmark-injected.mjs       # قياس أخطاء مزروعة في نصوص اصطناعية غير دينية (يطبع JSON)
```

البيانات التعليمية في الاختبارات نصوص اصطناعية غير دينية، وليست آيات ولا ترجمات قرآنية.

## ما ليس في هذا المستودع

- الـcorpus الخاص وكود نسخة 0.1 القديمة (لم تُحسم حقوق نشره).
- ملفات الاختبار الداخلية على نصوص حقيقية، والفيديو والعرض والحزم.
- أي مفاتيح أو أسرار.

## English summary

Mihakk is a browser-local triage tool for Quran-meaning translation files before expert review. It does not translate, issue rulings, or certify. Structural checks run without AI; the optional AI signals are experimental and are not accuracy scores. Translation files never leave the browser. Developed with AI coding tools (Claude Code and OpenAI Codex) under the founder's direction. Reviews mentioned in this project were run by AI agents, not independent or human panels. Code: MIT. Third-party material: see THIRD_PARTY_NOTICES.md.
