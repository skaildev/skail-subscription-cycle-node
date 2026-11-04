import type { Provider } from "@skail/runtime";
import { SubscriptionFunctions } from "./subscription-functions.js";
import { SubscriptionOperations } from "./subscription-operations.js";
import { buildConfig } from "./build-config.generated.js";
import { FakeBilling, FakeProgressNotifier, HttpBilling, HttpProgressNotifier } from "./web.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: SubscriptionFunctions,
    useFactory: () =>
      new SubscriptionFunctions(
        buildConfig.notifyProvider === "fake"
          ? new SubscriptionOperations(new FakeProgressNotifier(), new FakeBilling())
          : new SubscriptionOperations(
              new HttpProgressNotifier(buildConfig.webBaseUrl),
              new HttpBilling(buildConfig.webBaseUrl),
            ),
      ),
  },
];
