import type { Config } from "@netlify/functions";
import { json } from "../../src/server.ts";

// Public, browser-safe settings only (the PayPal client id is public by design).
export default () => json({ paypalClientId: process.env.PAYPAL_CLIENT_ID ?? null, sandbox: true });

export const config: Config = { path: "/api/config" };
