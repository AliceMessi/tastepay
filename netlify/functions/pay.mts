import type { Config } from "@netlify/functions";
import { PayPalSandbox, validShare } from "../../src/paypal.ts";
import { handle, json, rateLimited, readJson } from "../../src/server.ts";

// Sandbox only: create an order for one person's share, or capture it after approval.
export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ action?: string; amount?: number; description?: string; orderId?: string }>(req);
    if (!body) return json({ error: "Bad request" }, 400);
    if (rateLimited(req, "pay", 60)) return json({ error: "Too many payments from this address." }, 429);
    const paypal = new PayPalSandbox(process.env.PAYPAL_CLIENT_ID ?? "", process.env.PAYPAL_CLIENT_SECRET ?? "");
    if (body.action === "create") {
      const amount = validShare(body.amount);
      if (!amount) return json({ error: "Share must be between €1 and €300" }, 400);
      return json({ id: await paypal.createOrder(amount, `TastePay share: ${String(body.description ?? "group plan")}`) });
    }
    if (body.action === "capture" && body.orderId) return json(await paypal.capture(body.orderId));
    return json({ error: "Unknown action" }, 400);
  });

export const config: Config = { path: "/api/pay" };
