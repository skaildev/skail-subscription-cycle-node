// Types of the demo. This file ends up inside the skail bundle: pure code only, no Node imports.

/** The plans, as plain strings (they travel in the payload of an event), each with a monthly price. */
export const Plans = { basic: "basic", pro: "pro" } as const;
export const price = (plan: string) => (plan === Plans.pro ? 79.9 : 29.9);

/** External event names, shared by the function (waitForEvent) and the console (fire). */
export const Events = {
  customerSubscribed: "CUSTOMER_SUBSCRIBED",
  subscriptionCancelled: "SUBSCRIPTION_CANCELLED",
} as const;

/**
 * The simulated cards. The answer of the card network depends only on the card and the attempt, so a technical retry
 * of the command gets the same answer.
 */
export const Cards = {
  approved: "approved",
  declinedOnce: "declined-once",
  alwaysDeclined: "always-declined",
} as const;
export const allCards: readonly string[] = Object.values(Cards);

export function isApproved(card: string, attempt: number): boolean {
  if (card === Cards.declinedOnce) return attempt > 1;
  return card !== Cards.alwaysDeclined;
}

/** The customer subscribed: payload of CUSTOMER_SUBSCRIBED. `at` is stamped by whoever fires the event. */
export interface Subscription {
  plan: string;
  at: string;
}

/** The customer cancelled: payload of SUBSCRIPTION_CANCELLED. */
export interface Cancellation {
  reason: string | null;
  at: string;
}

/** Result of one charge attempt: a decline is a result, not an error. */
export interface Charge {
  approved: boolean;
  reason: string | null;
  amount: number;
}

/** Skail.whenAny returns the value of the winner: the payload for an event, undefined for a delay. */
export function isEvent<T>(winner: unknown): winner is T {
  return winner !== undefined && winner !== null;
}
