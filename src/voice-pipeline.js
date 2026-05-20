/**
 * AnswerBite Voice Pipeline
 * 
 * Everything runs through Groq API — no extra servers needed.
 *   1. STT: Groq Whisper Large V3
 *   2. LLM: Groq Llama 3.1 8B (agent.js)
 *   3. TTS: Groq Orpheus (direct API call)
 */

const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "placeholder" });

const TTS_VOICE = process.env.TTS_VOICE || "troy";
const TTS_MODEL = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
const TTS_SPEED = parseFloat(process.env.TTS_SPEED || "1.0");

async function speechToText(audioBuffer, options = {}) {
  const { language = "en", model = "whisper-large-v3" } = options;
  try {
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", model);
    formData.append("language", language);
    formData.append("response_format", "json");
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error("Groq STT " + response.status + ": " + errText);
    }
    const data = await response.json();
    return { text: data.text, language: data.language || language };
  } catch (err) {
    console.error("STT error:", err.message);
    return { text: "", error: err.message };
  }
}

async function textToSpeech(text, options = {}) {
  const { voice = TTS_VOICE, speed = TTS_SPEED } = options;
  if (!text || text.trim().length === 0) return { audio: null, error: "Empty text" };
  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: voice,
        input: text,
        response_format: "wav",
        speed: speed,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error("Groq TTS " + response.status + ": " + errText);
    }
    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    return { audio, format: "wav", sampleRate: 48000, duration: null };
  } catch (err) {
    console.error("TTS error:", err.message);
    return { audio: null, error: err.message };
  }
}

async function processVoiceTurn(audioBuffer, agent, conversationHistory = []) {
  const startTime = Date.now();
  console.log("  STT: Converting speech to text...");
  const sttStart = Date.now();
  const stt = await speechToText(audioBuffer);
  const sttTime = Date.now() - sttStart;
  if (!stt.text || stt.text.trim().length === 0) {
    return {
      callerText: "", agentText: "I'm sorry, I didn't catch that. Could you repeat?",
      agentAudio: null, action: null,
      timings: { stt: sttTime, llm: 0, tts: 0, total: Date.now() - startTime },
    };
  }
  console.log("  STT (" + sttTime + "ms): " + stt.text);
  console.log("  LLM: Getting AI response...");
  const llmStart = Date.now();
  const response = await agent.respond(stt.text, conversationHistory);
  const llmTime = Date.now() - llmStart;
  console.log("  LLM (" + llmTime + "ms): " + response.text);
  console.log("  TTS: Converting text to speech...");
  const ttsStart = Date.now();
  const tts = await textToSpeech(response.text);
  const ttsTime = Date.now() - ttsStart;
  const totalTime = Date.now() - startTime;
  console.log("  Total pipeline: " + totalTime + "ms");
  return {
    callerText: stt.text, agentText: response.text,
    agentAudio: tts.audio, agentAudioFormat: tts.format || "wav",
    action: response.action, order: response.order, reservation: response.reservation,
    timings: { stt: sttTime, llm: llmTime, tts: ttsTime, total: totalTime },
  };
}

function getPipelineStatus() {
  return {
    stt: { provider: "groq-whisper", model: "whisper-large-v3", ready: !!process.env.GROQ_API_KEY },
    llm: { provider: "groq", model: "llama-3.1-8b-instant", ready: !!process.env.GROQ_API_KEY },
    tts: { provider: "groq-orpheus", model: TTS_MODEL, voice: TTS_VOICE, speed: TTS_SPEED, ready: !!process.env.GROQ_API_KEY },
  };
}

module.exports = { speechToText, textToSpeech, processVoiceTurn, getPipelineStatus };
