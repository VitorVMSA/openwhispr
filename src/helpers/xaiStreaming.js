const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const XAI_STT_URL = "wss://api.x.ai/v1/stt";
const CONNECT_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 5000;
const DEFAULT_SAMPLE_RATE = 16000;
const COLD_START_SECONDS = 3;

function transcriptText(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.transcript === "string") return message.transcript;
  return "";
}

function errorText(message) {
  if (typeof message.error === "string") return message.error;
  if (message.error && typeof message.error.message === "string") return message.error.message;
  if (typeof message.message === "string") return message.message;
  return "xAI speech stream failed";
}

// Maps the documented xAI streaming events onto the meeting client callbacks.
// Interim text can still change. A locked chunk (is_final) is committed once;
// speech_final is the same commit when it repeats that chunk.
function classifyXaiSttMessage(message) {
  if (!message || typeof message !== "object") return { kind: "ignore" };
  if (message.type === "transcript.created") return { kind: "ready" };
  if (message.type === "transcript.done") return { kind: "done", text: transcriptText(message) };
  if (message.type === "error" || message.type === "transcript.error") {
    return { kind: "error", text: errorText(message) };
  }
  if (message.type === "transcript.partial") {
    const text = transcriptText(message);
    return message.is_final === true ? { kind: "final", text } : { kind: "partial", text };
  }
  return { kind: "ignore" };
}

function buildXaiSttWebSocketUrl({ model, language, format, sampleRate }) {
  const params = new URLSearchParams();
  params.set("sample_rate", String(sampleRate));
  params.set("encoding", "pcm");
  params.set("interim_results", "true");
  params.set("model", model);
  if (language) params.set("language", language);
  if (format) params.set("format", "true");
  return `${XAI_STT_URL}?${params.toString()}`;
}

async function resolveXaiStreamQuery(options = {}) {
  const { resolveByokModel, XAI_STT_LANGUAGES, XAI_STT_FORMAT_LANGUAGES } = await import(
    "./transcriptionRoute.ts"
  );
  const model = resolveByokModel("xai", options.model);
  const languageCode =
    typeof options.language === "string" ? options.language.split("-")[0].toLowerCase() : "";
  const language = XAI_STT_LANGUAGES.has(languageCode) ? languageCode : undefined;
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : DEFAULT_SAMPLE_RATE;
  return {
    model,
    language,
    format: Boolean(language && XAI_STT_FORMAT_LANGUAGES.has(language)),
    sampleRate,
  };
}

class XaiStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.connecting = false;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.sessionStartedAt = null;
    this.finalSegments = [];
    this.accumulatedText = "";
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.frameBytes = (DEFAULT_SAMPLE_RATE * 2) / 10;
    this.maxPendingBytes = DEFAULT_SAMPLE_RATE * 2 * COLD_START_SECONDS;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onConnectionLost = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.closeResolve = null;
    this.connectionTimeout = null;
    this.closeTimer = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  async connect(options = {}) {
    if (!options.apiKey) throw new Error("No xAI API key configured. Add your key in Settings.");
    const query = await resolveXaiStreamQuery(options);
    const url = buildXaiSttWebSocketUrl(query);
    this.frameBytes = Math.max(2, (query.sampleRate * 2) / 10);
    this.maxPendingBytes = query.sampleRate * 2 * COLD_START_SECONDS;
    this.connecting = true;
    this.isDisconnecting = false;
    debugLogger.debug("xAI speech stream connecting", {
      model: query.model,
      language: query.language || null,
      sampleRate: query.sampleRate,
    });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.connectionTimeout = setTimeout(() => {
        const error = new Error("xAI speech stream connection timeout");
        this.failConnect(error);
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${options.apiKey}` },
      });
      this.ws = ws;
      ws.on("message", (data) => {
        if (ws !== this.ws) return;
        this.handleMessage(data);
      });
      ws.on("error", (error) => {
        if (ws !== this.ws) return;
        debugLogger.error("xAI speech stream error", { error: error.message });
        if (this.pendingReject) {
          this.failConnect(error);
          return;
        }
        if (!this.isDisconnecting) this.onError?.(error);
      });
      ws.on("close", (code) => {
        if (ws !== this.ws) return;
        const wasActive = this.isConnected;
        if (this.pendingReject) {
          this.failConnect(new Error(`xAI speech stream closed before ready (code: ${code})`));
          return;
        }
        this.finishClose();
        if (wasActive && !this.isDisconnecting) {
          this.onConnectionLost?.(new Error(`xAI speech stream closed (code: ${code})`));
        }
      });
    });
  }

  failConnect(error) {
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.cleanup();
    reject?.(error);
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const event = classifyXaiSttMessage(message);
    if (event.kind === "ready") {
      this.isConnected = true;
      this.connecting = false;
      this.sessionStartedAt = Date.now();
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      this.flushBuffer();
      resolve?.();
      return;
    }
    if (event.kind === "partial") {
      const text = event.text.trim();
      if (text) this.onPartialTranscript?.(text);
      return;
    }
    if (event.kind === "final") {
      this.commitFinal(event.text);
      return;
    }
    if (event.kind === "done") {
      if (!this.accumulatedText && event.text.trim()) this.commitFinal(event.text);
      this.finishClose();
      return;
    }
    if (event.kind === "error") {
      const error = new Error(event.text);
      debugLogger.error("xAI speech stream rejected audio", { error: error.message });
      if (this.pendingReject) {
        this.failConnect(error);
        return;
      }
      if (!this.isDisconnecting) this.onError?.(error);
    }
  }

  commitFinal(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.finalSegments[this.finalSegments.length - 1]) return;
    this.finalSegments.push(trimmed);
    this.accumulatedText = this.finalSegments.join(" ");
    this.onFinalTranscript?.(this.accumulatedText, Date.now());
  }

  flushBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    for (const chunk of pending) this.sendFrame(chunk);
  }

  sendFrame(buffer) {
    for (let offset = 0; offset < buffer.length; offset += this.frameBytes) {
      const end = Math.min(offset + this.frameBytes, buffer.length);
      this.ws.send(buffer.subarray(offset, end));
      this.audioBytesSent += end - offset;
    }
  }

  sendAudio(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0 || this.isDisconnecting) return false;
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    if (!this.isConnected) {
      if (!this.connecting) return false;
      this.pendingAudio.push(buffer);
      this.pendingAudioBytes += buffer.length;
      while (this.pendingAudioBytes > this.maxPendingBytes && this.pendingAudio.length > 0) {
        this.pendingAudioBytes -= this.pendingAudio.shift().length;
      }
      return true;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.sendFrame(buffer);
    return true;
  }

  finishClose() {
    if (!this.closeResolve) return;
    const resolve = this.closeResolve;
    this.closeResolve = null;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    resolve({ text: this.accumulatedText });
  }

  async disconnect() {
    this.isDisconnecting = true;
    this.connecting = false;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      const text = this.accumulatedText;
      this.cleanup();
      reject(new Error("xAI speech stream disconnected"));
      return { text };
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const text = this.accumulatedText;
      this.cleanup();
      return { text };
    }
    this.ws.send(JSON.stringify({ type: "audio.done" }));
    const result = await Promise.race([
      new Promise((resolve) => {
        this.closeResolve = resolve;
      }),
      new Promise((resolve) => {
        this.closeTimer = setTimeout(() => resolve({ text: this.accumulatedText }), DISCONNECT_TIMEOUT_MS);
      }),
    ]);
    this.cleanup();
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.closeResolve = null;
    this.isConnected = false;
    this.connecting = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  }
}

module.exports = XaiStreaming;
module.exports.classifyXaiSttMessage = classifyXaiSttMessage;
module.exports.buildXaiSttWebSocketUrl = buildXaiSttWebSocketUrl;
module.exports.resolveXaiStreamQuery = resolveXaiStreamQuery;
