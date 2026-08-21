import { useCallback, useEffect, useRef, useState } from "react";
import { COCO_CLASSES, detectObjects } from "./utils/yolo";
import { IouTracker, type TrackedDetection } from "./utils/tracker";
import {
  Mode,
  PersonDescriptionState,
  Status,
} from "./interfaces/demo.interface";
import {
  BOX_COLORS,
  CAMERA_DETECT_INTERVAL_MS,
  CAMERA_GEMINI_INTERVAL_MS,
  CONF_THRESHOLD_RANGE,
  DEFAULT_CONF_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  DEFAULT_MODEL_URL,
  IOU_THRESHOLD_RANGE,
  MODEL_OPTIONS,
  PERSON_CLASS_ID,
  SESSION_API_KEY,
} from "./constants/demo.const";
import {
  cleanGeminiText,
  cropDetectionToDataUrl,
  describePersonImage,
  drawBoxes,
  drawImageDetections,
  getAttireClass,
  getAttireLabel,
  parseAgeGroupType,
  parseAttireType,
  parseGenderType,
} from "./functions/demo.func";

export default function App() {
  const envApiKey = import.meta.env.VITE_GEMINI_API_KEY ?? "";

  const [mode, setMode] = useState<Mode>("image");
  const [status, setStatus] = useState<Status>("idle");
  const [detections, setDetections] = useState<TrackedDetection[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  const [selectedClasses, setSelectedClasses] = useState<Set<number>>(
    () => new Set([COCO_CLASSES.indexOf("person")]),
  );

  const [showClassPicker, setShowClassPicker] = useState(false);

  const [confThreshold, setConfThreshold] = useState(DEFAULT_CONF_THRESHOLD);
  const [iouThreshold, setIouThreshold] = useState(DEFAULT_IOU_THRESHOLD);

  const [modelUrl, setModelUrl] = useState(DEFAULT_MODEL_URL);

  const [apiKey, setApiKey] = useState(() => {
    return sessionStorage.getItem(SESSION_API_KEY) ?? envApiKey;
  });

  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [personDescriptions, setPersonDescriptions] = useState<
    Record<number, PersonDescriptionState>
  >({});

  const selectedClassesRef = useRef(selectedClasses);
  const confThresholdRef = useRef(confThreshold);
  const iouThresholdRef = useRef(iouThreshold);
  const modelUrlRef = useRef(modelUrl);

  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraLoopRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const geminiLastRunRef = useRef(0);
  const geminiRunningRef = useRef(false);
  const leftPanelRef = useRef<HTMLDivElement>(null);

  const trackerRef = useRef(new IouTracker());

  selectedClassesRef.current = selectedClasses;
  confThresholdRef.current = confThreshold;
  iouThresholdRef.current = iouThreshold;
  modelUrlRef.current = modelUrl;

  const [resultsPanelHeight, setResultsPanelHeight] = useState<
    number | undefined
  >(undefined);

  useEffect(() => {
    const el = leftPanelRef.current;
    if (!el) return;

    const mq = window.matchMedia("(min-width: 768px)");

    const updateHeight = () => {
      setResultsPanelHeight(
        mq.matches ? el.getBoundingClientRect().height : undefined,
      );
    };

    updateHeight();

    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    mq.addEventListener("change", updateHeight);
    window.addEventListener("resize", updateHeight);

    return () => {
      ro.disconnect();
      mq.removeEventListener("change", updateHeight);
      window.removeEventListener("resize", updateHeight);
    };
  }, [mode, imageUrl, cameraActive, status]);

  useEffect(() => {
    if (apiKey.trim()) {
      sessionStorage.setItem(SESSION_API_KEY, apiKey.trim());
    } else {
      sessionStorage.removeItem(SESSION_API_KEY);
    }
  }, [apiKey]);

  const toggleClass = (classId: number) => {
    setSelectedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  };

  const selectAllClasses = () =>
    setSelectedClasses(new Set(COCO_CLASSES.map((_, i) => i)));
  const clearAllClasses = () => setSelectedClasses(new Set());

  const handleUseEnvApiKey = () => {
    if (!envApiKey.trim()) {
      setErrorMsg("ไม่พบ VITE_GEMINI_API_KEY ในไฟล์ .env");
      return;
    }
    setApiKey(envApiKey.trim());
    setErrorMsg("");
    setShowApiKeyInput(false);
  };

  const handleResetTracking = useCallback(() => {
    trackerRef.current.reset();
    setPersonDescriptions({});
  }, []);

  const analyzePerson = useCallback(
    async (
      source: HTMLImageElement | HTMLVideoElement,
      det: TrackedDetection,
      trackId: number,
    ) => {
      const currentApiKey = apiKey.trim();

      if (!currentApiKey) {
        setShowApiKeyInput(true);
        setPersonDescriptions((prev) => ({
          ...prev,
          [trackId]: { loading: false, error: "กรุณากรอก Gemini API key ก่อน" },
        }));
        return;
      }

      let thumbnail: string;

      try {
        thumbnail = cropDetectionToDataUrl(source, det);
      } catch (err) {
        console.error(err);
        setPersonDescriptions((prev) => ({
          ...prev,
          [trackId]: { loading: false, error: "ครอปภาพบุคคลไม่สำเร็จ" },
        }));
        return;
      }

      setPersonDescriptions((prev) => ({
        ...prev,
        [trackId]: { loading: true, thumbnail },
      }));

      try {
        const text = await describePersonImage(thumbnail, currentApiKey);
        const attire = parseAttireType(text);
        const gender = parseGenderType(text);
        const ageGroup = parseAgeGroupType(text);
        const cleanText = cleanGeminiText(text);

        setPersonDescriptions((prev) => ({
          ...prev,
          [trackId]: {
            loading: false,
            thumbnail,
            text: cleanText,
            attire,
            gender,
            ageGroup,
          },
        }));

        trackerRef.current.markAnalyzed(trackId);
      } catch (err) {
        console.error(err);
        setPersonDescriptions((prev) => ({
          ...prev,
          [trackId]: {
            loading: false,
            thumbnail,
            error:
              err instanceof Error
                ? err.message
                : "เกิดข้อผิดพลาดจาก Gemini API",
          },
        }));
      }
    },
    [apiKey],
  );

  const analyzeAllPeople = useCallback(
    async (
      source: HTMLImageElement | HTMLVideoElement,
      results: TrackedDetection[],
    ) => {
      const people = results.filter((det) => det.classId === PERSON_CLASS_ID);
      if (people.length === 0) return;

      if (!apiKey.trim()) {
        setShowApiKeyInput(true);
        return;
      }

      if (geminiRunningRef.current) return;

      const toAnalyze = people.filter(
        (det) => !trackerRef.current.isAnalyzed(det.trackId),
      );

      if (toAnalyze.length === 0) return;

      geminiRunningRef.current = true;

      try {
        for (const det of toAnalyze) {
          await analyzePerson(source, det, det.trackId);
        }
      } finally {
        geminiRunningRef.current = false;
        geminiLastRunRef.current = performance.now();
      }
    },
    [apiKey, analyzePerson],
  );

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;

    const url = URL.createObjectURL(file);

    setImageUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return url;
    });

    setDetections([]);
    setPersonDescriptions({});
    setStatus("idle");
    setErrorMsg("");
    setInferenceMs(null);
    trackerRef.current.reset();
  }, []);

  const runImageDetection = useCallback(async () => {
    const img = imgRef.current;
    const canvas = imageCanvasRef.current;
    if (!img || !canvas) return;

    setErrorMsg("");
    setDetections([]);
    setPersonDescriptions({});
    setStatus("loading-model");
    trackerRef.current.reset();

    try {
      const start = performance.now();
      setStatus("running");

      const rawResults = await detectObjects(img, {
        modelUrl: modelUrlRef.current,
        confThreshold: confThresholdRef.current,
        iouThreshold: iouThresholdRef.current,
      });

      const filtered = rawResults.filter((d) =>
        selectedClassesRef.current.has(d.classId),
      );

      const tracked = trackerRef.current.update(filtered);

      setInferenceMs(performance.now() - start);
      setDetections(tracked);
      drawImageDetections(canvas, img, tracked);
      setStatus("done");

      await analyzeAllPeople(img, tracked);
    } catch (err) {
      console.error(err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Detection failed. Check that the model file exists.",
      );
      setStatus("error");
    }
  }, [analyzeAllPeople]);

  const stopCamera = useCallback(() => {
    if (cameraLoopRef.current !== null) {
      window.clearTimeout(cameraLoopRef.current);
      cameraLoopRef.current = null;
    }

    runningRef.current = false;

    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    setCameraActive(false);
    setStatus("idle");
    setDetections([]);
    setPersonDescriptions({});
    trackerRef.current.reset();

    const overlay = overlayCanvasRef.current;
    if (overlay) {
      const ctx = overlay.getContext("2d");
      ctx?.clearRect(0, 0, overlay.width, overlay.height);
      overlay.width = 0;
      overlay.height = 0;
    }
  }, []);

  const cameraLoop = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayCanvasRef.current;

    if (!streamRef.current) return;

    if (!video || !overlay || video.readyState < 2) {
      if (streamRef.current) {
        cameraLoopRef.current = window.setTimeout(
          cameraLoop,
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
      return;
    }

    if (runningRef.current) {
      if (streamRef.current) {
        cameraLoopRef.current = window.setTimeout(
          cameraLoop,
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
      return;
    }

    runningRef.current = true;

    try {
      const start = performance.now();

      const rawResults = await detectObjects(video, {
        modelUrl: modelUrlRef.current,
        confThreshold: confThresholdRef.current,
        iouThreshold: iouThresholdRef.current,
      });

      const filtered = rawResults.filter((d) =>
        selectedClassesRef.current.has(d.classId),
      );

      const tracked = trackerRef.current.update(filtered);

      setInferenceMs(performance.now() - start);
      setDetections(tracked);

      if (
        overlay.width !== video.videoWidth ||
        overlay.height !== video.videoHeight
      ) {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
      }

      const ctx = overlay.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawBoxes(ctx, video.videoWidth, tracked);
      }

      setStatus("done");
      setErrorMsg("");

      const now = performance.now();

      if (
        now - geminiLastRunRef.current >= CAMERA_GEMINI_INTERVAL_MS &&
        !geminiRunningRef.current
      ) {
        await analyzeAllPeople(video, tracked);
      }
    } catch (err) {
      console.error(err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Detection failed. Check that the model file exists.",
      );
      setStatus("error");
    } finally {
      runningRef.current = false;

      if (streamRef.current) {
        cameraLoopRef.current = window.setTimeout(
          cameraLoop,
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
    }
  }, [analyzeAllPeople]);

  const startCamera = useCallback(async () => {
    setErrorMsg("");
    setStatus("loading-model");
    trackerRef.current.reset();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      geminiLastRunRef.current = 0;
      setCameraActive(true);
      setStatus("running");
    } catch (err) {
      console.error(err);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraActive(false);
      setStatus("error");
      setErrorMsg(
        err instanceof Error
          ? `เปิดกล้องไม่สำเร็จ: ${err.message}`
          : "เปิดกล้องไม่สำเร็จ ตรวจสอบสิทธิ์การเข้าถึงกล้องของเบราว์เซอร์",
      );
    }
  }, []);

  useEffect(() => {
    if (!cameraActive) return;

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    video
      .play()
      .then(() => {
        if (streamRef.current) {
          cameraLoopRef.current = window.setTimeout(cameraLoop, 200);
        }
      })
      .catch((err) => {
        console.error("Video play failed:", err);
        setErrorMsg(
          "ไม่สามารถแสดงภาพจากกล้องได้ กรุณาตรวจสอบสิทธิ์กล้องของเบราว์เซอร์",
        );
        setStatus("error");
      });

    return () => {
      if (cameraLoopRef.current !== null) {
        window.clearTimeout(cameraLoopRef.current);
        cameraLoopRef.current = null;
      }
    };
  }, [cameraActive, cameraLoop]);

  useEffect(() => {
    if (mode === "image") stopCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;

    setDetections([]);
    setErrorMsg("");
    setStatus("idle");
    setPersonDescriptions({});
    setInferenceMs(null);
    trackerRef.current.reset();

    if (next === "image") stopCamera();
    setMode(next);
  };

  const handleDescribePerson = useCallback(
    async (det: TrackedDetection) => {
      const source = mode === "image" ? imgRef.current : videoRef.current;
      if (!source) return;
      await analyzePerson(source, det, det.trackId);
    },
    [mode, analyzePerson],
  );

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const sortedDetections = [...detections].sort((a, b) => b.score - a.score);

  const personResults = detections.filter(
    (det) => det.classId === PERSON_CLASS_ID,
  );

  const studentCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "student",
  ).length;

  const generalCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "general",
  ).length;

  const uncertainCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "uncertain",
  ).length;

  const analyzingCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.loading,
  ).length;

  const analyzedCount = studentCount + generalCount + uncertainCount;

  const maleCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.gender === "male",
  ).length;

  const femaleCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.gender === "female",
  ).length;

  const teenCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.ageGroup === "teen",
  ).length;

  const adultCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.ageGroup === "adult",
  ).length;

  const elderlyCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.ageGroup === "elderly",
  ).length;

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <header className="border-b border-line px-6 py-5">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
              client-side inference
            </p>
            <h1 className="text-xl font-semibold">
              YOLOv8 · Gemini Attire Detection
            </h1>
          </div>

          <button
            onClick={() => setShowApiKeyInput((v) => !v)}
            className="font-mono text-xs text-slate-400 hover:text-accent"
          >
            onnxruntime-web ·{" "}
            {apiKey ? "Gemini API key ✓" : "ตั้งค่า Gemini API key"}
          </button>
        </div>

        {showApiKeyInput && (
          <div className="mx-auto mt-3 flex max-w-5xl flex-wrap items-center gap-2">
            <input
              type="password"
              placeholder="Gemini API key (AIza...)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-72 rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleUseEnvApiKey}
              disabled={!envApiKey}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-slate-300 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              ใช้ API key จาก .env
            </button>
            <button
              type="button"
              onClick={() => {
                setApiKey("");
                sessionStorage.removeItem(SESSION_API_KEY);
              }}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-slate-400 transition hover:border-warn hover:text-warn"
            >
              ล้าง
            </button>
            <span className="text-xs text-slate-500">
              {envApiKey
                ? "มี API key จาก .env · ค่าที่กรอกเองจะ override"
                : "ไม่พบ API key ใน .env · กรุณากรอกเอง"}
            </span>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 inline-flex rounded-md border border-line bg-panel p-1">
          <button
            onClick={() => switchMode("image")}
            className={`rounded px-4 py-1.5 text-sm font-medium transition ${
              mode === "image"
                ? "bg-accent text-ink"
                : "text-slate-300 hover:text-white"
            }`}
          >
            อัปโหลดรูปภาพ
          </button>
          <button
            onClick={() => switchMode("camera")}
            className={`rounded px-4 py-1.5 text-sm font-medium transition ${
              mode === "camera"
                ? "bg-accent text-ink"
                : "text-slate-300 hover:text-white"
            }`}
          >
            กล้องสด
          </button>
        </div>

        <section className="mb-6 rounded-lg border border-line bg-panel p-5">
          {mode === "image" ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:opacity-90"
              >
                เลือกรูปภาพ
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />

              <button
                onClick={runImageDetection}
                disabled={
                  !imageUrl ||
                  status === "loading-model" ||
                  status === "running"
                }
                className="rounded-md border border-line px-4 py-2 text-sm font-medium transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status === "loading-model" && "กำลังโหลดโมเดล..."}
                {status === "running" && "กำลังตรวจจับ..."}
                {(status === "idle" ||
                  status === "done" ||
                  status === "error") &&
                  "ตรวจจับและวิเคราะห์"}
              </button>

              {inferenceMs !== null && status === "done" && (
                <span className="font-mono text-xs text-slate-400">
                  YOLO: {inferenceMs.toFixed(0)}ms · {detections.length} objects
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {!cameraActive ? (
                <button
                  onClick={startCamera}
                  disabled={status === "loading-model"}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:opacity-90 disabled:opacity-40"
                >
                  {status === "loading-model"
                    ? "กำลังเปิดกล้อง..."
                    : "เปิดกล้อง"}
                </button>
              ) : (
                <>
                  <button
                    onClick={stopCamera}
                    className="rounded-md border border-warn/50 px-4 py-2 text-sm font-medium text-warn transition hover:bg-warn/10"
                  >
                    ปิดกล้อง
                  </button>
                  <button
                    onClick={handleResetTracking}
                    className="rounded-md border border-line px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-accent hover:text-accent"
                    title="ล้าง track ID ทั้งหมด แล้ววิเคราะห์ทุกคนใหม่"
                  >
                    รีเซ็ต tracking
                  </button>
                </>
              )}

              {cameraActive && (
                <span className="font-mono text-xs text-slate-400">
                  {inferenceMs !== null && `${inferenceMs.toFixed(0)}ms · `}
                  {detections.length} objects · ติดตาม{" "}
                  {trackerRef.current.activeTrackCount} track · YOLO ทุก{" "}
                  {CAMERA_DETECT_INTERVAL_MS}ms · Gemini ทุก{" "}
                  {CAMERA_GEMINI_INTERVAL_MS / 1000}s
                </span>
              )}
            </div>
          )}

          {errorMsg && (
            <div className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              {errorMsg}
              <p className="mt-1 text-xs text-warn/80">
                วางไฟล์โมเดลที่ export แล้วไว้ที่ <code>public/models/</code>
              </p>
            </div>
          )}

          {/* --- ใหม่: model switcher --- */}
          <div className="mt-4 border-t border-line pt-4">
            <p className="mb-2 text-sm font-medium text-slate-300">
              โมเดล YOLO
            </p>
            <div className="flex flex-wrap gap-2">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.url}
                  onClick={() => setModelUrl(opt.url)}
                  disabled={status === "running" || status === "loading-model"}
                  className={`rounded-md border px-3 py-1.5 text-xs transition ${
                    modelUrl === opt.url
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-line text-slate-300 hover:border-accent"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {MODEL_OPTIONS.find((o) => o.url === modelUrl)?.description} ·
              เปลี่ยนแล้วมีผลตั้งแต่การตรวจจับครั้งถัดไป
            </p>
          </div>

          {/* --- ใหม่: threshold sliders --- */}
          <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
                <span>Confidence threshold</span>
                <span className="font-mono text-xs text-accent">
                  {confThreshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={CONF_THRESHOLD_RANGE.min}
                max={CONF_THRESHOLD_RANGE.max}
                step={CONF_THRESHOLD_RANGE.step}
                value={confThreshold}
                onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
                className="w-full accent-accent"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                ค่าสูง = ตรวจจับแม่นแต่พลาดง่าย, ค่าต่ำ = จับได้เยอะแต่ noise
                เยอะ
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
                <span>IOU threshold (NMS)</span>
                <span className="font-mono text-xs text-accent">
                  {iouThreshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={IOU_THRESHOLD_RANGE.min}
                max={IOU_THRESHOLD_RANGE.max}
                step={IOU_THRESHOLD_RANGE.step}
                value={iouThreshold}
                onChange={(e) => setIouThreshold(parseFloat(e.target.value))}
                className="w-full accent-accent"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                ค่าต่ำ = ลบกล่องซ้อนกันมากขึ้น, ค่าสูง = เก็บกล่องซ้อนไว้มากขึ้น
              </p>
            </div>
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <button
              onClick={() => setShowClassPicker((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white"
            >
              <span
                className={`transition-transform ${showClassPicker ? "rotate-90" : ""}`}
              >
                ▸
              </span>
              เลือก class ที่จะตรวจจับ
              <span className="font-mono text-xs text-slate-500">
                ({selectedClasses.size}/{COCO_CLASSES.length})
              </span>
            </button>

            {showClassPicker && (
              <div className="mt-3">
                <div className="mb-3 flex gap-3">
                  <button
                    onClick={selectAllClasses}
                    className="text-xs text-accent hover:underline"
                  >
                    เลือกทั้งหมด
                  </button>
                  <button
                    onClick={clearAllClasses}
                    className="text-xs text-slate-400 hover:underline"
                  >
                    ไม่เลือกเลย
                  </button>
                </div>

                <div className="grid max-h-56 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto pr-2 sm:grid-cols-3">
                  {COCO_CLASSES.map((name, id) => (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        checked={selectedClasses.has(id)}
                        onChange={() => toggleClass(id)}
                        className="h-3.5 w-3.5 accent-accent"
                      />
                      <span
                        className={
                          selectedClasses.has(id)
                            ? "text-slate-200"
                            : "text-slate-500"
                        }
                      >
                        {name}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="grid items-start gap-6 md:grid-cols-[2fr_1fr]">
          <div className="min-w-0" ref={leftPanelRef}>
            <div className="flex w-full flex-col overflow-hidden rounded-lg border border-line bg-panel p-4">
              {mode === "image" ? (
                imageUrl ? (
                  <div className="relative">
                    <img
                      ref={imgRef}
                      src={imageUrl}
                      alt="uploaded"
                      className={
                        status === "done" ? "hidden" : "block w-full rounded-md"
                      }
                    />
                    <canvas
                      ref={imageCanvasRef}
                      className={
                        status === "done" ? "block w-full rounded-md" : "hidden"
                      }
                    />
                  </div>
                ) : (
                  <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-line text-sm text-slate-500">
                    ยังไม่ได้เลือกรูปภาพ
                  </div>
                )
              ) : (
                <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
                  {cameraActive ? (
                    <>
                      <video
                        ref={videoRef}
                        playsInline
                        muted
                        autoPlay
                        className="absolute inset-0 block h-full w-full scale-x-[-1] object-contain"
                      />
                      <canvas
                        ref={overlayCanvasRef}
                        className="pointer-events-none absolute inset-0 h-full w-full"
                      />
                    </>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center border border-dashed border-line text-sm text-slate-500">
                      กดปุ่ม "เปิดกล้อง" เพื่อเริ่มตรวจจับแบบเรียลไทม์
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0">
            <div
              className="flex w-full flex-col overflow-y-auto rounded-lg border border-line bg-panel p-4"
              style={
                resultsPanelHeight
                  ? {
                      height: resultsPanelHeight,
                      maxHeight: resultsPanelHeight,
                    }
                  : undefined
              }
            >
              <div className="mb-3 flex w-full shrink-0 items-center justify-between font-mono text-xs uppercase tracking-[0.15em] text-slate-400">
                <div>ผลลัพธ์</div>
                <div>
                  {analyzingCount > 0 && (
                    <span>กำลังวิเคราะห์ {analyzingCount} คน...</span>
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {personResults.length > 0 && (
                  <div className="mb-5 space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-accent/20 bg-accent/5 p-3">
                        <p className="text-[10px] text-slate-500">
                          ชุดนักศึกษา
                        </p>
                        <p className="text-xl font-semibold text-accent">
                          {studentCount}{" "}
                          <span className="text-xs font-normal">คน</span>
                        </p>
                      </div>
                      <div className="rounded-md border border-line bg-black/10 p-3">
                        <p className="text-[10px] text-slate-500">ชุดทั่วไป</p>
                        <p className="text-xl font-semibold text-slate-200">
                          {generalCount}{" "}
                          <span className="text-xs font-normal">คน</span>
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-line bg-panel p-3">
                        <p className="mb-2 text-[10px] font-semibold text-slate-400">
                          แยกตามเพศ
                        </p>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-300">ผู้ชาย</span>
                          <span className="font-semibold">{maleCount}</span>
                        </div>
                        <div className="mt-1 flex justify-between text-sm">
                          <span className="text-slate-300">ผู้หญิง</span>
                          <span className="font-semibold">{femaleCount}</span>
                        </div>
                      </div>

                      <div className="rounded-md border border-line bg-panel p-3">
                        <p className="mb-2 text-[10px] font-semibold text-slate-400">
                          แยกตามช่วงวัย
                        </p>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-300">วัยรุ่น/เรียน</span>
                          <span className="font-semibold">{teenCount}</span>
                        </div>
                        <div className="mt-1 flex justify-between text-sm">
                          <span className="text-slate-300">วัยผู้ใหญ่</span>
                          <span className="font-semibold">{adultCount}</span>
                        </div>
                        <div className="mt-1 flex justify-between text-sm">
                          <span className="text-slate-300">สูงวัย</span>
                          <span className="font-semibold">{elderlyCount}</span>
                        </div>
                      </div>
                    </div>

                    <div className="col-span-2">
                      <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
                        <span>วิเคราะห์การแต่งกาย (ไม่เรียกซ้ำคนเดิม)</span>
                        <span>
                          {analyzedCount}/{personResults.length}
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-white/5">
                        <div
                          className="h-full bg-accent transition-all duration-300"
                          style={{
                            width: `${personResults.length > 0 ? (analyzedCount / personResults.length) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {detections.length === 0 ? (
                  <p className="text-sm text-slate-500">ยังไม่มีผลการตรวจจับ</p>
                ) : (
                  <ul className="space-y-2">
                    {sortedDetections.map((det) => {
                      const desc = personDescriptions[det.trackId];
                      const isPerson = det.classId === PERSON_CLASS_ID;
                      const attireLabel = getAttireLabel(desc?.attire);

                      return (
                        <li
                          key={det.trackId}
                          className="rounded-md border border-line px-3 py-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{
                                backgroundColor:
                                  BOX_COLORS[det.classId % BOX_COLORS.length],
                              }}
                            />

                            <span className="font-mono text-[10px] text-slate-500">
                              #{det.trackId}
                            </span>

                            <span className="flex-1">{det.className}</span>

                            <span className="font-mono text-xs text-slate-400">
                              {(det.score * 100).toFixed(1)}%
                            </span>

                            {isPerson && (
                              <button
                                onClick={() => handleDescribePerson(det)}
                                disabled={desc?.loading}
                                className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-slate-300 transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-50"
                              >
                                {desc?.loading
                                  ? "กำลังวิเคราะห์..."
                                  : desc
                                    ? "วิเคราะห์อีกครั้ง"
                                    : "วิเคราะห์"}
                              </button>
                            )}
                          </div>

                          {isPerson && attireLabel && (
                            <div className="mt-2">
                              <span
                                className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${getAttireClass(desc?.attire)}`}
                              >
                                {attireLabel}
                              </span>
                            </div>
                          )}

                          {desc &&
                            (desc.thumbnail ||
                              desc.text ||
                              desc.error ||
                              desc.loading) && (
                              <div className="mt-2 flex gap-3 border-t border-line pt-2">
                                {desc.thumbnail && (
                                  <img
                                    src={desc.thumbnail}
                                    alt={`${det.className} crop`}
                                    className="h-16 w-16 shrink-0 rounded object-cover"
                                  />
                                )}
                                <div className="min-w-0 flex-1">
                                  {desc.loading && (
                                    <p className="text-xs text-slate-500">
                                      กำลังวิเคราะห์การแต่งกายด้วย Gemini...
                                    </p>
                                  )}
                                  {desc.error && (
                                    <p className="text-xs text-warn">
                                      {desc.error}
                                    </p>
                                  )}
                                  {desc.text && (
                                    <p className="text-xs leading-relaxed text-slate-300">
                                      {desc.text}
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
