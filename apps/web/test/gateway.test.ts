import { describe, expect, it } from "vitest";
import { SkailApiGateway, SkailGatewayError, type SkailOptions } from "../src/gateway.js";

const options: SkailOptions = {
  baseUrl: "https://skail.test/",
  namespace: "t/e",
  key: "k",
  workload: "subscriptioncycle:v1.0.0",
};
const subscription = { plan: "pro", at: "2026-01-01T10:00:00.000Z" };
const cancellation = { reason: null, at: "2026-02-01T10:00:00.000Z" };

function gateway(answers: Array<number | Error>, opts = options) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const gw = new SkailApiGateway(
    opts,
    async (url, init) => {
      calls.push({ url, init: init! });
      const next = answers.shift() ?? 200;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    },
    () => 0,
  );
  return { gw, calls };
}

describe("SkailApiGateway", () => {
  it("triggers ManageSubscription with [customerId, trialSeconds, monthSeconds] and the skail headers", async () => {
    const { gw, calls } = gateway([200]);
    await gw.trigger("id 1", 20, 10);
    expect(calls[0]!.url).toBe("https://skail.test/api/v1/trigger/subscriptioncycle/v1.0.0/ManageSubscription/id%201");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(["id 1", 20, 10]);
    expect(calls[0]!.init.headers).toMatchObject({
      "skail-key": "k",
      authorization: "Bearer k",
      "skail-namespace": "t/e",
    });
  });

  it("fires subscription and cancellation with the payload JSON as body", async () => {
    const { gw, calls } = gateway([200, 200]);
    await gw.fireSubscription("c1", subscription);
    await gw.fireCancellation("c 1", cancellation);
    expect(calls[0]!.url).toBe("https://skail.test/api/v1/fire/CUSTOMER_SUBSCRIBED/c1");
    expect(calls[1]!.url).toBe("https://skail.test/api/v1/fire/SUBSCRIPTION_CANCELLED/c%201");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(subscription);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual(cancellation);
  });

  it("retries 429/5xx/network with the same id and body, then gives up", async () => {
    const ok = gateway([503, new Error("reset"), 429, 200]);
    await ok.gw.fireSubscription("c1", subscription);
    expect(ok.calls).toHaveLength(4);
    expect(new Set(ok.calls.map((c) => c.url + c.init.body)).size).toBe(1);

    const down = gateway([500, 500, 500, 500, 500]);
    await expect(down.gw.fireCancellation("c1", cancellation)).rejects.toThrow(/giving up after 5/);
  });

  it("does not retry 401/403 and points at the key", async () => {
    const { gw, calls } = gateway([401]);
    await expect(gw.trigger("id 1", 20, 10)).rejects.toThrow(/SKAIL_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("fails before calling when SKAIL_BASE_URL or SKAIL_WORKLOAD are wrong", async () => {
    const a = gateway([], { ...options, baseUrl: "" });
    await expect(a.gw.trigger("id 1", 20, 10)).rejects.toBeInstanceOf(SkailGatewayError);
    const b = gateway([], { ...options, workload: "nover" });
    await expect(b.gw.trigger("id 1", 20, 10)).rejects.toThrow(/name:version/);
    expect(a.calls.length + b.calls.length).toBe(0);
  });
});
