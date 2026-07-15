import { renderWithProviders } from "../test-utils";
import UsersPage from "../pages/UsersPage";

it("renders the team directory", () => {
  renderWithProviders(<UsersPage />);
});
