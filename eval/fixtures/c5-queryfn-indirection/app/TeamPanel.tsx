import { useQuery } from "react-query";

import { fetchTeam } from "./api/users";

/** Legacy v3 positional form. */
export function TeamPanel() {
  const { data } = useQuery(["team"], fetchTeam);

  return (
    <aside>
      <h3>Team roster</h3>
      <ul>{data?.map((m: string) => <li key={m}>{m}</li>)}</ul>
    </aside>
  );
}
