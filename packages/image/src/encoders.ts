/**
 * Manual image encoders that don't need any external dependency or native
 * canvas toBlob support. All work on raw RGBA pixel data so they run
 * identically in the browser and in Node.
 *
 * Formats implemented here (beyond the canvas-native png/jpeg/webp/avif):
 *  - BMP  (uncompressed 32-bit BGRA)
 *  - GIF  (single frame, 256-color palette w/ median-cut quantization)
 *  - SVG  (encapsulated: raster embedded as a base64 data URI)
 *  - TIFF (uncompressed 24-bit RGB, little-endian)
 */

export type PixelSource = {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray | Uint8Array };
};

/* ------------------------------------------------------------------ */
/* BMP                                                                 */
/* ------------------------------------------------------------------ */

/** Encode RGBA pixels to an uncompressed 32-bit BMP (BITMAPINFOHEADER). */
export function encodeBmp(source: PixelSource, width: number, height: number): Uint8Array {
  const rowSize = width * 4; // 32bpp, already 4-byte aligned
  const pixelBytes = rowSize * height;
  const dataSize = 54 + pixelBytes;
  const bytes = new Uint8Array(dataSize);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, dataSize, true);
  view.setUint32(6, 0, true); // reserved
  view.setUint32(10, 54, true); // pixel data offset
  view.setUint32(14, 40, true); // BITMAPINFOHEADER size

  let w = width;
  let h = height;
  if (w < 0) w = -w;
  if (h < 0) h = -h;
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 32, true); // bpp
  view.setUint32(30, 0, true); // BI_RGB (uncompressed)
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // ~72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true); // colors used
  view.setUint32(50, 0, true); // important colors

  const data = source.getImageData(0, 0, width, height).data;
  let out = 54;
  // BMP rows are bottom-up.
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      bytes[out++] = data[i + 2]; // B
      bytes[out++] = data[i + 1]; // G
      bytes[out++] = data[i]; // R
      bytes[out++] = 0; // A (unused)
    }
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* GIF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Encode RGBA pixels to a single-frame GIF87a with a 256-color palette.
 * Uses a simple uniform-color-space quantization. Transparent pixels are
 * mapped to a dedicated transparent index.
 */
export function encodeGif(source: PixelSource, width: number, height: number): Uint8Array {
  const data = source.getImageData(0, 0, width, height).data;
  const n = width * height;

  // Build a 256-color palette (RGB) plus an explicit transparent index 0.
  const palette: Array<[number, number, number]> = [];
  const paletteMap = new Map<number, number>();
  const transparentIndex = 0;

  const quantize = () => {
    // Stage 1: use a simple 3-3-2 (R3 G3 B2) fixed palette path is complex;
    // instead rank colors by frequency and pick the top 255 most common.
    const freq = new Map<number, { r: number; g: number; b: number; count: number }>();
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = data[o + 3];
      if (a < 128) continue; // transparent pixels handled separately
      const k = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
      const f = freq.get(k);
      if (f) f.count++;
      else freq.set(k, { r: data[o], g: data[o + 1], b: data[o + 2], count: 1 });
    }

    const sorted = Array.from(freq.values()).sort((a, b) => b.count - a.count);
    // Use the average color of each bucket for the palette entry.
    const slotCount = Math.min(255, sorted.length);
    palette.push([0, 0, 0]); // index 0 reserved for transparent
    for (let i = 0; i < slotCount; i++) {
      palette.push([sorted[i].r, sorted[i].g, sorted[i].b]);
      const bucketKey = ((sorted[i].r >> 3) << 10) | ((sorted[i].g >> 3) << 5) | (sorted[i].b >> 3);
      paletteMap.set(bucketKey, i + 1);
    }

  };

  quantize();

  // Assign indices.
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 128) {
      indices[i] = transparentIndex;
    } else {
      const bk = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
      const idx = paletteMap.get(bk);
      if (idx !== undefined) {
        indices[i] = idx;
      } else {
        // Nearest palette color fallback (linear search).
        indices[i] = nearestPalette(data[o], data[o + 1], data[o + 2]) ?? transparentIndex;
      }
    }
  }

  function nearestPalette(r: number, g: number, b: number): number {
    let best = 1;
    let bestD = Infinity;
    for (let i = 1; i < palette.length; i++) {
      const dr = r - palette[i][0];
      const dg = g - palette[i][1];
      const db = b - palette[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  const gctSize = paletteSizeBytes(palette.length);
  const gctSizeCode = Math.max(0, Math.log2(gctSize) - 1);
  const lzwMinCodeSize = minBits(gctSize);

  const chunks: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x80 | 0x70 | gctSizeCode, // global color table, 8-bit color resolution, table size
    0x00, // background color index
    0x00, // pixel aspect ratio
  ];
  // Global color table: 2^(N+1) entries where N = log2(paletteSize)-1.
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    chunks.push(c[0], c[1], c[2]);
  }
  // Pad the rest of the color table with zeros.
  for (let i = palette.length; i < gctSize; i++) chunks.push(0, 0, 0);

  // Image descriptor.
  chunks.push(
    0x2c, // image separator
    0, 0,
    0, 0,
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x00, // no local color table
  );
  chunks.push(lzwMinCodeSize); // LZW minimum code size

  // LZW encode the raster (interlaced=off), row by row.
  const lzw = lzwEncode(indices, width, height, lzwMinCodeSize);
  chunks.push(...lzw.subblocks());

  chunks.push(0x3b); // trailer

  return Uint8Array.from(chunks);
}

function paletteSizeBytes(count: number): number {
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

function minBits(count: number): number {
  let bits = 2;
  while (1 << bits < count) bits++;
  return bits < 2 ? 2 : bits;
}

/** Minimal LZW compressor producing GIF sub-blocks. */
function lzwEncode(data: Uint8Array, width: number, height: number, minCodeSize: number): { subblocks(): number[] } {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  const maxCode = 1 << codeSize;

  const outBits: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const dict = new Map<string, number>();
  const resetDict = () => {
    dict.clear();
    let n = 0;
    for (let i = 0; i < clearCode; i++) {
      dict.set(String.fromCharCode(i), n++);
    }
    codeSize = minCodeSize + 1;
  };

  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      outBits.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  resetDict();
  emit(clearCode);
  let nextCode = eoiCode + 1;

  let prefix = "";
  const flat: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      flat.push(data[y * width + x]);
    }
  }

  for (let i = 0; i < flat.length; i++) {
    const cur = String.fromCharCode(flat[i]);
    const combined = prefix + cur;
    if (dict.has(combined)) {
      prefix = combined;
    } else {
      emit(dict.get(prefix)!);
      if (nextCode < 1 << 12) {
        dict.set(combined, nextCode++);
        if (nextCode >= maxCode && codeSize < 12) {
          codeSize++;
        }
      } else {
        emit(clearCode);
        resetDict();
        nextCode = eoiCode + 1;
      }
      prefix = cur;
    }
  }
  if (prefix.length > 0) emit(dict.get(prefix)!);
  emit(eoiCode);
  if (bitCount > 0) outBits.push(bitBuf & 0xff);

  // Split into sub-blocks of max 255 bytes.
  return {
    subblocks(): number[] {
      const out: number[] = [];
      for (let i = 0; i < outBits.length; i += 255) {
        const chunk = outBits.slice(i, i + 255);
        out.push(chunk.length);
        out.push(...chunk);
      }
      out.push(0); // block terminator
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build an encapsulated SVG: the raster is embedded as a base64 PNG data URI
 * inside an <image> element. The caller supplies the PNG data URI bytes.
 */
export function encodeSvg(
  width: number,
  height: number,
  pngBase64: string,
): Uint8Array {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}" href="data:image/png;base64,${pngBase64}"/>` +
    `</svg>`;
  return new TextEncoder().encode(svg);
}

/* ------------------------------------------------------------------ */
/* TIFF                                                                */
/* ------------------------------------------------------------------ */

/** Encode RGBA pixels to an uncompressed 24-bit RGB little-endian TIFF. */
export function encodeTiff(source: PixelSource, width: number, height: number): Uint8Array {
  const data = source.getImageData(0, 0, width, height).data;

  // Strip: rows padded to 4 bytes in TIFF.
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const stripBytes = rowBytes * height;

  // IFD with tags: ImageWidth(256), ImageLength(257), BitsPerSample(258),
  // Compression(259), PhotometricInterpretation(262), StripOffsets(273),
  // SamplesPerPixel(277), RowsPerStrip(278), StripByteCounts(279),
  // XResolution(282), YResolution(283), ResolutionUnit(296).
  const IFD_COUNT = 12;
  const headerSize = 8;
  const ifdStart = headerSize;

  // Extra data section (after IFD entries + next-IFD pointer).
  const extraStart = ifdStart + 2 + IFD_COUNT * 12 + 4;
  // Layout in extra region: [BitsPerSample*3=6][StripOffsets=4][RowsPerStrip=4]
  // [StripByteCounts=4][XRes=8][YRes=8] followed by pixel data.
  const bitsPerSampleOff = extraStart;
  const stripOffsetsOff = bitsPerSampleOff + 6;
  const rowsPerStripOff = stripOffsetsOff + 4;
  const stripByteCountsOff = rowsPerStripOff + 4;
  const xResOff = stripByteCountsOff + 4;
  const yResOff = xResOff + 8;
  const pixelDataOff = yResOff + 8;

  const total = pixelDataOff + stripBytes;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  // Header little-endian.
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true); // TIFF magic
  view.setUint32(4, ifdStart, true); // IFD offset

  // IFD count.
  view.setUint16(ifdStart, IFD_COUNT, true);
  let e = ifdStart + 2;
  const putEntry = (tag: number, type: number, count: number, litOrOff: number) => {
    view.setUint16(e, tag, true);
    view.setUint16(e + 2, type, true);
    view.setUint32(e + 4, count, true);
    view.setUint32(e + 8, litOrOff, true);
    e += 12;
  };

  // SHORT = 3, LONG = 4, RATIONAL = 5
  putEntry(256, 4, 1, width); // ImageWidth
  putEntry(257, 4, 1, height); // ImageLength
  putEntry(258, 3, 3, bitsPerSampleOff); // BitsPerSample (8,8,8) in extra
  putEntry(259, 3, 1, 1); // Compression none
  putEntry(262, 3, 1, 2); // Photometric RGB
  putEntry(273, 4, 1, pixelDataOff); // StripOffsets
  putEntry(277, 3, 1, 3); // SamplesPerPixel
  putEntry(278, 4, 1, height); // RowsPerStrip
  putEntry(279, 4, 1, stripBytes); // StripByteCounts
  putEntry(282, 5, 1, xResOff); // XResolution (rational)
  putEntry(283, 5, 1, yResOff); // YResolution (rational)
  putEntry(296, 3, 1, 2); // ResolutionUnit: inch

  view.setUint32(e, 0, true); // next IFD = none

  // Bits per sample.
  view.setUint16(bitsPerSampleOff, 8, true);
  view.setUint16(bitsPerSampleOff + 2, 8, true);
  view.setUint16(bitsPerSampleOff + 4, 8, true);

  // Strip offset (long).
  view.setUint32(stripOffsetsOff, pixelDataOff, true);
  // Rows per strip.
  view.setUint32(rowsPerStripOff, height, true);
  // Strip bytes.
  view.setUint32(stripByteCountsOff, stripBytes, true);
  // Resolution rationals: numerator, denominator.
  view.setUint32(xResOff, 72, true);
  view.setUint32(xResOff + 4, 1, true);
  view.setUint32(yResOff, 72, true);
  view.setUint32(yResOff + 4, 1, true);

  // Pixel data: uncompressed RGB, top-down rows, each row padded to 4 bytes.
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const rowBase = pixelDataOff + y * rowBytes;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      bytes[rowBase + x * 3] = data[i];
      bytes[rowBase + x * 3 + 1] = data[i + 1];
      bytes[rowBase + x * 3 + 2] = data[i + 2];
    }
    for (let p = width * 3; p < rowBytes; p++) bytes[rowBase + p] = 0;
  }
  return bytes;
}
