/**
 * One of these is shown in the dial-up header. Short (<= 60 columns), silly,
 * and about bb, agents, or 1994. Add more freely; keep them kind.
 */
export const TAGLINES: readonly string[] = [
  "640K ought to be enough for any agent.",
  "Now with 100% more modem noises (sound off by default).",
  "Your agents are working. You might as well play LORD.",
  "Please do not pick up the other phone while connected.",
  "It works on my machine. My machine is a 486.",
  "Context window: 25 lines. Like it's 1994.",
  "No GPUs were harmed in the making of this BBS.",
  "Ask your agent about Trade Wars. Then never ask again.",
  "If you can read this, your CRT is warmed up.",
  "The SysOp is a cron job. The cron job is asleep.",
];

/** Picks a tagline; pass `random` to make it deterministic in tests. */
export function pickTagline(random: () => number = Math.random): string {
  return TAGLINES[Math.floor(random() * TAGLINES.length) % TAGLINES.length];
}
