/**
 * Real Gemini-backed IntentAdapter via `@google/genai` (ARCHITECTURE.md).
 *
 * Constructed ONLY when an API key is present (GEMINI_API_KEY); the offline
 * test suite never imports this module's runtime path. The SDK is loaded
 * lazily so `npm test` stays network-free even if the package were absent.
 */

import type { Intent, IntentAdapter, IntentResult, Invoice } from '../types';
import { INTENTS } from '../types';

export interface GeminiAdapterOptions {
  apiKey: string;
  model?: string; // Flash by default per ARCHITECTURE model routing
}

export function geminiKeyFromEnv(): string | undefined {
  const k = process.env.GEMINI_API_KEY;
  return k && k.trim().length > 0 ? k.trim() : undefined;
}

export class GeminiIntentAdapter implements IntentAdapter {
  readonly name = 'gemini-intent-adapter';
  private readonly model: string;
  private client: unknown | null = null;

  constructor(private readonly opts: GeminiAdapterOptions) {
    if (!opts.apiKey) throw new Error('GeminiIntentAdapter requires an apiKey; use DeterministicMockAdapter offline');
    this.model = opts.model ?? 'gemini-2.5-flash';
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      const mod = await import('@google/genai');
      this.client = new mod.GoogleGenAI({ apiKey: this.opts.apiKey });
    }
    return this.client;
  }

  async classify(text: string, ctx: { invoice: Invoice }): Promise<IntentResult> {
    const ai = await this.getClient();
    const { Type } = await import('@google/genai');
    const res = await ai.models.generateContent({
      model: this.model,
      contents:
        `You classify a debtor's email reply about an overdue B2B invoice ` +
        `(${ctx.invoice.amountCents / 100} USD, ${ctx.invoice.agedDays} days past due).\n` +
        `Reply text:\n"""${text}"""\n` +
        `Pick exactly one intent. "hardship" = wants to pay but is cash-constrained; ` +
        `"ghost" = deflection with no payment signal. A money-difficulty statement is hardship, not ghost.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: { type: Type.STRING, enum: [...INTENTS] },
            confidence: { type: Type.NUMBER },
            rationale: { type: Type.STRING },
          },
          required: ['intent', 'confidence', 'rationale'],
        },
      },
    });
    const raw = typeof res.text === 'string' ? res.text : String(res.text ?? '');
    let parsed: { intent?: string; confidence?: number; rationale?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini returned non-JSON despite responseSchema: ${raw.slice(0, 120)}`);
    }
    const intent = (INTENTS as readonly string[]).includes(parsed.intent ?? '') ? (parsed.intent as Intent) : 'ghost';
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    return { intent, confidence, rationale: parsed.rationale ?? 'gemini classification', source: 'adapter' };
  }
}

/** Factory: real adapter iff a key is configured, else null (caller falls back to mock/heuristic). */
export function maybeGeminiAdapter(model?: string): GeminiIntentAdapter | null {
  const key = geminiKeyFromEnv();
  if (!key) return null;
  return new GeminiIntentAdapter(model !== undefined ? { apiKey: key, model } : { apiKey: key });
}
