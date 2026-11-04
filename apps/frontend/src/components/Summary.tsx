import type { CustomerView } from "@skail-subscription-cycle/contracts";

export function Summary({ customer }: { customer: CustomerView | undefined }) {
  return (
    <section className="summary" aria-label="Summary">
      <div>
        Plan <strong>{customer?.plan ?? "-"}</strong>
      </div>
      <div>
        Month <strong>{customer?.month ? customer.month : "-"}</strong>
      </div>
      <div>
        Total charged <strong>{customer ? `R$ ${customer.totalCharged.toFixed(2)}` : "-"}</strong>
      </div>
    </section>
  );
}
