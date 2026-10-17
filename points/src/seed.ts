// Seed the demo players and their focus intervals. Run with `npm run seed`.
//
// Everything is deterministic relative to the time the seed runs: fixed minute
// allocations per local day, fixed chunk lengths, and anchors derived from now.
// Re-running deletes the previous seeded players and their intervals first.
import 'dotenv/config';
import { nanoid } from 'nanoid';
import { closeDb, initDb, run } from './db.js';
import { defaultColor } from './stats.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface SeedPlayer {
  name: string;
  goalTitle: string;
  /** Focused minutes per local day; index 0 = today, 1 = yesterday, ... */
  minutesByDay: number[];
  /** Cycle of sources assigned to the day's chunks. */
  sources: string[];
  /** When true, today's last interval ends ~30 s before the seed runs (player shows as live). */
  live?: boolean;
}

// points = minutes + 25 * streak, so e.g. Marcus: 1150 + 25*9 = 1375.
const SEED_PLAYERS: SeedPlayer[] = [
  { name: 'Aiko',   goalTitle: 'Pass JLPT N3',                     minutesByDay: [85, 90, 80, 95, 88, 92, 76, 70, 64, 0],            live: true, sources: ['north-star'] },
  { name: 'Marcus', goalTitle: 'Ship my indie game demo',          minutesByDay: [130, 140, 125, 135, 128, 132, 120, 118, 122, 0],   sources: ['north-star', 'goal-coach'] },
  { name: 'Lena',   goalTitle: 'Learn Clair de Lune',              minutesByDay: [90, 85, 95, 88, 92, 85, 85, 0, 0, 0],              sources: ['north-star', 'goal-coach'] },
  { name: 'Ravi',   goalTitle: 'Get my first ML internship',       minutesByDay: [110, 108, 112, 105, 105, 0, 0, 0, 0, 0],           sources: ['goal-coach'] },
  { name: 'Sofia',  goalTitle: 'Launch a ceramics shop',           minutesByDay: [125, 130, 125, 0, 0, 0, 0, 0, 0, 0],               sources: ['north-star', 'goal-coach'] },
  { name: 'Kenji',  goalTitle: 'Run a half marathon',              minutesByDay: [0, 0, 60, 50, 30, 0, 0, 0, 0, 0],                  sources: ['north-star'] },
  { name: 'Amara',  goalTitle: 'Read 24 books this year',          minutesByDay: [100, 105, 98, 102, 100, 99, 98, 98, 0, 0],         sources: ['north-star', 'goal-coach'] },
  { name: 'Tom',    goalTitle: 'Cook through a Japanese cookbook', minutesByDay: [55, 0, 0, 0, 0, 0, 0, 0, 0, 0],                    sources: ['goal-coach'] },
  { name: 'Mei',    goalTitle: 'Finish my thesis draft',           minutesByDay: [50, 45, 0, 0, 0, 0, 0, 0, 0, 0],                   live: true, sources: ['north-star', 'goal-coach'] },
];

function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

interface PlannedInterval {
  id: string;
  playerId: string;
  source: string;
  start: string;
  end: string;
  createdAt: string;
}

/** Split a day's minutes into 5-15 minute chunks, ending the last chunk at the day's anchor. */
function planIntervals(player: SeedPlayer, playerId: string, salt: number, now: number): PlannedInterval[] {
  const planned: PlannedInterval[] = [];
  player.minutesByDay.forEach((dayMinutes, dayIndex) => {
    if (dayMinutes <= 0) return;

    const anchor =
      dayIndex === 0
        ? now - (player.live ? 30_000 : 3 * MINUTE)
        : localMidnight(now - dayIndex * DAY) + 20 * HOUR;

    const lengths: number[] = [];
    let remaining = dayMinutes;
    for (let k = 0; remaining > 0; k += 1) {
      let len = 5 + ((dayIndex * 31 + k * 17 + salt * 7) % 10); // deterministic 5..14
      if (remaining - len < 5) len = Math.min(remaining, 15); // absorb a short tail
      lengths.push(len);
      remaining -= len;
    }

    let cursor = anchor;
    lengths.forEach((len, k) => {
      const end = cursor;
      const start = cursor - len * MINUTE;
      planned.push({
        id: nanoid(),
        playerId,
        source: player.sources[k % player.sources.length],
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        createdAt: new Date(now).toISOString(),
      });
      cursor = start - 5 * MINUTE; // 5-minute gap between chunks
    });
  });
  return planned;
}

async function main(): Promise<void> {
  await initDb();
  const now = Date.now();

  await run(
    'MATCH (p:PSPlayer {seeded: true}) OPTIONAL MATCH (p)-[:LOGGED]->(i:PSInterval) DETACH DELETE p, i',
  );

  const players = SEED_PLAYERS.map(sp => {
    const nameLower = sp.name.toLowerCase();
    return {
      id: nanoid(),
      name: sp.name,
      nameLower,
      color: defaultColor(nameLower),
      goalTitle: sp.goalTitle,
      createdAt: new Date(now).toISOString(),
    };
  });

  await run(
    `UNWIND $players AS pl
     MERGE (p:PSPlayer {nameLower: pl.nameLower})
     ON CREATE SET p.id = pl.id, p.name = pl.name, p.color = pl.color, p.goalTitle = pl.goalTitle,
                   p.seeded = true, p.createdAt = pl.createdAt
     ON MATCH SET p.seeded = true`,
    { players },
  );

  const intervals = SEED_PLAYERS.flatMap((sp, index) =>
    planIntervals(sp, players[index].id, index, now),
  );
  await run(
    `UNWIND $intervals AS iv
     MATCH (p:PSPlayer {id: iv.playerId})
     MERGE (i:PSInterval {id: iv.id})
     ON CREATE SET i.source = iv.source, i.start = iv.start, i.end = iv.end, i.createdAt = iv.createdAt
     MERGE (p)-[:LOGGED]->(i)`,
    { intervals },
  );

  console.log(`Seeded ${players.length} players with ${intervals.length} intervals:`);
  SEED_PLAYERS.forEach(sp => {
    const total = sp.minutesByDay.reduce((sum, m) => sum + m, 0);
    let streak = 0;
    while (streak < sp.minutesByDay.length && sp.minutesByDay[streak] > 0) streak += 1;
    const liveTag = sp.live ? '  [live]' : '';
    console.log(
      `  ${sp.name.padEnd(7)} ${String(total).padStart(4)} min, streak ${streak}, ` +
        `points ${total + 25 * streak}${liveTag}  — ${sp.goalTitle}`,
    );
  });

  await closeDb();
}

main().catch(err => {
  console.error('seed failed:', err);
  process.exit(1);
});
