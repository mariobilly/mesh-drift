// A small WebM (Matroska / EBML) writer for one video track of VP9 or VP8 frames from WebCodecs.
// The file is assembled in memory once every frame is encoded, so every size is known and the file has a real
// Duration, a SeekHead and Cues: players show the length and can seek straight away.

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, FlagLacing: 0x9c, CodecID: 0x86,
  TrackType: 0x83, DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
};
export const WEBM_IDS = ID;

const enc = new TextEncoder();

function idBytes(id) {
  const out = [];
  for (let n = id; n > 0; n = Math.floor(n / 256)) out.unshift(n & 255);
  return Uint8Array.from(out);
}

/** EBML variable-length size. */
export function vint(size) {
  for (let len = 1; len <= 8; len++) {
    if (size < 2 ** (7 * len) - 1) {
      const b = new Uint8Array(len);
      let v = size;
      for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
      b[0] |= 0x80 >> (len - 1);
      return b;
    }
  }
  throw new Error('EBML size too large');
}

function uint(n, width = 0) {
  const out = [];
  for (let v = Math.floor(n); v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  if (!out.length) out.push(0);
  while (out.length < width) out.unshift(0);
  return Uint8Array.from(out);
}

function float64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return b;
}

// An element is { size, parts }: total byte length and the list of byte arrays it is made of.
function el(id, payload) {
  const kids = Array.isArray(payload) ? payload : [payload];
  const parts = [];
  let len = 0;
  for (const k of kids) {
    if (k instanceof Uint8Array) { parts.push(k); len += k.length; } else { parts.push(...k.parts); len += k.size; }
  }
  const head = [idBytes(id), vint(len)];
  return { size: head[0].length + head[1].length + len, parts: [...head, ...parts] };
}
const u = (id, n, w) => el(id, uint(n, w));
const str = (id, s) => el(id, enc.encode(s));

/**
 * frames: [{ data: Uint8Array, timestampUs: number, key: boolean }] in decode order.
 * Returns { parts, size } (pass parts to new Blob(parts, { type: 'video/webm' })).
 */
export function muxWebM({ width, height, fps, codec = 'vp9', frames, durationUs, app = 'Mesh Drift' }) {
  if (!frames.length) throw new Error('no frames to write');
  const header = el(ID.EBML, [
    u(ID.EBMLVersion, 1), u(ID.EBMLReadVersion, 1), u(ID.EBMLMaxIDLength, 4), u(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, 'webm'), u(ID.DocTypeVersion, 4), u(ID.DocTypeReadVersion, 2),
  ]);
  const totalMs = (durationUs ?? frames.length * (1e6 / fps)) / 1000;
  const info = el(ID.Info, [u(ID.TimecodeScale, 1000000), el(ID.Duration, float64(totalMs)), str(ID.MuxingApp, app), str(ID.WritingApp, app)]);
  const tracks = el(ID.Tracks, el(ID.TrackEntry, [
    u(ID.TrackNumber, 1), u(ID.TrackUID, 1), u(ID.FlagLacing, 0), str(ID.CodecID, codec === 'vp8' ? 'V_VP8' : 'V_VP9'),
    u(ID.TrackType, 1), u(ID.DefaultDuration, Math.round(1e9 / fps)),
    el(ID.Video, [u(ID.PixelWidth, width), u(ID.PixelHeight, height)]),
  ]));

  // Clusters: a new one at every key frame (and at least every 30 s, far inside the int16 block-time limit).
  const clusters = [];
  let cur = null;
  for (const f of frames) {
    const ms = Math.round(f.timestampUs / 1000);
    if (!cur || f.key || ms - cur.start > 30000) {
      cur = { start: ms, blocks: [] };
      clusters.push(cur);
    }
    const rel = ms - cur.start;
    const head = Uint8Array.of(0x81, (rel >> 8) & 255, rel & 255, f.key ? 0x80 : 0x00);
    cur.blocks.push(el(ID.SimpleBlock, [head, f.data]));
  }
  const clusterEls = clusters.map((c) => el(ID.Cluster, [u(ID.Timecode, c.start), ...c.blocks]));

  // Layout inside the Segment: SeekHead (fixed size: 8-byte positions), Info, Tracks, Clusters..., Cues.
  const seekHead = (pos) => el(ID.SeekHead, [
    el(ID.Seek, [el(ID.SeekID, idBytes(ID.Info)), u(ID.SeekPosition, pos.info, 8)]),
    el(ID.Seek, [el(ID.SeekID, idBytes(ID.Tracks)), u(ID.SeekPosition, pos.tracks, 8)]),
    el(ID.Seek, [el(ID.SeekID, idBytes(ID.Cues)), u(ID.SeekPosition, pos.cues, 8)]),
  ]);
  const shSize = seekHead({ info: 0, tracks: 0, cues: 0 }).size;
  const pos = { info: shSize, tracks: shSize + info.size };
  let off = pos.tracks + tracks.size;
  const cuePoints = [];
  clusters.forEach((c, i) => {
    cuePoints.push(el(ID.CuePoint, [u(ID.CueTime, c.start), el(ID.CueTrackPositions, [u(ID.CueTrack, 1), u(ID.CueClusterPosition, off)])]));
    off += clusterEls[i].size;
  });
  pos.cues = off;
  const cues = el(ID.Cues, cuePoints);
  const segment = el(ID.Segment, [seekHead(pos), info, tracks, ...clusterEls, cues]);
  return { parts: [...header.parts, ...segment.parts], size: header.size + segment.size };
}

// ---- reader (used by the tests to check what the writer produced) -------------------------------------------
function readVint(b, i, keepMarker) {
  const first = b[i];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('bad EBML vint at ' + i);
  let v = keepMarker ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + b[i + k];
  return { value: v, len };
}

const MASTER = new Set([ID.EBML, ID.Segment, ID.SeekHead, ID.Seek, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.Cues, ID.CuePoint, ID.CueTrackPositions]);

/** Parses bytes into a tree of { id, start, size, children | data }. Throws if any element overruns its parent. */
export function parseEBML(b, start = 0, end = b.length) {
  const out = [];
  let i = start;
  while (i < end) {
    const id = readVint(b, i, true);
    const sz = readVint(b, i + id.len, false);
    const dataStart = i + id.len + sz.len, dataEnd = dataStart + sz.value;
    if (dataEnd > end) throw new Error(`element 0x${id.value.toString(16)} overruns its parent`);
    const node = { id: id.value, start: i, dataStart, size: sz.value };
    if (MASTER.has(id.value)) node.children = parseEBML(b, dataStart, dataEnd);
    else node.data = b.subarray(dataStart, dataEnd);
    out.push(node);
    i = dataEnd;
  }
  return out;
}
