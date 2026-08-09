// Fill songs/ with ~200 Creative-Commons electronic tracks from the Internet
// Archive's netlabel collections. CC-licensed netlabel releases only — no
// commercial catalogues. Files land as "Artist - Title.mp3" so the
// preprocessing pipeline's filename matching works.
const fs = require('fs');
const path = require('path');

const OUT = 'c:/Workspace/Summerhacks/songs';
const TARGET = 200;
const MAX_BYTES = 18 * 1024 * 1024;
const MIN_BYTES = 1.2 * 1024 * 1024;              // skip jingles/stingers
const CONCURRENCY = 6;
const UA = 'Pulse hackathon jukebox (CC netlabel music; contact: repo RyanSun1112/Summerhacks)';

// long-running electronic netlabels hosted on archive.org
const COLLECTIONS = ['kahvi', 'monotonik', 'thinner', 'one', 'rec72', 'enoughrecords', 'budabeats', 'ogredung'];

const sanitize = s => String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function j(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function itemsFor(collection, rows) {
  const q = encodeURIComponent(`collection:${collection} AND mediatype:audio`);
  const u = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=creator&fl[]=title&rows=${rows}&page=1&output=json&sort[]=downloads+desc`;
  try { return (await j(u)).response.docs; } catch (e) { console.log(`  [${collection}] search failed: ${e.message}`); return []; }
}

function parseLen(v) {
  if (v == null) return null;
  if (/^[\d.]+$/.test(v)) return +v;
  const p = String(v).split(':').map(Number);
  return p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const have = new Set(fs.readdirSync(OUT).filter(f => /\.mp3$/i.test(f)).map(f => slug(f)));
  console.log(`starting with ${have.size} existing tracks; target ${TARGET}`);

  // build a big work list of {url, name} first
  const work = [];
  const seenArtist = {};                            // variety: cap tracks per artist
  for (const col of COLLECTIONS) {
    if (work.length > TARGET * 2.5) break;
    const docs = await itemsFor(col, 140);
    console.log(`[${col}] ${docs.length} items`);
    for (const doc of docs) {
      if (work.length > TARGET * 2.5) break;
      let meta;
      try { meta = await j(`https://archive.org/metadata/${doc.identifier}`); }
      catch { continue; }
      const artistRaw = Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || meta.metadata && meta.metadata.creator || col);
      const artist = sanitize(Array.isArray(artistRaw) ? artistRaw[0] : artistRaw) || col;
      const mp3s = (meta.files || []).filter(f => f.format === 'VBR MP3'
        && +f.size > MIN_BYTES && +f.size < MAX_BYTES);
      let taken = 0;
      for (const f of mp3s) {
        if (taken >= 2) break;                      // at most 2 tracks per release
        if ((seenArtist[artist] || 0) >= 6) break;  // and 6 per artist
        const secs = parseLen(f.length);
        if (secs != null && (secs < 120 || secs > 540)) continue;   // 2–9 min
        const title = sanitize(f.title || f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]*/, ''));
        if (!title) continue;
        const name = `${artist} - ${title}.mp3`;
        if (have.has(slug(name))) continue;
        have.add(slug(name));
        seenArtist[artist] = (seenArtist[artist] || 0) + 1;
        work.push({ url: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(f.name)}`, name });
        taken++;
      }
    }
    console.log(`[${col}] work list now ${work.length}`);
  }
  console.log(`work list: ${work.length} candidate tracks`);

  let done = fs.readdirSync(OUT).filter(f => /\.mp3$/i.test(f)).length;
  let idx = 0, active = 0, failed = 0;
  await new Promise(resolve => {
    const pump = () => {
      if (done >= TARGET || idx >= work.length) { if (active === 0) resolve(); return; }
      while (active < CONCURRENCY && idx < work.length && done < TARGET) {
        const w = work[idx++];
        active++;
        (async () => {
          try {
            const r = await fetch(w.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180000), redirect: 'follow' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < MIN_BYTES) throw new Error('too small');
            fs.writeFileSync(path.join(OUT, w.name), buf);
            done++;
            if (done % 10 === 0) console.log(`  ${done}/${TARGET} downloaded`);
          } catch (e) { failed++; }
          active--; pump();
        })();
      }
    };
    pump();
  });
  console.log(`FINISHED: ${fs.readdirSync(OUT).filter(f => /\.mp3$/i.test(f)).length} tracks in songs/ (${failed} failed downloads)`);
})();
