/** Local transcript/stock vocabulary. No transcript or frame is sent to a model. */
export type StockIntent = {
  /** Every subject must be evidenced in the provider's visual metadata. */
  subjects?: string[];
  /** An explicit spoken action must also be evidenced, not merely the subject. */
  actions?: string[];
  /** Only short topic queries are sent to stock providers. */
  searchQueries?: string[];
};

const noise = new Set(
  `a an the and or of on in at to for with from is are be it this that your our their my his her its some new better next small big real really just very more most how what when why who do does have has can will would could should make makes making get gets got want need think know say says said look looks like one two many thing things something everything moment moments story stories footage video videos photo photos stock broll b roll scene scenes clip clips view views hd uhd mp4 webm jpg jpeg png file`.split(
    " ",
  ),
);
// Equivalence is deliberately narrow. A paper notebook is not a laptop; a
// beach is not interchangeable with an ocean, and a cafe is not a coffee cup.
const aliases: Record<string, string> = {
  sea: "ocean",
  seaside: "ocean",
  shoreline: "ocean",
  shore: "ocean",
  coast: "ocean",
  coastal: "ocean",
  waves: "ocean",
  wave: "ocean",
  oceanic: "ocean",
  espresso: "coffee",
  cappuccino: "coffee",
  latte: "coffee",
  laptops: "laptop",
  computers: "computer",
  jogging: "run",
  running: "run",
  runner: "run",
  runners: "run",
  jog: "run",
  bicycle: "bike",
  bicycles: "bike",
  cycling: "bike",
  biking: "bike",
  cyclist: "bike",
  automobile: "car",
  automobiles: "car",
  vehicles: "vehicle",
  woodland: "forest",
  woods: "forest",
  trees: "tree",
  trekking: "hike",
  hiking: "hike",
  children: "child",
  kids: "child",
  kid: "child",
  dogs: "dog",
  puppy: "dog",
  puppies: "dog",
  cats: "cat",
  kitten: "cat",
  kittens: "cat",
  smartphone: "phone",
  smartphones: "phone",
  cellphone: "phone",
  mountains: "mountain",
  mountainous: "mountain",
  grinding: "grind",
  grinder: "grind",
  grinders: "grind",
  ground: "grind",
  grinds: "grind",
  brewing: "brew",
  brewer: "brew",
  brewers: "brew",
  brewed: "brew",
  brews: "brew",
  roasting: "roast",
  roasted: "roast",
  roaster: "roast",
  roasters: "roast",
  drinking: "drink",
  drinks: "drink",
  sipping: "drink",
  sip: "drink",
  pouring: "pour",
  pours: "pour",
  poured: "pour",
  cutting: "cut",
  cuts: "cut",
  chopping: "chop",
  chopped: "chop",
  baking: "bake",
  baked: "bake",
  cooking: "cook",
  cooked: "cook",
  watering: "water",
  planting: "plant",
  planted: "plant",
  seedlings: "seedling",
  harvesting: "harvest",
  sewing: "sew",
  painting: "paint",
  painted: "paint",
  drawing: "draw",
  reading: "read",
  typing: "type",
  recording: "record",
  charging: "charge",
  charged: "charge",
  swimming: "swim",
  swimmer: "swim",
  flying: "fly",
  washing: "wash",
  washed: "wash",
  cleaning: "clean",
  cleaned: "clean",
  lifting: "lift",
  repairing: "repair",
  writing: "write",
  written: "write",
  measuring: "measure",
  mixing: "mix",
  kneading: "knead",
  photographing: "photograph",
};
export function stockWordKey(word: string): string {
  if (aliases[word]) return aliases[word];
  if (word.length > 5 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}
export function stockWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
export function stockKeywords(text: string): string[] {
  return [
    ...new Set(
      stockWords(text)
        .filter(
          (word) => word.length > 2 && !noise.has(word) && !/^\d+$/.test(word),
        )
        .map(stockWordKey),
    ),
  ];
}

const negativeWords = new Set([
  "not",
  "never",
  "no",
  "dont",
  "doesnt",
  "didnt",
  "cannot",
  "cant",
  "without",
  "avoid",
  "avoiding",
  "stop",
  "stopped",
  "skip",
  "skipping",
  "unlike",
]);
const resetWords = new Set(["but", "instead", "rather", "however", "now"]);
/** Conservative clause scope, shared by speech intent and provider metadata. */
export function negatedWordPositions(words: string[]): Set<number> {
  const positions = new Set<number>();
  let negative = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (resetWords.has(word)) negative = false;
    if (
      (word === "instead" && words[i + 1] === "of") ||
      (word === "rather" && words[i + 1] === "than")
    )
      negative = true;
    if (negativeWords.has(word) && !(word === "not" && words[i + 1] === "only"))
      negative = true;
    if (negative) positions.add(i);
  }
  return positions;
}

export const visualActions: Record<string, string> = {
  grind: "grinding",
  brew: "brewing",
  roast: "roasting",
  drink: "drinking",
  pour: "pouring",
  cut: "cutting",
  chop: "chopping",
  bake: "baking",
  cook: "cooking",
  plant: "planting",
  harvest: "harvesting",
  sew: "sewing",
  paint: "painting",
  draw: "drawing",
  read: "reading",
  type: "typing",
  record: "recording",
  charge: "charging",
  swim: "swimming",
  fly: "flying",
  wash: "washing",
  clean: "cleaning",
  lift: "lifting",
  repair: "repairing",
  write: "writing",
  measure: "measuring",
  mix: "mixing",
  knead: "kneading",
};

/** Tool names and completed states never prove an action is happening. */
export function stockActionKey(word: string): string {
  if (["sip", "sips", "sipping"].includes(word)) return "drink";
  for (const [key, gerund] of Object.entries(visualActions)) {
    const present =
      key === "fly"
        ? "flies"
        : `${key}${/(?:sh|ch|x)$/.test(key) ? "es" : "s"}`;
    if (word === key || word === gerund || word === present) return key;
  }
  return "";
}

/** Provider prose is evidence only within a short clause, never a creator name. */
export function visualMetadataClauses(
  title: string,
  description = "",
): Set<string>[] {
  return [title, description.slice(0, 2400)].flatMap((text) =>
    text
      .split(
        /[.!?;\n]|\b(?:but|however|while|beside|alongside|behind|near|next to|in front of)\b/i,
      )
      .flatMap((clause) => {
        const words = stockWords(clause),
          negative = negatedWordPositions(words);
        const positive = words.filter((_, index) => !negative.has(index));
        // Long keyword dumps/descriptions cannot join distant unrelated subjects.
        const clauses: Set<string>[] = [];
        for (let index = 0; index < positive.length; index += 16) {
          const window = positive.slice(index, index + 28);
          const evidence = new Set(stockKeywords(window.join(" ")));
          for (const word of window) {
            const action = stockActionKey(word);
            if (action) evidence.add(`@action:${action}`);
          }
          clauses.push(evidence);
        }
        return clauses;
      }),
  );
}
