import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DetectionHistoryEntry } from '../utils/detectionHistory';
import type { DashboardData, EventBucket, EventCounts, EventPage, PersonEvent } from '../utils/personEvents';
import { connectData, dataRequest, disconnectData, flushEvents, getCameraId, getSyncState, loginData, setCameraId, subscribeSync } from '../utils/dataSync';
import LocalHistoryDashboard from './LocalHistoryDashboard';

interface Props {
  history: DetectionHistoryEntry[];
  onStartDetection: (mode: 'image' | 'camera') => void;
  onClearHistory: () => void;
}
type View = 'today' | 'stats' | 'events' | 'local';
const classes = ['target', 'other', 'uncertain'] as const;
const labels: Record<string, string> = { target: 'กลุ่มเป้าหมาย', other: 'กลุ่มอื่น', uncertain: 'ไม่แน่ใจ', unclassified: 'รอจำแนก', male: 'ชาย', female: 'หญิง', unisex: 'ไม่ระบุเพศ', teen: 'วัยรุ่น', adult: 'ผู้ใหญ่', elderly: 'ผู้สูงอายุ' };
const colors = { target: '#5eead4', other: '#fb923c', uncertain: '#fcd34d', unclassified: '#94a3b8' };
const control = 'rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
const action = 'rounded-md border border-line px-3 py-2 text-sm text-slate-200 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
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
  const [view, setView] = useState<View>('today');
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
  const [clock, setClock] = useState(Date.now());
  const [selectedImageEvent, setSelectedImageEvent] = useState('');
  const currentDay = today();
  useEffect(() => {
    if (!selectedImageEvent) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedImageEvent(''); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedImageEvent]);
  const effective = view === 'today' ? { ...applied, from: currentDay, to: currentDay } : applied;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(effective)) {
    if (Array.isArray(value)) value.forEach(item => query.append(name, item));
    else if (value) query.set(name, value);
  }
  const queryKey = query.toString();
  const noneSelected = applied.attire.length === 0;
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
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
      dataRequest<EventPage>(`/events?${queryKey}&page=${page}&size=${size}&sort=${sort}&direction=${direction}`, { signal: controller.signal }),
    ]).then(([summary, events]) => { if (!disposed) { setData(summary); setEventPage(events); } })
      .catch(e => { if (!disposed) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [sync.authorized, view, queryKey, page, size, sort, direction, refresh, noneSelected]);
  function changeView(next: View) { setView(next); setPage(0); setDetailDay(''); }
  function selectRange(from: string, to: string) {
    const next = { ...filters, from, to }; setFilters(next); setApplied(next); setPage(0); setDetailDay(''); setView('stats');
  }
  function drill(day: string) {
    const next = { ...applied, from: day, to: day }; setFilters(next); setApplied(next); setPage(0); setDetailDay(day); setView('stats');
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
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="font-display text-2xl font-semibold text-white">Dashboard</h2><p className="mt-2 text-sm text-slate-300">ผลตรวจจับรายบุคคลจากทุกกล้อง · เวลาไทย</p></div>
        <div className="flex flex-wrap gap-2">
          <button className={action} onClick={() => props.onStartDetection('image')}>ตรวจจับจากรูปภาพ</button>
          <button className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-ink hover:bg-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => props.onStartDetection('camera')}>เปิดกล้องสด</button>
        </div>
      </div>
      <div className="my-5 flex flex-wrap items-center justify-between gap-3 border-y border-line py-3 text-xs text-slate-300" aria-live="polite">
        <p>กล้องเครื่องนี้ <strong className="text-white">{getCameraId()}</strong> · {sync.authorized ? sync.sending ? 'กำลังส่งข้อมูล' : 'เปิดการส่งข้อมูล' : 'ยังไม่เชื่อมต่อฐานข้อมูล'} · รอส่ง {sync.pending.toLocaleString()} รายการ{sync.lastSent > 0 && ` · ส่งล่าสุด ${format(sync.lastSent, true)}`}</p>
        <div className="flex gap-3">{sync.authorized && <><button className="underline underline-offset-4 hover:text-accent" onClick={() => setSettings(!settings)}>ตั้งค่ารหัสกล้อง</button><button className="underline underline-offset-4 hover:text-accent" onClick={() => void flushEvents()}>ส่งคิวตอนนี้</button><button className="underline underline-offset-4 hover:text-accent" onClick={() => void disconnectData()}>ออกจากระบบแอดมิน</button></>}</div>
      </div>
      {!sync.authorized && <form onSubmit={submitLogin} className="mb-6 grid max-w-xl gap-4 rounded-md border border-line bg-panel p-5">
        <div><h3 className="font-semibold text-white">เข้าสู่ระบบแอดมิน</h3><p className="mt-1 text-sm text-slate-300">กรอกรหัสแอดมินที่ตั้งไว้ใน `.env.server` เพื่อดูข้อมูลจาก TiDB</p></div>
        <label className="text-sm text-slate-200">ชื่อผู้ใช้<input value="admin" readOnly autoComplete="username" className={`${control} mt-2 w-full opacity-80`} /></label>
        <label className="text-sm text-slate-200">รหัสผ่าน<input type="password" value={password} required autoComplete="current-password" onChange={e => setPassword(e.target.value)} className={`${control} mt-2 w-full`} /></label>
        <button disabled={connecting} className={`${action} justify-self-start`}>{connecting ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}</button>
      </form>}
      {settings && <form onSubmit={saveConnection} className="mb-6 grid gap-4 rounded-md border border-line bg-panel p-5 sm:grid-cols-[1fr_auto]">
        <label className="text-sm text-slate-200">รหัสกล้องของเครื่องนี้<input value={camera} maxLength={64} required onChange={e => setCamera(e.target.value)} className={`${control} mt-2 w-full`} placeholder="เช่น rdk-lobby-01" /></label>
        <div className="flex items-end"><button disabled={connecting} className={action}>{connecting ? 'กำลังตรวจสอบ…' : 'ตรวจการเชื่อมต่อ / บันทึก'}</button></div>
        <p className="text-xs leading-relaxed text-slate-300 sm:col-span-2">เว็บเชื่อมฐานข้อมูลให้อัตโนมัติ · รหัสกล้องนี้ใช้กับรอบใหม่ · เมื่อเน็ตขาด เก็บคิวในเบราว์เซอร์แล้วส่งซ้ำอัตโนมัติ</p>
      </form>}
      {settingsMessage && <p role="status" className="mb-4 text-sm text-accent">{settingsMessage}</p>}
      {sync.dropped > 0 && <p role="alert" className="mb-4 text-sm text-orange-200">มีการอัปเดต {sync.dropped} รายการที่คิวเต็มและบันทึกไม่ได้ โปรดตรวจการเชื่อมต่อและพื้นที่จัดเก็บ</p>}
      {(sync.error || sync.storageError) && <p role="alert" className="mb-4 rounded-md border border-warn/40 px-4 py-3 text-sm text-orange-200">{sync.storageError || sync.error} · ลองเชื่อมต่อใหม่ ข้อมูลที่บันทึกในคิวสำเร็จยังอยู่</p>}
      <nav aria-label="มุมมองข้อมูล" className="mb-6 flex flex-wrap gap-x-6 border-b border-line">
        {([{ id: 'today', text: 'ภาพรวมวันนี้' }, { id: 'stats', text: 'สถิติย้อนหลัง' }, { id: 'events', text: 'ข้อมูลรายบุคคล' }, { id: 'local', text: 'ประวัติในเครื่อง' }] as const).map(tab => <button key={tab.id} onClick={() => changeView(tab.id)} aria-current={view === tab.id ? 'page' : undefined} className={`border-b-2 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${view === tab.id ? 'border-accent text-accent' : 'border-transparent text-slate-300 hover:text-white'}`}>{tab.text}</button>)}
      </nav>
      {!sync.authorized ? <Empty title="เข้าสู่ระบบเพื่อดู Dashboard" text="ข้อมูลจาก TiDB แสดงหลังแอดมินเข้าสู่ระบบ" /> : view === 'local' ? <LocalHistoryDashboard {...props} /> : <>
        <form onSubmit={e => { e.preventDefault(); setApplied(filters); setPage(0); setDetailDay(''); }} className="mb-6 space-y-4 rounded-md bg-panel p-4 sm:p-5">
          <div className="flex flex-wrap gap-4">
            {classes.map(cls => <label key={cls} className="inline-flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={filters.attire.includes(cls)} onChange={e => setFilters(f => ({ ...f, attire: e.target.checked ? [...f.attire, cls] : f.attire.filter(c => c !== cls) }))} className="h-4 w-4 accent-teal-300" /><span className="h-2 w-2 rounded-full" style={{ background: colors[cls] }} />{className(cls, filters.attireMode)}</label>)}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <label className="text-xs text-slate-300">ตั้งแต่<input aria-label="วันที่เริ่มต้น" type="date" required disabled={view === 'today'} max={filters.to} value={view === 'today' ? currentDay : filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className={`${control} mt-1 w-full`} /></label>
            <label className="text-xs text-slate-300">ถึง<input aria-label="วันที่สิ้นสุด" type="date" required disabled={view === 'today'} min={filters.from} max={currentDay} value={view === 'today' ? currentDay : filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className={`${control} mt-1 w-full`} /></label>
            <label className="text-xs text-slate-300">กล้อง<input value={filters.camera} placeholder="ทุกกล้อง" list="known-cameras" onChange={e => setFilters(f => ({ ...f, camera: e.target.value }))} className={`${control} mt-1 w-full`} /><datalist id="known-cameras">{data?.cameras.map(c => <option key={c.cameraId} value={c.cameraId} />)}</datalist></label>
            <FilterSelect label="โหมดจำแนก" value={filters.attireMode} onChange={value => setFilters(f => ({ ...f, attireMode: value }))} options={{ student: 'ชุดนักศึกษา', medical: 'บุคลากรทางการแพทย์' }} />
            <FilterSelect label="แหล่งภาพ" value={filters.source} onChange={value => setFilters(f => ({ ...f, source: value }))} options={{ camera: 'กล้องสด', image: 'รูปภาพ' }} />
            <FilterSelect label="เพศที่ AI ประเมิน" value={filters.gender} onChange={value => setFilters(f => ({ ...f, gender: value }))} options={{ male: 'ชาย', female: 'หญิง', unisex: 'ไม่ระบุเพศ', uncertain: 'ไม่แน่ใจ' }} />
            <FilterSelect label="ช่วงอายุที่ AI ประเมิน" value={filters.ageGroup} onChange={value => setFilters(f => ({ ...f, ageGroup: value }))} options={{ teen: 'วัยรุ่น', adult: 'ผู้ใหญ่', elderly: 'ผู้สูงอายุ', uncertain: 'ไม่แน่ใจ' }} />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap gap-2"><button type="button" className={action} onClick={() => selectRange(currentDay, currentDay)}>วันนี้</button><button type="button" className={action} onClick={() => selectRange(shiftDay(currentDay, -6), currentDay)}>7 วัน</button><button type="button" className={action} onClick={() => selectRange(shiftDay(currentDay, -29), currentDay)}>30 วัน</button><button type="button" className={action} onClick={() => { const next = initialFilters(); setFilters(next); setApplied(next); setPage(0); setDetailDay(''); }}>ล้างตัวกรอง</button></div>
            <div className="flex items-end gap-3"><label className="text-xs text-slate-300">ความมั่นใจ YOLO ขั้นต่ำ<input type="number" min="0" max="1" step="0.05" value={filters.minConfidence} onChange={e => setFilters(f => ({ ...f, minConfidence: e.target.value }))} placeholder="0–1" className={`${control} ml-2 w-20`} /></label><button className={action}>ใช้ตัวกรอง</button></div>
          </div>
        </form>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold text-white">{detailDay ? `รายละเอียดวันที่ ${detailDay}` : view === 'today' ? 'การตรวจจับวันนี้' : `${effective.from} ถึง ${effective.to}`}</h3><p className="mt-1 text-xs text-slate-300">{data ? `อัปเดต ${format(data.asOf)} · รีเฟรชทุก 30 วินาที` : 'แสดงข้อมูลจาก SQL หลังเชื่อมต่อสำเร็จ'}</p></div>
          <div className="flex gap-2">{detailDay && <><button className={action} onClick={() => drill(shiftDay(detailDay, -1))}>วันก่อนหน้า</button><button className={action} disabled={detailDay >= currentDay} onClick={() => drill(shiftDay(detailDay, 1))}>วันถัดไป</button></>}<button className={action} disabled={loading || !sync.authorized} onClick={() => setRefresh(n => n + 1)}>{loading ? 'กำลังโหลด…' : 'รีเฟรช'}</button></div>
        </div>
        {!sync.authorized ? <Empty title="เข้าสู่ระบบเพื่อดูข้อมูลทุกกล้อง" text="ประวัติเดิมยังดูได้หลังแอดมินเข้าสู่ระบบ" /> : noneSelected ? <Empty title="ยังไม่ได้เลือกประเภทผลจำแนก" text="เลือกอย่างน้อยหนึ่งประเภท แล้วกดใช้ตัวกรอง" /> : error ? <div role="alert" className="rounded-md border border-warn/40 p-6 text-orange-200">{error}<p className="mt-2 text-sm">ตรวจบริการ Data API แล้วกดรีเฟรชอีกครั้ง</p></div> : loading ? <p role="status" className="py-16 text-center text-slate-300">กำลังอ่านข้อมูลจากฐานข้อมูล…</p> : data && <>
          <div className="mb-6 grid grid-cols-2 gap-y-5 border-y border-line py-5 sm:grid-cols-5">
            <Metric label="เหตุการณ์บุคคลทั้งหมด" value={total(data.totals)} />{classes.map(cls => <Metric key={cls} label={className(cls, applied.attireMode)} value={data.totals[cls]} color={colors[cls]} />)}
          </div>
          <p className="mb-6 text-xs leading-relaxed text-slate-300">นับหนึ่งเหตุการณ์ต่อ track ในแต่ละรอบกล้อง คนเดิมอาจถูกนับใหม่เมื่อ track หายหรือเริ่มรอบใหม่ · ผลชุด เพศ และช่วงอายุเป็นการประเมินของ AI · เก็บเฉพาะภาพ crop ขนาดเล็กของแต่ละเหตุการณ์</p>
          {view === 'today' && <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_2fr]">
            <section className="flex flex-col justify-between border-b border-line py-2 lg:border-b-0"><div><h3 className="text-lg font-medium text-white">วันนี้ · {currentDay}</h3><p className="mt-3 font-mono text-3xl text-accent">{format(clock, true)}</p><p className="mt-3 text-sm text-slate-300">ล่าสุด {data.latest[0] ? `${format(data.latest[0].firstSeen, true)} · ${data.latest[0].cameraId}` : 'ยังไม่มีเหตุการณ์'}</p></div><p className="mt-4 text-xs text-slate-300">ข้อมูลอัปเดตอัตโนมัติขณะเปิดหน้านี้</p></section>
            <section><h3 className="mb-3 font-semibold text-white">ตรวจพบล่าสุด</h3>{data.latest.length ? <ul className="divide-y divide-line">{data.latest.map(e => <li key={e.eventId} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span className="font-mono text-slate-200">{format(e.firstSeen, true)}</span><span className="text-slate-300">{e.cameraId} · #{e.trackId}</span><span style={{ color: colors[e.attire] }}>{className(e.attire, e.attireMode)}</span></li>)}</ul> : <p className="py-6 text-sm text-slate-300">ยังไม่มีข้อมูลในช่วงที่เลือก</p>}</section>
          </div>}
          {view !== 'events' && <>
            <section className="mb-6 rounded-md border border-line bg-panel p-4 sm:p-6"><div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold text-white">{data.granularity === 'hour' ? 'จำนวนรายชั่วโมง' : 'แนวโน้มรายวัน'}</h3><p className="text-xs text-slate-300">เลือกจุดบนกราฟเพื่อดูรายละเอียดวันนั้น</p></div><TrendChart buckets={data.buckets} selected={applied.attire} mode={applied.attireMode} onDay={drill} bars={view === 'today' || !!detailDay} /><Legend mode={applied.attireMode} selected={applied.attire} /></section>
            <div className="mb-6 grid gap-6 lg:grid-cols-2"><section className="rounded-md border border-line p-5"><h3 className="mb-4 font-semibold text-white">จำนวนแยกตามกล้อง</h3><Distribution rows={data.cameras.map(c => ({ label: c.cameraId, count: Number(c.count) }))} onSelect={id => { const next = { ...applied, camera: id }; setFilters(next); setApplied(next); setPage(0); }} /></section><section className="rounded-md border border-line p-5"><h3 className="mb-4 font-semibold text-white">เพศและช่วงอายุที่ AI ประเมิน</h3><div className="grid gap-6 sm:grid-cols-2"><Distribution rows={['male', 'female', 'unisex', 'uncertain'].map(g => ({ label: labels[g], count: data.demographics.filter(d => d.gender === g).reduce((s, d) => s + Number(d.count), 0) }))} /><Distribution rows={['teen', 'adult', 'elderly', 'uncertain'].map(a => ({ label: labels[a], count: data.demographics.filter(d => d.ageGroup === a).reduce((s, d) => s + Number(d.count), 0) }))} /></div></section></div>
            {data.cameraSeries.length > 0 && <section className="mb-6 rounded-md border border-line p-5"><h3 className="font-semibold text-white">แนวโน้มแยกตามกล้อง</h3><p className="mt-1 text-xs text-slate-300">ใช้สเกลเดียวกันทุกกล้อง · จำนวนเหตุการณ์บุคคล ไม่ใช่ยอดเข้า–ออก</p><div className="mt-4 grid gap-6 lg:grid-cols-2">{data.cameraSeries.map(series => <div key={series.cameraId} className="min-w-0"><h4 className="mb-2 text-sm text-slate-200">{series.cameraId}</h4><TrendChart buckets={series.buckets.map(b => ({ key: b.key, date: b.date, target: b.count, other: 0, uncertain: 0, unclassified: 0 }))} selected={['target']} mode="camera-count" onDay={drill} maxValue={Math.max(1, ...data.cameraSeries.flatMap(s => s.buckets.map(b => b.count)))} /></div>)}</div></section>}
            <details className="mb-6 rounded-md border border-line p-5" open={!!detailDay}><summary className="cursor-pointer font-semibold text-white">{data.granularity === 'hour' ? 'ตารางสรุปรายชั่วโมง' : 'ตารางสรุปรายวัน'}</summary><div className="mt-4 max-h-80 overflow-auto"><table className="w-full text-right text-sm"><thead><tr className="border-b border-line text-slate-300"><th className="py-3 text-left">{data.granularity === 'hour' ? 'เวลา' : 'วันที่'}</th>{classes.map(c => <th key={c} className="px-3 font-medium">{className(c, applied.attireMode)}</th>)}<th>รวม</th></tr></thead><tbody>{[...data.buckets].reverse().map(b => <tr key={b.key} className="border-b border-line/60"><td className="py-2 text-left"><button className="text-accent underline underline-offset-4" onClick={() => drill(b.date)}>{b.key}</button></td>{classes.map(c => <td key={c} className="px-3 font-mono">{b[c]}</td>)}<td className="font-mono">{classes.reduce((sum, c) => sum + b[c], 0)}</td></tr>)}</tbody></table></div></details>
          </>}
          <section className="overflow-hidden rounded-md border border-line"><div className="flex flex-wrap items-center justify-between gap-3 p-5"><div><h3 className="font-semibold text-white">ข้อมูลรายบุคคล</h3><p className="mt-1 text-xs text-slate-300">{eventPage?.total.toLocaleString() ?? 0} เหตุการณ์ · กดหัวคอลัมน์เพื่อเรียงข้อมูล</p></div><label className="text-xs text-slate-300">แถวต่อหน้า <select className={control} value={size} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}>{[25, 50, 100].map(n => <option key={n}>{n}</option>)}</select></label></div>
            <div className="max-h-[36rem] overflow-auto"><table className="w-full min-w-[1160px] text-left text-sm"><thead className="sticky top-0 bg-panel text-xs text-slate-300"><tr>{[['', 'ภาพ crop'], ['firstSeen', 'พบครั้งแรก'], ['lastSeen', 'พบล่าสุด'], ['cameraId', 'กล้อง'], ['trackId', 'Track'], ['attire', 'ผลจำแนก'], ['', 'โหมด'], ['', 'เพศ / อายุ'], ['confidence', 'YOLO'], ['', 'แหล่งภาพ'], ['receivedAt', 'บันทึกเข้า SQL']].map(([column, label]) => <th key={label} className="px-4 py-3 font-medium" aria-sort={column && sort === column ? direction === 'desc' ? 'descending' : 'ascending' : undefined}>{column ? <button className="whitespace-nowrap hover:text-accent focus-visible:outline focus-visible:outline-accent" onClick={() => sortBy(column)}>{label}{sort === column ? direction === 'desc' ? ' ↓' : ' ↑' : ''}</button> : label}</th>)}</tr></thead><tbody>{eventPage?.rows.map(e => <EventRow key={e.eventId} event={e} onViewImage={setSelectedImageEvent} />)}</tbody></table></div>
            {!eventPage?.rows.length && <p className="p-8 text-center text-sm text-slate-300">ไม่มีเหตุการณ์ตรงกับตัวกรองนี้</p>}
            <div className="flex items-center justify-between gap-3 border-t border-line p-4 text-xs text-slate-300"><span>หน้า {page + 1} / {Math.max(1, Math.ceil((eventPage?.total ?? 0) / size))}</span><div className="flex gap-2"><button className={action} disabled={page === 0} onClick={() => setPage(p => p - 1)}>ก่อนหน้า</button><button className={action} disabled={(page + 1) * size >= (eventPage?.total ?? 0)} onClick={() => setPage(p => p + 1)}>ถัดไป</button></div></div>
          </section>
        </>}
      </>}
      {selectedImageEvent && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="presentation" onClick={() => setSelectedImageEvent('')}><section role="dialog" aria-modal="true" aria-label="ภาพ crop ของเหตุการณ์" className="relative max-h-[90vh] max-w-[90vw] rounded-md border border-line bg-panel p-3 shadow-2xl" onClick={event => event.stopPropagation()}><button className={`${action} absolute right-5 top-5 z-10 bg-ink/90`} aria-label="ปิดภาพ" onClick={() => setSelectedImageEvent('')}>ปิด</button><img className="max-h-[84vh] max-w-[86vw] rounded object-contain" src={`/api/data/events/${selectedImageEvent}/image`} alt={`ภาพ crop ของเหตุการณ์ ${selectedImageEvent}`} /></section></div>}
    </main>
  );
}
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return <label className="text-xs text-slate-300">{label}<select className={`${control} mt-1 w-full`} value={value} onChange={e => onChange(e.target.value)}><option value="">ทั้งหมด</option>{Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="rounded-md border border-dashed border-line px-6 py-14 text-center"><h3 className="font-semibold text-white">{title}</h3><p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">{text}</p></div>; }
function Metric({ label, value, color }: { label: string; value: number; color?: string }) { return <div className="px-3"><p className="text-xs text-slate-300">{label}</p><p className="mt-2 font-mono text-2xl text-white" style={{ color }}>{value.toLocaleString()}</p></div>; }
function Legend({ selected, mode }: { selected: string[]; mode: string }) { return <div className="mt-4 flex flex-wrap justify-center gap-5 text-xs text-slate-200">{classes.filter(c => selected.includes(c)).map(c => <span key={c} className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: colors[c] }} />{className(c, mode)}</span>)}</div>; }
function TrendChart({ buckets, selected, mode, onDay, bars = false, maxValue }: { buckets: EventBucket[]; selected: string[]; mode: string; onDay: (day: string) => void; bars?: boolean; maxValue?: number }) {
  const active = classes.filter(c => selected.includes(c));
  const max = maxValue ?? Math.max(1, ...buckets.flatMap(b => bars ? [active.reduce((n, c) => n + b[c], 0)] : active.map(c => b[c])));
  const x = (i: number) => 48 + (buckets.length === 1 ? 0.5 : i / (buckets.length - 1)) * 834;
  const y = (n: number) => 225 - n / max * 195;
  return <div className="overflow-x-auto"><svg viewBox="0 0 920 270" className="min-w-[540px] w-full" role="img" aria-label="กราฟจำนวนเหตุการณ์ตามเวลา ดูค่าที่แน่นอนได้จากตารางสรุปด้านล่าง">
    {Array.from({ length: Math.min(4, max) + 1 }, (_, i) => i / Math.min(4, max)).map(t => <g key={t}><line x1="48" x2="882" y1={y(t * max)} y2={y(t * max)} stroke="#2a3140" /><text x="40" y={y(t * max) + 4} textAnchor="end" fill="#cbd5e1" fontSize="11">{Math.round(t * max)}</text></g>)}
    {!bars && active.map(c => <polyline key={c} points={buckets.map((b, i) => `${x(i)},${y(b[c])}`).join(' ')} fill="none" stroke={colors[c]} strokeWidth="2.5" />)}
    {bars && buckets.map((b, i) => { let cumulative = 0; return <g key={b.key}>{active.map(c => { const bottom = cumulative; cumulative += b[c]; return <rect key={c} x={x(i) - 10} y={y(cumulative)} width="20" height={y(bottom) - y(cumulative)} fill={colors[c]} />; })}</g>; })}
    {buckets.map((b, i) => <g key={b.key} role="button" tabIndex={0} aria-label={`${b.key}: ${active.map(c => `${className(c, mode)} ${b[c]}`).join(', ')} เปิดรายละเอียด`} onClick={() => onDay(b.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDay(b.date); } }} className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-accent"><rect x={x(i) - Math.max(3, 380 / buckets.length)} y="15" width={Math.max(6, 760 / buckets.length)} height="220" fill="transparent" /><title>{b.key}: {active.map(c => `${className(c, mode)} ${b[c]}`).join(' · ')}</title>{!bars && buckets.length <= 31 && active.map(c => <circle key={c} cx={x(i)} cy={y(b[c])} r="3" fill={colors[c]} />)}{i % Math.max(1, Math.ceil(buckets.length / 8)) === 0 && <text x={x(i)} y="253" textAnchor="middle" fill="#cbd5e1" fontSize="11">{b.key.length > 5 ? b.key.slice(5) : b.key}</text>}</g>)}
  </svg></div>;
}
function Distribution({ rows, onSelect }: { rows: { label: string; count: number }[]; onSelect?: (label: string) => void }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  if (!rows.length) return <p className="py-4 text-sm text-slate-300">ยังไม่มีข้อมูล</p>;
  return <div className="space-y-4">{rows.map(r => <div key={r.label}><div className="mb-1 flex justify-between gap-4 text-xs text-slate-200">{onSelect ? <button className="break-all text-left underline underline-offset-4 hover:text-accent" onClick={() => onSelect(r.label)}>{r.label}</button> : <span>{r.label}</span>}<span className="font-mono">{r.count.toLocaleString()}</span></div><div className="h-1 bg-line"><div className="h-1 bg-accent" style={{ width: `${r.count / max * 100}%` }} /></div></div>)}</div>;
}
function EventRow({ event: e, onViewImage }: { event: PersonEvent; onViewImage: (id: string) => void }) {
  return <tr className="border-t border-line/70 text-xs text-slate-200 hover:bg-panel"><td className="px-4 py-2">{e.imageAvailable ? <button onClick={() => onViewImage(e.eventId)} aria-label={`เปิดภาพ crop ของ Track ${e.trackId}`} className="block rounded border border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><img className="h-14 w-12 rounded object-cover" src={`/api/data/events/${e.eventId}/image`} alt={`ภาพ crop Track ${e.trackId}`} loading="lazy" /></button> : <span className="text-slate-400" title="เหตุการณ์เก่าหรือยังไม่มีภาพ">—</span>}</td><td className="whitespace-nowrap px-4 py-3">{format(e.firstSeen)}</td><td className="whitespace-nowrap px-4 py-3">{format(e.lastSeen)}</td><td className="px-4 py-3">{e.cameraId}</td><td className="px-4 py-3 font-mono" title={`เหตุการณ์ ${e.eventId}`}>#{e.trackId}<span className="mt-1 block text-[10px] text-slate-400">รอบ {e.sessionId.slice(-6)} / {e.trackEpoch}</span></td><td className="whitespace-nowrap px-4 py-3" style={{ color: colors[e.attire] }}>{className(e.attire, e.attireMode)}</td><td className="px-4 py-3">{e.attireMode === 'student' ? 'นักศึกษา' : 'แพทย์'}</td><td className="whitespace-nowrap px-4 py-3">{labels[e.gender]} / {labels[e.ageGroup]}</td><td className="px-4 py-3 font-mono">{(e.confidence * 100).toFixed(1)}%</td><td className="px-4 py-3">{e.source === 'camera' ? 'กล้องสด' : 'รูปภาพ'}</td><td className="whitespace-nowrap px-4 py-3">{e.receivedAt ? format(e.receivedAt) : '—'}</td></tr>;
}
