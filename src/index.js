require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { createAgent } = require("./agent");
const { handleCallWebhook } = require("./call-handler");

const app = express();
app.use(cors());
app.use(express.json());

// ── Supabase client (service role for backend) ──
const WebSocket = require('ws');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "answerbite-voice", version: "2.0.0" });
});


// ═══════════════════════════════════════════════════════════════
//  RESTAURANT ONBOARDING & CRUD
// ═══════════════════════════════════════════════════════════════

// Create a new restaurant (onboarding)
app.post("/api/restaurants", async (req, res) => {
  try {
    const {
      name, address, phone, cuisine, owner_name, owner_email,
      greeting, voice_style, can_take_orders, can_book_reservations,
      can_transfer, transfer_phone,
    } = req.body;

    if (!name || !phone || !owner_email) {
      return res.status(400).json({ error: "name, phone, and owner_email are required" });
    }

    const { data, error } = await supabase.from("restaurants").insert({
      name, address, phone, cuisine, owner_name, owner_email,
      greeting: greeting || `Thank you for calling ${name}! How can I help you?`,
      voice_style: voice_style || "friendly",
      can_take_orders: can_take_orders !== false,
      can_book_reservations: can_book_reservations !== false,
      can_transfer: can_transfer !== false,
      transfer_phone: transfer_phone || phone,
      api_key: `ab_${crypto.randomBytes(24).toString("hex")}`,
      is_active: true,
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    console.error("Create restaurant error:", err);
    res.status(500).json({ error: "Failed to create restaurant" });
  }
});

// Update restaurant settings
app.put("/api/restaurants/:id", async (req, res) => {
  try {
    const allowed = [
      "name", "address", "phone", "cuisine", "owner_name", "owner_email",
      "greeting", "voice_style", "can_take_orders", "can_book_reservations",
      "can_transfer", "transfer_phone", "is_active",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from("restaurants")
      .update(updates)
      .eq("id", req.params.id)
      .select("*, menu_items(*), business_hours(*)")
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error("Update restaurant error:", err);
    res.status(500).json({ error: "Failed to update restaurant" });
  }
});

// List all restaurants (admin)
app.get("/api/restaurants", async (req, res) => {
  const { data } = await supabase
    .from("restaurants")
    .select("id, name, phone, cuisine, is_active, created_at")
    .order("created_at", { ascending: false });
  res.json(data || []);
});

// Delete restaurant
app.delete("/api/restaurants/:id", async (req, res) => {
  const { error } = await supabase
    .from("restaurants")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});


// ═══════════════════════════════════════════════════════════════
//  MENU ITEMS CRUD
// ═══════════════════════════════════════════════════════════════

// Add menu item
app.post("/api/restaurants/:id/menu", async (req, res) => {
  const { name, description, price, category } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ error: "name and price are required" });
  }
  const { data, error } = await supabase.from("menu_items").insert({
    restaurant_id: req.params.id, name, description, price, category,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Bulk add menu items
app.post("/api/restaurants/:id/menu/bulk", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array is required" });
  }
  const rows = items.map((item) => ({
    restaurant_id: req.params.id,
    name: item.name,
    description: item.description || null,
    price: item.price,
    category: item.category || "other",
  }));
  const { data, error } = await supabase.from("menu_items").insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Update menu item
app.put("/api/menu/:itemId", async (req, res) => {
  const updates = {};
  for (const key of ["name", "description", "price", "category", "is_available"]) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const { data, error } = await supabase
    .from("menu_items").update(updates).eq("id", req.params.itemId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Delete menu item
app.delete("/api/menu/:itemId", async (req, res) => {
  const { error } = await supabase.from("menu_items").delete().eq("id", req.params.itemId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});


// ═══════════════════════════════════════════════════════════════
//  BUSINESS HOURS CRUD
// ═══════════════════════════════════════════════════════════════

// Set all business hours (replaces existing)
app.put("/api/restaurants/:id/hours", async (req, res) => {
  const { hours } = req.body;
  if (!Array.isArray(hours)) {
    return res.status(400).json({ error: "hours array is required" });
  }
  // Delete existing hours
  await supabase.from("business_hours").delete().eq("restaurant_id", req.params.id);
  // Insert new hours
  const rows = hours.map((h) => ({
    restaurant_id: req.params.id,
    day_of_week: h.day_of_week,
    open_time: h.open_time,
    close_time: h.close_time,
    is_closed: h.is_closed || false,
  }));
  const { data, error } = await supabase.from("business_hours").insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


// ═══════════════════════════════════════════════════════════════
//  TEST CHAT — Simulate AI conversation via text (no phone needed)
// ═══════════════════════════════════════════════════════════════

app.post("/api/test-chat", async (req, res) => {
  try {
    const { restaurant_id, message, conversation_history } = req.body;

    const rid = restaurant_id || process.env.DEFAULT_RESTAURANT_ID || "00000000-0000-0000-0000-000000000001";
    const restaurant = await getRestaurantContext(rid, supabase);

    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const agent = createAgent(restaurant);
    const response = await agent.respond(message, conversation_history || []);

    res.json({
      text: response.text,
      action: response.action || null,
      order: response.order || null,
      reservation: response.reservation || null,
      conversation_history: [
        ...(conversation_history || []),
        { role: "caller", content: message, timestamp: new Date().toISOString() },
        { role: "agent", content: response.text, timestamp: new Date().toISOString() },
      ],
    });
  } catch (err) {
    console.error("Test chat error:", err);
    res.status(500).json({ error: "Failed to process message" });
  }
});

// Test chat: get greeting (start a new conversation)
app.get("/api/test-chat/greeting/:restaurantId", async (req, res) => {
  const restaurant = await getRestaurantContext(req.params.restaurantId, supabase);
  if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
  const greeting = restaurant.greeting || `Thank you for calling ${restaurant.name}! How can I help you?`;
  res.json({
    text: greeting,
    restaurant_name: restaurant.name,
    conversation_history: [
      { role: "agent", content: greeting, timestamp: new Date().toISOString() },
    ],
  });
});


// ═══════════════════════════════════════════════════════════════
//  SIMULATE A FULL CALL — Create a fake call record for testing
// ═══════════════════════════════════════════════════════════════

app.post("/api/simulate-call", async (req, res) => {
  try {
    const { restaurant_id, caller_number, messages } = req.body;
    const rid = restaurant_id || process.env.DEFAULT_RESTAURANT_ID;

    const restaurant = await getRestaurantContext(rid, supabase);
    if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

    // Create call record
    const { data: call } = await supabase.from("calls").insert({
      restaurant_id: rid,
      caller_number: caller_number || "+1555" + Math.floor(1000000 + Math.random() * 9000000),
      status: "in_progress",
      transcript: [],
    }).select().single();

    // Process each message through the AI agent
    const agent = createAgent(restaurant);
    const transcript = [];
    let lastResponse = null;

    const callerMessages = messages || ["Hi, I'd like to place an order for pickup"];

    for (const msg of callerMessages) {
      const response = await agent.respond(msg, transcript);
      transcript.push(
        { role: "caller", content: msg, timestamp: new Date().toISOString() },
        { role: "agent", content: response.text, timestamp: new Date().toISOString() }
      );
      lastResponse = response;

      // Save order or reservation if AI detected one
      if (response.action === "place_order" && response.order) {
        await saveOrder(response.order, call.id, rid, supabase);
      }
      if (response.action === "book_reservation" && response.reservation) {
        await saveReservation(response.reservation, call.id, rid, supabase);
      }
    }

    // Classify and close the call
    const classification = await agent.classifyCall(transcript);
    const duration = 30 + Math.floor(Math.random() * 180);

    await supabase.from("calls").update({
      transcript,
      status: classification.status || "completed",
      call_type: classification.type || "other",
      summary: classification.summary || "Simulated call",
      duration_seconds: duration,
      ended_at: new Date().toISOString(),
    }).eq("id", call.id);

    res.json({
      call_id: call.id,
      transcript,
      classification,
      duration_seconds: duration,
    });
  } catch (err) {
    console.error("Simulate call error:", err);
    res.status(500).json({ error: "Failed to simulate call" });
  }
});


// ═══════════════════════════════════════════════════════════════
//  CALL WEBHOOK — SIP media server hits this on incoming call
// ═══════════════════════════════════════════════════════════════

app.post("/webhook/call", async (req, res) => {
  try {
    const result = await handleCallWebhook(req.body, supabase);
    res.json(result);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});


// ═══════════════════════════════════════════════════════════════
//  CONVERSATION — AI processes caller speech per turn
// ═══════════════════════════════════════════════════════════════

app.post("/conversation", async (req, res) => {
  try {
    const { restaurant_id, call_id, caller_text, conversation_history } = req.body;

    const restaurant = await getRestaurantContext(restaurant_id, supabase);
    if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

    const agent = createAgent(restaurant);
    const response = await agent.respond(caller_text, conversation_history || []);

    if (call_id) {
      const newEntry = [
        { role: "caller", content: caller_text, timestamp: new Date().toISOString() },
        { role: "agent", content: response.text, timestamp: new Date().toISOString() },
      ];
      const { data: call } = await supabase
        .from("calls").select("transcript").eq("id", call_id).single();
      const transcript = [...(call?.transcript || []), ...newEntry];
      await supabase.from("calls").update({ transcript }).eq("id", call_id);
    }

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


// ═══════════════════════════════════════════════════════════════
//  END CALL — Called when a call ends
// ═══════════════════════════════════════════════════════════════

app.post("/call/end", async (req, res) => {
  try {
    const { call_id, duration_seconds } = req.body;

    const { data: call } = await supabase
      .from("calls").select("*").eq("id", call_id).single();
    if (!call) return res.status(404).json({ error: "Call not found" });

    const agent = createAgent({});
    const classification = await agent.classifyCall(call.transcript || []);

    await supabase.from("calls").update({
      status: classification.status,
      call_type: classification.type,
      summary: classification.summary,
      duration_seconds,
      ended_at: new Date().toISOString(),
    }).eq("id", call_id);

    res.json({ success: true });
  } catch (err) {
    console.error("End call error:", err);
    res.status(500).json({ error: "Failed to end call" });
  }
});


// ═══════════════════════════════════════════════════════════════
//  SMS NOTIFICATIONS (stub — ready for GatewayAPI/Twilio)
// ═══════════════════════════════════════════════════════════════

app.post("/api/sms/send", async (req, res) => {
  const { to, message, restaurant_id } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "to and message are required" });
  }

  // TODO: Wire up actual SMS provider (GatewayAPI, Twilio, etc.)
  console.log(`📱 SMS to ${to}: ${message}`);
  res.json({ success: true, provider: "stub", message: "SMS logged (provider not configured)" });
});


// ═══════════════════════════════════════════════════════════════
//  VOICE PIPELINE — STT, TTS, and full pipeline test endpoints
// ═══════════════════════════════════════════════════════════════

const { speechToText, textToSpeech, processVoiceTurn, getPipelineStatus } = require("./voice-pipeline");
const { setupWebSocket } = require("./ws-handler");

// Pipeline status check
app.get("/api/voice/status", (req, res) => {
  res.json({
    status: "ok",
    pipeline: getPipelineStatus(),
    websocket: "/voice",
    sip_connected: false, // will be true when SIP.US is wired
  });
});

// Test TTS — generate speech from text
app.post("/api/voice/tts", async (req, res) => {
  const { text, voice, speed } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  const result = await textToSpeech(text, { voice, speed });
  if (result.error) return res.status(500).json({ error: result.error });

  // Return audio file
  res.set({
    "Content-Type": "audio/wav",
    "Content-Disposition": `attachment; filename="tts_${Date.now()}.wav"`,
    "Content-Length": result.audio.length,
  });
  res.send(result.audio);
});

// Test STT — transcribe audio file
app.post("/api/voice/stt", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: "Audio data required (send as raw audio/wav)" });
  }

  const result = await speechToText(req.body);
  res.json(result);
});

// Test full pipeline — text in, audio out (simulates a voice turn without real audio input)
app.post("/api/voice/test-turn", async (req, res) => {
  try {
    const { restaurant_id, message, conversation_history } = req.body;
    const rid = restaurant_id || process.env.DEFAULT_RESTAURANT_ID;

    const restaurant = await getRestaurantContext(rid, supabase);
    if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

    const agent = createAgent(restaurant);
    const response = await agent.respond(message, conversation_history || []);

    // Generate TTS for the response
    const tts = await textToSpeech(response.text);

    res.json({
      caller_text: message,
      agent_text: response.text,
      action: response.action,
      order: response.order,
      reservation: response.reservation,
      has_audio: !!tts.audio,
      audio_size: tts.audio ? tts.audio.length : 0,
      conversation_history: [
        ...(conversation_history || []),
        { role: "caller", content: message, timestamp: new Date().toISOString() },
        { role: "agent", content: response.text, timestamp: new Date().toISOString() },
      ],
    });
  } catch (err) {
    console.error("Test turn error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get TTS audio for a specific text (GET for easy testing in browser)
app.get("/api/voice/speak", async (req, res) => {
  const text = req.query.text || "Hello, thank you for calling!";
  const voice = req.query.voice || undefined;

  const result = await textToSpeech(text, { voice });
  if (result.error || !result.audio) {
    return res.status(500).json({ error: result.error || "TTS failed" });
  }

  res.set({ "Content-Type": "audio/wav" });
  res.send(result.audio);
});


// ═══════════════════════════════════════════════════════════════
//  API ROUTES — Dashboard data
// ═══════════════════════════════════════════════════════════════

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
    .from("calls").select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("started_at", { ascending: false }).limit(limit);
  res.json(data || []);
});

// Get orders
app.get("/api/orders/:restaurantId", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase
    .from("orders").select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("created_at", { ascending: false }).limit(limit);
  res.json(data || []);
});

// Get reservations
app.get("/api/reservations/:restaurantId", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase
    .from("reservations").select("*")
    .eq("restaurant_id", req.params.restaurantId)
    .order("created_at", { ascending: false }).limit(limit);
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
  const callTypes = {};
  (calls.data || []).forEach((c) => {
    callTypes[c.call_type || "other"] = (callTypes[c.call_type || "other"] || 0) + 1;
  });

  res.json({ totalCalls, totalOrders, totalReservations, totalRevenue, callTypes });
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
    call_id: callId, restaurant_id: restaurantId,
    customer_phone: order.customer_phone, customer_name: order.customer_name,
    items: order.items, subtotal: order.subtotal, tax: order.tax, total: order.total,
    order_type: order.order_type || "pickup", special_instructions: order.special_instructions,
  });
}

async function saveReservation(reservation, callId, restaurantId, supabase) {
  await supabase.from("reservations").insert({
    call_id: callId, restaurant_id: restaurantId,
    customer_phone: reservation.customer_phone, customer_name: reservation.customer_name,
    party_size: reservation.party_size, reservation_date: reservation.date,
    reservation_time: reservation.time, special_requests: reservation.special_requests,
  });
}


// ── Start server with WebSocket ──
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🤖 AnswerBite Voice Agent v2.0 running on port ${PORT}`);
  console.log(`📞 WebSocket voice endpoint: ws://localhost:${PORT}/voice`);
  console.log(`🔊 Voice pipeline status: /api/voice/status`);
  console.log(`🧪 Test TTS: /api/voice/speak?text=Hello`);
});

// Attach WebSocket server for real-time voice calls
setupWebSocket(server, supabase);

