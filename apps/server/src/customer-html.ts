import { createHash } from "node:crypto";
import { PASS_TEXT } from "@cafe-loyalty/db";
import { DEFAULT_CARD_COLORS, PRODUCT_NAME, type CardColors } from "@cafe-loyalty/shared";
import { selfHostedFonts, stylesheets, tokenValue } from "@cafe-loyalty/ui";

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

/** Where the customer pages' fonts and logo are served from (customer-pages.ts); their own origin only. */
export const FONT_PATH = "/assets/fonts/";
export const LOGO_PATH = "/assets/logo.svg";
export const ICON_PATH = "/assets/icon-192.png";

/** The browser's bar colour on phones: the card's espresso. */
const THEME_COLOR = tokenValue("color-espresso");

const fonts = selfHostedFonts(FONT_PATH);

/** The font files the stylesheet names, by file name, to their paths on disk. */
export const FONT_FILES = fonts.files;

/**
 * The one stylesheet: the design system's fonts, tokens, base and customer styles (@cafe-loyalty/ui). Its hash is the
 * only style the CSP allows, and no script is allowed at all (AC 7).
 */
const STYLE = `${fonts.css}\n${stylesheets(["tokens", "base", "customer"])}`;

const styleHash = (style: string): string => `'sha256-${createHash("sha256").update(style).digest("base64")}'`;

/**
 * Content-Security-Policy for a customer page: no scripts, no outside resources, only our own forms, fonts and images
 * (the logos included), and only the one stylesheet, plus `extraStyle` when the page has one (a café's card colours).
 */
export const customerCsp = (extraStyle?: string): string =>
  [
    "default-src 'none'",
    `style-src ${[STYLE, ...(extraStyle === undefined ? [] : [extraStyle])].map(styleHash).join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/** The policy of every customer page without a stylesheet of its own. */
export const CUSTOMER_CSP = customerCsp();

/**
 * The stylesheet giving a card face its café's colours (customer.css reads them), or undefined for a café on the
 * product's colours, whose card stays as it always looked. Only #rrggbb values (as the database keeps them) go in. The
 * copper glow goes: over the café's own background it would lower the 4.5:1 the operator was promised.
 */
export function cardStyle(colors: CardColors): string | undefined {
  const isDefault = colors.background === DEFAULT_CARD_COLORS.background && colors.foreground === DEFAULT_CARD_COLORS.foreground && colors.label === DEFAULT_CARD_COLORS.label;
  if (isDefault || ![colors.background, colors.foreground, colors.label].every((color) => /^#[0-9a-f]{6}$/.test(color))) {
    return undefined;
  }
  return `.card-face{--card-background:${colors.background};--card-foreground:${colors.foreground};--card-label:${colors.label};--card-glow:transparent}`;
}

/** Strings for the customer pages. `{name}` style placeholders are filled by `t`. */
const MESSAGES = {
  en: {
    ...PASS_TEXT.en,
    other: "العربية",
    joinTitle: "Get your loyalty card at {cafe}",
    programSummary: "Collect {stamps} and get: {reward}.",
    nameLabel: "Your name",
    nameHint: "The café's staff see it on your card.",
    nameInvalid: "Enter your name, up to 60 characters.",
    countryCodeLabel: "Country code",
    countryCodeHint: "+961 is Lebanon. Change it for a number from another country.",
    countryCodeInvalid: "Enter a country code, such as +961.",
    phoneLabel: "Your mobile number",
    phoneHint: "For example 70 123 456. The café uses it to find your card when you forget your phone.",
    privacyTitle: "Privacy",
    privacyText:
      "{operator} keeps your number encrypted, with your name, stamps and visits at {cafe}, only to run your loyalty card. The café sees your card and your name, not your number. If you tick the offers box, {cafe} may show offers on your card; you can turn them off in your card's settings. You can add an email to restore your card on a new phone, and you can delete your card at any time from its page.",
    privacyAccept: "I have read the privacy notice and want a card.",
    joinButton: "Get my card",
    joinEmailLabel: "Recovery email (optional)",
    joinEmailHint: "If you lose this phone, we can email you a link to restore your card. You can also add one later from your card.",
    alreadyHaveCard: "Already have a card here? Open it from your wallet or bookmark: signing up again starts a new card.",
    phoneInvalid: "Enter a mobile number, such as 70 123 456 or +961 70 123 456.",
    privacyRequired: "Tick the box to accept the privacy notice.",
    cardTitle: "Your card at {cafe}",
    siteTitle: "Loyalty card",
    qrAlt: "Your card's QR code. Show it to the barista.",
    keepLink: "This page is your card. Bookmark it or add it to your home screen, and do not share its link.",
    addToAppleWallet: "Add to Apple Wallet",
    addToGoogleWallet: "Add to Google Wallet",
    walletHint: "Your card updates itself in your wallet, and this page keeps working too.",
    emailNudgeTitle: "Don't lose your stamps",
    emailNudgeText: "If you lose this phone or this page's link, a recovery email gets your card back.",
    emailNudgeLink: "Add a recovery email",
    emailTitle: "Recovery email",
    emailText: "If you lose this phone, we can email you a link to restore your card.",
    emailLabel: "Email",
    emailSave: "Save email",
    emailRemoveHint: "Save a new address to replace it, or remove it to have none.",
    emailRemove: "Remove email",
    emailInvalid: "Enter an email address in Latin letters, such as name@example.com.",
    emailCurrent: "Your card's recovery email is {email}.",
    undoTitle: "Put your recovery email back",
    undoText: "Enter the email address this link was sent to. Your card goes back to it, gets a new link on this phone, and its old links and QR codes stop working.",
    undoButton: "Put my email back",
    undoWrongEmail: "This is not the address this link was sent to.",
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
    restoreDeleteTitle: "Delete your cards",
    restoreDeleteText: "Or delete every card that uses this email, with its stamps. Your number is deleted too unless another card still uses it. It cannot be undone.",
    restoreDeleteConfirm: "Yes, delete every card that uses this email.",
    restoreDeleteButton: "Delete my cards",
    restoredTitle: "Your cards",
    restoredText: "Open each card and bookmark it on this phone:",
    linkExpired: "This link has expired, was already used, or was replaced by a newer one. Ask for a new link.",
    cardGone: "This card link no longer works. If you restored your card on another phone, use the new link there.",
    joinGone: "This signup code is no longer valid. Ask the café for its current code.",
    crossSite: "This form can only be sent from its own page. Open the page again and send the form from there.",
    joinPaused: "{cafe} is not taking new members right now. Ask the café when you can join.",
    tooMany: "Too many attempts. Wait {minutes} and try again.",
    failed: "Something went wrong on our side. Try again in a moment.",
    badRequest: "This form could not be read. Go back, check it and send it again.",
    notFound: "No such page. Check the link, or scan the café's code again.",
    errorTitle: "Loyalty card: there is a problem",
    askNewLink: "Ask for a new link",
    restoreCard: "Restore your card",
    tryAgain: "Try again",
    stampsToGo: "{stamps} to go for {reward}.",
    rewardReady: "Your reward is ready: {reward}. Show this card to the barista.",
    rewardReadyHeading: "Reward ready: show this code to the barista",
    yourOffer: "Your offer",
    poweredBy: "Loyalty card by {product}",
    feedbackTitle: "How was your visit to {cafe}?",
    feedbackText: "Tell the café what went well and what didn't. Your message goes privately to the owner.",
    feedbackLabel: "Your message",
    feedbackHint: "Up to 2,000 characters. The café does not see your name or number, and the owner cannot reply to it here.",
    feedbackSend: "Send to the café",
    feedbackSent: "Thank you. Your message is with the café.",
    feedbackDone: "You already sent a message about this visit. Thank you.",
    feedbackClosed: "This visit was more than 30 days ago, so its feedback link no longer works.",
    feedbackEmpty: "Write a message before you send it.",
    feedbackTooLong: "Keep your message to 2,000 characters.",
    reviewTitle: "Review {cafe} on Google",
    reviewText: "You can also leave a public review on Google, whatever you thought of your visit.",
    reviewButton: "Write a Google review",
    cardFeedbackTitle: "How was your visit?",
    cardFeedbackLink: "Tell the café",
    settingsLink: "Card settings: email, offers, delete",
    settingsTitle: "Card settings",
    settingsPageTitle: "Card settings at {cafe}",
    backToCard: "Back to your card",
  },
  ar: {
    ...PASS_TEXT.ar,
    other: "English",
    joinTitle: "احصل على بطاقة الولاء في {cafe}",
    programSummary: "اجمع {stamps} واحصل على: {reward}.",
    nameLabel: "اسمك",
    nameHint: "يراه فريق المقهى على بطاقتك.",
    nameInvalid: "أدخل اسمك، 60 حرفاً كحد أقصى.",
    countryCodeLabel: "رمز البلد",
    countryCodeHint: "⁦+961⁩ هو رمز لبنان. غيّره إذا كان رقمك من بلد آخر.",
    countryCodeInvalid: "أدخل رمز البلد، مثل ⁦+961⁩.",
    phoneLabel: "رقم هاتفك المحمول",
    phoneHint: "مثلاً ⁦70 123 456⁩. يستخدمه المقهى للعثور على بطاقتك إذا نسيت هاتفك.",
    privacyTitle: "الخصوصية",
    privacyText:
      "يحتفظ {operator} برقمك مشفّراً، مع اسمك وأختامك وزياراتك في {cafe}، فقط لتشغيل بطاقة الولاء. يرى المقهى بطاقتك واسمك لا رقمك. إذا وضعت علامة في مربع العروض، قد يعرض {cafe} عروضاً على بطاقتك، ويمكنك إيقافها من إعدادات بطاقتك. يمكنك إضافة بريد إلكتروني لاستعادة بطاقتك على هاتف جديد، ويمكنك حذف بطاقتك في أي وقت من صفحتها.",
    privacyAccept: "قرأت إشعار الخصوصية وأريد بطاقة.",
    joinButton: "أعطني بطاقتي",
    joinEmailLabel: "بريد الاستعادة (اختياري)",
    joinEmailHint: "إذا فقدت هذا الهاتف، يمكننا أن نرسل إلى بريدك رابطاً لاستعادة بطاقتك. يمكنك أيضاً إضافته لاحقاً من بطاقتك.",
    alreadyHaveCard: "لديك بطاقة هنا من قبل؟ افتحها من محفظتك أو من المفضلة: التسجيل مرة أخرى يبدأ بطاقة جديدة.",
    phoneInvalid: "أدخل رقم هاتف محمول، مثل ⁦70 123 456⁩ أو ⁦+961 70 123 456⁩.",
    privacyRequired: "ضع علامة في المربع للموافقة على إشعار الخصوصية.",
    cardTitle: "بطاقتك في {cafe}",
    siteTitle: "بطاقة الولاء",
    qrAlt: "رمز QR الخاص ببطاقتك. أظهره للباريستا.",
    keepLink: "هذه الصفحة هي بطاقتك. احفظها في المفضلة أو أضفها إلى الشاشة الرئيسية، ولا تشارك رابطها.",
    addToAppleWallet: "إضافة إلى Apple Wallet",
    addToGoogleWallet: "إضافة إلى محفظة Google",
    walletHint: "تُحدَّث بطاقتك تلقائياً في محفظتك، وتبقى هذه الصفحة تعمل أيضاً.",
    emailNudgeTitle: "لا تخسر أختامك",
    emailNudgeText: "إذا فقدت هذا الهاتف أو رابط هذه الصفحة، يعيد لك بريد الاستعادة بطاقتك.",
    emailNudgeLink: "أضف بريد استعادة",
    emailTitle: "بريد الاستعادة",
    emailText: "إذا فقدت هذا الهاتف، يمكننا أن نرسل لك رابطاً لاستعادة بطاقتك.",
    emailLabel: "البريد الإلكتروني",
    emailSave: "حفظ البريد",
    emailRemoveHint: "احفظ عنواناً جديداً ليحلّ محله، أو أزله كي لا يبقى أي بريد.",
    emailRemove: "إزالة البريد",
    emailInvalid: "أدخل عنوان بريد بالأحرف اللاتينية، مثل name@example.com.",
    emailCurrent: "بريد الاستعادة لبطاقتك هو {email}.",
    undoTitle: "أعد بريد الاستعادة",
    undoText: "أدخل عنوان البريد الذي أُرسل إليه هذا الرابط. تعود بطاقتك إليه، وتحصل على رابط جديد على هذا الهاتف، وتتوقف روابطها ورموز QR القديمة عن العمل.",
    undoButton: "أعد بريدي",
    undoWrongEmail: "هذا ليس العنوان الذي أُرسل إليه هذا الرابط.",
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
    restoreDeleteTitle: "حذف بطاقاتك",
    restoreDeleteText: "أو احذف كل البطاقات التي تستخدم هذا البريد، مع أختامها. يُحذف رقمك أيضاً ما لم تكن بطاقة أخرى لا تزال تستخدمه. لا يمكن التراجع عن ذلك.",
    restoreDeleteConfirm: "نعم، احذف كل البطاقات التي تستخدم هذا البريد.",
    restoreDeleteButton: "حذف بطاقاتي",
    restoredTitle: "بطاقاتك",
    restoredText: "افتح كل بطاقة واحفظها على هذا الهاتف:",
    linkExpired: "انتهت صلاحية هذا الرابط أو استُخدم أو حلّ محله رابط أحدث. اطلب رابطاً جديداً.",
    cardGone: "رابط هذه البطاقة لم يعد يعمل. إذا استعدت بطاقتك على هاتف آخر، فاستخدم الرابط الجديد هناك.",
    joinGone: "رمز التسجيل هذا لم يعد صالحاً. اطلب من المقهى رمزه الحالي.",
    crossSite: "لا يمكن إرسال هذا النموذج إلا من صفحته. افتح الصفحة مجدداً وأرسل النموذج منها.",
    joinPaused: "{cafe} لا يستقبل أعضاء جدداً حالياً. اسأل المقهى متى يمكنك الانضمام.",
    tooMany: "محاولات كثيرة. انتظر {minutes} وحاول مجدداً.",
    failed: "حدث خطأ لدينا. حاول بعد قليل.",
    badRequest: "تعذّرت قراءة هذا النموذج. ارجع وتحقق منه وأرسله مجدداً.",
    notFound: "لا توجد صفحة كهذه. تحقق من الرابط، أو امسح رمز المقهى مجدداً.",
    errorTitle: "بطاقة الولاء: هناك مشكلة",
    askNewLink: "اطلب رابطاً جديداً",
    restoreCard: "استعد بطاقتك",
    tryAgain: "حاول مجدداً",
    stampsToGo: "تبقّى {stamps} للحصول على {reward}.",
    rewardReady: "مكافأتك جاهزة: {reward}. أظهر هذه البطاقة للباريستا.",
    rewardReadyHeading: "المكافأة جاهزة: أظهر هذا الرمز للباريستا",
    yourOffer: "عرضك",
    poweredBy: "بطاقة ولاء من {product}",
    feedbackTitle: "كيف كانت زيارتك إلى {cafe}؟",
    feedbackText: "أخبر المقهى بما أعجبك وما لم يعجبك. تصل رسالتك إلى المالك بشكل خاص.",
    feedbackLabel: "رسالتك",
    feedbackHint: "حتى 2,000 حرف. لا يرى المقهى اسمك ولا رقمك، ولا يستطيع المالك الرد على رسالتك هنا.",
    feedbackSend: "إرسال إلى المقهى",
    feedbackSent: "شكراً لك. وصلت رسالتك إلى المقهى.",
    feedbackDone: "لقد أرسلت رسالة عن هذه الزيارة. شكراً لك.",
    feedbackClosed: "مرّ أكثر من 30 يوماً على هذه الزيارة، لذا لم يعد رابط الملاحظات يعمل.",
    feedbackEmpty: "اكتب رسالة قبل إرسالها.",
    feedbackTooLong: "اجعل رسالتك في حدود 2,000 حرف.",
    reviewTitle: "قيّم {cafe} على Google",
    reviewText: "يمكنك أيضاً كتابة تقييم علني على Google، أياً كان رأيك في زيارتك.",
    reviewButton: "اكتب تقييماً على Google",
    cardFeedbackTitle: "كيف كانت زيارتك؟",
    cardFeedbackLink: "أخبر المقهى",
    settingsLink: "إعدادات البطاقة: البريد، العروض، الحذف",
    settingsTitle: "إعدادات البطاقة",
    settingsPageTitle: "إعدادات البطاقة في {cafe}",
    backToCard: "العودة إلى بطاقتك",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)["en"];

/**
 * A message in `lang`, with `{name}` placeholders filled from `values` (as text, escaped when rendered). Each value
 * is wrapped in Unicode isolates (FSI ... PDI), so an English café name inside Arabic text, or the reverse, keeps
 * the sentence's punctuation in place.
 */
export function t(lang: Lang, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in values ? `⁨${String(values[name])}⁩` : placeholder));
}

/** Counted nouns in every plural form each language uses (Arabic has six). */
const COUNTED = {
  stamps: {
    en: { one: "{n} stamp", other: "{n} stamps" },
    ar: { zero: "{n} ختم", one: "ختم واحد", two: "ختمان", few: "{n} أختام", many: "{n} ختمًا", other: "{n} ختم" },
  },
  /** Stamps as a verb's object ("اجمع ختماً واحداً"): Arabic's one and two take the accusative there. */
  stampsToCollect: {
    en: { one: "{n} stamp", other: "{n} stamps" },
    ar: { zero: "{n} ختم", one: "ختماً واحداً", two: "ختمين", few: "{n} أختام", many: "{n} ختمًا", other: "{n} ختم" },
  },
  minutes: {
    en: { one: "{n} minute", other: "{n} minutes" },
    ar: { zero: "{n} دقيقة", one: "دقيقة واحدة", two: "دقيقتين", few: "{n} دقائق", many: "{n} دقيقة", other: "{n} دقيقة" },
  },
} as const satisfies Record<string, Record<Lang, Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>>;

const pluralRules: Record<Lang, Intl.PluralRules> = { ar: new Intl.PluralRules("ar"), en: new Intl.PluralRules("en") };

/** `n` of a counted noun in the language's plural form: "1 stamp", "9 stamps", "ختمان", "3 أختام". */
export function count(lang: Lang, noun: keyof typeof COUNTED, n: number): string {
  const forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string } = COUNTED[noun][lang];
  return (forms[pluralRules[lang].select(n)] ?? forms.other).replace("{n}", String(n));
}

/**
 * A whole customer page: language and direction, a same-origin referrer policy, noindex, the one stylesheet, the favicon, a language
 * switch unless `otherLangHref` is null (a page that cannot be loaded again, such as freshly restored card links), and
 * the product's name in the footer.
 */
export function page(lang: Lang, title: string, body: SafeHtml, otherLangHref: string | null, extraStyle?: string): string {
  return `<!doctype html>${html`<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="${LOGO_PATH}">
<link rel="apple-touch-icon" href="${ICON_PATH}">
<meta name="theme-color" content="${THEME_COLOR}">
<style>${new SafeHtml(STYLE)}</style>
${extraStyle === undefined ? null : html`<style>${new SafeHtml(extraStyle)}</style>`}
</head>
<body>
<main>
${otherLangHref === null ? null : html`<p class="lang"><a href="${otherLangHref}" lang="${lang === "ar" ? "en" : "ar"}">${t(lang, "other")}</a></p>`}
${body}
</main>
<footer class="site-footer"><img src="${LOGO_PATH}" alt="" width="20" height="20">${t(lang, "poweredBy", { product: PRODUCT_NAME })}</footer>
</body>
</html>`.value}`;
}
