import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DetectionHistoryEntry } from '../utils/detectionHistory';
import type { DashboardData, EventBucket, EventCounts, EventPage, PersonEvent } from '../utils/personEvents';
import { connectData, dataRequest, disconnectData, flushEvents, getCameraId, getSyncState, loginData, setCameraId, subscribeSync } from '../utils/dataSync';
import LocalHistoryDashboard from './LocalHistoryDashboard';

interface Props {
  history: DetectionHistoryEntry[];
  onStartDetection: (mode: 'image' | 'camera') => void;
  onClearHistory: () => void;
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
}
export type DashboardView = 'today' | 'stats' | 'events' | 'local';
const classes = ['target', 'other', 'uncertain'] as const;
const labels: Record<string, string> = { target: 'กลุ่มเป้าหมาย', other: 'กลุ่มอื่น', uncertain: 'ไม่แน่ใจ', unclassified: 'รอจำแนก', male: 'ชาย', female: 'หญิง', unisex: 'ไม่ระบุเพศ', teen: 'วัยรุ่น', adult: 'ผู้ใหญ่', elderly: 'ผู้สูงอายุ' };
const colors = { target: '#087d6d', other: '#a84f25', uncertain: '#8f6500', unclassified: '#61756b' };
const control = 'min-h-11 rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
const action = 'min-h-11 rounded-md border border-line px-3 py-2 text-sm text-slate-200 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
function today() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
function shiftDay(day: string, amount: number) { return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10); }
function format(ms: number, timeOnly = false) { return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', ...(timeOnly ? {} : { day: 'numeric', month: 'short', year: 'numeric' }), hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms); }
function total(counts: EventCounts) { return classes.reduce((sum, name) => sum + Number(counts[name]), 0); }
function className(key: string, mode: string) {
  if (key === 'target' && mode === 'camera-count') return 'เหตุการณ์บุคคล';
  if (key === 'target') return mode === 'student' ? 'นักศึกษา/บุคลากร' : mode === 'medical' ? 'บุคลากรทางการแพทย์' : 'กลุ่มเป้าหมาย';
  if (key === 'other') return mode === 'student' ? 'บุคคลภายนอก' : mode === 'medical' ? 'ชุดทั่วไป' : 'กลุ่มอื่น';
  return labels[key] ?? key;
}
const initialFilters = () => ({ from: today(), to: today(), camera: '', attireMode: '', source: '', gender: '', ageGroup: '', minConfidence: '', attire: [...classes] as string[] });

export default function Dashboard(props: Props) {
  const sync = useSyncExternalStore(subscribeSync, getSyncState);
  const { view, onViewChange } = props;
  const [filters, setFilters] = useState(initialFilters);
  const [applied, setApplied] = useState(initialFilters);
  const [camera, setCamera] = useState(getCameraId);
  const [password, setPassword] = useState('');
  const [settings, setSettings] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);
  const [eventPage, setEventPage] = useState<EventPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const [sort, setSort] = useState('firstSeen');
  const [direction, setDirection] = useState('desc');
  const [refresh, setRefresh] = useState(0);
  const [detailDay, setDetailDay] = useState('');
  const [selectedImageEvent, setSelectedImageEvent] = useState('');
  const [modalImageError, setModalImageError] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const currentDay = today();
  useEffect(() => {
    if (!selectedImageEvent) return;
    setModalImageError(false);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedImageEvent(''); };
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('keydown', closeOnEscape); previousFocus?.focus(); };
  }, [selectedImageEvent]);
  const effective = view === 'today' ? { ...applied, from: currentDay, to: currentDay } : applied;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(effective)) {
    if (Array.isArray(value)) value.forEach(item => query.append(name, item));
    else if (value) query.set(name, value);
  }
  const queryKey = query.toString();
  const noneSelected = applied.attire.length === 0;
  const filtersDirty = JSON.stringify(filters) !== JSON.stringify(applied);
  const syncLabel = sync.storageError
    ? 'พื้นที่จัดเก็บมีปัญหา'
    : sync.error
      ? 'เชื่อมต่อฐานข้อมูลไม่ได้'
      : sync.sending
        ? 'กำลังส่งข้อมูล'
        : sync.pending > 0
          ? 'มีข้อมูลรอส่ง'
          : sync.authorized
            ? 'เข้าสู่ระบบแล้ว · พร้อมบันทึก'
            : 'ยังไม่ได้เข้าสู่ระบบแอดมิน';
  useEffect(() => {
    if (!sync.authorized || view === 'local') return;
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 30000);
    return () => clearInterval(timer);
  }, [sync.authorized, view]);
  useEffect(() => {
    if (!sync.authorized || view === 'local' || noneSelected) { setData(null); setEventPage(null); setLoading(false); return; }
    const controller = new AbortController(); let disposed = false;
    setLoading(true); setError('');
    // Never label old rows with a newly selected date/filter.
    setData(null); setEventPage(null);
    Promise.all([
      dataRequest<DashboardData>(`/dashboard?${queryKey}`, { signal: controller.signal }),
      view === 'events'
        ? dataRequest<EventPage>(`/events?${queryKey}&page=${page}&size=${size}&sort=${sort}&direction=${direction}`, { signal: controller.signal })
        : Promise.resolve(null),
    ]).then(([summary, events]) => { if (!disposed) { setData(summary); setEventPage(events); } })
      .catch(e => { if (!disposed) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [sync.authorized, view, queryKey, page, size, sort, direction, refresh, noneSelected]);
  function changeView(next: DashboardView) { onViewChange(next); setPage(0); setDetailDay(''); }
  function selectRange(from: string, to: string) {
    const next = { ...filters, from, to }; setFilters(next); setApplied(next); setPage(0); setDetailDay(''); onViewChange('stats');
  }
  function drill(day: string) {
    const next = { ...applied, from: day, to: day }; setFilters(next); setApplied(next); setPage(0); setDetailDay(day); onViewChange('stats');
  }
  function sortBy(column: string) { setDirection(sort === column && direction === 'desc' ? 'asc' : 'desc'); setSort(column); setPage(0); }
  async function saveConnection(event: React.FormEvent) {
    event.preventDefault(); setSettingsMessage(''); setConnecting(true);
    try {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(camera.trim())) throw new Error('รหัสกล้องใช้ภาษาอังกฤษ ตัวเลข จุด ขีด หรือ _ ไม่เกิน 64 ตัว');
      await connectData();
      setCameraId(camera.trim()); setSettings(false); setRefresh(n => n + 1);
      setSettingsMessage('บันทึกแล้ว รหัสกล้องใหม่ใช้กับรอบตรวจจับถัดไป');
    } catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'เชื่อมต่อไม่สำเร็จ'); }
    finally { setConnecting(false); }
  }
  async function submitLogin(event: React.FormEvent) {
    event.preventDefault(); setSettingsMessage(''); setConnecting(true);
    try { await loginData(password); setPassword(''); setSettingsMessage('เข้าสู่ระบบแอดมินแล้ว'); }
    catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'เข้าสู่ระบบไม่สำเร็จ'); }
    finally { setConnecting(false); }
  }
  if (!sync.authorized && view !== 'local') {
    return <main id="main-content" className="mx-auto grid min-h-dvh w-full max-w-7xl items-center gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.85fr)] lg:gap-16 lg:py-12">
      <section className="hidden rounded-2xl bg-[#173b34] p-10 text-ink lg:flex lg:min-h-[34rem] lg:flex-col lg:justify-between" aria-label="เกี่ยวกับ AI Camera">
        <p className="font-display text-xl font-semibold">AI Camera</p>
        <div><h1 className="max-w-lg font-display text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">จากภาพสด<br />สู่ข้อมูลที่ค้นดูได้</h1><p className="mt-5 max-w-md text-base leading-relaxed text-[#d9e9df]">ตรวจจับบุคคล วิเคราะห์ภาพ และดูผลรายบุคคลพร้อมเวลาและรหัสกล้องในที่เดียว</p></div>
        <p className="text-sm text-[#d9e9df]">ข้อมูลย้อนหลังสำหรับผู้ดูแล · ตรวจจับกล้องสดใช้งานได้ทันที</p>
      </section>
      <section className="mx-auto w-full max-w-md rounded-2xl bg-panel p-6 shadow-[0_14px_40px_-24px_rgba(23,51,45,0.35)] sm:p-8">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3" /></svg>
        </div>
        <p className="text-sm font-semibold text-accent">AI Camera · พื้นที่ผู้ดูแล</p>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight text-white">เข้าสู่ระบบผู้ดูแล</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">ลงชื่อเข้าใช้เพื่อดูข้อมูลจากฐานข้อมูลและสถิติย้อนหลัง</p>
        <form onSubmit={submitLogin} className="mt-6 grid gap-4">
          <label className="text-sm font-medium text-slate-200">ชื่อผู้ใช้<input value="admin" readOnly autoComplete="username" className={`${control} mt-2 min-h-11 w-full`} /></label>
          <label className="text-sm font-medium text-slate-200">รหัสผ่าน<input type="password" value={password} required autoComplete="current-password" onChange={e => setPassword(e.target.value)} className={`${control} mt-2 min-h-11 w-full`} /></label>
          {settingsMessage && <p role="alert" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">{settingsMessage}</p>}
          <button disabled={connecting} className="min-h-12 rounded-md bg-accent px-4 py-2 font-semibold text-ink transition hover:bg-[#06695c] disabled:cursor-not-allowed disabled:opacity-50">{connecting ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}</button>
        </form>
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-center text-sm text-slate-400">ต้องการเริ่มตรวจจับเลย?</p>
          <button
            type="button"
            className="mt-3 min-h-11 w-full rounded-md border border-line bg-ink px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => props.onStartDetection('camera')}
          >
            ไปหน้าตรวจจับกล้องสด
          </button>
          <button
            type="button"
            className="mt-2 min-h-10 w-full rounded-md px-3 py-2 text-sm font-medium text-accent underline underline-offset-4 hover:bg-accent/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeView('local')}
          >
            ดูประวัติในเครื่องนี้
          </button>
        </div>
      </section>
    </main>;
  }
  if (view === 'local') {
    return <main id="main-content" className="mx-auto w-full max-w-screen-2xl px-4 py-7 sm:px-6 lg:px-10 lg:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><h2 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">ประวัติในเครื่อง</h2><p className="mt-2 text-sm text-slate-300">ข้อมูลที่บันทึกไว้ในเบราว์เซอร์นี้</p></div>
        <button className={action} onClick={() => changeView('today')}>{sync.authorized ? 'กลับสู่ภาพรวม' : 'เข้าสู่ระบบฐานข้อมูล'}</button>
      </div>
      {sync.authorized && <nav aria-label="มุมมองข้อมูล" className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-line bg-panel p-1.5 sm:grid-cols-4">
        {([{ id: 'today', text: 'ภาพรวมวันนี้' }, { id: 'stats', text: 'สถิติย้อนหลัง' }, { id: 'events', text: 'ข้อมูลรายบุคคล' }, { id: 'local', text: 'ประวัติในเครื่อง' }] as const).map(tab => <button key={tab.id} onClick={() => changeView(tab.id)} aria-current={view === tab.id ? 'page' : undefined} className={`min-h-11 rounded-lg px-3 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${view === tab.id ? 'bg-accent text-ink' : 'text-slate-300 hover:bg-ink hover:text-white'}`}>{tab.text}</button>)}
      </nav>}
      <LocalHistoryDashboard {...props} />
    </main>;
  }
  return (
    <main id="main-content" className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div><h2 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">{view === 'today' ? 'ภาพรวมการตรวจจับ' : view === 'stats' ? 'สถิติย้อนหลัง' : 'ข้อมูลรายบุคคล'}</h2><p className="mt-2 text-sm text-slate-300">{view === 'today' ? 'สรุปเหตุการณ์จากกล้องทั้งหมดของวันนี้ · เวลาไทย' : view === 'stats' ? 'เปรียบเทียบผลตรวจจับตามช่วงเวลาและกล้อง' : 'ค้นหาและตรวจดูภาพ crop ของแต่ละเหตุการณ์'}</p></div>
        <div className="flex flex-wrap gap-2">
          <button className={action} onClick={() => props.onStartDetection('image')}>วิเคราะห์รูปภาพ</button>
          <button className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-ink transition hover:bg-[#06695c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => props.onStartDetection('camera')}>เปิดกล้องสด</button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3" aria-live="polite">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <span className="inline-flex items-center gap-2" role="status"><span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${sync.storageError || sync.error ? 'bg-warn' : sync.authorized ? 'bg-accent' : 'bg-slate-500'}`} /><span className="text-slate-300">{syncLabel}</span></span>
          <span className="text-slate-300">รหัสกล้อง <strong className="font-medium text-white">{getCameraId()}</strong></span>
          {sync.pending > 0 && <span className="text-amber-200">คิวรอส่ง {sync.pending.toLocaleString()} รายการ</span>}
          {sync.lastSent > 0 && <span className="text-xs text-slate-400">ส่งล่าสุด {format(sync.lastSent, true)}</span>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">{sync.authorized && <><button className="text-slate-300 underline underline-offset-4 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setSettings(value => !value)} aria-expanded={settings} aria-controls="camera-settings">{settings ? 'ปิดตั้งค่ากล้อง' : 'ตั้งค่ารหัสกล้อง'}</button><button className="text-slate-300 underline underline-offset-4 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void flushEvents()} disabled={sync.pending === 0 || sync.sending} title={sync.pending === 0 ? 'ไม่มีรายการรอส่ง' : 'ส่งข้อมูลที่รออยู่ตอนนี้'}>ส่งคิวตอนนี้</button><button className="text-slate-300 underline underline-offset-4 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => void disconnectData()}>ออกจากระบบ</button></>}</div>
      </div>
      {settings && <form id="camera-settings" onSubmit={saveConnection} className="mb-6 grid gap-4 rounded-md border border-line bg-panel p-5 sm:grid-cols-[1fr_auto]">
        <label className="text-sm text-slate-200">รหัสกล้องของเครื่องนี้<input value={camera} maxLength={64} required onChange={e => setCamera(e.target.value)} className={`${control} mt-2 w-full`} placeholder="เช่น rdk-lobby-01" /></label>
        <div className="flex items-end"><button disabled={connecting} className={action}>{connecting ? 'กำลังตรวจสอบ…' : 'ตรวจการเชื่อมต่อ / บันทึก'}</button></div>
        <p className="text-xs leading-relaxed text-slate-300 sm:col-span-2">เว็บเชื่อมฐานข้อมูลให้อัตโนมัติ · รหัสกล้องนี้ใช้กับรอบใหม่ · เมื่อเน็ตขาด เก็บคิวในเบราว์เซอร์แล้วส่งซ้ำอัตโนมัติ</p>
      </form>}
      {settingsMessage && <p role="status" className="mb-4 text-sm text-accent">{settingsMessage}</p>}
      {sync.dropped > 0 && <p role="alert" className="mb-4 text-sm text-orange-200">มีการอัปเดต {sync.dropped} รายการที่คิวเต็มและบันทึกไม่ได้ โปรดตรวจการเชื่อมต่อและพื้นที่จัดเก็บ</p>}
      {(sync.error || sync.storageError) && <p role="alert" className="mb-4 rounded-md border border-warn/40 px-4 py-3 text-sm text-orange-200">{sync.storageError || sync.error} · ลองเชื่อมต่อใหม่ ข้อมูลที่บันทึกในคิวสำเร็จยังอยู่</p>}
      <nav aria-label="มุมมองข้อมูล" className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-line bg-panel p-1.5 sm:grid-cols-4">
        {([{ id: 'today', text: 'ภาพรวมวันนี้' }, { id: 'stats', text: 'สถิติย้อนหลัง' }, { id: 'events', text: 'ข้อมูลรายบุคคล' }, { id: 'local', text: 'ประวัติในเครื่อง' }] as const).map(tab => <button key={tab.id} onClick={() => changeView(tab.id)} aria-current={view === tab.id ? 'page' : undefined} className={`min-h-11 rounded-lg px-3 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${view === tab.id ? 'bg-accent text-ink' : 'text-slate-300 hover:bg-ink hover:text-white'}`}>{tab.text}</button>)}
      </nav>
      <>
        <details key={view} open={view !== 'today'} className="mb-5 rounded-xl border border-line bg-panel">
          <summary className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-white sm:px-5"><span>ตัวกรองข้อมูล <span className="ml-2 font-normal text-slate-400">{view === 'today' ? 'วันนี้' : `${effective.from} ถึง ${effective.to}`} · {applied.camera || 'ทุกกล้อง'}</span></span><span className="text-xs font-medium text-accent">เปิด / ปิด</span></summary>
        <form onSubmit={e => { e.preventDefault(); setApplied(filters); setPage(0); setDetailDay(''); }} className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-white">ตัวกรองข้อมูล</h3>
            {filtersDirty && <span role="status" className="text-xs font-medium text-warn">มีการแก้ตัวกรองที่ยังไม่ใช้</span>}
          </div>
          <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${view === 'today' ? 'xl:grid-cols-4' : 'xl:grid-cols-5'}`}>
            {view === 'today' ? <div className="flex min-h-11 flex-col justify-center rounded-md bg-ink px-3 py-1.5"><span className="text-[11px] text-slate-500">ช่วงเวลา</span><span className="text-sm font-medium text-slate-200">วันนี้ · {currentDay}</span></div> : <>
              <label className="text-xs text-slate-300">ตั้งแต่<input aria-label="วันที่เริ่มต้น" type="date" required max={filters.to} value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className={`${control} mt-1 w-full`} /></label>
              <label className="text-xs text-slate-300">ถึง<input aria-label="วันที่สิ้นสุด" type="date" required min={filters.from} max={currentDay} value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className={`${control} mt-1 w-full`} /></label>
            </>}
            <label className="text-xs text-slate-300">กล้อง<input value={filters.camera} placeholder="ทุกกล้อง" list="known-cameras" onChange={e => setFilters(f => ({ ...f, camera: e.target.value }))} className={`${control} mt-1 w-full`} /><datalist id="known-cameras">{data?.cameras.map(c => <option key={c.cameraId} value={c.cameraId} />)}</datalist></label>
            <FilterSelect label="โหมดจำแนก" value={filters.attireMode} onChange={value => setFilters(f => ({ ...f, attireMode: value }))} options={{ student: 'ชุดนักศึกษา', medical: 'บุคลากรทางการแพทย์' }} />
            <FilterSelect label="แหล่งภาพ" value={filters.source} onChange={value => setFilters(f => ({ ...f, source: value }))} options={{ camera: 'กล้องสด', image: 'รูปภาพ' }} />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3">
            <span className="text-xs text-slate-500">ผลจำแนก</span>
            {classes.map(cls => <label key={cls} className="inline-flex min-h-8 items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={filters.attire.includes(cls)} onChange={e => setFilters(f => ({ ...f, attire: e.target.checked ? [...f.attire, cls] : f.attire.filter(c => c !== cls) }))} className="h-4 w-4 accent-accent" /><span className="h-2 w-2 rounded-full" style={{ background: colors[cls] }} />{className(cls, filters.attireMode)}</label>)}
          </div>
          <details className="border-t border-line pt-2">
            <summary className="py-1 text-sm font-medium text-slate-300">ตัวกรองเพิ่มเติม <span className="ml-1 text-xs font-normal text-slate-500">เพศ อายุ และความมั่นใจ</span></summary>
            <div className="mt-2 grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-3">
              <FilterSelect label="เพศที่ AI ประเมิน" value={filters.gender} onChange={value => setFilters(f => ({ ...f, gender: value }))} options={{ male: 'ชาย', female: 'หญิง', unisex: 'ไม่ระบุเพศ', uncertain: 'ไม่แน่ใจ' }} />
              <FilterSelect label="ช่วงอายุที่ AI ประเมิน" value={filters.ageGroup} onChange={value => setFilters(f => ({ ...f, ageGroup: value }))} options={{ teen: 'วัยรุ่น', adult: 'ผู้ใหญ่', elderly: 'ผู้สูงอายุ', uncertain: 'ไม่แน่ใจ' }} />
              <label className="text-xs text-slate-300">ความมั่นใจ YOLO ขั้นต่ำ<input aria-label="ความมั่นใจ YOLO ขั้นต่ำ" type="number" min="0" max="1" step="0.05" value={filters.minConfidence} onChange={e => setFilters(f => ({ ...f, minConfidence: e.target.value }))} placeholder="0–1" className={`${control} mt-1 w-full`} /></label>
            </div>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-slate-500">ช่วงด่วน</span><button type="button" className="min-h-9 rounded-md px-2.5 text-xs font-medium text-slate-300 hover:bg-ink hover:text-white" onClick={() => selectRange(currentDay, currentDay)}>วันนี้</button><button type="button" className="min-h-9 rounded-md px-2.5 text-xs font-medium text-slate-300 hover:bg-ink hover:text-white" onClick={() => selectRange(shiftDay(currentDay, -6), currentDay)}>7 วัน</button><button type="button" className="min-h-9 rounded-md px-2.5 text-xs font-medium text-slate-300 hover:bg-ink hover:text-white" onClick={() => selectRange(shiftDay(currentDay, -29), currentDay)}>30 วัน</button><button type="button" className="min-h-9 rounded-md px-2.5 text-xs font-medium text-slate-500 hover:text-warn" onClick={() => { const next = initialFilters(); setFilters(next); setApplied(next); setPage(0); setDetailDay(''); }}>ล้าง</button></div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="min-h-10 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-ink transition hover:bg-[#06695c]">{filtersDirty ? 'ใช้ตัวกรอง' : 'รีเฟรชข้อมูล'}</button>
            </div>
          </div>
        </form>
        </details>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold text-white">{view === 'events' ? 'ผลการค้นหา' : detailDay ? `รายละเอียดวันที่ ${detailDay}` : view === 'today' ? 'การตรวจจับวันนี้' : `${effective.from} ถึง ${effective.to}`}</h3><p className="mt-1 text-xs text-slate-300">{data ? `อัปเดต ${format(data.asOf)} · รีเฟรชทุก 30 วินาที` : 'แสดงข้อมูลจาก SQL หลังเชื่อมต่อสำเร็จ'}</p></div>
          <div className="flex gap-2">{detailDay && <><button className={action} onClick={() => drill(shiftDay(detailDay, -1))}>วันก่อนหน้า</button><button className={action} disabled={detailDay >= currentDay} onClick={() => drill(shiftDay(detailDay, 1))}>วันถัดไป</button></>}<button className={action} disabled={loading || !sync.authorized} onClick={() => setRefresh(n => n + 1)}>{loading ? 'กำลังโหลด…' : 'รีเฟรช'}</button></div>
        </div>
        {!sync.authorized ? <Empty title="เข้าสู่ระบบเพื่อดูข้อมูลทุกกล้อง" text="ประวัติเดิมยังดูได้หลังแอดมินเข้าสู่ระบบ" /> : noneSelected ? <Empty title="ยังไม่ได้เลือกประเภทผลจำแนก" text="เลือกอย่างน้อยหนึ่งประเภท แล้วกดใช้ตัวกรอง" /> : error ? <div role="alert" className="rounded-md border border-warn/40 p-6 text-orange-200">{error}<p className="mt-2 text-sm">ตรวจบริการ Data API แล้วกดรีเฟรชอีกครั้ง</p></div> : loading ? <p role="status" className="py-16 text-center text-slate-300">กำลังอ่านข้อมูลจากฐานข้อมูล…</p> : data && <>
          {view !== 'events' && <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-4">
            <Metric label="เหตุการณ์ทั้งหมด" value={total(data.totals)} />{classes.map((cls, index) => <Metric key={cls} label={className(cls, applied.attireMode)} value={data.totals[cls]} color={colors[cls]} className={index === classes.length - 1 ? 'col-span-2 sm:col-span-1' : ''} />)}
          </div>}
          {view !== 'events' && <details className="mb-5 text-xs text-slate-500"><summary className="cursor-pointer py-1">วิธีอ่านข้อมูล</summary><p className="mt-1 max-w-4xl leading-relaxed">นับหนึ่งเหตุการณ์ต่อ track ในแต่ละรอบกล้อง คนเดิมอาจถูกนับใหม่เมื่อ track หายหรือเริ่มรอบใหม่ · เพศและช่วงอายุเป็นการประเมินของ AI · ระบบเก็บภาพ crop ขนาดเล็กของแต่ละเหตุการณ์</p></details>}
          {view === 'today' && <div className="mb-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,1fr)]">
            <section className="min-w-0 rounded-xl border border-line bg-panel p-4 sm:p-5"><div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold text-white">จำนวนรายชั่วโมง</h3><p className="text-xs text-slate-400">วันนี้ · {currentDay}</p></div><TrendChart buckets={data.buckets} selected={applied.attire} mode={applied.attireMode} onDay={drill} bars /><Legend mode={applied.attireMode} selected={applied.attire} /></section>
            <section className="min-w-0 rounded-xl border border-line bg-panel p-4 sm:p-5"><div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="font-semibold text-white">ตรวจพบล่าสุด</h3><span className="text-xs text-slate-500">{data.latest.length} รายการ</span></div>{data.latest.length ? <ul className="divide-y divide-line">{data.latest.map(e => <li key={e.eventId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 text-sm"><span className="font-mono text-xs text-slate-500">{format(e.firstSeen, true)}</span><span className="min-w-0 truncate text-slate-300">{e.cameraId} · #{e.trackId}</span><span className="text-right text-xs font-medium" style={{ color: colors[e.attire] }}>{className(e.attire, e.attireMode)}</span></li>)}</ul> : <p className="py-6 text-sm text-slate-400">ยังไม่มีข้อมูลในช่วงที่เลือก</p>}<button onClick={() => changeView('events')} className="mt-3 min-h-10 text-sm font-semibold text-accent underline underline-offset-4 hover:text-white">ดูตารางข้อมูลรายบุคคล ภาพ crop และเวลา SQL</button></section>
          </div>}
          {view !== 'today' && view !== 'events' && <section className="mb-6 rounded-xl border border-line bg-panel p-4 sm:p-5"><div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold text-white">{data.granularity === 'hour' ? 'จำนวนรายชั่วโมง' : 'แนวโน้มรายวัน'}</h3><p className="text-xs text-slate-400">เลือกจุดบนกราฟเพื่อดูรายละเอียดวันนั้น</p></div><TrendChart buckets={data.buckets} selected={applied.attire} mode={applied.attireMode} onDay={drill} bars={!!detailDay} /><Legend mode={applied.attireMode} selected={applied.attire} /></section>}
          {view !== 'events' && <DashboardBreakdown
            data={data}
            mode={applied.attireMode}
            onDay={drill}
            onCamera={id => { const next = { ...applied, camera: id }; setFilters(next); setApplied(next); setPage(0); }}
          />}
          {view === 'events' && <section className="overflow-hidden rounded-lg border border-line bg-panel"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5"><div><h3 className="font-semibold text-white">ข้อมูลรายบุคคล</h3><p className="mt-1 text-xs text-slate-400">{eventPage?.total.toLocaleString() ?? 0} เหตุการณ์ · เลือกหัวคอลัมน์เพื่อเรียงลำดับ</p></div><label className="text-sm text-slate-300">แถวต่อหน้า <select aria-label="จำนวนแถวต่อหน้า" className={`${control} ml-2`} value={size} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}>{[25, 50, 100].map(n => <option key={n}>{n}</option>)}</select></label></div>
            {eventPage?.rows.length ? <>
              <div className="max-h-[36rem] divide-y divide-line overflow-y-auto lg:hidden">
                {eventPage.rows.map(event => <EventCard key={event.eventId} event={event} onViewImage={setSelectedImageEvent} />)}
              </div>
              <div className="hidden max-h-[36rem] overflow-auto lg:block">
                <table className="w-full min-w-[1260px] text-left text-sm">
                  <caption className="sr-only">ข้อมูลบุคคลที่ตรวจพบตามตัวกรองที่เลือก</caption>
                  <thead className="sticky top-0 bg-panel text-xs text-slate-500"><tr>{[['', 'ภาพ crop'], ['firstSeen', 'พบครั้งแรก'], ['lastSeen', 'พบล่าสุด'], ['cameraId', 'กล้อง'], ['trackId', 'Track'], ['attire', 'ผลจำแนก'], ['', 'โหมด'], ['', 'เพศ / อายุ'], ['confidence', 'YOLO'], ['', 'แหล่งภาพ'], ['receivedAt', 'บันทึกเข้า SQL']].map(([column, label]) => <th key={label} scope="col" className="px-4 py-3 font-medium" aria-sort={column && sort === column ? direction === 'desc' ? 'descending' : 'ascending' : undefined}>{column ? <button className="min-h-10 whitespace-nowrap rounded px-1 py-1 text-left hover:text-accent focus-visible:outline focus-visible:outline-accent" onClick={() => sortBy(column)}>{label}{sort === column ? direction === 'desc' ? ' ↓' : ' ↑' : ''}</button> : label}</th>)}</tr></thead>
                  <tbody>{eventPage.rows.map(event => <EventRow key={event.eventId} event={event} onViewImage={setSelectedImageEvent} />)}</tbody>
                </table>
              </div>
            </> : <p className="p-8 text-center text-sm text-slate-300">ไม่มีเหตุการณ์ตรงกับตัวกรองนี้</p>}
            <nav aria-label="หน้าข้อมูลรายบุคคล" className="flex items-center justify-between gap-3 border-t border-line p-4 text-sm text-slate-300"><span>หน้า {page + 1} จาก {Math.max(1, Math.ceil((eventPage?.total ?? 0) / size))}</span><div className="flex gap-2"><button className={action} disabled={page === 0} onClick={() => setPage(p => p - 1)}>ก่อนหน้า</button><button className={action} disabled={(page + 1) * size >= (eventPage?.total ?? 0)} onClick={() => setPage(p => p + 1)}>ถัดไป</button></div></nav>
          </section>}
        </>}
      </>
      {selectedImageEvent && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="presentation" onClick={() => setSelectedImageEvent('')}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label="ภาพ crop ของเหตุการณ์" tabIndex={-1} className="relative max-h-[90vh] max-w-[90vw] rounded-xl border border-line bg-panel p-3 shadow-2xl" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); dialogRef.current?.querySelector<HTMLElement>('button')?.focus(); } }}><button className={`${action} absolute right-5 top-5 z-10 bg-ink/90`} aria-label="ปิดภาพ" onClick={() => setSelectedImageEvent('')}>ปิด</button>{modalImageError ? <p role="alert" className="px-16 py-20 text-center text-sm text-slate-300">โหลดภาพ crop ไม่สำเร็จ</p> : <img className="max-h-[84vh] max-w-[86vw] rounded object-contain" src={`/api/data/events/${selectedImageEvent}/image`} alt={`ภาพ crop ของเหตุการณ์ ${selectedImageEvent}`} onError={() => setModalImageError(true)} />}</section></div>}
    </main>
  );
}
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return <label className="text-xs text-slate-300">{label}<select className={`${control} mt-1 w-full`} value={value} onChange={e => onChange(e.target.value)}><option value="">ทั้งหมด</option>{Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}
function DashboardBreakdown({ data, mode, onDay, onCamera }: {
  data: DashboardData;
  mode: string;
  onDay: (day: string) => void;
  onCamera: (camera: string) => void;
}) {
  const cameraMax = Math.max(1, ...data.cameraSeries.flatMap(series => series.buckets.map(bucket => bucket.count)));
  const hourly = data.granularity === 'hour';
  return <div className="mb-6 grid min-w-0 items-stretch gap-5 xl:grid-cols-2">
      <section className="overflow-hidden rounded-xl border border-line bg-panel xl:col-span-2" aria-labelledby="demographic-title">
        <div className="border-b border-line px-5 py-4"><h3 id="demographic-title" className="font-semibold text-white">เพศและช่วงอายุที่ AI ประเมิน</h3><p className="mt-1 text-xs text-slate-400">จำนวนเหตุการณ์ตามตัวกรองที่เลือก</p></div>
        <div className="grid gap-6 p-5 sm:grid-cols-2">
          <div><h4 className="mb-4 text-sm font-semibold text-slate-200">เพศ</h4><Distribution compact rows={['male', 'female', 'unisex', 'uncertain'].map(gender => ({ label: labels[gender], count: data.demographics.filter(item => item.gender === gender).reduce((sum, item) => sum + Number(item.count), 0) }))} /></div>
          <div><h4 className="mb-4 text-sm font-semibold text-slate-200">ช่วงอายุ</h4><Distribution compact rows={['teen', 'adult', 'elderly', 'uncertain'].map(age => ({ label: labels[age], count: data.demographics.filter(item => item.ageGroup === age).reduce((sum, item) => sum + Number(item.count), 0) }))} /></div>
        </div>
      </section>
    <section className="min-w-0 overflow-hidden rounded-xl border border-line bg-panel" aria-labelledby="camera-breakdown-title">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-baseline justify-between gap-3"><h3 id="camera-breakdown-title" className="font-semibold text-white">จำนวนแยกตามกล้อง</h3><span className="text-xs text-slate-400">{data.cameras.length} กล้อง</span></div>
        <p className="mt-1 text-xs text-slate-400">เลือกชื่อกล้องเพื่อกรองข้อมูล</p>
      </div>
      <div className="p-5"><Distribution rows={data.cameras.map(camera => ({ label: camera.cameraId, count: Number(camera.count) }))} onSelect={onCamera} /></div>
      {data.cameraSeries.length > 0 && <div className="border-t border-line">
        <div className="px-5 pt-5"><h4 className="text-sm font-semibold text-white">แนวโน้มแยกตามกล้อง</h4><p className="mt-1 text-xs leading-relaxed text-slate-400">ใช้สเกลเดียวกันทุกกล้อง · จำนวนเหตุการณ์บุคคล ไม่ใช่ยอดเข้า–ออก</p></div>
        <div className="divide-y divide-line">{data.cameraSeries.map(series => <div key={series.cameraId} className="min-w-0 px-4 py-5 sm:px-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><h5 className="break-all text-sm font-medium text-slate-200">{series.cameraId}</h5><span className="text-xs text-slate-400">เลือกจุดเพื่อดูรายละเอียด</span></div>
          <TrendChart buckets={series.buckets.map(bucket => ({ key: bucket.key, date: bucket.date, target: bucket.count, other: 0, uncertain: 0, unclassified: 0 }))} selected={['target']} mode="camera-count" onDay={onDay} maxValue={cameraMax} />
        </div>)}</div>
      </div>}
    </section>


      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel" aria-labelledby="summary-table-title">
        <div className="shrink-0 border-b border-line px-5 py-4"><h3 id="summary-table-title" className="font-semibold text-white">{hourly ? 'ตารางสรุปรายชั่วโมง' : 'ตารางสรุปรายวัน'}</h3><p className="mt-1 text-xs text-slate-400">{hourly ? 'เลือกเวลาเพื่อดูรายละเอียดของวันนั้น' : 'เลือกวันที่เพื่อดูรายละเอียด'} · แสดงครบทุกช่วงเวลา</p></div>
        <div className="h-96 min-h-0 flex-auto overflow-auto">
          <table className="w-full min-w-[480px] border-collapse text-right text-sm tabular-nums">
            <caption className="sr-only">{hourly ? 'สรุปจำนวนเหตุการณ์รายชั่วโมง' : 'สรุปจำนวนเหตุการณ์รายวัน'}</caption>
            <thead className="sticky top-0 z-10 bg-ink text-xs text-slate-300"><tr><th scope="col" className="px-4 py-3 text-left font-medium">{hourly ? 'เวลา' : 'วันที่'}</th>{classes.map(category => <th key={category} scope="col" className="px-3 py-3 font-medium">{className(category, mode)}</th>)}<th scope="col" className="px-4 py-3 font-semibold">รวม</th></tr></thead>
            <tbody>{[...data.buckets].reverse().map(bucket => {
              const count = total(bucket);
              return <tr key={bucket.key} className={`border-t border-line transition-colors hover:bg-accent/10 ${count > 0 ? 'bg-accent/5 text-slate-100' : 'text-slate-400'}`}>
                <td className="px-4 py-1"><button className="min-h-10 whitespace-nowrap text-left font-medium text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent" onClick={() => onDay(bucket.date)}>{bucket.key}</button></td>
                {classes.map(category => <td key={category} className="px-3 py-3">{bucket[category].toLocaleString()}</td>)}
                <td className={`px-4 py-3 ${count > 0 ? 'font-semibold text-accent' : ''}`}>{count.toLocaleString()}</td>
              </tr>;
            })}</tbody>
            <tfoot className="sticky bottom-0 border-t border-line bg-ink font-semibold text-slate-100"><tr><th scope="row" className="px-4 py-3 text-left">รวม</th>{classes.map(category => <td key={category} className="px-3 py-3">{data.buckets.reduce((sum, bucket) => sum + Number(bucket[category]), 0).toLocaleString()}</td>)}<td className="px-4 py-3 text-accent">{data.buckets.reduce((sum, bucket) => sum + total(bucket), 0).toLocaleString()}</td></tr></tfoot>
          </table>
        </div>
      </section>

  </div>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="rounded-md border border-dashed border-line px-6 py-14 text-center"><h3 className="font-semibold text-white">{title}</h3><p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">{text}</p></div>; }
function Metric({ label, value, color, className = '' }: { label: string; value: number; color?: string; className?: string }) { return <div className={`min-h-20 bg-panel px-4 py-3 sm:py-4 ${className}`}><p className="text-xs leading-relaxed text-slate-400">{label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white" style={{ color }}>{value.toLocaleString()}</p></div>; }
function Legend({ selected, mode }: { selected: string[]; mode: string }) { return <div className="mt-4 flex flex-wrap justify-center gap-5 text-xs text-slate-200">{classes.filter(c => selected.includes(c)).map(c => <span key={c} className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: colors[c] }} />{className(c, mode)}</span>)}</div>; }
function TrendChart({ buckets, selected, mode, onDay, bars = false, maxValue }: { buckets: EventBucket[]; selected: string[]; mode: string; onDay: (day: string) => void; bars?: boolean; maxValue?: number }) {
  const active = classes.filter(c => selected.includes(c));
  const max = maxValue ?? Math.max(1, ...buckets.flatMap(b => bars ? [active.reduce((n, c) => n + b[c], 0)] : active.map(c => b[c])));
  const x = (i: number) => 48 + (buckets.length === 1 ? 0.5 : i / (buckets.length - 1)) * 834;
  const y = (n: number) => 225 - n / max * 195;
  return <div className="overflow-x-auto"><svg viewBox="0 0 920 270" className="min-w-[540px] w-full" role="img" aria-label="กราฟจำนวนเหตุการณ์ตามเวลา ดูค่าที่แน่นอนได้จากตารางสรุปด้านล่าง">
    {Array.from({ length: Math.min(4, max) + 1 }, (_, i) => i / Math.min(4, max)).map(t => <g key={t}><line x1="48" x2="882" y1={y(t * max)} y2={y(t * max)} stroke="#dce5df" /><text x="40" y={y(t * max) + 4} textAnchor="end" fill="#52685f" fontSize="11">{Math.round(t * max)}</text></g>)}
    {!bars && active.map(c => <polyline key={c} points={buckets.map((b, i) => `${x(i)},${y(b[c])}`).join(' ')} fill="none" stroke={colors[c]} strokeWidth="2.5" />)}
    {bars && buckets.map((b, i) => { let cumulative = 0; return <g key={b.key}>{active.map(c => { const bottom = cumulative; cumulative += b[c]; return <rect key={c} x={x(i) - 10} y={y(cumulative)} width="20" height={y(bottom) - y(cumulative)} fill={colors[c]} />; })}</g>; })}
    {buckets.map((b, i) => <g key={b.key} role="button" tabIndex={0} aria-label={`${b.key}: ${active.map(c => `${className(c, mode)} ${b[c]}`).join(', ')} เปิดรายละเอียด`} onClick={() => onDay(b.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDay(b.date); } }} className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-accent"><rect x={x(i) - Math.max(3, 380 / buckets.length)} y="15" width={Math.max(6, 760 / buckets.length)} height="220" fill="transparent" /><title>{b.key}: {active.map(c => `${className(c, mode)} ${b[c]}`).join(' · ')}</title>{!bars && buckets.length <= 31 && active.map(c => <circle key={c} cx={x(i)} cy={y(b[c])} r="3" fill={colors[c]} />)}{i % Math.max(1, Math.ceil(buckets.length / 8)) === 0 && <text x={x(i)} y="253" textAnchor="middle" fill="#52685f" fontSize="11">{b.key.length > 5 ? b.key.slice(5) : b.key}</text>}</g>)}
  </svg></div>;
}
function Distribution({ rows, onSelect, compact = false }: { rows: { label: string; count: number }[]; onSelect?: (label: string) => void; compact?: boolean }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  if (!rows.length) return <p className="py-4 text-sm text-slate-300">ยังไม่มีข้อมูล</p>;
  return <div className={compact ? 'grid gap-x-6 gap-y-4 sm:grid-cols-2' : 'space-y-4'}>{rows.map(r => <div key={r.label}><div className="mb-2 flex justify-between gap-4 text-sm text-slate-200">{onSelect ? <button className="min-h-10 break-all text-left underline underline-offset-4 hover:text-accent" onClick={() => onSelect(r.label)}>{r.label}</button> : <span>{r.label}</span>}<span className="self-center font-medium tabular-nums">{r.count.toLocaleString()}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${r.count / max * 100}%` }} /></div></div>)}</div>;
}
function EventCard({ event: e, onViewImage }: { event: PersonEvent; onViewImage: (id: string) => void }) {
  const [imageError, setImageError] = useState(false);
  const attireColor = colors[e.attire] ?? colors.uncertain;
  return (
    <article className="flex gap-3 p-4">
      {e.imageAvailable && !imageError ? (
        <button onClick={() => onViewImage(e.eventId)} aria-label={`เปิดภาพ crop ของ Track ${e.trackId}`} className="flex h-28 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-ink p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <img src={`/api/data/events/${e.eventId}/image`} alt={`ภาพ crop Track ${e.trackId}`} className="h-full w-full object-contain" loading="lazy" onError={() => setImageError(true)} />
        </button>
      ) : (
        <span className="flex h-28 w-24 shrink-0 items-center justify-center rounded-md border border-dashed border-line px-1 text-center text-xs text-slate-500">ไม่มีภาพ</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold" style={{ color: attireColor }}>{className(e.attire, e.attireMode)}</p>
            <p className="mt-1 break-all text-xs text-slate-400">{e.cameraId} · Track #{e.trackId}</p>
          </div>
          <span className="rounded-full bg-ink px-2 py-1 font-mono text-xs text-slate-500">YOLO {(e.confidence * 100).toFixed(1)}%</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div><dt className="text-slate-500">พบครั้งแรก</dt><dd className="mt-0.5 text-slate-200">{format(e.firstSeen)}</dd></div>
          <div><dt className="text-slate-500">พบล่าสุด</dt><dd className="mt-0.5 text-slate-200">{format(e.lastSeen)}</dd></div>
          <div><dt className="text-slate-500">โหมด</dt><dd className="mt-0.5 text-slate-200">{e.attireMode === 'student' ? 'ชุดนักศึกษา' : 'บุคลากรทางการแพทย์'}</dd></div>
          <div><dt className="text-slate-500">เพศ / อายุที่ AI ประเมิน</dt><dd className="mt-0.5 text-slate-200">{labels[e.gender] ?? 'ไม่ระบุ'} / {labels[e.ageGroup] ?? 'ไม่ระบุ'}</dd></div>
          <div><dt className="text-slate-500">แหล่งภาพ</dt><dd className="mt-0.5 text-slate-200">{e.source === 'camera' ? 'กล้องสด' : 'รูปภาพ'}</dd></div>
          <div><dt className="text-slate-500">บันทึกเข้า SQL</dt><dd className="mt-0.5 text-slate-200">{e.receivedAt ? format(e.receivedAt) : '—'}</dd></div>
        </dl>
      </div>
    </article>
  );
}
function EventRow({ event: e, onViewImage }: { event: PersonEvent; onViewImage: (id: string) => void }) {
  const [imageError, setImageError] = useState(false);
  return <tr className="border-t border-line/70 text-sm text-slate-200 transition-colors hover:bg-ink/60"><td className="px-4 py-2">{e.imageAvailable && !imageError ? <button onClick={() => onViewImage(e.eventId)} aria-label={`เปิดภาพ crop ของ Track ${e.trackId}`} className="flex h-28 w-24 items-center justify-center rounded-md border border-line bg-ink p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><img className="h-full w-full rounded object-contain" src={`/api/data/events/${e.eventId}/image`} alt={`ภาพ crop Track ${e.trackId}`} loading="lazy" onError={() => setImageError(true)} /></button> : <span className="inline-flex h-28 w-24 items-center justify-center rounded-md border border-dashed border-line px-1 text-center text-xs text-slate-400" title="ไม่มีภาพ crop สำหรับเหตุการณ์นี้">ไม่มีภาพ</span>}</td><td className="whitespace-nowrap px-4 py-3">{format(e.firstSeen)}</td><td className="whitespace-nowrap px-4 py-3">{format(e.lastSeen)}</td><td className="px-4 py-3">{e.cameraId}</td><td className="px-4 py-3 font-mono" title={`เหตุการณ์ ${e.eventId}`}>#{e.trackId}<span className="mt-1 block text-[10px] text-slate-500">รอบ {e.sessionId.slice(-6)} / {e.trackEpoch}</span></td><td className="whitespace-nowrap px-4 py-3 font-medium" style={{ color: colors[e.attire] }}>{className(e.attire, e.attireMode)}</td><td className="px-4 py-3">{e.attireMode === 'student' ? 'ชุดนักศึกษา' : 'บุคลากรทางการแพทย์'}</td><td className="whitespace-nowrap px-4 py-3">{labels[e.gender] ?? 'ไม่ระบุ'} / {labels[e.ageGroup] ?? 'ไม่ระบุ'}</td><td className="px-4 py-3 font-mono">{(e.confidence * 100).toFixed(1)}%</td><td className="px-4 py-3">{e.source === 'camera' ? 'กล้องสด' : 'รูปภาพ'}</td><td className="whitespace-nowrap px-4 py-3">{e.receivedAt ? format(e.receivedAt) : '—'}</td></tr>;
}
