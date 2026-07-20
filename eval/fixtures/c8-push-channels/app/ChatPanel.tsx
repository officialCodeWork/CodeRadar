import { useEffect, useState } from "react";

// WebSocket push channel → websocket data source.
export function ChatPanel() {
  const [messages, setMessages] = useState<string[]>([]);
  useEffect(() => {
    const socket = new WebSocket("wss://chat.example.com/socket");
    socket.onmessage = (e) => setMessages((m) => [...m, e.data]);
    return () => socket.close();
  }, []);
  return (
    <section>
      <h2>Team chat</h2>
      <ul>{messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
    </section>
  );
}
