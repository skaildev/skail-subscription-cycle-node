import type { AppConfig, CustomerView } from "@skail-subscription-cycle/contracts";

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${res.status}`);
}

async function post(url: string, body?: unknown): Promise<CustomerView> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export interface StartInput {
  name: string;
  plan: string;
  trialSeconds: number;
  monthSeconds: number;
  card: string;
}

export const startCustomer = (input: StartInput) => post("/api/customers", input);
// the plan comes from the form
export const subscribe = (customerId: string, plan: string) => post(`/api/customers/${customerId}/subscribe`, { plan });
export const cancel = (customerId: string) => post(`/api/customers/${customerId}/cancel`, {});

export async function getCustomer(customerId: string): Promise<CustomerView | null> {
  const res = await fetch(`/api/customers/${customerId}`);
  return res.ok ? res.json() : null;
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw await failure(res);
  return res.json();
}
