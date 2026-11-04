import type { CustomerView } from "@skail-subscription-cycle/contracts";

export function overallLabel(customer: CustomerView | undefined): string {
  if (!customer) return "Idle";
  switch (customer.phase) {
    case "Starting":
      return "Starting…";
    case "Subscribed":
      return customer.cancelRequested ? "Cancelling…" : "Subscribed";
    case "Declined":
      return "Payment declined, retrying";
    default:
      return customer.phase;
  }
}

export function badgeClass(customer: CustomerView | undefined): string {
  if (!customer) return "idle";
  if (customer.phase === "Suspended" || customer.phase === "Failed") return "failed";
  if (customer.phase === "Ended" || customer.phase === "Cancelled" || customer.phase === "Expired") return "done";
  return customer.phase === "Declined" ? "warn" : "active";
}

export function StatusBadge({ customer }: { customer: CustomerView | undefined }) {
  return <span className={`badge ${badgeClass(customer)}`}>{overallLabel(customer)}</span>;
}
