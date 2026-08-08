'use strict';

const fs = require('fs');
const path = require('path');
const { validateSongProfile } = require('./models');

function loadSongProfiles(filePath) {
  const resolved = path.resolve(filePath);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`could not load song profiles from ${resolved}: ${error.message}`);
  }
  if (!Array.isArray(payload)) throw new TypeError(`song profile file ${resolved} must contain a JSON array`);
  const songs = payload.map(validateSongProfile);
  const seen = new Set();
  for (const song of songs) {
    if (seen.has(song.id)) throw new Error(`duplicate song ID in profile database: ${song.id}`);
    seen.add(song.id);
  }
  if (!songs.length) throw new Error(`song profile file ${resolved} is empty`);
  return songs;
}

function indexSongs(songs) {
  return new Map(songs.map(song => [song.id, song]));
}

function resolveSongIds(ids, songIndex) {
  if (!Array.isArray(ids)) return [];
  return ids.map(id => songIndex.get(id)).filter(Boolean);
}

module.exports = { loadSongProfiles, indexSongs, resolveSongIds };
