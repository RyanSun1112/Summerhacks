'use strict';

const { validateCrowdState } = require('./models');

const MOCK_SCENARIOS = Object.freeze({
  dancingGrowing: {
    energy: 0.75, rhythm: 0.84, clustering: 0.78, volume: 0.70, mobility: 0.25,
    energyTrend: 0.70, rhythmTrend: 0.78, clusteringTrend: 0.55,
    mobilityTrend: 0.45, volumeTrend: 0.62, currentBpm: 124
  },
  socializing: {
    energy: 0.35, rhythm: 0.22, clustering: 0.72, volume: 0.60, mobility: 0.30,
    energyTrend: 0.50, rhythmTrend: 0.45, clusteringTrend: 0.55,
    mobilityTrend: 0.50, volumeTrend: 0.52, currentBpm: 108
  },
  losingDanceFloor: {
    energy: 0.52, rhythm: 0.45, clustering: 0.55, volume: 0.58, mobility: 0.40,
    energyTrend: 0.30, rhythmTrend: 0.25, clusteringTrend: 0.42,
    mobilityTrend: 0.55, volumeTrend: 0.44, currentBpm: 120
  },
  peakDanceFloor: {
    energy: 0.92, rhythm: 0.91, clustering: 0.86, volume: 0.87, mobility: 0.20,
    energyTrend: 0.55, rhythmTrend: 0.60, clusteringTrend: 0.55,
    mobilityTrend: 0.45, volumeTrend: 0.58, currentBpm: 130
  },
  highMovementLowRhythm: {
    energy: 0.76, rhythm: 0.28, clustering: 0.46, volume: 0.64, mobility: 0.72,
    energyTrend: 0.53, rhythmTrend: 0.42, clusteringTrend: 0.48,
    mobilityTrend: 0.68, volumeTrend: 0.55, currentBpm: 116
  },
  calmSocial: {
    energy: 0.24, rhythm: 0.18, clustering: 0.58, volume: 0.34, mobility: 0.28,
    energyTrend: 0.49, rhythmTrend: 0.48, clusteringTrend: 0.52,
    mobilityTrend: 0.46, volumeTrend: 0.49, currentBpm: 98
  }
});

for (const [name, scenario] of Object.entries(MOCK_SCENARIOS)) {
  try {
    validateCrowdState(scenario);
  } catch (error) {
    throw new Error(`Invalid built-in DJ scenario ${name}: ${error.message}`);
  }
}

function getMockScenario(name) {
  if (!Object.hasOwn(MOCK_SCENARIOS, name)) {
    throw new RangeError(`unknown scenario ${name}; choose: ${Object.keys(MOCK_SCENARIOS).join(', ')}`);
  }
  return { ...MOCK_SCENARIOS[name], timestamp: Date.now() };
}

module.exports = { MOCK_SCENARIOS, getMockScenario };
