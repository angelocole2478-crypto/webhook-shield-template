# Webhook Shield Template

قالب Railway قابل لإعادة الاستخدام لحماية Webhooks من الفقد أثناء التعطل أو النشر. يستقبل الحدث، يخزنه في PostgreSQL، يضعه في Redis/BullMQ، يحاول تسليمه إلى HTTP destination، ثم يعيد المحاولة أو يتركه في حالة `dead_letter`.

## التشغيل خلال خمس دقائق

1. أنشئ PostgreSQL وRedis في Railway.
2. انسخ `.env.example` إلى `.env` واملأ المتغيرات المطلوبة.
3. شغّل `npm install` ثم `npm run build`.
4. شغّل الخادم `npm start` في طرفية والعامل `npm run worker` في طرفية أخرى.
5. أرسل طلباً:

```bash
curl -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: replace-with-a-long-random-secret' \
  -H 'x-event-id: demo-1' \
  -d '{"type":"demo","value":42}'
```

يجب أن يعيد الخادم `202` وحالة `queued`. يستخدم `DELIVERY_URL` كوجهة التسليم. راقب الحدث عبر `GET /events/:id` مع `x-monitor-secret`.

## العقد التشغيلي

المسار هو `Receive → Store → Queue → Retry → Deliver / Dead Letter`. التخزين يحدث قبل وضع الحدث في الطابور. التكرار يمنع إعادة قبول نفس `x-event-id`: أول طلب يعيد `202`، والطلب المكرر يعيد `200 already_accepted`. يرسل العامل `x-webhook-event-id` إلى الوجهة لدعم idempotency. يعيد المحاولة عند أخطاء الشبكة و`5xx` و`408` و`429`، بينما تنتقل أخطاء `4xx` الأخرى مباشرة إلى `dead_letter`. عدد المحاولات الافتراضي ثلاث، مع Backoff أسي يبدأ من ثانية واحدة. ينفذ العامل تنظيفاً دورياً للأحداث الأقدم من `RETENTION_DAYS`.

## المتغيرات

| المتغير | Required | الوصف |
|---|---|---|
| `DATABASE_URL` | نعم | رابط PostgreSQL |
| `REDIS_URL` | نعم | رابط Redis |
| `DELIVERY_URL` | نعم | وجهة HTTP التجريبية أو الحقيقية |
| `INGEST_SECRET` | نعم | سر قبول Webhooks |
| `MONITOR_SECRET` | لا | سر قراءة حالة الأحداث؛ يستخدم `INGEST_SECRET` إن غاب |
| `MAX_ATTEMPTS` | لا | عدد المحاولات، الافتراضي 3 |
| `RETENTION_DAYS` | لا | حذف الأحداث ومحاولات التسليم الأقدم من هذه المدة، الافتراضي 14 |
| `PORT` | لا | المنفذ؛ توفره Railway عادة |

## الاختبارات

شغّل `npm test` لاختبارات الوحدة. بعد تشغيل PostgreSQL وRedis محلياً، يمكن تشغيل اختبار التكامل الكامل بالأمر التالي:

```bash
NODE_ENV=integration DATABASE_URL='postgresql://...' REDIS_URL='redis://...' DELIVERY_URL='http://127.0.0.1:3999/delivery' INGEST_SECRET='...' MONITOR_SECRET='...' npx tsx scripts/integration-test.ts
```

يختبر السكربت المسار الناجح، فشل المحاولتين ثم النجاح، الانتقال إلى DLQ، إعادة التشغيل، ومنع التكرار. نتيجة النجاح المتوقعة هي `integration: pass`.

لإعادة تشغيل حدث موجود في DLQ، أرسل `POST /events/:id/replay` مع ترويسة `x-monitor-secret`. لا يمكن إعادة تشغيل حدث ليس في حالة `dead_letter`.

## حدود V1

هذا قالب V1 بوجهة HTTP واحدة. لا يتضمن Multi-tenancy، أو فوترة، أو لوحة تحليلات متقدمة، أو تكاملات مزودين متعددة، أو ضمان ترتيب عام للأحداث.

## النشر

يمكن نشره على Railway باستخدام Dockerfile و`railway.toml`.

1. ارفع هذا المجلد إلى مستودع GitHub جديد.
2. في Railway اختر **New Project → Deploy from GitHub Repo**.
3. أضف PostgreSQL وRedis إلى المشروع، ثم اربطهما بالخدمة حتى تتوفر `DATABASE_URL` و`REDIS_URL`.
4. أضف `DELIVERY_URL` و`INGEST_SECRET` و`MONITOR_SECRET`. اجعل الأسرار عشوائية ولا تضعها في Git.
5. اترك أمر الخادم كما هو: `node dist/server.js`. يقرأ Railway الإعداد من `railway.toml` ويستخدم `/health` للفحص.
6. أنشئ خدمة ثانية من المستودع نفسه باسم Worker، واضبط أمر التشغيل إلى `node dist/worker.js`. يجب أن تشارك خدمة Worker نفس متغيرات PostgreSQL وRedis وDelivery والأسرار.
7. بعد نجاح النشر، اختبر `/health` من الرابط العام، ثم أرسل Webhook إلى `/webhooks`.

مثال تجربة بعد استبدال `APP_URL` و`INGEST_SECRET`:

```bash
curl -i -X POST "$APP_URL/webhooks" \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $INGEST_SECRET" \
  -H 'x-event-id: first-demo-1' \
  -d '{"type":"demo","value":42}'
```

لأن القالب يحتاج إلى وجهة تسليم، استخدم أولاً endpoint تجريبي يعيد `200`. لا تستخدم عنوان `localhost` داخل Railway؛ فهو يشير إلى الحاوية نفسها وليس إلى جهازك. يمكن في الاختبار الأول استخدام Webhook.site أو خدمة HTTP تجريبية تملكها، ثم استبدالها بالوجهة الحقيقية.

قبل اعتبار القالب منشوراً، تحقق من الآتي: الخادم يصل إلى `healthy`، الـ Worker يعمل، الطلب يعيد `202`، والحدث يصل إلى `DELIVERY_URL`. النشر الكامل يحتاج خدمتي Server وWorker؛ تشغيل الخادم وحده يستقبل الأحداث لكنه لا ينفذ التسليم.
