'use strict';

const {
  clamp01,
  assertUnitFloat,
  validateCrowdState,
  validateSelectionMode,
  validateSongTarget
} = require('./models');
const { mergeConfig } = require('./config');

function countRecentPeakSongs(recentHistory, threshold) {
  return recentHistory.filter(song => song && song.energy >= threshold).length;
}

function baseTarget(crowd) {
  return {
    energy: clamp01(0.55 * crowd.energy + 0.20 * crowd.rhythm + 0.10 * crowd.volume + 0.10 * crowd.mobility + 0.05 * crowd.energyTrend),
    danceability: clamp01(0.70 * crowd.rhythm + 0.20 * crowd.energy + 0.10 * crowd.clustering * crowd.rhythm),
    socialness: clamp01(0.40 * (1 - crowd.rhythm) + 0.25 * (1 - crowd.energy) + 0.20 * crowd.mobility + 0.15 * crowd.clustering * (1 - crowd.rhythm)),
    intensity: clamp01(0.60 * crowd.energy + 0.25 * crowd.volume + 0.15 * Math.max(0, crowd.energyTrend * 2 - 1)),
    valence: 0.58
  };
}

function currentBpmFor(crowd, currentSong) {
  return currentSong && Number.isFinite(currentSong.bpm) ? currentSong.bpm : crowd.currentBpm;
}

function roundTargetMetrics(target) {
  for (const field of ['energy', 'danceability', 'socialness', 'intensity', 'valence']) {
    target[field] = Math.round(target[field] * 10000) / 10000;
  }
  for (const field of ['bpmTarget', 'bpmMin', 'bpmMax']) {
    if (Number.isFinite(target[field])) target[field] = Math.round(target[field] * 100) / 100;
  }
  return target;
}

function matchingTarget(crowd, currentSong, config) {
  const target = {
    // Crowd energy and rhythm are the closest available observations for a
    // mirror strategy. The other musical qualities remain interpretations,
    // because the crowd has no direct socialness, intensity, or valence sensor.
    energy: crowd.energy,
    danceability: clamp01(0.80 * crowd.rhythm + 0.20 * crowd.energy),
    socialness: clamp01(
      0.45 * (1 - crowd.rhythm) +
      0.25 * (1 - crowd.energy) +
      0.20 * crowd.mobility +
      0.10 * crowd.clustering * (1 - crowd.rhythm)
    ),
    intensity: clamp01(0.70 * crowd.energy + 0.30 * crowd.volume),
    valence: 0.58,
    intention: "Match the room's present energy and groove with minimal intervention",
    policyCase: 'match-room',
    selectionMode: 'match',
    guidanceStrength: 0
  };
  const currentBpm = currentBpmFor(crowd, currentSong);
  if (currentBpm) {
    target.bpmTarget = currentBpm;
    target.bpmMin = Math.max(1, currentBpm - config.bpm.normalWindow);
    target.bpmMax = currentBpm + config.bpm.normalWindow;
  }
  return roundTargetMetrics(target);
}

function guidedTarget(crowd, currentSong, recentHistory, config) {
  const t = config.thresholds;
  const a = config.adjustments;
  const bpmConfig = config.bpm;
  const target = baseTarget(crowd);
  let bpmDelta = 0;
  let bpmWindow = bpmConfig.normalWindow;
  let intention = 'Maintain a balanced room with a smooth musical transition';
  let policyCase = 'balanced';

  const peak = crowd.energy > t.peakEnergy && crowd.rhythm > t.peakRhythm;
  const dancingGrowing = crowd.rhythm > t.highRhythm && crowd.energy > t.activeEnergy &&
    crowd.energyTrend > t.risingTrend && crowd.rhythmTrend > t.risingTrend;
  const highMovementLowRhythm = (crowd.energy > t.highEnergy || crowd.mobility > t.highEnergy) && crowd.rhythm < t.lowRhythm;
  const clusteredSocial = crowd.clustering > t.highClustering && crowd.mobility < t.lowMobility && crowd.rhythm < t.lowRhythm;
  const clusteredDanceFloor = crowd.clustering > t.highClustering && crowd.rhythm > t.highRhythm;
  const falling = crowd.energyTrend < t.fallingTrend && crowd.rhythmTrend < t.fallingTrend;
  const calm = crowd.energy < t.calmEnergy && crowd.rhythm < t.lowRhythm;

  if (peak) {
    const repeatedPeak = countRecentPeakSongs(recentHistory, t.peakSongEnergy) >= t.peakHistoryCount;
    const relief = repeatedPeak ? a.repeatedPeakRelief : a.peakRelief;
    Object.assign(target, {
      energy: clamp01(crowd.energy - relief),
      danceability: clamp01(Math.max(0.84, crowd.rhythm - 0.03)),
      socialness: 0.12,
      intensity: clamp01(crowd.energy - relief * 0.7),
      valence: repeatedPeak ? 0.62 : 0.68
    });
    bpmDelta = bpmConfig.peakVariation;
    bpmWindow = bpmConfig.normalWindow;
    intention = repeatedPeak ? 'Release the peak slightly while preserving the dance floor' : 'Maintain peak engagement with controlled variation';
    policyCase = 'peak-saturation';
  } else if (dancingGrowing) {
    Object.assign(target, {
      energy: clamp01(crowd.energy + a.buildEnergy),
      danceability: clamp01(crowd.rhythm + a.buildDanceability),
      socialness: clamp01(0.24 - crowd.rhythm * 0.08),
      intensity: clamp01(crowd.energy + 0.03),
      valence: 0.68
    });
    bpmDelta = bpmConfig.buildIncrease;
    intention = 'Continue building dance-floor energy without a dramatic jump';
    policyCase = 'dancing-growing';
  } else if (highMovementLowRhythm) {
    Object.assign(target, { energy: 0.55, danceability: 0.48, socialness: 0.72, intensity: 0.46, valence: 0.62 });
    bpmWindow = bpmConfig.socialWindow;
    intention = 'Support mingling and movement without falsely escalating to peak dance music';
    policyCase = 'movement-not-dancing';
  } else if (clusteredSocial) {
    Object.assign(target, { energy: 0.40, danceability: 0.36, socialness: 0.82, intensity: 0.32, valence: 0.66 });
    bpmDelta = -2;
    bpmWindow = bpmConfig.socialWindow;
    intention = 'Give clustered guests space to talk and socialize';
    policyCase = 'clustered-social';
  } else if (clusteredDanceFloor) {
    Object.assign(target, {
      energy: clamp01(Math.max(0.72, crowd.energy + 0.05)),
      danceability: clamp01(Math.max(0.86, crowd.rhythm + 0.04)),
      socialness: 0.18,
      intensity: clamp01(Math.max(0.66, crowd.energy)),
      valence: 0.65
    });
    bpmDelta = 2;
    intention = 'Serve the concentrated active dance floor';
    policyCase = 'clustered-dance-floor';
  } else if (falling) {
    Object.assign(target, {
      energy: clamp01(crowd.energy + a.fallingEnergy),
      danceability: clamp01(crowd.rhythm + a.fallingDanceability),
      socialness: clamp01(target.socialness - 0.10),
      intensity: clamp01(target.intensity + 0.10),
      valence: 0.72
    });
    bpmDelta = bpmConfig.interventionIncrease;
    bpmWindow = bpmConfig.interventionWindow;
    intention = 'Re-engage a weakening room with a modest, accessible lift';
    policyCase = 'falling-engagement';
  } else if (calm) {
    Object.assign(target, { energy: 0.36, danceability: 0.40, socialness: 0.80, intensity: 0.30, valence: 0.70 });
    bpmDelta = -2;
    bpmWindow = bpmConfig.socialWindow;
    intention = 'Keep the room pleasant, calm, and conversation-friendly';
    policyCase = 'calm-social';
  }

  const currentBpm = currentBpmFor(crowd, currentSong);
  if (currentBpm) {
    target.bpmTarget = Math.max(1, currentBpm + bpmDelta);
    target.bpmMin = Math.max(1, target.bpmTarget - bpmWindow);
    target.bpmMax = target.bpmTarget + bpmWindow;
  }
  target.intention = intention;
  target.policyCase = policyCase;
  target.selectionMode = 'guide';
  target.guidanceStrength = 1;
  return roundTargetMetrics(target);
}

function blendTargets(match, guide, guidanceStrength) {
  const target = {};
  for (const field of ['energy', 'danceability', 'socialness', 'intensity', 'valence']) {
    target[field] = match[field] * (1 - guidanceStrength) + guide[field] * guidanceStrength;
  }
  for (const field of ['bpmTarget', 'bpmMin', 'bpmMax']) {
    if (Number.isFinite(match[field]) && Number.isFinite(guide[field])) {
      target[field] = match[field] * (1 - guidanceStrength) + guide[field] * guidanceStrength;
    }
  }
  target.intention = `Blend ${Math.round(guidanceStrength * 100)}% DJ guidance with room matching: ${guide.intention}`;
  target.policyCase = `blend-${guide.policyCase}`;
  target.selectionMode = 'blend';
  target.guidanceStrength = guidanceStrength;
  return roundTargetMetrics(target);
}

function determineSongTarget(crowdInput, currentSong = null, recentHistory = [], configOverrides = {}) {
  const crowd = validateCrowdState(crowdInput);
  const config = mergeConfig(configOverrides);
  const mode = validateSelectionMode(config.selection.mode);
  const configuredStrength = assertUnitFloat(
    config.selection.guidanceStrength,
    'selection.guidanceStrength'
  );
  const match = matchingTarget(crowd, currentSong, config);

  if (mode === 'match') return validateSongTarget(match);

  const guide = guidedTarget(crowd, currentSong, recentHistory, config);
  if (mode === 'guide') return validateSongTarget(guide);

  return validateSongTarget(blendTargets(match, guide, configuredStrength));
}

module.exports = { determineSongTarget };
