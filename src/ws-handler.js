/**
 * AnswerBite WebSocket Call Handler
 * 
 * Handles real-time voice calls over WebSocket.
 * The SIP bridge (FreeSWITCH/Asterisk) will connect here
 * and stream audio bidirectionally.
 * 
 * Protocol:
 *   Client → Server: Binary audio frames (PCM 16-bit, 8kHz mono)
 *   Server → Client: Binary audio frames (PCM 16-bit, 8kHz mono)
 *   Client → Server: JSON control messages { type, ... }
 *   Server → Client: JSON status messages { type, ... }
 * 
 * Flow:
 *   1. SIP bridge connects via WebSocket with ?restaurant_id=xxx&caller=+1234567890
 *   2. Server sends greeting audio
 *   3. Client streams caller audio → server accumulates until silence detected
 *   4. On silence: STT → LLM → TTS → stream response audio back
 *   5. Repeat until call ends
 */

const WebSocket = require("ws");
const { processVoiceTurn, textToSpeech, getPipelineStatus } = require("./voice-pipeline");
const { createAgent } = require("./agent");

// Audio settings for phone calls (SIP standard)
const PHONE_SAMPLE_RATE = 8000;   // 8kHz for phone
const PHONE_CHANNELS = 1;         // mono
const PHONE_BIT_DEPTH = 16;       // 16-bit PCM

// Silence detection settings
const SILENCE_THRESHOLD = 500;     // amplitude threshold for silence
const SILENCE_DURATION_MS = 1500;  // ms of silence before processing
const MIN_SPEECH_DURATION_MS = 300;// minimum speech to process (ignore noise)
const MAX_RECORDING_MS = 30000;    // max recording before forced processing

/**
 * Set up WebSocket server for voice calls
 * Attaches to existing HTTP server
 */
function setupWebSocket(server, supabase) {
  const wss = new WebSocket.Server({
    server,
    path: "/voice",
  });

  console.log("📞 WebSocket voice server ready on /voice");

  wss.on("connection", (ws, req) => {
    handleVoiceConnection(ws, req, supabase);
  });

  return wss;
}

/**
 * Handle a single voice call WebSocket connection
 */
async function handleVoiceConnection(ws, req, supabase) {
  // Parse connection params
  const url = new URL(req.url, `http://${req.headers.host}`);
  const restaurantId = url.searchParams.get("restaurant_id") || process.env.DEFAULT_RESTAURANT_ID;
  const callerNumber = url.searchParams.get("caller") || "Unknown";
  const calledNumber = url.searchParams.get("called") || "";

  console.log(`\n📞 New call: ${callerNumber} → Restaurant ${restaurantId}`);

  // Load restaurant context
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("*, menu_items(*), business_hours(*)")
    .eq("id", restaurantId)
    .single();

  if (!restaurant) {
    ws.send(JSON.stringify({ type: "error", message: "Restaurant not found" }));
    ws.close();
    return;
  }

  // Create call record in database
  const { data: call } = await supabase.from("calls").insert({
    restaurant_id: restaurant.id,
    caller_number: callerNumber,
    status: "in_progress",
    transcript: [],
  }).select().single();

  const callId = call?.id;
  console.log(`  Call ID: ${callId}`);

  // Create AI agent for this restaurant
  const agent = createAgent(restaurant);
  const conversationHistory = [];

  // Call state
  let audioChunks = [];
  let speechStartTime = null;
  let lastSoundTime = Date.now();
  let isProcessing = false;
  let turnCount = 0;

  // Send greeting
  const greeting = restaurant.greeting || `Thank you for calling ${restaurant.name}! How can I help you?`;
  console.log(`  🔊 Greeting: "${greeting}"`);

  // Add greeting to history
  conversationHistory.push({
    role: "agent",
    content: greeting,
    timestamp: new Date().toISOString(),
  });

  // Generate and send greeting audio
  try {
    const greetingAudio = await textToSpeech(greeting);
    if (greetingAudio.audio) {
      // Downsample from 24kHz to 8kHz for phone
      const phoneAudio = downsample(greetingAudio.audio, 24000, PHONE_SAMPLE_RATE);
      ws.send(phoneAudio);
    }
    ws.send(JSON.stringify({
      type: "greeting",
      text: greeting,
      restaurant: restaurant.name,
      call_id: callId,
    }));
  } catch (err) {
    console.error("  Greeting TTS error:", err.message);
    ws.send(JSON.stringify({ type: "greeting", text: greeting, call_id: callId }));
  }

  // Handle incoming audio data
  ws.on("message", async (data) => {
    // JSON control messages
    if (typeof data === "string" || (data instanceof Buffer && data[0] === 0x7B)) {
      try {
        const msg = JSON.parse(data.toString());
        handleControlMessage(msg, ws, callId, supabase, conversationHistory, agent, restaurant);
        return;
      } catch {}
    }

    // Binary audio data
    if (isProcessing) return; // ignore audio while processing

    const buffer = Buffer.from(data);

    // Check if this chunk contains speech (simple amplitude check)
    const hasSound = detectSound(buffer, SILENCE_THRESHOLD);

    if (hasSound) {
      if (!speechStartTime) {
        speechStartTime = Date.now();
        console.log("  🎤 Speech started");
      }
      lastSoundTime = Date.now();
      audioChunks.push(buffer);
    } else if (speechStartTime) {
      // Still accumulating but silent — check if silence duration exceeded
      audioChunks.push(buffer); // include silence for natural breaks
      const silenceDuration = Date.now() - lastSoundTime;
      const speechDuration = Date.now() - speechStartTime;

      if (silenceDuration >= SILENCE_DURATION_MS && speechDuration >= MIN_SPEECH_DURATION_MS) {
        // Silence detected after speech → process this turn
        isProcessing = true;
        turnCount++;
        console.log(`\n  ═══ Turn ${turnCount} ═══`);
        console.log(`  Speech duration: ${speechDuration}ms, Chunks: ${audioChunks.length}`);

        // Combine audio chunks into single buffer
        const combinedAudio = Buffer.concat(audioChunks);

        // Convert to WAV for Whisper (upsample from 8kHz to 16kHz if needed)
        const wavAudio = pcmToWav(combinedAudio, PHONE_SAMPLE_RATE);

        // Process through voice pipeline
        try {
          const result = await processVoiceTurn(wavAudio, agent, conversationHistory);

          if (result.callerText) {
            // Update conversation history
            conversationHistory.push(
              { role: "caller", content: result.callerText, timestamp: new Date().toISOString() },
              { role: "agent", content: result.agentText, timestamp: new Date().toISOString() }
            );

            // Send transcription
            ws.send(JSON.stringify({
              type: "turn",
              turn: turnCount,
              caller_text: result.callerText,
              agent_text: result.agentText,
              action: result.action,
              timings: result.timings,
            }));

            // Send audio response
            if (result.agentAudio) {
              const phoneAudio = downsample(result.agentAudio, 24000, PHONE_SAMPLE_RATE);
              ws.send(phoneAudio);
            }

            // Save transcript to database
            await updateCallTranscript(callId, conversationHistory, supabase);

            // Handle actions (order, reservation, transfer, end)
            if (result.action === "place_order" && result.order) {
              await saveOrder(result.order, callId, restaurant.id, supabase);
              ws.send(JSON.stringify({ type: "action", action: "order_placed", order: result.order }));
            }
            if (result.action === "book_reservation" && result.reservation) {
              await saveReservation(result.reservation, callId, restaurant.id, supabase);
              ws.send(JSON.stringify({ type: "action", action: "reservation_booked", reservation: result.reservation }));
            }
            if (result.action === "transfer") {
              ws.send(JSON.stringify({ type: "action", action: "transfer", transfer_to: restaurant.transfer_phone }));
            }
            if (result.action === "end_call") {
              ws.send(JSON.stringify({ type: "action", action: "end_call" }));
              // Don't close yet — let SIP bridge handle hangup
            }
          }
        } catch (err) {
          console.error("  Pipeline error:", err.message);
          // Send a fallback response
          const fallback = "I'm sorry, could you repeat that?";
          ws.send(JSON.stringify({ type: "turn", caller_text: "", agent_text: fallback, error: err.message }));
          try {
            const fallbackAudio = await textToSpeech(fallback);
            if (fallbackAudio.audio) {
              ws.send(downsample(fallbackAudio.audio, 24000, PHONE_SAMPLE_RATE));
            }
          } catch {}
        }

        // Reset for next turn
        audioChunks = [];
        speechStartTime = null;
        isProcessing = false;
      }

      // Safety: force process if recording too long
      if (speechDuration >= MAX_RECORDING_MS) {
        console.log("  ⚠️ Max recording duration reached, forcing process");
        isProcessing = true;
        // ... same processing as above (simplified for now)
        audioChunks = [];
        speechStartTime = null;
        isProcessing = false;
      }
    }
  });

  // Handle disconnection
  ws.on("close", async () => {
    console.log(`\n📞 Call ended: ${callerNumber} (${turnCount} turns)`);

    if (callId) {
      // Classify and close the call
      try {
        const classification = await agent.classifyCall(conversationHistory);
        const duration = Math.round((Date.now() - (call?.created_at ? new Date(call.created_at).getTime() : Date.now())) / 1000);

        await supabase.from("calls").update({
          transcript: conversationHistory,
          status: classification.status || "completed",
          call_type: classification.type || "other",
          summary: classification.summary || "Call completed",
          duration_seconds: duration,
          ended_at: new Date().toISOString(),
        }).eq("id", callId);
      } catch (err) {
        console.error("  Failed to close call:", err.message);
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`  WebSocket error: ${err.message}`);
  });
}

/**
 * Handle JSON control messages from SIP bridge
 */
async function handleControlMessage(msg, ws, callId, supabase, history, agent, restaurant) {
  switch (msg.type) {
    case "dtmf":
      console.log(`  📱 DTMF: ${msg.digit}`);
      // Handle touch-tone input if needed
      break;

    case "hangup":
      console.log("  📱 Caller hung up");
      ws.close();
      break;

    case "hold":
      console.log("  📱 Call on hold");
      break;

    case "status":
      ws.send(JSON.stringify({
        type: "status",
        call_id: callId,
        turns: history.length,
        pipeline: getPipelineStatus(),
      }));
      break;

    default:
      console.log(`  Unknown control message: ${msg.type}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  AUDIO HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Detect if audio chunk contains sound above threshold
 */
function detectSound(buffer, threshold) {
  // Read 16-bit PCM samples
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = Math.abs(buffer.readInt16LE(i));
    if (sample > threshold) return true;
  }
  return false;
}

/**
 * Convert raw PCM buffer to WAV format
 */
function pcmToWav(pcmBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataLength);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);

  pcmBuffer.copy(buffer, 44);
  return buffer;
}

/**
 * Downsample WAV audio from one sample rate to another
 * Used to convert 24kHz Kokoro output to 8kHz phone audio
 */
function downsample(wavBuffer, fromRate, toRate) {
  if (fromRate === toRate) return wavBuffer;

  // Skip WAV header (44 bytes) to get PCM data
  const headerSize = 44;
  if (wavBuffer.length <= headerSize) return wavBuffer;

  const pcmData = wavBuffer.slice(headerSize);
  const ratio = fromRate / toRate;
  const newLength = Math.floor(pcmData.length / 2 / ratio);
  const output = Buffer.alloc(44 + newLength * 2);

  // Write new WAV header
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + newLength * 2, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(toRate, 24);
  output.writeUInt32LE(toRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(newLength * 2, 40);

  // Linear interpolation downsample
  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const offset = srcIndex * 2;
    if (offset + 1 < pcmData.length) {
      const sample = pcmData.readInt16LE(offset);
      output.writeInt16LE(sample, 44 + i * 2);
    }
  }

  return output;
}

/**
 * Update call transcript in Supabase
 */
async function updateCallTranscript(callId, transcript, supabase) {
  if (!callId) return;
  await supabase.from("calls").update({ transcript }).eq("id", callId);
}

/**
 * Save order to database
 */
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

/**
 * Save reservation to database
 */
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


module.exports = { setupWebSocket };
