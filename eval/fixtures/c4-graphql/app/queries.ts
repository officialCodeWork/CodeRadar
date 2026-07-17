import { gql } from "@apollo/client";

// GraphQL operations defined as gql consts and imported by the components that
// run them — the common Apollo/urql pattern. The operation NAME is the data
// source identity; a component that runs it gets a fetches-from edge.
export const GET_USERS = gql`
  query GetUsers {
    users {
      id
      name
    }
  }
`;

export const CREATE_USER = gql`
  mutation CreateUser($input: UserInput!) {
    createUser(input: $input) {
      id
    }
  }
`;
