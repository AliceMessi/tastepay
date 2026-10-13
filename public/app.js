// TastePay front end. Every string from the server (including LLM output) goes
// through textContent, never innerHTML.

const $ = (s) => document.querySelector(s);
const OCC_LOCAL = { dinner: true, drinks: true, culture: true, trip: false };
const EXAMPLE = [
  { name: "Sara", favourites: ["Radiohead", "Haruki Murakami"] },
  { name: "Luca", favourites: ["The Grand Budapest Hotel", "Miles Davis"] },
  { name: "Giulia", favourites: ["Spirited Away", "Billie Eilish"] },
];

const state = { tab: "form", occasion: "dinner", request: null, members: [], picks: [], explanations: {}, chosen: null, paypal: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.setAttribute("style", v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path, body, retries = 1) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  // Qloo or a function can be briefly busy: wait and try once more.
  if ([429, 502, 503, 504].includes(res.status) && retries > 0) {
    await new Promise((r) => setTimeout(r, 2500));
    return api(path, body, retries - 1);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- input ----------

function addPerson(p = { name: "", favourites: [] }) {
  const node = $("#person-tpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".p-name").value = p.name;
  node.querySelector(".p-favs").value = p.favourites.join(", ");
  node.querySelector(".remove").addEventListener("click", () => {
    if (document.querySelectorAll(".person").length > 2) node.remove();
  });
  $("#people").append(node);
}

function setOccasion(v) {
  state.occasion = v;
  document.querySelectorAll("#occasion .chip").forEach((c) => c.classList.toggle("active", c.dataset.v === v));
  $("#city-field").classList.toggle("hidden", !OCC_LOCAL[v]);
}

function fillForm(req) {
  setOccasion(req.occasion);
  if (req.city) $("#city").value = req.city;
  if (req.budgetPerPerson) $("#budget").value = req.budgetPerPerson;
  $("#people").replaceChildren();
  req.members.forEach(addPerson);
}

function readForm() {
  const members = [...document.querySelectorAll(".person")].map((p) => ({
    name: p.querySelector(".p-name").value.trim(),
    favourites: p.querySelector(".p-favs").value.split(",").map((s) => s.trim()).filter(Boolean),
  })).filter((m) => m.name && m.favourites.length);
  return {
    occasion: state.occasion,
    city: OCC_LOCAL[state.occasion] ? $("#city").value.trim() : undefined,
    budgetPerPerson: Number($("#budget").value) || undefined,
    members,
  };
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
    t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  });
  $("#panel-form").classList.toggle("hidden", tab !== "form");
  $("#panel-brief").classList.toggle("hidden", tab !== "brief");
}

// ---------- trace ----------

function traceStart(label) {
  const li = h("li", {}, h("span", { class: "dot run" }), h("div", {}, h("b", {}, label), h("span", { class: "src" }, "working…")));
  $("#trace").append(li);
  return li;
}

function traceDone(li, step) {
  const kind = /Qloo/.test(step.source) ? "qloo" : /LLM/.test(step.source) ? "llm" : "";
  li.replaceChildren(
    h("span", { class: `dot ${kind}` }),
    h("div", {}, h("b", {}, step.step), h("span", { class: "src" }, `${step.source}${step.ms ? ` · ${(step.ms / 1000).toFixed(1)} s` : ""}`), h("div", { class: "det" }, step.detail)),
  );
}

function traceFail(li, label, err) {
  li.replaceChildren(h("span", { class: "dot" }), h("div", {}, h("b", {}, label), h("span", { class: "src" }, err.message)));
}

async function step(label, fn) {
  const li = traceStart(label);
  try {
    const out = await fn();
    const steps = Array.isArray(out.trace) ? out.trace : [out.trace];
    traceDone(li, steps[0]);
    steps.slice(1).forEach((s) => traceDone(traceStart(s.step), s));
    return out;
  } catch (e) {
    traceFail(li, label, e);
    throw e;
  }
}

// ---------- run ----------

function setStatus(msg, error = false) {
  $("#status").textContent = msg;
  $("#status").classList.toggle("error", error);
}

async function run() {
  const go = $("#go");
  go.disabled = true;
  setStatus("");
  $("#trace").replaceChildren();
  ["#results", "#compare", "#pay"].forEach((s) => $(s).classList.add("hidden"));
  $("#work").classList.remove("hidden");
  try {
    let request;
    if (state.tab === "brief") {
      const u = await step("Understand brief", () => api("/api/understand", { brief: $("#brief").value }));
      request = u.request;
      fillForm(request);
    } else {
      request = readForm();
    }
    if (request.members.length < 2) throw new Error("Add at least two people with at least one favourite each.");
    if (OCC_LOCAL[request.occasion] && !request.city) throw new Error("Which city?");
    state.request = request;

    const r = await step("Resolve tastes", () => api("/api/resolve", { members: request.members }));
    state.members = r.members;
    renderTastes();

    // Free models are often busy: one more try for the comparison if the first gets no answer.
    const baseline = step("LLM without Qloo", () => api("/api/baseline", { request }))
      .then((b) => (b.text ? b : step("LLM without Qloo (retry)", () => api("/api/baseline", { request }))));
    await rankAndExplain();
    $("#work").scrollIntoView({ behavior: "smooth", block: "start" });
    baseline.then(renderBaseline).catch(() => {});
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    go.disabled = false;
  }
}

async function rankAndExplain() {
  const k = await step("Taste affinities", () => api("/api/rank", { request: state.request, members: state.members }));
  state.picks = k.picks;
  state.explanations = {};
  renderPicks(true);
  if (!k.picks.length) return;
  try {
    const e = await step("Explain", () => api("/api/explain", { request: state.request, members: state.members, picks: k.picks }));
    state.explanations = e.explanations;
  } catch { /* the cards already show the shared Qloo tags */ }
  renderPicks(false);
}

// ---------- tastes ----------

function renderTastes() {
  const box = $("#tastes");
  box.replaceChildren();
  const asked = new Map(state.request.members.map((m) => [m.name, m.favourites]));
  for (const m of state.members) {
    const found = new Set(m.tastes.map((t) => t.query));
    const chips = m.tastes.map((t, i) => tasteChip(m, t, i));
    const missing = (asked.get(m.name) ?? []).filter((f) => !found.has(f)).map((f) => h("span", { class: "taste missing", title: "Not found in Qloo" }, f));
    box.append(h("div", { class: "member" }, h("div", { class: "member-name" }, m.name), ...chips, ...missing));
  }
}

function tasteChip(member, taste, index) {
  const chip = h("button", { type: "button", class: "taste", title: taste.alternatives.length ? "Not this one? Pick another" : taste.query },
    h("span", { class: "type" }, taste.type.replace("urn:entity:", "").replace("_", " ")), taste.name);
  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    document.querySelectorAll(".alts").forEach((a) => a.remove());
    if (!taste.alternatives.length) return;
    const menu = h("div", { class: "alts" }, ...taste.alternatives.map((alt) =>
      h("button", { type: "button", onclick: async (e) => {
        e.stopPropagation();
        menu.remove();
        member.tastes[index] = { ...alt, query: taste.query, alternatives: [taste, ...taste.alternatives.filter((a) => a.id !== alt.id)] };
        renderTastes();
        try { await rankAndExplain(); } catch (err) { setStatus(err.message, true); }
      } }, `${alt.name} · ${alt.type.replace("urn:entity:", "")}${alt.detail ? ` (${alt.detail})` : ""}`)));
    chip.append(menu);
  });
  return chip;
}

document.addEventListener("click", () => document.querySelectorAll(".alts").forEach((a) => a.remove()));

// ---------- picks ----------

function renderPicks(loading) {
  const box = $("#picks");
  box.replaceChildren();
  $("#results").classList.remove("hidden");
  if (!state.picks.length) {
    box.append(h("p", { class: "empty" }, "Nothing fits this budget in Qloo's data. Try a higher budget or another occasion."));
    return;
  }
  state.picks.forEach((p, i) => box.append(pickCard(p, i, loading)));
}

function pickCard(p, i, loading) {
  const c = p.candidate;
  const ex = state.explanations[c.id];
  const img = h("div", { class: "img" },
    photo(c),
    h("span", { class: "rank" }, `#${i + 1}`), h("span", { class: "fit" }, `${Math.round(p.fit * 100)}% group fit`));
  const meta = [c.priceLevel ? "€".repeat(c.priceLevel) : null, c.rating ? `★ ${c.rating}` : null, c.address].filter(Boolean).join(" · ");
  const today = todayHours(c.hours);
  const facts = [
    today ? h("span", { class: "fact" }, `🕒 Today ${today}`) : null,
    c.liveMusic ? h("span", { class: "fact" }, "🎵 Live music") : null,
    c.specialties?.length ? h("span", { class: "fact" }, `🍴 ${c.specialties.slice(0, 3).join(", ")}`) : null,
  ].filter(Boolean);
  const d = c.details ?? {};
  const more = [
    d.highlights ? h("p", {}, h("b", {}, "Why people go: "), d.highlights) : null,
    d.ambience ? h("p", {}, h("b", {}, "Atmosphere: "), d.ambience) : null,
    d.cuisine ? h("p", {}, h("b", {}, "Food & drink: "), d.cuisine) : null,
    d.service ? h("p", {}, h("b", {}, "Service: "), d.service) : null,
    c.keywords?.length ? h("p", {}, h("b", {}, "People mention: "), c.keywords.join(" · ")) : null,
  ].filter(Boolean);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.name, c.address].filter(Boolean).join(" "))}`;
  const links = h("div", { class: "links" },
    h("a", { href: mapsUrl, target: "_blank", rel: "noopener nofollow" }, "Map, photos & reviews ↗"),
    c.website ? h("a", { href: c.website, target: "_blank", rel: "noopener nofollow" }, "Website ↗") : null,
    c.menuUrl ? h("a", { href: c.menuUrl, target: "_blank", rel: "noopener nofollow" }, "Menu ↗") : null,
    c.phone ? h("a", { href: `tel:${c.phone.replace(/[^+\d]/g, "")}` }, `Call ${c.phone}`) : null);
  const bars = h("div", { class: "bars" }, ...p.perMember.flatMap((s) => [
    h("div", { class: "bar" }, h("span", {}, s.member),
      h("div", { class: "track" }, h("div", { class: `fill${s.known ? "" : " est"}`, style: `width:${Math.round(s.score * 100)}%` })),
      h("span", {}, `${Math.round(s.score * 100)}%`)),
    ex?.perMember?.[s.member] ? h("div", { class: "reason" }, ex.perMember[s.member]) : null,
  ]));
  const why = ex?.why ?? (p.sharedTags.length ? `Shared vibe: ${p.sharedTags.slice(0, 3).map((t) => t.name.toLowerCase()).join(", ")}.` : "The best balance between everyone's tastes.");
  const card = h("article", { class: `card pick${state.chosen === c.id ? " chosen" : ""}` }, img,
    h("div", { class: "body" },
      h("h3", {}, c.name),
      meta ? h("div", { class: "meta" }, meta) : null,
      p.sharedTags.length ? h("div", { class: "vibes" }, ...p.sharedTags.map((t) => h("span", { class: "vibe" }, t.name))) : null,
      facts.length ? h("div", { class: "facts" }, ...facts) : null,
      h("p", { class: `why${loading && !ex ? " loading" : ""}` }, loading && !ex ? `${why} Writing a fuller explanation…` : why),
      bars,
      more.length ? h("details", { class: "more" }, h("summary", {}, "More about this place"), ...more) : null,
      links,
      h("button", { class: "primary choose", onclick: () => choose(p) }, "Choose & split the bill"),
    ));
  return card;
}

/**
 * Qloo photo first (its image server can be slow), then the venue website's own
 * preview image, then a gradient.
 */
function photo(c) {
  const queue = [...(c.images?.length ? c.images : c.image ? [c.image] : [])];
  // Not lazy: with only three cards, lazy loading would start after the stall timer.
  const el = h("img", { alt: "", decoding: "async", referrerpolicy: "no-referrer" });
  let triedWebsite = false;
  let timer;
  const next = async () => {
    clearTimeout(timer);
    const url = queue.shift();
    if (url) {
      el.src = url;
      timer = setTimeout(next, 8000); // a stalled image server counts as a failure
      return;
    }
    if (!triedWebsite && c.website) {
      triedWebsite = true;
      const r = await api("/api/preview", { url: c.website }, 0).catch(() => null);
      if (r?.image) { queue.push(r.image); return next(); }
    }
    el.remove();
  };
  el.addEventListener("load", () => { clearTimeout(timer); el.classList.add("loaded"); });
  el.addEventListener("error", next);
  next();
  return el;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "12:00–15:00, 19:00–23:00" for today, "closed", or null when Qloo has no hours. */
function todayHours(hours) {
  const slots = hours?.[DAYS[new Date().getDay()]];
  if (!Array.isArray(slots) || !slots.length) return null;
  if (slots.every((s) => s.closed)) return "closed";
  const t = (x) => (x ?? "").replace(/^T/, "").slice(0, 5);
  return slots.filter((s) => !s.closed).map((s) => `${t(s.opens)}–${t(s.closes)}`).join(", ");
}

// ---------- comparison ----------

function renderBaseline(b) {
  $("#compare").classList.remove("hidden");
  // Plain text: drop markdown emphasis the model may add.
  $("#baseline").textContent = b.text ? b.text.replace(/\*\*|__/g, "").replace(/(^|\s)[*_](\S)/g, "$1$2").replace(/(\S)[*_](?=\s|[.,;:]|$)/g, "$1") : "No free model answered this time — the Qloo-based plan above does not need one.";
  const labels = { "in-city": "Found in the city", "other-city": "Different city", "not-found": "Not in Qloo's place data" };
  $("#claims").replaceChildren(...(b.claims ?? []).map((c) => h("li", {},
    h("div", { class: `verdict v-${c.verdict}` }, labels[c.verdict] + (c.overBudget ? " · over your budget" : "")),
    h("div", {}, h("b", {}, c.named)),
    c.match ? h("div", { class: "meta" }, `Qloo: ${c.match.name}${c.match.city ? `, ${c.match.city}` : ""}${c.match.priceLevel ? ` · ${"€".repeat(c.match.priceLevel)}` : ""}`) : null)));
}

// ---------- pay ----------

function choose(p) {
  state.chosen = p.candidate.id;
  renderPicks(false);
  $("#pay").classList.remove("hidden");
  $("#share").value = state.request.budgetPerPerson ?? 25;
  $("#pay-intro").textContent = `${p.candidate.name} for ${state.request.members.length} people. Each person pays their own share with PayPal.`;
  renderPayers(p);
  $("#pay").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadPayPal() {
  if (state.paypal) return state.paypal;
  const cfg = await fetch("/api/config").then((r) => r.json());
  if (!cfg.paypalClientId) throw new Error("Payments are not configured.");
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=EUR&intent=capture`;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load PayPal"));
    document.head.append(s);
  });
  state.paypal = window.paypal;
  return state.paypal;
}

async function renderPayers(pick) {
  const box = $("#payers");
  box.replaceChildren();
  let paypal;
  try { paypal = await loadPayPal(); } catch (e) { box.append(h("p", { class: "status error" }, e.message)); return; }
  for (const m of state.request.members) {
    const slot = h("div", {});
    box.append(h("div", { class: "payer" }, h("b", {}, m.name), slot));
    paypal.Buttons({
      style: { layout: "horizontal", height: 40, tagline: false },
      createOrder: async () => (await api("/api/pay", { action: "create", amount: Number($("#share").value), description: `${pick.candidate.name} (${m.name})` })).id,
      onApprove: async (data) => {
        const r = await api("/api/pay", { action: "capture", orderId: data.orderID });
        slot.replaceChildren(h("span", { class: "paid" }, `Paid ✓ €${Number($("#share").value).toFixed(2)} · sandbox order ${r.id}`));
      },
      onError: (err) => slot.append(h("p", { class: "status error" }, String(err?.message ?? err))),
    }).render(slot);
  }
}

// ---------- init ----------

EXAMPLE.forEach(addPerson);
setOccasion("dinner");
document.querySelectorAll("#occasion .chip").forEach((c) => c.addEventListener("click", () => setOccasion(c.dataset.v)));
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#add-person").addEventListener("click", () => document.querySelectorAll(".person").length < 8 && addPerson());
$("#go").addEventListener("click", run);
