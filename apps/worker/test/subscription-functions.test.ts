import { beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import {
  Cards,
  CycleLimits,
  Events,
  chargeFor,
  type Subscription,
  type Cancellation,
  type Charge,
  type CustomerEvent,
  type CycleResult,
} from "@skail-subscription-cycle/contracts";
import { SubscriptionFunctions } from "../src/subscription-functions.js";
import { SubscriptionOperations } from "../src/subscription-operations.js";
import type { Billing, ProgressNotifier } from "../src/web.js";

const WORKLOAD = "subscriptioncycle:v1.0.0";
const ID = "customer-1";

const subscription = (plan = "pro"): Subscription => ({ plan, at: "2026-01-01T10:00:00.000Z" });
const cancellation = (): Cancellation => ({ reason: null, at: "2026-02-01T10:00:00.000Z" });

class Harness {
  readonly events: CustomerEvent[] = [];
  readonly charges: Array<[number, number]> = []; // [month, attempt] of every executed charge
  card: string = Cards.approved;
  failCharges = 0; // transient failures of the billing before succeeding
  alwaysFailCharge = false;
  readonly platform = new InMemorySkailPlatform();
  readonly worker: SkailWorker;

  constructor() {
    const notifier: ProgressNotifier = { notify: async (event) => void this.events.push(event) };
    const billing: Billing = {
      charge: async (_id, plan, month, attempt): Promise<Charge> => {
        if (this.alwaysFailCharge) throw new Error("billing down");
        if (this.failCharges > 0) {
          this.failCharges--;
          throw new Error("transient");
        }
        this.charges.push([month, attempt]);
        return chargeFor(this.card, plan, attempt);
      },
    };
    const providers: Provider[] = [
      {
        token: SubscriptionFunctions,
        useFactory: () => new SubscriptionFunctions(new SubscriptionOperations(notifier, billing)),
      },
    ];
    this.worker = createSkailWorker({
      workload: WORKLOAD,
      types: [SubscriptionFunctions],
      providers,
      sidecar: this.platform,
    });
  }

  start(id = ID) {
    this.platform.start(`${WORKLOAD}/ManageSubscription`, [id, 20, 10], id);
  }

  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }

  pending(eventType: EventType) {
    return this.platform.history(ID).filter((f) => f.eventType === eventType && !f.targetResult);
  }

  /** Completes the most recent pending delay (the trial delay stays orphan once the customer subscribed). */
  async elapse() {
    const delays = this.pending(EventType.Delay);
    expect(delays.length).toBeGreaterThan(0);
    this.platform.complete(ID, delays.at(-1)!.index);
    return this.run();
  }

  subscribe(plan = "pro", id = ID) {
    this.platform.signal(Events.customerSubscribed, id, subscription(plan));
  }

  cancel(id = ID) {
    this.platform.signal(Events.subscriptionCancelled, id, cancellation());
  }

  stages(stage: CustomerEvent["stage"]) {
    return this.events.filter((e) => e.stage === stage);
  }

  /** Subscribes and runs until the function hibernates on the first monthly wait. */
  async subscribedAndCharged() {
    this.start();
    await this.run();
    this.subscribe();
    return this.run();
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

const result = (outcome: Awaited<ReturnType<Harness["run"]>>) => (outcome as { result: CycleResult }).result;

describe("ManageSubscription: trial", () => {
  it("notifies TrialStarted and hibernates on the trial delay and the subscription wait", async () => {
    h.start();
    expect((await h.run()).status).toBe("hibernated");
    expect(h.stages("TrialStarted")).toHaveLength(1);
    expect(h.pending(EventType.Delay)).toHaveLength(1);
    expect(h.pending(EventType.WaitExternalEvent)).toHaveLength(1);
    expect(h.charges).toEqual([]);
  });

  it("ends the trial without charging when the deadline wins (delay is undefined, not a subscription)", async () => {
    h.start();
    await h.run();
    const outcome = await h.elapse();
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Ended", monthsPaid: 0, totalCharged: 0 });
    expect(h.stages("TrialEnded")).toHaveLength(1);
    expect(h.charges).toEqual([]);
  });

  it("subscribing during the trial starts charging right away, with the plan of the event", async () => {
    h.start();
    await h.run();
    h.subscribe("basic");
    expect((await h.run()).status).toBe("hibernated"); // waiting for the next month or a cancellation
    expect(h.stages("Subscribed")[0]).toMatchObject({ plan: "basic" });
    expect(h.charges).toEqual([[1, 1]]);
    expect(h.stages("TrialEnded")).toHaveLength(0);
  });

  it("serves a subscription fired before the function reached the wait (during TrialStarted / worker down)", async () => {
    h.start();
    await h.run(); // hibernated on both waits
    h.subscribe(); // arrives while nobody runs
    await h.run();
    expect(h.charges).toEqual([[1, 1]]);
  });

  it("an event for another customer does not wake this one", async () => {
    h.start();
    await h.run();
    expect(() => h.subscribe("pro", "other-customer")).toThrow();
    expect(h.pending(EventType.WaitExternalEvent)).toHaveLength(1);
  });
});

describe("ManageSubscription: monthly charges", () => {
  it("charges month 1, waits, and charges month 2 after the month delay, once each", async () => {
    expect((await h.subscribedAndCharged()).status).toBe("hibernated");
    expect(h.charges).toEqual([[1, 1]]);

    await h.elapse();
    expect(h.charges).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("expires when the last month has passed without a cancellation", async () => {
    let outcome = await h.subscribedAndCharged();
    for (let month = 1; month < CycleLimits.maxMonths; month++) outcome = await h.elapse();
    expect(outcome.status).toBe("hibernated"); // month 12 charged, waiting for it to pass
    outcome = await h.elapse();

    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Expired", monthsPaid: CycleLimits.maxMonths });
    expect(h.charges).toHaveLength(CycleLimits.maxMonths);
    expect(h.stages("Expired")).toHaveLength(1);
  });

  it("does not run a recorded charge again after resuming", async () => {
    await h.subscribedAndCharged();
    await h.elapse();
    await h.elapse();
    expect(h.charges.filter(([month]) => month === 1)).toHaveLength(1);
    expect(h.stages("TrialStarted")).toHaveLength(1);
  });
});

describe("ManageSubscription: declined payment", () => {
  it("declined once: warns, waits the retry delay and the second attempt is approved", async () => {
    h.card = Cards.declinedOnce;
    h.start();
    await h.run();
    h.subscribe();
    expect((await h.run()).status).toBe("hibernated"); // on the retry delay
    expect(h.charges).toEqual([[1, 1]]);
    expect(h.stages("Retrying")).toHaveLength(1);

    await h.elapse(); // retry delay: second attempt approved, now waits for the month
    expect(h.charges).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(h.stages("Suspended")).toHaveLength(0);

    await h.elapse(); // month 2: first attempt declined again, warns again
    expect(h.charges.at(-1)).toEqual([2, 1]);
  });

  it("always declined: second attempt declined, subscription suspended with the reason", async () => {
    h.card = Cards.alwaysDeclined;
    h.start();
    await h.run();
    h.subscribe();
    await h.run();
    const outcome = await h.elapse();

    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({
      end: "Suspended",
      month: 1,
      monthsPaid: 0,
      reason: "card declined by the issuer",
    });
    expect(h.charges).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(h.stages("Suspended")).toHaveLength(1);
  });
});

describe("ManageSubscription: cancellation", () => {
  it("cancelling between charges stops with the last paid month and no new charge", async () => {
    await h.subscribedAndCharged();
    h.cancel();
    const outcome = await h.run();

    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Cancelled", month: 1, monthsPaid: 1 });
    expect(h.charges).toEqual([[1, 1]]);
    expect(h.stages("Cancelled")).toHaveLength(1);
  });

  it("a single cancellation wait serves every month (cancel in the 3rd month)", async () => {
    await h.subscribedAndCharged();
    await h.elapse();
    await h.elapse();
    expect(h.charges).toHaveLength(3);
    h.cancel();
    expect(result(await h.run())).toMatchObject({ end: "Cancelled", month: 3 });
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.WaitExternalEvent)).toHaveLength(2); // subscription + cancellation
  });

  it("cancelling during the retry wait: the second attempt is still charged and, approved, ends Cancelled", async () => {
    h.card = Cards.declinedOnce;
    h.start();
    await h.run();
    h.subscribe();
    await h.run(); // retry delay pending
    h.cancel();
    await h.run(); // the cancellation is seen only by the next whenAny: back to the retry delay

    const outcome = await h.elapse();
    expect(h.charges).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Cancelled", month: 1 });
  });

  it("cancelling during the retry wait with a declined retry ends Suspended", async () => {
    h.card = Cards.alwaysDeclined;
    h.start();
    await h.run();
    h.subscribe();
    await h.run();
    h.cancel();
    const outcome = await h.elapse();
    expect(result(outcome)).toMatchObject({ end: "Suspended" });
  });
});

describe("ManageSubscription: failures", () => {
  it("retries a charge command that failed once, with the same arguments", async () => {
    h.failCharges = 1;
    h.start();
    await h.run();
    h.subscribe();
    await h.run();
    for (let i = 0; i < 5 && h.charges.length < 1; i++) {
      h.platform.enqueue(ID);
      await h.run();
    }
    expect(h.charges).toEqual([[1, 1]]);
  });

  it("when the charge keeps failing the failure is notified and the function fails", async () => {
    h.alwaysFailCharge = true;
    h.start();
    await h.run();
    h.subscribe();
    let outcome = await h.run();
    for (let i = 0; i < 6 && outcome.status !== "failed" && h.stages("Failed").length === 0; i++) {
      h.platform.enqueue(ID);
      outcome = await h.run();
    }
    expect(h.stages("Failed")).toHaveLength(1);
  });
});
