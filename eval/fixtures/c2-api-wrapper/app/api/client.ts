const API_BASE = "/api";

async function request(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

export const apiClient = {
  get(path: string) {
    return request(path);
  },
  post(path: string, body: unknown) {
    return request(path, { method: "POST", body: JSON.stringify(body) });
  },
};
