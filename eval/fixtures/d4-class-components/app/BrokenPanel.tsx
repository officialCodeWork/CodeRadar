import { Component } from "react";

/** No render() — must degrade to an `incomplete`-flagged node, never vanish. */
export class BrokenPanel extends Component {
  helper() {
    return "not a render method";
  }
}
