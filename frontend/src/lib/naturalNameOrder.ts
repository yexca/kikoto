// Orders file and folder names the way a listener reads them: a run of digits
// compares by its value, and a kanji numeral after 第 compares as the number it
// writes, so 第二話 comes before 第十話 whatever the interface language.

// localeCompare with options builds a collator per call; sorting is hot enough to share one.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const kanjiOrdinal = /第([〇零一二三四五六七八九十百千万萬]+)/g;

const kanjiDigits: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const kanjiUnits: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** The number a kanji numeral writes, such as 二十一 or 二〇二四, or null when it is not well formed. */
export function kanjiNumeralValue(numeral: string): number | null {
  const characters = [...numeral];
  if (characters.every((character) => character in kanjiDigits)) {
    return Number(characters.map((character) => kanjiDigits[character]).join(""));
  }
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const character of characters) {
    if (character === "〇" || character === "零") {
      // A zero between units only marks a skipped place, as in 一百零五.
      if (digit !== null) return null;
    } else if (character in kanjiDigits) {
      if (digit !== null) return null;
      digit = kanjiDigits[character];
    } else if (character in kanjiUnits) {
      section += (digit ?? 1) * kanjiUnits[character];
      digit = null;
    } else {
      total += (section + (digit ?? 0) || 1) * 10000;
      section = 0;
      digit = null;
    }
  }
  return total + section + (digit ?? 0);
}

function naturalSortKey(name: string) {
  if (!name.includes("第")) return name;
  return name.replace(kanjiOrdinal, (ordinal, numeral: string) => {
    const value = kanjiNumeralValue(numeral);
    return value === null ? ordinal : `第${value}`;
  });
}

/** Compares two file or folder names in natural order; names that read the same fall back to their own text. */
export function naturalNameCompare(left: string, right: string) {
  return collator.compare(naturalSortKey(left), naturalSortKey(right)) || collator.compare(left, right);
}
