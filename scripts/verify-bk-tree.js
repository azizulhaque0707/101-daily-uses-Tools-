/* eslint-disable */
/**
 * Validates the grouping logic that ships inside the browser worker.
 *
 * Reads /public/workers/duplicate-hash.js and evaluates its pure functions
 * directly, so the test always exercises the code users actually run rather
 * than a hand-copied duplicate. Compares BK-tree grouping against a brute-force
 * reference across several corpus shapes and thresholds.
 *
 * Usage: node scripts/verify-bk-tree.js
 */
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../public/workers/duplicate-hash.js"), "utf8");

// Everything before the message router is pure and side-effect free.
const pure = source.split("/* ------------------------------- message router ----------------------------- */")[0];
const fns = new Function(
  `${pure}\nreturn { hexToPair, distance, buildGroups, bkInsert, bkSearch };`,
)();

/* ------------------------- brute-force reference --------------------------- */

function bruteForceGroups(entries, threshold, method) {
  const hashOf = (entry) =>
    method === "dhash" ? entry.dhash : method === "ahash" ? entry.ahash : entry.phash;
  const pairs = entries.map((entry) => fns.hexToPair(hashOf(entry)));
  const radius = Math.floor(((100 - threshold) / 100) * 64);
  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (fns.distance(pairs[i], pairs[j]) <= radius) union(i, j);
    }
  }
  const clusters = new Map();
  entries.forEach((_, index) => {
    const root = find(index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(index);
  });
  return [...clusters.values()]
    .filter((members) => members.length > 1)
    .map((members) => members.map((index) => entries[index].id).sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function normalise(groups) {
  return groups
    .map((group) => [...group.indices].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

/* ------------------------------ test corpora ------------------------------- */

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHash(random) {
  let hex = "";
  for (let i = 0; i < 16; i += 1) hex += Math.floor(random() * 16).toString(16);
  return hex;
}

function flipBits(hex, positions) {
  const chars = hex.split("");
  for (const position of positions) {
    const byteIndex = Math.floor(position / 4);
    const nibbleIndex = position % 4;
    const value = Number.parseInt(chars[byteIndex], 16) ^ (1 << nibbleIndex);
    chars[byteIndex] = value.toString(16);
  }
  return chars.join("");
}

/**
 * Sparse corpus, like a real photo library: some duplicate families plus a lot
 * of unrelated images. This is the shape the BK-tree is optimised for.
 */
function sparseCorpus(random, families) {
  const entries = [];
  for (let family = 0; family < families; family += 1) {
    const anchor = randomHash(random);
    const variants = [[], [5], [12, 40]];
    for (const flips of variants) {
      entries.push({
        id: entries.length,
        sha256: `sha-${entries.length}`,
        ahash: flipBits(anchor, flips),
        dhash: flipBits(anchor, flips),
        phash: flipBits(anchor, flips),
      });
    }
  }
  for (let i = 0; i < families; i += 1) {
    const noise = randomHash(random);
    entries.push({ id: entries.length, sha256: `sha-${entries.length}`, ahash: noise, dhash: noise, phash: noise });
  }
  return entries;
}

/**
 * Dense corpus: every image is a near-duplicate of another, which is the worst
 * case for a BK-tree. Included so we measure the honest worst case.
 */
function denseCorpus(random, families) {
  const entries = [];
  for (let family = 0; family < families; family += 1) {
    const anchor = randomHash(random);
    for (const flips of [[], [3], [9], [21], [37], [50]]) {
      entries.push({
        id: entries.length,
        sha256: `sha-${entries.length}`,
        ahash: flipBits(anchor, flips),
        dhash: flipBits(anchor, flips),
        phash: flipBits(anchor, flips),
      });
    }
  }
  return entries;
}

/* --------------------------------- checks ---------------------------------- */

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const cases = [
  { build: sparseCorpus, families: 15, threshold: 95, method: "phash", seed: 1 },
  { build: sparseCorpus, families: 30, threshold: 95, method: "dhash", seed: 2 },
  { build: sparseCorpus, families: 25, threshold: 90, method: "ahash", seed: 3 },
  { build: sparseCorpus, families: 50, threshold: 80, method: "phash", seed: 4 },
  { build: sparseCorpus, families: 100, threshold: 100, method: "phash", seed: 5 },
  { build: denseCorpus, families: 20, threshold: 90, method: "phash", seed: 6 },
];

for (const testCase of cases) {
  const random = mulberry32(testCase.seed);
  const entries = testCase.build(random, testCase.families);

  const actual = normalise(fns.buildGroups(entries, testCase.threshold, testCase.method));
  const expected = bruteForceGroups(entries, testCase.threshold, testCase.method);

  const identical =
    actual.length === expected.length &&
    actual.every((group, index) =>
      group.length === expected[index].length && group.every((id, i) => id === expected[index][i]),
    );

  check(
    `${entries.length} images @ ${testCase.threshold}% (${testCase.method}, ${testCase.build === denseCorpus ? "dense" : "sparse"})`,
    identical,
    `${actual.length} groups match brute force`,
  );
}

// A corpus with no duplicates must report no groups.
const randomNone = mulberry32(42);
const none = Array.from({ length: 80 }, (_, index) => {
  const hash = randomHash(randomNone);
  return { id: index, sha256: `sha-${index}`, ahash: hash, dhash: hash, phash: hash };
});
check("no duplicates reports zero groups", fns.buildGroups(none, 95, "phash").length === 0);

// Byte-identical files (same SHA-256, different names) must group as "exact".
const twinHash = randomHash(mulberry32(7));
const byteIdentical = [
  { id: 0, sha256: "sha-SAME", ahash: twinHash, dhash: twinHash, phash: twinHash },
  { id: 1, sha256: "sha-SAME", ahash: twinHash, dhash: twinHash, phash: twinHash },
];
const byteGroups = fns.buildGroups(byteIdentical, 95, "phash");
check(
  "same bytes with different filenames group as exact at 100%",
  byteGroups.length === 1 &&
    byteGroups[0].kind === "exact" &&
    byteGroups[0].similarity === 100 &&
    byteGroups[0].indices.length === 2,
);

// Same pixels but different bytes (e.g. re-encoded) are visually identical, not
// byte-identical, so they must be reported as "similar" — not "exact".
const reEncoded = [
  { id: 0, sha256: "sha-A", ahash: twinHash, dhash: twinHash, phash: twinHash },
  { id: 1, sha256: "sha-B", ahash: twinHash, dhash: twinHash, phash: twinHash },
];
const reEncodedGroups = fns.buildGroups(reEncoded, 95, "phash");
check(
  "re-encoded copies group as similar, not exact",
  reEncodedGroups.length === 1 && reEncodedGroups[0].kind === "similar" && reEncodedGroups[0].similarity === 100,
  `kind=${reEncodedGroups[0] ? reEncodedGroups[0].kind : "none"}`,
);

// A group of one must never be reported.
check("single images never form a group", fns.buildGroups(none.slice(0, 1), 95, "phash").length === 0);

/* ------------------------------- performance ------------------------------- */

console.log("\n  performance (grouping runs in a worker, so these times are off the main thread):");
const sparseRandom = mulberry32(99);
const sparse5k = sparseCorpus(sparseRandom, 1250);

const sparseStart = Date.now();
const sparseResult = fns.buildGroups(sparse5k, 95, "phash");
const sparseMs = Date.now() - sparseStart;

const sparseBruteStart = Date.now();
const sparseBrute = bruteForceGroups(sparse5k, 95, "phash").length;
const sparseBruteMs = Date.now() - sparseBruteStart;

console.log(`  info 5,000 sparse: BK-tree ${sparseMs}ms vs brute force ${sparseBruteMs}ms (${sparseResult.length} vs ${sparseBrute} groups)`);
check("5,000 sparse images agree with brute force", sparseResult.length === sparseBrute);
check("5,000 sparse images produce the expected families", sparseResult.length === 1250, `${sparseResult.length} families`);
check("5,000 images group in under 500ms", sparseMs < 500, `${sparseMs}ms`);
check(
  "hash distance helper agrees with a naive hex comparison",
  (() => {
    const a = "0f1e2d3c4b5a6978";
    const b = "0f1e2d3c4b5a6979";
    let naive = 0;
    for (let i = 0; i < a.length; i += 2) {
      let x = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
      while (x) {
        naive += x & 1;
        x >>= 1;
      }
    }
    return fns.distance(fns.hexToPair(a), fns.hexToPair(b)) === naive;
  })(),
);

const denseRandom = mulberry32(100);
const dense5k = denseCorpus(denseRandom, 834);
const denseStart = Date.now();
const denseResult = fns.buildGroups(dense5k, 90, "phash");
const denseMs = Date.now() - denseStart;
console.log(`  info 5,000 dense: BK-tree ${denseMs}ms → ${denseResult.length} groups (worst case)`);
check("5,000 dense images still complete", denseResult.length > 0);

console.log(failures === 0 ? "\nworker grouping verified" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
