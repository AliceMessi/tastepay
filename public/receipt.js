// Receipt page: shows an order's live status as reported by PayPal.
const order = new URLSearchParams(location.search).get("order") ?? "";
const title = document.getElementById("r-title");
const rows = document.getElementById("r-rows");

function row(label, value) {
  if (!value) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  rows.append(dt, dd);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : undefined);

try {
  const res = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", orderId: order }) });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error || "Order not found");
  const ok = r.captureStatus === "COMPLETED" || r.status === "COMPLETED";
  title.textContent = ok ? `Paid ✓ €${Number(r.amount).toFixed(2)}` : `Status: ${r.status}`;
  title.classList.toggle("ok", ok);
  row("What", r.description);
  row("Amount", r.amount ? `${r.amount} ${r.currency}` : undefined);
  row("Payment method", r.method);
  row("PayPal order", r.orderId);
  row("Order status", r.status);
  row("Capture (transaction) ID", r.captureId);
  row("Capture status", r.captureStatus);
  row("Created", when(r.createdAt));
  row("Paid", when(r.paidAt));
  row("Verified with PayPal", new Date().toLocaleString());
} catch (e) {
  title.textContent = "Receipt not found";
  document.getElementById("r-note").textContent = `${e.message}. Check the link, or make a payment from the TastePay page first.`;
}
