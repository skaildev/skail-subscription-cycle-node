import { useEffect } from "react";
import { isTerminalPhase, type CustomerView } from "@skail-subscription-cycle/contracts";

/**
 * Follows a customer through SSE. EventSource reconnects by itself and the stream starts with the current
 * snapshot, so no update is lost. Closes at a terminal phase.
 */
export function useCustomerStream(
  customerId: string | undefined,
  onState: (customer: CustomerView) => void,
  onTerminal: () => void,
) {
  useEffect(() => {
    if (!customerId) return;
    const source = new EventSource(`/api/customers/${customerId}/stream`);
    source.onmessage = (event) => {
      const customer = JSON.parse(event.data) as CustomerView;
      onState(customer);
      if (isTerminalPhase(customer.phase)) {
        source.close();
        onTerminal();
      }
    };
    return () => source.close();
    // callbacks are stable (state setters); the stream only depends on the customer id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
}
