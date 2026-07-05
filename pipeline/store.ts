import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Flat-file store: one JSON array per dataset under public/data/, so every
// dataset is both what the site renders and a directly downloadable URL.
// Writes are idempotent upserts keyed per row — re-running ingest or backfill
// for overlapping ranges replaces rows instead of duplicating them.

export const DATA_DIR = join(process.cwd(), 'public', 'data')

export function readRows<T>(file: string): T[] {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8')) as T[]
}

export function upsertRows<T>(file: string, incoming: T[], keyOf: (row: T) => string): number {
  mkdirSync(DATA_DIR, { recursive: true })
  const existing = readRows<T>(file)
  const byKey = new Map(existing.map((r) => [keyOf(r), r]))
  let added = 0
  for (const row of incoming) {
    const key = keyOf(row)
    if (!byKey.has(key)) added++
    byKey.set(key, row)
  }
  const merged = [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  writeFileSync(join(DATA_DIR, file), JSON.stringify(merged) + '\n')
  return added
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, file), JSON.stringify(value, null, 2) + '\n')
}
