// WebM writer tests: structure, sizes, timing, cues (node --test tests/js)
import test from 'node:test';
import assert from 'node:assert/strict';

import { muxWebM, parseEBML, vint, WEBM_IDS as ID } from '../../static/js/webm.js';

const join = (parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const find = (nodes, id) => nodes.find((n) => n.id === id);
const all = (nodes, id) => nodes.filter((n) => n.id === id);
const uint = (b) => b.reduce((v, x) => v * 256 + x, 0);

test('vint encodes sizes in the shortest form', () => {
  assert.deepEqual([...vint(0)], [0x80]);
  assert.deepEqual([...vint(126)], [0xfe]);
  assert.deepEqual([...vint(127)], [0x40, 0x7f]);
  assert.deepEqual([...vint(16382)], [0x7f, 0xfe]);
  assert.equal(vint(2 ** 40).length, 6);
});

function fakeFrames(n, fps, keyEvery) {
  return Array.from({ length: n }, (_, i) => ({
    data: Uint8Array.from({ length: 50 + (i % 7) * 13 }, (_, k) => (i * 31 + k) & 255),
    timestampUs: Math.round((i * 1e6) / fps),
    key: i % keyEvery === 0,
  }));
}

test('a 5 s 30 fps file parses back with every frame, cluster and cue in place', () => {
  const fps = 30, n = 150, frames = fakeFrames(n, fps, 60);
  const { parts, size } = muxWebM({ width: 1920, height: 1080, fps, codec: 'vp9', frames, durationUs: n * 1e6 / fps });
  const bytes = join(parts);
  assert.equal(bytes.length, size, 'reported size matches');
  const top = parseEBML(bytes);
  assert.equal(top.length, 2);
  const ebml = top[0];
  assert.equal(ebml.id, ID.EBML);
  assert.equal(new TextDecoder().decode(find(ebml.children, ID.DocType).data), 'webm');
  const seg = top[1];
  assert.equal(seg.id, ID.Segment);
  assert.equal(seg.dataStart + seg.size, bytes.length, 'segment runs to the end');

  const info = find(seg.children, ID.Info);
  const dur = new DataView(find(info.children, ID.Duration).data.slice().buffer).getFloat64(0);
  assert.equal(dur, 5000);
  const track = find(find(seg.children, ID.Tracks).children, ID.TrackEntry);
  assert.equal(new TextDecoder().decode(find(track.children, ID.CodecID).data), 'V_VP9');
  const video = find(track.children, ID.Video);
  assert.equal(uint(find(video.children, ID.PixelWidth).data), 1920);
  assert.equal(uint(find(video.children, ID.PixelHeight).data), 1080);
  assert.equal(uint(find(track.children, ID.DefaultDuration).data), Math.round(1e9 / 30));

  const clusters = all(seg.children, ID.Cluster);
  assert.equal(clusters.length, 3, 'one cluster per key frame');
  let count = 0, lastMs = -1;
  for (const c of clusters) {
    const tc = uint(find(c.children, ID.Timecode).data);
    all(c.children, ID.SimpleBlock).forEach((b, k) => {
      const rel = (b.data[1] << 8) | b.data[2];
      const ms = tc + rel;
      assert.ok(ms > lastMs, 'timestamps increase');
      lastMs = ms;
      assert.equal(b.data[0], 0x81, 'track 1');
      assert.equal(!!(b.data[3] & 0x80), k === 0, 'key flag only on the first block of a cluster');
      const f = frames[count];
      assert.deepEqual([...b.data.subarray(4)], [...f.data], 'payload intact');
      count++;
    });
  }
  assert.equal(count, n);

  // SeekHead and Cues point at the right byte offsets inside the segment
  const seekHead = find(seg.children, ID.SeekHead);
  for (const s of seekHead.children) {
    const target = uint(find(s.children, ID.SeekID).data);
    const pos = uint(find(s.children, ID.SeekPosition).data);
    const el = seg.children.find((x) => x.start - seg.dataStart === pos);
    assert.ok(el, `seek target at ${pos}`);
    assert.equal(el.id, target);
  }
  const cues = find(seg.children, ID.Cues);
  all(cues.children, ID.CuePoint).forEach((cp, k) => {
    const ctp = find(cp.children, ID.CueTrackPositions);
    const pos = uint(find(ctp.children, ID.CueClusterPosition).data);
    assert.equal(clusters[k].start - seg.dataStart, pos, 'cue points at its cluster');
    assert.equal(uint(find(cp.children, ID.CueTime).data), uint(find(clusters[k].children, ID.Timecode).data));
  });
});

test('VP8 codec id and empty input', () => {
  const { parts } = muxWebM({ width: 64, height: 64, fps: 60, codec: 'vp8', frames: fakeFrames(3, 60, 1) });
  const seg = parseEBML(join(parts))[1];
  const track = find(find(seg.children, ID.Tracks).children, ID.TrackEntry);
  assert.equal(new TextDecoder().decode(find(track.children, ID.CodecID).data), 'V_VP8');
  assert.throws(() => muxWebM({ width: 2, height: 2, fps: 30, frames: [] }));
});
