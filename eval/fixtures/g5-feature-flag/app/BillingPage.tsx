import { useNavigate } from "react-router-dom";

import { BetaBanner } from "./BetaBanner";
import { isEnabled } from "./flags";

export function BillingPage({ role }: { role: string }) {
  const navigate = useNavigate();

  return (
    <section>
      <h1>Billing</h1>

      {/* Flag-gated child component → renders edge carries the flag condition. */}
      {isEnabled("beta-banner") && <BetaBanner />}

      {/* Flag-gated action → handles edge (and its journey step) carries the flag. */}
      {isEnabled("new-billing") && (
        <button onClick={() => navigate("/billing/new")}>Try new billing</button>
      )}

      {/* Role-gated action → handles edge carries a role condition. */}
      {role === "admin" && (
        <button onClick={() => fetch("/api/billing/reset", { method: "POST" })}>
          Reset billing
        </button>
      )}
    </section>
  );
}
