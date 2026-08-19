import { useCallback, useEffect, useRef, useState } from "react";
import { COCO_CLASSES, detectObjects, type Detection } from "./utils/yolo";
import {
  Mode,
  PersonDescriptionState,
  Status,
} from "./interfaces/demo.interface";
import {
  BOX_COLORS,
  CAMERA_DETECT_INTERVAL_MS,
  CAMERA_GEMINI_INTERVAL_MS,
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
  const [mode, setMode] = useState<Mode>("image");

  const [status, setStatus] = useState<Status>("idle");

  const [detections, setDetections] = useState<Detection[]>([]);

  const [errorMsg, setErrorMsg] = useState("");

  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const [inferenceMs, setInferenceMs] = useState<number | null>(null);

  const [cameraActive, setCameraActive] = useState(false);

  const [selectedClasses, setSelectedClasses] = useState<Set<number>>(
    () => new Set([COCO_CLASSES.indexOf("person")]),
  );

  const [showClassPicker, setShowClassPicker] = useState(false);

  const selectedClassesRef = useRef(selectedClasses);

  selectedClassesRef.current = selectedClasses;

  const [apiKey, setApiKey] = useState(
    () => sessionStorage.getItem(SESSION_API_KEY) ?? "",
  );

  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [personDescriptions, setPersonDescriptions] = useState<
    Record<number, PersonDescriptionState>
  >({});

  const geminiLastRunRef = useRef(0);

  const geminiRunningRef = useRef(false);

  useEffect(() => {
    if (apiKey) {
      sessionStorage.setItem(SESSION_API_KEY, apiKey);
    } else {
      sessionStorage.removeItem(SESSION_API_KEY);
    }
  }, [apiKey]);

  const toggleClass = (classId: number) => {
    setSelectedClasses((prev) => {
      const next = new Set(prev);

      if (next.has(classId)) {
        next.delete(classId);
      } else {
        next.add(classId);
      }

      return next;
    });
  };

  const selectAllClasses = () =>
    setSelectedClasses(new Set(COCO_CLASSES.map((_, i) => i)));

  const clearAllClasses = () => setSelectedClasses(new Set());

  const imgRef = useRef<HTMLImageElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);

  const imageCanvasRef = useRef<HTMLCanvasElement>(null);

  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const cameraLoopRef = useRef<number | null>(null);

  const runningRef = useRef(false);

  const analyzePerson = useCallback(
    async (
      source: HTMLImageElement | HTMLVideoElement,
      det: Detection,
      index: number,
    ) => {
      if (!apiKey.trim()) {
        setShowApiKeyInput(true);

        setPersonDescriptions((prev) => ({
          ...prev,

          [index]: {
            loading: false,
            error: "กรุณากรอก Gemini API key ก่อน",
          },
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

          [index]: {
            loading: false,
            error: "ครอปภาพบุคคลไม่สำเร็จ",
          },
        }));

        return;
      }

      setPersonDescriptions((prev) => ({
        ...prev,

        [index]: {
          loading: true,
          thumbnail,
        },
      }));

      try {
        const text = await describePersonImage(thumbnail, apiKey.trim());
        const attire = parseAttireType(text);
        const gender = parseGenderType(text);
        const ageGroup = parseAgeGroupType(text);
        const cleanText = cleanGeminiText(text);

        setPersonDescriptions((prev) => ({
          ...prev,
          [index]: {
            loading: false,
            thumbnail,
            text: cleanText,
            attire,
            gender,
            ageGroup,
          },
        }));
      } catch (err) {
        console.error(err);

        setPersonDescriptions((prev) => ({
          ...prev,

          [index]: {
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
      results: Detection[],
    ) => {
      const people = results
        .map((det, index) => ({
          det,
          index,
        }))
        .filter(({ det }) => det.classId === PERSON_CLASS_ID);

      if (people.length === 0) {
        return;
      }

      if (!apiKey.trim()) {
        setShowApiKeyInput(true);

        return;
      }

      if (geminiRunningRef.current) {
        return;
      }

      geminiRunningRef.current = true;

      try {
        for (const person of people) {
          await analyzePerson(source, person.det, person.index);
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

    setImageUrl(url);
    setDetections([]);
    setPersonDescriptions({});
    setStatus("idle");
    setErrorMsg("");
    setInferenceMs(null);
  }, []);

  const runImageDetection = useCallback(async () => {
    const img = imgRef.current;

    const canvas = imageCanvasRef.current;

    if (!img || !canvas) return;

    setErrorMsg("");
    setDetections([]);
    setPersonDescriptions({});
    setStatus("loading-model");

    try {
      const start = performance.now();

      setStatus("running");

      const rawResults = await detectObjects(img);

      const results = rawResults.filter((d) =>
        selectedClassesRef.current.has(d.classId),
      );

      setInferenceMs(performance.now() - start);

      setDetections(results);

      drawImageDetections(canvas, img, results);

      setStatus("done");

      await analyzeAllPeople(img, results);
    } catch (err) {
      console.error(err);

      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Detection failed. Check that /models/yolov8n.onnx exists.",
      );

      setStatus("error");
    }
  }, [analyzeAllPeople]);

  const stopCamera = useCallback(() => {
    if (cameraLoopRef.current) {
      window.clearTimeout(cameraLoopRef.current);

      cameraLoopRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());

    streamRef.current = null;

    setCameraActive(false);
    setStatus("idle");

    setDetections([]);
    setPersonDescriptions({});

    const overlay = overlayCanvasRef.current;

    if (overlay) {
      overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
    }
  }, []);

  const cameraLoop = useCallback(async () => {
    const video = videoRef.current;

    const overlay = overlayCanvasRef.current;

    if (!video || !overlay || video.readyState < 2) {
      cameraLoopRef.current = window.setTimeout(
        cameraLoop,
        CAMERA_DETECT_INTERVAL_MS,
      );

      return;
    }

    if (runningRef.current) {
      cameraLoopRef.current = window.setTimeout(
        cameraLoop,
        CAMERA_DETECT_INTERVAL_MS,
      );

      return;
    }

    runningRef.current = true;

    try {
      const start = performance.now();

      const rawResults = await detectObjects(video);

      const results = rawResults.filter((d) =>
        selectedClassesRef.current.has(d.classId),
      );

      setInferenceMs(performance.now() - start);

      setDetections(results);

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

        drawBoxes(ctx, video.videoWidth, results);
      }

      setStatus("done");
      setErrorMsg("");

      const now = performance.now();

      if (
        now - geminiLastRunRef.current >= CAMERA_GEMINI_INTERVAL_MS &&
        !geminiRunningRef.current
      ) {
        await analyzeAllPeople(video, results);
      }
    } catch (err) {
      console.error(err);

      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Detection failed. Check that /models/yolov8n.onnx exists.",
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",

          width: {
            ideal: 1280,
          },

          height: {
            ideal: 720,
          },
        },

        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;

        await videoRef.current.play();
      }

      geminiLastRunRef.current = 0;

      setCameraActive(true);
      setStatus("running");

      cameraLoopRef.current = window.setTimeout(cameraLoop, 200);
    } catch (err) {
      console.error(err);

      setErrorMsg(
        err instanceof Error
          ? `เปิดกล้องไม่สำเร็จ: ${err.message}`
          : "เปิดกล้องไม่สำเร็จ ตรวจสอบสิทธิ์การเข้าถึงกล้องของเบราว์เซอร์",
      );

      setStatus("error");
    }
  }, [cameraLoop]);

  useEffect(() => {
    if (mode === "image") {
      stopCamera();
    }

    return () => stopCamera();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const switchMode = (next: Mode) => {
    setDetections([]);
    setErrorMsg("");
    setStatus("idle");
    setPersonDescriptions({});
    setInferenceMs(null);

    setMode(next);
  };

  const handleDescribePerson = useCallback(
    async (det: Detection, index: number) => {
      const source = mode === "image" ? imgRef.current : videoRef.current;

      if (!source) return;

      await analyzePerson(source, det, index);
    },
    [mode, analyzePerson],
  );

  const sortedDetections = detections
    .map((det, originalIndex) => ({
      det,
      originalIndex,
    }))
    .sort((a, b) => b.det.score - a.det.score);

  const personResults = detections
    .map((det, originalIndex) => ({
      det,
      originalIndex,
    }))
    .filter(({ det }) => det.classId === PERSON_CLASS_ID);

  const studentCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.attire === "student",
  ).length;

  const generalCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.attire === "general",
  ).length;

  const uncertainCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.attire === "uncertain",
  ).length;

  const analyzingCount = personResults.filter(
    ({ originalIndex }) => personDescriptions[originalIndex]?.loading,
  ).length;

  const analyzedCount = studentCount + generalCount + uncertainCount;

  const maleCount = personResults.filter(
    ({ originalIndex }) => personDescriptions[originalIndex]?.gender === "male",
  ).length;
  const femaleCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.gender === "female",
  ).length;

  const teenCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.ageGroup === "teen",
  ).length;
  const adultCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.ageGroup === "adult",
  ).length;
  const elderlyCount = personResults.filter(
    ({ originalIndex }) =>
      personDescriptions[originalIndex]?.ageGroup === "elderly",
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

            <span className="text-xs text-slate-500">
              เก็บไว้ใน sessionStorage ของเบราว์เซอร์นี้เท่านั้น
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
                  YOLO: {inferenceMs.toFixed(0)}
                  ms · {detections.length} objects
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
                <button
                  onClick={stopCamera}
                  className="rounded-md border border-warn/50 px-4 py-2 text-sm font-medium text-warn transition hover:bg-warn/10"
                >
                  ปิดกล้อง
                </button>
              )}

              {cameraActive && (
                <span className="font-mono text-xs text-slate-400">
                  {inferenceMs !== null && `${inferenceMs.toFixed(0)}ms · `}
                  {detections.length} objects · YOLO ทุก{" "}
                  {CAMERA_DETECT_INTERVAL_MS}
                  ms · Gemini ทุก {CAMERA_GEMINI_INTERVAL_MS / 1000}s
                </span>
              )}
            </div>
          )}

          {errorMsg && (
            <div className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              {errorMsg}

              <p className="mt-1 text-xs text-warn/80">
                วางไฟล์โมเดลที่ export แล้วไว้ที่{" "}
                <code>public/models/yolov8n.onnx</code>
              </p>
            </div>
          )}

          <div className="mt-4 border-t border-line pt-4">
            <button
              onClick={() => setShowClassPicker((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white"
            >
              <span
                className={`transition-transform ${
                  showClassPicker ? "rotate-90" : ""
                }`}
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

        <section className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <div className="rounded-lg border border-line bg-panel p-4">
            {mode === "image" ? (
              imageUrl ? (
                <div className="relative">
                  <img
                    ref={imgRef}
                    src={imageUrl}
                    alt="uploaded"
                    className={
                      status === "done" ? "hidden" : "w-full rounded-md"
                    }
                  />

                  <canvas
                    ref={imageCanvasRef}
                    className={
                      status === "done" ? "w-full rounded-md" : "hidden"
                    }
                  />
                </div>
              ) : (
                <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-line text-sm text-slate-500">
                  ยังไม่ได้เลือกรูปภาพ
                </div>
              )
            ) : (
              <div className="relative">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className={
                    cameraActive ? "w-full rounded-md scale-x-[-1]" : "hidden"
                  }
                />

                {cameraActive && (
                  <canvas
                    ref={overlayCanvasRef}
                    className="pointer-events-none absolute inset-0 h-full w-full rounded-md"
                  />
                )}

                {!cameraActive && (
                  <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-line text-sm text-slate-500">
                    กดปุ่ม "เปิดกล้อง" เพื่อเริ่มตรวจจับแบบเรียลไทม์
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="overflow-y-auto max-h-[50vh] rounded-lg border border-line bg-panel p-4">
            <div className="w-full flex justify-between items-center mb-3 font-mono text-xs uppercase tracking-[0.15em] text-slate-400">
              <div>ผลลัพธ์</div>
              <div>
                {analyzingCount > 0 && (
                  <span>กำลังวิเคราะห์ {analyzingCount} คน...</span>
                )}
              </div>
            </div>

            {personResults.length > 0 && (
              <div className="mb-5 space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-accent/20 bg-accent/5 p-3">
                    <p className="text-[10px] text-slate-500">ชุดนักศึกษา</p>
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
                    <div className="flex justify-between text-sm mt-1">
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
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-slate-300">วัยผู้ใหญ่</span>
                      <span className="font-semibold">{adultCount}</span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-slate-300">สูงวัย</span>
                      <span className="font-semibold">{elderlyCount}</span>
                    </div>
                  </div>
                </div>

                <div className="col-span-2">
                  <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
                    <span>วิเคราะห์การแต่งกาย</span>

                    <span>
                      {analyzedCount}/{personResults.length}
                    </span>
                  </div>

                  <div className="h-1 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full bg-accent transition-all duration-300"
                      style={{
                        width: `${
                          personResults.length > 0
                            ? (analyzedCount / personResults.length) * 100
                            : 0
                        }%`,
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
                {sortedDetections.map(({ det, originalIndex }) => {
                  const desc = personDescriptions[originalIndex];

                  const isPerson = det.classId === PERSON_CLASS_ID;

                  const attireLabel = getAttireLabel(desc?.attire);

                  return (
                    <li
                      key={originalIndex}
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

                        <span className="flex-1">{det.className}</span>

                        <span className="font-mono text-xs text-slate-400">
                          {(det.score * 100).toFixed(1)}%
                        </span>

                        {isPerson && (
                          <button
                            onClick={() =>
                              handleDescribePerson(det, originalIndex)
                            }
                            disabled={desc?.loading}
                            className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-slate-300 transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-50"
                          >
                            {desc?.loading
                              ? "กำลังวิเคราะห์..."
                              : "วิเคราะห์อีกครั้ง"}
                          </button>
                        )}
                      </div>

                      {isPerson && attireLabel && (
                        <div className="mt-2">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${getAttireClass(
                              desc?.attire,
                            )}`}
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
        </section>
      </main>
    </div>
  );
}
