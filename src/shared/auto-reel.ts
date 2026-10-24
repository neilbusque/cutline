import { applyCommands, type Command } from "./commands";
import { overlayFadeFrames } from "./transitions";
import {
  ReelFormatSchema,
  type ReelFormat,
  type ReelBeat,
} from "./reel-formats";
import { creatorBrollPlacement, creatorBrollWindow } from "./creator-education";
import {
  creatorShortCutReframes,
  isCreatorShortFormat,
} from "./creator-shorts";
import { duckingKeys } from "./audio-duck";
import {
  makeClip,
  uid,
  type Asset,
  type Clip,
  type Project,
  type Track,
  type Word,
} from "./model";
import {
  createReelPlan,
  reelWordsForClip,
  type ReelPlan,
  type ReelSource,
  type ReelStyle,
} from "./reel";

import {
  negatedWordPositions,
  stockKeywords,
  stockActionKey,
  stockWordKey,
  stockWords,
  visualActions,
  type StockIntent,
} from "./stock-relevance";

export type AutoReelBeat = StockIntent & {
  query: string;
  keywords: string[];
  startSeconds: number;
  durationSeconds: number;
  reason: string;
};
export type AutoReelAnalysis = {
  assetId: string;
  fps: Project["fps"];
  sources: ReelSource[];
  targetSeconds: 15 | 30 | 60 | 90;
  durationSeconds: number;
  style: ReelStyle;
  format?: ReelFormat;
  hook: string;
  beats: AutoReelBeat[];
  speechRanges: { startSeconds: number; endSeconds: number }[];
  warnings: string[];
};
export type AutoReelOptions = {
  targetSeconds?: 15 | 30 | 60 | 90;
  style?: ReelStyle;
  format?: ReelFormat;
  pace?: "natural" | "tight";
  fps?: Project["fps"];
};
export type AutoReelPlacement = {
  assetId: string;
  startSeconds: number;
  durationSeconds: number;
  query: string;
};
type Span = { start: number; end: number };
type TimedWord = Word & { sourceStart: number };

const pacing = {
  natural: { before: 0.12, after: 0.18, gap: 0.8 },
  tight: { before: 0.09, after: 0.14, gap: 0.5 },
};
const stopWords = new Set(
  `a about actually after again against all almost also always am an and another any anyone anything are aren't around as at away back be because been before being best better between big bit both but by can cannot can't come comes could couldn't day days did didn't different do does doesn't doing don't down each easy else enough even ever every everybody everything few first for from further get gets getting give go goes going good got great had has have haven't having he her here hers herself him himself his how however i i'd i'll i'm i've if in into is isn't it it's its itself just keep kind know last later less let's like little long look lot made make makes making many may me mean means might more most much must my myself need needs never new next no nor not nothing now of off often okay old on once one only or other our ours ourselves out over own part people perhaps please really right said same say says saying second see seen she should shouldn't since small so some somebody someone something sometimes still such sure take than that that's the their theirs them themselves then there there's these they thing things think third this those though through time times to too try two under until up us use used using usually very want was wasn't way we we'd we'll we're we've well were weren't what what's whatever when where whether which while who whom why will with within without won't work works working would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves today tomorrow yesterday important useful understand video videos reel reels watch watching tell talk talking thank thanks welcome hello hey subscribe follow save channel learn learning explain explained point points step steps example examples stuff pretty basically simply exactly literally definitely probably absolutely everyone someone nobody already become able needs let really much many much enough`.split(
    /\s+/,
  ),
);

// Search concepts describe the topic that was spoken. They are not claims about
// what the camera saw. Only explicitly matched terms activate a concept.
const concreteWords = new Set(
  `tea beans bean wine beer whiskey vodka juice alcohol apple apples orange oranges banana bananas tomato tomatoes potato potatoes carrot carrots lettuce broccoli vegetables fruit fruits salad rice pasta noodles cheese milk yogurt chocolate pizza sandwich sandwiches bread burger burgers fish salmon shrimp chicken beef eggs egg salt pepper spices bowl plate plates fork knife spoon cup cups glass glasses bottle bottles table desk chair chairs sofa couch lamp lamps window windows door doors roof wall walls floor floors pencil pencils pen pens paper notebook notebooks journal journals backpack backpacks suitcase luggage umbrella coat coats jacket jackets shirt shirts shoes sneakers boots hat hats watch watches clock clocks bicycle bicycles motorcycle motorcycles bus buses train trains subway station boat boats ship ships bridge bridges road roads street streets highway traffic city cities village villages river rivers lake lakes waterfall waterfalls desert sand snow rain storm clouds cloud sunlight sunset sunrise moon stars telescope telescopes microscope microscopes laboratory laboratories experiment experiments bacteria cells dna robotics robot robots drone drones satellite satellites rocket rockets space spacecraft astronaut astronauts ocean coral reef reefs whale whales dolphin dolphins turtle turtles bird birds eagle eagles horse horses cow cows sheep pig pigs rabbit rabbits bee bees butterfly butterflies insect insects flower flowers rose roses tulip tulips sunflower sunflowers wheat corn tractor tractors farm farms field fields orchard orchards vineyard vineyards grapes grape timber wood lumber brick bricks steel metal copper gold silver fabric fabrics cotton wool silk leather sewing needle needles scissors thread threads pottery ceramics clay sculpture sculptures marble stone stones rock rocks gemstone gemstones diamond diamonds hospital hospitals clinic clinics dentist dentists tooth teeth toothbrush toothpaste soap shampoo skincare cosmetics makeup lipstick perfume nail nails scissors scissors scissors mirror mirrors hair haircut salon salons barber barbers printer printers keyboard keyboards mouse monitor monitors touchscreen tablet tablets smartphone smartphones phone phones server servers cable cables router routers wifi ethernet guitar piano violin drums drum flute trumpet saxophone football soccer basketball baseball tennis volleyball swimming pool pools stadium stadiums racket rackets ball balls skateboard skateboards surfboard surfboards skates snowboard snowboards skiing ski skis`.split(
    /\s+/,
  ),
);

// These words need an actual subject beside them; alone they can describe
// unrelated actions (drinking wine, charging clients, planning a business).
const ambiguousSubjects = new Set([
  "drinking",
  "outreach",
  "electric",
  "charging",
  "renewable",
  "planning",
  "scheduling",
  "deadline",
  "deadlines",
  "saving",
  "delivery",
]);
const queryAliases: Record<string, string> = {
  "a book": "book",
  "the book": "book",
  ai: "artificial intelligence",
  "running outdoors": "running",
  "running outside": "running",
};

const concepts: { terms: string[]; query: string; keywords: string[] }[] = [
  {
    terms: ["coffee", "espresso", "cappuccino", "latte", "barista"],
    query: "coffee espresso",
    keywords: ["coffee", "espresso"],
  },
  {
    terms: ["email", "emails", "inbox", "outreach"],
    query: "email laptop",
    keywords: ["email", "laptop"],
  },
  {
    terms: ["camera", "cameras", "photography", "photographer", "lens"],
    query: "camera photography",
    keywords: ["camera", "photography"],
  },
  {
    terms: ["microphone", "podcast", "podcasts", "recording"],
    query: "microphone recording",
    keywords: ["microphone", "recording"],
  },
  {
    terms: [
      "restaurant",
      "restaurants",
      "chef",
      "chefs",
      "cooking",
      "kitchen",
      "recipe",
    ],
    query: "cooking kitchen",
    keywords: ["cooking", "kitchen"],
  },
  {
    terms: ["baking", "bakery", "bread", "dough"],
    query: "bread baking",
    keywords: ["bread", "baking"],
  },
  {
    terms: ["gym", "workout", "workouts", "weightlifting", "dumbbell"],
    query: "gym workout",
    keywords: ["gym", "workout"],
  },
  {
    terms: [
      "jogging",
      "marathon",
      "runner",
      "running outdoors",
      "running outside",
      "running shoes",
    ],
    query: "running outdoors",
    keywords: ["running", "runner"],
  },
  {
    terms: ["cycling", "bicycle", "cyclist", "biking"],
    query: "bicycle cycling",
    keywords: ["bicycle", "cycling"],
  },
  {
    terms: ["yoga", "meditation", "meditate", "mindfulness"],
    query: "yoga meditation",
    keywords: ["yoga", "meditation"],
  },
  {
    terms: ["sleep", "sleeping", "bedtime", "insomnia"],
    query: "bedroom sleep",
    keywords: ["bedroom", "sleep"],
  },
  {
    terms: ["garden", "gardening", "plants", "planting"],
    query: "gardening plants",
    keywords: ["gardening", "plants"],
  },
  {
    terms: ["forest", "forests", "trees", "woodland"],
    query: "forest trees",
    keywords: ["forest", "trees"],
  },
  {
    terms: ["ocean", "oceans", "beach", "beaches", "seaside"],
    query: "ocean beach",
    keywords: ["ocean", "beach"],
  },
  {
    terms: ["mountain", "mountains", "hiking", "hike"],
    query: "mountain hiking",
    keywords: ["mountain", "hiking"],
  },
  {
    terms: ["airport", "airplane", "airplanes", "flight", "flying"],
    query: "airport airplane",
    keywords: ["airport", "airplane"],
  },
  {
    terms: ["hotel", "hotels", "resort", "hospitality"],
    query: "hotel travel",
    keywords: ["hotel", "travel"],
  },
  {
    terms: ["car", "cars", "automotive", "mechanic", "mechanics", "vehicle"],
    query: "car automotive",
    keywords: ["car", "automotive"],
  },
  {
    terms: ["electric", "battery", "batteries", "charging"],
    query: "battery charging",
    keywords: ["battery", "charging"],
  },
  {
    terms: ["solar", "renewable", "windmill", "turbine"],
    query: "renewable energy solar",
    keywords: ["renewable", "energy", "solar"],
  },
  {
    terms: ["house", "houses", "housing", "real estate", "property market"],
    query: "house real estate",
    keywords: ["house", "property"],
  },
  {
    terms: [
      "construction",
      "building site",
      "builder",
      "builders",
      "concrete wall",
      "concrete floor",
    ],
    query: "construction site",
    keywords: ["construction", "building"],
  },
  {
    terms: ["coding", "programming", "developer", "developers", "software"],
    query: "computer programming",
    keywords: ["computer", "programming"],
  },
  {
    terms: ["artificial intelligence", "machine learning", "ai"],
    query: "computer technology",
    keywords: ["computer", "technology"],
  },
  {
    terms: [
      "spreadsheet",
      "spreadsheets",
      "analytics",
      "dashboard",
      "data analysis",
    ],
    query: "data spreadsheet",
    keywords: ["data", "spreadsheet"],
  },
  {
    terms: [
      "calendar",
      "schedule",
      "scheduling",
      "deadline",
      "deadlines",
      "planning",
    ],
    query: "calendar planning",
    keywords: ["calendar", "planning"],
  },
  {
    terms: ["meeting", "meetings", "teamwork", "coworkers", "colleagues"],
    query: "team meeting",
    keywords: ["team", "meeting"],
  },
  {
    terms: ["interview", "interviews", "hiring", "recruiting", "recruitment"],
    query: "job interview",
    keywords: ["job", "interview"],
  },
  {
    terms: [
      "money",
      "budget",
      "budgeting",
      "saving",
      "savings",
      "finance",
      "financial",
    ],
    query: "money budgeting",
    keywords: ["money", "budgeting"],
  },
  {
    terms: ["investment", "investing", "stocks", "stock market", "trading"],
    query: "stock market finance",
    keywords: ["stock", "market", "finance"],
  },
  {
    terms: ["warehouse", "shipping", "logistics", "delivery", "packages"],
    query: "warehouse packages",
    keywords: ["warehouse", "packages"],
  },
  {
    terms: [
      "shopping",
      "retail",
      "ecommerce",
      "grocery store",
      "retail store",
      "shop window",
    ],
    query: "retail shopping",
    keywords: ["retail", "shopping"],
  },
  {
    terms: ["books", "reading", "library", "book cover", "a book", "the book"],
    query: "books reading",
    keywords: ["books", "reading"],
  },
  {
    terms: ["school", "classroom", "teacher", "teaching", "students"],
    query: "school classroom",
    keywords: ["school", "classroom"],
  },
  {
    terms: ["paint", "painting", "artist", "artwork", "drawing"],
    query: "artist painting",
    keywords: ["artist", "painting"],
  },
  {
    terms: ["guitar", "piano", "violin", "instrument", "musician"],
    query: "music instrument",
    keywords: ["music", "instrument"],
  },
  {
    terms: ["dog", "dogs", "puppy", "puppies"],
    query: "dog pet",
    keywords: ["dog", "pet"],
  },
  {
    terms: ["cat", "cats", "kitten", "kittens"],
    query: "cat pet",
    keywords: ["cat", "pet"],
  },
  {
    terms: ["water", "hydration", "hydrate", "drinking"],
    query: "drinking water",
    keywords: ["drinking", "water"],
  },
];

function normalized(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function includesTerm(text: string, term: string) {
  return ` ${text} `.includes(` ${term} `);
}
function usableWords(asset: Asset): Word[] {
  return (asset.words ?? [])
    .filter(
      (word) =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start &&
        word.start < asset.duration &&
        word.end > 0 &&
        word.text.trim() &&
        !/^\s*\[[^\]]+\]\s*$/.test(word.text),
    )
    .map((word) => ({
      text: word.text.trim(),
      start: Math.max(0, word.start),
      end: Math.min(asset.duration, word.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
function speechSpans(
  words: Word[],
  assetDuration: number,
  pace: "natural" | "tight" = "natural",
): Span[] {
  const handles = pacing[pace];
  const spans: Span[] = [];
  for (const word of words) {
    const current = spans.at(-1);
    if (!current || word.start - (current.end - handles.after) > handles.gap)
      spans.push({
        start: Math.max(0, word.start - handles.before),
        end: Math.min(assetDuration, word.end + handles.after),
      });
    else
      current.end = Math.min(
        assetDuration,
        Math.max(current.end, word.end + handles.after),
      );
  }
  return spans;
}
function frameLength(span: Span, fps: number) {
  return Math.max(0, Math.floor((span.end - span.start) * fps + 1e-7));
}
function totalFrames(spans: Span[], fps: number) {
  return spans.reduce((sum, span) => sum + frameLength(span, fps), 0);
}
function sourcesFor(
  asset: Asset,
  words: Word[],
  fps: number,
  pace: "natural" | "tight",
): ReelSource[] {
  const spans = speechSpans(words, asset.duration, pace);
  const lastWord = words.at(-1),
    lastSpan = spans.at(-1);
  // An ending handle must not capture the beginning of the next, excluded
  // word. Otherwise a sentence-safe selection can still sound cut mid-word.
  const nextWord =
    lastWord &&
    usableWords(asset).find(
      (word) => word.start >= lastWord.end && word.start > lastWord.start,
    );
  if (lastSpan && lastWord && nextWord)
    lastSpan.end = Math.max(
      lastWord.end,
      Math.min(lastSpan.end, nextWord.start),
    );
  return spans
    .filter((span) => frameLength(span, fps) > 0)
    .map((span) => ({
      assetId: asset.id,
      sourceIn: span.start,
      sourceOut: span.end,
      speed: 1,
    }));
}
function mappedWords(
  asset: Asset,
  sources: ReelSource[],
  fps: number,
): TimedWord[] {
  let cursor = 0;
  return sources.flatMap((source) => {
    const sourceIn = source.sourceIn ?? 0,
      sourceOut = source.sourceOut ?? asset.duration;
    const seconds =
      Math.floor(((sourceOut - sourceIn) / (source.speed ?? 1)) * fps + 1e-7) /
      fps;
    const local = reelWordsForClip(
      { ...asset, words: usableWords(asset) },
      {
        sourceIn,
        speed: source.speed ?? 1,
        duration: Math.round(seconds * fps),
      },
      fps,
    );
    const result = local.map((word) => ({
      ...word,
      sourceStart: sourceIn + word.start * (source.speed ?? 1),
      start: cursor + word.start,
      end: cursor + word.end,
    }));
    cursor += seconds;
    return result;
  });
}
function mergeSpeechRanges(
  words: Word[],
): { startSeconds: number; endSeconds: number }[] {
  const ranges: { startSeconds: number; endSeconds: number }[] = [];
  for (const word of words) {
    const current = ranges.at(-1);
    if (!current || word.start - current.endSeconds > 0.65)
      ranges.push({ startSeconds: word.start, endSeconds: word.end });
    else current.endSeconds = Math.max(current.endSeconds, word.end);
  }
  return ranges;
}
function makeBeats(
  words: TimedWord[],
  durationSeconds: number,
): AutoReelBeat[] {
  const beats: AutoReelBeat[] = [],
    seen = new Map<string, number>();
  const sentences: TimedWord[][] = [];
  for (const word of words) {
    const current = sentences.at(-1);
    if (
      !current ||
      word.start - current.at(-1)!.end > 0.9 ||
      word.start - current[0].start > 12 ||
      /[.!?]["'”)]?$/.test(current.at(-1)!.text)
    )
      sentences.push([word]);
    else current.push(word);
  }
  let previousCoffeeEnd = -Infinity;
  for (const sentence of sentences) {
    if (beats.length >= 6) break;
    const tokens = sentence.flatMap((word) =>
      /[@]|https?:|www\./i.test(word.text)
        ? []
        : stockWords(word.text).map((text) => ({ text, word })),
    );
    const tokenText = tokens.map((token) => token.text),
      negative = negatedWordPositions(tokenText);
    const mentions: {
      anchor: string;
      index: number;
      length: number;
      group: string;
    }[] = [];
    for (const concept of concepts)
      for (const term of concept.terms) {
        if (
          ambiguousSubjects.has(term) ||
          [
            "recording",
            "mindfulness",
            "insomnia",
            "software",
            "developer",
            "developers",
            "finance",
            "financial",
            "investment",
            "investing",
            "trading",
            "hiring",
            "recruiting",
            "recruitment",
            "teamwork",
          ].includes(term)
        )
          continue;
        const parts = stockWords(term);
        for (let index = 0; index <= tokens.length - parts.length; index++) {
          if (
            parts.every(
              (part, offset) =>
                tokenText[index + offset] === part &&
                !negative.has(index + offset),
            )
          )
            mentions.push({
              anchor: queryAliases[term] ?? term,
              index,
              length: parts.length,
              group: concept.query,
            });
        }
      }
    tokens.forEach((token, index) => {
      if (
        !negative.has(index) &&
        concreteWords.has(token.text) &&
        !stopWords.has(token.text) &&
        !mentions.some(
          (mention) =>
            index >= mention.index && index < mention.index + mention.length,
        )
      )
        mentions.push({
          anchor: token.text,
          index,
          length: 1,
          group: stockWordKey(token.text),
        });
    });
    // "Grind the beans" can inherit coffee from the immediately preceding
    // sentence; an unrelated bean recipe cannot inherit a distant topic.
    if (
      sentence[0].start - previousCoffeeEnd < 2.5 &&
      !mentions.some((mention) =>
        stockKeywords(mention.anchor).includes("coffee"),
      )
    ) {
      const index = tokens.findIndex(
        (token, i) => stockWordKey(token.text) === "bean" && !negative.has(i),
      );
      if (
        index >= 0 &&
        tokens.some(
          (token, i) =>
            !negative.has(i) &&
            ["grind", "brew", "roast"].includes(stockWordKey(token.text)),
        )
      )
        mentions.push({
          anchor: "coffee beans",
          index,
          length: 1,
          group: "coffee espresso",
        });
    }
    if (
      mentions.some((mention) =>
        stockKeywords(mention.anchor).includes("coffee"),
      )
    )
      previousCoffeeEnd = sentence.at(-1)!.end;
    const compoundCoffee = mentions.find((mention) =>
      stockKeywords(mention.anchor).includes("coffee"),
    );
    const candidates = mentions
      .filter(
        (mention) =>
          !(
            stockKeywords(mention.anchor).every((key) => key === "bean") &&
            compoundCoffee &&
            Math.abs(mention.index - compoundCoffee.index) <= 2
          ),
      )
      .map((mention) => {
        const subjects = stockKeywords(mention.anchor);
        let subjectQuery = mention.anchor;
        // Adjacent physical details narrow the shot, rather than inventing a
        // broad lifestyle concept from a single word.
        if (
          subjects.includes("coffee") &&
          tokens.some(
            (token, index) =>
              Math.abs(index - mention.index) <= 2 &&
              !negative.has(index) &&
              stockWordKey(token.text) === "bean",
          )
        ) {
          subjectQuery = "coffee beans";
          if (!subjects.includes("bean")) subjects.push("bean");
        }
        // Beans narrow search and ranking, but "grinding coffee" already
        // identifies the same physical process when metadata omits the bean noun.
        const details = subjects.includes("coffee")
          ? subjects.filter((key) => key === "bean")
          : [];
        for (const detail of details)
          subjects.splice(subjects.indexOf(detail), 1);
        const action = tokens
          .map((token, index) => ({
            key: stockActionKey(token.text),
            index,
            word: token.word,
          }))
          .filter(
            (value) =>
              visualActions[value.key] &&
              !negative.has(value.index) &&
              Math.abs(value.index - mention.index) <= 5 &&
              !subjects.includes(value.key),
          )
          // Do not borrow the action belonging to a different nearby subject.
          .filter(
            (value) =>
              !mentions.some(
                (other) =>
                  other !== mention &&
                  other.index > Math.min(value.index, mention.index) &&
                  other.index < Math.max(value.index, mention.index) &&
                  !stockKeywords(other.anchor).some((key) =>
                    subjects.includes(key),
                  ),
              ),
          )
          .sort(
            (a, b) =>
              Math.abs(a.index - mention.index) -
              Math.abs(b.index - mention.index),
          )[0];
        const query = action
          ? `${visualActions[action.key]} ${subjectQuery}`
          : subjectQuery;
        const spokenAt = Math.min(
          tokens[mention.index].word.start,
          action?.word.start ?? Infinity,
        );
        let clauseStart = sentence[0].start;
        for (let index = 0; index < mention.index; index++) {
          if (
            negative.has(index) ||
            ["but", "instead", "however", "then", "and"].includes(
              tokens[index].text,
            ) ||
            /[,;:]$/.test(tokens[index].word.text)
          )
            clauseStart = tokens[index].word.end;
        }
        const anticipatedAt = action
          ? spokenAt
          : Math.max(clauseStart, spokenAt - 0.35);
        const identity = `${mention.group}:${action?.key ?? ""}`;
        return {
          query,
          subjects,
          details,
          actions: action ? [action.key] : [],
          spokenAt,
          anticipatedAt,
          identity,
          subjectQuery,
          score:
            (action ? 4 : 0) + subjects.length * 0.5 - mention.index * 0.025,
        };
      })
      .filter(
        (candidate) =>
          candidate.subjects.length &&
          (!seen.has(candidate.identity) ||
            candidate.spokenAt - seen.get(candidate.identity)! >= 12),
      )
      .sort((a, b) => b.score - a.score || a.spokenAt - b.spokenAt);
    for (const candidate of candidates) {
      const startSeconds = Math.max(2.5, candidate.anticipatedAt),
        previous = beats.at(-1);
      if (
        previous &&
        startSeconds < previous.startSeconds + previous.durationSeconds + 1.25
      )
        continue;
      // A cutaway ends with its thought; it cannot cover the next instruction.
      const endSeconds = Math.min(
        durationSeconds - 1.5,
        sentence.at(-1)!.end + 0.18,
        startSeconds + 3,
      );
      const duration = endSeconds - startSeconds;
      if (duration < 1.25 || startSeconds - candidate.spokenAt > 2.5) continue;
      beats.push({
        query: candidate.query,
        keywords: [
          ...candidate.subjects,
          ...candidate.details,
          ...candidate.actions,
        ],
        subjects: candidate.subjects,
        actions: candidate.actions,
        searchQueries: [
          ...new Set([candidate.query, candidate.subjects.join(" ")]),
        ],
        startSeconds,
        durationSeconds: duration,
        reason: `Transcript mentions ${candidate.query}. Stock must match the spoken subject${candidate.actions.length ? " and action" : ""}; this is based on speech, not visual scene recognition.`,
      });
      seen.set(candidate.identity, startSeconds);
      break;
    }
  }
  return beats;
}

/** Analyze only local metadata and supplied transcript. No network or mutation. */
export function analyzeAutoReel(
  asset: Asset,
  options: AutoReelOptions = {},
): AutoReelAnalysis {
  if (
    asset.kind !== "video" ||
    !Number.isFinite(asset.duration) ||
    asset.duration <= 0
  )
    throw Error("Choose one video with a usable duration.");
  const format = ReelFormatSchema.parse(options.format ?? "montage");
  const fps = options.fps ?? 30,
    style =
      options.style ??
      (format === "creator-education" || isCreatorShortFormat(format)
        ? "clean"
        : "bold");
  const pace = options.pace ?? "natural";
  if (pace !== "natural" && pace !== "tight")
    throw Error("Choose Natural or Tight pacing.");
  if (![24, 25, 30, 60].includes(fps))
    throw Error("Choose a supported project frame rate.");
  if (!["clean", "bold", "cinematic"].includes(style))
    throw Error("Choose a supported Reel style.");
  if (
    options.targetSeconds !== undefined &&
    ![15, 30, 60, 90].includes(options.targetSeconds)
  )
    throw Error("Choose a 15, 30, 60 or 90 second target.");
  if (Math.floor(asset.duration * fps + 1e-7) < 1)
    throw Error("The video is shorter than one output frame.");
  const warnings: string[] = [],
    words = usableWords(asset);
  let sources: ReelSource[], targetSeconds: AutoReelAnalysis["targetSeconds"];
  if (!words.length || !asset.hasAudio) {
    const limit = options.targetSeconds ?? 60;
    const frames = Math.floor(Math.min(asset.duration, limit) * fps + 1e-7);
    if (frames < 1) throw Error("The video is shorter than one output frame.");
    sources = [
      { assetId: asset.id, sourceIn: 0, sourceOut: frames / fps, speed: 1 },
    ];
    targetSeconds =
      options.targetSeconds ??
      ([15, 30, 60, 90].find(
        (value) => value >= frames / fps,
      ) as AutoReelAnalysis["targetSeconds"]);
    warnings.push(
      asset.hasAudio
        ? "No usable transcript is available. The original video is kept; captions and topic-matched B-roll need speech transcription."
        : "This video has no audio track. The original video is kept with motion and music; no spoken captions or transcript-matched B-roll can be inferred.",
    );
  } else {
    const requested = options.targetSeconds ?? 60;
    const fullSpans = speechSpans(words, asset.duration, pace),
      fullFrames = totalFrames(fullSpans, fps);
    let chosen = words;
    if (fullFrames > requested * fps) {
      let lastWord = -1,
        lastSentence = -1,
        sentenceInNinety = -1;
      for (let index = 0; index < words.length; index++) {
        const seconds =
          totalFrames(
            speechSpans(words.slice(0, index + 1), asset.duration, pace),
            fps,
          ) / fps;
        const boundary =
          /[.!?]["'”)]?$/.test(words[index].text) ||
          (index + 1 < words.length &&
            words[index + 1].start - words[index].end > 0.75);
        if (seconds <= requested) {
          lastWord = index;
          if (boundary) lastSentence = index;
        }
        if (boundary && seconds <= 90 && sentenceInNinety < 0)
          sentenceInNinety = index;
        if (seconds > (options.targetSeconds ? requested : 90)) break;
      }
      // Prefer a complete sentence. A long first sentence may use the optional
      // 90-second ceiling rather than cutting it simply to hit one minute.
      if (lastSentence >= 0) chosen = words.slice(0, lastSentence + 1);
      else if (!options.targetSeconds && sentenceInNinety >= 0)
        chosen = words.slice(0, sentenceInNinety + 1);
      else if (lastWord >= 0) {
        chosen = words.slice(0, lastWord + 1);
        warnings.push(
          "No complete sentence boundary fit the target. The edit ends after a whole transcribed word; review the final thought.",
        );
      } else
        throw Error(
          "No complete spoken word fits this target. Choose a longer Reel.",
        );
    }
    sources = sourcesFor(asset, chosen, fps, pace);
    const seconds = sources.reduce(
      (sum, item) =>
        sum +
        frameLength({ start: item.sourceIn!, end: item.sourceOut! }, fps) / fps,
      0,
    );
    targetSeconds =
      options.targetSeconds ??
      ([15, 30, 60, 90].find(
        (value) => value >= seconds,
      ) as AutoReelAnalysis["targetSeconds"]);
    const retained = sources.reduce(
      (sum, source) => sum + (source.sourceOut! - source.sourceIn!),
      0,
    );
    const removedPauses = Math.max(
      0,
      sources.at(-1)!.sourceOut! - sources[0].sourceIn! - retained,
    );
    if (removedPauses > 0.5)
      warnings.push(
        `Removed ${removedPauses.toFixed(1)} seconds of long pauses with small speech handles.`,
      );
    if (chosen.length < words.length)
      warnings.push(
        "The Reel uses the opening speech that fits the target. The rest of the source remains in your media library.",
      );
  }
  const outputWords = asset.hasAudio ? mappedWords(asset, sources, fps) : [];
  const durationSeconds = sources.reduce(
    (sum, source) =>
      sum +
      Math.floor((source.sourceOut! - source.sourceIn!) * fps + 1e-7) / fps,
    0,
  );
  const opening: string[] = [];
  for (const word of outputWords) {
    if (
      opening.join(" ").length + word.text.length > 96 ||
      opening.length >= 12
    )
      break;
    opening.push(word.text);
    if (/[.!?]["'”)]?$/.test(word.text) || word.start > 4) break;
  }
  const beats = makeBeats(outputWords, durationSeconds);
  if (outputWords.length && !beats.length)
    warnings.push(
      "No concrete transcript topic produced a useful B-roll beat. The original footage will carry the story.",
    );
  return {
    assetId: asset.id,
    fps,
    sources,
    targetSeconds,
    durationSeconds,
    style,
    format,
    hook: opening.join(" "),
    beats,
    speechRanges: mergeSpeechRanges(outputWords),
    warnings,
  };
}

/** The music bed dips under speech; audio.duck shares this curve. */
function volumeKeys(
  clip: Clip,
  ranges: AutoReelAnalysis["speechRanges"],
  fps: number,
): Clip["keyframes"] {
  const ramp = Math.max(1, Math.round(fps * 0.2));
  return duckingKeys(
    clip.duration,
    ranges.map((range) => ({
      start: Math.floor(range.startSeconds * fps),
      end: Math.ceil(range.endSeconds * fps),
    })),
    { level: 0.18, ducked: 0.075, attack: ramp, release: ramp },
  );
}

function brollTrack(project: Project, commands: Command[]): string {
  // Only an empty video track below every text track is reused: full-screen
  // B-roll above the captions would hide them.
  const lastText = project.tracks.reduce(
    (last, track, index) => (track.kind === "text" ? index : last),
    -1,
  );
  const free = project.tracks.find(
    (track, index) =>
      index > lastText &&
      track.kind === "video" &&
      !project.clips.some((clip) => clip.trackId === track.id),
  );
  const track: Track = {
    id: free?.id ?? uid(),
    name: "Auto Reel · matched B-roll",
    kind: "video",
    muted: true,
    hidden: false,
  };
  if (!free && project.tracks.length >= 64)
    throw Error("No spare layer is available for matched B-roll.");
  if (free) {
    commands.push({
      type: "track.update",
      id: free.id,
      patch: { name: track.name, kind: "video", muted: true, hidden: false },
    });
    const target = project.tracks.findIndex(
      (item) =>
        item.kind === "video" &&
        project.clips.some((clip) => clip.trackId === item.id),
    );
    let index = project.tracks.findIndex((item) => item.id === free.id);
    while (index > target && target >= 0) {
      commands.push({ type: "track.move", id: free.id, direction: "up" });
      index--;
    }
  } else commands.push({ type: "track.add", track });
  return track.id;
}

/** Build one Undo transaction; stock placements must match actual analysis beats. */
export function finalizeAutoReelPlan(
  project: Project,
  analysis: AutoReelAnalysis,
  placements: AutoReelPlacement[] = [],
  musicAssetId?: string,
  requested: {
    broll?: boolean;
    music?: boolean;
    openingTitle?: boolean;
    captionStyle?: Clip["captionStyle"];
    beats?: ReelBeat[];
  } = {},
): ReelPlan {
  if (project.fps !== analysis.fps)
    throw Error(
      "The project frame rate changed. Analyze this video again to keep cuts and captions aligned.",
    );
  const asset = project.assets.find((item) => item.id === analysis.assetId);
  if (!asset || asset.kind !== "video")
    throw Error("The analyzed video is no longer in the project.");
  const useBroll = requested.broll ?? !isCreatorShortFormat(analysis.format);
  const useMusic = requested.music ?? !isCreatorShortFormat(analysis.format);
  const bedId = useMusic ? musicAssetId : undefined;
  const plan = createReelPlan(project, {
    sources: analysis.sources,
    targetSeconds: analysis.targetSeconds,
    mode: "replace",
    style: analysis.style,
    format: analysis.format,
    captionStyle: requested.captionStyle,
    beats: requested.beats,
    hook: requested.openingTitle === false ? "" : analysis.hook,
    captions: true,
    musicAssetId: bedId,
    musicVolume: 0.18,
  });
  const warnings = [
    ...analysis.warnings.filter(
      (warning) =>
        useBroll || !warning.startsWith("No concrete transcript topic"),
    ),
    ...plan.warnings.filter(
      (warning) => !warning.startsWith("The selected footage makes"),
    ),
  ];
  const commands = structuredClone(plan.commands),
    fps = project.fps;
  for (const command of commands)
    if (command.type === "clip.add") {
      const clip = command.clip;
      if (clip.kind === "video" && clip.assetId === asset.id) {
        const last = clip.duration - 1;
        // One slow push spans the entire edit, so removing a pause does not
        // restart the camera or create a new zoom jump at every speech cut.
        const scaleAt = (frame: number) =>
          1 +
          0.025 *
            Math.min(
              1,
              Math.max(0, frame / Math.max(1, plan.durationFrames - 1)),
            );
        clip.cameraMotion = "none";
        clip.effectAmount =
          analysis.style === "bold"
            ? 0.35
            : analysis.style === "cinematic"
              ? 0.5
              : 0;
        clip.overlay = analysis.style === "cinematic" ? "film-grain" : "none";
        clip.overlayAmount = analysis.style === "cinematic" ? 0.1 : 0;
        if (
          analysis.format !== "creator-education" &&
          analysis.format !== "talking-head" &&
          !isCreatorShortFormat(analysis.format)
        ) {
          clip.keyframes = [
            {
              property: "scale",
              frame: 0,
              value: scaleAt(clip.start),
              easing: "linear",
            },
          ];
          if (last > 0)
            clip.keyframes.push({
              property: "scale",
              frame: last,
              value: scaleAt(clip.start + last),
              easing: "linear",
            });
        }
      }
      if (clip.kind === "audio" && clip.assetId === bedId)
        clip.keyframes = volumeKeys(clip, analysis.speechRanges, fps);
    }
  if (isCreatorShortFormat(analysis.format) && requested.beats?.length !== 0)
    creatorShortCutReframes(
      commands.flatMap((command) =>
        command.type === "clip.add" &&
        command.clip.kind === "video" &&
        command.clip.assetId === asset.id
          ? [command.clip]
          : [],
      ),
      fps,
    );
  const validPlacements = (useBroll ? placements : [])
    .filter((placement) => {
      const valid =
        Number.isFinite(placement.startSeconds) &&
        Number.isFinite(placement.durationSeconds) &&
        placement.durationSeconds > 0 &&
        analysis.beats.some(
          (beat) =>
            beat.query === placement.query &&
            Math.abs(beat.startSeconds - placement.startSeconds) <= 1 / fps &&
            placement.durationSeconds <= beat.durationSeconds + 1 / fps,
        );
      if (!valid)
        warnings.push(
          "Skipped a stock placement that did not match a transcript beat.",
        );
      return valid;
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);
  let brollCount = 0,
    lastEnd = 0;
  if (validPlacements.length) {
    const current = applyCommands(project, {
      projectId: project.id,
      revision: project.revision,
      label: plan.label,
      commands,
    });
    const trackId = brollTrack(current, commands);
    for (const placement of validPlacements) {
      const stock = project.assets.find(
        (item) => item.id === placement.assetId,
      );
      if (!stock || stock.kind === "audio" || stock.id === asset.id) {
        warnings.push(
          `Skipped unavailable matched B-roll for “${placement.query}”.`,
        );
        continue;
      }
      let start = Math.max(0, Math.round(placement.startSeconds * fps));
      let frames = Math.min(
        Math.floor(placement.durationSeconds * fps),
        plan.durationFrames - start,
        stock.kind === "image"
          ? Infinity
          : Math.floor(stock.duration * fps + 1e-7),
      );
      if (analysis.format === "creator-education") {
        const cardIds = new Set(
          current.motions
            .filter((motion) => motion.source === "reel:creator-education")
            .map((motion) => motion.id),
        );
        const cards = current.clips.filter(
          (clip) => clip.motionId && cardIds.has(clip.motionId),
        );
        const window = creatorBrollWindow(start, frames, cards);
        start = window.start;
        frames = window.frames;
      }
      if (start < lastEnd || frames < Math.round(fps * 0.5)) {
        warnings.push(
          `Skipped a too-short or overlapping B-roll beat for “${placement.query}”.`,
        );
        continue;
      }
      const clip: Clip = {
        ...makeClip(current, stock.kind, trackId, start, stock),
        duration: frames,
        sourceIn: 0,
        volume: 0,
        fadeIn: overlayFadeFrames(frames, fps),
        fadeOut: overlayFadeFrames(frames, fps),
        look:
          analysis.style === "cinematic"
            ? "cinematic"
            : analysis.style === "bold"
              ? "vivid"
              : "none",
        effectAmount:
          analysis.style === "cinematic"
            ? 0.5
            : analysis.style === "bold"
              ? 0.35
              : 0,
        overlay: analysis.style === "cinematic" ? "film-grain" : "none",
        overlayAmount: analysis.style === "cinematic" ? 0.1 : 0,
        cameraMotion: "none",
        keyframes:
          stock.kind === "image"
            ? [
                {
                  property: "scale",
                  frame: 0,
                  value: 1,
                  easing: "ease-in-out",
                },
                {
                  property: "scale",
                  frame: frames - 1,
                  value: 1.035,
                  easing: "ease-in-out",
                },
              ]
            : [],
        ...(analysis.format === "creator-education"
          ? creatorBrollPlacement(current)
          : {}),
      };
      commands.push({ type: "clip.add", clip });
      lastEnd = start + frames;
      brollCount++;
    }
  }
  if (useBroll && analysis.beats.length && !brollCount)
    warnings.push(
      "No relevant stock match was available. Your original footage stays in place; no unrelated B-roll was inserted.",
    );
  if (useMusic && !bedId)
    warnings.push(
      "No music bed was available. The original source audio is preserved.",
    );
  const label = "Auto edit Reel";
  applyCommands(project, {
    projectId: project.id,
    revision: project.revision,
    label,
    commands,
  });
  return {
    ...plan,
    commands,
    label,
    brollCount,
    warnings: [...new Set(warnings)],
  };
}
