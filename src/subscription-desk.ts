import { randomUUID } from "node:crypto";
import { Cards, Events, Plans, allCards } from "./model.js";
import type { SkailApiClient } from "./skail-api.js";
import type { Timeline, TimelineEntry } from "./timeline.js";

/** The trial and the month last seconds in the demo; a real subscription uses 30 days and one month. */
export const TRIAL_SECONDS = 20;
export const MONTH_SECONDS = 10;

/**
 * Plays the customer for the page: it starts the trial with the chosen card and turns the buttons into the
 * subscription and the cancellation events. It follows one customer at a time, the last one started (or the one given
 * on the command line). It also keeps the card on file, which the charge command asks for by customer id.
 */
export class SubscriptionDesk {
  private readonly cards = new Map<string, string>();
  private customerId: string | null = null;
  private startedAt: number | null = null;
  private subscribed = false;
  private cancelled = false;

  constructor(
    private readonly skail: SkailApiClient,
    private readonly timeline: Timeline,
  ) {}

  cardFor(customerId: string): string {
    return this.cards.get(customerId) ?? Cards.approved;
  }

  /** Follows a customer that already exists, to see it resume. */
  follow(id: string, card: string): void {
    this.cards.set(id, card);
    this.customerId = id;
    this.startedAt = null;
    this.subscribed = this.cancelled = false;
  }

  async start(card: string): Promise<string | null> {
    if (!allCards.includes(card)) return null;
    const id = randomUUID();
    this.cards.set(id, card);
    await this.skail.trigger(id, TRIAL_SECONDS, MONTH_SECONDS);
    this.customerId = id;
    this.startedAt = Date.now();
    this.subscribed = this.cancelled = false;
    return id;
  }

  /** Subscribes during the trial. Only once. */
  async subscribe(plan: string): Promise<boolean> {
    const id = this.customerId;
    if (!id || this.subscribed || (plan !== Plans.basic && plan !== Plans.pro) || this.ended(id)) return false;
    this.subscribed = true;
    await this.skail.fire(Events.customerSubscribed, id, { plan, at: new Date().toISOString() });
    this.timeline.add(id, `subscribed to ${plan}: ${Events.customerSubscribed} sent`, "sent:subscribe");
    return true;
  }

  /** Cancels after the subscription. Only once. */
  async cancel(): Promise<boolean> {
    const id = this.customerId;
    if (!id || !this.subscribed || this.cancelled || this.ended(id)) return false;
    this.cancelled = true;
    await this.skail.fire(Events.subscriptionCancelled, id, {
      reason: "cancelled in the demo",
      at: new Date().toISOString(),
    });
    this.timeline.add(id, `cancelled: ${Events.subscriptionCancelled} sent`, "sent:cancel");
    return true;
  }

  /** What the page shows: the customer, what can be done now and the timeline of the run. */
  view(): unknown {
    const id = this.customerId;
    if (!id) return { customer: null };

    const entries = this.timeline.for(id);
    const end = lastStep(entries, "end:");
    const plan = lastStep(entries, "subscribed:");
    const inTrial = end === null && plan === null && !this.subscribed;
    return {
      customer: {
        id,
        card: this.cardFor(id),
        plan,
        monthsPaid: entries.filter((e) => e.step?.startsWith("charged:")).length,
        trialEnds: inTrial && this.startedAt ? new Date(this.startedAt + TRIAL_SECONDS * 1000).toISOString() : null,
        end,
      },
      canSubscribe: inTrial,
      canCancel: end === null && this.subscribed && !this.cancelled,
      timeline: entries.map((e) => ({ at: e.at, text: e.text })),
    };
  }

  private ended(id: string): boolean {
    return lastStep(this.timeline.for(id), "end:") !== null;
  }
}

/** The value after the prefix of the last step that has it, or null. */
function lastStep(entries: TimelineEntry[], prefix: string): string | null {
  return (
    [...entries]
      .reverse()
      .find((e) => e.step?.startsWith(prefix))
      ?.step?.slice(prefix.length) ?? null
  );
}
