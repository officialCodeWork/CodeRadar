import { useEffect, useState } from "react";

// A hand-authored component: a screenshot/ticket for its text must resolve here,
// and it must not be crowded out by the generated components alongside it.
export function RevenuePanel() {
  const [rows, setRows] = useState<Record<string, number>[]>([]);

  useEffect(() => {
    fetch("/api/revenue")
      .then((res) => res.json())
      .then(setRows);
  }, []);

  return (
    <section>
      <h2>Quarterly revenue breakdown</h2>
      <p>{rows.length} periods</p>
    </section>
  );
}
