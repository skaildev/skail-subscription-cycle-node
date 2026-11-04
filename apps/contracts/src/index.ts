// Shared by web, worker and front end. It also goes into the skail bundle, so it has only types, constants
// and pure functions: no Node I/O imports, which the skail build rejects.

/** The plans, as plain strings (Subscription is the payload of an external event), each with a simulated monthly price. */
export const Plans = {
  basic: "basic",
  pro: "pro",
  isValid: (plan: unknown): plan is string => plan === "basic" || plan === "pro",
  price(plan: string): number {
    switch (plan) {
      case "basic":
        return 29.9;
      case "pro":
        return 79.9;
      default:
        throw new Error(`unknown plan '${plan}'`);
    }
  },
} as const;

/** Simulated credit cards: they decide, deterministically, whether a charge is approved. */
export const Cards = {
  approved: "approved",
  declinedOnce: "declined-once",
  alwaysDeclined: "always-declined",
  isValid: (card: unknown): card is string =>
    card === "approved" || card === "declined-once" || card === "always-declined",
} as const;

/** External event names, shared by the function (waitForEvent) and the web app (fire). */
export const Events = {
  customerSubscribed: "CUSTOMER_SUBSCRIBED",
  subscriptionCancelled: "SUBSCRIPTION_CANCELLED",
} as const;

export const CycleLimits = {
  /** The demo does not charge forever: after this month without cancelling the cycle ends as Expired. */
  maxMonths: 12,
  /** Wait before the single retry of a declined charge. */
  retrySeconds: 5,
  defaultName: "Demo Customer",
  defaultTrialSeconds: 20,
  defaultMonthSeconds: 10,
  maxNameLength: 80,
  maxSeconds: 60 * 60 * 24 * 366,
} as const;

/**
 * The customer subscribed: payload of the `CUSTOMER_SUBSCRIBED` event. The event goes into the run history, so it
 * carries only the chosen plan and the time (ISO 8601), stamped by the web app because the function cannot read
 * the clock.
 */
export interface Subscription {
  plan: string;
  at: string;
}

/** The customer cancelled: payload of the `SUBSCRIPTION_CANCELLED` event. */
export interface Cancellation {
  reason: string | null;
  at: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Skail.whenAny returns the value of the winner: undefined for a delay, the payload for an event.
// The function tells them apart by the shape of the value, so the payloads always have their required fields.
export function isSubscription(value: unknown): value is Subscription {
  return isObject(value) && typeof value.plan === "string" && typeof value.at === "string";
}

export function isCancellation(value: unknown): value is Cancellation {
  return (
    isObject(value) &&
    !("plan" in value) &&
    typeof value.at === "string" &&
    (value.reason === null || typeof value.reason === "string")
  );
}

/** Business result of one charge attempt: a decline is a result, not an exception. */
export interface Charge {
  approved: boolean;
  reason: string | null;
  amount: number;
}

export const declineReason = "card declined by the issuer";

/** The simulated card network: the answer depends only on the card and the attempt, so a technical retry gets the same answer. */
export function chargeFor(card: string, plan: string, attempt: number): Charge {
  const amount = Plans.price(plan);
  const declined = card === Cards.alwaysDeclined || (card === Cards.declinedOnce && attempt === 1);
  return declined ? { approved: false, reason: declineReason, amount } : { approved: true, reason: null, amount };
}

export type CycleEnd = "Ended" | "Cancelled" | "Suspended" | "Expired";

export interface CycleResult {
  customerId: string;
  end: CycleEnd;
  plan: string | null;
  monthsPaid: number;
  totalCharged: number;
  /** Last paid month (Cancelled), failing month (Suspended) or last month (Expired). */
  month: number | null;
  reason: string | null;
}

const paid = (plan: string, months: number) => Math.round(Plans.price(plan) * months * 100) / 100;

export const CycleResult = {
  ended: (customerId: string): CycleResult => ({
    customerId,
    end: "Ended",
    plan: null,
    monthsPaid: 0,
    totalCharged: 0,
    month: null,
    reason: null,
  }),

  cancelled: (customerId: string, plan: string, lastPaidMonth: number): CycleResult => ({
    customerId,
    end: "Cancelled",
    plan,
    monthsPaid: lastPaidMonth,
    totalCharged: paid(plan, lastPaidMonth),
    month: lastPaidMonth,
    reason: null,
  }),

  suspended: (customerId: string, plan: string, month: number, reason: string): CycleResult => ({
    customerId,
    end: "Suspended",
    plan,
    monthsPaid: month - 1,
    totalCharged: paid(plan, month - 1),
    month,
    reason,
  }),

  expired: (customerId: string, plan: string, months: number): CycleResult => ({
    customerId,
    end: "Expired",
    plan,
    monthsPaid: months,
    totalCharged: paid(plan, months),
    month: months,
    reason: null,
  }),
};

export type CustomerStage =
  "TrialStarted" | "TrialEnded" | "Subscribed" | "Retrying" | "Suspended" | "Cancelled" | "Expired" | "Failed";

/** Progress reported by the worker to the web app. Subscribing and cancelling go straight to skail. */
export interface CustomerEvent {
  customerId: string;
  stage: CustomerStage;
  plan?: string | null;
  month?: number | null;
  reason?: string | null;
  result?: CycleResult | null;
  error?: string | null;
}

export const CustomerEvent = {
  trialStarted: (customerId: string): CustomerEvent => ({ customerId, stage: "TrialStarted" }),
  trialEnded: (customerId: string, result: CycleResult): CustomerEvent => ({ customerId, stage: "TrialEnded", result }),
  subscribed: (customerId: string, plan: string): CustomerEvent => ({ customerId, stage: "Subscribed", plan }),
  retrying: (customerId: string, month: number, reason: string): CustomerEvent => ({
    customerId,
    stage: "Retrying",
    month,
    reason,
  }),
  suspended: (customerId: string, result: CycleResult): CustomerEvent => ({ customerId, stage: "Suspended", result }),
  cancelled: (customerId: string, result: CycleResult): CustomerEvent => ({ customerId, stage: "Cancelled", result }),
  expired: (customerId: string, result: CycleResult): CustomerEvent => ({ customerId, stage: "Expired", result }),
  failed: (customerId: string, error: string): CustomerEvent => ({ customerId, stage: "Failed", error }),
};

// ---- web view (what GET /api/customers/{id} and the SSE stream return) ----

export type CustomerPhase =
  "Starting" | "Trial" | "Subscribed" | "Declined" | "Ended" | "Cancelled" | "Suspended" | "Expired" | "Failed";

export interface TimelineEntry {
  kind: string;
  month: number | null;
  attempt: number | null;
  text: string;
  at: string;
}

export interface CustomerState {
  customerId: string;
  name: string;
  plan: string;
  card: string;
  trialSeconds: number;
  monthSeconds: number;
  phase: CustomerPhase;
  month: number;
  totalCharged: number;
  /** A subscribe / cancel click was accepted (the event was fired): the buttons are one-shot. */
  subscribeRequested: boolean;
  cancelRequested: boolean;
  /** ISO 8601, stamped when the worker reports TrialStarted: the page countdown reads it. */
  trialStartedAt: string | null;
  timeline: TimelineEntry[];
  result: CycleResult | null;
  error: string | null;
}

export interface CustomerView extends CustomerState {
  active: boolean;
}

export interface AppConfig {
  defaultName: string;
  defaultTrialSeconds: number;
  defaultMonthSeconds: number;
  monitorUrl: string | null;
}

export function isTerminalPhase(phase: CustomerPhase): boolean {
  return (
    phase === "Ended" || phase === "Cancelled" || phase === "Suspended" || phase === "Expired" || phase === "Failed"
  );
}

export interface UiState {
  label: string;
  enabled: boolean;
}

/** The form is available only when there is no customer in progress. */
export function startState(customer: Pick<CustomerState, "phase"> | undefined): UiState {
  return { label: "Start trial", enabled: !customer || isTerminalPhase(customer.phase) };
}
