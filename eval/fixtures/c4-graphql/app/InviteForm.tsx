import { useMutation } from "@apollo/client";

import { CREATE_USER } from "./queries";

// Apollo useMutation with an imported gql const → graphql data source
// "CreateUser" (method: mutation). Shares the useMutation name with react-query,
// but the gql argument makes it a GraphQL source, not a react-query one.
export function InviteForm() {
  const [createUser] = useMutation(CREATE_USER);
  return (
    <form onSubmit={() => createUser({ variables: { input: {} } })}>
      <h3>Invite teammate</h3>
      <button type="submit">Send invite</button>
    </form>
  );
}
