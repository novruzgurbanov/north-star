// Neo4j access for the points service. Everything this service writes uses the
// PS* labels so it can share a database with the other hackathon apps.
import neo4j, { Integer } from 'neo4j-driver';
import 'dotenv/config';

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.error('Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD in environment');
  process.exit(1);
}

export const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));

const CONSTRAINTS = [
  'CREATE CONSTRAINT ps_player_id IF NOT EXISTS FOR (p:PSPlayer) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT ps_player_name IF NOT EXISTS FOR (p:PSPlayer) REQUIRE p.nameLower IS UNIQUE',
  'CREATE CONSTRAINT ps_interval_id IF NOT EXISTS FOR (i:PSInterval) REQUIRE i.id IS UNIQUE',
  'CREATE CONSTRAINT ps_goal_key IF NOT EXISTS FOR (g:PSGoal) REQUIRE g.key IS UNIQUE',
];

/** Create the service's unique constraints. Safe to run on every boot. */
export async function initDb(): Promise<void> {
  for (const query of CONSTRAINTS) {
    await driver.executeQuery(query);
  }
}

export async function closeDb(): Promise<void> {
  await driver.close();
}

/** Recursively convert driver values (neo4j.Integer, nested maps/lists) to plain JS. */
function plain(value: unknown): unknown {
  if (neo4j.isInt(value)) return (value as Integer).toNumber();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = plain(item);
    }
    return out;
  }
  return value;
}

/** Run a query and return the records as plain JS objects. */
export async function run(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const { records } = await driver.executeQuery(cypher, params);
  return records.map(record => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.toObject())) {
      out[key] = plain(value);
    }
    return out;
  });
}
