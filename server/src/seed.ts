import 'dotenv/config';
import { nanoid } from 'nanoid';
import { close, run } from './db.js';
import { computeStats, loadGoals, userColor } from './model.js';

/**
 * Deterministic demo data. Every user's score and streak are hand-planned so that
 * after `npm run seed` scores span roughly 80..1400 and streaks 0..9.
 *
 * Score = focusedMinutes + 100 * milestonesDone + 25 * streak
 * Streak counts consecutive days ending today or yesterday with on-task activity
 * or a milestone completion, so doneAt offsets are chosen to never extend a
 * user's planned streak (or break it at the tail).
 */

interface SeedMilestone {
  title: string;
  doneDaysAgo?: number; // when set, the milestone is done at that day, 20:00
}

interface SeedGoal {
  title: string;
  why: string;
  successLooksLike: string;
  deadline: string | null;
  createdDaysAgo: number;
  milestones: SeedMilestone[];
}

interface SeedActivity {
  goal: number; // index into goals
  daysAgo: number;
  minutes: number;
  hour: number; // local hour of day
}

interface SeedUser {
  name: string;
  goals: SeedGoal[];
  activities: SeedActivity[];
}

const USERS: SeedUser[] = [
  {
    name: 'Kenji',
    goals: [
      {
        title: 'Read 24 books this year',
        why: 'After my father passed, his shelf of books is how I keep him close.',
        successLooksLike: 'I finish my 24th book of the year and write a short note on each.',
        deadline: '2026-12-31',
        createdDaysAgo: 80,
        milestones: [
          { title: 'Read the first four', doneDaysAgo: 8 },
          { title: 'Read eight books', doneDaysAgo: 6 },
          { title: 'Read twelve books', doneDaysAgo: 4 },
          { title: 'Read sixteen books', doneDaysAgo: 2 },
          { title: 'Read twenty books', doneDaysAgo: 0 },
          { title: 'Finish all twenty four' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 0, minutes: 90, hour: 8 },
      { goal: 0, daysAgo: 1, minutes: 80, hour: 21 },
      { goal: 0, daysAgo: 2, minutes: 75, hour: 21 },
      { goal: 0, daysAgo: 3, minutes: 70, hour: 21 },
      { goal: 0, daysAgo: 4, minutes: 65, hour: 20 },
      { goal: 0, daysAgo: 5, minutes: 60, hour: 21 },
      { goal: 0, daysAgo: 6, minutes: 75, hour: 21 },
      { goal: 0, daysAgo: 7, minutes: 80, hour: 20 },
      { goal: 0, daysAgo: 8, minutes: 80, hour: 21 },
    ],
  },
  {
    name: 'Aiko',
    goals: [
      {
        title: 'Run a half marathon',
        why: 'I promised my sister we would cross the finish line together after her recovery.',
        successLooksLike: 'I finish the half marathon in under two and a half hours.',
        deadline: '2027-02-28',
        createdDaysAgo: 70,
        milestones: [
          { title: 'Buy proper running shoes', doneDaysAgo: 10 },
          { title: 'Run five kilometers nonstop', doneDaysAgo: 8 },
          { title: 'Run ten kilometers comfortably', doneDaysAgo: 6 },
          { title: 'Complete a fifteen kilometer run' },
          { title: 'Finish the half marathon' },
        ],
      },
      {
        title: 'Hold real Spanish conversations',
        why: 'I want to talk with my grandmother in Madrid in her own language.',
        successLooksLike: 'I keep a 20-minute conversation in Spanish without switching to English.',
        deadline: null,
        createdDaysAgo: 45,
        milestones: [
          { title: 'Complete A1 audio course', doneDaysAgo: 4 },
          { title: 'Learn 500 core words' },
          { title: 'Chat with a language partner' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 1, minutes: 60, hour: 7 },
      { goal: 0, daysAgo: 2, minutes: 55, hour: 7 },
      { goal: 0, daysAgo: 3, minutes: 65, hour: 8 },
      { goal: 0, daysAgo: 4, minutes: 60, hour: 7 },
      { goal: 0, daysAgo: 5, minutes: 70, hour: 7 },
      { goal: 0, daysAgo: 6, minutes: 75, hour: 8 },
      { goal: 1, daysAgo: 7, minutes: 35, hour: 20 },
      { goal: 1, daysAgo: 8, minutes: 30, hour: 21 },
    ],
  },
  {
    name: 'Ravi',
    goals: [
      {
        title: 'Get my first ML internship',
        why: 'I want my engineering degree to finally open the door to research work.',
        successLooksLike: 'I sign an internship offer with a team building ML products.',
        deadline: '2027-01-15',
        createdDaysAgo: 40,
        milestones: [
          { title: 'Build two portfolio projects', doneDaysAgo: 8 },
          { title: 'Write an ML blog series', doneDaysAgo: 5 },
          { title: 'Polish my GitHub profile' },
          { title: 'Pass internship interviews' },
        ],
      },
      {
        title: 'Automate my apartment lighting',
        why: 'I love tinkering, and waking up to a simulated sunrise changes my mornings.',
        successLooksLike: 'My lights follow my schedule and mood without me touching a switch.',
        deadline: null,
        createdDaysAgo: 25,
        milestones: [
          { title: 'Set up smart bulbs', doneDaysAgo: 3 },
          { title: 'Write the automation scripts' },
          { title: 'Build the sunrise routine' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 0, minutes: 60, hour: 9 },
      { goal: 0, daysAgo: 1, minutes: 75, hour: 21 },
      { goal: 0, daysAgo: 2, minutes: 70, hour: 20 },
      { goal: 1, daysAgo: 3, minutes: 65, hour: 20 },
      { goal: 1, daysAgo: 4, minutes: 60, hour: 21 },
      { goal: 1, daysAgo: 5, minutes: 60, hour: 20 },
    ],
  },
  {
    name: 'Marcus',
    goals: [
      {
        title: 'Ship my indie game demo',
        why: 'I have dreamed of people playing something I built since I was ten.',
        successLooksLike: 'A stranger plays my demo on itch.io and leaves a comment.',
        deadline: '2026-11-30',
        createdDaysAgo: 55,
        milestones: [
          { title: 'Draft the game design document', doneDaysAgo: 9 },
          { title: 'Prototype player movement', doneDaysAgo: 7 },
          { title: 'Implement combat and enemies', doneDaysAgo: 6 },
          { title: 'Build the first level' },
          { title: 'Add sound and music' },
          { title: 'Publish the demo online' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 3, minutes: 120, hour: 20 },
      { goal: 0, daysAgo: 5, minutes: 130, hour: 21 },
      { goal: 0, daysAgo: 8, minutes: 140, hour: 20 },
      { goal: 0, daysAgo: 10, minutes: 130, hour: 21 },
    ],
  },
  {
    name: 'Lena',
    goals: [
      {
        title: 'Pass JLPT N3',
        why: 'I want to read my favorite novelists in the language they wrote in.',
        successLooksLike: 'I pass the N3 with over 100 points and follow a drama episode without subtitles.',
        deadline: '2026-12-06',
        createdDaysAgo: 90,
        milestones: [
          { title: 'Learn 300 core kanji', doneDaysAgo: 11 },
          { title: 'Finish the N3 textbook', doneDaysAgo: 10 },
          { title: 'Master N3 grammar points', doneDaysAgo: 9 },
          { title: 'Do weekly listening practice', doneDaysAgo: 3 },
          { title: 'Take three practice exams' },
          { title: 'Pass the December exam' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 1, minutes: 30, hour: 20 },
      { goal: 0, daysAgo: 2, minutes: 35, hour: 21 },
      { goal: 0, daysAgo: 3, minutes: 25, hour: 20 },
      { goal: 0, daysAgo: 4, minutes: 40, hour: 21 },
      { goal: 0, daysAgo: 5, minutes: 30, hour: 20 },
      { goal: 0, daysAgo: 6, minutes: 35, hour: 21 },
      { goal: 0, daysAgo: 7, minutes: 45, hour: 20 },
    ],
  },
  {
    name: 'Sofia',
    goals: [
      {
        title: 'Launch a ceramics shop',
        why: 'My pottery is the one thing people keep asking to buy.',
        successLooksLike: 'My shop makes its first ten sales and pays for the new kiln.',
        deadline: '2026-12-15',
        createdDaysAgo: 50,
        milestones: [
          { title: 'Throw fifty consistent mugs', doneDaysAgo: 2 },
          { title: 'Design a brand identity', doneDaysAgo: 10 },
          { title: 'Photograph a full collection', doneDaysAgo: 6 },
          { title: 'Build the online shop' },
          { title: 'Make the first sales' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 0, minutes: 60, hour: 10 },
      { goal: 0, daysAgo: 1, minutes: 75, hour: 14 },
      { goal: 0, daysAgo: 2, minutes: 50, hour: 15 },
      { goal: 0, daysAgo: 3, minutes: 80, hour: 14 },
      { goal: 0, daysAgo: 4, minutes: 70, hour: 15 },
    ],
  },
  {
    name: 'Mei',
    goals: [
      {
        title: 'Cook a Japanese cookbook',
        why: "My grandmother's recipes live in a cookbook I have never dared to open.",
        successLooksLike: 'I cook every recipe and host a dinner made entirely from the book.',
        deadline: null,
        createdDaysAgo: 60,
        milestones: [
          { title: 'Master the basic stocks', doneDaysAgo: 6 },
          { title: 'Cook the first ten recipes', doneDaysAgo: 5 },
          { title: 'Practice knife fundamentals' },
          { title: 'Host a full dinner' },
          { title: 'Cook every last recipe' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 1, minutes: 40, hour: 19 },
      { goal: 0, daysAgo: 2, minutes: 35, hour: 19 },
      { goal: 0, daysAgo: 3, minutes: 45, hour: 19 },
    ],
  },
  {
    name: 'Amara',
    goals: [
      {
        title: 'Learn to play Clair de Lune',
        why: 'My grandmother hummed it while cooking; playing it myself feels like meeting her again.',
        successLooksLike: 'I perform the piece from memory at the community recital.',
        deadline: '2027-01-31',
        createdDaysAgo: 35,
        milestones: [
          { title: 'Master the opening arpeggios', doneDaysAgo: 5 },
          { title: 'Learn the middle section' },
          { title: 'Play hands together slowly' },
          { title: 'Perform at a recital' },
        ],
      },
    ],
    activities: [
      { goal: 0, daysAgo: 1, minutes: 45, hour: 18 },
      { goal: 0, daysAgo: 2, minutes: 55, hour: 18 },
    ],
  },
  {
    name: 'Tom',
    goals: [
      {
        title: 'Finish my thesis draft',
        why: 'This draft has haunted me for two years and I refuse to carry it into a third.',
        successLooksLike: 'My advisor reads the full draft and says it is ready to defend.',
        deadline: '2026-12-20',
        createdDaysAgo: 30,
        milestones: [
          { title: 'Outline the chapter structure' },
          { title: 'Draft the methodology chapter' },
          { title: 'Analyze the collected data' },
          { title: 'Write the results chapter' },
          { title: 'Submit the draft' },
        ],
      },
    ],
    activities: [{ goal: 0, daysAgo: 1, minutes: 55, hour: 22 }],
  },
];

// Hand-planned outcomes (score, streak) used to self-verify the seed.
const EXPECTED: Record<string, { score: number; streak: number }> = {
  Kenji: { score: 1400, streak: 9 },
  Aiko: { score: 1050, streak: 8 },
  Lena: { score: 815, streak: 7 },
  Ravi: { score: 840, streak: 6 },
  Sofia: { score: 760, streak: 5 },
  Mei: { score: 395, streak: 3 },
  Amara: { score: 250, streak: 2 },
  Tom: { score: 80, streak: 1 },
  Marcus: { score: 820, streak: 0 },
};

function atTime(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() > Date.now()) d.setTime(Date.now() - 5 * 60 * 1000); // never in the future
  return d.toISOString();
}

async function deleteSeeded(): Promise<void> {
  // Delete all NSUser {seeded:true} and everything hanging off them.
  await run(
    `MATCH (u: NSUser {seeded: true})-[:LOGGED]->(a: NSActivity)
     DETACH DELETE a`
  );
  await run(
    `MATCH (:NSUser {seeded: true})-[:PURSUES]->(g: NSGoal)-[:HAS_MILESTONE]->(m: NSMilestone)
     DETACH DELETE m`
  );
  await run(
    `MATCH (:NSUser {seeded: true})-[:PURSUES]->(g: NSGoal)
     DETACH DELETE g`
  );
  await run(
    `MATCH (u: NSUser {seeded: true})
     DETACH DELETE u`
  );
}

async function createUser(su: SeedUser): Promise<string> {
  const userId = nanoid(12);
  const createdDaysAgo = Math.max(...su.goals.map((g) => g.createdDaysAgo)) + 5;
  await run('CREATE (u: NSUser $props)', {
    props: {
      id: userId,
      name: su.name,
      nameLower: su.name.toLowerCase(),
      color: userColor(su.name),
      seeded: true,
      createdAt: atTime(createdDaysAgo, 10),
    },
  });

  const goalIds: string[] = [];
  for (const g of su.goals) {
    const goalId = nanoid(12);
    goalIds.push(goalId);
    const ids = g.milestones.map(() => nanoid(12));
    const items = g.milestones.map((m, i) => ({
      id: ids[i],
      title: m.title,
      idx: i,
      done: m.doneDaysAgo !== undefined,
      doneAt: m.doneDaysAgo !== undefined ? atTime(m.doneDaysAgo, 20) : null,
      prev: i > 0 ? ids[i - 1] : null,
    }));
    await run(
      `MATCH (u: NSUser {id: $userId})
       CREATE (g: NSGoal {
         id: $goalId, title: $title, why: $why, successLooksLike: $successLooksLike,
         deadline: $deadline, createdAt: $createdAt
       })
       CREATE (u)-[:PURSUES]->(g)
       WITH g
       UNWIND $items AS item
       CREATE (m: NSMilestone {id: item.id, title: item.title, done: item.done, \`order\`: item.idx, doneAt: item.doneAt})
       CREATE (g)-[:HAS_MILESTONE]->(m)
       WITH g, item, m
       WHERE item.prev IS NOT NULL
       MATCH (prev: NSMilestone {id: item.prev})
       CREATE (prev)-[:NEXT]->(m)`,
      {
        userId,
        goalId,
        title: g.title,
        why: g.why,
        successLooksLike: g.successLooksLike,
        deadline: g.deadline,
        createdAt: atTime(g.createdDaysAgo, 12),
        items,
      }
    );
  }

  for (const a of su.activities) {
    await run(
      `MATCH (u: NSUser {id: $userId}), (g: NSGoal {id: $goalId})
       CREATE (act: NSActivity {id: $id, minutes: $minutes, onTask: true, source: $source, at: $at})
       CREATE (u)-[:LOGGED]->(act)
       CREATE (act)-[:FOR]->(g)`,
      {
        userId,
        goalId: goalIds[a.goal],
        id: nanoid(12),
        minutes: a.minutes,
        source: 'manual',
        at: atTime(a.daysAgo, a.hour),
      }
    );
  }
  return userId;
}

async function verify(): Promise<void> {
  const rows = await run(
    'MATCH (u: NSUser {seeded: true}) RETURN u {.*} AS user ORDER BY u.createdAt'
  );
  console.log(`\nseeded ${rows.length} demo users:`);
  console.log('name      goals  done  minutes  streak  score');
  let failures = 0;
  for (const r of rows) {
    const u = r.user as Record<string, unknown>;
    const id = String(u.id);
    const name = String(u.name);
    const [goals, stats] = await Promise.all([loadGoals(id), computeStats(id)]);
    console.log(
      `${name.padEnd(9)} ${String(goals.length).padEnd(6)} ${String(stats.milestonesDone).padEnd(5)} ${String(
        stats.focusedMinutes
      ).padEnd(8)} ${String(stats.streak).padEnd(7)} ${stats.score}`
    );
    const expected = EXPECTED[name];
    if (!expected || expected.score !== stats.score || expected.streak !== stats.streak) {
      failures++;
      console.error(`  ^ mismatch for ${name}: expected score=${expected?.score} streak=${expected?.streak}`);
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} user(s) did not match the planned score/streak`);
  }
  console.log('all scores and streaks match the plan');
}

async function main(): Promise<void> {
  console.log('deleting previously seeded users...');
  await deleteSeeded();
  for (const su of USERS) {
    const id = await createUser(su);
    console.log(`created ${su.name} (${id})`);
  }
  await verify();
}

main()
  .then(async () => {
    await close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('seed failed:', err instanceof Error ? err.message : err);
    await close().catch(() => undefined);
    process.exit(1);
  });
