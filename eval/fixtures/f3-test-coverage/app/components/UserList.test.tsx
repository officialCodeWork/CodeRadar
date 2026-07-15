import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserList } from "./UserList";

describe("UserList", () => {
  it("renders the users", () => {
    render(<UserList />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });
});
