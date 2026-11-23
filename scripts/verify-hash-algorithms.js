/* eslint-disable */
// Node-side validation of the hashing algorithms shipped to the browser worker.
// Run with: node scripts/verify-hash-algorithms.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../public/workers/duplicate-hash.js"), "utf8");
const body = src.split("self.onmessage")[0];
const fns = new Function(body + "; return { averageHash, differenceHash, perceptualHash };")();

function makeImage(fn) {
  const px = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const i = (y * 32 + x) * 4;
      const [r, g, b] = fn(x, y);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px.buffer;
}

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// A structured, photo-like fixture: soft blobs over a mid-tone background.
// Pure gradients are a degenerate case for DCT hashing, so we use something
// with real spatial structure instead.
function blobPattern(brightness = 0, scale = 1) {
  return makeImage((x, y) => {
    const sx = (x - 16) * scale;
    const sy = (y - 16) * scale;
    const d1 = Math.sqrt(sx * sx + sy * sy);
    const d2 = Math.sqrt((sx - 7) ** 2 + (sy + 5) ** 2);
    const d3 = Math.sqrt((sx + 8) ** 2 + (sy - 6) ** 2);
    const value =
      128 + brightness + 60 * Math.exp(-d1 / 6) - 45 * Math.exp(-d2 / 5) + 30 * Math.exp(-d3 / 4);
    return [Math.min(255, Math.max(0, value)), Math.min(255, Math.max(0, value * 0.92 + 10)), Math.min(255, Math.max(0, value * 0.8 + 25))];
  });
}

const reference = blobPattern(0, 1);
const identical = blobPattern(0, 1);
const brightened = blobPattern(18, 1); // no clipping at +18
const rescaled = blobPattern(0, 0.8); // 25% zoom change
const noise = makeImage(() => [
  Math.floor(Math.random() * 255),
  Math.floor(Math.random() * 255),
  Math.floor(Math.random() * 255),
]);
const different = makeImage((x, y) => {
  const stripes = Math.sin((x * 8 * Math.PI) / 32) > 0 ? 240 : 20;
  const grid = (x + y) % 8 === 0 ? 30 : 0;
  return [Math.min(255, stripes - grid), 90, 40];
});

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail });
}

const a1 = fns.averageHash(reference, 32, 32);
const p1 = fns.perceptualHash(reference, 32, 32);
const d1 = fns.differenceHash(reference, 32, 32);

check("hashes are 64-bit hex strings", a1.length === 16 && p1.length === 16 && d1.length === 16, {
  ahash: a1.length,
  phash: p1.length,
  dhash: d1.length,
});

check(
  "identical pixels produce identical hashes",
  a1 === fns.averageHash(identical, 32, 32) &&
    p1 === fns.perceptualHash(identical, 32, 32) &&
    d1 === fns.differenceHash(identical, 32, 32),
  {},
);

const noiseDistances = {
  ahash: ham(a1, fns.averageHash(noise, 32, 32)),
  dhash: ham(d1, fns.differenceHash(noise, 32, 32)),
  phash: ham(p1, fns.perceptualHash(noise, 32, 32)),
};
check(
  "unrelated images score far apart",
  noiseDistances.phash > 20 && noiseDistances.dhash > 20,
  noiseDistances,
);

const brightDistance = ham(p1, fns.perceptualHash(brightened, 32, 32));
check("brightness shift stays visually similar (pHash)", brightDistance <= 6, { distance: brightDistance });

const scaledDistance = ham(p1, fns.perceptualHash(rescaled, 32, 32));
// A 25% zoom genuinely changes framing, so we assert it lands in the "similar"
// band rather than the "very similar" band — that is what users should expect.
check("25% zoom lands in the similar band (pHash)", scaledDistance <= 24, {
  distance: scaledDistance,
  similarity: `${Math.round(((64 - scaledDistance) / 64) * 100)}%`,
});

const differentDistance = ham(p1, fns.perceptualHash(different, 32, 32));
check("a different image scores far away (pHash)", differentDistance >= 22, { distance: differentDistance });

const formatChangeDistance = ham(p1, fns.perceptualHash(brightened, 32, 32));
check("brightness-only change is under the 95% threshold", formatChangeDistance / 64 <= 0.05, { distance: formatChangeDistance });

let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`  ok   ${result.name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${result.name}`, JSON.stringify(result.detail));
  }
}
console.log(`\n${results.length - failures}/${results.length} hash checks passed`);
process.exit(failures === 0 ? 0 : 1);
