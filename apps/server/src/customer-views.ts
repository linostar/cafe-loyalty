import { count, html, page, t, type Lang, type SafeHtml } from "./customer-html.js";

/**
 * The customer pages' markup (AC 4, 7, 8, 9), from plain data: the routes in customer-pages.ts load what a page needs
 * and render it here, and the screenshot spec (e2e/dashboard/customer-screens.spec.ts) renders the same views with
 * fake data. No scripts; the one stylesheet comes from page().
 */

/** A form field's error, tied to its field by id. */
const errorBlock = (message: string | undefined, id: string): SafeHtml | false =>
  message !== undefined && html`<p class="field-error" id="${id}" role="alert">${message}</p>`;

/** The café's program as the customer reads it, in the page's language. */
export interface ProgramView {
  stampsRequired: number;
  reward: string;
}

export interface JoinView {
  path: string;
  cafeName: string;
  program: ProgramView | undefined;
  /** The form's one-time value, which makes sending it twice land on one card. */
  formToken: string;
  values: Readonly<Record<string, string | undefined>>;
  errors: { phone?: string; privacy?: string };
  otherLangHref: string;
}

/** The café's signup page, opened from its counter QR (AC 4, 5). */
export function joinView(lang: Lang, view: JoinView): string {
  const { cafeName, program, values, errors } = view;
  return page(
    lang,
    t(lang, "joinTitle", { cafe: cafeName }),
    html`<header class="hero">
<p class="kicker">${t(lang, "siteTitle")}</p>
<h1>${t(lang, "joinTitle", { cafe: cafeName })}</h1>
${program === undefined ? null : html`<p>${t(lang, "programSummary", { stamps: program.stampsRequired, reward: program.reward })}</p>`}
</header>
<form method="post" action="${view.path}" novalidate class="card">
<input type="hidden" name="lang" value="${lang}">
<input type="hidden" name="form" value="${view.formToken}">
<label for="phone">${t(lang, "phoneLabel")}</label>
<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" required value="${values.phone ?? ""}" aria-describedby="phone-hint${errors.phone === undefined ? "" : " phone-error"}"${errors.phone === undefined ? "" : html` aria-invalid="true"`}>
<p id="phone-hint" class="hint">${t(lang, "phoneHint")}</p>
${errorBlock(errors.phone, "phone-error")}
<div class="privacy" id="privacy-text"><strong>${t(lang, "privacyTitle")}</strong><p>${t(lang, "privacyText", { cafe: cafeName })}</p></div>
<label class="check"><input type="checkbox" name="privacy" value="yes" required aria-describedby="privacy-text${errors.privacy === undefined ? "" : " privacy-error"}"${errors.privacy === undefined ? "" : html` aria-invalid="true"`}${values.privacy === "yes" ? html` checked` : ""}> ${t(lang, "privacyAccept")}</label>
${errorBlock(errors.privacy, "privacy-error")}
<label class="check"><input type="checkbox" name="offers" value="yes"${values.offers === "yes" ? html` checked` : ""}> ${t(lang, "offersOptIn", { cafe: cafeName })}</label>
<button type="submit">${t(lang, "joinButton")}</button>
</form>
<p class="aside"><a href="/recover?lang=${lang}">${t(lang, "lostCard")}</a></p>`,
    view.otherLangHref,
  );
}

/** How the web card offers a wallet pass: Apple's to Apple devices, Google's to the others, or neither. */
export type WalletLink = { kind: "apple"; href: string } | { kind: "google"; href: string; badge: string } | null;

export interface CardView {
  path: string;
  cafeName: string;
  stamps: number;
  program: ProgramView | undefined;
  /** The card's signed QR, as an image data URL. */
  qr: string;
  /** The offer the card holds now (offerText), if any. */
  offer: { headline: string; details: string } | undefined;
  /** The feedback page of the card's latest visit (AC 37), if it was asked about one. */
  feedbackHref: string | undefined;
  wallet: WalletLink;
  email: string | null;
  offersOptedIn: boolean;
  notice: string | undefined;
  errors: { email?: string; delete?: string };
  otherLangHref: string;
}

/** A tick for a collected stamp; drawn, so it needs no image the policy would have to allow. */
const TICK = html`<svg viewBox="0 0 24 24" focusable="false"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The stamps as a grid of the program's slots, filled up to the card's count; the text beside it says the same. */
function stampGrid(stamps: number, required: number): SafeHtml {
  const slots = Array.from({ length: required }, (_, index) => (index < stamps ? html`<li class="stamp is-filled">${TICK}</li>` : html`<li class="stamp"></li>`));
  return html`<ol class="stamp-grid" aria-hidden="true">${slots}</ol>`;
}

/** The web card (AC 7, 10): the card itself with its stamps and QR, then the card's own settings. */
export function cardView(lang: Lang, view: CardView): string {
  const { program, stamps, errors } = view;
  const left = program === undefined ? 0 : program.stampsRequired - stamps;
  return page(
    lang,
    t(lang, "cardTitle", { cafe: view.cafeName }),
    html`${view.notice === undefined ? null : html`<p class="notice" role="status">${view.notice}</p>`}
<article class="loyalty-card" aria-labelledby="card-title">
<div class="card-face">
<p class="kicker">${t(lang, "siteTitle")}</p>
<h1 id="card-title">${t(lang, "cardTitle", { cafe: view.cafeName })}</h1>
<p class="stamps">${program === undefined ? count(lang, "stamps", stamps) : t(lang, "stampsProgress", { stamps, required: count(lang, "stamps", program.stampsRequired) })}</p>
${program === undefined ? null : stampGrid(stamps, program.stampsRequired)}
${program === undefined
  ? null
  : html`<p class="reward">${left > 0 ? t(lang, "stampsToGo", { stamps: count(lang, "stamps", left), reward: program.reward }) : t(lang, "rewardReady", { reward: program.reward })}</p>`}
</div>
<div class="card-qr">
<img class="qr" src="${view.qr}" alt="${t(lang, "qrAlt")}" width="288" height="288">
</div>
</article>
${view.offer === undefined
  ? null
  : html`<section class="offer" aria-labelledby="offer-title">
<p class="kicker">${t(lang, "yourOffer")}</p>
<h2 id="offer-title">${view.offer.headline}</h2>
<p>${view.offer.details}</p>
</section>`}
${view.wallet === null
  ? null
  : view.wallet.kind === "apple"
    ? html`<p class="wallet-row"><a class="wallet" href="${view.wallet.href}">${t(lang, "addToAppleWallet")}</a></p>`
    : html`<p class="wallet-row"><a class="google-wallet" href="${view.wallet.href}"><img src="${view.wallet.badge}" alt="${t(lang, "addToGoogleWallet")}" width="199" height="55"></a></p>`}
<p class="aside">${t(lang, "keepLink")}</p>
${view.feedbackHref === undefined
  ? null
  : html`<section aria-labelledby="feedback-title" class="card">
<h2 id="feedback-title">${t(lang, "cardFeedbackTitle")}</h2>
<p><a href="${view.feedbackHref}">${t(lang, "cardFeedbackLink")}</a></p>
</section>`}
<section aria-labelledby="email-title" class="card">
<h2 id="email-title">${t(lang, "emailTitle")}</h2>
<p>${t(lang, "emailText")}</p>
<form method="post" action="${view.path}/email" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label for="email">${t(lang, "emailLabel")}</label>
<input id="email" name="email" type="email" autocomplete="email" dir="ltr" value="${view.email ?? ""}" aria-describedby="email-hint${errors.email === undefined ? "" : " email-error"}"${errors.email === undefined ? "" : html` aria-invalid="true"`}>
<p id="email-hint" class="hint">${t(lang, "emailRemoveHint")}</p>
${errorBlock(errors.email, "email-error")}
<button type="submit">${t(lang, "emailSave")}</button>
</form>
</section>
<section aria-labelledby="offers-title" class="card">
<h2 id="offers-title">${t(lang, "offersTitle")}</h2>
<form method="post" action="${view.path}/offers">
<input type="hidden" name="lang" value="${lang}">
<label class="check"><input type="checkbox" name="offers" value="yes"${view.offersOptedIn ? html` checked` : ""}> ${t(lang, "offersLabel", { cafe: view.cafeName })}</label>
<button type="submit">${t(lang, "offersSave")}</button>
</form>
</section>
<section aria-labelledby="delete-title" class="card">
<h2 id="delete-title">${t(lang, "deleteTitle")}</h2>
<p id="delete-text">${t(lang, "deleteText")}</p>
<form method="post" action="${view.path}/delete" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label class="check"><input type="checkbox" name="confirm" value="yes" aria-describedby="delete-text${errors.delete === undefined ? "" : " delete-error"}"> ${t(lang, "deleteConfirm")}</label>
${errorBlock(errors.delete, "delete-error")}
<button type="submit" class="danger">${t(lang, "deleteButton")}</button>
</form>
</section>`,
    view.otherLangHref,
  );
}

/** Card recovery by email: the form, and once sent, the same answer whether or not a card uses it (AC 8). */
export function recoverView(lang: Lang, sent: boolean, error: string | undefined, otherLangHref: string): string {
  return page(
    lang,
    t(lang, "recoverTitle"),
    html`<div class="card">
<h1>${t(lang, "recoverTitle")}</h1>
${sent ? html`<p class="notice" role="status">${t(lang, "recoverSent")}</p>` : null}
<p>${t(lang, "recoverText")}</p>
<form method="post" action="/recover" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label for="email">${t(lang, "emailLabel")}</label>
<input id="email" name="email" type="email" autocomplete="email" dir="ltr" required${error === undefined ? "" : html` aria-invalid="true" aria-describedby="email-error"`}>
${errorBlock(error, "email-error")}
<button type="submit">${t(lang, "recoverButton")}</button>
</form>
</div>`,
    otherLangHref,
  );
}

/** The recovery link's page: buttons, so a mail scanner fetching the link cannot use it up (AC 8, 9). */
export function restoreView(lang: Lang, path: string, otherLangHref: string): string {
  return page(
    lang,
    t(lang, "restoreTitle"),
    html`<div class="card">
<h1>${t(lang, "restoreTitle")}</h1>
<p>${t(lang, "restoreText")}</p>
<form method="post" action="${path}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="action" value="restore"><button type="submit">${t(lang, "restoreButton")}</button></form>
</div>
<div class="card">
<p>${t(lang, "restoreDeleteText")}</p>
<form method="post" action="${path}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="action" value="delete"><button type="submit" class="danger">${t(lang, "restoreDeleteButton")}</button></form>
</div>`,
    otherLangHref,
  );
}

/** The restored cards' new links: the only place they appear, so the page has no language switch. */
export function restoredView(lang: Lang, cards: readonly { href: string; label: string }[]): string {
  return page(
    lang,
    t(lang, "restoredTitle"),
    html`<div class="card">
<h1>${t(lang, "restoredTitle")}</h1>
<p>${t(lang, "restoredText")}</p>
<ul class="card-links">${cards.map((card) => html`<li><a href="${card.href}"><bdi>${card.label}</bdi></a></li>`)}</ul>
</div>`,
    null,
  );
}

/** After a card (or every card of an email) is deleted (AC 9). */
export function deletedView(lang: Lang, otherLangHref: string): string {
  return page(lang, t(lang, "deletedTitle"), html`<div class="card"><h1>${t(lang, "deletedTitle")}</h1><p role="status">${t(lang, "deletedText")}</p></div>`, otherLangHref);
}

/** An error page: the message as its heading. */
export function errorView(lang: Lang, message: string, otherLangHref: string): string {
  return page(lang, t(lang, "siteTitle"), html`<div class="card"><h1 role="alert">${message}</h1></div>`, otherLangHref);
}

export interface FeedbackView {
  path: string;
  cafeName: string;
  /** The café's Google review link, or null for none. */
  reviewUrl: string | null;
  /** The form, the thanks after sending, or a request already answered. */
  state: "form" | "sent" | "done";
  message: string;
  error: string | undefined;
  otherLangHref: string;
}

/**
 * A visit's feedback page (AC 37): a private message to the owner and the café's Google review link, both offered to
 * every customer. No rating is asked, so nothing decides who sees the review link (no review gating).
 */
export function feedbackView(lang: Lang, view: FeedbackView): string {
  const { error } = view;
  const review =
    view.reviewUrl === null
      ? null
      : html`<section aria-labelledby="review-title" class="card">
<h2 id="review-title">${t(lang, "reviewTitle", { cafe: view.cafeName })}</h2>
<p>${t(lang, "reviewText")}</p>
<p class="wallet-row"><a class="wallet" href="${view.reviewUrl}" rel="noreferrer">${t(lang, "reviewButton")}</a></p>
</section>`;
  const body =
    view.state === "form"
      ? html`<form method="post" action="${view.path}" novalidate class="card">
<h1>${t(lang, "feedbackTitle", { cafe: view.cafeName })}</h1>
<p>${t(lang, "feedbackText")}</p>
<input type="hidden" name="lang" value="${lang}">
<label for="message">${t(lang, "feedbackLabel")}</label>
<textarea id="message" name="message" rows="6" maxlength="2000" required aria-describedby="message-hint${error === undefined ? "" : " message-error"}"${error === undefined ? "" : html` aria-invalid="true"`}>${view.message}</textarea>
<p id="message-hint" class="hint">${t(lang, "feedbackHint")}</p>
${errorBlock(error, "message-error")}
<button type="submit">${t(lang, "feedbackSend")}</button>
</form>`
      : html`<div class="card">
<h1>${t(lang, "feedbackTitle", { cafe: view.cafeName })}</h1>
<p class="notice" role="status">${t(lang, view.state === "sent" ? "feedbackSent" : "feedbackDone")}</p>
</div>`;
  return page(lang, t(lang, "feedbackTitle", { cafe: view.cafeName }), html`${body}
${review}`, view.otherLangHref);
}
