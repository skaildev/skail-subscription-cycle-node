import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkail } from "@skail/build";

describe("skail build", () => {
  it("accepts the worker (no forbidden imports) and lists the function and commands as <workload>/<method>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subscription-cycle-bundle-"));
    try {
      const manifest = await buildSkail({
        entryPoint: "src/skail-functions.ts",
        workload: "subscriptioncycle:v1.0.0",
        outfile: join(dir, "skail-functions.mjs"),
        manifestFile: join(dir, "manifest.json"),
      });

      const w = "subscriptioncycle:v1.0.0";
      expect(manifest.methods.map((m) => [m.kind, m.uri]).sort()).toEqual(
        [
          ["function", `${w}/ManageSubscription`],
          ["command", `${w}/StartTrial`],
          ["command", `${w}/EndTrial`],
          ["command", `${w}/StartSubscription`],
          ["command", `${w}/ChargeMonthlyFee`],
          ["command", `${w}/NotifyPaymentDeclined`],
          ["command", `${w}/SuspendSubscription`],
          ["command", `${w}/CancelSubscription`],
          ["command", `${w}/EndCycle`],
          ["command", `${w}/ReportStatus`],
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
