import { useEffect, useState } from "react";

export function useMembers() {
  const [members, setMembers] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/members")
      .then((res) => res.json())
      .then(setMembers);
  }, []);
  return { members };
}
