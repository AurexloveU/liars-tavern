// Product AI is implemented in ai.js and calls the configured LLM over fetch.
// This compatibility module intentionally contains no rule-based player.
export { createAIProvider, requestDecision, validateDecision, AIProviderError } from './ai.js';
