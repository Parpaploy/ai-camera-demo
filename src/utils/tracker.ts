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
    const results: TrackedDetection[] = [];

    for (const det of detections) {
      let bestId: number | null = null;
      let bestIou = 0;

      for (const id of unmatched) {
        const track = this.tracks.get(id)!;

        if (track.classId !== det.classId) continue;

        const val = iou(track.box, det.box);

        if (val > bestIou && val >= this.matchIouThreshold) {
          bestIou = val;
          bestId = id;
        }
      }

      if (bestId !== null) {
        const track = this.tracks.get(bestId)!;

        track.box = det.box;
        track.missedFrames = 0;

        unmatched.delete(bestId);

        results.push({ ...det, trackId: bestId });
      } else {
        const id = this.nextId++;

        this.tracks.set(id, {
          id,
          box: det.box,
          classId: det.classId,
          missedFrames: 0,
          analyzed: false,
        });

        results.push({ ...det, trackId: id });
      }
    }

    for (const id of unmatched) {
      const track = this.tracks.get(id)!;

      track.missedFrames++;

      if (track.missedFrames > this.maxMissedFrames) {
        this.tracks.delete(id);
      }
    }

    return results;
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
