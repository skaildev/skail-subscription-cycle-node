import { describe, expect, it } from "vitest";
import { chargeFor, Cards, CustomerEvent } from "@skail-subscription-cycle/contracts";
import { FakeBilling, HttpBilling, HttpProgressNotifier } from "../src/web.js";

describe("HttpProgressNotifier", () => {
  it("POSTs the event to /internal/customers/{id}/events", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const notifier = new HttpProgressNotifier(
      "http://web:8080/",
      async (url, init) => (calls.push([url, init]), new Response(null, { status: 204 })),
    );
    await notifier.notify(CustomerEvent.trialStarted("a b"));
    expect(calls[0]![0]).toBe("http://web:8080/internal/customers/a%20b/events");
    expect(JSON.parse(calls[0]![1]!.body as string)).toMatchObject({ customerId: "a b", stage: "TrialStarted" });
  });

  it("throws when the web app answers an error, so skail retries", async () => {
    const notifier = new HttpProgressNotifier("http://web", async () => new Response(null, { status: 500 }));
    await expect(notifier.notify(CustomerEvent.failed("c", "x"))).rejects.toThrow("500");
  });
});

describe("HttpBilling", () => {
  it("POSTs { plan, month, attempt } to /internal/customers/{id}/charges and returns the Charge", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const charge = { approved: false, reason: "declined", amount: 79.9 };
    const billing = new HttpBilling(
      "http://web:8080",
      async (url, init) => (calls.push([url, init]), Response.json(charge)),
    );
    expect(await billing.charge("c1", "pro", 2, 1)).toEqual(charge);
    expect(calls[0]![0]).toBe("http://web:8080/internal/customers/c1/charges");
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ plan: "pro", month: 2, attempt: 1 });
  });

  it("throws when the web app answers an error", async () => {
    const billing = new HttpBilling("http://web", async () => new Response(null, { status: 503 }));
    await expect(billing.charge("c1", "pro", 1, 1)).rejects.toThrow("503");
  });
});

describe("FakeBilling", () => {
  it("uses the simulated card (approved by default)", async () => {
    expect(await new FakeBilling().charge("c1", "pro", 1, 1)).toEqual(chargeFor(Cards.approved, "pro", 1));
  });
});
