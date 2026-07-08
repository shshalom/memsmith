<section dir="rtl">
<h1 align="center">
  <br>
  <a href="https://github.com/shshalom/memsmith">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/memsmith-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/memsmith-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/memsmith-logo-for-light-mode.webp" alt="MemSmith" width="400">
    </picture>
  </a>
  <br>
</h1>

<p align="center">
  <a href="README.zh.md">🇨🇳 中文</a> •
  <a href="README.zh-tw.md">🇹🇼 繁體中文</a> •
  <a href="README.ja.md">🇯🇵 日本語</a> •
  <a href="README.pt-br.md">🇧🇷 Português</a> •
  <a href="README.ko.md">🇰🇷 한국어</a> •
  <a href="README.es.md">🇪🇸 Español</a> •
  <a href="README.de.md">🇩🇪 Deutsch</a> •
  <a href="README.fr.md">🇫🇷 Français</a>
  <a href="README.he.md">🇮🇱 עברית</a> •
  <a href="README.ar.md">🇸🇦 العربية</a> •
  <a href="README.ru.md">🇷🇺 Русский</a> •
  <a href="README.pl.md">🇵🇱 Polski</a> •
  <a href="README.cs.md">🇨🇿 Čeština</a> •
  <a href="README.nl.md">🇳🇱 Nederlands</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.uk.md">🇺🇦 Українська</a> •
  <a href="README.vi.md">🇻🇳 Tiếng Việt</a> •
  <a href="README.id.md">🇮🇩 Indonesia</a> •
  <a href="README.th.md">🇹🇭 ไทย</a> •
  <a href="README.hi.md">🇮🇳 हिन्दी</a> •
  <a href="README.bn.md">🇧🇩 বাংলা</a> •
  <a href="README.ur.md">🇵🇰 اردو</a> •
  <a href="README.ro.md">🇷🇴 Română</a> •
  <a href="README.sv.md">🇸🇪 Svenska</a> •
  <a href="README.it.md">🇮🇹 Italiano</a> •
  <a href="README.el.md">🇬🇷 Ελληνικά</a> •
  <a href="README.hu.md">🇭🇺 Magyar</a> •
  <a href="README.fi.md">🇫🇮 Suomi</a> •
  <a href="README.da.md">🇩🇰 Dansk</a> •
  <a href="README.no.md">🇳🇴 Norsk</a>
</p>

<h4 align="center">أداة إضافية لـ <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> تعمل على أتمتة تسجيل معلومات الجلسات السابقه، وضغطها, ثم حقن السياق ذي الصلة في الجلسات المستقبلية.
</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-13.4.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/shshalom/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/trendshift-badge.svg" alt="shshalom/memsmith | Trendshift" width="250" height="55"/>
    </picture>
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/shshalom/memsmith">
    <picture>
      <img src="https://raw.githubusercontent.com/shshalom/memsmith/main/docs/public/cm-preview.gif" alt="MemSmith Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#بداية-سريعة">بداية سريعة</a> •
  <a href="#كيف-يعمل">كيف يعمل</a> •
  <a href="#أدوات-البحث-mcp-search-tools">أدوات البحث</a> •
  <a href="#المستندات">التوثيق</a> •
  <a href="#الإعدادات">الإعدادات</a> •
  <a href="#استكشاف-الأخطاء-وإصلاحها">استكشاف الأخطاء وإصلاحها</a> •
  <a href="#الترخيص-license">الترخيص</a>
</p>

<p align="center"  dir="rtl">
MemSmith هو نظام متطور مصمم لضغط وحفظ الذاكرة لسياق عمل Claude Code. وظيفته الأساسية هي جعل "كلود" يتذكر ما فعله في جلسات العمل السابقة بسلاسة، عبر تسجيل تحركاته، وإنشاء ملخصات ذكية، واستدعائها في الجلسات المستقبلية. هذا يضمن عدم ضياع سياق المشروع حتى لو أغلقت البرنامج وفتحته لاحقاً.
</p>

---

## بداية سريعة 

للبدء، افتح "Claude Code" في مبنى الأوامر (Terminal) واكتب الأوامر التالية:
<div dir="ltr"  align="left">

```
> /plugin marketplace add shshalom/memsmith

> /plugin install memsmith
```

</div>

بمجرد إعادة تشغيل Claude Code، سيتم استدعاء السياق من الجلسات السابقة تلقائيا عند الحاجة.

**الميزات الرئيسية:**

- 🧠 **ذاكرة مستديمه**:  سياق عملك لا ينتهي بانتهاء الجلسة، بل ينتقل معك للجلسة التالية.
- 📊 **الكشف التدريجي** (Progressive Disclosure): نظام ذكي يستدعي المعلومات على طبقات، مما يمنحك رؤية واضحة لاستهلاك الـ "Tokens" (التكلفة).
- 🔍 **بحث سريع** - استعلم عن سجل مشروعك باستخدام خاصية `mem-search`.
- 🖥️ **واجهة مستخدم ويب** - رؤية معلومات الذاكرة مع  تحديث فوري عبر المتصفح من خلال الرابط: http://localhost:37777
- 💻 **تكامل مع Claude Desktop** - إمكانية البحث في الذاكرة مباشرة من واجهة Claude المكتبية
- 🔒 **التحكم في الخصوصية** - دعم وسم `<private>` لمنع النظام من تخزين أي معلومات حساسة.
- ⚙️ **إعدادات السياق** - تحكم دقيق في السياق (context) التي سيتم حقنها في سياق المحادثة.
- 🤖 **أتمتة كاملة:** - النظام يعمل في الخلفية دون الحاجة لتدخل يدوي منك.
- 🔗 **الاستشهادات** - رجوع إلى الملاحظات السابقة باستخدام (http://localhost:37777/api/observation/{id} أو عرض جميع المعلومات على http://localhost:37777)
- 🧪 **مزايا التجريبيه** - تجربة مميزات مثل "الوضع اللانهائي" (Endless Mode).

---

## المستندات 

📚 **[عرض التوثيق الكامل](https://docs.memsmith.ai/)** - تصفح على الموقع الرسمي

### البدء

- **[دليل التثبيت](https://docs.memsmith.ai/installation)** - البدء السريع والتثبيت المتقدم
- **[دليل الاستخدام](https://docs.memsmith.ai/usage/getting-started)** - كيف يعمل MemSmith تلقائيًا
- **[أدوات البحث](https://docs.memsmith.ai/usage/search-tools)** - استعلم عن سجل مشروعك بلغتك
- **[الميزات التجريبية](https://docs.memsmith.ai/beta-features)** - جرّب الميزات التجريبية مثل Endless Mode

### أفضل الممارسات

- **[هندسة السياق](https://docs.memsmith.ai/context-engineering)** - مبادئ تحسين سياق وكيل الذكاء الاصطناعي
- **[الكشف التدريجي](https://docs.memsmith.ai/progressive-disclosure)** - الفلسفة وراء استراتيجية تهيئة السياق في MemSmith

### البنية المعمارية

- **[نظرة عامة](https://docs.memsmith.ai/architecture/overview)** - مكونات النظام وتدفق البيانات
- **[تطور البنية المعمارية](https://docs.memsmith.ai/architecture-evolution)** - تطور المعمارية من v3 إلى v5
- **[بنية برامج الربط (Hooks)](https://docs.memsmith.ai/hooks-architecture)** - كيف يستخدم MemSmith خطافات دورة الحياة
- **[مرجع برامج الربط (Hooks)](https://docs.memsmith.ai/architecture/hooks)** - شرح 7 سكريبتات خطافات
- **[خدمة العامل](https://docs.memsmith.ai/architecture/worker-service)** - HTTP API وإدارة Bun
- **[قاعدة البيانات](https://docs.memsmith.ai/architecture/database)** - مخطط SQLite وبحث FTS5
- **[بنية البحث](https://docs.memsmith.ai/architecture/search-architecture)** - البحث المختلط مع قاعدة بيانات المتجهات Chroma

### الإعدادات والتطوير

- **[الإعدادات](https://docs.memsmith.ai/configuration)** - متغيرات البيئة والإعدادات
- **[التطوير](https://docs.memsmith.ai/development)** - البناء، الاختبار، سير العمل للمساهمة
- **[استكشاف الأخطاء وإصلاحها](https://docs.memsmith.ai/troubleshooting)** - المشكلات الشائعة والحلول

---

## كيف يعمل

**المكونات الأساسية:**

1. **5 برامج ربط (Hooks)** - SessionStart، UserPromptSubmit، PostToolUse، Stop، SessionEnd
2. **تثبيت ذكي** - فاحص التبعيات المخزنة مؤقتًا
3. **خدمة العامل** - HTTP API على المنفذ 37777 مع واجهة مستخدم عارض الويب و10 نقاط نهاية للبحث، تديرها Bun
4. **قاعدة بيانات SQLite** - تخزن الجلسات، الملاحظات، الملخصات
5. **مهارة mem-search** - استعلامات اللغة الطبيعية مع الكشف التدريجي
6. **قاعدة بيانات المتجهات Chroma** - البحث الدلالي الهجين + الكلمات المفتاحية لاسترجاع السياق الذكي

انظر [نظرة عامة على البنية المعمارية](https://docs.memsmith.ai/architecture/overview) للتفاصيل.

---

## أدوات البحث (MCP Search Tools)
يوفر MemSmith بحثًا ذكيًا من خلال مهارة mem-search التي تُستدعى تلقائيًا عندما تسأل عن العمل السابق:

**كيف يعمل:**
- فقط اسأل بشكل طبيعي: *"ماذا فعلنا في الجلسة الأخيرة؟"* أو *"هل أصلحنا هذا الخطأ من قبل؟"*
- يستدعي Claude تلقائيًا خاصية mem-search للعثور على السياق ذي الصلة

**عمليات البحث المتاحة:**

1. **البحث في الملاحظات** - البحث النصي الكامل عبر الملاحظات
2. **البحث في الجلسات** - البحث النصي الكامل عبر ملخصات الجلسات
3. **البحث في المطالبات** - البحث في طلبات المستخدم الخام
4. **حسب المفهوم** - البحث بواسطة وسوم المفهوم (discovery، problem-solution، pattern، إلخ.)
5. **حسب الملف** - البحث عن الملاحظات التي تشير إلى ملفات محددة
6. **حسب النوع** - البحث حسب النوع (decision، bugfix، feature، refactor، discovery، change)
7. **السياق الحديث** - الحصول على سياق الجلسة الأخيرة لمشروع
8. **الجدول الزمني** - الحصول على جدول زمني موحد للسياق حول نقطة زمنية محددة
9. **الجدول الزمني حسب الاستعلام** - البحث عن الملاحظات والحصول على سياق الجدول الزمني حول أفضل تطابق
10. **مساعدة API** - الحصول على توثيق API البحث

**أمثلة على الاستعلامات:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

انظر [دليل أدوات البحث](https://docs.memsmith.ai/usage/search-tools) لأمثلة مفصلة.

---

## الميزات التجريبية

يقدم MemSmith **قناة تجريبية** بميزات تجريبية مثل **Endless Mode** (بنية ذاكرة بيوميمتية للجلسات الممتدة). بدّل بين الإصدارات المستقرة والتجريبية من واجهة مستخدم عارض الويب على http://localhost:37777 ← الإعدادات.

انظر **[توثيق الميزات التجريبية](https://docs.memsmith.ai/beta-features)** لتفاصيل حول Endless Mode وكيفية تجربته.

---

## متطلبات النظام

- **Node.js**: 20.0.0 أو أعلى
- **Claude Code**: أحدث إصدار مع دعم الإضافات
- **Bun & uv**: (يتم تثبيتهما تلقائياً) لإدارة العمليات والبحث المتجه.
- **SQLite 3**: للتخزين المستمر (مدمج)

---

## الإعدادات

تتم إدارة الإعدادات في `~/.memsmith/settings.json` (يتم إنشاؤه تلقائيًا بالقيم الافتراضية عند التشغيل الأول). قم بتكوين نموذج الذكاء الاصطناعي، منفذ العامل، دليل البيانات، مستوى السجل، وإعدادات حقن السياق.

انظر **[دليل الإعدادات](https://docs.memsmith.ai/configuration)** لجميع الإعدادات المتاحة والأمثلة.

---

## التطوير

انظر **[دليل التطوير](https://docs.memsmith.ai/development)** لتعليمات البناء، الاختبار، وسير عمل المساهمة.

---

## استكشاف الأخطاء وإصلاحها

إذا واجهت مشكلة، اشرحها لـ Claude وسيقوم بتشغيل خاصية troubleshoot لإصلاحها ذاتياً.

انظر **[دليل استكشاف الأخطاء وإصلاحها](https://docs.memsmith.ai/troubleshooting)** للمشكلات الشائعة والحلول.

---

## تقارير الأخطاء

أنشئ تقارير أخطاء شاملة باستخدام المولّد الآلي:
<div align=left>

```bash
cd ~/.claude/plugins/marketplaces/shshalom
npm run bug-report
```
</div>

## المساهمة

المساهمات مرحب بها! يُرجى:

1. عمل Fork للمشروع (Repository)
2. إنشاء فرع (branch)
3. إجراء التغييرات مع الاختبارات
4. تحديث المستندات عند الحاجه
5. تقديم Pull Request

انظر [دليل التطوير](https://docs.memsmith.ai/development) لسير عمل المساهمة.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@shshalom). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## الدعم

- **التوثيق**: [docs/](docs/)
- **المشكلات**: [GitHub Issues](https://github.com/shshalom/memsmith/issues)
- **المستودع**: [github.com/shshalom/memsmith](https://github.com/shshalom/memsmith)
- **المؤلف**: Alex Newman ([@shshalom](https://github.com/shshalom))

---

**مبني باستخدام Claude Agent SDK** | **مدعوم بواسطة Claude Code** | **صُنع باستخدام TypeScript**

</section>
