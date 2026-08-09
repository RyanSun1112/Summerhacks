'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MOCK_SCENARIOS,
  getMockScenario,
  validateCrowdState,
  validateAISelection,
  determineSongTarget,
  rankSongs,
  topCandidates,
  buildAIInput,
  OpenAISelector,
  selectNextSong
} = require('../lib/dj');

function song(id, overrides = {}) {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    year: 2026,
    genres: ['house'],
    bpm: 124,
    energy: 0.72,
    danceability: 0.82,
    valence: 0.68,
    socialness: 0.25,
    intensity: 0.70,
    ...overrides
  };
}

const balancedTarget = {
  energy: 0.72,
  danceability: 0.82,
  socialness: 0.25,
  intensity: 0.70,
  valence: 0.68,
  bpmTarget: 124,
  bpmMin: 116,
  bpmMax: 132,
  intention: 'Test target',
  policyCase: 'test'
};

test('CrowdState validation accepts normalized states and rejects invalid values', () => {
  assert.equal(validateCrowdState(getMockScenario('socializing')).rhythm, 0.22);
  assert.throws(() => validateCrowdState({ ...getMockScenario('socializing'), energy: 1.1 }), /between 0 and 1/);
  assert.throws(() => validateCrowdState({ energy: 0.5 }), /rhythm/);
});

test('high-rhythm rising crowd produces a modest build target', () => {
  const target = determineSongTarget(getMockScenario('dancingGrowing'), song('current', { bpm: 124 }));
  assert.equal(target.policyCase, 'dancing-growing');
  assert(target.energy > MOCK_SCENARIOS.dancingGrowing.energy);
  assert(target.bpmTarget <= 129);
  assert(target.socialness < 0.3);
});

test('socializing crowd favors socialness rather than dance escalation', () => {
  const target = determineSongTarget(getMockScenario('socializing'), song('current', { bpm: 108 }));
  assert.equal(target.policyCase, 'clustered-social');
  assert(target.socialness >= 0.8);
  assert(target.energy < 0.5);
  assert(target.danceability < 0.5);
});

test('falling engagement requests a bounded accessible lift', () => {
  const state = getMockScenario('losingDanceFloor');
  const target = determineSongTarget(state, song('current', { bpm: 120 }));
  assert.equal(target.policyCase, 'falling-engagement');
  assert(target.energy > state.energy);
  assert(target.danceability > state.rhythm);
  assert(target.energy < 0.8);
});

test('peak saturation maintains or releases instead of escalating forever', () => {
  const state = getMockScenario('peakDanceFloor');
  const first = determineSongTarget(state, song('current', { bpm: 130 }));
  const repeated = determineSongTarget(state, song('current', { bpm: 130 }), [
    song('peak-1', { energy: 0.9 }), song('peak-2', { energy: 0.88 })
  ]);
  assert.equal(first.policyCase, 'peak-saturation');
  assert(first.energy < state.energy);
  assert(repeated.energy < first.energy);
  assert(repeated.energy < 1);
});

test('match mode mirrors present crowd energy without pushing BPM', () => {
  const state = getMockScenario('dancingGrowing');
  const target = determineSongTarget(state, song('current', { bpm: 124 }), [], {
    selection: { mode: 'match' }
  });
  assert.equal(target.selectionMode, 'match');
  assert.equal(target.guidanceStrength, 0);
  assert.equal(target.policyCase, 'match-room');
  assert.equal(target.energy, state.energy);
  assert.equal(target.bpmTarget, 124);
});

test('blend mode interpolates between matching and guided targets', () => {
  const state = getMockScenario('dancingGrowing');
  const current = song('current', { bpm: 124 });
  const match = determineSongTarget(state, current, [], { selection: { mode: 'match' } });
  const guide = determineSongTarget(state, current, [], { selection: { mode: 'guide' } });
  const blend = determineSongTarget(state, current, [], {
    selection: { mode: 'blend', guidanceStrength: 0.25 }
  });
  assert.equal(blend.selectionMode, 'blend');
  assert.equal(blend.guidanceStrength, 0.25);
  assert.equal(blend.energy, Math.round((match.energy * 0.75 + guide.energy * 0.25) * 10000) / 10000);
  assert.equal(blend.bpmTarget, 125);
  assert.match(blend.policyCase, /^blend-/);
});

test('selection mode and guidance strength validation reject invalid controls', () => {
  const state = getMockScenario('socializing');
  assert.throws(
    () => determineSongTarget(state, null, [], { selection: { mode: 'invented' } }),
    /selectionMode/
  );
  assert.throws(
    () => determineSongTarget(state, null, [], { selection: { mode: 'blend', guidanceStrength: 1.2 } }),
    /between 0 and 1/
  );
});

test('ranker puts the closest song first and provides reasons', () => {
  const ranked = rankSongs(balancedTarget, [
    song('far', { energy: 0.2, danceability: 0.3, socialness: 0.9, bpm: 95 }),
    song('near')
  ]);
  assert.equal(ranked[0].song.id, 'near');
  assert(ranked[0].score > ranked[1].score);
  assert(ranked[0].reasons.some(reason => reason.includes('energy near target')));
});

test('BPM difference lowers otherwise identical scores', () => {
  const ranked = rankSongs(balancedTarget, [song('smooth', { bpm: 125 }), song('jump', { bpm: 155 })]);
  assert.equal(ranked[0].song.id, 'smooth');
  assert(ranked[0].components.bpm.penalty < ranked[1].components.bpm.penalty);
});

test('current and recently played tracks are excluded', () => {
  const current = song('current');
  const recent = song('recent');
  const ranked = rankSongs(balancedTarget, [current, recent, song('eligible')], current, [recent]);
  assert.deepEqual(ranked.map(item => item.song.id), ['eligible']);
});

test('same-artist recency receives a moderate penalty', () => {
  const previous = song('previous', { artist: 'Repeat Artist' });
  const repeated = song('repeated', { artist: 'Repeat Artist' });
  const fresh = song('fresh', { energy: 0.74 });
  const ranked = rankSongs(balancedTarget, [repeated, fresh], null, [previous]);
  assert(ranked.find(item => item.song.id === 'repeated').score < ranked.find(item => item.song.id === 'fresh').score);
  assert(ranked.find(item => item.song.id === 'repeated').reasons.some(reason => reason.includes('artist played')));
});

test('top candidate filtering is configurable', () => {
  const ranked = rankSongs(balancedTarget, Array.from({ length: 15 }, (_, index) => song(String(index), { energy: index / 20 })));
  assert.equal(topCandidates(ranked, 7).length, 7);
});

test('AI response validation rejects unknown songs and invalid confidence', () => {
  assert.deepEqual(
    validateAISelection({ songId: 'a', reason: 'Fits the trajectory', confidence: 0.8 }, ['a', 'b']),
    { songId: 'a', reason: 'Fits the trajectory', confidence: 0.8 }
  );
  assert.throws(() => validateAISelection({ songId: 'x', reason: 'No', confidence: 0.8 }, ['a']), /candidate list/);
  assert.throws(() => validateAISelection({ songId: 'a', reason: 'No', confidence: 2 }, ['a']), /between 0 and 1/);
});

test('AI input contains only compact context and deterministic candidates', () => {
  const candidate = { song: song('candidate', { raw: { shouldNotLeak: true } }), score: 0.91, reasons: ['+ fit'] };
  const payload = buildAIInput({
    crowdState: getMockScenario('dancingGrowing'),
    target: balancedTarget,
    currentSong: song('current'),
    recentHistory: [song('recent')],
    candidates: [candidate]
  });
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].deterministicScore, 0.91);
  assert.equal(payload.candidates[0].raw, undefined);
});

test('OpenAI adapter requests strict structured output and validates it', async () => {
  let request;
  const client = { responses: { create: async input => {
    request = input;
    return { output_text: JSON.stringify({ songId: 'candidate', reason: 'Best emotional direction', confidence: 0.84 }) };
  } } };
  const selector = new OpenAISelector({ client, model: 'test-model' });
  const response = await selector.select({
    crowdState: getMockScenario('dancingGrowing'),
    target: balancedTarget,
    currentSong: song('current'),
    recentHistory: [],
    candidates: [{ song: song('candidate'), score: 0.9, reasons: ['+ fit'] }]
  });
  assert.equal(response.songId, 'candidate');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.model, 'test-model');
});

test('invalid AI song ID falls back to highest deterministic candidate', async () => {
  const songs = [song('a'), song('b', { energy: 0.45 })];
  const result = await selectNextSong({
    crowdState: getMockScenario('dancingGrowing'),
    songs,
    useAI: true,
    aiSelector: { select: async () => ({ songId: 'invented', reason: 'Invalid', confidence: 0.9 }) }
  });
  assert.equal(result.selectionMethod, 'deterministic-fallback');
  assert.equal(result.selectedSong.id, result.candidates[0].song.id);
});

test('valid AI selection may choose another already-ranked candidate', async () => {
  const songs = [song('a'), song('b', { energy: 0.68 })];
  const result = await selectNextSong({
    crowdState: getMockScenario('dancingGrowing'),
    songs,
    useAI: true,
    aiSelector: { select: async context => ({
      songId: context.candidates[1].song.id,
      reason: 'The second option offers better emotional variation',
      confidence: 0.77
    }) }
  });
  assert.equal(result.selectionMethod, 'ai');
  assert.equal(result.selectedRank, 2);
  assert.equal(result.aiSelection.confidence, 0.77);
});

test('missing AI selector or API key uses deterministic fallback', async () => {
  const result = await selectNextSong({
    crowdState: getMockScenario('socializing'),
    songs: [song('a'), song('b', { socialness: 0.8 })],
    useAI: true,
    aiSelector: null
  });
  assert.equal(result.selectionMethod, 'deterministic-fallback');
  assert.match(result.aiError, /unavailable/);
  assert.equal(result.selectedSong.id, result.candidates[0].song.id);
});

test('engine exposes match and blend strategy controls', async () => {
  const songs = [song('a'), song('b', { energy: 0.45, socialness: 0.8 })];
  const matched = await selectNextSong({
    crowdState: getMockScenario('socializing'),
    songs,
    selectionMode: 'match'
  });
  const blended = await selectNextSong({
    crowdState: getMockScenario('socializing'),
    songs,
    selectionMode: 'blend',
    guidanceStrength: 0.3
  });
  assert.equal(matched.target.selectionMode, 'match');
  assert.equal(blended.target.selectionMode, 'blend');
  assert.equal(blended.target.guidanceStrength, 0.3);
});

test('AI provider failure falls back without stopping selection', async () => {
  const result = await selectNextSong({
    crowdState: getMockScenario('socializing'),
    songs: [song('a'), song('b', { socialness: 0.8, energy: 0.4 })],
    useAI: true,
    aiSelector: { select: async () => { throw new Error('timeout'); } }
  });
  assert.equal(result.selectionMethod, 'deterministic-fallback');
  assert.equal(result.aiError, 'timeout');
  assert(result.selectedSong);
});

test('every mock scenario executes through the deterministic engine', async () => {
  const songs = Array.from({ length: 12 }, (_, index) => song(`song-${index}`, {
    bpm: 96 + index * 3,
    energy: 0.15 + index * 0.07,
    danceability: 0.25 + index * 0.06,
    socialness: 0.9 - index * 0.07,
    intensity: 0.15 + index * 0.07
  }));
  for (const name of Object.keys(MOCK_SCENARIOS)) {
    const result = await selectNextSong({ crowdState: getMockScenario(name), songs });
    assert(result.selectedSong, name);
    assert(result.target.intention, name);
  }
});
