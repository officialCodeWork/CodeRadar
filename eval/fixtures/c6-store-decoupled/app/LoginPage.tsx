import { useEffect } from "react";
import { useDispatch } from "react-redux";

import { fetchUsers } from "./store/usersSlice";

export function LoginPage() {
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(fetchUsers());
  }, [dispatch]);

  return (
    <main>
      <h1>Welcome back</h1>
    </main>
  );
}
