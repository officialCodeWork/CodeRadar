import { Component } from "react";

export class UserBadge extends Component<{ name: string }> {
  render() {
    return (
      <span title="Current user">
        Signed in as <strong>{this.props.name}</strong>
      </span>
    );
  }
}
