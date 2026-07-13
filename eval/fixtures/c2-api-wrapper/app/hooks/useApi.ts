import { apiClient } from "../api/client";

/** Thin data hook — the third wrapper layer: useApi → apiClient.get → request → fetch. */
export function useApi(path: string) {
  return apiClient.get(path);
}
