import { useMemo, useState } from "react";
import type { AttireDetectionMode } from "../interfaces/demo.interface";
import type { DetectionHistoryEntry } from "../utils/detectionHistory";

type ModeFilter = "all" | AttireDetectionMode;

interface DashboardProps {
  history: DetectionHistoryEntry[];
  onStartDetection: (mode: "image" | "camera") => void;
  onClearHistory: () => void;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTargetLabel(mode: AttireDetectionMode | "all"): string {
  if (mode === "student") return "นักศึกษา/บุคลากร";
  if (mode === "medical") return "บุคลากรทางการแพทย์";
  return "กลุ่มเป้าหมาย";
}

function getOtherLabel(mode: AttireDetectionMode | "all"): string {
  if (mode === "student") return "บุคคลภายนอก";
  if (mode === "medical") return "ชุดทั่วไป";
  return "กลุ่มอื่น";
}

function getModeLabel(mode: AttireDetectionMode): string {
  return mode === "student" ? "ชุดนักศึกษา" : "บุคลากรทางการแพทย์";
}

function formatDate(timestamp: number, includeTime = false): string {
  return new Intl.DateTimeFormat(
    "th-TH",
    includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" },
  ).format(new Date(timestamp));
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} วินาที`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} นาที ${seconds} วินาที` : `${minutes} นาที`;
}

export default function Dashboard({
  history,
  onStartDetection,
  onClearHistory,
}: DashboardProps) {
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [confirmClear, setConfirmClear] = useState(false);

  const filteredHistory = useMemo(
    () =>
      modeFilter === "all"
        ? history
        : history.filter((entry) => entry.attireMode === modeFilter),
    [history, modeFilter],
  );

  const totals = useMemo(
    () =>
      filteredHistory.reduce(
        (total, entry) => ({
          sessions: total.sessions + 1,
          people: total.people + entry.peopleDetected,
          target: total.target + entry.targetCount,
          other: total.other + entry.otherCount,
          uncertain: total.uncertain + entry.uncertainCount,
          unclassified: total.unclassified + entry.unclassifiedCount,
        }),
        {
          sessions: 0,
          people: 0,
          target: 0,
          other: 0,
          uncertain: 0,
          unclassified: 0,
        },
      ),
    [filteredHistory],
  );

  const weeklyActivity = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      const key = localDateKey(date);
      const people = filteredHistory
        .filter((entry) => localDateKey(new Date(entry.startedAt)) === key)
        .reduce((sum, entry) => sum + entry.peopleDetected, 0);

      return {
        key,
        label: new Intl.DateTimeFormat("th-TH", { weekday: "short" }).format(
          date,
        ),
        people,
      };
    });
  }, [filteredHistory]);

  const weeklyMax = Math.max(1, ...weeklyActivity.map((day) => day.people));
  const targetLabel = getTargetLabel(modeFilter);
  const otherLabel = getOtherLabel(modeFilter);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 lg:py-9">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
            ภาพรวมการตรวจจับ
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Dashboard
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            สรุปจำนวนคนและผลจำแนกจากรอบตรวจจับที่บันทึกไว้ในเบราว์เซอร์นี้
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onStartDetection("image")}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:bg-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ตรวจจับจากรูปภาพ
          </button>
          <button
            onClick={() => onStartDetection("camera")}
            className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            เปิดกล้องสด
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel/70 px-4 py-3">
        <p className="text-xs leading-relaxed text-slate-400">
          เก็บยอดสรุปสูงสุด 200 รอบในเบราว์เซอร์นี้ · ไม่บันทึกภาพหรือคำบรรยายบุคคล
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-md border border-line bg-ink p-1"
            role="group"
            aria-label="กรองตามโหมดตรวจจับ"
          >
            {(
              [
                { id: "all", label: "ทั้งหมด" },
                { id: "student", label: "ชุดนักศึกษา" },
                { id: "medical", label: "แพทย์" },
              ] as const
            ).map((filter) => (
              <button
                key={filter.id}
                onClick={() => setModeFilter(filter.id)}
                aria-pressed={modeFilter === filter.id}
                className={`rounded px-2.5 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  modeFilter === filter.id
                    ? "bg-accent text-ink"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {history.length > 0 && !confirmClear && (
            <button
              onClick={() => setConfirmClear(true)}
              className="rounded-md px-2.5 py-1.5 text-xs text-slate-500 transition hover:text-warn focus-visible:outline focus-visible:outline-2 focus-visible:outline-warn"
            >
              ล้างประวัติ
            </button>
          )}
        </div>
      </div>

      {confirmClear && (
        <div
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/5 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-slate-200">
            ลบประวัติทั้งหมดที่บันทึกไว้ในเบราว์เซอร์นี้หรือไม่?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                onClearHistory();
                setConfirmClear(false);
              }}
              className="rounded-md bg-warn px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-orange-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn"
            >
              ลบประวัติ
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-slate-300 transition hover:border-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {history.length === 0 ? (
        <section className="rounded-lg border border-dashed border-line bg-panel/50 px-6 py-14 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
            ยังไม่มีประวัติ
          </p>
          <h3 className="mt-3 text-lg font-semibold text-white">
            เริ่มตรวจจับเพื่อสร้างสรุปชุดแรก
          </h3>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
            เมื่อจบรอบตรวจจับ ระบบจะบันทึกวันเวลา แหล่งภาพ และจำนวนที่จำแนกได้ไว้ในเบราว์เซอร์นี้
          </p>
          <button
            onClick={() => onStartDetection("image")}
            className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:bg-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            เริ่มจากรูปภาพ
          </button>
        </section>
      ) : filteredHistory.length === 0 ? (
        <section className="rounded-lg border border-line bg-panel px-6 py-12 text-center">
          <h3 className="text-base font-semibold text-white">
            ยังไม่มีประวัติในโหมดนี้
          </h3>
          <p className="mt-2 text-sm text-slate-400">
            เลือก “ทั้งหมด” เพื่อดูรอบตรวจจับอื่น
          </p>
        </section>
      ) : (
        <>
          <section
            className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            aria-label="ยอดรวมประวัติ"
          >
            <MetricCard label="รอบตรวจจับ" value={totals.sessions} />
            <MetricCard label="ตรวจพบคน" value={totals.people} />
            <MetricCard
              label={targetLabel}
              value={totals.target}
              tone="target"
            />
            <MetricCard
              label={otherLabel}
              value={totals.other}
              tone="other"
            />
            <MetricCard
              label="ไม่แน่ใจ / รอวิเคราะห์"
              value={totals.uncertain + totals.unclassified}
              tone="uncertain"
            />
          </section>

          <section className="mb-6 rounded-lg border border-line bg-panel p-5 sm:p-6">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold text-white">
                  จำนวนคนใน 7 วันที่ผ่านมา
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  รวมตามวันจากประวัติที่บันทึกไว้ · คนเดิมอาจถูกนับซ้ำข้ามรอบ
                </p>
              </div>
              <p className="font-mono text-xs text-slate-400">
                {weeklyActivity.reduce((sum, day) => sum + day.people, 0)} คน
              </p>
            </div>
            <div className="grid h-36 grid-cols-7 items-end gap-2 sm:gap-4">
              {weeklyActivity.map((day) => (
                <div
                  key={day.key}
                  className="flex h-full flex-col items-center justify-end gap-2"
                >
                  <span className="font-mono text-[10px] text-slate-500">
                    {day.people || ""}
                  </span>
                  <div className="flex h-24 w-full items-end rounded-sm bg-ink/70">
                    <div
                      className="w-full rounded-sm bg-accent/80 transition-[height] duration-300"
                      style={{
                        height: `${day.people ? Math.max(8, (day.people / weeklyMax) * 100) : 2}%`,
                      }}
                      title={`${day.label}: ${day.people} คน`}
                    />
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {day.label}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
              <div>
                <h3 className="font-semibold text-white">ประวัติล่าสุด</h3>
                <p className="mt-1 text-xs text-slate-500">
                  แสดงสูงสุด 20 รอบล่าสุด
                </p>
              </div>
              <span className="font-mono text-xs text-slate-500">
                {filteredHistory.length} รอบ
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] text-slate-500">
                    <th className="px-5 py-3 font-medium">วันเวลา</th>
                    <th className="px-4 py-3 font-medium">แหล่งภาพ</th>
                    <th className="px-4 py-3 font-medium">โหมด</th>
                    <th className="px-4 py-3 text-right font-medium">คน</th>
                    <th className="px-4 py-3 text-right font-medium">
                      {targetLabel}
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      {otherLabel}
                    </th>
                    <th className="px-5 py-3 text-right font-medium">
                      ไม่ชัด
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.slice(0, 20).map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-line/70 last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="whitespace-nowrap px-5 py-3 text-slate-200">
                        {formatDate(entry.startedAt, true)}
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          {formatDuration(entry.durationMs)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {entry.source === "image" ? "รูปภาพ" : "กล้องสด"}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {getModeLabel(entry.attireMode)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white">
                        {entry.peopleDetected}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-accent">
                        {entry.targetCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-orange-300">
                        {entry.otherCount}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-amber-300">
                        {entry.uncertainCount + entry.unclassifiedCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function MetricCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "target" | "other" | "uncertain";
}) {
  const toneClass = {
    neutral: "text-white",
    target: "text-accent",
    other: "text-orange-300",
    uncertain: "text-amber-300",
  }[tone];

  return (
    <div className="min-h-24 rounded-lg border border-line bg-panel px-4 py-4">
      <p className="text-xs leading-relaxed text-slate-400">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value.toLocaleString("th-TH")}
      </p>
    </div>
  );
}
