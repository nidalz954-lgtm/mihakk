# إشعارات المواد والأطراف الثالثة

آخر مراجعة: 6 أكتوبر 2026

## الإصدار العام 0.4.2

**نص المصحف المعروض (للاطلاع فقط):** الموسوعة القرآنية quranpedia.net، ملف البيانات المفتوحة `mushafs-1.json.gz` «مصحف حفص — موافق لطبعة مجمع الملك فهد لطباعة المصحف الشريف»، نسخة 2026-10-06، بصمة الملف المضغوط `18ecddb19fbab73f38b9f869cf4ca1f33796edcfdf055fa53985992c12c02c4d` مطابقة لقائمة الملفات الرسمية. نسخة العرض `public/data/quran-hafs-quranpedia.json` (بصمة `c414b5e5d4ae38bb99cf9c66ea44cb2b1a7aaa7053c2a5c4fa155cab17d15de8`) تحذف فقط محارف U+FEFF غير المرئية، ولا تغيّر الحروف ولا الضبط. الرخصة: استعمال مجاني داخل التطبيقات، وإعادة نشر البيانات كقاعدة بيانات قابلة للتنزيل تتطلب ذكر quranpedia.net مع رابط ونسخة الملف. [الرخصة](https://api.quranpedia.net/dumps/LICENSE.md). تحقق مستقل: 6,233 من 6,236 آية متطابقة الحروف مع نص Tanzil (CC BY 3.0) بعد فصل البسملة، والثلاث الباقية فروق رسم للألف فقط؛ السجل في `07-verification/quran-text-2026-10-06/`.

**نموذج التعارض السياقي متعدد اللغات (اختياري، تجريبي):** `Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7` بالمراجعة `0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0`، ملف الأوزان `onnx/model_quantized.onnx` (بصمة `ccb655bf617edf1d3b0ccdc5b4576a4322e28cee5ce9ab8cd21af4b1f13e6836`، نحو 339 MB) يُنزّل من Hugging Face عند أول تشغيل فقط. المصدر الأصلي MoritzLaurer بترخيص MIT؛ مستودع ONNX لا يعلن ترخيصًا منفصلًا؛ بيانات التدريب تشمل facebook/anli بترخيص CC BY-NC 4.0، فيلزم مراجعة الشروط قبل أي استخدام تجاري. يقارن نصين بنفس اللغة المعلنة فقط، ولم يُختبر على ترجمات القرآن.

## الإصدار العام 0.4.1

هذا القسم يصف الإصدار الحالي. الأقسام التالية تصف نسخة 0.1 الخاصة التاريخية، ولا تحجب تشغيل النسخة العامة الجديدة.

**مكتبات مضمّنة في المشروع:**
- **SheetJS Community 0.20.3:** قراءة XLSX محليًا، Apache-2.0. الملف `public/vendor/xlsx-0.20.3.mjs`، والرخصة `SHEETJS-LICENSE.txt`. [المصدر](https://docs.sheetjs.com/docs/getting-started/installation/standalone/).
- **Transformers.js 3.8.1:** Apache-2.0. الملف `public/vendor/transformers-3.8.1.mjs`، والرخصة `TRANSFORMERS-LICENSE.txt`. [المشروع](https://github.com/huggingface/transformers.js).
  - **مكوّنات مدمجة داخل الملف نفسه:**
    - onnxruntime-web: MIT، [الرخصة](https://github.com/microsoft/onnxruntime/blob/main/LICENSE).
    - @huggingface/jinja: MIT، [المشروع](https://github.com/huggingface/huggingface.js).

**إغلاق نقص إشعارات الحقوق في 5 أكتوبر 2026:** أُضيفت نصوص الإشعارات الأصلية كاملة دون تعديل؛ لم تُغيّر مكتبة التشغيل. طابقت بصمة `public/vendor/transformers-3.8.1.mjs` ملف التوزيع الأصلي [transformers.min.js 3.8.1](https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js): `aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa`. إصدارات التبعيات أدناه من [package-lock.json في وسم 3.8.1](https://raw.githubusercontent.com/huggingface/transformers.js/3.8.1/package-lock.json). حُسبت البصمات على بايتات الملفات المرفقة.

| المكوّن والإصدار المطابق للتوزيع | ملف الإشعار المحلي | المصدر الأصلي ودليل البايتات |
|---|---|---|
| @huggingface/jinja 0.5.3، MIT | `public/vendor/HUGGINGFACE-JINJA-LICENSE.txt` | `package/LICENSE` مستخرج من [حزمة npm الأصلية 0.5.3](https://registry.npmjs.org/@huggingface/jinja/-/jinja-0.5.3.tgz)، بعد مطابقة SHA-512 مع integrity في سجل upstream؛ يتضمن حقوق Hugging Face 2023 ونص الإذن كاملًا. SHA-256 `d6e7b19451c1b3d1d66353bb4b1274138953b3bfd9ae60c56e77b1f548796982`. |
| onnxruntime-web 1.22.0-dev.20250409-89f8206ba4، MIT | `public/vendor/ONNXRUNTIME-LICENSE.txt` | [LICENSE عند commit 89f8206ba4](https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/LICENSE)، SHA-256 `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c`. |
| إشعارات ONNX Runtime في commit نفسه | `public/vendor/ONNXRUNTIME-THIRD-PARTY-NOTICES.txt` | [ThirdPartyNotices.txt عند commit 89f8206ba4](https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/ThirdPartyNotices.txt)، SHA-256 `e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc`. هذا سجل upstream كامل يشمل تكوينات أخرى أيضًا؛ وجود إشعار لا يعني أن كل مكوّن فيه مضمّن في نسخة المتصفح. |

حُفظت حزم المصدر وبصماتها ومطابقة التوزيع في سجل الفحص المحلي `07-verification/judging-2026-10-05/final-sources-jury/` خارج حزمة الموقع. لا تُنشر حزم npm الكاملة أو ملفات فحص المصدر مع المنتج؛ ملفات الإشعارات المذكورة جزء من التوزيع، ويجب أن تبقى في البناء والحزمة النهائية.

**تُجلب وقت التشغيل ولا تُضمّن:**
- **ONNX Runtime WASM:** من الإصدار المثبت على jsDelivr، MIT.
- **أوزان النماذج:** تُجلب عند الطلب من revision موثق، ولا تُضمّن في المستودع.
  - `Xenova/multilingual-e5-small`: نسخة ONNX من `intfloat/multilingual-e5-small`، **MIT**. [البطاقة](https://huggingface.co/intfloat/multilingual-e5-small).
  - `Xenova/nli-deberta-v3-small`: نسخة ONNX من `cross-encoder/nli-deberta-v3-small`، **Apache-2.0**. revision `6bc2a55c7c0f7e2bc68de60bb248e523e2612abb`. [البطاقة](https://huggingface.co/cross-encoder/nli-deberta-v3-small).
  - `onnx-community/whisper-base` (اختياري، للسماع على الجهاز في مرشد الموقع): نسخة ONNX من `openai/whisper-base`، **Apache-2.0** حسب بطاقة OpenAI. revision `1846881b6b3a3024392c1eea3ad983695bc23925`، أوزان q8 نحو 77 MB تُنزّل عند أول استخدام فقط. مستودع ONNX لا يعلن ترخيصاً منفصلاً. [البطاقة](https://huggingface.co/openai/whisper-base).

**الخط:**
- **Readex Pro:** SIL Open Font License 1.1. الرخصة `public/assets/fonts/OFL-Readex-Pro.txt`.

- فهرس أعداد الآيات بيانات عددية فقط دون نصوص أو ترجمة، موثّق وفق [Tanzil metadata](https://tanzil.net/docs/Quran_Metadata) وترقيم العد الكوفي؛ لا ننسب ملكية نص القرآن إلى المشروع.
- Quranpedia استخدام حي وفق [السياسة](https://api.quranpedia.net/) و[شروط البيانات](https://api.quranpedia.net/dumps/LICENSE.md): المرجع في ذاكرة الجلسة، لا corpus ثابت داخل المستودع. حقوق الترجمات المعاصرة لأصحابها. حفظ التقرير لا يمنح إذن إعادة نشر مجموعة ترجمات؛ ارجع إلى شروط المصدر قبل مشاركة أي نص مرجعي.
- الشعار الأصلي الذي قدّمه صاحب المشروع محفوظ دون إعادة رسم؛ غير مشمول برخصة MIT العامة للشفرة.

لا تنشر الملفات الخاصة أو corpus القديم أو دليل الجهة المنظمة أو بيانات المستفيدين. النسخة العامة تبدأ وتختبر دونها.

هذه الوثيقة سجل مصادر وليست ترخيصاً أو رأياً قانونياً. وجود رابط أو مقتطف في نسخة التقييم لا يمنح تلقائياً حق النسخ أو إعادة التوزيع.

## تبعيات الشفرة

لا تحتوي النسخة `0.1.0` على حزم npm خارجية في وقت التشغيل أو الاختبار؛ وهي تستخدم وحدات Node.js القياسية فقط. يبقى Node.js خاضعاً لتراخيص مشروعه ومكوناته.

## المحتوى المرجعي في نسخة التقييم الخاصة

| المادة | المرجع الرسمي/العام | الاستخدام الداخلي الحالي | حالة إعادة النشر |
|---|---|---|---|
| نص عربي بالرسم العثماني | [مجمع الملك فهد لطباعة المصحف الشريف](https://qurancomplex.gov.sa/) | مقتطفات محلية لثماني آيات | **غير محسومة**؛ يلزم التحقق من شروط الناشر والإذن المناسب قبل النشر. |
| ترجمة Saheeh International الإنجليزية | [Quranpedia](https://quranpedia.net/) | مقتطفات ترجمة محلية للفرز | **غير محسومة**؛ ظهور النص عبر بوابة مرجعية لا يثبت حق إعادة التوزيع. يجب التحقق من صاحب الترجمة وشروطه. |
| ملاحظات مصطلحية | [موسوعة المحتوى الإسلامي — القاموس](https://islamic-content.com/dictionary) | ملاحظات محلية مشتقة لاختبار قواعد محددة | **غير محسومة**؛ يلزم التحقق من شروط الاستخدام ونطاق الاقتباس. |
| مرجعية وحزمة علمية للتحدي | ملف PDF قدمته الجهة المنظمة للمشاركين | ضبط حدود الامتناع والإحالة محلياً | مادة خاصة بالتحدي؛ لا تُدرج في مستودع عام من دون إذن صريح. |

الروابط المسجلة في corpus الحالي عامة وليست روابط سجلات دقيقة. قبل أي إصدار عام يجب توثيق رابط كل سجل، الإصدار/تاريخ الوصول، صاحب الحق، نص الإذن أو الترخيص، نطاق الاستخدام، ومتطلبات النسبة.

## مواد المشروع المستبعدة من MIT

- `data/*.json` ومحتواها النصي أو المرجعي.
- أي ملف PDF أو PPTX أو DOCX مصدر أو مقدم من الجهة المنظمة أو الناشرين.
- `public/assets/mihakk-logo-*.png`، اسم مِحَكّ، والشعارات والهوية البصرية.
- أي مقتطف أو وصف أو علامة لطرف ثالث، حتى لو ظهر في لقطة شاشة أو فيديو.

لا يغطي [LICENSE](LICENSE) هذه المواد. الحقوق محفوظة لأصحابها، ولا يُقصد من إدراجها الداخلي الادعاء بالملكية.

## قرار الإصدار الحالي

خط الواجهة المحلي `public/assets/fonts/ReadexPro.ttf` نسخة أصلية غير معدلة من Readex Pro من مستودع Google Fonts، تحت SIL Open Font License 1.1. نص الترخيص الكامل بجواره `OFL-Readex-Pro.txt`. مصدر الملف: [Google Fonts Readex Pro](https://github.com/google/fonts/tree/main/ofl/readexpro). جُلب 4 أكتوبر 2026؛ SHA256 `268bba7e1e8f3b14d798b3fb0e40ebaa3fc39308c9ac0020e2faf6df181cc30e`. لا اتصال بخدمة الخطوط وقت تشغيل التطبيق، ولا يدخل الخط أو الهوية ضمن ترخيص MIT للشفرة.

لا يجوز نشر corpus الحالي ضمن مستودع عام. المسار المقبول هو نشر الشفرة منفصلة بعد أن تعمل اختبارات الإصدار على fixtures اصطناعية غير دينية، وإتاحة corpus الحقيقي فقط عبر قناة مرخصة ومنفصلة عند توافر الإذن.
