import 'dotenv/config';
import neo4j, { type Driver, type Integer } from 'neo4j-driver';

export const DB = 'neo4j';

export const driver: Driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'neo4j')
);

/** Convert a Neo4j Integer (or any number-ish value) to a JS number. */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object' && neo4j.isInt(v)) return (v as Integer).toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Recursively convert Neo4j values (Integers, nested maps, lists) to plain JS. */
export function convertValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object' && neo4j.isInt(v)) return (v as Integer).toNumber();
  if (Array.isArray(v)) return v.map(convertValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = convertValue(val);
    return out;
  }
  return v;
}

/** Run a query and return converted records. */
export async function run(
  query: string,
  params: Record<string, unknown> = {}
): Promise<Array<Record<string, unknown>>> {
  const res = await driver.executeQuery(query, params, { database: DB });
  return res.records.map((r) => convertValue(r.toObject()) as Record<string, unknown>);
}

/** Create uniqueness constraints for our labels (idempotent; NS prefix avoids other projects' data). */
export async function initConstraints(): Promise<void> {
  const statements = [
    'CREATE CONSTRAINT ns_user_id IF NOT EXISTS FOR (u: NSUser) REQUIRE u.id IS UNIQUE',
    'CREATE CONSTRAINT ns_goal_id IF NOT EXISTS FOR (g: NSGoal) REQUIRE g.id IS UNIQUE',
    'CREATE CONSTRAINT ns_milestone_id IF NOT EXISTS FOR (m: NSMilestone) REQUIRE m.id IS UNIQUE',
    'CREATE CONSTRAINT ns_entry_id IF NOT EXISTS FOR (e: NSEntry) REQUIRE e.id IS UNIQUE', // v2 panels
  ];
  for (const s of statements) await run(s);
}

export async function close(): Promise<void> {
  await driver.close();
}
