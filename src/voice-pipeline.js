/**
 * AnswerBite Voice Pipeline
 * 
 * Orchestrates the full voice conversation loop:
 *   Audio In → Groq Whisper STT → Groq LLM → Groq TTS → Audio Out
 * 
 * Everything runs through Groq's API — no extra servers needed.
 *   1. Speech-to-Text: Groq Whisper Large V3 ($0.111/hour)
 *   2. LLM: Groq Llama 3.1 8B (agent.js)
 *   3. Text-to-Speech: Groq PlayAI TTS ($0.05/M chars)
 */

const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "placeholder" });

// TTS settings
const TTS_VOICE = process.env.TTS_VOICE || "Arista-PlayAI";
const TTS_MODEL = process.env.TTS_MODEL || "playai-tts";
const TTS_SPEED = parseFloat(process.env.TTS_SPEED || "1.0");


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
    const tempPath = path.join("/tmp", `stt_${Date.now()}.wav`);
    fs.writeFileSync(tempPath, audioBuffer);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model,
      language,
      response_format: "json",
    });

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
//  TEXT-TO-SPEECH (Groq PlayAI TTS)
//  $0.05 per million characters = basically free
//  No extra server needed — uses same Groq API key
// ═══════════════════════════════════════════════════════════════

async function textToSpeech(text, options = {}) {
  const {
    voice = TTS_VOICE,
    speed = TTS_SPEED,
  } = options;

  if (!text || text.trim().length === 0) {
    return { audio: null, error: "Empty text" };
  }

  try {
    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      voice: voice,
      input: text,
      response_format: "wav",
      speed: speed,
    });

    // Get audio as buffer
    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);

    return {
      audio,
      format: "wav",
      sampleRate: 24000,
      duration: null,
    };
  } catch (err) {
    console.error("TTS error:", err.message);
    return { audio: null, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════
//  FULL VOICE PIPELINE
//  Audio In → STT → LLM → TTS → Audio Out
// ═══════════════════════════════════════════════════════════════

async function processVoiceTurn(audioBuffer, agent, conversationHistory = []) {
  const startTime = Date.now();

  // Step 1: STT
  console.log("  🎀 STT: Converting speech to text...");
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
  console.log(`  🎀 STT (${sttTime}ms): "${stt.text}"`);

  // Step 2: LLM
  console.log("  🧠 LLM: Getting AI response...");
  const llmStart = Date.now();
  const response = await agent.respond(stt.text, conversationHistory);
  const llmTime = Date.now() - llmStart;
  console.log(`  🧠 LLM (${llmTime}ms): "${response.text}"`);

  // Step 3: TTS
  console.log("  πŸ"Š TTS: Converting text to speech...");
  const ttsStart = Date.now();
  const tts = await textToSpeech(response.text);
  const ttsTime = Date.now() - ttsStart;
  console.log(`  πŸ"Š TTS (${ttsTime}ms): ${tts.audio ? `${tts.audio.length} bytes` : "failed"}`);

  const totalTime = Date.now() - startTime;
  console.log(`  ⚑ Total pipeline: ${totalTime}ms (STT:${sttTime} + LLM:${llmTime} + TTS:${ttsTime})`);

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
      provider: "groq-playai",
      model: TTS_MODEL,
      voice: TTS_VOICE,
      speed: TTS_SPEED,
      ready: !!process.env.GROQ_API_KEY,
    },
  };
}


module.exports = {
  speechToText,
  textToSpeech,
  processVoiceTurn,
  getPipelineStatus,
};
