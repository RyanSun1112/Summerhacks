#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  MOCK_SCENARIOS,
  getMockScenario,
  loadSongProfiles,
  indexSongs,
  resolveSongIds,
  OpenAISelector,
  selectNextSong
} = require('../lib/dj');

function parseArgs(argv) {
  const options = { scenario: 'dancingGrowing', useAI: false, json: false, recent: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--scenario' && value) { options.scenario = value; index++; }
    else if (argument === '--profiles' && value) { options.profiles = value; index++; }
    else if (argument === '--current' && value) { options.current = value; index++; }
    else if (argument === '--recent' && value) { options.recent = value.split(',').filter(Boolean); index++; }
    else if (argument === '--ai') options.useAI = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--list-scenarios') options.listScenarios = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function usage() {
  return `Usage: npm run select-song -- [options]

Options:
  --scenario NAME       Mock crowd state (default: dancingGrowing)
  --profiles PATH       Song-profile JSON (default: data/songProfiles.json)
  --current SONG_ID     Current song (default: first catalog song)
  --recent ID1,ID2      Recent IDs, most recent first
  --ai                  Ask the optional server-side OpenAI final selector
  --json                Print the complete decision as JSON
  --list-scenarios      List available mock scenarios
  -h, --help            Show this help`;
}

function resolveProfilePath(requested) {
  if (requested) return path.resolve(requested);
  const real = path.resolve('data/songProfiles.json');
  if (fs.existsSync(real)) return real;
  const example = path.resolve('data/songProfiles.example.json');
  console.warn(`[dj] ${real} not found; using fictional example profiles for this demo.`);
  return example;
}

function metric(label, value) {
  console.log(`${label.padEnd(16)}${Number(value).toFixed(2)}`);
}

function printDecision(result, profilePath) {
  console.log('\nCROWD STATE');
  metric('Energy:', result.crowdState.energy);
  metric('Rhythm:', result.crowdState.rhythm);
  metric('Clustering:', result.crowdState.clustering);
  metric('Mobility:', result.crowdState.mobility);
  metric('Volume:', result.crowdState.volume);

  console.log('\nDJ INTENTION');
  console.log(result.target.intention);
  console.log(`Policy case: ${result.target.policyCase}`);

  console.log('\nTARGET');
  metric('Energy:', result.target.energy);
  metric('Danceability:', result.target.danceability);
  metric('Socialness:', result.target.socialness);
  metric('Intensity:', result.target.intensity);
  metric('Valence:', result.target.valence);
  if (result.target.bpmTarget) {
    console.log(`BPM:            ${Math.round(result.target.bpmTarget)} (${Math.round(result.target.bpmMin)}–${Math.round(result.target.bpmMax)})`);
  }

  console.log('\nTOP CANDIDATES');
  result.candidates.forEach((candidate, index) => {
    console.log(`\n${index + 1}. ${candidate.song.artist} — ${candidate.song.title}`);
    console.log(`   deterministic score: ${candidate.score.toFixed(3)}`);
    candidate.reasons.forEach(reason => console.log(`   ${reason}`));
  });

  console.log('\nSELECTION');
  console.log(`${result.selectedSong.artist} — ${result.selectedSong.title}`);
  console.log(`Method: ${result.selectionMethod}`);
  if (result.aiSelection) {
    console.log(`Reason: ${result.aiSelection.reason}`);
    console.log(`Confidence: ${result.aiSelection.confidence.toFixed(2)}`);
  } else if (result.aiError) {
    console.log(`AI fallback: ${result.aiError}`);
  }
  console.log(`Profiles: ${profilePath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (options.listScenarios) { console.log(Object.keys(MOCK_SCENARIOS).join('\n')); return; }

  const profilePath = resolveProfilePath(options.profiles);
  const songs = loadSongProfiles(profilePath);
  const songIndex = indexSongs(songs);
  const crowdState = getMockScenario(options.scenario);
  const currentSong = options.current
    ? songIndex.get(options.current)
    : songs.reduce((closest, song) => (
      Math.abs(song.bpm - crowdState.currentBpm) < Math.abs(closest.bpm - crowdState.currentBpm) ? song : closest
    ), songs[0]);
  if (options.current && !currentSong) throw new Error(`current song ID not found: ${options.current}`);
  const recentHistory = resolveSongIds(options.recent, songIndex);

  let aiSelector = null;
  if (options.useAI) {
    try {
      aiSelector = new OpenAISelector();
    } catch (error) {
      console.warn(`[dj] ${error.message}; deterministic fallback will be used.`);
    }
  }
  const result = await selectNextSong({
    crowdState,
    songs,
    currentSong,
    recentHistory,
    useAI: options.useAI,
    aiSelector
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printDecision(result, profilePath);
}

main().catch(error => {
  console.error(`DJ selection failed: ${error.message}`);
  process.exitCode = 1;
});
