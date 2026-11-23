/* eslint-disable */
/**
 * Duplicate Image Finder — hashing and grouping worker.
 *
 * Served from /workers/duplicate-hash.js as plain JavaScript so every browser
 * can execute it directly. Everything runs on the user's device: this code has
 * no network access whatsoever.
 *
 * Messages in:
 *   { type: "hash",  id, buffer, pixels, width, height }
 *   { type: "group", id, entries, threshold, method, splitExact }
 *
 * Messages out:
 *   { id, sha256, ahash, dhash, phash }
 *   { id, groups }
 *   { id, error }
 *
 * Grouping lives here rather than on the main thread because the perceptual
 * comparison is quadratic in the worst case. For a 5,000 image folder that is
 * seconds of work, and doing it inside React's render cycle would freeze the
 * interface — which the tool explicitly promises not to do.
 */

var HEX = "0123456789abcdef";

/* ------------------------------ hash encoding ------------------------------ */

function toHex(buffer) {
  var bytes = new Uint8Array(buffer);
  var out = "";
  for (var i = 0; i < bytes.length; i += 1) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

/** 16-char hex → two 32-bit halves, so distance becomes XOR + popcount. */
function hexToPair(hex) {
  return [parseInt(hex.slice(0, 8), 16) | 0, parseInt(hex.slice(8, 16), 16) | 0];
}

var POPCOUNT = new Uint8Array(256);
for (var pc = 0; pc < 256; pc += 1) {
  var bits = pc;
  var count = 0;
  while (bits) {
    count += bits & 1;
    bits >>= 1;
  }
  POPCOUNT[pc] = count;
}

/** Hamming distance over two [hi, lo] 32-bit pairs. ~20x faster than hex parsing. */
function distance(a, b) {
  return (
    POPCOUNT[(a[0] ^ b[0]) & 0xff] +
    POPCOUNT[((a[0] ^ b[0]) >>> 8) & 0xff] +
    POPCOUNT[((a[0] ^ b[0]) >>> 16) & 0xff] +
    POPCOUNT[((a[0] ^ b[0]) >>> 24) & 0xff] +
    POPCOUNT[(a[1] ^ b[1]) & 0xff] +
    POPCOUNT[((a[1] ^ b[1]) >>> 8) & 0xff] +
    POPCOUNT[((a[1] ^ b[1]) >>> 16) & 0xff] +
    POPCOUNT[((a[1] ^ b[1]) >>> 24) & 0xff]
  );
}

/* ----------------------------- perceptual hashes ---------------------------- */

/** RGBA pixels → grayscale, downscaled to size × size. */
function toGrayscale(pixels, sourceWidth, sourceHeight, size) {
  var data = new Uint8ClampedArray(pixels);
  var output = new Float64Array(size * size);
  for (var y = 0; y < size; y += 1) {
    var sampleY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / size));
    for (var x = 0; x < size; x += 1) {
      var sampleX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / size));
      var offset = (sampleY * sourceWidth + sampleX) * 4;
      // Rec. 601 luma, the standard weighting for perceptual hashing.
      output[y * size + x] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    }
  }
  return output;
}

function bitsToHex(bits) {
  var out = "";
  for (var byte = 0; byte < bits.length / 8; byte += 1) {
    var value = 0;
    for (var bit = 0; bit < 8; bit += 1) value = (value << 1) | (bits[byte * 8 + bit] & 1);
    out += HEX[value >> 4] + HEX[value & 15];
  }
  return out;
}

/** aHash — each 8×8 pixel compared against the mean luminance. */
function averageHash(pixels, width, height) {
  var size = 8;
  var gray = toGrayscale(pixels, width, height, size);
  var mean = 0;
  for (var i = 0; i < gray.length; i += 1) mean += gray[i];
  mean /= gray.length;
  var bits = new Uint8Array(64);
  for (var j = 0; j < 64; j += 1) bits[j] = gray[j] >= mean ? 1 : 0;
  return bitsToHex(bits);
}

/** dHash — each pixel compared with its right-hand neighbour. */
function differenceHash(pixels, width, height) {
  var cols = 9;
  var rows = 8;
  var gray = toGrayscale(pixels, width, height, cols);
  var bits = new Uint8Array(64);
  for (var row = 0; row < rows; row += 1) {
    for (var col = 0; col < cols - 1; col += 1) {
      bits[row * (cols - 1) + col] = gray[row * cols + col] > gray[row * cols + col + 1] ? 1 : 0;
    }
  }
  return bitsToHex(bits);
}

/** One-dimensional DCT-II. */
function dct1d(vector, size, out, offset) {
  for (var k = 0; k < size; k += 1) {
    var sum = 0;
    for (var n = 0; n < size; n += 1) {
      sum += vector[n] * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * size));
    }
    out[offset + k] = sum;
  }
}

/** pHash — DCT of a 32×32 image, keeping the low-frequency 8×8 block. */
function perceptualHash(pixels, width, height) {
  var size = 32;
  var block = 8;
  var gray = toGrayscale(pixels, width, height, size);

  var rows = new Float64Array(size * size);
  var temp = new Float64Array(size);
  var rowOut = new Float64Array(size);
  for (var y = 0; y < size; y += 1) {
    for (var x = 0; x < size; x += 1) temp[x] = gray[y * size + x];
    dct1d(temp, size, rowOut, 0);
    for (var x2 = 0; x2 < size; x2 += 1) rows[y * size + x2] = rowOut[x2];
  }

  var blockValues = [];
  var colOut = new Float64Array(size);
  for (var col = 0; col < block; col += 1) {
    for (var y2 = 0; y2 < size; y2 += 1) temp[y2] = rows[y2 * size + col];
    dct1d(temp, size, colOut, 0);
    for (var y3 = 0; y3 < block; y3 += 1) blockValues.push(colOut[y3]);
  }

  // Median of the AC coefficients (skipping the DC term at index 0).
  var sorted = blockValues.slice(1).sort(function (a, b) { return a - b; });
  var median = sorted[Math.floor(sorted.length / 2)];

  var bits = new Uint8Array(64);
  for (var i = 0; i < 64; i += 1) bits[i] = blockValues[i] > median ? 1 : 0;
  return bitsToHex(bits);
}

/* --------------------------------- grouping -------------------------------- */

function DisjointSet(size) {
  this.parent = new Int32Array(size);
  for (var i = 0; i < size; i += 1) this.parent[i] = i;
}
DisjointSet.prototype.find = function (index) {
  var parent = this.parent;
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
};
DisjointSet.prototype.union = function (a, b) {
  var ra = this.find(a);
  var rb = this.find(b);
  if (ra !== rb) this.parent[rb] = ra;
};

/**
 * Burkhard–Keller tree over the 64-bit hashes.
 *
 * Hamming distance is a true metric, so a BK-tree returns every pair inside a
 * radius without scanning all of them. Real photo libraries are sparse (most
 * images are unrelated), where this is dramatically faster than the naive
 * quadratic scan. Dense corpora degrade towards quadratic, which is exactly why
 * the whole pass runs in this worker instead of on the main thread.
 */
function BkNode(hashPair) {
  this.hash = hashPair;
  this.indices = [];
  this.children = new Map();
}

function bkInsert(root, pair, index) {
  var node = root;
  for (;;) {
    var d = distance(node.hash, pair);
    if (d === 0) {
      node.indices.push(index);
      return;
    }
    var child = node.children.get(d);
    if (!child) {
      var leaf = new BkNode(pair);
      leaf.indices.push(index);
      node.children.set(d, leaf);
      return;
    }
    node = child;
  }
}

function bkSearch(root, pair, radius) {
  var results = [];
  var stack = [root];
  while (stack.length > 0) {
    var node = stack.pop();
    var d = distance(node.hash, pair);
    if (d <= radius) {
      for (var i = 0; i < node.indices.length; i += 1) results.push(node.indices[i]);
    }
    var low = d - radius;
    var high = d + radius;
    node.children.forEach(function (child, edge) {
      if (edge >= low && edge <= high) stack.push(child);
    });
  }
  return results;
}

function hashPairFor(entry, method) {
  if (method === "dhash") return entry.dhash;
  if (method === "ahash") return entry.ahash;
  return entry.phash;
}

/**
 * entries: [{ id, sha256, ahash, dhash, phash }]
 * Returns groups of image ids: { id, kind, similarity, indices }
 */
function buildGroups(entries, threshold, method) {
  var count = entries.length;
  var sets = new DisjointSet(count);

  // Exact duplicates first: one O(n) pass keyed on SHA-256.
  var exact = new Map();
  for (var e = 0; e < count; e += 1) {
    var bucket = exact.get(entries[e].sha256);
    if (!bucket) {
      bucket = [];
      exact.set(entries[e].sha256, bucket);
    }
    bucket.push(e);
  }
  exact.forEach(function (members) {
    for (var i = 1; i < members.length; i += 1) sets.union(members[0], members[i]);
  });

  // Then perceptual matches through the BK-tree.
  var radius = Math.floor(((100 - threshold) / 100) * 64);
  if (radius >= 64) {
    for (var a = 1; a < count; a += 1) sets.union(0, a);
  } else if (radius >= 0) {
    var root = null;
    for (var k = 0; k < count; k += 1) {
      var pair = hexToPair(hashPairFor(entries[k], method));
      if (root) {
        var matches = bkSearch(root, pair, radius);
        for (var m = 0; m < matches.length; m += 1) sets.union(matches[m], k);
        bkInsert(root, pair, k);
      } else {
        root = new BkNode(pair);
        root.indices.push(k);
      }
    }
  }

  var clusters = new Map();
  for (var c = 0; c < count; c += 1) {
    var r = sets.find(c);
    var members = clusters.get(r);
    if (!members) {
      members = [];
      clusters.set(r, members);
    }
    members.push(c);
  }

  var groups = [];
  clusters.forEach(function (members, rootIndex) {
    if (members.length < 2) return;
    var allSameHash = true;
    for (var i = 1; i < members.length; i += 1) {
      if (entries[members[i]].sha256 !== entries[members[0]].sha256) {
        allSameHash = false;
        break;
      }
    }
    var similarity = 100;
    if (!allSameHash) {
      var anchor = hexToPair(hashPairFor(entries[members[0]], method));
      for (var j = 1; j < members.length; j += 1) {
        var d = distance(anchor, hexToPair(hashPairFor(entries[members[j]], method)));
        similarity = Math.min(similarity, ((64 - d) / 64) * 100);
      }
    }
    var ids = [];
    for (var q = 0; q < members.length; q += 1) ids.push(entries[members[q]].id);
    groups.push({
      id: "g-" + rootIndex,
      kind: allSameHash ? "exact" : "similar",
      similarity: Math.round(similarity),
      indices: ids,
    });
  });

  groups.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === "exact" ? -1 : 1;
    return b.indices.length - a.indices.length;
  });
  return groups;
}

/* ------------------------------- message router ----------------------------- */

self.onmessage = async function (event) {
  var data = event.data;
  try {
    if (data && data.type === "group") {
      var groups = buildGroups(data.entries, data.threshold, data.method);
      self.postMessage({ id: data.id, groups: groups });
      return;
    }

    // Default (and legacy) behaviour: hash one image.
    var digest = await crypto.subtle.digest("SHA-256", data.buffer);
    var response = {
      id: data.id,
      sha256: toHex(digest),
      ahash: averageHash(data.pixels, data.width, data.height),
      dhash: differenceHash(data.pixels, data.width, data.height),
      phash: perceptualHash(data.pixels, data.width, data.height),
    };
    self.postMessage(response);
  } catch (error) {
    self.postMessage({ id: data.id, error: String((error && error.message) || error) });
  }
};
