import { CustomerEvent, CycleResult, type Charge } from "@skail-subscription-cycle/contracts";
import type { Billing, ProgressNotifier } from "./web.js";

/**
 * The I/O behind the commands, as plain async methods. The command wrappers only delegate here, so the
 * logic is unit tested without the skail runtime. The web app plays the card network and the page: if a call
 * cannot be delivered the method throws and skail retries the command.
 */
export class SubscriptionOperations {
  constructor(
    private readonly notifier: ProgressNotifier,
    private readonly billing: Billing,
  ) {}

  async startTrial(customerId: string): Promise<void> {
    await this.notifier.notify(CustomerEvent.trialStarted(customerId));
  }

  /** Idempotent: the result derives from the arguments, and the web app ignores a repeated stage. */
  async endTrial(customerId: string): Promise<CycleResult> {
    const result = CycleResult.ended(customerId);
    await this.notifier.notify(CustomerEvent.trialEnded(customerId, result));
    return result;
  }

  async startSubscription(customerId: string, plan: string): Promise<void> {
    await this.notifier.notify(CustomerEvent.subscribed(customerId, plan));
  }

  /** Idempotent by customer, month and attempt: the card network gives the same answer to a retry. */
  charge(customerId: string, plan: string, month: number, attempt: number): Promise<Charge> {
    return this.billing.charge(customerId, plan, month, attempt);
  }

  async notifyPaymentDeclined(customerId: string, month: number, reason: string): Promise<void> {
    await this.notifier.notify(CustomerEvent.retrying(customerId, month, reason));
  }

  async suspend(customerId: string, plan: string, month: number, reason: string): Promise<CycleResult> {
    const result = CycleResult.suspended(customerId, plan, month, reason);
    await this.notifier.notify(CustomerEvent.suspended(customerId, result));
    return result;
  }

  async cancel(customerId: string, plan: string, lastPaidMonth: number): Promise<CycleResult> {
    const result = CycleResult.cancelled(customerId, plan, lastPaidMonth);
    await this.notifier.notify(CustomerEvent.cancelled(customerId, result));
    return result;
  }

  async endCycle(customerId: string, plan: string, months: number): Promise<CycleResult> {
    const result = CycleResult.expired(customerId, plan, months);
    await this.notifier.notify(CustomerEvent.expired(customerId, result));
    return result;
  }

  reportStatus(evt: CustomerEvent): Promise<void> {
    return this.notifier.notify(evt);
  }
}
