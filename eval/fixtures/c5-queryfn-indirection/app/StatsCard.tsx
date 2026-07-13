import { useQuery } from "@tanstack/react-query";

export function StatsCard() {
  const { data } = useQuery({
    queryKey: ["stats"],
    queryFn: () => fetch("/api/stats").then((r) => r.json()),
  });

  return (
    <div>
      <h4>Weekly stats</h4>
      <strong>{data?.total}</strong>
    </div>
  );
}
