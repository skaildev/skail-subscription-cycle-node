// End to end without a skail environment: the real web app listening on a port, the real worker commands talking to
// it over HTTP (progress events and the simulated card network), and InMemorySkailPlatform in place of skail, with
// the web gateway bridged to it (trigger = start, fire = signal). Everything a user does goes through the web API.
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import { Events, type CustomerView } from "@skail-subscription-cycle/contracts";
import { createApp } from "../../web/src/app.js";
import { CustomerStore } from "../../web/src/customer-store.js";
import type { SkailGateway } from "../../web/src/gateway.js";
import { SubscriptionFunctions } from "../src/subscription-functions.js";
import { SubscriptionOperations } from "../src/subscription-operations.js";
import { HttpBilling, HttpProgressNotifier } from "../src/web.js";

const WORKLOAD = "subscriptioncycle:v1.0.0";

class World {
  readonly platform = new InMemorySkailPlatform();
  readonly app;
  readonly fires: string[] = [];
  worker!: SkailWorker;
  base = "";
  id = "";

  constructor() {
    const gateway: SkailGateway = {
      trigger: async (id, trialSeconds, monthSeconds) =>
        void this.platform.start(`${WORKLOAD}/ManageSubscription`, [id, trialSeconds, monthSeconds], id),
      fireSubscription: async (id, a) =>
        void (this.fires.push("CUSTOMER_SUBSCRIBED"), this.platform.signal(Events.customerSubscribed, id, a)),
      fireCancellation: async (id, c) =>
        void (this.fires.push("SUBSCRIPTION_CANCELLED"), this.platform.signal(Events.subscriptionCancelled, id, c)),
    };
    this.app = createApp({ store: new CustomerStore(), gateway });
  }

  async listen() {
    await this.app.listen({ port: 0, host: "127.0.0.1" });
    this.base = `http://127.0.0.1:${(this.app.server.address() as AddressInfo).port}`;
    const providers: Provider[] = [
      {
        token: SubscriptionFunctions,
        useFactory: () =>
          new SubscriptionFunctions(
            new SubscriptionOperations(new HttpProgressNotifier(this.base), new HttpBilling(this.base)),
          ),
      },
    ];
    this.worker = createSkailWorker({
      workload: WORKLOAD,
      types: [SubscriptionFunctions],
      providers,
      sidecar: this.platform,
    });
  }

  async api(method: string, path: string, body?: object) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as CustomerView | null };
  }

  async start(input: object = {}) {
    const { status, body } = await this.api("POST", "/api/customers", input);
    expect(status).toBe(200);
    this.id = body!.customerId;
    return this.run();
  }

  /** The worker handles whatever skail queued (like the real worker pulling work). */
  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }

  /** Completes the most recent pending delay, as the clock would, and runs the worker. */
  async elapse() {
    const delays = this.platform.history(this.id).filter((f) => f.eventType === EventType.Delay && !f.targetResult);
    expect(delays.length).toBeGreaterThan(0);
    this.platform.complete(this.id, delays.at(-1)!.index);
    return this.run();
  }

  async subscribe(body: object = {}) {
    const r = await this.api("POST", `/api/customers/${this.id}/subscribe`, body);
    if (r.status === 200) await this.run();
    return r;
  }

  async cancel() {
    const r = await this.api("POST", `/api/customers/${this.id}/cancel`, {});
    if (r.status === 200) await this.run();
    return r;
  }

  async customer() {
    return (await this.api("GET", `/api/customers/${this.id}`)).body!;
  }
}

let w: World;
beforeEach(async () => {
  w = new World();
  await w.listen();
});
afterEach(async () => {
  await w.app.close();
});

describe("end to end: web API + worker over HTTP", () => {
  it("trial runs out without a subscription: Ended, nothing charged", async () => {
    await w.start();
    expect(await w.customer()).toMatchObject({ phase: "Trial", name: "Demo Customer", active: true });

    await w.elapse();
    expect(await w.customer()).toMatchObject({
      phase: "Ended",
      active: false,
      totalCharged: 0,
      result: { end: "Ended" },
    });
    expect((await w.subscribe()).status).toBe(409); // too late
    expect(w.fires).toEqual([]);
  });

  it("subscribe, two approved months, cancel: Cancelled with the last paid month and total", async () => {
    await w.start({ name: "Ana", plan: "pro" });
    expect((await w.subscribe()).status).toBe(200);
    expect(await w.customer()).toMatchObject({ phase: "Subscribed", plan: "pro", month: 1 });

    await w.elapse(); // month 2
    expect(await w.customer()).toMatchObject({ phase: "Subscribed", month: 2 });

    expect((await w.cancel()).status).toBe(200);
    const end = await w.customer();
    expect(end).toMatchObject({
      phase: "Cancelled",
      active: false,
      result: { end: "Cancelled", month: 2, monthsPaid: 2 },
    });
    expect(end.totalCharged).toBeCloseTo(159.8, 2);
    expect(end.timeline.filter((t) => t.kind === "Charged").map((t) => t.month)).toEqual([1, 2]);
    expect(w.fires).toEqual(["CUSTOMER_SUBSCRIBED", "SUBSCRIPTION_CANCELLED"]);
  });

  it("declined-once card: warned, retry approved, cycle goes on", async () => {
    await w.start({ card: "declined-once" });
    await w.subscribe();
    expect(await w.customer()).toMatchObject({ phase: "Declined", month: 1, totalCharged: 0 });

    await w.elapse(); // retry delay: second attempt approved
    const c = await w.customer();
    expect(c).toMatchObject({ phase: "Subscribed", month: 1 });
    expect(c.timeline.map((t) => t.kind)).toEqual(expect.arrayContaining(["ChargeDeclined", "Retrying", "Charged"]));
  });

  it("always-declined card: retry declined too, Suspended with the reason", async () => {
    await w.start({ card: "always-declined" });
    await w.subscribe();
    await w.elapse();
    expect(await w.customer()).toMatchObject({
      phase: "Suspended",
      active: false,
      result: { end: "Suspended", month: 1, monthsPaid: 0, reason: "card declined by the issuer" },
    });
  });

  it("a second subscribe or cancel is a 409 and fires nothing; cancel without a subscription is a 409", async () => {
    await w.start();
    expect((await w.cancel()).status).toBe(409); // no subscription yet
    expect((await w.subscribe()).status).toBe(200);
    expect((await w.subscribe()).status).toBe(409);
    expect((await w.cancel()).status).toBe(200);
    expect((await w.cancel()).status).toBe(409);
    expect(w.fires).toEqual(["CUSTOMER_SUBSCRIBED", "SUBSCRIPTION_CANCELLED"]);
  });

  it("a click made while the worker is down is delivered when it comes back, and nothing is charged twice", async () => {
    await w.start();
    // the worker is down: the click is registered and fired, but nobody runs the activation yet
    expect((await w.api("POST", `/api/customers/${w.id}/subscribe`, {})).status).toBe(200);
    await w.run(); // the worker is back
    const c = await w.customer();
    expect(c).toMatchObject({ phase: "Subscribed", month: 1 });
    expect(c.timeline.filter((t) => t.kind === "Charged")).toHaveLength(1);
  });

  it("the whole cycle expires after 12 months", async () => {
    await w.start();
    await w.subscribe();
    for (let month = 1; month <= 12; month++) await w.elapse();
    expect(await w.customer()).toMatchObject({ phase: "Expired", result: { end: "Expired", monthsPaid: 12 } });
  });
});
