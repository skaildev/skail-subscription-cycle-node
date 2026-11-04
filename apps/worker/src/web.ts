import type { Charge, CustomerEvent } from "@skail-subscription-cycle/contracts";
import { Cards, chargeFor } from "@skail-subscription-cycle/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProgressNotifier {
  notify(event: CustomerEvent): Promise<void>;
}

/** The simulated card network: asks for the charge of a month and attempt. A decline is a result, not an error. */
export interface Billing {
  charge(customerId: string, plan: string, month: number, attempt: number): Promise<Charge>;
}

const join = (baseUrl: string, path: string) => `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}${path}`;

/** Reports progress to the web app: POST {web}/internal/customers/{id}/events. */
export class HttpProgressNotifier implements ProgressNotifier {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async notify(event: CustomerEvent): Promise<void> {
    const response = await this.fetchImpl(
      join(this.baseUrl, `internal/customers/${encodeURIComponent(event.customerId)}/events`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      },
    );
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the progress event`);
  }
}

/** Asks the web app (the card network) for the charge: POST {web}/internal/customers/{id}/charges. */
export class HttpBilling implements Billing {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async charge(customerId: string, plan: string, month: number, attempt: number): Promise<Charge> {
    const response = await this.fetchImpl(
      join(this.baseUrl, `internal/customers/${encodeURIComponent(customerId)}/charges`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, month, attempt }),
      },
    );
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the charge`);
    return (await response.json()) as Charge;
  }
}

/** Offline notifier (NOTIFY_PROVIDER=fake): drops the events. */
export class FakeProgressNotifier implements ProgressNotifier {
  async notify(): Promise<void> {}
}

/** Offline billing (NOTIFY_PROVIDER=fake): the simulated card network with an approved card. */
export class FakeBilling implements Billing {
  async charge(_customerId: string, plan: string, _month: number, attempt: number): Promise<Charge> {
    return chargeFor(Cards.approved, plan, attempt);
  }
}
