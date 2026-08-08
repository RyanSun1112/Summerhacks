'use strict';

const DEFAULT_DJ_CONFIG = Object.freeze({
  thresholds: Object.freeze({
    highRhythm: 0.65,
    highEnergy: 0.65,
    activeEnergy: 0.55,
    risingTrend: 0.55,
    fallingTrend: 0.40,
    highClustering: 0.65,
    lowMobility: 0.35,
    lowRhythm: 0.40,
    calmEnergy: 0.42,
    peakEnergy: 0.85,
    peakRhythm: 0.80,
    peakSongEnergy: 0.82,
    peakHistoryCount: 2
  }),
  adjustments: Object.freeze({
    buildEnergy: 0.08,
    buildDanceability: 0.07,
    fallingEnergy: 0.12,
    fallingDanceability: 0.16,
    peakRelief: 0.06,
    repeatedPeakRelief: 0.11
  }),
  bpm: Object.freeze({
    normalWindow: 8,
    socialWindow: 5,
    interventionWindow: 12,
    buildIncrease: 4,
    interventionIncrease: 6,
    peakVariation: -2,
    differenceScale: 30,
    outsideWindowPenalty: 0.06
  }),
  scoringWeights: Object.freeze({
    energy: 0.25,
    danceability: 0.25,
    socialness: 0.15,
    intensity: 0.10,
    valence: 0.05,
    bpm: 0.20
  }),
  repetition: Object.freeze({
    recentTrackExclusionWindow: 6,
    sameArtistWindow: 2,
    sameArtistPenalty: 0.09,
    similarRecentThreshold: 0.10,
    similarRecentPenalty: 0.05
  }),
  topCandidateCount: 10,
  ai: Object.freeze({
    model: 'gpt-5-mini',
    timeoutMs: 8000
  })
});

function mergeConfig(overrides = {}) {
  return {
    ...DEFAULT_DJ_CONFIG,
    ...overrides,
    thresholds: { ...DEFAULT_DJ_CONFIG.thresholds, ...(overrides.thresholds || {}) },
    adjustments: { ...DEFAULT_DJ_CONFIG.adjustments, ...(overrides.adjustments || {}) },
    bpm: { ...DEFAULT_DJ_CONFIG.bpm, ...(overrides.bpm || {}) },
    scoringWeights: { ...DEFAULT_DJ_CONFIG.scoringWeights, ...(overrides.scoringWeights || {}) },
    repetition: { ...DEFAULT_DJ_CONFIG.repetition, ...(overrides.repetition || {}) },
    ai: { ...DEFAULT_DJ_CONFIG.ai, ...(overrides.ai || {}) }
  };
}

module.exports = { DEFAULT_DJ_CONFIG, mergeConfig };
