import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const entries = [
  {
    key: "zero_chat_philosophy",
    title: "Zero-Chat Philosophy",
    category: "philosophy",
    priority: 0,
    content: `Gennety Dating is a Zero-Chat dating service. Users NEVER message each other through our platform.
The AI matchmaker finds compatible matches, proposes them with a personalized pitch, and negotiates the logistics of the first date.
Users just show up. No swiping, no chatting, no awkward first messages.
If a user asks to message their match, explain that our philosophy is to skip the texting phase entirely — science shows that real chemistry is best discovered in person.`,
  },
  {
    key: "match_timing_faq",
    title: "Match Timing & Batch Schedule",
    category: "faq",
    priority: 1,
    content: `Matches are generated in weekly batches. The system runs a global matching algorithm once per week.
After the batch runs, matched users receive a personalized AI-generated pitch.
Both users must accept the match within 24 hours or it expires.
If both accept, the progressive scheduling flow begins (AI proposes times, then calendar if needed).
Users should keep their profile active and updated to maximize match quality.`,
  },
  {
    key: "profile_rules",
    title: "Profile & Editing Rules",
    category: "rules",
    priority: 2,
    content: `Core identity data (Name, Age, University/Email) is FIXED after onboarding and cannot be changed.
Users CAN edit: bio/psychological summary, major, age range preferences, visual preferences, and photos.
Minimum 2 photos required at all times. Maximum 6 photos.
Bio length is capped at 500 characters.
Encourage users to keep their profile fresh — updated photos and preferences improve match quality.`,
  },
  {
    key: "emergency_protocol",
    title: "Emergency Protocol & Date Lifecycle",
    category: "rules",
    priority: 3,
    content: `5 hours before a scheduled date, the emergency cancellation window unlocks.
To cancel, the user MUST provide a written explanation. The bot forwards the EXACT text to the other person — no filtering, no AI rewriting.
Ice-breaker conversation starters are sent 5 hours before the date to both users.
The day after a date, the bot asks both users for feedback to improve future matching.
Cancelling too frequently may affect future match quality.`,
  },
  {
    key: "university_verification",
    title: "University Email Verification",
    category: "rules",
    priority: 4,
    content: `All users must verify a corporate university email address (.edu, .ac.uk, etc.) during onboarding.
This cannot be changed after verification. It ensures all users are real university students.
If a user has trouble verifying, they can request a new OTP code.
We do not accept personal email addresses (Gmail, Yahoo, etc.).`,
  },
];

async function main() {
  console.log("Seeding system_knowledge...");

  for (const entry of entries) {
    await prisma.systemKnowledge.upsert({
      where: { key: entry.key },
      create: entry,
      update: {
        title: entry.title,
        content: entry.content,
        category: entry.category,
        priority: entry.priority,
      },
    });
    console.log(`  ✓ ${entry.key}`);
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
