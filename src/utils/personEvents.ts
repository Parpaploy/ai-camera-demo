import type { AgeGroupType, AttireDetectionMode, AttireType, GenderType, PersonDescriptionState } from '../interfaces/demo.interface';
import type { TrackedDetection } from './tracker';

export interface PersonEvent {
  eventId: string; sessionId: string; cameraId: string; trackId: number; trackEpoch: number;
  source: 'camera' | 'image'; attireMode: AttireDetectionMode; firstSeen: number; lastSeen: number;
  confidence: number; attire: AttireType | 'unclassified'; gender: GenderType;
  ageGroup: AgeGroupType; revision: number; receivedAt?: number;
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

// One record per track per session, never one record per video frame.
export class PersonEventRecorder {
  private active = new Map<number, { event: PersonEvent; sentAt: number }>();
  private session: { id: string; cameraId: string; source: PersonEvent['source']; mode: AttireDetectionMode } | null = null;
  private epoch = 0;
  constructor(private enqueue: (event: PersonEvent) => void, private now = Date.now) {}
  begin(id: string, cameraId: string, source: PersonEvent['source'], mode: AttireDetectionMode) {
    this.finish(); this.session = { id, cameraId, source, mode }; this.epoch = 0;
  }
  resetTracks() { this.flushActive(); this.active.clear(); this.epoch++; }
  private publish(item: { event: PersonEvent; sentAt: number }) {
    item.event.revision++; item.sentAt = this.now(); this.enqueue({ ...item.event });
  }
  observe(people: TrackedDetection[], hasTrack: (id: number) => boolean) {
    if (!this.session) return;
    for (const [id, item] of this.active) if (!hasTrack(id)) { this.publish(item); this.active.delete(id); }
    const now = this.now(), s = this.session;
    for (const person of people) {
      let item = this.active.get(person.trackId);
      if (!item) {
        item = { sentAt: 0, event: {
          eventId: `${s.id}:${this.epoch}:${person.trackId}`, sessionId: s.id, cameraId: s.cameraId,
          trackId: person.trackId, trackEpoch: this.epoch, source: s.source, attireMode: s.mode,
          firstSeen: now, lastSeen: now, confidence: person.score, attire: 'unclassified',
          gender: 'uncertain', ageGroup: 'uncertain', revision: 0,
        } };
        this.active.set(person.trackId, item);
      }
      item.event.lastSeen = Math.max(item.event.lastSeen, now);
      item.event.confidence = Math.max(item.event.confidence, person.score);
      if (item.event.revision === 0 || now - item.sentAt >= 5000) this.publish(item);
    }
  }
  classify(trackId: number, description: PersonDescriptionState) {
    const item = this.active.get(trackId);
    if (!item || description.loading || !description.attire) return;
    item.event.attire = description.attire;
    item.event.gender = description.gender ?? 'uncertain';
    item.event.ageGroup = description.ageGroup ?? 'uncertain';
    this.publish(item);
  }
  private flushActive() { for (const item of this.active.values()) this.publish(item); }
  finish() { this.flushActive(); this.active.clear(); this.session = null; }
}
