import { describe, expect, it } from "vitest";
import {
  Cards,
  CycleLimits,
  CycleResult,
  Events,
  Plans,
  chargeFor,
  isCancellation,
  isSubscription,
  startState,
  type Subscription,
  type Cancellation,
} from "../src/index.js";

const subscription: Subscription = { plan: "pro", at: "2026-01-01T10:00:00.000Z" };
const cancellation: Cancellation = { reason: null, at: "2026-01-01T10:00:00.000Z" };

describe("Plans", () => {
  it("validates plans and gives each a monthly price", () => {
    expect(Plans.isValid("basic")).toBe(true);
    expect(Plans.isValid("pro")).toBe(true);
    expect(Plans.isValid("gold")).toBe(false);
    expect(Plans.price("basic")).toBeLessThan(Plans.price("pro"));
    expect(() => Plans.price("gold")).toThrow();
  });
});

describe("CycleLimits", () => {
  it("has a default customer name", () => {
    expect(CycleLimits.defaultName).toBe("Demo Customer");
  });
});

describe("Events", () => {
  it("shares the external event names", () => {
    expect(Events).toEqual({
      customerSubscribed: "CUSTOMER_SUBSCRIBED",
      subscriptionCancelled: "SUBSCRIPTION_CANCELLED",
    });
  });
});

describe("whenAny winner detection", () => {
  it("recognizes the Subscription payload and nothing else", () => {
    expect(isSubscription(subscription)).toBe(true);
    for (const v of [undefined, null, true, {}, cancellation, "x"]) expect(isSubscription(v)).toBe(false);
  });

  it("recognizes the Cancellation payload and nothing else", () => {
    expect(isCancellation(cancellation)).toBe(true);
    expect(isCancellation({ ...cancellation, reason: "caro" })).toBe(true);
    for (const v of [undefined, null, true, {}, subscription, "x"]) expect(isCancellation(v)).toBe(false);
  });
});

describe("chargeFor (simulated card)", () => {
  it("approved always approves, with the plan price", () => {
    for (const attempt of [1, 2])
      expect(chargeFor(Cards.approved, "basic", attempt)).toEqual({
        approved: true,
        reason: null,
        amount: Plans.price("basic"),
      });
  });

  it("declined-once declines only the first attempt", () => {
    expect(chargeFor(Cards.declinedOnce, "pro", 1)).toMatchObject({
      approved: false,
      reason: "card declined by the issuer",
    });
    expect(chargeFor(Cards.declinedOnce, "pro", 2)).toMatchObject({ approved: true });
  });

  it("always-declined declines every attempt and is deterministic", () => {
    expect(chargeFor(Cards.alwaysDeclined, "pro", 2)).toEqual(chargeFor(Cards.alwaysDeclined, "pro", 2));
    expect(chargeFor(Cards.alwaysDeclined, "pro", 2).approved).toBe(false);
  });

  it("validates cards", () => {
    expect(Cards.isValid("approved")).toBe(true);
    expect(Cards.isValid("gold")).toBe(false);
  });
});

describe("CycleResult", () => {
  it("Ended: trial expired, nothing charged", () => {
    expect(CycleResult.ended("c1")).toMatchObject({
      customerId: "c1",
      end: "Ended",
      monthsPaid: 0,
      totalCharged: 0,
      plan: null,
    });
  });

  it("Cancelled: last paid month and total charged", () => {
    const r = CycleResult.cancelled("c1", "pro", 2);
    expect(r).toMatchObject({ end: "Cancelled", monthsPaid: 2, month: 2 });
    expect(r.totalCharged).toBeCloseTo(2 * Plans.price("pro"), 2);
  });

  it("Suspended: paid months are the ones before the failing month, with the reason", () => {
    const r = CycleResult.suspended("c1", "basic", 3, "card declined by the issuer");
    expect(r).toMatchObject({ end: "Suspended", monthsPaid: 2, month: 3, reason: "card declined by the issuer" });
  });

  it("Expired: all months paid", () => {
    const r = CycleResult.expired("c1", "basic", CycleLimits.maxMonths);
    expect(r).toMatchObject({ end: "Expired", monthsPaid: 12 });
    expect(r.totalCharged).toBeCloseTo(12 * Plans.price("basic"), 2);
  });

  it("survives a JSON round trip", () => {
    const r = CycleResult.cancelled("c1", "pro", 2);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("startState", () => {
  it("enables the form when there is no customer or it is finished", () => {
    expect(startState(undefined).enabled).toBe(true);
    for (const phase of ["Ended", "Cancelled", "Suspended", "Expired", "Failed"] as const)
      expect(startState({ phase }).enabled).toBe(true);
  });

  it("disables the form while a customer is active, keeping the button label", () => {
    for (const phase of ["Starting", "Trial", "Subscribed", "Declined"] as const)
      expect(startState({ phase })).toEqual({ label: "Start trial", enabled: false });
  });
});
