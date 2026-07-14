import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<unknown[]>([]);
  useEffect(() => {
    fetch("/api/metrics").then((r) => r.json()).then(setMetrics);
  }, []);
  return (
    <main>
      <h2>Key metrics</h2>
      <div>{metrics.length}</div>
    </main>
  );
}
