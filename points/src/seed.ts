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

interface SeedGoal {
  id: string;
  title: string;
  status: 'brainstorm' | 'ready';
  brightness: number;
  milestonesDone: number;
  milestonesTotal: number;
}

interface SeedPlayer {
  name: string;
  goalTitle: string;
  /** Focused minutes per local day; index 0 = today, 1 = yesterday, ... */
  minutesByDay: number[];
  /** Cycle of sources assigned to the day's chunks. */
  sources: string[];
  /** When true, today's last interval ends ~30 s before the seed runs (player shows as live). */
  live?: boolean;
  /** Public goals (constellation stars); first one mirrors goalTitle. */
  goals: SeedGoal[];
}

// points = minutes + 25 * streak, so e.g. Marcus: 1150 + 25*9 = 1375.
const SEED_PLAYERS: SeedPlayer[] = [
  {
    name: 'Aiko', goalTitle: 'Pass JLPT N3',
    minutesByDay: [85, 90, 80, 95, 88, 92, 76, 70, 64, 0], live: true, sources: ['north-star'],
    goals: [
      { id: 'jlpt-n3', title: 'Pass JLPT N3', status: 'ready', brightness: 0.9, milestonesDone: 12, milestonesTotal: 20 },
      { id: 'jp-diary', title: 'Keep a Japanese diary', status: 'ready', brightness: 0.55, milestonesDone: 3, milestonesTotal: 7 },
    ],
  },
  {
    name: 'Marcus', goalTitle: 'Ship my indie game demo',
    minutesByDay: [130, 140, 125, 135, 128, 132, 120, 118, 122, 0], sources: ['north-star', 'goal-coach'],
    goals: [
      { id: 'ship-demo', title: 'Ship my indie game demo', status: 'ready', brightness: 1, milestonesDone: 8, milestonesTotal: 10 },
      { id: 'boss-fight', title: 'Polish the boss fight', status: 'ready', brightness: 0.75, milestonesDone: 5, milestonesTotal: 6 },
      { id: 'weekly-devlog', title: 'Post a devlog every week', status: 'brainstorm', brightness: 0.4, milestonesDone: 1, milestonesTotal: 8 },
    ],
  },
  {
    name: 'Lena', goalTitle: 'Learn Clair de Lune',
    minutesByDay: [90, 85, 95, 88, 92, 85, 85, 0, 0, 0], sources: ['north-star', 'goal-coach'],
    goals: [
      { id: 'clair-de-lune', title: 'Learn Clair de Lune', status: 'ready', brightness: 0.8, milestonesDone: 6, milestonesTotal: 9 },
      { id: 'daily-scales', title: 'Practice scales daily', status: 'ready', brightness: 0.5, milestonesDone: 20, milestonesTotal: 30 },
    ],
  },
  {
    name: 'Ravi', goalTitle: 'Get my first ML internship',
    minutesByDay: [110, 108, 112, 105, 105, 0, 0, 0, 0, 0], sources: ['goal-coach'],
    goals: [
      { id: 'ml-internship', title: 'Get my first ML internship', status: 'ready', brightness: 0.85, milestonesDone: 4, milestonesTotal: 5 },
      { id: 'kaggle-project', title: 'Ship a Kaggle project', status: 'ready', brightness: 0.6, milestonesDone: 2, milestonesTotal: 4 },
    ],
  },
  {
    name: 'Sofia', goalTitle: 'Launch a ceramics shop',
    minutesByDay: [125, 130, 125, 0, 0, 0, 0, 0, 0, 0], sources: ['north-star', 'goal-coach'],
    goals: [
      { id: 'shop-launch', title: 'Launch a ceramics shop', status: 'ready', brightness: 0.95, milestonesDone: 7, milestonesTotal: 10 },
      { id: 'hundred-bowls', title: 'Throw 100 bowls', status: 'ready', brightness: 0.7, milestonesDone: 46, milestonesTotal: 100 },
      { id: 'shop-name', title: 'Pick a shop name', status: 'brainstorm', brightness: 0.3, milestonesDone: 0, milestonesTotal: 1 },
    ],
  },
  {
    name: 'Kenji', goalTitle: 'Run a half marathon',
    minutesByDay: [0, 0, 60, 50, 30, 0, 0, 0, 0, 0], sources: ['north-star'],
    goals: [
      { id: 'half-marathon', title: 'Run a half marathon', status: 'ready', brightness: 0.5, milestonesDone: 3, milestonesTotal: 12 },
    ],
  },
  {
    name: 'Amara', goalTitle: 'Read 24 books this year',
    minutesByDay: [100, 105, 98, 102, 100, 99, 98, 98, 0, 0], sources: ['north-star', 'goal-coach'],
    goals: [
      { id: '24-books', title: 'Read 24 books this year', status: 'ready', brightness: 0.9, milestonesDone: 17, milestonesTotal: 24 },
      { id: 'lights-out', title: 'Lights out by midnight', status: 'brainstorm', brightness: 0.45, milestonesDone: 5, milestonesTotal: 14 },
    ],
  },
  {
    name: 'Tom', goalTitle: 'Cook through a Japanese cookbook',
    minutesByDay: [55, 0, 0, 0, 0, 0, 0, 0, 0, 0], sources: ['goal-coach'],
    goals: [
      { id: 'jp-cookbook', title: 'Cook through a Japanese cookbook', status: 'ready', brightness: 0.65, milestonesDone: 9, milestonesTotal: 27 },
    ],
  },
  {
    name: 'Mei', goalTitle: 'Finish my thesis draft',
    minutesByDay: [50, 45, 0, 0, 0, 0, 0, 0, 0, 0], live: true, sources: ['north-star', 'goal-coach'],
    goals: [
      { id: 'thesis-draft', title: 'Finish my thesis draft', status: 'ready', brightness: 0.75, milestonesDone: 4, milestonesTotal: 6 },
      { id: 'advisor-email', title: 'Email my advisor', status: 'brainstorm', brightness: 0.35, milestonesDone: 0, milestonesTotal: 1 },
    ],
  },
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
    'MATCH (p:PSPlayer {seeded: true}) ' +
      'OPTIONAL MATCH (p)-[:LOGGED]->(i:PSInterval) ' +
      'OPTIONAL MATCH (p)-[:SHARES]->(g:PSGoal) ' +
      'DETACH DELETE p, i, g',
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

  const idRecords = await run(
    `UNWIND $players AS pl
     MERGE (p:PSPlayer {nameLower: pl.nameLower})
     ON CREATE SET p.id = pl.id, p.name = pl.name, p.color = pl.color, p.goalTitle = pl.goalTitle,
                   p.seeded = true, p.createdAt = pl.createdAt
     ON MATCH SET p.seeded = true
     RETURN p.id AS id`,
    { players },
  );
  const ids = idRecords.map(r => String(r.id));

  const intervals = SEED_PLAYERS.flatMap((sp, index) =>
    planIntervals(sp, ids[index], index, now),
  );
  await run(
    `UNWIND $intervals AS iv
     MATCH (p:PSPlayer {id: iv.playerId})
     MERGE (i:PSInterval {id: iv.id})
     ON CREATE SET i.source = iv.source, i.start = iv.start, i.end = iv.end, i.createdAt = iv.createdAt
     MERGE (p)-[:LOGGED]->(i)`,
    { intervals },
  );

  const goals = SEED_PLAYERS.flatMap((sp, index) =>
    sp.goals.map((goal, ord) => ({
      ...goal,
      key: `${ids[index]}:${goal.id}`,
      playerId: ids[index],
      ord,
      updatedAt: new Date(now).toISOString(),
    })),
  );
  await run(
    `UNWIND $goals AS gl
     MATCH (p:PSPlayer {id: gl.playerId})
     MERGE (goal:PSGoal {key: gl.key})
     SET goal.goalId = gl.id, goal.title = gl.title, goal.status = gl.status,
         goal.brightness = gl.brightness, goal.milestonesDone = gl.milestonesDone,
         goal.milestonesTotal = gl.milestonesTotal, goal.ord = gl.ord, goal.updatedAt = gl.updatedAt
     MERGE (p)-[:SHARES]->(goal)`,
    { goals },
  );

  console.log(
    `Seeded ${players.length} players with ${intervals.length} intervals and ${goals.length} public goals:`,
  );
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
