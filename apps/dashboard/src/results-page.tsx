import { RESULTS_WINDOW_DAYS, formatUsd, resultsReportSchema, type OfferResult } from "@cafe-loyalty/shared";
import { PageStatus, useApiData } from "./session.js";

const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

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
  const [state] = useApiData("/api/results", resultsReportSchema);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const report = state.data;
  const { window } = report;
  return (
    <section aria-labelledby="results-page-title">
      <h2 id="results-page-title">First month</h2>
      {window === null ? (
        <p className="page-intro">
          Your first month starts with the first visit recorded with a loyalty card. Its results show here, and fill in over the {RESULTS_WINDOW_DAYS} days after
          it.
        </p>
      ) : (
        <p className="page-intro">
          {window.complete ? "Your first" : "So far in your first"} {RESULTS_WINDOW_DAYS} days, from {dayFormat.format(new Date(window.from))} to{" "}
          {dayFormat.format(new Date(new Date(window.to).getTime() - 1))}
          {window.complete ? "." : ", still running."} Member visits only: visits recorded with a loyalty card.
        </p>
      )}
      <ul className="stats">
        <li>
          <p className="stat-value">{report.memberVisits}</p>
          <p>Member visits</p>
        </li>
        <li>
          <p className="stat-value">{report.customersWonBack}</p>
          <p>Customers won back: regulars who had stayed away and came back</p>
        </li>
        <li>
          <p className="stat-value">{report.quietHourVisits}</p>
          <p>Quiet-hour visits with a campaign discount</p>
        </li>
        <li>
          <p className="stat-value">{report.rewardRedemptions}</p>
          <p>Rewards redeemed</p>
        </li>
      </ul>
      <section aria-labelledby="offers-title" className="card">
        <h3 id="offers-title">Offer cost against offer revenue</h3>
        <p className="hint">What each kind of offer gave away in discounts, against what the visits that used it paid.</p>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Offers in the first month</caption>
            <thead>
              <tr>
                <th scope="col">Offer</th>
                <th scope="col">Visits</th>
                <th scope="col">Cost (discounts)</th>
                <th scope="col">Revenue</th>
              </tr>
            </thead>
            <tbody>
              <OfferRow name="Win-back offers" offer={report.offers.winBack} />
              <OfferRow name="Quiet-hour campaigns" offer={report.offers.quietHour} />
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
