import { useQuery } from "@tanstack/react-query";

import { fetchUsers } from "./api/users";

export function UsersDashboard() {
  const { data } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });

  return (
    <section>
      <h2>Active users</h2>
      <p>{data?.length ?? 0} online</p>
    </section>
  );
}
