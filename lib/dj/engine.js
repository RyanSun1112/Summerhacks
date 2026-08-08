'use strict';

const { mergeConfig } = require('./config');
const { validateAISelection, validateCrowdState } = require('./models');
const { determineSongTarget } = require('./policy');
const { rankSongs, topCandidates } = require('./ranker');

async function selectNextSong(options) {
  const {
    crowdState: crowdInput,
    songs,
    currentSong = null,
    recentHistory = [],
    aiSelector = null,
    useAI = false,
    config: configOverrides = {}
  } = options;
  const config = mergeConfig(configOverrides);
  const crowdState = validateCrowdState(crowdInput);
  const target = determineSongTarget(crowdState, currentSong, recentHistory, config);
  const ranked = rankSongs(target, songs, currentSong, recentHistory, config);
  const candidates = topCandidates(ranked, config.topCandidateCount);
  if (!candidates.length) throw new Error('no eligible songs remain after current/recent exclusions');

  let selected = candidates[0];
  let selectionMethod = 'deterministic';
  let aiSelection = null;
  let aiError = null;

  if (useAI) {
    if (!aiSelector) {
      selectionMethod = 'deterministic-fallback';
      aiError = 'AI unavailable; no selector or API key configured';
    } else {
      try {
        const response = await aiSelector.select({
          crowdState,
          target,
          currentSong,
          recentHistory,
          candidates
        });
        aiSelection = validateAISelection(response, candidates.map(candidate => candidate.song.id));
        selected = candidates.find(candidate => candidate.song.id === aiSelection.songId);
        selectionMethod = 'ai';
      } catch (error) {
        selectionMethod = 'deterministic-fallback';
        aiError = error instanceof Error ? error.message : 'unknown AI selector failure';
      }
    }
  }

  const decisionRecord = {
    stateBefore: crowdState,
    selectedSongId: selected.song.id,
    target,
    deterministicCandidates: candidates.map(candidate => ({
      songId: candidate.song.id,
      score: candidate.score,
      reasons: candidate.reasons
    }))
  };

  return {
    crowdState,
    target,
    candidates,
    selectedSong: selected.song,
    selectedRank: candidates.findIndex(candidate => candidate.song.id === selected.song.id) + 1,
    selectionMethod,
    aiSelection,
    aiError,
    decisionRecord
  };
}

module.exports = { selectNextSong };
