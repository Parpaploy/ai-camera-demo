import { Detection } from "./yolo";

export interface TrackedDetection extends Detection {
  trackId: number;
}

interface Track {
  id: number;
  box: [number, number, number, number];
  classId: number;
  missedFrames: number;
  analyzed: boolean;
  velocity: [number, number];
  hits: number;
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface IouTrackerOptions {
  matchIouThreshold?: number;

  maxMissedFrames?: number;
}

export class IouTracker {
  private tracks: Map<number, Track> = new Map();
  private nextId = 1;
  private matchIouThreshold: number;
  private maxMissedFrames: number;

  constructor(options: IouTrackerOptions = {}) {
    this.matchIouThreshold = options.matchIouThreshold ?? 0.3;
    this.maxMissedFrames = options.maxMissedFrames ?? 8;
  }

  update(detections: Detection[]): TrackedDetection[] {
    const unmatched = new Set(this.tracks.keys());
    const matches = new Map<number, number>();
    const candidates: { index: number; id: number; score: number }[] = [];
    detections.forEach((det, index) => {
      for (const track of this.tracks.values()) {
        if (track.classId !== det.classId) continue;
        const [x, y, w, h] = track.box;
        const steps = Math.min(track.missedFrames + 1, 3);
        const predicted: Track['box'] = [x + track.velocity[0] * steps, y + track.velocity[1] * steps, w, h];
        const overlap = iou(track.box, det.box);
        const predictedOverlap = iou(predicted, det.box);
        const [dx, dy, dw, dh] = det.box;
        const areaRatio = dw * dh / Math.max(1, w * h);
        const distance = Math.hypot(dx + dw / 2 - predicted[0] - w / 2, dy + dh / 2 - predicted[1] - h / 2);
        const near = distance / Math.max(1, Math.hypot(w, h));
        // Small detector jumps or a brief occlusion should not allocate a new ID.
        // Size/distance gates avoid reusing an ID for an unrelated distant person.
        if (Math.max(overlap, predictedOverlap) < this.matchIouThreshold &&
            !(near < 0.6 && areaRatio >= 0.5 && areaRatio <= 2)) continue;
        candidates.push({ index, id: track.id,
          score: Math.max(predictedOverlap * 0.8 + overlap * 0.2, 0.15 * (1 - near / 0.6)) });
      }
    });
    // Match strongest pairs first, independently of detector output ordering.
    candidates.sort((a, b) => b.score - a.score || a.id - b.id || a.index - b.index);
    for (const { index, id } of candidates) {
      if (matches.has(index) || !unmatched.has(id)) continue;
      matches.set(index, id);
      unmatched.delete(id);
    }
    const results = detections.map((det, index) => {
      const matchedId = matches.get(index);
      if (matchedId !== undefined) {
        const track = this.tracks.get(matchedId)!;
        const elapsed = track.missedFrames + 1;
        const vx = (det.box[0] + det.box[2] / 2 - track.box[0] - track.box[2] / 2) / elapsed;
        const vy = (det.box[1] + det.box[3] / 2 - track.box[1] - track.box[3] / 2) / elapsed;
        track.velocity = track.hits === 1 ? [vx, vy] : [(track.velocity[0] + vx) / 2, (track.velocity[1] + vy) / 2];
        track.hits++;
        track.box = det.box;
        track.missedFrames = 0;
        return { ...det, trackId: matchedId };
      } else {
        const id = this.nextId++;

        this.tracks.set(id, {
          id,
          box: det.box,
          classId: det.classId,
          missedFrames: 0,
          analyzed: false,
          velocity: [0, 0],
          hits: 1,
        });

        return { ...det, trackId: id };
      }
    });

    for (const id of unmatched) {
      const track = this.tracks.get(id)!;

      track.missedFrames++;

      if (track.missedFrames > this.maxMissedFrames) {
        this.tracks.delete(id);
      }
    }

    return results;
  }

  hasTrack(trackId: number): boolean {
    return this.tracks.has(trackId);
  }

  markAnalyzed(trackId: number) {
    const track = this.tracks.get(trackId);

    if (track) track.analyzed = true;
  }

  isAnalyzed(trackId: number): boolean {
    return this.tracks.get(trackId)?.analyzed ?? false;
  }

  get activeTrackCount(): number {
    return this.tracks.size;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }
}
