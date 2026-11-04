import { useEffect, useState } from "react";
import type { CustomerView } from "@skail-subscription-cycle/contracts";

/** Visual countdown only: the real wait is the durable delay inside the skail function. */
export function Countdown({ customer }: { customer: CustomerView | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!customer || customer.phase !== "Trial" || !customer.trialStartedAt) return null;
  const left = Math.max(0, customer.trialSeconds - (now - new Date(customer.trialStartedAt).getTime()) / 1000);
  return <span className="countdown">trial ends in {Math.ceil(left)}s</span>;
}
