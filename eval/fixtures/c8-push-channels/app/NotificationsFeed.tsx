import { useEffect, useState } from "react";

// Server-Sent Events push channel → sse data source.
export function NotificationsFeed() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const source = new EventSource("/api/notifications/stream");
    source.onmessage = () => setCount((c) => c + 1);
    return () => source.close();
  }, []);
  return (
    <aside>
      <h3>Live notifications</h3>
      <span>{count} unread</span>
    </aside>
  );
}
