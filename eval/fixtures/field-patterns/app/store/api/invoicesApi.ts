import { baseApi } from "./baseApi";

export const invoicesApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listInvoices: builder.query<string[], void>({
      query: () => ({ url: "/invoices" }),
    }),
    payInvoice: builder.mutation<void, string>({
      query: (id) => ({ url: `/invoices/${id}/pay`, method: "POST" }),
    }),
  }),
});

export const { useListInvoicesQuery, usePayInvoiceMutation } = invoicesApi;
