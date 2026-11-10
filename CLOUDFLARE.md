# F&N على Cloudflare Workers Free

هذا خادم التطبيق، وليس نسخة Expo للويب. `wrangler.jsonc` يحدد نقطة الدخول الصحيحة ويمنع Wrangler من التخمين وتشغيل `expo export -p web`.

## البناء والنشر

- اربط المستودع الذي يحتوي على الملفات الجديدة، وفرع `main`.
- اسم Worker هو `fn-chat` كما في `wrangler.jsonc`.
- Root directory: جذر المستودع `/`.
- Build command: فارغ / None.
- Deploy command: `npm run deploy` (أو `npx wrangler deploy`).
- لا تضف Assets directory أو Web build command. لا تحتاج `react-dom` أو `react-native-web` لخادم التطبيق.
- النشر ينشئ ربط `FN_ROOM` وDurable Object باسم `PrivateRoom` باستخدام SQLite الدائم المتاح على الخطة المجانية. لا تستخدم Containers أو خطة Workers Paid.

## إعداد الحسابين

من **Worker → Settings → Variables and Secrets** أضف النوع Secret:

| الاسم | القيمة |
|---|---|
| `PASSWORD_1` | كلمة مرور F، بين 16 و128 حرفًا |
| `PASSWORD_2` | كلمة مرور N مختلفة، بين 16 و128 حرفًا |

الأسماء `USER_1=F` و`USER_2=N` في ملف Wrangler. لتغييرهما عدّل الملف وأعد النشر. لا تضع أي سر في Git، أو Build variables، أو إعدادات APK. لا ترسل قيم الأسرار في صور أو محادثات.

الخادم يدعم حسابين فقط. اسم المرسل والطرف الآخر يحددهما الخادم، ولا يمكن للعميل اختيار غرفة أخرى. الدخول المكرر مرفوض؛ إعادة الاتصال تحتاج رمز الجلسة الحالي. رموز الجلسات وحالة المكالمة محفوظة أثناء سكون Durable Object. الرسائل محفوظة في تخزين SQLite المرفق بالخادم وليست في ملفات مؤقتة.

## إعداد المكالمات

الشات يمكن اختباره أولًا بعد ضبط كلمتي المرور. لتشغيل الصوت والفيديو بين شبكات مختلفة أضف Secret لكل من:

- `CF_TURN_KEY_ID`
- `CF_TURN_API_TOKEN`

أو لخادم coturn خاص: `TURN_URLS` و`TURN_SHARED_SECRET`. طلب بيانات المكالمات يتطلب جلسة مصدقة. مفاتيح TURN تظل على الخادم؛ التطبيق يحصل على بيانات مؤقتة فقط. عدم ضبط TURN يعطي رسالة واضحة عند محاولة المكالمة، دون التحول الصامت إلى اتصال STUN غير مضمون.

## التحقق وبناء الموبايل

1. افتح عنوان الخدمة الفعلي مع `/health`. قبل ضبط الحسابات يرجع 503 و`needs_configuration`؛ بعدها يرجع `status: ok` و`transport: websocket`. قيمة `callsConfigured` تفيد وجود إعدادات TURN فقط، ولا تثبت صلاحية المفاتيح أو نجاح المكالمات.
2. ابنِ APK جديدًا بعنوان الخدمة HTTPS باستخدام `FN_SERVER_URL` و`FN_ONLINE_BUILD=1` و`FN_SERVER_TRANSPORT=websocket`. نطاق `workers.dev` يختار WebSocket تلقائيًا أيضًا؛ اضبط المتغير صراحة عند استخدام نطاق خاص.
3. نسخة APK السابقة تستخدم الخادم المحلي ولا تتغير بمجرد نجاح نشر Worker. افتح التطبيقين على هاتفين، وسجّل F وN، واختبر الرسائل وإعادة الاتصال والصوت والفيديو على شبكتين مختلفتين.
4. اختبار SQLite وإعادة إنشاء الكائن محليًا: `npm test`. اختبار بناء Wrangler بدون نشر: `npx wrangler deploy --dry-run`.

هذه النسخة لا تستورد الرسائل القديمة تلقائيًا من قاعدة SQLite المحلية أو Neon. لا تحذفها. التطبيق يحتاج أن يبقى مفتوحًا لاستقبال رنين المكالمات؛ إشعارات الخلفية لم تضف بعد. الرسائل مصدقة ومحفوظة على الخادم وليست مشفرة من طرف إلى طرف.

## حدود الاستخدام

الخطة المجانية محدودة وليست ضمانًا لاستضافة دائمة. عند تجاوز حدود Workers/Durable Objects تتعطل العمليات بدل التحول التلقائي إلى رسوم على خطة Free. خدمة TURN لها حدود وشروط مستقلة يجب التأكد منها داخل الحساب قبل تفعيلها.

المراجع: [Workers](https://www.cloudflare.com/products/workers/)، [Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/)، [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
