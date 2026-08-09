'use strict';

const { validateAISelection, validateCrowdState, validateSongTarget } = require('./models');
const { mergeConfig } = require('./config');

const AI_SELECTOR_SYSTEM_PROMPT = `You are the final decision engine for an adaptive venue DJ.

You receive numerical crowd measurements, the deterministic DJ target, the current
song, recent history, and a small candidate list already chosen by a deterministic
ranker. Crowd and semantic song metrics range from 0 to 1; BPM does not.

Crowd ENERGY is physical movement intensity. RHYTHM is periodic/synchronized
movement. CLUSTERING is spatial concentration. MOBILITY is relocation around the
venue. VOLUME is venue acoustic energy. Trend values use 0 for strongly decreasing,
0.5 for stable, and 1 for strongly increasing.

Song ENERGY is perceived musical energy. DANCEABILITY is groove accessibility.
SOCIALNESS is suitability for conversation/mingling. VALENCE is emotional
positivity. INTENSITY is forcefulness.

The DJ target also declares a selectionMode. MATCH means preserve the room's present
energy and groove. GUIDE means intentionally build, maintain, cool, or re-engage
according to the stated intention. BLEND means balance those goals according to
guidanceStrength, where 0 is matching and 1 is full guidance.

Select EXACTLY ONE songId from the supplied candidate list. Never invent another
song. Use the DJ target as the primary direction while considering crowd trajectory,
transition smoothness, recent history, repetition, emotional variation, and the
deterministic score. Do not always select the highest-energy song. More energy is
not always better, and the numerically highest score may be passed over when another
candidate clearly fits the build/maintain/cool-down trajectory better.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    songId: { type: 'string' },
    reason: { type: 'string', minLength: 1, maxLength: 600 },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['songId', 'reason', 'confidence'],
  additionalProperties: false
};

function compactSong(song) {
  if (!song) return null;
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    year: song.year || null,
    genres: song.genres || [],
    bpm: song.bpm,
    energy: song.energy,
    danceability: song.danceability,
    socialness: song.socialness,
    valence: song.valence,
    intensity: song.intensity
  };
}

function buildAIInput({ crowdState, target, currentSong, recentHistory, candidates }) {
  return {
    crowdState: validateCrowdState(crowdState),
    djTarget: validateSongTarget(target),
    currentSong: compactSong(currentSong),
    recentSongs: recentHistory.map(compactSong),
    candidates: candidates.map(candidate => ({
      ...compactSong(candidate.song),
      deterministicScore: candidate.score,
      deterministicReasons: candidate.reasons
    }))
  };
}

class OpenAISelector {
  constructor(options = {}) {
    const config = mergeConfig(options.config);
    this.model = options.model || process.env.OPENAI_DJ_MODEL || config.ai.model;
    this.timeoutMs = options.timeoutMs || config.ai.timeoutMs;
    this.client = options.client || null;
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!this.client && !this.apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }
  }

  getClient() {
    if (this.client) return this.client;
    // Loaded only when AI is explicitly enabled, so deterministic selection has
    // no SDK or key dependency at runtime.
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey: this.apiKey, timeout: this.timeoutMs, maxRetries: 1 });
    return this.client;
  }

  async select(context) {
    const payload = buildAIInput(context);
    const candidateIds = payload.candidates.map(song => song.id);
    if (!candidateIds.length) throw new Error('AI selector received no candidates');
    const response = await this.getClient().responses.create({
      model: this.model,
      input: [
        { role: 'system', content: AI_SELECTOR_SYSTEM_PROMPT },
        { role: 'user', content: `Choose the next song from this JSON only:\n${JSON.stringify(payload)}` }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'dj_final_selection',
          strict: true,
          schema: RESPONSE_SCHEMA
        }
      }
    });
    if (typeof response.output_text !== 'string' || !response.output_text.trim()) {
      throw new Error('OpenAI returned no structured selection text');
    }
    let parsed;
    try {
      parsed = JSON.parse(response.output_text);
    } catch (error) {
      throw new Error(`OpenAI returned malformed selection JSON: ${error.message}`);
    }
    return validateAISelection(parsed, candidateIds);
  }
}

module.exports = {
  AI_SELECTOR_SYSTEM_PROMPT,
  RESPONSE_SCHEMA,
  compactSong,
  buildAIInput,
  OpenAISelector
};
