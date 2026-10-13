// PayPal Orders v2 in the sandbox: create an order for one person's share, capture it after approval.

export const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";
export const MAX_SHARE_EUR = 300;

type Fetch = typeof fetch;

export function validShare(amount: unknown): number | null {
  const n = Math.round(Number(amount) * 100) / 100;
  return Number.isFinite(n) && n >= 1 && n <= MAX_SHARE_EUR ? n : null;
}

export interface Receipt {
  orderId: string;
  status: string;
  captureId?: string;
  captureStatus?: string;
  amount?: string;
  currency?: string;
  description?: string;
  createdAt?: string;
  paidAt?: string;
  method?: string;
}

/** The parts of a PayPal order worth showing on a receipt (no personal data). */
export function toReceipt(order: any): Receipt {
  const unit = order?.purchase_units?.[0] ?? {};
  const capture = unit.payments?.captures?.[0];
  const card = order?.payment_source?.card;
  return {
    orderId: order?.id,
    status: order?.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    amount: capture?.amount?.value ?? unit.amount?.value,
    currency: capture?.amount?.currency_code ?? unit.amount?.currency_code,
    description: unit.description,
    createdAt: order?.create_time,
    paidAt: capture?.create_time ?? order?.update_time,
    method: card ? `${card.brand ?? "Card"} ···· ${card.last_digits ?? ""}`.trim() : order?.payment_source?.paypal ? "PayPal" : undefined,
  };
}

export class PayPalSandbox {
  constructor(
    private clientId: string,
    private secret: string,
    private fetchImpl: Fetch = fetch,
    private base = PAYPAL_SANDBOX,
  ) {
    if (!clientId || !secret) throw new Error("PayPal sandbox credentials are not set");
  }

  private async token(): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`PayPal token failed: HTTP ${res.status}`);
    return ((await res.json()) as any).access_token;
  }

  async createOrder(amount: number, description: string): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "EUR", value: amount.toFixed(2) }, description: description.slice(0, 120) }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`PayPal create order failed: HTTP ${res.status}`);
    return ((await res.json()) as any).id;
  }

  async capture(orderId: string): Promise<Receipt> {
    if (!/^[A-Z0-9]{8,30}$/.test(orderId)) throw new Error("Invalid order id");
    const res = await this.fetchImpl(`${this.base}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`PayPal capture failed: HTTP ${res.status}`);
    return toReceipt(body);
  }

  /** Live status of an order, straight from PayPal (used by the receipt page). */
  async order(orderId: string): Promise<Receipt> {
    if (!/^[A-Z0-9]{8,30}$/.test(orderId)) throw new Error("Invalid order id");
    const res = await this.fetchImpl(`${this.base}/v2/checkout/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) throw new Error("Order not found");
    if (!res.ok) throw new Error(`PayPal order lookup failed: HTTP ${res.status}`);
    return toReceipt(await res.json());
  }
}
