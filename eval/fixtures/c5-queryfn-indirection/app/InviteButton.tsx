import { useMutation } from "@tanstack/react-query";

import { createUser } from "./api/users";

export function InviteButton() {
  const mutation = useMutation({ mutationFn: createUser });

  return (
    <button onClick={() => mutation.mutate({ name: "New teammate" })}>Invite user</button>
  );
}
