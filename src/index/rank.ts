// Function words dropped from keyword queries (English + Portuguese). Lowercase.
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but of to in on at by for from with as is are was were be been being ' +
    'it its this that these those there here why what which how when where who whom whose ' +
    'do does did done have has had we you i me my our your they them their he she his her ' +
    'not no can could should would will shall may might must about into than then so if ' +
    'de da do das dos e o os as um uma uns umas que por para com sem no na nos nas em ao aos ' +
    'se como porque por que qual quais quem onde quando nós eu ele ela eles elas foi é são ' +
    'era ser estar está isso isto esse essa este esta mais mas ou já não sim'
  ).split(' '),
);

/** Reciprocal Rank Fusion: score(d) = Σ weight / (k + rank), rank starting at 1. */
export function fuse(
  lists: Array<{ ids: string[]; weight?: number }>,
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ids, weight = 1 } of lists) {
    ids.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + i + 1));
    });
  }
  return scores;
}

const DAY_MS = 86_400_000;

/**
 * Multiplier in [1, 1.2]: +20% for a brand-new doc, halving every year.
 * ponytail: fixed curve; make it configurable if it misranks real queries.
 */
export function recencyBoost(updatedAt: string, now: Date): number {
  const age = (now.getTime() - new Date(updatedAt).getTime()) / DAY_MS;
  if (!Number.isFinite(age)) return 1;
  return 1 + 0.2 * 0.5 ** (Math.max(0, age) / 365);
}
