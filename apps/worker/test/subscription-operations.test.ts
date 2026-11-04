import { describe, expect, it } from "vitest";
import { Plans, type Charge, type CustomerEvent } from "@skail-subscription-cycle/contracts";
import { SubscriptionOperations } from "../src/subscription-operations.js";
import type { Billing, ProgressNotifier } from "../src/web.js";

function make(opts: { charge?: Billing["charge"]; notify?: ProgressNotifier["notify"] } = {}) {
  const events: CustomerEvent[] = [];
  const charged: unknown[][] = [];
  const notifier: ProgressNotifier = { notify: opts.notify ?? (async (e) => void events.push(e)) };
  const billing: Billing = {
    charge:
      opts.charge ??
      (async (...args) => {
        charged.push(args);
        return { approved: true, reason: null, amount: Plans.price("pro") } satisfies Charge;
      }),
  };
  return { ops: new SubscriptionOperations(notifier, billing), events, charged };
}

describe("SubscriptionOperations", () => {
  it("startTrial notifies TrialStarted", async () => {
    const { ops, events } = make();
    await ops.startTrial("c1");
    expect(events).toEqual([{ customerId: "c1", stage: "TrialStarted" }]);
  });

  it("charge asks the right charge (plan, month, attempt) and returns the Charge", async () => {
    const { ops, charged } = make();
    const charge = await ops.charge("c1", "pro", 2, 1);
    expect(charged).toEqual([["c1", "pro", 2, 1]]);
    expect(charge.approved).toBe(true);
  });

  it("charge throws only when the billing call fails (a decline is a result)", async () => {
    const declined = make({ charge: async () => ({ approved: false, reason: "declined", amount: 1 }) });
    await expect(declined.ops.charge("c1", "pro", 1, 1)).resolves.toMatchObject({ approved: false });
    const broken = make({
      charge: async () => {
        throw new Error("down");
      },
    });
    await expect(broken.ops.charge("c1", "pro", 1, 1)).rejects.toThrow("down");
  });

  it("notifyPaymentDeclined notifies Retrying with month and reason", async () => {
    const { ops, events } = make();
    await ops.notifyPaymentDeclined("c1", 3, "card declined by the issuer");
    expect(events).toEqual([{ customerId: "c1", stage: "Retrying", month: 3, reason: "card declined by the issuer" }]);
  });

  it("suspend, cancel, endCycle and endTrial return the right result and notify it", async () => {
    const { ops, events } = make();
    expect(await ops.suspend("c1", "pro", 2, "declined")).toMatchObject({ end: "Suspended", month: 2, monthsPaid: 1 });
    expect(await ops.cancel("c1", "pro", 4)).toMatchObject({ end: "Cancelled", month: 4, monthsPaid: 4 });
    expect(await ops.endCycle("c1", "pro", 12)).toMatchObject({ end: "Expired", monthsPaid: 12 });
    expect(await ops.endTrial("c1")).toMatchObject({ end: "Ended" });
    expect(events.map((e) => e.stage)).toEqual(["Suspended", "Cancelled", "Expired", "TrialEnded"]);
  });

  it("is idempotent: the same call returns the same result", async () => {
    const { ops } = make();
    expect(await ops.cancel("c1", "pro", 4)).toEqual(await ops.cancel("c1", "pro", 4));
  });

  it("reportStatus and startSubscription propagate a notifier failure so skail retries", async () => {
    const { ops } = make({
      notify: async () => {
        throw new Error("web down");
      },
    });
    await expect(ops.startSubscription("c1", "pro")).rejects.toThrow("web down");
    await expect(ops.reportStatus({ customerId: "c1", stage: "Failed", error: "x" })).rejects.toThrow("web down");
  });
});
