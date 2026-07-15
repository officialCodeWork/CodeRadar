import { Grid } from "@ui";

import { useGetUsersQuery } from "@store/api/usersApi";

export function UsersPage() {
  const { data } = useGetUsersQuery();
  return (
    <section>
      <h1>Team directory</h1>
      <Grid rows={data ?? []} />
    </section>
  );
}

export default UsersPage;
