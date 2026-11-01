import { formatUsd, resultsReportSchema, type Lang, type OfferResult, type ResultsReport } from "@cafe-loyalty/shared";
import { useId, useState } from "react";
import { Notice } from "./forms.js";
import { dateFormat, useLang, useT } from "./i18n.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  Results: "النتائج",
  Month: "الشهر",
  "{month} (so far)": "{month} (حتى الآن)",
  "{month} so far, still running. Member visits only: visits recorded with a loyalty card, counted in café time.":
    "{month} حتى الآن، ولا يزال جارياً. زيارات الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء، بتوقيت المقهى.",
  "All of {month}. Member visits only: visits recorded with a loyalty card, counted in café time.":
    "كامل {month}. زيارات الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء، بتوقيت المقهى.",
  "Showing {month}.": "تُعرض نتائج {month}.",
  "Member visits": "زيارات الأعضاء",
  "Customers won back: regulars who had stayed away and came back": "الزبائن المسترجَعون: زبائن دائمون غابوا ثم عادوا",
  "Quiet-hour visits with a campaign discount": "زيارات ساعات الهدوء بخصم حملة",
  "Rewards redeemed": "المكافآت المستبدلة",
  "Offer cost against offer revenue": "كلفة العروض مقابل إيراداتها",
  "What each kind of offer gave away in discounts, against what the visits that used it paid.": "ما قدّمه كل نوع من العروض من خصومات، مقابل ما دفعته الزيارات التي استخدمته.",
  "Offers in {month}": "العروض في {month}",
  Offer: "العرض",
  Visits: "الزيارات",
  "Cost (discounts)": "الكلفة (الخصومات)",
  Revenue: "الإيرادات",
  "Welcome-back offers": "عروض العودة",
  "Quiet-hour campaigns": "حملات ساعات الهدوء",
} as const;

/** A `YYYY-MM` month as its name and year, such as "October 2026". */
function monthName(lang: Lang, month: string): string {
  return dateFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

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

/**
 * `/results`: the results report (AC 38) of one calendar month in café time, the current one first, picked from the
 * months since the café's first member visit. While another month loads, or when it fails, the picker stays (focus
 * with it) and the status region says so; the month shown is announced once loaded.
 */
export function ResultsPage() {
  const t = useT(AR);
  const lang = useLang();
  const pickerId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [state, , retry] = useApiData(chosen === null ? "/api/results" : `/api/results?month=${chosen}`, resultsReportSchema);
  // The last report loaded, whose months the picker keeps while another month loads or fails (set during this render).
  const [lastLoaded, setLastLoaded] = useState<ResultsReport | null>(null);
  if (state.status === "loaded" && state.data !== lastLoaded) {
    setLastLoaded(state.data);
  }
  const listed = state.status === "loaded" ? state.data : lastLoaded;
  if (listed === null) {
    return <PageStatus state={state} onRetry={retry} />;
  }
  // The chosen month's report; until it loads, the last one is another month's.
  const report = state.status === "loaded" && (chosen === null || state.data.month === chosen) ? state.data : null;
  const month = report === null ? "" : monthName(lang, report.month);
  return (
    <section aria-labelledby="results-page-title">
      <h2 id="results-page-title">{t("Results")}</h2>
      <div className="field page-narrow">
        <label htmlFor={pickerId}>{t("Month")}</label>
        <select
          id={pickerId}
          value={chosen ?? listed.month}
          onChange={(event) => {
            setChosen(event.target.value);
          }}
        >
          {listed.months.map((listedMonth, index) => (
            <option key={listedMonth} value={listedMonth}>
              {/* The first month listed is the current one, still running. */}
              {index === 0 ? t("{month} (so far)", { month: monthName(lang, listedMonth) }) : monthName(lang, listedMonth)}
            </option>
          ))}
        </select>
      </div>
      <Notice>{state.status === "loaded" ? (report === null ? t("Loading…") : chosen === null ? null : t("Showing {month}.", { month })) : null}</Notice>
      {state.status === "failed" ? (
        <PageStatus state={state} onRetry={retry} />
      ) : report === null ? null : (
        <>
          <p className="page-intro">
            {t(
              report.current
                ? "{month} so far, still running. Member visits only: visits recorded with a loyalty card, counted in café time."
                : "All of {month}. Member visits only: visits recorded with a loyalty card, counted in café time.",
              { month },
            )}
          </p>
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
                <caption className="visually-hidden">{t("Offers in {month}", { month })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("Offer")}</th>
                    <th scope="col">{t("Visits")}</th>
                    <th scope="col">{t("Cost (discounts)")}</th>
                    <th scope="col">{t("Revenue")}</th>
                  </tr>
                </thead>
                <tbody>
                  <OfferRow name={t("Welcome-back offers")} offer={report.offers.winBack} />
                  <OfferRow name={t("Quiet-hour campaigns")} offer={report.offers.quietHour} />
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
