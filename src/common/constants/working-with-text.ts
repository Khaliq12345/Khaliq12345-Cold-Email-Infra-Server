export function generateUniqueAlphaNames(
  first: string,
  last: string,
  count: number = 100,
): string[] {
  const names = new Set<string>();
  const f = first.toLowerCase().trim();
  const l = last.toLowerCase().trim();
  const fi = f[0]; // first initial
  const li = l[0]; // last initial

  // 1. Core Patterns (Based on your "Nicole Soto" examples)
  const corePatterns = [
    f, // nicole
    `${f}.${li}`, // nicole.s
    `${fi}.${l}`, // n.soto
    `${fi}${li}`, // ns
    `${fi}${l}`, // nsoto
    `${f}${li}`, // nicoles
    `${f}.${l}`, // nicole.soto
  ];

  for (const name of corePatterns) {
    if (names.size < count) names.add(name);
  }

  // 2. Numeric Strategy (nicole2, nsoto1, etc.)
  // We iterate numbers and apply them to the base patterns
  let num = 1;
  while (names.size < count && num < 1000) {
    // Priority: common combinations with numbers
    const numericVariations = [
      `${fi}${l}${num}`, // nsoto1
      `${f}${num}`, // nicole2
      `${f}.${l}${num}`, // nicole.s13 (if num is 13)
      `${f}.${li}${num}`, // nicole.s1
      `${fi}.${l}${num}`, // n.soto1
    ];

    for (const v of numericVariations) {
      if (names.size < count) names.add(v);
    }
    num++;
  }

  return Array.from(names);
}

export const generateStr = (len: number) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + len);
