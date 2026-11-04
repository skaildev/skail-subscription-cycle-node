import {
  CycleLimits,
  Plans,
  chargeFor,
  isTerminalPhase,
  type Subscription,
  type Cancellation,
  type Charge,
  type CustomerEvent,
  type CustomerPhase,
  type CustomerState,
  type CycleResult,
} from "@skail-subscription-cycle/contracts";

export type ActionOutcome = "Accepted" | "Conflict" | "NotFound";

export interface NewCustomer {
  name: string;
  plan: string;
  card: string;
  trialSeconds: number;
  monthSeconds: number;
}

interface Subscriber {
  onState: (state: CustomerState) => void;
  onClose: () => void;
}

/**
 * In-memory state of the customers. The durable state lives in skail; this is the UI view, the "one subscribe
 * and one cancel" guard, and the simulated card network. Clicks are registered here before the fire, and the
 * final result comes from the worker.
 */
export class CustomerStore {
  readonly #customers = new Map<string, CustomerState>();
  readonly #charges = new Map<string, Map<string, Charge>>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(customerId: string, input: NewCustomer): CustomerState {
    const customer: CustomerState = {
      customerId,
      ...input,
      phase: "Starting",
      month: 0,
      totalCharged: 0,
      subscribeRequested: false,
      cancelRequested: false,
      trialStartedAt: null,
      timeline: [],
      result: null,
      error: null,
    };
    this.#customers.set(customerId, customer);
    return customer;
  }

  get(customerId: string): CustomerState | undefined {
    return this.#customers.get(customerId);
  }

  remove(customerId: string): void {
    this.#customers.delete(customerId);
    this.#charges.delete(customerId);
    this.#close(customerId);
  }

  /** The first subscription wins, and only during the trial; anything else is refused so no second event is fired. */
  trySubscribe(customerId: string, a: Subscription): ActionOutcome {
    const c = this.#customers.get(customerId);
    if (!c) return "NotFound";
    if (c.phase !== "Trial" || c.subscribeRequested) return "Conflict";
    this.#publish(
      this.#add(
        { ...c, subscribeRequested: true },
        "SubscribeRequested",
        null,
        null,
        `Subscription requested: plan ${a.plan}`,
      ),
    );
    return "Accepted";
  }

  /** Undoes trySubscribe when the fire failed, so the same click can be repeated. */
  releaseSubscribe(customerId: string): void {
    const c = this.#customers.get(customerId);
    if (!c || !c.subscribeRequested || c.phase !== "Trial") return;
    this.#publish({ ...c, subscribeRequested: false, timeline: this.#without(c, "SubscribeRequested") });
  }

  /** A cancellation is valid with an active subscription (also while a declined charge waits for the retry). */
  tryCancel(customerId: string, a: Cancellation): ActionOutcome {
    const c = this.#customers.get(customerId);
    if (!c) return "NotFound";
    if ((c.phase !== "Subscribed" && c.phase !== "Declined") || c.cancelRequested) return "Conflict";
    const reason = a.reason?.trim() ? `: ${a.reason}` : "";
    this.#publish(
      this.#add({ ...c, cancelRequested: true }, "CancelRequested", null, null, `Cancellation requested${reason}`),
    );
    return "Accepted";
  }

  releaseCancel(customerId: string): void {
    const c = this.#customers.get(customerId);
    if (!c || !c.cancelRequested || isTerminalPhase(c.phase)) return;
    this.#publish({ ...c, cancelRequested: false, timeline: this.#without(c, "CancelRequested") });
  }

  /**
   * The simulated card network. Each month and attempt is charged once: a technical retry of the command gets
   * the recorded Charge and is not counted twice. Undefined for an unknown customer.
   */
  charge(customerId: string, plan: string, month: number, attempt: number): Charge | undefined {
    const c = this.#customers.get(customerId);
    if (!c) return undefined;

    const key = `${month}-${attempt}`;
    let byAttempt = this.#charges.get(customerId);
    if (!byAttempt) this.#charges.set(customerId, (byAttempt = new Map()));
    const known = byAttempt.get(key);
    if (known) return known;

    const charge = chargeFor(c.card, plan, attempt);
    byAttempt.set(key, charge);
    if (isTerminalPhase(c.phase)) return charge;

    const retry = attempt > 1 ? ` (attempt ${attempt})` : "";
    if (charge.approved) {
      const total = Math.round((c.totalCharged + charge.amount) * 100) / 100;
      this.#publish(
        this.#add(
          { ...c, phase: "Subscribed", month, totalCharged: total },
          "Charged",
          month,
          attempt,
          `Month ${month}: charged R$ ${charge.amount.toFixed(2)}${retry}`,
        ),
      );
    } else {
      this.#publish(
        this.#add(
          { ...c, phase: "Declined", month },
          "ChargeDeclined",
          month,
          attempt,
          `Month ${month}: payment declined${retry}: ${charge.reason}`,
        ),
      );
    }
    return charge;
  }

  /** @returns true when the event changed the customer; false when ignored (unknown or finished customer, duplicate). */
  apply(event: CustomerEvent): boolean {
    const c = this.#customers.get(event.customerId);
    if (!c || isTerminalPhase(c.phase)) return false;

    let next: CustomerState | null = null;
    switch (event.stage) {
      case "TrialStarted":
        if (c.phase === "Starting")
          next = this.#add(
            { ...c, phase: "Trial", trialStartedAt: this.now() },
            "TrialStarted",
            null,
            null,
            `Trial started (${c.trialSeconds}s)`,
          );
        break;
      case "Subscribed":
        if (c.phase === "Trial") {
          const plan = event.plan ?? c.plan;
          next = this.#add(
            { ...c, phase: "Subscribed", plan },
            "Subscribed",
            null,
            null,
            `Subscribed to plan ${plan} (R$ ${Plans.price(plan).toFixed(2)}/month)`,
          );
        }
        break;
      case "Retrying":
        if (!c.timeline.some((t) => t.kind === "Retrying" && t.month === event.month)) {
          next = this.#add(
            c,
            "Retrying",
            event.month ?? null,
            null,
            `Customer warned about the declined payment, retrying in ${CycleLimits.retrySeconds}s`,
          );
        }
        break;
      case "TrialEnded":
        if (event.result)
          next = this.#end(c, "Ended", event.result, "TrialEnded", "Trial ended without a subscription");
        break;
      case "Suspended":
        if (event.result)
          next = this.#end(
            c,
            "Suspended",
            event.result,
            "Suspended",
            `Subscription suspended at month ${event.result.month}: ${event.result.reason}`,
          );
        break;
      case "Cancelled":
        if (event.result)
          next = this.#end(
            c,
            "Cancelled",
            event.result,
            "Cancelled",
            `Subscription cancelled after month ${event.result.month}`,
          );
        break;
      case "Expired":
        if (event.result)
          next = this.#end(
            c,
            "Expired",
            event.result,
            "Expired",
            `Cycle ended after ${event.result.monthsPaid} months`,
          );
        break;
      case "Failed": {
        const error = event.error ?? "unknown error";
        next = this.#add({ ...c, phase: "Failed", error }, "Failed", null, null, error);
        break;
      }
    }
    if (!next) return false;
    this.#publish(next);
    return true;
  }

  /** @returns the unsubscribe function. `onClose` is called when the customer ends or is removed. */
  subscribe(customerId: string, onState: (state: CustomerState) => void, onClose: () => void): () => void {
    const subscriber: Subscriber = { onState, onClose };
    let set = this.#subscribers.get(customerId);
    if (!set) this.#subscribers.set(customerId, (set = new Set()));
    set.add(subscriber);
    return () => void this.#subscribers.get(customerId)?.delete(subscriber);
  }

  #end(c: CustomerState, phase: CustomerPhase, result: CycleResult, kind: string, text: string): CustomerState {
    return this.#add(
      { ...c, phase, result, totalCharged: result.totalCharged, month: result.month ?? c.month },
      kind,
      null,
      null,
      text,
    );
  }

  #add(c: CustomerState, kind: string, month: number | null, attempt: number | null, text: string): CustomerState {
    return { ...c, timeline: [...c.timeline, { kind, month, attempt, text, at: this.now() }] };
  }

  #without(c: CustomerState, kind: string) {
    const last = c.timeline.map((t) => t.kind === kind).lastIndexOf(true);
    return last < 0 ? c.timeline : c.timeline.filter((_, i) => i !== last);
  }

  #publish(state: CustomerState): void {
    this.#customers.set(state.customerId, state);
    for (const subscriber of [...(this.#subscribers.get(state.customerId) ?? [])]) subscriber.onState(state);
    if (isTerminalPhase(state.phase)) this.#close(state.customerId);
  }

  #close(customerId: string): void {
    const set = this.#subscribers.get(customerId);
    if (!set) return;
    this.#subscribers.delete(customerId);
    for (const subscriber of set) subscriber.onClose();
  }
}
