import { useQuery } from "@apollo/client";

import { GET_USERS } from "./queries";

// Apollo useQuery with an imported gql const → graphql data source "GetUsers".
export function UsersPanel() {
  const { data } = useQuery(GET_USERS);
  return (
    <section>
      <h2>User directory</h2>
      <ul>{data?.users?.map((u: { id: string; name: string }) => <li key={u.id}>{u.name}</li>)}</ul>
    </section>
  );
}
