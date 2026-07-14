import { createSlice } from "@reduxjs/toolkit";

const cartSlice = createSlice({
  name: "cart",
  initialState: { items: [] as string[] },
  reducers: {
    // A plain reducer action: dispatch(clearCart()) writes this slice.
    clearCart(state) {
      state.items = [];
    },
    addItem(state, action) {
      state.items.push(action.payload);
    },
  },
});

export const { clearCart, addItem } = cartSlice.actions;
export default cartSlice.reducer;
