import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, buildApiUrl } from "../../../config/constants";
import logger from "../../../utils/logger";

// Same XAI_API_KEY the dictation path stores. Chat is OpenAI-compatible
// Chat Completions at /v1/chat/completions; speech stays on /v1/stt.
export const xaiProvider: InferenceProvider = {
  id: "xai",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("XAI_START", { model, agentName });
    const apiKey = await ctx.getApiKey("xai");
    const endpoint = buildApiUrl(API_ENDPOINTS.XAI_BASE, "/chat/completions");
    return ctx.callChatCompletionsApi(endpoint, apiKey, model, text, agentName, config, "xAI");
  },
};
