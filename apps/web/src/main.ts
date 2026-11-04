import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { CustomerStore } from "./customer-store.js";
import { SkailApiGateway, skailOptionsFromEnvironment } from "./gateway.js";

const positive = (v: string | undefined) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const app = createApp({
  store: new CustomerStore(),
  gateway: new SkailApiGateway(skailOptionsFromEnvironment()),
  monitorUrl: process.env.MONITOR_URL,
  defaults: {
    trialSeconds: positive(process.env.DEFAULT_TRIAL_SECONDS),
    monthSeconds: positive(process.env.DEFAULT_MONTH_SECONDS),
  },
  staticDir,
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
console.log(`Subscription cycle web listening on http://${host}:${port} (static: ${staticDir})`);
