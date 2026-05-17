/**
 * AnswerBite Voice Pipeline
 * 
 * Orchestrates the full voice conversation loop:
 *   Audio In → Whisper STT (Groq) → LLM (Groq) → Kokoro TTS → Audio Out
 * 
 * This module handles:
 *   1. Speech-to-Text via Groq Whisper API
 *   2. LLM response via Groq (already in agent.js)
 *   3. Text-to-Speech via Kokoro (self-hosted or kokoro-js local)
 * 
 * When SIP.US is connected, the WebSocket handler in index.js
 * will pipe real-time phone audio through this pipeline.
 */

const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'placeholder' });

// ═══════════════════════════════════════════════════════════════
//  SPEECH-TO-TEXT (Groq Whisper)
//  $0.111/hour = ~$0.002/min = practically free
// ═══════════════════════════════════════════════════════════════

async function speechToText(audioBuffer, options = {}) {
  const {
    language = "en",
    model = "whisper-large-v3",
  } = options;

  try {
    // Groq expects a File-like object
    // Write buffer to temp file, then pass to Groq
    const tempPath = path.join("/tmp", `stt_${Date.now()}.wav`);
    fs.writeFileSync(tempPath, audioBuffer);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model,
      language,
      response_format: "json",
    });

    // Cleanup temp file
    try { fs.unlinkSync(tempPath); } catch {}

    return {
      text: transcription.text,
      language: transcription.language || language,
    };
  } catch (err) {
    console.error("STT error:", err.message);
    return { text: "", error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════
//  TEXT-TO-SPEECH (Kokoro)
//  Uses either:
//    A) Self-hosted Kokoro-FastAPI container (OpenAI-compatible API)
//    B) kokoro-js running locally in Node.js (CPU, no GPU needed)
// ═══════════════════════════════════════════════════════════════

let kokoroTTS = null;
let kokoroReady = false;
let kokoroInitializing = false;

// Mode: "api" uses a remote Kokoro server, "local" uses kokoro-js
const TTS_MODE = process.env.KOKORO_MODE || "api";
const KOKORO_API_URL = process.env.KOKORO_API_URL || "http://localhost:8880/v1/audio/speech";
const KOKORO_VOICE = process.env.KOKORO_VOICE || "af_heart";
const KOKORO_SPEED = parseFloat(process.env.KOKORO_SPEED || "1.1");

/**
 * Initialize kokoro-js for local TTS (no external server needed)
 * Downloads the ONNX model on first run (~200MB), cached afterwards
 */
async function initKokoroLocal() {
  if (kokoroReady || kokoroInitializing) return;
  kokoroInitializing = true;

  try {
    console.log("🔊 Loading Kokoro TTS model (first time takes ~1 min)...");
    const { KokoroTTS } = await import("kokoro-js");
    kokoroTTS = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: "q8", device: "cpu" }
    );
    kokoroReady = true;
    console.log("✅ Kokoro TTS loaded and ready");
  } catch (err) {
    console.error("❌ Failed to load Kokoro TTS:", err.message);
    kokoroInitializing = false;
  }
}

/**
 * Generate speech audio from text
 * Returns a Buffer containing WAV audio data
 */
async function textToSpeech(text, options = {}) {
  const {
    voice = KOKORO_VOICE,
    speed = KOKORO_SPEED,
  } = options;

  if (!text || text.trim().length === 0) {
    return { audio: null, error: "Empty text" };
  }

  try {
    if (TTS_MODE === "local") {
      return await ttsLocal(text, voice, speed);
    } else {
      return await ttsAPI(text, voice, speed);
    }
  } catch (err) {
    console.error("TTS error:", err.message);
    return { audio: null, error: err.message };
  }
}

/**
 * TTS via kokoro-js (runs locally, no GPU needed)
 */
async function ttsLocal(text, voice, speed) {
  if (!kokoroReady) {
    await initKokoroLocal();
  }
  if (!kokoroTTS) {
    return { audio: null, error: "Kokoro TTS not initialized" };
  }

  const result = await kokoroTTS.generate(text, { voice, speed });

  // result.audio contains Float32Array audio data at 24kHz
  // Convert to WAV buffer
  const wavBuffer = float32ToWav(result.audio, 24000);

  return {
    audio: wavBuffer,
    format: "wav",
    sampleRate: 24000,
    duration: result.audio.length / 24000,
  };
}

/**
 * TTS via remote Kokoro-FastAPI server (OpenAI-compatible)
 */
async function ttsAPI(text, voice, speed) {
  const response = await fetch(KOKORO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.KOKORO_API_KEY || "not-needed"}`,
    },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice,
      speed,
      response_format: "wav",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kokoro API error: ${response.status} - ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);

  return {
    audio,
    format: "wav",
    sampleRate: 24000,
    duration: null, // unknown from API
  };
}


// ═══════════════════════════════════════════════════════════════
//  FULL VOICE PIPELINE
//  Audio In → STT → LLM → TTS → Audio Out
// ═══════════════════════════════════════════════════════════════

/**
 * Process a single voice turn:
 *   1. Convert caller audio to text (Whisper STT)
 *   2. Get AI response (Groq LLM via agent.js)
 *   3. Convert AI response to audio (Kokoro TTS)
 * 
 * @param {Buffer} audioBuffer - Caller's audio in WAV format
 * @param {Object} agent - The restaurant agent (from agent.js)
 * @param {Array} conversationHistory - Previous turns
 * @returns {Object} { callerText, agentText, agentAudio, action, order, reservation }
 */
async function processVoiceTurn(audioBuffer, agent, conversationHistory = []) {
  const startTime = Date.now();

  // Step 1: STT
  console.log("  🎤 STT: Converting speech to text...");
  const sttStart = Date.now();
  const stt = await speechToText(audioBuffer);
  const sttTime = Date.now() - sttStart;

  if (!stt.text || stt.text.trim().length === 0) {
    console.log("  ⚠️ No speech detected");
    return {
      callerText: "",
      agentText: "I'm sorry, I didn't catch that. Could you repeat?",
      agentAudio: null,
      action: null,
      timings: { stt: sttTime, llm: 0, tts: 0, total: Date.now() - startTime },
    };
  }
  console.log(`  🎤 STT (${sttTime}ms): "${stt.text}"`);

  // Step 2: LLM
  console.log("  🧠 LLM: Getting AI response...");
  const llmStart = Date.now();
  const response = await agent.respond(stt.text, conversationHistory);
  const llmTime = Date.now() - llmStart;
  console.log(`  🧠 LLM (${llmTime}ms): "${response.text}"`);

  // Step 3: TTS
  console.log("  🔊 TTS: Converting text to speech...");
  const ttsStart = Date.now();
  const tts = await textToSpeech(response.text);
  const ttsTime = Date.now() - ttsStart;
  console.log(`  🔊 TTS (${ttsTime}ms): ${tts.audio ? `${tts.audio.length} bytes` : "failed"}`);

  const totalTime = Date.now() - startTime;
  console.log(`  ⚡ Total pipeline: ${totalTime}ms (STT:${sttTime} + LLM:${llmTime} + TTS:${ttsTime})`);

  return {
    callerText: stt.text,
    agentText: response.text,
    agentAudio: tts.audio,
    agentAudioFormat: tts.format || "wav",
    action: response.action,
    order: response.order,
    reservation: response.reservation,
    timings: { stt: sttTime, llm: llmTime, tts: ttsTime, total: totalTime },
  };
}


// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Convert Float32Array audio data to WAV buffer
 */
function float32ToWav(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataLength);

  // WAV header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);

  // Convert float32 to int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(Math.round(val), 44 + i * 2);
  }

  return buffer;
}

/**
 * Get pipeline status
 */
function getPipelineStatus() {
  return {
    stt: {
      provider: "groq-whisper",
      model: "whisper-large-v3",
      ready: !!process.env.GROQ_API_KEY,
    },
    llm: {
      provider: "groq",
      model: "llama-3.1-8b-instant",
      ready: !!process.env.GROQ_API_KEY,
    },
    tts: {
      provider: TTS_MODE === "local" ? "kokoro-js-local" : "kokoro-api",
      voice: KOKORO_VOICE,
      speed: KOKORO_SPEED,
      ready: TTS_MODE === "api" ? true : kokoroReady,
      apiUrl: TTS_MODE === "api" ? KOKORO_API_URL : null,
    },
  };
}


module.exports = {
  speechToText,
  textToSpeech,
  processVoiceTurn,
  initKokoroLocal,
  getPipelineStatus,
};
