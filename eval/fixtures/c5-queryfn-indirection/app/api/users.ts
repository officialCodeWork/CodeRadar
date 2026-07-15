export async function fetchUsers() {
  const res = await fetch("/api/users");
  return res.json();
}

export async function createUser(body: { name: string }) {
  const res = await fetch("/api/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

export const fetchTeam = async () => {
  const res = await fetch("/api/team");
  return res.json();
};
