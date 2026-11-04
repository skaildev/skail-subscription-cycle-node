import { beforeEach, describe, expect, it } from "vitest";
import {
  Cards,
  CustomerEvent,
  CycleLimits,
  CycleResult,
  type Subscription,
  type Cancellation,
} from "@skail-subscription-cycle/contracts";
import { createApp } from "../src/app.js";
import { CustomerStore } from "../src/customer-store.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";

class FakeGateway implements SkailGateway {
  triggers: Array<[string, number, number]> = [];
  subscriptions: Array<[string, Subscription]> = [];
  cancellations: Array<[string, Cancellation]> = [];
  failTrigger = false;
  failFire = false;
  async trigger(customerId: string, trialSeconds: number, monthSeconds: number) {
    if (this.failTrigger) throw new SkailGatewayError("skail down");
    this.triggers.push([customerId, trialSeconds, monthSeconds]);
  }
  async fireSubscription(id: string, a: Subscription) {
    if (this.failFire) throw new SkailGatewayError("skail down");
    this.subscriptions.push([id, a]);
  }
  async fireCancellation(id: string, c: Cancellation) {
    if (this.failFire) throw new SkailGatewayError("skail down");
    this.cancellations.push([id, c]);
  }
}

let gw: FakeGateway;
let store: CustomerStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  gw = new FakeGateway();
  store = new CustomerStore();
  app = createApp({ store, gateway: gw, monitorUrl: "http://monitor" });
});

const start = async (payload?: unknown) => {
  const res = await app.inject({ method: "POST", url: "/api/customers", payload: payload as object });
  return { res, body: res.json() };
};
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload });
const event = (id: string, e: CustomerEvent) => post(`/internal/customers/${id}/events`, e);

/** A customer in the trial, subscribed and being charged (the worker's events). */
async function subscribedCustomer(payload?: object) {
  const { body } = await start(payload);
  await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
  await post(`/api/customers/${body.customerId}/subscribe`);
  await event(body.customerId, CustomerEvent.subscribed(body.customerId, body.plan));
  return body.customerId as string;
}

describe("web API: config, health and trigger", () => {
  it("serves config and healthz", async () => {
    expect((await app.inject("/healthz")).body).toBe("ok");
    expect((await app.inject("/api/config")).json()).toEqual({
      defaultName: CycleLimits.defaultName,
      defaultTrialSeconds: CycleLimits.defaultTrialSeconds,
      defaultMonthSeconds: CycleLimits.defaultMonthSeconds,
      monitorUrl: "http://monitor",
    });
  });

  it("uses the configured defaults of the form", async () => {
    const custom = createApp({ store, gateway: gw, defaults: { trialSeconds: 40, monthSeconds: 15 } });
    expect((await custom.inject("/api/config")).json()).toMatchObject({
      defaultTrialSeconds: 40,
      defaultMonthSeconds: 15,
    });
  });

  it("triggers ManageSubscription with defaults, a new GUID and the simulated card", async () => {
    const { res, body } = await start();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      phase: "Starting",
      active: true,
      name: "Demo Customer",
      plan: "basic",
      card: "approved",
      trialSeconds: 20,
      monthSeconds: 10,
    });
    expect(body.customerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(gw.triggers).toEqual([[body.customerId, 20, 10]]);
  });

  it("blank name, plan and card fall back to the defaults (the page sends an empty name field)", async () => {
    const { res, body } = await start({ name: "  ", plan: "", card: "" });
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ name: "Demo Customer", plan: "basic", card: "approved" });
  });

  it("uses the informed values", async () => {
    const { body } = await start({
      name: " Ana ",
      plan: "pro",
      trialSeconds: 5,
      monthSeconds: 3,
      card: Cards.declinedOnce,
    });
    expect(body).toMatchObject({ name: "Ana", plan: "pro", trialSeconds: 5, monthSeconds: 3, card: "declined-once" });
  });

  it.each([
    [{ plan: "gold" }],
    [{ trialSeconds: 0 }],
    [{ monthSeconds: -1 }],
    [{ trialSeconds: 1.5 }],
    [{ trialSeconds: "x" }],
    [{ card: "visa" }],
    [{ name: "x".repeat(CycleLimits.maxNameLength + 1) }],
  ])("rejects invalid input %j with 400 and does not trigger", async (payload) => {
    const { res } = await start(payload);
    expect(res.statusCode).toBe(400);
    expect(gw.triggers).toHaveLength(0);
  });

  it("answers 502 and forgets the customer when the trigger fails", async () => {
    gw.failTrigger = true;
    const { res } = await start();
    expect(res.statusCode).toBe(502);
  });

  it("GET returns the state or 404", async () => {
    const { body } = await start();
    expect((await app.inject(`/api/customers/${body.customerId}`)).json()).toMatchObject({
      customerId: body.customerId,
    });
    expect((await app.inject("/api/customers/nope")).statusCode).toBe(404);
  });
});

describe("web API: subscribe and cancel", () => {
  it("subscribe fires 'subscription' with the form plan and a server-stamped time", async () => {
    const { body } = await start({ name: "Ana", plan: "pro" });
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    const res = await post(`/api/customers/${body.customerId}/subscribe`, {});
    expect(res.statusCode).toBe(200);
    expect(gw.subscriptions).toHaveLength(1);
    expect(gw.subscriptions[0]![1]).toMatchObject({ plan: "pro" });
    expect(Date.parse(gw.subscriptions[0]![1].at)).not.toBeNaN();
  });

  it("subscribe can override the plan (validated)", async () => {
    const { body } = await start({ plan: "basic" });
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    expect((await post(`/api/customers/${body.customerId}/subscribe`, { plan: "gold" })).statusCode).toBe(400);
    expect(gw.subscriptions).toHaveLength(0);
    expect((await post(`/api/customers/${body.customerId}/subscribe`, { plan: "pro" })).statusCode).toBe(200);
    expect(gw.subscriptions[0]![1]).toEqual({ plan: "pro", at: expect.any(String) });
  });

  it("cancel sends the reason, or null without one", async () => {
    const id = await subscribedCustomer();
    await post(`/api/customers/${id}/cancel`);
    expect(gw.cancellations[0]![1]).toEqual({ reason: null, at: expect.any(String) });
  });

  it("a second subscribe, one before the trial starts and one for an unknown customer are 409/404 without a second fire", async () => {
    const { body } = await start();
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(409); // trial not started
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(200);
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(409);
    expect((await post("/api/customers/nope/subscribe")).statusCode).toBe(404);
    expect(gw.subscriptions).toHaveLength(1);
  });

  it("subscribing after the trial ended is 409", async () => {
    const { body } = await start();
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    await event(body.customerId, CustomerEvent.trialEnded(body.customerId, CycleResult.ended(body.customerId)));
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(409);
    expect(gw.subscriptions).toHaveLength(0);
  });

  it("a failed fire answers 502 and leaves the click undone for another try", async () => {
    const { body } = await start();
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    gw.failFire = true;
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(502);
    gw.failFire = false;
    expect((await post(`/api/customers/${body.customerId}/subscribe`)).statusCode).toBe(200);
    expect(gw.subscriptions).toHaveLength(1);
  });

  it("cancel fires 'cancellation' once; a second cancel and a cancel without subscription are 409", async () => {
    const { body } = await start();
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    expect((await post(`/api/customers/${body.customerId}/cancel`)).statusCode).toBe(409); // no subscription yet
    const id = await subscribedCustomer();
    expect((await post(`/api/customers/${id}/cancel`, { reason: "caro" })).statusCode).toBe(200);
    expect((await post(`/api/customers/${id}/cancel`)).statusCode).toBe(409);
    expect(gw.cancellations).toHaveLength(1);
    expect(gw.cancellations[0]![1]).toMatchObject({ reason: "caro" });
    expect((await post("/api/customers/nope/cancel")).statusCode).toBe(404);
  });

  it("a failed cancel fire answers 502 and can be repeated", async () => {
    const id = await subscribedCustomer();
    gw.failFire = true;
    expect((await post(`/api/customers/${id}/cancel`)).statusCode).toBe(502);
    gw.failFire = false;
    expect((await post(`/api/customers/${id}/cancel`)).statusCode).toBe(200);
  });
});

describe("web API: internal endpoints", () => {
  it("applies worker events and answers 204", async () => {
    const { body } = await start();
    const res = await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    expect(res.statusCode).toBe(204);
    expect((await app.inject(`/api/customers/${body.customerId}`)).json().phase).toBe("Trial");
  });

  it("answers the simulated charge by card, deterministically", async () => {
    const id = await subscribedCustomer({ card: Cards.declinedOnce });
    const first = await post(`/internal/customers/${id}/charges`, { plan: "basic", month: 1, attempt: 1 });
    expect(first.json()).toMatchObject({ approved: false, reason: "card declined by the issuer" });
    expect((await post(`/internal/customers/${id}/charges`, { plan: "basic", month: 1, attempt: 1 })).json()).toEqual(
      first.json(),
    );
    expect(
      (await post(`/internal/customers/${id}/charges`, { plan: "basic", month: 1, attempt: 2 })).json(),
    ).toMatchObject({ approved: true });
  });

  it("charge: 404 for unknown customer and 400 for a bad body", async () => {
    const id = await subscribedCustomer();
    expect((await post("/internal/customers/nope/charges", { plan: "basic", month: 1, attempt: 1 })).statusCode).toBe(
      404,
    );
    expect((await post(`/internal/customers/${id}/charges`, { plan: "gold", month: 1, attempt: 1 })).statusCode).toBe(
      400,
    );
    expect((await post(`/internal/customers/${id}/charges`, { plan: "basic", month: 0, attempt: 1 })).statusCode).toBe(
      400,
    );
  });
});

describe("web API: SSE", () => {
  it("sends the current state first and closes when the customer is already finished", async () => {
    const { body } = await start();
    await event(body.customerId, CustomerEvent.trialStarted(body.customerId));
    await event(body.customerId, CustomerEvent.trialEnded(body.customerId, CycleResult.ended(body.customerId)));
    const res = await app.inject(`/api/customers/${body.customerId}/stream`);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"phase":"Ended"');
    expect((await app.inject("/api/customers/nope/stream")).statusCode).toBe(404);
  });
});
