import type { CustomerView, CycleResult } from "@skail-subscription-cycle/contracts";

const money = (v: number) => `R$ ${Number(v).toFixed(2)}`;

function resultText(r: CycleResult): string {
  const paid = `${r.monthsPaid} month(s) paid, ${money(r.totalCharged)}`;
  switch (r.end) {
    case "Ended":
      return "Trial ended without a subscription · nothing was charged";
    case "Cancelled":
      return `Cancelled · ${paid} · no further charge`;
    case "Suspended":
      return `Suspended at month ${r.month}: ${r.reason} · ${paid}`;
    default:
      return `Reached the month limit · ${paid}`;
  }
}

export function ResultBanner({ customer }: { customer: CustomerView }) {
  const r = customer.result;
  if (!r) return null;
  const bad = customer.phase === "Suspended" || customer.phase === "Failed";
  return (
    <section role="status" aria-label="Result" className={`result ${bad ? "bad" : "ok"}`}>
      {resultText(r)}
    </section>
  );
}
