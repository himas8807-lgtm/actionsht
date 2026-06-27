#!/usr/bin/env node
// Fetches ISRCs for BTS catalog songs that are missing them via MusicBrainz.
// Reads from / writes to Supabase directly using the REST API.
// Run via GitHub Actions (no timeout) or locally: node .github/scripts/fetch-isrcs.js

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || '0') // 0 = process all
const MB = 'https://musicbrainz.org/ws/2'
const MB_HDR = {
  'User-Agent': 'Arirang/1.0 (github-actions; bts-catalog)',
  Accept: 'application/json',
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function mbFetch(url) {
  try {
    const r = await fetch(url, { headers: MB_HDR, signal: AbortSignal.timeout(8000) })
    if (r.status === 503 || r.status === 429) {
      const wait = parseInt(r.headers.get('Retry-After') || '10') * 1000
      console.log(`  MusicBrainz rate-limited — waiting ${wait / 1000}s`)
      await sleep(wait)
      return mbFetch(url) // one retry
    }
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// 2-step MusicBrainz ISRC lookup: search recording → get MBID → lookup ISRCs
async function mbIsrc(name, artist) {
  const q = encodeURIComponent(`recording:"${name}" AND artist:${artist}`)
  const searchData = await mbFetch(`${MB}/recording?query=${q}&limit=5&fmt=json`)
  await sleep(1100) // 1 req/sec rate limit

  const recordings = searchData?.recordings || []
  const rec =
    recordings.find(r => (r.title || '').toLowerCase() === name.toLowerCase()) ||
    recordings[0]
  if (!rec?.id) return null

  const lookupData = await mbFetch(`${MB}/recording/${rec.id}?inc=isrcs&fmt=json`)
  await sleep(1100)

  return lookupData?.isrcs?.[0] || null
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  })
  if (!r.ok) throw new Error(`Supabase GET ${path} → ${r.status}: ${await r.text()}`)
  return r.json()
}

async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Supabase PATCH ${path} → ${r.status}: ${await r.text()}`)
}

async function main() {
  console.log('Fetching catalog from Supabase…')
  const rows = await sbGet('bts_song_catalog?id=eq.current&select=songs')
  const catalog = rows[0]?.songs || []
  console.log(`Catalog: ${catalog.length} songs`)

  const needIsrc = catalog.filter(s => !s.isrc)
  const toProcess = BATCH_LIMIT > 0 ? needIsrc.slice(0, BATCH_LIMIT) : needIsrc
  console.log(`Songs missing ISRC: ${needIsrc.length} — processing ${toProcess.length}`)

  if (!toProcess.length) {
    console.log('Nothing to do.')
    return
  }

  let updated = 0, notFound = 0, errors = 0
  const start = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const song = toProcess[i]
    const artist = (song.artists || ['BTS'])[0]
    const elapsed = ((Date.now() - start) / 1000).toFixed(0)
    process.stdout.write(
      `[${i + 1}/${toProcess.length}] ${elapsed}s — ${song.name} (${artist}) … `
    )

    let isrc = null
    try {
      isrc = await mbIsrc(song.name, artist)
    } catch (e) {
      console.log(`ERROR: ${e.message}`)
      errors++
      continue
    }

    if (isrc) {
      const idx = catalog.findIndex(s => s.key === song.key)
      if (idx !== -1) catalog[idx] = { ...catalog[idx], isrc }
      updated++
      console.log(`✓ ${isrc}`)
    } else {
      notFound++
      console.log('not found')
    }

    // Save checkpoint every 25 updates to avoid losing progress
    if (updated > 0 && updated % 25 === 0) {
      console.log(`  Saving checkpoint (${updated} updated so far)…`)
      await sbPatch('bts_song_catalog?id=eq.current', { songs: catalog, updated_at: new Date().toISOString() })
    }
  }

  if (updated > 0) {
    console.log(`\nSaving final results…`)
    await sbPatch('bts_song_catalog?id=eq.current', { songs: catalog, updated_at: new Date().toISOString() })
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\nDone in ${totalSec}s — updated: ${updated}, not found: ${notFound}, errors: ${errors}`)
  console.log(`Still missing: ${needIsrc.length - updated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
