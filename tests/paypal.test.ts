import { describe, expect, it } from "vitest";
import { PayPalSandbox, toReceipt, validShare } from "../src/paypal.ts";

describe("toReceipt", () => {
  it("keeps the order, capture, amount and masked card, nothing personal", () => {
    const r = toReceipt({
      id: "7FD86652UN573413X", status: "COMPLETED", create_time: "2026-10-13T09:00:00Z",
      payment_source: { card: { brand: "VISA", last_digits: "1234", name: "Test Buyer" } },
      purchase_units: [{ description: "TastePay share", amount: { value: "40.00", currency_code: "EUR" },
        payments: { captures: [{ id: "CAP123", status: "COMPLETED", amount: { value: "40.00", currency_code: "EUR" }, create_time: "2026-10-13T09:00:05Z" }] } }],
    });
    expect(r).toMatchObject({ orderId: "7FD86652UN573413X", captureId: "CAP123", captureStatus: "COMPLETED", amount: "40.00", currency: "EUR", method: "VISA ···· 1234" });
    expect(JSON.stringify(r)).not.toContain("Test Buyer");
  });
});

describe("PayPalSandbox", () => {
  it("rejects malformed order ids before calling PayPal", async () => {
    const pp = new PayPalSandbox("id", "secret", (async () => { throw new Error("should not be called"); }) as typeof fetch);
    await expect(pp.order("../../v1/oauth2")).rejects.toThrow(/Invalid order id/);
  });
  it("accepts shares between 1 and 300 EUR", () => {
    expect([0, 1, 40.555, 300, 301].map(validShare)).toEqual([null, 1, 40.56, 300, null]);
  });
});
