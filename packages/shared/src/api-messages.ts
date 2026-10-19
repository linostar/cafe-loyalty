import { arabicPluralForm, fill, type ArabicPlural, type Lang, type TemplateValues } from "./i18n.js";

/**
 * Every message the API sends (error envelopes, their field issues, the shared schemas' messages and the clients' own
 * readings of a failed response), in English as sent, with its Arabic. The API speaks English; the dashboard and the
 * counter show these in Arabic with localiseApiMessage (AC 41). ApiError and the schemas take only messages listed here,
 * so a message without its Arabic does not compile. `{name}` is a placeholder; a message counted by `{n}` may give
 * Arabic's plural forms.
 */
export const API_MESSAGES_AR = {
  // Sessions and access.
  "Your session has ended. Sign in again.": "انتهت جلستك. سجّل الدخول مجدداً.",
  "Your operator session has ended. Sign in to the admin screen again.": "انتهت جلسة المشغّل. سجّل الدخول إلى شاشة الإدارة مجدداً.",
  "This device needs a new access token. It renews itself; try again.": "يحتاج هذا الجهاز إلى رمز وصول جديد. يجدّده تلقائياً؛ حاول مجدداً.",
  "Only the café owner can do this, from the dashboard.": "هذا متاح لمالك المقهى فقط، من لوحة التحكم.",
  "Only the service's operator can do this, from the admin screen.": "هذا متاح لمشغّل الخدمة فقط، من شاشة الإدارة.",
  "The owner removed this device. Pair it again from the owner's dashboard to use it.": "أزال المالك هذا الجهاز. اربطه مجدداً من لوحة تحكم المالك لاستخدامه.",
  "Send the request as JSON, with an empty object ({}) when there is nothing to send.": "أرسل الطلب بصيغة JSON، مع كائن فارغ ({}) عندما لا يوجد ما يُرسل.",
  "Send the request as JSON.": "أرسل الطلب بصيغة JSON.",
  // Owner accounts.
  "The email or password is wrong. Try again, or reset your password.": "البريد الإلكتروني أو كلمة المرور غير صحيحة. حاول مجدداً، أو أعد تعيين كلمة المرور.",
  "This invite link has expired or was already used. Ask for a new invite.": "انتهت صلاحية رابط الدعوة هذا أو استُخدم من قبل. اطلب دعوة جديدة.",
  "This password reset link has expired, was already used, or was replaced by a newer one. Use the newest email's link, or request a new one.":
    "انتهت صلاحية رابط إعادة تعيين كلمة المرور هذا، أو استُخدم، أو حلّ محله رابط أحدث. استخدم رابط أحدث رسالة، أو اطلب رابطاً جديداً.",
  "This email already has an account. Sign in instead, or use another email.": "لهذا البريد حساب مسبقاً. سجّل الدخول، أو استخدم بريداً آخر.",
  "The current password is wrong. Check it and try again.": "كلمة المرور الحالية غير صحيحة. تحقق منها وحاول مجدداً.",
  "Your password was changed somewhere else just now. Sign in again with the new password.": "تغيّرت كلمة مرورك من مكان آخر للتو. سجّل الدخول مجدداً بكلمة المرور الجديدة.",
  "If an account uses this email, a link to reset the password is on its way or already in its inbox. Use the newest one; each link works for 30 minutes after it was sent.":
    "إذا كان هناك حساب بهذا البريد، فرابط إعادة تعيين كلمة المرور في طريقه إليه أو وصل إلى بريده الوارد. استخدم أحدث رابط؛ يعمل كل رابط لمدة 30 دقيقة من إرساله.",
  "This link is incomplete. Open it again from the message.": "هذا الرابط ناقص. افتحه مجدداً من الرسالة.",
  "Enter an email address in Latin letters, such as name@example.com.": "أدخل عنوان بريد بالأحرف اللاتينية، مثل name@example.com.",
  "Enter your password.": "أدخل كلمة المرور.",
  "This password is too common. Choose another.": "كلمة المرور هذه شائعة جداً. اختر غيرها.",
  // The operator's admin screen.
  "The email or password is wrong. Try again, or ask for a new password from create-operator.":
    "البريد الإلكتروني أو كلمة المرور غير صحيحة. حاول مجدداً، أو اطلب كلمة مرور جديدة عبر create-operator.",
  "This café no longer exists. Reload the list.": "هذا المقهى لم يعد موجوداً. أعد تحميل القائمة.",
  "Use the day the café paid, from 2026 up to today.": "استخدم يوم الدفع، من سنة 2026 حتى اليوم.",
  "This payment was already recorded with other details. Reload the page to see it, then record any other payment as a new one.":
    "سُجّلت هذه الدفعة سابقاً بتفاصيل أخرى. أعد تحميل الصفحة لرؤيتها، ثم سجّل أي دفعة أخرى كدفعة جديدة.",
  "Choose pilot, active or suspended.": "اختر تجريبية أو فعّالة أو موقوفة.",
  "Enter the date as YYYY-MM-DD.": "أدخل التاريخ بصيغة YYYY-MM-DD.",
  "Reload the page and record the payment again.": "أعد تحميل الصفحة وسجّل الدفعة مجدداً.",
  "Enter why the payment is voided.": "أدخل سبب إبطال الدفعة.",
  "This payment is not in this café's list. Reload the page.": "هذه الدفعة ليست في قائمة هذا المقهى. أعد تحميل الصفحة.",
  "Choose how the café paid.": "اختر طريقة دفع المقهى.",
  "Reload the page and create the café again.": "أعد تحميل الصفحة وأنشئ المقهى مجدداً.",
  "Enter the café's name.": "أدخل اسم المقهى.",
  "This café was already created with another name. Reload the page to see it, then create any other café as a new one.":
    "أُنشئ هذا المقهى سابقاً باسم آخر. أعد تحميل الصفحة لرؤيته، ثم أنشئ أي مقهى آخر كمقهى جديد.",
  // Café setup.
  "This order type does not exist. Reload the page to see the current list.": "نوع الطلب هذا غير موجود. أعد تحميل الصفحة لرؤية القائمة الحالية.",
  "This staff member does not exist. Reload the page to see the current list.": "هذا الموظف غير موجود. أعد تحميل الصفحة لرؤية القائمة الحالية.",
  "This staff member was removed. Add them again to give them a PIN.": "أُزيل هذا الموظف. أضفه مجدداً لتعطيه رمزاً سرياً.",
  "Fill this in.": "املأ هذا الحقل.",
  "Use at most {max} characters.": "الحد الأقصى للأحرف: {max}.",
  "Use at least {min} characters.": "الحد الأدنى للأحرف: {min}.",
  "Use a whole percentage.": "استخدم نسبة مئوية بلا كسور.",
  "Use 0% or more.": "استخدم 0% أو أكثر.",
  "Use at most 1000%.": "استخدم 1000% على الأكثر.",
  "Use 1% to 100%.": "استخدم من 1% إلى 100%.",
  "Use a whole number of days.": "استخدم عدداً صحيحاً من الأيام.",
  "Use at least {days} days, how long an offer lasts.": "استخدم {days} يوماً على الأقل، وهي مدة العرض.",
  "Use at most {days} days.": "استخدم {days} يوماً على الأكثر.",
  "Paste the review link from your Google Business Profile, such as https://g.page/r/…/review.":
    "الصق رابط التقييم من ملفك في Google Business Profile، مثل https://g.page/r/…/review.",
  "Change at least one field.": "غيّر حقلاً واحداً على الأقل.",
  "Use at least 1 stamp.": "استخدم ختماً واحداً على الأقل.",
  "Use at most 50 stamps.": "استخدم 50 ختماً على الأكثر.",
  "Use 0 to 10 stamps.": "استخدم من 0 إلى 10 أختام.",
  "Use 6 to 12 digits.": "استخدم من 6 إلى 12 رقماً.",
  "Choose a PIN that is harder to guess than a repeated digit or a straight run such as 123456.":
    "اختر رمزاً سرياً أصعب تخميناً من رقم مكرر أو تسلسل مثل 123456.",
  // Money.
  "Enter an amount.": "أدخل مبلغاً.",
  "Use whole cents.": "استخدم سنتات كاملة.",
  "Use an amount of $0 or more.": "استخدم مبلغاً من $0 أو أكثر.",
  "Use an amount of $0.01 or more.": "استخدم مبلغاً من $0.01 أو أكثر.",
  "Use an amount over $0.": "استخدم مبلغاً أكبر من $0.",
  "Use an amount up to $1,000,000.": "استخدم مبلغاً حتى $1,000,000.",
  // Campaigns.
  "A café can run at most {max} campaigns at once. End one first.": "الحد الأقصى للحملات الجارية معاً في المقهى: {max}. أنهِ إحداها أولاً.",
  "Pick order types that are on sale. Reload the page to see the current list.": "اختر أنواع طلبات معروضة للبيع. أعد تحميل الصفحة لرؤية القائمة الحالية.",
  "An order type is not on sale or no longer exists.": "أحد أنواع الطلبات غير معروض للبيع أو لم يعد موجوداً.",
  "This discount takes some order types below your minimum margin. Lower the discount, or leave those order types out.":
    "هذا الخصم يُنزل بعض أنواع الطلبات دون الحد الأدنى لهامش ربحك. خفّض الخصم، أو استبعد تلك الأنواع.",
  "{name} would sell for {price}, below its floor of {floor} (cost {cost} plus {margin}%).":
    "سيُباع {name} بسعر {price}، أي دون حدّه الأدنى {floor} (التكلفة {cost} زائد {margin}%).",
  "This message does not exist. Reload the inbox.": "هذه الرسالة غير موجودة. أعد تحميل صندوق الوارد.",
  "This campaign is not running. Reload the page to see the current list.": "هذه الحملة ليست جارية. أعد تحميل الصفحة لرؤية القائمة الحالية.",
  "Pick at least one day.": "اختر يوماً واحداً على الأقل.",
  "Pick each day once.": "اختر كل يوم مرة واحدة.",
  "Pick at least one order type.": "اختر نوع طلب واحداً على الأقل.",
  "Pick each order type once.": "اختر كل نوع طلب مرة واحدة.",
  "End after the start, on the same day.": "اجعل النهاية بعد البداية، في اليوم نفسه.",
  // Devices and pairing.
  "This counter app is out of date. Keep the phone online: it sends its waiting stamps, then updates itself.":
    "تطبيق الكاونتر هذا قديم. أبقِ الهاتف متصلاً بالإنترنت: سيرسل الأختام المنتظرة ثم يحدّث نفسه.",
  "This pairing code is wrong, used or expired. Check it, or create a new code on the owner's dashboard.":
    "رمز الربط هذا خاطئ أو مستخدم أو منتهي الصلاحية. تحقق منه، أو أنشئ رمزاً جديداً من لوحة تحكم المالك.",
  "This device must be paired again. Create a pairing code on the owner's dashboard.": "يجب ربط هذا الجهاز مجدداً. أنشئ رمز ربط من لوحة تحكم المالك.",
  "This pairing code was already used, cancelled or expired. Reload the page to see the current codes.":
    "رمز الربط هذا استُخدم أو أُلغي أو انتهت صلاحيته. أعد تحميل الصفحة لرؤية الرموز الحالية.",
  "This device does not exist. Reload the page to see the current list.": "هذا الجهاز غير موجود. أعد تحميل الصفحة لرؤية القائمة الحالية.",
  "The device's key is not valid. Reload the counter app and pair again.": "مفتاح الجهاز غير صالح. أعد تحميل تطبيق الكاونتر واربطه مجدداً.",
  "Not a P-256 public key.": "ليس مفتاحاً عاماً من نوع P-256.",
  "Not a valid key.": "ليس مفتاحاً صالحاً.",
  "This phone is still paired with another café and may hold stamps it has not sent there. Pair it with that café first, or start over on the phone.":
    "هذا الهاتف لا يزال مربوطاً بمقهى آخر وقد يحمل أختاماً لم يرسلها إليه بعد. اربطه بذلك المقهى أولاً، أو ابدأ من جديد على الهاتف.",
  "This device's clock is off by more than 5 minutes. Set the phone's date and time to automatic, then try again.":
    "ساعة هذا الجهاز تختلف بأكثر من 5 دقائق. اضبط تاريخ الهاتف ووقته على التلقائي، ثم حاول مجدداً.",
  "Outside the accepted clock skew.": "خارج فارق الوقت المقبول.",
  "This renewal was already used. The device signs a new one for each attempt; try again.": "استُخدم طلب التجديد هذا من قبل. يوقّع الجهاز طلباً جديداً لكل محاولة؛ حاول مجدداً.",
  "Not later than the last accepted renewal.": "ليس بعد آخر تجديد مقبول.",
  "Enter the 12-character code shown on the owner's dashboard.": "أدخل الرمز المؤلف من 12 خانة الظاهر على لوحة تحكم المالك.",
  // Stamping, redemption and sync.
  "This barista was removed by the owner. Switch barista and try again.": "أزال المالك هذا الباريستا. بدّل الباريستا وحاول مجدداً.",
  "This reward was already given for another card. Start a new redemption.": "مُنحت هذه المكافأة لبطاقة أخرى. ابدأ استبدالاً جديداً.",
  "This card was moved to another phone. Ask the customer to show the card on their new phone.": "نُقلت هذه البطاقة إلى هاتف آخر. اطلب من الزبون إظهار البطاقة على هاتفه الجديد.",
  "This is not a loyalty card of this café. Scan the customer's card again.": "هذه ليست بطاقة ولاء لهذا المقهى. امسح بطاقة الزبون مجدداً.",
  "This café has no reward yet. Ask the owner to set the loyalty program on the dashboard.": "لا مكافأة لهذا المقهى بعد. اطلب من المالك ضبط برنامج الولاء من لوحة التحكم.",
  "This card has {stamps} of the {required} stamps a reward needs. Add stamps first.": "في هذه البطاقة {stamps} من الأختام، والمكافأة تحتاج {required}. أضف أختاماً أولاً.",
  "This event was already accepted or discarded. Reload the list.": "قُبل هذا الحدث أو أُهمل من قبل. أعد تحميل القائمة.",
  "This list position is not valid. Reload the list.": "موضع القائمة هذا غير صالح. أعد تحميل القائمة.",
  "Enter the number in international form, e.g. +96170123456.": "أدخل الرقم بالصيغة الدولية، مثل ‎+96170123456.",
  "This signup link is incomplete. Scan the café's code again.": "رابط التسجيل هذا ناقص. امسح رمز المقهى مجدداً.",
  "Signature must be 64 bytes, base64url-encoded.": "يجب أن يكون التوقيع 64 بايت بترميز base64url.",
  "The discount is more than the price.": "الخصم أكبر من السعر.",
  "A discount needs its campaign.": "يحتاج الخصم إلى حملته.",
  "A discount needs its campaign or the win-back offer.": "يحتاج الخصم إلى حملته أو إلى عرض الاسترجاع.",
  "The items add up to more than the largest accepted amount.": "مجموع العناصر يتجاوز أكبر مبلغ مقبول.",
  "The total does not match the sum of the items.": "المجموع لا يطابق مجموع العناصر.",
  // Any request.
  "Some fields are missing or not valid. Check them and try again.": "بعض الحقول ناقصة أو غير صالحة. تحقق منها وحاول مجدداً.",
  "Too many attempts. Wait 1 minute and try again.": "محاولات كثيرة. انتظر دقيقة واحدة وحاول مجدداً.",
  "Too many attempts. Wait {n} minutes and try again.": {
    two: "محاولات كثيرة. انتظر دقيقتين وحاول مجدداً.",
    few: "محاولات كثيرة. انتظر {n} دقائق وحاول مجدداً.",
    other: "محاولات كثيرة. انتظر {n} دقيقة وحاول مجدداً.",
  },
  "Too many requests. Wait a minute and try again.": "طلبات كثيرة. انتظر دقيقة وحاول مجدداً.",
  "The request could not be read. Reload the page and try again.": "تعذّرت قراءة الطلب. أعد تحميل الصفحة وحاول مجدداً.",
  "The request is not valid. Reload the page and try again.": "الطلب غير صالح. أعد تحميل الصفحة وحاول مجدداً.",
  "No such page or API route. Check the address.": "لا توجد صفحة أو مسار كهذا. تحقق من العنوان.",
  "The request is too large. Send less at once and try again.": "الطلب كبير جداً. أرسل كمية أقل دفعة واحدة وحاول مجدداً.",
  "Something went wrong on our side. Try again in a moment.": "حدث خطأ لدينا. حاول بعد قليل.",
  // The clients' readings of a failed response (errors.ts).
  "The server sent an unreadable response (HTTP {status}). Wait a moment and try again.": "أرسل الخادم رداً غير مقروء (HTTP {status}). انتظر قليلاً وحاول مجدداً.",
  "The server sent an error this app does not recognise (HTTP {status}). Reload the page and try again.":
    "أرسل الخادم خطأً لا يعرفه هذا التطبيق (HTTP {status}). أعد تحميل الصفحة وحاول مجدداً.",
  "The request failed (HTTP {status}). Try again.": "فشل الطلب (HTTP {status}). حاول مجدداً.",
  "Could not reach the server. Your work is kept and will be sent again.": "تعذّر الوصول إلى الخادم. عملك محفوظ وسيُرسل مجدداً.",
  "Could not reach the server. Check your connection and try again.": "تعذّر الوصول إلى الخادم. تحقق من اتصالك وحاول مجدداً.",
  "The server sent a response this page cannot read. Reload the page and try again.": "أرسل الخادم رداً لا تستطيع هذه الصفحة قراءته. أعد تحميل الصفحة وحاول مجدداً.",
  "Something went wrong on this page. Reload it and try again.": "حدث خطأ في هذه الصفحة. أعد تحميلها وحاول مجدداً.",
  "Could not load this page. Reload it and try again.": "تعذّر تحميل هذه الصفحة. أعد تحميلها وحاول مجدداً.",
  // The counter's own readings of a failure.
  "The owner removed this phone. Ask them for a pairing code to use it again; its waiting stamps are kept.":
    "أزال المالك هذا الهاتف. اطلب منه رمز ربط لاستخدامه مجدداً؛ الأختام المنتظرة محفوظة.",
  "This phone must be paired again. Ask the owner for a pairing code; its waiting stamps are kept.": "يجب ربط هذا الهاتف مجدداً. اطلب من المالك رمز ربط؛ الأختام المنتظرة محفوظة.",
  "The server sent an answer this app cannot read. Your work is kept; reload the page and try again.":
    "أرسل الخادم رداً لا يستطيع هذا التطبيق قراءته. عملك محفوظ؛ أعد تحميل الصفحة وحاول مجدداً.",
  "This phone's storage is busy in another tab. Close the other counter tabs and reload.": "تخزين هذا الهاتف مشغول في تبويب آخر. أغلق تبويبات الكاونتر الأخرى وأعد التحميل.",
  "This phone was paired again meanwhile. Try again.": "رُبط هذا الهاتف مجدداً في هذه الأثناء. حاول مجدداً.",
  "The pairing could not be confirmed. Check the connection and try again; if the code no longer works, ask the owner for a new one.":
    "تعذّر تأكيد الربط. تحقق من الاتصال وحاول مجدداً؛ وإذا لم يعد الرمز يعمل، فاطلب من المالك رمزاً جديداً.",
  "The app could not be saved for offline use. Reload the page while online.": "تعذّر حفظ التطبيق للاستخدام دون اتصال. أعد تحميل الصفحة وأنت متصل بالإنترنت.",
  "This browser cannot keep the app for offline use. Use an up-to-date Chrome or Safari.": "لا يستطيع هذا المتصفح حفظ التطبيق للاستخدام دون اتصال. استخدم إصداراً حديثاً من Chrome أو Safari.",
} as const satisfies Record<string, string | ArabicPlural>;

export type ApiMessage = keyof typeof API_MESSAGES_AR;

declare const filledBrand: unique symbol;
/** A listed message with its placeholders filled, as apiMessage returns it. */
export type FilledApiMessage = string & { readonly [filledBrand]: true };

/** What ApiError and the schemas accept: a listed message, as written or filled. */
export type ApiText = ApiMessage | FilledApiMessage;

/** A listed message as written; a typo or a new message without its Arabic does not compile. */
export const apiText = <T extends ApiMessage>(text: T): T => text;

/** A listed message with its placeholders filled, in English as the API sends it. */
export const apiMessage = (template: ApiMessage, values: TemplateValues): FilledApiMessage => fill("en", template, values) as FilledApiMessage;

/** Longer than any listed message (the longest is about 230 characters) filled with its values. */
const MAX_MESSAGE_LENGTH = 1000;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The messages with placeholders, as patterns that read the values back out of a filled message. */
const TEMPLATES = Object.entries(API_MESSAGES_AR as Readonly<Record<string, string | ArabicPlural>>)
  .filter(([english]) => /\{\w+\}/.test(english))
  .map(([english, arabic]) => {
    const names: string[] = [];
    const pattern = english
      .split(/(\{\w+\})/)
      .map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        if (name === undefined) {
          return escapeRegExp(part);
        }
        names.push(name);
        return "(.+?)";
      })
      .join("");
    return { pattern: new RegExp(`^${pattern}$`), names, arabic };
  });

/**
 * A message from the API (or a client's reading of a failed response) in `lang`. One the catalog does not list, such as
 * a newer server's, stays in English rather than being lost.
 */
export function localiseApiMessage(lang: Lang, message: string): string {
  // Every listed message is far shorter; a longer one (a proxy's page, a corrupted body) is not matched at all, so the
  // placeholder patterns never backtrack over a long text.
  if (lang === "en" || message.length > MAX_MESSAGE_LENGTH) {
    return message;
  }
  if (Object.hasOwn(API_MESSAGES_AR, message)) {
    const arabic: string | ArabicPlural = API_MESSAGES_AR[message as ApiMessage];
    if (typeof arabic === "string") {
      return arabic;
    }
  }
  for (const { pattern, names, arabic } of TEMPLATES) {
    const match = pattern.exec(message);
    if (match === null) {
      continue;
    }
    const values: Record<string, string> = {};
    names.forEach((name, index) => {
      values[name] = match[index + 1] ?? "";
    });
    return fill("ar", typeof arabic === "string" ? arabic : arabicPluralForm(arabic, Number(values.n)), values);
  }
  return message;
}
