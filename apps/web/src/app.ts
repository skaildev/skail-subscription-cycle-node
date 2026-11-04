import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  Cards,
  CycleLimits,
  Plans,
  isTerminalPhase,
  type AppConfig,
  type Subscription,
  type Cancellation,
  type CustomerEvent,
  type CustomerState,
  type CustomerView,
} from "@skail-subscription-cycle/contracts";
import type { CustomerStore } from "./customer-store.js";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";

export interface AppOptions {
  store: CustomerStore;
  gateway: SkailGateway;
  /** Optional link to the skail Monitor (MONITOR_URL), shown by the page. */
  monitorUrl?: string | null;
  /** Defaults of the form (DEFAULT_TRIAL_SECONDS / DEFAULT_MONTH_SECONDS); the function receives them as parameters. */
  defaults?: { trialSeconds?: number; monthSeconds?: number };
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
}

export function toView(customer: CustomerState): CustomerView {
  return { ...customer, active: !isTerminalPhase(customer.phase) };
}

interface StartBody {
  name?: unknown;
  plan?: unknown;
  trialSeconds?: unknown;
  monthSeconds?: unknown;
  card?: unknown;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= CycleLimits.maxSeconds;

export function createApp({
  store,
  gateway,
  monitorUrl = null,
  defaults = {},
  staticDir,
}: AppOptions): FastifyInstance {
  const app = fastify();
  const defaultTrial = defaults.trialSeconds ?? CycleLimits.defaultTrialSeconds;
  const defaultMonth = defaults.monthSeconds ?? CycleLimits.defaultMonthSeconds;

  app.get("/healthz", async () => "ok");

  app.get("/api/config", async (): Promise<AppConfig> => ({
    defaultName: CycleLimits.defaultName,
    defaultTrialSeconds: defaultTrial,
    defaultMonthSeconds: defaultMonth,
    monitorUrl: monitorUrl || null,
  }));

  app.post<{ Body: StartBody | null }>("/api/customers", async (request, reply) => {
    const body = request.body ?? {};
    // a blank name, plan or card (the page sends an empty name field) means the default
    const name = text(body.name) ?? CycleLimits.defaultName;
    const plan = text(body.plan) ?? (body.plan === undefined || body.plan === "" ? Plans.basic : body.plan);
    const card = text(body.card) ?? (body.card === undefined || body.card === "" ? Cards.approved : body.card);
    const trialSeconds = body.trialSeconds === undefined ? defaultTrial : body.trialSeconds;
    const monthSeconds = body.monthSeconds === undefined ? defaultMonth : body.monthSeconds;

    if (name.length > CycleLimits.maxNameLength)
      return reply.code(400).send({ error: `The name can have at most ${CycleLimits.maxNameLength} characters` });
    if (!Plans.isValid(plan))
      return reply.code(400).send({ error: `Unknown plan. Use '${Plans.basic}' or '${Plans.pro}'` });
    if (!Cards.isValid(card))
      return reply
        .code(400)
        .send({ error: `Unknown card. Use '${Cards.approved}', '${Cards.declinedOnce}' or '${Cards.alwaysDeclined}'` });
    if (!isSeconds(trialSeconds)) return reply.code(400).send({ error: "trialSeconds must be a positive integer" });
    if (!isSeconds(monthSeconds)) return reply.code(400).send({ error: "monthSeconds must be a positive integer" });

    const customerId = randomUUID();
    const customer = store.create(customerId, { name, plan, card, trialSeconds, monthSeconds });
    try {
      await gateway.trigger(customerId, trialSeconds, monthSeconds);
    } catch (error) {
      store.remove(customerId);
      return reply.code(502).send({ error: messageOf(error) });
    }
    return toView(store.get(customerId) ?? customer);
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (request, reply) => {
    const customer = store.get(request.params.id);
    return customer ? toView(customer) : reply.code(404).send();
  });

  // The customer subscribes: registered here (the first one wins) and fired to the function's waitForEvent.
  app.post<{ Params: { id: string }; Body: { plan?: unknown } | null }>(
    "/api/customers/:id/subscribe",
    async (request, reply) => {
      const { id } = request.params;
      const customer = store.get(id);
      if (!customer) return reply.code(404).send();

      const plan = text(request.body?.plan) ?? customer.plan; // the plan chosen on the page, defaulting to the one it started with
      if (!Plans.isValid(plan))
        return reply.code(400).send({ error: `Unknown plan. Use '${Plans.basic}' or '${Plans.pro}'` });

      const subscription: Subscription = { plan, at: new Date().toISOString() };
      switch (store.trySubscribe(id, subscription)) {
        case "NotFound":
          return reply.code(404).send();
        case "Conflict":
          return reply
            .code(409)
            .send({ error: "The customer cannot subscribe now (only once, and only during the trial)" });
      }

      try {
        await gateway.fireSubscription(id, subscription);
      } catch (error) {
        store.releaseSubscribe(id); // not delivered: the click can be repeated
        return reply.code(502).send({ error: messageOf(error) });
      }
      return toView(store.get(id)!);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } | null }>(
    "/api/customers/:id/cancel",
    async (request, reply) => {
      const { id } = request.params;
      const customer = store.get(id);
      if (!customer) return reply.code(404).send();

      const cancellation: Cancellation = { reason: text(request.body?.reason), at: new Date().toISOString() };
      switch (store.tryCancel(id, cancellation)) {
        case "NotFound":
          return reply.code(404).send();
        case "Conflict":
          return reply
            .code(409)
            .send({ error: "The subscription cannot be cancelled now (it needs to be active, and only once)" });
      }

      try {
        await gateway.fireCancellation(id, cancellation);
      } catch (error) {
        store.releaseCancel(id);
        return reply.code(502).send({ error: messageOf(error) });
      }
      return toView(store.get(id)!);
    },
  );

  // called by the worker's commands (StartTrial, StartSubscription, SuspendSubscription, ..., ReportStatus)
  app.post<{ Params: { id: string }; Body: CustomerEvent }>(
    "/internal/customers/:id/events",
    async (request, reply) => {
      store.apply({ ...request.body, customerId: request.params.id });
      return reply.code(204).send();
    },
  );

  // called by ChargeMonthlyFee: the simulated card network decides by the customer's card
  app.post<{ Params: { id: string }; Body: { plan?: unknown; month?: unknown; attempt?: unknown } | null }>(
    "/internal/customers/:id/charges",
    async (request, reply) => {
      const { plan, month, attempt } = request.body ?? {};
      if (!Plans.isValid(plan) || !isPositiveInt(month) || !isPositiveInt(attempt)) {
        return reply.code(400).send({ error: "plan, month and attempt are required (month and attempt start at 1)" });
      }
      const charge = store.charge(request.params.id, plan, month, attempt);
      return charge ?? reply.code(404).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/customers/:id/stream", (request, reply) => {
    const { id } = request.params;
    const current = store.get(id);
    if (!current) return reply.code(404).send();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: CustomerState) => raw.write(`data: ${JSON.stringify(toView(state))}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(id, send, () => raw.end());
    raw.on("close", unsubscribe);
    send(current);
    if (isTerminalPhase(current.phase)) {
      unsubscribe();
      raw.end();
    }
  });

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function messageOf(error: unknown): string {
  return error instanceof SkailGatewayError || error instanceof Error ? error.message : String(error);
}
