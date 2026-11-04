import { Skail, SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  CustomerEvent,
  CycleLimits,
  Events,
  isCancellation,
  isSubscription,
  type Subscription,
  type Cancellation,
  type Charge,
  type CycleResult,
} from "@skail-subscription-cycle/contracts";
import type { SubscriptionOperations } from "./subscription-operations.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The method names are PascalCase on purpose: the skail route is <workload>/<method>, and the web app triggers
// <workload>/ManageSubscription.
export class SubscriptionFunctions {
  constructor(private readonly operations: SubscriptionOperations) {}

  /**
   * The whole life of a subscription in one function: the trial, which ends at the deadline or when the customer
   * subscribes, then one charge per month, with one retry of a declined charge, until a cancellation, a suspension
   * or the month limit. The durations are arguments and the decisions come only from recorded events, so a replay
   * takes the same path.
   */
  @SkailFunction()
  async ManageSubscription(customerId: string, trialSeconds: number, monthSeconds: number): Promise<CycleResult> {
    try {
      await this.StartTrial(customerId);

      // Both waits are created before the whenAny, without await.
      const trialDeadline = Skail.delaySeconds(trialSeconds);
      const subscription = Skail.waitForEvent<Subscription>(Events.customerSubscribed, customerId);

      // whenAny returns the value of the winner: undefined for the delay, the payload for the event.
      const winner = await Skail.whenAny([trialDeadline, subscription]);
      if (!isSubscription(winner)) return await this.EndTrial(customerId);

      const plan = winner.plan;
      await this.StartSubscription(customerId, plan);

      // One wait for the cancellation, created before the loop and reused by every month.
      const cancellation = Skail.waitForEvent<Cancellation>(Events.subscriptionCancelled, customerId);

      for (let month = 1; month <= CycleLimits.maxMonths; month++) {
        let charge = await this.ChargeMonthlyFee(customerId, plan, month, 1);
        if (!charge.approved) {
          await this.NotifyPaymentDeclined(customerId, month, charge.reason ?? "");
          await Skail.delaySeconds(CycleLimits.retrySeconds);
          charge = await this.ChargeMonthlyFee(customerId, plan, month, 2);
        }

        if (!charge.approved) return await this.SuspendSubscription(customerId, plan, month, charge.reason ?? "");

        const next = await Skail.whenAny([cancellation, Skail.delaySeconds(monthSeconds)]);
        if (isCancellation(next)) return await this.CancelSubscription(customerId, plan, month);
      }

      return await this.EndCycle(customerId, plan, CycleLimits.maxMonths);
    } catch (error) {
      if (!(error instanceof SkailNonDeterministicError))
        await this.ReportStatus(CustomerEvent.failed(customerId, errorMessage(error)));
      throw error;
    }
  }

  // The commands only delegate to SubscriptionOperations, so their logic is tested without skail.

  @SkailCommand({ retryCount: 3 })
  async StartTrial(customerId: string): Promise<void> {
    await this.operations.startTrial(customerId);
  }

  @SkailCommand({ retryCount: 3 })
  async EndTrial(customerId: string): Promise<CycleResult> {
    return this.operations.endTrial(customerId);
  }

  @SkailCommand({ retryCount: 3 })
  async StartSubscription(customerId: string, plan: string): Promise<void> {
    await this.operations.startSubscription(customerId, plan);
  }

  /** Idempotent by customer, month and attempt: a technical retry gets the same answer from the card network. */
  @SkailCommand({ retryCount: 3 })
  async ChargeMonthlyFee(customerId: string, plan: string, month: number, attempt: number): Promise<Charge> {
    return this.operations.charge(customerId, plan, month, attempt);
  }

  @SkailCommand({ retryCount: 3 })
  async NotifyPaymentDeclined(customerId: string, month: number, reason: string): Promise<void> {
    await this.operations.notifyPaymentDeclined(customerId, month, reason);
  }

  @SkailCommand({ retryCount: 3 })
  async SuspendSubscription(customerId: string, plan: string, month: number, reason: string): Promise<CycleResult> {
    return this.operations.suspend(customerId, plan, month, reason);
  }

  @SkailCommand({ retryCount: 3 })
  async CancelSubscription(customerId: string, plan: string, lastPaidMonth: number): Promise<CycleResult> {
    return this.operations.cancel(customerId, plan, lastPaidMonth);
  }

  @SkailCommand({ retryCount: 3 })
  async EndCycle(customerId: string, plan: string, months: number): Promise<CycleResult> {
    return this.operations.endCycle(customerId, plan, months);
  }

  /** Idempotent: the web app ignores a repeated event (same customer and stage). */
  @SkailCommand({ retryCount: 3 })
  async ReportStatus(evt: CustomerEvent): Promise<void> {
    await this.operations.reportStatus(evt);
  }
}
