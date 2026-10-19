import type { AgeGroupType, AttireDetectionMode, AttireType, GenderType, PersonDescriptionState } from '../interfaces/demo.interface';
import type { TrackedDetection } from './tracker';

export interface PersonEvent {
  eventId: string; sessionId: string; cameraId: string; trackId: number; trackEpoch: number;
  source: 'camera' | 'image'; attireMode: AttireDetectionMode; firstSeen: number; lastSeen: number;
  confidence: number; attire: AttireType | 'unclassified'; gender: GenderType;
  ageGroup: AgeGroupType; revision: number; receivedAt?: number; thumbnail?: string; imageAvailable?: boolean;
}
export type EventCounts = Record<PersonEvent['attire'], number>;
export interface EventBucket extends EventCounts { key: string; date: string }
export interface DashboardData {
  from: string; to: string; granularity: 'hour' | 'day'; buckets: EventBucket[];
  totals: EventCounts; cameras: { cameraId: string; count: number }[];
  demographics: { gender: GenderType; ageGroup: AgeGroupType; count: number }[];
  cameraSeries: { cameraId: string; buckets: { key: string; date: string; count: number }[] }[];
  latest: PersonEvent[]; asOf: number; timezone: string;
}
export interface EventPage { rows: PersonEvent[]; total: number; page: number; size: number }

interface ActiveEvent {
  event: PersonEvent;
  sentAt: number;
  thumbnailAttached: boolean;
  dirty: boolean;
  analyzing: boolean;
  departed: boolean;
}

// Publish a completed result + one thumbnail, then infrequent metadata updates.
export class PersonEventRecorder {
  private active = new Map<number, ActiveEvent>();
  private session: { id: string; cameraId: string; source: PersonEvent['source']; mode: AttireDetectionMode } | null = null;
  private epoch = 0;
  constructor(private enqueue: (event: PersonEvent) => void, private now = Date.now) {}
  begin(id: string, cameraId: string, source: PersonEvent['source'], mode: AttireDetectionMode) {
    this.finish(); this.session = { id, cameraId, source, mode }; this.epoch = 0;
  }
  resetTracks() { this.flushActive(); this.active.clear(); this.epoch++; }
  private publish(item: ActiveEvent) {
    if (item.event.attire === 'unclassified' || !item.dirty) return;
    item.event.revision++; item.sentAt = this.now();
    const snapshot = { ...item.event };
    delete item.event.thumbnail;
    item.dirty = false;
    this.enqueue(snapshot);
  }
  observe(people: TrackedDetection[], hasTrack: (id: number) => boolean) {
    if (!this.session) return;
    for (const [id, item] of this.active) if (!hasTrack(id)) {
      item.departed = true;
      this.publish(item);
      // Keep the timestamp/identity until an already-running AI call completes.
      if (!item.analyzing) this.active.delete(id);
    }
    const now = this.now(), s = this.session;
    for (const person of people) {
      let item = this.active.get(person.trackId);
      if (!item) {
        item = { sentAt: 0, thumbnailAttached: false, dirty: true, analyzing: false, departed: false, event: {
          eventId: `${s.id}:${this.epoch}:${person.trackId}`, sessionId: s.id, cameraId: s.cameraId,
          trackId: person.trackId, trackEpoch: this.epoch, source: s.source, attireMode: s.mode,
          firstSeen: now, lastSeen: now, confidence: person.score, attire: 'unclassified',
          gender: 'uncertain', ageGroup: 'uncertain', revision: 0,
        } };
        this.active.set(person.trackId, item);
      }
      const lastSeen = Math.max(item.event.lastSeen, now);
      const confidence = Math.max(item.event.confidence, person.score);
      item.dirty ||= lastSeen !== item.event.lastSeen || confidence !== item.event.confidence;
      item.event.lastSeen = lastSeen;
      item.event.confidence = confidence;
      if (now - item.sentAt >= 30_000) this.publish(item);
    }
  }
  beginAnalysis(trackId: number) {
    const item = this.active.get(trackId);
    if (item) item.analyzing = true;
  }
  endAnalysis(trackId: number) {
    const item = this.active.get(trackId);
    if (!item) return;
    item.analyzing = false;
    if (item.departed) { this.publish(item); this.active.delete(trackId); }
  }
  classify(trackId: number, description: PersonDescriptionState) {
    const item = this.active.get(trackId);
    if (!item || item.event.attire !== 'unclassified' || description.loading || description.error || !description.attire) return;
    item.event.attire = description.attire;
    item.event.gender = description.gender ?? 'uncertain';
    item.event.ageGroup = description.ageGroup ?? 'uncertain';
    item.dirty = true;
    this.publish(item);
  }
  attachThumbnail(trackId: number, thumbnail: string) {
    const item = this.active.get(trackId);
    if (!item || item.thumbnailAttached) return;
    item.thumbnailAttached = true;
    item.event.thumbnail = thumbnail;
    item.dirty = true;
  }
  private flushActive() { for (const item of this.active.values()) this.publish(item); }
  finish() { this.flushActive(); this.active.clear(); this.session = null; }
}
