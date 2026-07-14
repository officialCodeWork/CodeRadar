import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";

// Thunk: the fetch lives here; dispatch(fetchUsers()) in a handler triggers it.
export const fetchUsers = createAsyncThunk("users/fetch", async () => {
  const res = await fetch("/api/users");
  return res.json();
});

const usersSlice = createSlice({
  name: "users",
  initialState: { list: [] as string[] },
  reducers: {
    selectUser(state, action) {
      (state as { selected?: string }).selected = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchUsers.fulfilled, (state, action) => {
      state.list = action.payload;
    });
  },
});

export const { selectUser } = usersSlice.actions;
export default usersSlice.reducer;
