import type { UiState } from "@skail-subscription-cycle/contracts";

export interface FormValues {
  name: string;
  plan: string;
  trialSeconds: number;
  monthSeconds: number;
  card: string;
}

interface Props {
  values: FormValues;
  ui: UiState;
  busy: boolean;
  /** The server default name, shown while the field is empty. */
  namePlaceholder: string;
  onChange: (values: FormValues) => void;
  onStart: () => void;
}

export function CustomerForm({ values, ui, busy, namePlaceholder, onChange, onStart }: Props) {
  const disabled = !ui.enabled || busy;
  const set = (patch: Partial<FormValues>) => onChange({ ...values, ...patch });
  const seconds = (v: string) => Math.max(1, Math.floor(Number(v)) || 1);
  return (
    <section className="form">
      <label>
        Customer
        <input
          id="name"
          type="text"
          maxLength={80}
          value={values.name}
          disabled={disabled}
          placeholder={namePlaceholder}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        Plan
        <select id="plan" value={values.plan} disabled={disabled} onChange={(e) => set({ plan: e.target.value })}>
          <option value="basic">basic · R$ 29.90</option>
          <option value="pro">pro · R$ 79.90</option>
        </select>
      </label>
      <label>
        Trial (seconds)
        <input
          id="trial"
          type="number"
          min={1}
          value={values.trialSeconds}
          disabled={disabled}
          onChange={(e) => set({ trialSeconds: seconds(e.target.value) })}
        />
      </label>
      <label>
        Month (seconds)
        <input
          id="month"
          type="number"
          min={1}
          value={values.monthSeconds}
          disabled={disabled}
          onChange={(e) => set({ monthSeconds: seconds(e.target.value) })}
        />
      </label>
      <label>
        Card
        <select id="card" value={values.card} disabled={disabled} onChange={(e) => set({ card: e.target.value })}>
          <option value="approved">approved</option>
          <option value="declined-once">declined once</option>
          <option value="always-declined">always declined</option>
        </select>
      </label>
      <button id="start" type="button" disabled={disabled} onClick={onStart}>
        {ui.label}
      </button>
    </section>
  );
}
