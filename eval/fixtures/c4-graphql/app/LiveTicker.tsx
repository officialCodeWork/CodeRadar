import { gql, useSubscription } from "@apollo/client";

// Inline gql tagged template (not a const) with a subscription operation →
// graphql data source "OnTick" (method: subscription).
export function LiveTicker() {
  const { data } = useSubscription(
    gql`
      subscription OnTick {
        tick {
          at
        }
      }
    `,
  );
  return (
    <div>
      <h3>Live updates</h3>
      <span>{data?.tick?.at ?? "waiting"}</span>
    </div>
  );
}
