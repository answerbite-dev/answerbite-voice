require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { createAgent } = require("./agent");
const { handleCallWebhook } = require("./call-handler");

const app = express();
app.use(cors());
app.use(express.json());

// ── Supabase client (service role for backend) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "answerbite-voice", version: "1.0.0" });
});

// ══════════════════════════════════════════════════════════════
// CALL WEBHOOK - FreeSWITCH/Asterisk hits this when a call comes in
// ══════════════════════════════════════════════════════════════
app.post("/webhook/call", async (req, res) => {
  try {
    const result = await handleCallWebhook(req.body, supabase);
    res.json(result);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════
// CONVERSATION - AI processes caller speech and responds
// This is called by the SIP media server for each turn
// ══════════════════════════════════════════════════════════════
app.post("/conversation", async (req, res) => {
  try {
    const { restaurant_id, call_id, caller_text, conversation_history } = req.body;

    // Load restaurant context
    const restaurant = await getRestaurantContext(restaurant_id, supabase);
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    // Get AI response
    const agent = createAgent(restaurant);
    const response = await agent.respond(caller_text, conversation_history || []);

    // Update call transcript in Supabase
    if (call_id) {
      const newEntry = [
        { role: "caller", content: caller_text, timestamp: new Date().toISOString() },
        { role: "agent", content: response.text, timestamp: new Date().toISOString() },
      ];
      const { data: call } = await supabase
        .from("calls")
        .select("transcript")
        .eq("id", call_id)
        .single();

      const transcript = [...(call?.transcript || []), ...newEntry];
      await supabase.from("calls").update({ transcript }).eq("id", call_id);
    }

    // If the AI detected an order or reservation, save it
    if (response.action === "place_order" && response.order) {
      await saveOrder(response.order, call_id, restaurant_id, supabase);
    }
    if (response.action === "book_reservation" && response.reservation) {
      await saveReservation(response.reservation, call_id, restaurant_id, supabase);
    }

    res.json({
      text: response.text,
      action: response.action || null,
      should_transfer: response.action === "transfer",
      should_end: response.action === "end_call",
    });
  } catch (err) {
    console.error("Conversation error:", err);
    res.status(500).json({ error: "Failed to process conversation" });
  }
});

// ══════════════════════════════════════════════════════════════
// END CALL - Called when the call ends
// ══════════════════════════════════════════════════════════════
app.post("/call/end", async (req, res) => {
  try {
    const { call_id, duration_seconds } = req.body;

    // Get the call to check its transcript
    const { data: call } = await supabase
      .from("calls")
      .select("*")
      .eq("id", call_id)
      .single();

    if (!call) return res.status(404).json({ error: "Call not found" });

    // Use AI to generate a summary and classify the call
    const agent = createAgent({});
    const classification = await agent.classifyCall(call.transcript || []);

    await supabase
      .from("calls")
      .update({
        status: classification.status,
        call_type: classification.type,
        summary: classification.summary,
        duration_seconds,
        ended_at: new Date().toISOString(),
      })
      .eq("id", call_id);

    res.json({ success: true });
  } catch (err) {
    console.error("End call error:", err);
    res.status(500).json({ error: "Failed to end call" });
  }
});

// ══════════════════════════════════════════════════════════════
// API ROUTES - For the dashboard to read data
// ══════════════════════════════════════════════════════════════

// Get restaurant info
app.get("/api/restaurant/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("restaurants")
    .select("*, menu_items(*), business_hours(*)")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

// Get recent calls
app.get("/api/calls/:restaurantId", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase
    .from("calls")
    .select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("started_at", { ascending: false })
    .limit(limit);
  res.json(data || []);
});

// Get orders
app.get("/api/orders/:restaurantId", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase
    .from("orders")
    .select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  res.json(data || []);
});

// Get reservations
app.get("/api/reservations/:restaurantId", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase
    .from("reservations")
    .select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  res.json(data || []);
});

// Get dashboard stats
app.get("/api/stats/:restaurantId", async (req, res) => {
  const rid = req.params.restaurantId;

  const [calls, orders, reservations] = await Promise.all([
    supabase.from("calls").select("id, call_type, status, started_at, duration_seconds").eq("restaurant_id", rid),
    supabase.from("orders").select("id, total, created_at").eq("restaurant_id", rid),
    supabase.from("reservations").select("id, created_at").eq("restaurant_id", rid),
  ]);

  const totalCalls = calls.data?.length || 0;
  const totalOrders = orders.data?.length || 0;
  const totalReservations = reservations.data?.length || 0;
  const totalRevenue = orders.data?.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0) || 0;

  // Call type breakdown
  const callTypes = {};
  (calls.data || []).forEach((c) => {
    callTypes[c.call_type || "other"] = (callTypes[c.call_type || "other"] || 0) + 1;
  });

  res.json({
    totalCalls,
    totalOrders,
    totalReservations,
    totalRevenue,
    callTypes,
  });
});

// ── Helpers ──────────────────────────────────────────────────

async function getRestaurantContext(restaurantId, supabase) {
  const { data } = await supabase
    .from("restaurants")
    .select("*, menu_items(*), business_hours(*)")
    .eq("id", restaurantId)
    .single();
  return data;
}

async function saveOrder(order, callId, restaurantId, supabase) {
  await supabase.from("orders").insert({
    call_id: callId,
    restaurant_id: restaurantId,
    customer_phone: order.customer_phone,
    customer_name: order.customer_name,
    items: order.items,
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    order_type: order.order_type || "pickup",
    special_instructions: order.special_instructions,
  });
}

async function saveReservation(reservation, callId, restaurantId, supabase) {
  await supabase.from("reservations").insert({
    call_id: callId,
    restaurant_id: restaurantId,
    customer_phone: reservation.customer_phone,
    customer_name: reservation.customer_name,
    party_size: reservation.party_size,
    reservation_date: reservation.date,
    reservation_time: reservation.time,
    special_requests: reservation.special_requests,
  });
}

// ── Start server ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 AnswerBite Voice Agent running on port ${PORT}`);
});
