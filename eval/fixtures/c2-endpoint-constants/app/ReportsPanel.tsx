import { useEffect, useState } from "react";

import { API_PREFIX } from "./api/endpoints";

export function ReportsPanel() {
  const [reports, setReports] = useState<string[]>([]);

  useEffect(() => {
    fetch(API_PREFIX + "/reports")
      .then((res) => res.json())
      .then(setReports);
  }, []);

  return (
    <section>
      <h2>Weekly reports</h2>
      <ul>
        {reports.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </section>
  );
}
