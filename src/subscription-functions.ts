import { Skail, SkailCommand, SkailFunction } from "@skail/runtime";
import {
  Events,
  isApproved,
  isEvent,
  price,
  type Cancellation,
  type Charge,
  type Subscription,
} from "./model.js";

const MAX_MONTHS = 12;
const RETRY_SECONDS = 5;

// Method names are PascalCase on purpose: the skail address is <workload>/<method>, and the trigger calls
// <workload>/ManageSubscription.
export class SubscriptionFunctions {
  /**
   * The whole life of a subscription: the trial, which ends at the deadline or when the customer subscribes, then one
   * charge per month, with one retry of a declined charge, until a cancellation, a suspension or 12 months. The
   * durations are arguments, so the same code serves the demo (seconds) and a real subscription (30 days, a month).
   * The name and the parameters are the trigger contract: ["{customerId}", {trialSeconds}, {monthSeconds}].
   */
  @SkailFunction()
  async ManageSubscription(customerId: string, trialSeconds: number, monthSeconds: number): Promise<string> {
    await this.StartTrial(customerId, trialSeconds);

    // whenAny returns the value of the winner: the subscription, or undefined when the trial deadline wins
    const subscription = Skail.waitForEvent<Subscription>(Events.customerSubscribed, customerId);
    const subscribed = await Skail.whenAny([Skail.delaySeconds(trialSeconds), subscription]);
    if (!isEvent<Subscription>(subscribed)) return this.EndTrial(customerId);

    const plan = subscribed.plan;
    await this.StartSubscription(customerId, plan);

    // one wait for the cancellation, created before the loop and reused every month
    const cancellation = Skail.waitForEvent<Cancellation>(Events.subscriptionCancelled, customerId);

    for (let month = 1; month <= MAX_MONTHS; month++) {
      let charge = await this.ChargeMonthlyFee(customerId, plan, month, 1);
      if (!charge.approved) {
        await this.NotifyPaymentDeclined(customerId, month, charge.reason!);
        await Skail.delaySeconds(RETRY_SECONDS);
        charge = await this.ChargeMonthlyFee(customerId, plan, month, 2);
      }
      if (!charge.approved) return this.SuspendSubscription(customerId, month);

      const winner = await Skail.whenAny([cancellation, Skail.delaySeconds(monthSeconds)]);
      if (isEvent<Cancellation>(winner)) return this.CancelSubscription(customerId, month);
    }

    return this.EndCycle(customerId, MAX_MONTHS);
  }

  // The commands are the I/O: the charge asks the simulated card network, the others report what would happen, to the
  // console and to the page.
  // A completed command never runs again, so a replay does not charge twice nor print the same line twice.

  @SkailCommand({ retryCount: 3 })
  async StartTrial(customerId: string, trialSeconds: number): Promise<void> {
    await report(customerId, `trial started: ${trialSeconds} s to subscribe`, "trial:started");
  }

  @SkailCommand({ retryCount: 3 })
  async EndTrial(customerId: string): Promise<string> {
    await report(customerId, "trial ended without a subscription: nothing was charged", "end:trial-ended");
    return "trial ended";
  }

  @SkailCommand({ retryCount: 3 })
  async StartSubscription(customerId: string, plan: string): Promise<void> {
    await report(customerId, `subscribed to the ${plan} plan, ${money(price(plan))} a month`, `subscribed:${plan}`);
  }

  /**
   * The card network answers by the card and the attempt, so a retry of the command gets the same answer and the month
   * is not charged twice. The card on file is asked to the app here, by customer id: it never enters the run history.
   * A decline is a result: another attempt in the same second would get the same answer.
   */
  @SkailCommand({ retryCount: 3 })
  async ChargeMonthlyFee(customerId: string, plan: string, month: number, attempt: number): Promise<Charge> {
    const card = await cardOnFile(customerId);
    const charge: Charge = isApproved(card, attempt)
      ? { approved: true, reason: null, amount: price(plan) }
      : { approved: false, reason: "card declined by the issuer", amount: price(plan) };
    const retry = attempt > 1 ? ` (attempt ${attempt})` : "";
    await report(
      customerId,
      charge.approved
        ? `month ${month}: ${money(charge.amount)} charged${retry}`
        : `month ${month}: charge declined${retry}, ${charge.reason}`,
      charge.approved ? `charged:${month}` : `declined:${month}`,
    );
    return charge;
  }

  @SkailCommand({ retryCount: 3 })
  async NotifyPaymentDeclined(customerId: string, month: number, reason: string): Promise<void> {
    await report(
      customerId,
      `customer warned: month ${month} was declined (${reason}), new attempt in ${RETRY_SECONDS} s`,
      `warned:${month}`,
    );
  }

  @SkailCommand({ retryCount: 3 })
  async SuspendSubscription(customerId: string, month: number): Promise<string> {
    await report(customerId, `suspended: month ${month} was declined twice`, "end:suspended");
    return "suspended";
  }

  @SkailCommand({ retryCount: 3 })
  async CancelSubscription(customerId: string, lastPaidMonth: number): Promise<string> {
    await report(customerId, `cancelled: no more charges; months 1 to ${lastPaidMonth} stay paid`, "end:cancelled");
    return "cancelled";
  }

  @SkailCommand({ retryCount: 3 })
  async EndCycle(customerId: string, months: number): Promise<string> {
    await report(customerId, `cycle ended: ${months} months paid`, "end:cycle-ended");
    return "cycle ended";
  }
}

// Commands run in an isolated VM, so they reach the app over HTTP on a local port, whose address is in DEMO_INTERNAL_URL.

/** Reports a step to the app, which prints it and shows it on the page. */
async function report(customerId: string, text: string, step: string): Promise<void> {
  const response = await fetch(`${process.env.DEMO_INTERNAL_URL}/internal/timeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: customerId, text, step }),
  });
  if (!response.ok) throw new Error(`the app answered ${response.status} to the timeline`);
}

/** The card the customer chose, kept by the app like a payment gateway keeps the card on file. */
async function cardOnFile(customerId: string): Promise<string> {
  const response = await fetch(`${process.env.DEMO_INTERNAL_URL}/internal/cards/${encodeURIComponent(customerId)}`);
  if (!response.ok) throw new Error(`the app answered ${response.status} to the card on file`);
  return ((await response.json()) as { card: string }).card;
}

function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
