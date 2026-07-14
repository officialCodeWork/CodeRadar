import { useEffect, useState } from "react";

import { HEALTH_URL } from "./api/endpoints";

export function HealthBadge() {
  const [status, setStatus] = useState("unknown");

  useEffect(() => {
    fetch(HEALTH_URL)
      .then((res) => res.json())
      .then((body: { status: string }) => setStatus(body.status));
  }, []);

  return <span title="System status">{status}</span>;
}
