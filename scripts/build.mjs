#!/usr/bin/env node
// Fetch SpaceX launches and write docs/data/launches.json + docs/cal/*.ics.
// Usage: node scripts/build.mjs [--fixture]

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLaunches } from './ll2.mjs';
import { buildLaunchList, CATEGORIES } from './normalize.mjs';
import { calendar } from './ics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

const hasAny = (l, cats) => l.categories.some((c) => cats.includes(c));

export const FEEDS = [
  { id: 'all', name: 'SpaceX Launches', description: 'Every SpaceX launch', filter: () => true },
  {
    id: 'no-starlink',
    name: 'SpaceX (no Starlink)',
    description: 'Everything except routine Starlink missions',
    filter: (l) => !(l.categories.length === 1 && l.categories[0] === 'starlink'),
  },
  {
    id: 'notable',
    name: 'SpaceX Notable',
    description: 'Starship, crewed and Falcon Heavy only',
    filter: (l) => hasAny(l, ['starship', 'crewed', 'falcon-heavy']),
  },
  { id: 'starship', name: 'SpaceX Starship', description: 'Starship flight tests', filter: (l) => hasAny(l, ['starship']) },
  { id: 'crewed', name: 'SpaceX Crewed', description: 'Missions with people aboard', filter: (l) => hasAny(l, ['crewed']) },
  { id: 'starlink', name: 'SpaceX Starlink', description: 'Starlink missions only', filter: (l) => hasAny(l, ['starlink']) },
];

export function siteUrlFromEnv(env = process.env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/?$/, '/');
  const repo = env.GITHUB_REPOSITORY; // "owner/name" inside GitHub Actions
  if (repo) {
    const [owner, name] = repo.split('/');
    return `https://${owner.toLowerCase()}.github.io/${name}/`;
  }
  return null;
}

export async function build({ source, now = new Date(), outDir = DOCS, siteUrl = siteUrlFromEnv() } = {}) {
  const launches = buildLaunchList(source, now);

  const dataDir = join(outDir, 'data');
  const calDir = join(outDir, 'cal');
  const oneDir = join(calDir, 'one');
  await rm(oneDir, { recursive: true, force: true }); // drop single-launch files for old launches
  await mkdir(dataDir, { recursive: true });
  await mkdir(oneDir, { recursive: true });

  const feeds = [];
  for (const feed of FEEDS) {
    const subset = launches.filter(feed.filter);
    await writeFile(join(calDir, `${feed.id}.ics`), calendar(subset, { name: feed.name, description: feed.description, siteUrl }));
    feeds.push({ id: feed.id, name: feed.name, description: feed.description, count: subset.length });
  }
  for (const l of launches) {
    if (l.precision === 'vague') continue;
    await writeFile(join(oneDir, `${l.id}.ics`), calendar([l], { siteUrl, refresh: false }));
  }

  const payload = { generatedAt: now.toISOString(), siteUrl, categories: CATEGORIES, feeds, launches };
  // Keep generatedAt on its own line so the workflow can ignore it when diffing.
  await writeFile(join(dataDir, 'launches.json'), JSON.stringify(payload, null, 1) + '\n');
  return payload;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const useFixture = process.argv.includes('--fixture');
  let source;
  if (useFixture) {
    const { makeSource } = await import('../test/fixtures/ll2.mjs');
    source = makeSource(new Date());
  } else {
    source = await fetchLaunches();
  }
  const out = await build({ source });
  const next = out.launches.find((l) => Date.parse(l.net) > Date.now());
  console.log(`Wrote ${out.launches.length} launches, ${out.feeds.length} feeds${useFixture ? ' (fixture data)' : ''}.`);
  if (next) console.log(`Next: ${next.vehicle} · ${next.mission} at ${next.net} [${next.status}]`);
}
