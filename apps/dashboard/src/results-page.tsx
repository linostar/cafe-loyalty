import { RESULTS_WINDOW_DAYS, formatUsd, resultsReportSchema, type OfferResult } from "@cafe-loyalty/shared";
import { dateFormat, useLang, useT } from "./i18n.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  "First month": "الشهر الأول",
  "Your first month starts with the first visit recorded with a loyalty card. Its results show here, and fill in over the {days} days after it.":
    "يبدأ شهرك الأول بأول زيارة تُسجَّل ببطاقة ولاء. تظهر نتائجه هنا، وتكتمل خلال الأيام الـ{days} التي تليها.",
  "Your first {days} days, from {from} to {to}. Member visits only: visits recorded with a loyalty card.":
    "أيامك الـ{days} الأولى، من {from} إلى {to}. زيارات الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء.",
  "So far in your first {days} days, from {from} to {to}, still running. Member visits only: visits recorded with a loyalty card.":
    "حتى الآن من أيامك الـ{days} الأولى، من {from} إلى {to}، ولا تزال جارية. زيارات الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء.",
  "Member visits": "زيارات الأعضاء",
  "Customers won back: regulars who had stayed away and came back": "الزبائن المسترجَعون: زبائن دائمون غابوا ثم عادوا",
  "Quiet-hour visits with a campaign discount": "زيارات ساعات الهدوء بخصم حملة",
  "Rewards redeemed": "المكافآت المستبدلة",
  "Offer cost against offer revenue": "كلفة العروض مقابل إيراداتها",
  "What each kind of offer gave away in discounts, against what the visits that used it paid.": "ما قدّمه كل نوع من العروض من خصومات، مقابل ما دفعته الزيارات التي استخدمته.",
  "Offers in the first month": "العروض في الشهر الأول",
  Offer: "العرض",
  Visits: "الزيارات",
  "Cost (discounts)": "الكلفة (الخصومات)",
  Revenue: "الإيرادات",
  "Win-back offers": "عروض الاسترجاع",
  "Quiet-hour campaigns": "حملات ساعات الهدوء",
} as const;

function OfferRow({ name, offer }: { name: string; offer: OfferResult }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{offer.visits}</td>
      <td>{formatUsd(offer.costCents, "en")}</td>
      <td>{formatUsd(offer.revenueCents, "en")}</td>
    </tr>
  );
}

/** `/results`: the first-month results report (AC 38), from the café's first member visit. */
export function ResultsPage() {
  const t = useT(AR);
  const lang = useLang();
  const [state, , retry] = useApiData("/api/results", resultsReportSchema);
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const report = state.data;
  const { window } = report;
  const dayFormat = dateFormat(lang, { dateStyle: "medium" });
  return (
    <section aria-labelledby="results-page-title">
      <h2 id="results-page-title">{t("First month")}</h2>
      {window === null ? (
        <p className="page-intro">
          {t("Your first month starts with the first visit recorded with a loyalty card. Its results show here, and fill in over the {days} days after it.", {
            days: RESULTS_WINDOW_DAYS,
          })}
        </p>
      ) : (
        <p className="page-intro">
          {t(
            window.complete
              ? "Your first {days} days, from {from} to {to}. Member visits only: visits recorded with a loyalty card."
              : "So far in your first {days} days, from {from} to {to}, still running. Member visits only: visits recorded with a loyalty card.",
            { days: RESULTS_WINDOW_DAYS, from: dayFormat.format(new Date(window.from)), to: dayFormat.format(new Date(new Date(window.to).getTime() - 1)) },
          )}
        </p>
      )}
      <ul className="stats">
        <li>
          <p className="stat-value">{report.memberVisits}</p>
          <p>{t("Member visits")}</p>
        </li>
        <li>
          <p className="stat-value">{report.customersWonBack}</p>
          <p>{t("Customers won back: regulars who had stayed away and came back")}</p>
        </li>
        <li>
          <p className="stat-value">{report.quietHourVisits}</p>
          <p>{t("Quiet-hour visits with a campaign discount")}</p>
        </li>
        <li>
          <p className="stat-value">{report.rewardRedemptions}</p>
          <p>{t("Rewards redeemed")}</p>
        </li>
      </ul>
      <section aria-labelledby="offers-title" className="card">
        <h3 id="offers-title">{t("Offer cost against offer revenue")}</h3>
        <p className="hint">{t("What each kind of offer gave away in discounts, against what the visits that used it paid.")}</p>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">{t("Offers in the first month")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("Offer")}</th>
                <th scope="col">{t("Visits")}</th>
                <th scope="col">{t("Cost (discounts)")}</th>
                <th scope="col">{t("Revenue")}</th>
              </tr>
            </thead>
            <tbody>
              <OfferRow name={t("Win-back offers")} offer={report.offers.winBack} />
              <OfferRow name={t("Quiet-hour campaigns")} offer={report.offers.quietHour} />
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
