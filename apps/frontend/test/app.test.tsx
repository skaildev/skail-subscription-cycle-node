import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CycleResult, isTerminalPhase, type CustomerView } from "@skail-subscription-cycle/contracts";
import { App } from "../src/App";

const view = (patch: Partial<CustomerView> = {}): CustomerView => {
  const c = {
    customerId: "customer-1",
    name: "Maria Silva",
    plan: "pro",
    card: "approved",
    trialSeconds: 20,
    monthSeconds: 10,
    trialStartedAt: null,
    phase: "Trial" as const,
    month: 0,
    totalCharged: 0,
    subscribeRequested: false,
    cancelRequested: false,
    timeline: [],
    result: null,
    error: null,
    ...patch,
  };
  return { ...c, active: !isTerminalPhase(c.phase) };
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: CustomerView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; method: string; body?: string }>;
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = {
    "GET /api/config": () =>
      json({ defaultName: "Demo Customer", defaultTrialSeconds: 20, defaultMonthSeconds: 10, monitorUrl: null }),
  };
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startedPage(initial: CustomerView) {
  answers["POST /api/customers"] = () => json(initial);
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Start trial" }));
  await screen.findByText("customer-1");
  return user;
}

describe("form", () => {
  it("shows the defaults from /api/config and the idle state", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Trial (seconds)")).toHaveValue(20));
    expect(screen.getByLabelText("Customer")).toHaveValue(""); // empty: the server default is only the placeholder
    expect(screen.getByLabelText("Customer")).toHaveAttribute("placeholder", "Demo Customer");
    expect(screen.getByLabelText("Month (seconds)")).toHaveValue(10);
    expect(screen.getByLabelText("Plan")).toHaveValue("basic");
    expect(screen.getByLabelText("Card")).toHaveValue("approved");
    expect(screen.getByText("Idle")).toBeInTheDocument();
    // both actions are always there, disabled until they apply
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeDisabled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Trial and recurring billing");
    expect(screen.getByText("basic · R$ 29.90")).toBeInTheDocument();
  });

  it("starts the trial with the form values and disables the form while the customer is active", async () => {
    answers["POST /api/customers"] = () => json(view({ phase: "Starting" }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Trial (seconds)")).toHaveValue(20));
    await user.selectOptions(screen.getByLabelText("Plan"), "pro");
    await user.selectOptions(screen.getByLabelText("Card"), "declined-once");
    await user.click(screen.getByRole("button", { name: "Start trial" }));

    await screen.findByText("customer-1");
    const post = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({
      name: "",
      plan: "pro",
      trialSeconds: 20,
      monthSeconds: 10,
      card: "declined-once",
    });
    expect(screen.getByRole("button", { name: "Start trial" })).toBeDisabled(); // same label
    expect(screen.getByLabelText("Customer")).toBeDisabled();
    expect(localStorage.getItem("subscription-cycle.customerId")).toBe("customer-1");
  });

  it("fills the form with what the server stored (a blank name becomes the default)", async () => {
    answers["POST /api/customers"] = () =>
      json(
        view({
          phase: "Starting",
          name: "Demo Customer",
          plan: "pro",
          card: "declined-once",
          trialSeconds: 33,
          monthSeconds: 7,
        }),
      );
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start trial" }));
    await waitFor(() => expect(screen.getByLabelText("Customer")).toHaveValue("Demo Customer"));
    expect(screen.getByLabelText("Plan")).toHaveValue("pro");
    expect(screen.getByLabelText("Card")).toHaveValue("declined-once");
    expect(screen.getByLabelText("Trial (seconds)")).toHaveValue(33);
    expect(screen.getByLabelText("Month (seconds)")).toHaveValue(7);
  });

  it("shows the error when the trigger fails", async () => {
    answers["POST /api/customers"] = () => json({ error: "skail down" }, 502);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start trial" }));
    expect(await screen.findByText(/skail down/)).toBeInTheDocument();
  });
});

describe("trial and subscription buttons", () => {
  it("Subscribe is available only during the trial and posts to /subscribe", async () => {
    const user = await startedPage(view({ phase: "Starting" }));
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();

    FakeEventSource.instances[0]!.emit(view({ phase: "Trial" }));
    answers["POST /api/customers/customer-1/subscribe"] = () =>
      json(view({ phase: "Trial", subscribeRequested: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    const sent = calls.find((c) => c.url === "/api/customers/customer-1/subscribe" && c.method === "POST")!;
    expect(JSON.parse(sent.body!)).toEqual({ plan: "pro" }); // the form shows what the server holds, and Subscribe sends it
    await waitFor(() => expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled()); // one-shot
  });

  it("a failed subscribe shows the error and keeps the button for another try", async () => {
    const user = await startedPage(view({ phase: "Trial" }));
    answers["POST /api/customers/customer-1/subscribe"] = () => json({ error: "skail down" }, 502);
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText(/skail down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();
  });

  it("Cancel is enabled once subscribed (also while retrying), with the summary, and is one-shot", async () => {
    const user = await startedPage(view({ phase: "Trial" }));
    expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeDisabled();

    FakeEventSource.instances[0]!.emit(view({ phase: "Subscribed", month: 2, totalCharged: 159.8 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeEnabled());
    const summary = screen.getByLabelText("Summary");
    expect(summary).toHaveTextContent("Plan pro");
    expect(summary).toHaveTextContent("Month 2");
    expect(summary).toHaveTextContent("Total charged R$ 159.80");
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();

    FakeEventSource.instances[0]!.emit(view({ phase: "Declined", month: 3 }));
    expect(screen.getByText("Payment declined, retrying")).toBeInTheDocument();
    answers["POST /api/customers/customer-1/cancel"] = () => json(view({ phase: "Declined", cancelRequested: true }));
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeDisabled());
  });

  it("shows the trial countdown and 'Cancelling…' while a cancellation waits", async () => {
    await startedPage(view({ phase: "Trial", trialStartedAt: new Date().toISOString(), trialSeconds: 20 }));
    expect(await screen.findByText(/trial ends in \d+s/)).toBeInTheDocument();
    FakeEventSource.instances[0]!.emit(view({ phase: "Subscribed", cancelRequested: true }));
    expect(await screen.findByText("Cancelling…")).toBeInTheDocument();
    expect(screen.queryByText(/trial ends in/)).not.toBeInTheDocument();
  });
});

describe("result and timeline", () => {
  it.each([
    ["Ended", CycleResult.ended("customer-1"), /Trial ended without a subscription · nothing was charged/],
    [
      "Cancelled",
      CycleResult.cancelled("customer-1", "pro", 2),
      /Cancelled · 2 month\(s\) paid, R\$ 159\.80 · no further charge/,
    ],
    [
      "Suspended",
      CycleResult.suspended("customer-1", "pro", 3, "card declined by the issuer"),
      /Suspended at month 3: card declined by the issuer · 2 month\(s\) paid/,
    ],
    ["Expired", CycleResult.expired("customer-1", "pro", 12), /Reached the month limit · 12 month\(s\) paid/],
  ] as const)("highlights %s and re-enables the form", async (phase, result, text) => {
    await startedPage(view({ phase: "Subscribed" }));
    FakeEventSource.instances[0]!.emit(
      view({
        phase,
        result,
        timeline: [{ kind: phase, month: null, attempt: null, text: `entry ${phase}`, at: "2026-01-01T10:00:00.000Z" }],
      }),
    );

    expect(await screen.findByRole("status", { name: "Result" })).toHaveTextContent(text);
    expect(screen.getByText(`entry ${phase}`, { exact: false })).toHaveClass(phase); // class = kind
    expect(screen.getByRole("button", { name: "Start trial" })).toBeEnabled();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(localStorage.getItem("subscription-cycle.customerId")).toBeNull();
  });

  it("shows a Failed error", async () => {
    await startedPage(view({ phase: "Trial" }));
    FakeEventSource.instances[0]!.emit(view({ phase: "Failed", error: "boom" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});

describe("reload", () => {
  it("restores an active customer from localStorage and reconnects the stream", async () => {
    localStorage.setItem("subscription-cycle.customerId", "customer-1");
    answers["GET /api/customers/customer-1"] = () =>
      json(view({ phase: "Subscribed", month: 1, subscribeRequested: true }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeEnabled());
    expect(FakeEventSource.instances[0]!.url).toBe("/api/customers/customer-1/stream");
  });

  it("forgets an unknown or finished customer", async () => {
    localStorage.setItem("subscription-cycle.customerId", "customer-1");
    answers["GET /api/customers/customer-1"] = () => new Response(null, { status: 404 });
    render(<App />);
    await waitFor(() => expect(localStorage.getItem("subscription-cycle.customerId")).toBeNull());
    expect(screen.getByRole("button", { name: "Start trial" })).toBeEnabled();
  });
});
