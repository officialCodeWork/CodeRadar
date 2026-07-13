import React from "react";

interface OrdersBoardState {
  orders: string[];
  failed: boolean;
}

export class OrdersBoard extends React.Component<Record<string, never>, OrdersBoardState> {
  state: OrdersBoardState = { orders: [], failed: false };

  componentDidMount() {
    fetch("/api/orders")
      .then((res) => res.json())
      .then((orders: string[]) => this.setState({ orders }))
      .catch(() => this.setState({ failed: true }));
  }

  refresh = () => {
    fetch("/api/orders")
      .then((res) => res.json())
      .then((orders: string[]) => this.setState({ orders }));
  };

  render() {
    if (this.state.failed) return <p>Orders unavailable</p>;
    return (
      <section>
        <h2>Orders board</h2>
        <ul>
          {this.state.orders.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        <button onClick={this.refresh}>Refresh orders</button>
      </section>
    );
  }
}
