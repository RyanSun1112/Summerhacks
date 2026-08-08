'use strict';

const { clamp01, validateSongProfile, validateSongTarget } = require('./models');
const { mergeConfig } = require('./config');

const FEATURE_LABELS = {
  energy: 'energy',
  danceability: 'danceability',
  socialness: 'socialness',
  intensity: 'intensity',
  valence: 'valence'
};

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function songSimilarityDistance(a, b) {
  return (
    Math.abs(a.energy - b.energy) +
    Math.abs(a.danceability - b.danceability) +
    Math.abs(a.socialness - b.socialness) +
    Math.abs(a.intensity - b.intensity) +
    Math.abs(a.valence - b.valence)
  ) / 5;
}

function describeFeature(field, difference, signedDifference) {
  const label = FEATURE_LABELS[field];
  if (difference <= 0.08) return `+ ${label} near target`;
  if (difference >= 0.22) return `- ${label} ${signedDifference > 0 ? 'above' : 'below'} target`;
  return null;
}

function rankSongs(targetInput, songInputs, currentSongInput = null, recentHistoryInputs = [], configOverrides = {}) {
  const target = validateSongTarget(targetInput);
  const songs = songInputs.map(validateSongProfile);
  const currentSong = currentSongInput ? validateSongProfile(currentSongInput) : null;
  const recentHistory = recentHistoryInputs.filter(Boolean).map(validateSongProfile);
  const config = mergeConfig(configOverrides);
  const recentIds = new Set(
    recentHistory.slice(0, config.repetition.recentTrackExclusionWindow).map(song => song.id)
  );
  const recentArtists = new Set(
    recentHistory.slice(0, config.repetition.sameArtistWindow).map(song => song.artist.toLocaleLowerCase())
  );
  const lastSong = recentHistory[0] || currentSong;
  const ranked = [];

  for (const song of songs) {
    if (currentSong && song.id === currentSong.id) continue;
    if (recentIds.has(song.id)) continue;

    const reasons = [];
    const components = {};
    let weightedPenalty = 0;
    let activeWeight = 0;

    for (const field of Object.keys(FEATURE_LABELS)) {
      if (target[field] == null || config.scoringWeights[field] <= 0) continue;
      const signedDifference = song[field] - target[field];
      const difference = Math.abs(signedDifference);
      const weight = config.scoringWeights[field];
      weightedPenalty += weight * difference;
      activeWeight += weight;
      components[field] = { difference: round(difference), penalty: round(weight * difference) };
      const reason = describeFeature(field, difference, signedDifference);
      if (reason) reasons.push(reason);
    }

    if (target.bpmTarget != null && config.scoringWeights.bpm > 0) {
      const rawDifference = Math.abs(song.bpm - target.bpmTarget);
      const difference = clamp01(rawDifference / config.bpm.differenceScale);
      const weight = config.scoringWeights.bpm;
      weightedPenalty += weight * difference;
      activeWeight += weight;
      components.bpm = { difference: round(difference), rawDifference: round(rawDifference), penalty: round(weight * difference) };
      if (rawDifference <= 5) reasons.push('+ BPM transition is smooth');
      else if (target.bpmMin != null && target.bpmMax != null && (song.bpm < target.bpmMin || song.bpm > target.bpmMax)) {
        weightedPenalty += config.bpm.outsideWindowPenalty * activeWeight;
        reasons.push(`- BPM outside preferred ${Math.round(target.bpmMin)}–${Math.round(target.bpmMax)} range`);
      }
    }

    let score = 1 - (activeWeight ? weightedPenalty / activeWeight : 0);
    const artistRepeated = recentArtists.has(song.artist.toLocaleLowerCase());
    if (artistRepeated) {
      score -= config.repetition.sameArtistPenalty;
      reasons.push('- artist played in the last two songs');
    }
    if (lastSong && songSimilarityDistance(song, lastSong) < config.repetition.similarRecentThreshold) {
      score -= config.repetition.similarRecentPenalty;
      reasons.push('- very similar profile to the previous song');
    }
    score = clamp01(score);
    if (!reasons.length) reasons.push('+ balanced numeric fit for the DJ target');
    ranked.push({ song, score: round(score), reasons, components });
  }

  ranked.sort((a, b) => b.score - a.score || a.song.id.localeCompare(b.song.id));
  return ranked;
}

function topCandidates(rankedSongs, count) {
  if (!Number.isInteger(count) || count < 1) throw new TypeError('candidate count must be a positive integer');
  return rankedSongs.slice(0, count);
}

module.exports = { rankSongs, topCandidates, songSimilarityDistance };
