import { createHash } from "node:crypto";

export type Lang = "ar" | "en";

/** Markup that is already safe to insert. Everything else interpolated into html`` is escaped. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

type Interpolated = SafeHtml | string | number | null | undefined | false | readonly Interpolated[];

function render(value: Interpolated): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (value instanceof SafeHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map((item: Interpolated) => render(item)).join("");
  }
  return escapeHtml(String(value));
}

/** Builds markup, escaping every interpolated value that is not already SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: Interpolated[]): SafeHtml {
  return new SafeHtml(strings.reduce((out, part, index) => out + part + (index < values.length ? render(values[index]) : ""), ""));
}

/** The page language: ?lang= or the form's lang field, else the browser's first preference, else Arabic. */
export function pickLang(requested: unknown, acceptLanguage: string | undefined): Lang {
  if (requested === "ar" || requested === "en") {
    return requested;
  }
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "ar";
}

/** The one stylesheet; its hash is the only style the CSP allows, and no script is allowed at all (AC 7). */
const STYLE = `
:root { font-family: system-ui, sans-serif; line-height: 1.5; color: #1d1d1f; background: #fff; }
body { margin: 0; }
main { box-sizing: border-box; max-width: 30rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.5rem; margin: 0.5rem 0; }
.lang { text-align: end; margin: 0; }
label { display: block; font-weight: 600; margin-block: 0.75rem 0.25rem; }
label.check { display: flex; gap: 0.5rem; align-items: flex-start; font-weight: 400; }
input[type="tel"], input[type="email"] { box-sizing: border-box; width: 100%; padding: 0.5rem; font: inherit; }
input[type="checkbox"] { width: 1.25rem; height: 1.25rem; flex: none; margin-top: 0.15rem; }
button { margin-block: 0.75rem; padding: 0.6rem 1.2rem; font: inherit; }
button.danger { border-color: #a51d2d; color: #a51d2d; }
:focus-visible { outline: 3px solid #1a5fb4; outline-offset: 2px; }
.error { color: #a51d2d; }
.notice { padding: 0.5rem; border-inline-start: 4px solid #26a269; background: #eef8f1; }
.privacy { font-size: 0.95rem; padding: 0.75rem; background: #f4f4f6; }
.qr { display: block; width: 100%; max-width: 18rem; height: auto; margin: 1rem auto; background: #fff; }
.stamps { font-size: 1.25rem; font-weight: 700; }
section { border-block-start: 1px solid #d0d0d7; margin-block-start: 1.5rem; }
ul { padding-inline-start: 1.25rem; }
`;

/** Content-Security-Policy for every customer page: no scripts, no outside resources, only our own forms. */
export const CUSTOMER_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "img-src data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Strings for the customer pages. `{name}` style placeholders are filled by `t`. */
const MESSAGES = {
  en: {
    other: "العربية",
    joinTitle: "Get your loyalty card at {cafe}",
    programSummary: "Collect {stamps} stamps and get: {reward}.",
    phoneLabel: "Your mobile number",
    phoneHint: "For example 70 123 456. The café uses it to find your card when you forget your phone.",
    privacyTitle: "Privacy",
    privacyText:
      "We keep your number encrypted, with your stamps and visits at {cafe}, only to run your loyalty card. The café sees your card, not your number. You can add an email to restore your card on a new phone, and you can delete your card at any time from its page.",
    privacyAccept: "I have read the privacy notice and want a card.",
    offersOptIn: "Send offers from {cafe} to my card (optional).",
    joinButton: "Get my card",
    phoneInvalid: "Enter a mobile number, such as 70 123 456 or +961 70 123 456.",
    privacyRequired: "Tick the box to accept the privacy notice.",
    cardTitle: "Your card at {cafe}",
    stampsProgress: "{stamps} of {required} stamps",
    stampsOnly: "{stamps} stamps",
    qrAlt: "Your card's QR code. Show it to the barista.",
    keepLink: "This page is your card. Bookmark it or add it to your home screen, and do not share its link.",
    emailTitle: "Recovery email",
    emailText: "If you lose this phone, we can email you a link to restore your card.",
    emailLabel: "Email",
    emailSave: "Save email",
    emailRemoveHint: "Leave it empty and save to remove your email.",
    emailInvalid: "Enter an email address in Latin letters, such as name@example.com.",
    offersTitle: "Offers",
    offersLabel: "Send offers from {cafe} to my card.",
    offersSave: "Save",
    deleteTitle: "Delete this card",
    deleteText: "This removes the card, its stamps and your number for this café. It cannot be undone.",
    deleteConfirm: "Yes, delete this card.",
    deleteButton: "Delete card",
    deleteConfirmRequired: "Tick the box to confirm.",
    saved: "Saved.",
    deletedTitle: "Card deleted",
    deletedText: "Your card and its data are deleted.",
    recoverTitle: "Restore your card",
    recoverText: "Enter the recovery email you added to your card. We will send you a link that works for 30 minutes.",
    recoverButton: "Send link",
    recoverSent: "If a card uses this email, we sent it a link. It works for 30 minutes; if you ask again, only the newest email's link works.",
    lostCard: "Lost your phone? Restore your card",
    restoreTitle: "Restore your cards",
    restoreText: "Restoring makes your old card links and QR codes stop working, and gives you new ones on this phone.",
    restoreButton: "Restore my cards",
    restoreDeleteText: "Or delete every card that uses this email.",
    restoreDeleteButton: "Delete my cards",
    restoredTitle: "Your cards",
    restoredText: "Open each card and bookmark it on this phone:",
    linkExpired: "This link has expired, was already used, or was replaced by a newer one. Ask for a new link.",
    cardGone: "This card link no longer works. If you restored your card on another phone, use the new link there.",
    joinGone: "This signup code is no longer valid. Ask the café for its current code.",
    tooMany: "Too many attempts. Wait {minutes} minutes and try again.",
    failed: "Something went wrong on our side. Try again in a moment.",
    badRequest: "This form could not be read. Go back, check it and send it again.",
    notFound: "No such page. Check the link, or scan the café's code again.",
  },
  ar: {
    other: "English",
    joinTitle: "احصل على بطاقة الولاء في {cafe}",
    programSummary: "اجمع {stamps} أختام واحصل على: {reward}.",
    phoneLabel: "رقم هاتفك المحمول",
    phoneHint: "مثلاً 70 123 456. يستخدمه المقهى للعثور على بطاقتك إذا نسيت هاتفك.",
    privacyTitle: "الخصوصية",
    privacyText:
      "نحتفظ برقمك مشفّراً، مع أختامك وزياراتك في {cafe}، فقط لتشغيل بطاقة الولاء. يرى المقهى بطاقتك لا رقمك. يمكنك إضافة بريد إلكتروني لاستعادة بطاقتك على هاتف جديد، ويمكنك حذف بطاقتك في أي وقت من صفحتها.",
    privacyAccept: "قرأت إشعار الخصوصية وأريد بطاقة.",
    offersOptIn: "أرسلوا عروض {cafe} إلى بطاقتي (اختياري).",
    joinButton: "أعطني بطاقتي",
    phoneInvalid: "أدخل رقم هاتف محمول، مثل 70 123 456 أو ‎+961 70 123 456.",
    privacyRequired: "ضع علامة في المربع للموافقة على إشعار الخصوصية.",
    cardTitle: "بطاقتك في {cafe}",
    stampsProgress: "{stamps} من {required} أختام",
    stampsOnly: "{stamps} أختام",
    qrAlt: "رمز QR الخاص ببطاقتك. أظهره للباريستا.",
    keepLink: "هذه الصفحة هي بطاقتك. احفظها في المفضلة أو أضفها إلى الشاشة الرئيسية، ولا تشارك رابطها.",
    emailTitle: "بريد الاستعادة",
    emailText: "إذا فقدت هذا الهاتف، يمكننا أن نرسل لك رابطاً لاستعادة بطاقتك.",
    emailLabel: "البريد الإلكتروني",
    emailSave: "حفظ البريد",
    emailRemoveHint: "اتركه فارغاً واحفظ لإزالة بريدك.",
    emailInvalid: "أدخل عنوان بريد بالأحرف اللاتينية، مثل name@example.com.",
    offersTitle: "العروض",
    offersLabel: "أرسلوا عروض {cafe} إلى بطاقتي.",
    offersSave: "حفظ",
    deleteTitle: "حذف هذه البطاقة",
    deleteText: "يحذف هذا البطاقة وأختامها ورقمك لدى هذا المقهى. لا يمكن التراجع عنه.",
    deleteConfirm: "نعم، احذف هذه البطاقة.",
    deleteButton: "حذف البطاقة",
    deleteConfirmRequired: "ضع علامة في المربع للتأكيد.",
    saved: "تم الحفظ.",
    deletedTitle: "تم حذف البطاقة",
    deletedText: "تم حذف بطاقتك وبياناتها.",
    recoverTitle: "استعادة بطاقتك",
    recoverText: "أدخل بريد الاستعادة الذي أضفته إلى بطاقتك. سنرسل لك رابطاً يعمل لمدة 30 دقيقة.",
    recoverButton: "إرسال الرابط",
    recoverSent: "إذا كانت هناك بطاقة بهذا البريد، فقد أرسلنا إليه رابطاً يعمل لمدة 30 دقيقة؛ إذا طلبت مرة أخرى، فرابط أحدث رسالة هو الوحيد الذي يعمل.",
    lostCard: "فقدت هاتفك؟ استعد بطاقتك",
    restoreTitle: "استعادة بطاقاتك",
    restoreText: "الاستعادة توقف روابط بطاقاتك القديمة ورموز QR وتعطيك روابط جديدة على هذا الهاتف.",
    restoreButton: "استعادة بطاقاتي",
    restoreDeleteText: "أو احذف كل البطاقات التي تستخدم هذا البريد.",
    restoreDeleteButton: "حذف بطاقاتي",
    restoredTitle: "بطاقاتك",
    restoredText: "افتح كل بطاقة واحفظها على هذا الهاتف:",
    linkExpired: "انتهت صلاحية هذا الرابط أو استُخدم أو حلّ محله رابط أحدث. اطلب رابطاً جديداً.",
    cardGone: "رابط هذه البطاقة لم يعد يعمل. إذا استعدت بطاقتك على هاتف آخر، فاستخدم الرابط الجديد هناك.",
    joinGone: "رمز التسجيل هذا لم يعد صالحاً. اطلب من المقهى رمزه الحالي.",
    tooMany: "محاولات كثيرة. انتظر {minutes} دقائق وحاول مجدداً.",
    failed: "حدث خطأ لدينا. حاول بعد قليل.",
    badRequest: "تعذّرت قراءة هذا النموذج. ارجع وتحقق منه وأرسله مجدداً.",
    notFound: "لا توجد صفحة كهذه. تحقق من الرابط، أو امسح رمز المقهى مجدداً.",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)["en"];

/** A message in `lang`, with `{name}` placeholders filled from `values` (as text, escaped when rendered). */
export function t(lang: Lang, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in values ? String(values[name]) : placeholder));
}

/** A whole customer page: language and direction, no referrer, noindex, the one stylesheet, a language switch. */
export function page(lang: Lang, title: string, body: SafeHtml, otherLangHref: string): string {
  return `<!doctype html>${html`<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${new SafeHtml(STYLE)}</style>
</head>
<body>
<main>
<p class="lang"><a href="${otherLangHref}" lang="${lang === "ar" ? "en" : "ar"}">${t(lang, "other")}</a></p>
${body}
</main>
</body>
</html>`.value}`;
}
