export const MODEL_PRESETS = Object.freeze([
  { id: 'astra', model: 'gpt-6-astra', effort: 'medium', label: 'Astra · medium' },
  { id: 'sol', model: 'gpt-5.6-sol', effort: 'high', label: 'Sol · high' },
  { id: 'terra', model: 'gpt-5.6-terra', effort: 'xhigh', label: 'Terra · xhigh' },
  { id: 'luna', model: 'gpt-5.6-luna', effort: 'max', label: 'Luna · max' },
]);
export function modelPreset(value = 'gpt-5.6-luna') {
  return MODEL_PRESETS.find((preset) => preset.model === value || preset.id === value) || null;
}
export function shortSpeech(value) {
  return Array.from(typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '').slice(0, 20).join('');
}
