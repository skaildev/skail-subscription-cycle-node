import { beforeEach, describe, expect, it } from "vitest";
import {
  Cards,
  CustomerEvent,
  CycleResult,
  type Subscription,
  type Cancellation,
} from "@skail-subscription-cycle/contracts";
import { CustomerStore } from "../src/customer-store.js";

const ID = "c1";
const input = { name: "Maria", plan: "pro", card: Cards.approved as string, trialSeconds: 20, monthSeconds: 10 };
const subscription: Subscription = { plan: "pro", at: "2026-01-01T10:00:00.000Z" };
const cancellation: Cancellation = { reason: null, at: "2026-02-01T10:00:00.000Z" };

let store: CustomerStore;
beforeEach(() => {
  store = new CustomerStore(() => "T");
  store.create(ID, input);
});

const toTrial = () => store.apply(CustomerEvent.trialStarted(ID));
const toSubscribed = () => {
  toTrial();
  expect(store.trySubscribe(ID, subscription)).toBe("Accepted");
  store.apply(CustomerEvent.subscribed(ID, "pro"));
};

describe("CustomerStore: trial", () => {
  it("stamps trialStartedAt when the trial starts (the page countdown reads it)", () => {
    expect(store.get(ID)!.trialStartedAt).toBeNull();
    toTrial();
    expect(store.get(ID)!.trialStartedAt).toBe("T");
  });

  it("starts in Starting and moves to Trial on TrialStarted (once)", () => {
    expect(store.get(ID)).toMatchObject({
      phase: "Starting",
      name: "Maria",
      plan: "pro",
      card: "approved",
      month: 0,
      totalCharged: 0,
    });
    expect(toTrial()).toBe(true);
    expect(store.get(ID)!.phase).toBe("Trial");
    expect(toTrial()).toBe(false);
    expect(store.get(ID)!.timeline.filter((t) => t.kind === "TrialStarted")).toHaveLength(1);
  });

  it("trial ends without subscription: Ended, terminal", () => {
    toTrial();
    expect(store.apply(CustomerEvent.trialEnded(ID, CycleResult.ended(ID)))).toBe(true);
    expect(store.get(ID)).toMatchObject({ phase: "Ended", result: { end: "Ended" } });
    expect(store.apply(CustomerEvent.subscribed(ID, "pro"))).toBe(false);
  });
});

describe("CustomerStore: subscribe and cancel guards", () => {
  it("accepts one subscription during the trial; the second is a conflict", () => {
    toTrial();
    expect(store.trySubscribe(ID, subscription)).toBe("Accepted");
    expect(store.trySubscribe(ID, subscription)).toBe("Conflict");
    expect(store.get(ID)!.subscribeRequested).toBe(true);
  });

  it("refuses to subscribe before the trial starts, after it ended, and for an unknown customer", () => {
    expect(store.trySubscribe(ID, subscription)).toBe("Conflict"); // still Starting
    toTrial();
    store.apply(CustomerEvent.trialEnded(ID, CycleResult.ended(ID)));
    expect(store.trySubscribe(ID, subscription)).toBe("Conflict");
    expect(store.trySubscribe("nope", subscription)).toBe("NotFound");
  });

  it("release undoes an accepted subscription so the click can be repeated", () => {
    toTrial();
    store.trySubscribe(ID, subscription);
    store.releaseSubscribe(ID);
    expect(store.get(ID)!.subscribeRequested).toBe(false);
    expect(store.trySubscribe(ID, subscription)).toBe("Accepted");
    expect(store.get(ID)!.timeline.filter((t) => t.kind === "SubscribeRequested")).toHaveLength(1);
  });

  it("cancel needs an active subscription; the second cancel is a conflict", () => {
    toTrial();
    expect(store.tryCancel(ID, cancellation)).toBe("Conflict"); // no subscription
    store.trySubscribe(ID, subscription);
    expect(store.tryCancel(ID, cancellation)).toBe("Conflict"); // worker did not start it yet
    store.apply(CustomerEvent.subscribed(ID, "pro"));
    expect(store.tryCancel(ID, cancellation)).toBe("Accepted");
    expect(store.tryCancel(ID, cancellation)).toBe("Conflict");
    expect(store.tryCancel("nope", cancellation)).toBe("NotFound");
  });

  it("release undoes an accepted cancellation", () => {
    toSubscribed();
    store.tryCancel(ID, cancellation);
    store.releaseCancel(ID);
    expect(store.get(ID)!.cancelRequested).toBe(false);
    expect(store.tryCancel(ID, cancellation)).toBe("Accepted");
  });

  it("cancel is accepted while a declined charge waits for the retry", () => {
    toSubscribed();
    store.apply(CustomerEvent.subscribed(ID, "pro"));
    const declined = new CustomerStore();
    declined.create(ID, { ...input, card: Cards.alwaysDeclined });
    declined.apply(CustomerEvent.trialStarted(ID));
    declined.trySubscribe(ID, subscription);
    declined.apply(CustomerEvent.subscribed(ID, "pro"));
    declined.charge(ID, "pro", 1, 1);
    expect(declined.get(ID)!.phase).toBe("Declined");
    expect(declined.tryCancel(ID, cancellation)).toBe("Accepted");
  });

  it("nothing is accepted after the end", () => {
    toSubscribed();
    store.apply(CustomerEvent.cancelled(ID, CycleResult.cancelled(ID, "pro", 1)));
    expect(store.tryCancel(ID, cancellation)).toBe("Conflict");
  });
});

describe("CustomerStore: simulated card network", () => {
  it("approved: records the charge, month and total", () => {
    toSubscribed();
    expect(store.charge(ID, "pro", 1, 1)).toMatchObject({ approved: true, amount: 79.9 });
    expect(store.charge(ID, "pro", 2, 1)).toMatchObject({ approved: true });
    expect(store.get(ID)).toMatchObject({ phase: "Subscribed", month: 2 });
    expect(store.get(ID)!.totalCharged).toBeCloseTo(159.8, 2);
    expect(
      store
        .get(ID)!
        .timeline.filter((t) => t.kind === "Charged")
        .map((t) => [t.month, t.attempt]),
    ).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("a retried charge (same month and attempt) gets the same answer and is not counted twice", () => {
    toSubscribed();
    const first = store.charge(ID, "pro", 1, 1);
    expect(store.charge(ID, "pro", 1, 1)).toEqual(first);
    expect(store.get(ID)!.totalCharged).toBeCloseTo(79.9, 2);
    expect(store.get(ID)!.timeline.filter((t) => t.kind === "Charged")).toHaveLength(1);
  });

  it("declined-once: first attempt of each month declined (phase Declined), second approved", () => {
    const s = new CustomerStore();
    s.create(ID, { ...input, card: Cards.declinedOnce });
    s.apply(CustomerEvent.trialStarted(ID));
    s.trySubscribe(ID, subscription);
    s.apply(CustomerEvent.subscribed(ID, "pro"));
    expect(s.charge(ID, "pro", 1, 1)).toMatchObject({ approved: false, reason: "card declined by the issuer" });
    expect(s.get(ID)).toMatchObject({ phase: "Declined", totalCharged: 0 });
    expect(s.charge(ID, "pro", 1, 2)).toMatchObject({ approved: true });
    expect(s.get(ID)!.phase).toBe("Subscribed");
    expect(s.get(ID)!.timeline.map((t) => t.kind)).toContain("ChargeDeclined");
  });

  it("returns undefined for an unknown customer", () => {
    expect(store.charge("nope", "pro", 1, 1)).toBeUndefined();
  });
});

describe("CustomerStore: worker events", () => {
  it("Subscribed moves to Subscribed with the plan; Retrying is recorded once per month", () => {
    toSubscribed();
    expect(store.get(ID)).toMatchObject({ phase: "Subscribed", plan: "pro" });
    expect(store.apply(CustomerEvent.retrying(ID, 1, "declined"))).toBe(true);
    expect(store.apply(CustomerEvent.retrying(ID, 1, "declined"))).toBe(false);
    expect(store.get(ID)!.timeline.filter((t) => t.kind === "Retrying")).toHaveLength(1);
  });

  it.each([
    ["Suspended", CustomerEvent.suspended(ID, CycleResult.suspended(ID, "pro", 2, "declined"))],
    ["Cancelled", CustomerEvent.cancelled(ID, CycleResult.cancelled(ID, "pro", 2))],
    ["Expired", CustomerEvent.expired(ID, CycleResult.expired(ID, "pro", 12))],
  ] as const)("%s is terminal and carries the result", (phase, event) => {
    toSubscribed();
    expect(store.apply(event)).toBe(true);
    expect(store.get(ID)).toMatchObject({ phase, result: { end: phase } });
    expect(store.apply(CustomerEvent.failed(ID, "late"))).toBe(false);
  });

  it("Failed is terminal with the error", () => {
    toTrial();
    store.apply(CustomerEvent.failed(ID, "boom"));
    expect(store.get(ID)).toMatchObject({ phase: "Failed", error: "boom" });
  });

  it("ignores events of unknown customers", () => {
    expect(store.apply(CustomerEvent.trialStarted("nope"))).toBe(false);
  });
});

describe("CustomerStore: SSE subscribers", () => {
  it("notifies each change and closes when the customer ends", () => {
    const states: string[] = [];
    let closed = 0;
    store.subscribe(
      ID,
      (s) => states.push(s.phase),
      () => closed++,
    );
    toTrial();
    store.apply(CustomerEvent.trialEnded(ID, CycleResult.ended(ID)));
    expect(states).toEqual(["Trial", "Ended"]);
    expect(closed).toBe(1);
  });

  it("unsubscribe stops notifications; remove closes the stream", () => {
    let seen = 0;
    let closed = 0;
    const unsubscribe = store.subscribe(
      ID,
      () => seen++,
      () => closed++,
    );
    unsubscribe();
    toTrial();
    expect(seen).toBe(0);
    store.subscribe(
      ID,
      () => seen++,
      () => closed++,
    );
    store.remove(ID);
    expect(closed).toBe(1);
    expect(store.get(ID)).toBeUndefined();
  });
});
