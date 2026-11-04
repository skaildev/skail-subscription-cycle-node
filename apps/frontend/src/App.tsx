import { useCallback, useEffect, useState } from "react";
import { CycleLimits, isTerminalPhase, startState, type CustomerView } from "@skail-subscription-cycle/contracts";
import { cancel, getConfig, getCustomer, startCustomer, subscribe } from "./api";
import { CustomerForm, type FormValues } from "./components/CustomerForm";
import { ResultBanner } from "./components/ResultBanner";
import { StatusBadge } from "./components/StatusBadge";
import { Summary } from "./components/Summary";
import { Timeline } from "./components/Timeline";
import { Countdown } from "./components/Countdown";
import { useCustomerStream } from "./hooks/useCustomerStream";

const KEY = "subscription-cycle.customerId";

const initialValues: FormValues = {
  name: "", // empty: the default name is only the placeholder, the server applies it
  plan: "basic",
  trialSeconds: CycleLimits.defaultTrialSeconds,
  monthSeconds: CycleLimits.defaultMonthSeconds,
  card: "approved",
};

export function App() {
  const [customer, setCustomer] = useState<CustomerView | undefined>();
  const [values, setValues] = useState<FormValues>(initialValues);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);
  const [defaultName, setDefaultName] = useState<string>(CycleLimits.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = useCallback(() => localStorage.removeItem(KEY), []);
  const active = customer && !isTerminalPhase(customer.phase) ? customer.customerId : undefined;
  useCustomerStream(active, setCustomer, forget);

  useEffect(() => {
    getConfig().then(
      (config) => {
        setMonitorUrl(config.monitorUrl);
        setDefaultName(config.defaultName);
        setValues((current) =>
          current === initialValues
            ? { ...current, trialSeconds: config.defaultTrialSeconds, monthSeconds: config.defaultMonthSeconds }
            : current,
        );
      },
      () => {},
    );
  }, []);

  // reload keeps the controls right: the state always comes from the server
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (!saved) return;
    getCustomer(saved).then((restored) => {
      if (!restored) return forget();
      setCustomer(restored);
      if (isTerminalPhase(restored.phase)) forget();
    }, forget);
  }, [forget]);

  // the form always shows what the server holds for the customer, e.g. the default name
  useEffect(() => {
    if (customer)
      setValues({
        name: customer.name,
        plan: customer.plan,
        trialSeconds: customer.trialSeconds,
        monthSeconds: customer.monthSeconds,
        card: customer.card,
      });
  }, [customer]);

  const ui = startState(customer);

  async function run(action: () => Promise<CustomerView>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setCustomer(next);
      return next;
    } catch (e) {
      setError(`${failure}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onStart() {
    const started = await run(() => startCustomer({ ...values, name: values.name.trim() }), "Could not start");
    if (started) localStorage.setItem(KEY, started.customerId);
  }

  const canSubscribe = !busy && customer?.phase === "Trial" && !customer.subscribeRequested;
  const canCancel =
    !busy && (customer?.phase === "Subscribed" || customer?.phase === "Declined") && !customer.cancelRequested;

  return (
    <main>
      <header>
        <h1>Trial and recurring billing</h1>
        <p className="subtitle">
          One skail function runs the whole life of a subscription: a trial that ends at the deadline or when the
          customer subscribes, then one charge per month, with one retry before suspending, until the customer cancels.
        </p>
      </header>

      <CustomerForm
        values={values}
        ui={ui}
        busy={busy}
        namePlaceholder={defaultName}
        onChange={setValues}
        onStart={onStart}
      />

      <section className="status">
        <StatusBadge customer={customer} />
        <Countdown customer={customer} />
        {monitorUrl && (
          <a href={monitorUrl} target="_blank" rel="noopener noreferrer">
            Open the skail Monitor
          </a>
        )}
      </section>

      {(error ?? customer?.error) && <p className="error">{error ?? customer?.error}</p>}
      {customer && <ResultBanner customer={customer} />}

      <Summary customer={customer} />

      <section className="buttons">
        <button
          type="button"
          disabled={!canSubscribe}
          onClick={() => customer && run(() => subscribe(customer.customerId, values.plan), "Could not subscribe")}
        >
          Subscribe
        </button>
        <button
          type="button"
          className="danger"
          disabled={!canCancel}
          onClick={() => customer && run(() => cancel(customer.customerId), "Could not cancel")}
        >
          Cancel subscription
        </button>
      </section>

      <section>
        <h2>Timeline</h2>
        <Timeline entries={customer?.timeline ?? []} />
      </section>

      <footer>
        Customer <code>{customer?.customerId ?? "-"}</code>
      </footer>
    </main>
  );
}
