'use strict';

/**
 * @typedef {Object} CrowdState
 * @property {number} energy
 * @property {number} rhythm
 * @property {number} clustering
 * @property {number} volume
 * @property {number} mobility
 * @property {number} energyTrend
 * @property {number} rhythmTrend
 * @property {number} clusteringTrend
 * @property {number} mobilityTrend
 * @property {number} volumeTrend
 * @property {number=} currentBpm
 * @property {number=} timestamp
 */

/**
 * @typedef {Object} SongTarget
 * @property {number} energy
 * @property {number} danceability
 * @property {number} socialness
 * @property {number=} valence
 * @property {number=} intensity
 * @property {number=} bpmTarget
 * @property {number=} bpmMin
 * @property {number=} bpmMax
 * @property {string} intention
 * @property {string} policyCase
 * @property {'match'|'guide'|'blend'=} selectionMode
 * @property {number=} guidanceStrength
 */

const CROWD_UNIT_FIELDS = [
  'energy', 'rhythm', 'clustering', 'volume', 'mobility',
  'energyTrend', 'rhythmTrend', 'clusteringTrend', 'mobilityTrend', 'volumeTrend'
];

const SONG_UNIT_FIELDS = ['energy', 'danceability', 'valence', 'socialness', 'intensity'];
const SELECTION_MODES = Object.freeze(['match', 'guide', 'blend']);

const clamp01 = value => Math.max(0, Math.min(1, value));

function assertUnitFloat(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function validateSelectionMode(value) {
  if (!SELECTION_MODES.includes(value)) {
    throw new TypeError(`selectionMode must be one of: ${SELECTION_MODES.join(', ')}`);
  }
  return value;
}

function validateCrowdState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('crowdState must be an object');
  }
  const state = {};
  for (const field of CROWD_UNIT_FIELDS) state[field] = assertUnitFloat(input[field], `crowdState.${field}`);
  if (input.currentBpm != null) {
    if (typeof input.currentBpm !== 'number' || !Number.isFinite(input.currentBpm) || input.currentBpm <= 0) {
      throw new TypeError('crowdState.currentBpm must be a positive finite number');
    }
    state.currentBpm = input.currentBpm;
  }
  if (input.timestamp != null) {
    if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp)) {
      throw new TypeError('crowdState.timestamp must be a finite number');
    }
    state.timestamp = input.timestamp;
  }
  return state;
}

function validateSongProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('song profile must be an object');
  }
  for (const field of ['id', 'title', 'artist']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      throw new TypeError(`song.${field} must be a non-empty string`);
    }
  }
  if (typeof input.bpm !== 'number' || !Number.isFinite(input.bpm) || input.bpm <= 0) {
    throw new TypeError(`song ${input.id}.bpm must be a positive finite number`);
  }
  for (const field of SONG_UNIT_FIELDS) assertUnitFloat(input[field], `song ${input.id}.${field}`);
  if (input.year != null && (!Number.isInteger(input.year) || input.year < 1800 || input.year > 3000)) {
    throw new TypeError(`song ${input.id}.year must be a plausible integer`);
  }
  if (input.genres != null && (!Array.isArray(input.genres) || input.genres.some(value => typeof value !== 'string'))) {
    throw new TypeError(`song ${input.id}.genres must be an array of strings`);
  }
  return {
    ...input,
    id: input.id.trim(),
    title: input.title.trim(),
    artist: input.artist.trim(),
    genres: input.genres || []
  };
}

function validateSongTarget(target) {
  if (!target || typeof target !== 'object') throw new TypeError('song target must be an object');
  for (const field of ['energy', 'danceability', 'socialness']) {
    assertUnitFloat(target[field], `target.${field}`);
  }
  for (const field of ['valence', 'intensity']) {
    if (target[field] != null) assertUnitFloat(target[field], `target.${field}`);
  }
  for (const field of ['bpmTarget', 'bpmMin', 'bpmMax']) {
    if (target[field] != null && (typeof target[field] !== 'number' || !Number.isFinite(target[field]) || target[field] <= 0)) {
      throw new TypeError(`target.${field} must be a positive finite number`);
    }
  }
  if (typeof target.intention !== 'string' || !target.intention.trim()) {
    throw new TypeError('target.intention must be a non-empty string');
  }
  if (target.selectionMode != null) validateSelectionMode(target.selectionMode);
  if (target.guidanceStrength != null) assertUnitFloat(target.guidanceStrength, 'target.guidanceStrength');
  return target;
}

function validateAISelection(input, candidateIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('AI selection must be an object');
  }
  if (typeof input.songId !== 'string' || !candidateIds.includes(input.songId)) {
    throw new TypeError('AI songId must belong to the supplied candidate list');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 600) {
    throw new TypeError('AI reason must be a non-empty string of at most 600 characters');
  }
  assertUnitFloat(input.confidence, 'AI confidence');
  return { songId: input.songId, reason: input.reason.trim(), confidence: input.confidence };
}

module.exports = {
  CROWD_UNIT_FIELDS,
  SONG_UNIT_FIELDS,
  SELECTION_MODES,
  clamp01,
  assertUnitFloat,
  validateSelectionMode,
  validateCrowdState,
  validateSongProfile,
  validateSongTarget,
  validateAISelection
};
