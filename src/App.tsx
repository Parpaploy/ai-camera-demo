import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { COCO_CLASSES, detectObjects } from "./utils/yolo";
import { IouTracker, type TrackedDetection } from "./utils/tracker";
import {
  AttireDetectionMode,
  type AttireType,
  Mode,
  PersonDescriptionState,
  Status,
} from "./interfaces/demo.interface";
import {
  ATTIRE_DETECTION_MODES,
  ATTIRE_BOX_COLORS,
  BOX_COLORS,
  CAMERA_DETECT_INTERVAL_MS,
  CONF_THRESHOLD_RANGE,
  DEFAULT_ATTIRE_MODE,
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
  describePersonImages,
  describePersonImagesWithOllama,
  getOllamaModels,
  drawBoxes,
  drawImageDetections,
  getAttireClass,
  getAttireLabel,
  parseAgeGroupType,
  parseAttireType,
  parseGenderType,
} from "./functions/demo.func";
import type { BoxColorResolver, OllamaModel, PersonImageFrame } from "./functions/demo.func";
import Dashboard, { type DashboardView } from "./components/Dashboard";
import { PersonEventRecorder } from "./utils/personEvents";
import { getCameraId, getSyncState, queuePersonEvent, startDataSync, subscribeSync } from "./utils/dataSync";

interface PersonFrameQueue {
  startedAt: number;
  lastCapturedAt: number;
  frames: PersonImageFrame[];
  attempts: number;
  retryAfter: number;
}

const PERSON_QUEUE_FRAME_COUNT = 3;
const PERSON_QUEUE_SAMPLE_INTERVAL_MS = 1200;
const PERSON_QUEUE_MAX_ATTEMPTS = 3;
import {
  clearDetectionHistory,
  createHistoryId,
  loadDetectionHistory,
  persistDetectionHistory,
  type DetectionHistoryEntry,
  upsertDetectionHistory,
} from "./utils/detectionHistory";

type CameraHistorySession = {
  id: string;
  startedAt: number;
  attireMode: AttireDetectionMode;
};

type CameraSource = "browser" | "rdk-mipi";
type CameraFrameSource = HTMLVideoElement | HTMLImageElement;
type AppPage = "dashboard" | "detector";

function getPageFromPath(pathname: string): AppPage {
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean)[0] === "detector"
    ? "detector"
    : "dashboard";
}

function getDashboardViewFromPath(pathname: string): DashboardView {
  const view = pathname.replace(/\/+$/, "").split("/").filter(Boolean)[1];
  if (view === "stats" || view === "events" || view === "local-history") {
    return view === "local-history" ? "local" : view;
  }
  return "today";
}

function getPathForPage(page: AppPage, dashboardView: DashboardView = "today"): string {
  if (page === "detector") return "/detector";
  if (dashboardView === "today") return "/dashboard";
  return dashboardView === "local"
    ? "/dashboard/local-history"
    : `/dashboard/${dashboardView}`;
}

function getFrameDimensions(source: CameraFrameSource) {
  return source instanceof HTMLVideoElement
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

function buildHistoryEntry(
  base: Pick<
    DetectionHistoryEntry,
    "id" | "startedAt" | "source" | "attireMode"
  >,
  people: TrackedDetection[],
  descriptions: Record<number, PersonDescriptionState>,
): DetectionHistoryEntry {
  const categories = people.map(
    (person) => descriptions[person.trackId]?.attire,
  );
  const completedAt = Date.now();
  const targetCount = categories.filter((type) => type === "target").length;
  const otherCount = categories.filter((type) => type === "other").length;
  const uncertainCount = categories.filter(
    (type) => type === "uncertain",
  ).length;

  return {
    ...base,
    completedAt,
    durationMs: Math.max(0, completedAt - base.startedAt),
    peopleDetected: targetCount + otherCount + uncertainCount,
    targetCount,
    otherCount,
    uncertainCount,
    unclassifiedCount: 0,
  };
}

function buildCameraHistoryEntry(
  session: CameraHistorySession,
  completedAt: number,
  categories: (AttireType | undefined)[],
  retired: Record<AttireType | "unclassified", number>,
): DetectionHistoryEntry {
  const targetCount = categories.filter((type) => type === "target").length;
  const otherCount = categories.filter((type) => type === "other").length;
  const uncertainCount = categories.filter(
    (type) => type === "uncertain",
  ).length;

  return {
    ...session,
    completedAt,
    durationMs: Math.max(0, completedAt - session.startedAt),
    peopleDetected: targetCount + otherCount + uncertainCount + retired.target + retired.other + retired.uncertain,
    targetCount: targetCount + retired.target,
    otherCount: otherCount + retired.other,
    uncertainCount: uncertainCount + retired.uncertain,
    unclassifiedCount: 0,
    source: "camera",
  };
}

function getDetectionBoxColor(
  det: Parameters<BoxColorResolver>[0],
  descriptions: Record<number, PersonDescriptionState>,
): string {
  if (det.classId !== PERSON_CLASS_ID() || det.trackId === undefined) {
    return BOX_COLORS[det.classId % BOX_COLORS.length];
  }

  switch (descriptions[det.trackId]?.attire) {
    case "target":
      return ATTIRE_BOX_COLORS.target;
    case "other":
      return ATTIRE_BOX_COLORS.other;
    case "uncertain":
      return ATTIRE_BOX_COLORS.uncertain;
    default:
      return ATTIRE_BOX_COLORS.pending;
  }
}

let mipiCommandQueue: Promise<unknown> = Promise.resolve();

function queueMipiCommand<T>(command: () => Promise<T>): Promise<T> {
  const next = mipiCommandQueue.then(command, command);
  mipiCommandQueue = next.catch(() => undefined);
  return next;
}

function stopMipiBridge() {
  return queueMipiCommand(async () => {
    const response = await fetch("/api/mipi/stop", {
      method: "POST", keepalive: true, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("MIPI stop failed");
  });
}

async function waitForMipiBridge() {
  let response: Response;

  try {
    response = await fetch("/api/mipi/start", { method: "POST", signal: AbortSignal.timeout(25000) });
  } catch {
    throw new Error(
      "ติดต่อบริการกล้องไม่ได้ ให้รัน scripts/rdk_mipi_bridge.py บน RDK X5 ก่อน",
    );
  }

  const responseText = await response.text();
  let payload: { state?: string; error?: string } | null = null;
  try {
    payload = JSON.parse(responseText) as { state?: string; error?: string };
  } catch {
    // The Vite proxy can return a plain-text error when the bridge is offline.
  }

  if (!response.ok || payload?.state !== "ready") {
    throw new Error(
      payload?.error ||
        (responseText.trim()
          ? `บริการกล้องตอบกลับ HTTP ${response.status}: ${responseText.trim().slice(0, 240)}`
          : `บริการกล้องตอบกลับ HTTP ${response.status} โดยไม่มีรายละเอียด ตรวจว่า scripts/rdk_mipi_bridge.py ทำงานบน RDK X5 และเปิดพอร์ต 8765 แล้ว`),
    );
  }
}

export default function App() {
  const envApiKey = import.meta.env.VITE_GEMINI_API_KEY ?? "";
  const dataSync = useSyncExternalStore(subscribeSync, getSyncState);

  const [page, setPage] = useState<AppPage>(() => getPageFromPath(window.location.pathname));
  const [dashboardView, setDashboardView] = useState<DashboardView>(() => getDashboardViewFromPath(window.location.pathname));
  const [mode, setMode] = useState<Mode>("image");
  const [status, setStatus] = useState<Status>("idle");
  const [detections, setDetections] = useState<TrackedDetection[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraSource, setCameraSource] = useState<CameraSource>("browser");
  const [mipiStreamUrl, setMipiStreamUrl] = useState("");
  const [detectStreamUrl, setDetectStreamUrl] = useState("");
  const [detectPreviewOk, setDetectPreviewOk] = useState(false);

  const [attireMode, setAttireMode] =
    useState<AttireDetectionMode>(DEFAULT_ATTIRE_MODE);

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
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const [aiProvider, setAiProvider] = useState<"gemini" | "ollama">("gemini");
  const aiProviderRef = useRef(aiProvider);
  aiProviderRef.current = aiProvider;
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaModel, setOllamaModel] = useState("qwen3.5:2b");
  const [ollamaStatus, setOllamaStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [ollamaError, setOllamaError] = useState("");

  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [personDescriptions, setPersonDescriptions] = useState<
    Record<number, PersonDescriptionState>
  >({});
  const personDescriptionsRef = useRef(personDescriptions);
  const [history, setHistory] = useState<DetectionHistoryEntry[]>(
    loadDetectionHistory,
  );
  const historyRef = useRef(history);
  const imageHistorySessionRef = useRef<DetectionHistoryEntry | null>(null);
  const cameraHistorySessionRef = useRef<CameraHistorySession | null>(null);
  const cameraTrackSummariesRef = useRef<Map<string, AttireType | undefined>>(
    new Map(),
  );
  const cameraTrackEpochRef = useRef(0);
  const retiredCountsRef = useRef({ target: 0, other: 0, uncertain: 0, unclassified: 0 });

  const selectedClassesRef = useRef(selectedClasses);
  const confThresholdRef = useRef(confThreshold);
  const iouThresholdRef = useRef(iouThreshold);
  const modelUrlRef = useRef(modelUrl);
  const attireModeRef = useRef(attireMode);

  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mipiImageRef = useRef<HTMLImageElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef(0);
  const analysisEpochRef = useRef(0);
  const loopGenerationRef = useRef(0);
  const cameraLoopRef = useRef<number | null>(null);
  const cameraLoopActiveRef = useRef(false);
  const activeCameraSourceRef = useRef<CameraSource>("browser");
  const runningRef = useRef(false);
  const aiAnalysisRunningRef = useRef(false);
  const personFrameQueuesRef = useRef(new Map<number, PersonFrameQueue>());
  const leftPanelRef = useRef<HTMLDivElement>(null);

  const trackerRef = useRef(new IouTracker());
  const eventRecorderRef = useRef(new PersonEventRecorder(queuePersonEvent));
  useEffect(() => startDataSync(), []);

  const saveHistoryEntry = useCallback((entry: DetectionHistoryEntry) => {
    if (entry.peopleDetected === 0) return;
    const next = upsertDetectionHistory(historyRef.current, entry);
    historyRef.current = next;
    persistDetectionHistory(next);
    setHistory(next);
  }, []);

  const handleClearHistory = useCallback(() => {
    clearDetectionHistory();
    imageHistorySessionRef.current = null;
    historyRef.current = [];
    setHistory([]);
  }, []);

  const updatePersonDescription = useCallback(
    (trackId: number, description: PersonDescriptionState) => {
      eventRecorderRef.current.classify(trackId, description);
      if (!trackerRef.current.hasTrack(trackId)) {
        // A person can leave while AI is analyzing the cached crops.
        if (cameraHistorySessionRef.current && description.attire && !description.loading && !description.error) {
          retiredCountsRef.current[description.attire] += 1;
        }
        return;
      }
      const next = {
        ...personDescriptionsRef.current,
        [trackId]: description,
      };
      personDescriptionsRef.current = next;
      setPersonDescriptions(next);

      const key = `${cameraTrackEpochRef.current}:${trackId}`;
      if (
        cameraHistorySessionRef.current &&
        cameraTrackSummariesRef.current.has(key) && description.attire && !description.loading && !description.error
      ) {
        cameraTrackSummariesRef.current.set(key, description.attire);
      }
    },
    [],
  );

  selectedClassesRef.current = selectedClasses;
  confThresholdRef.current = confThreshold;
  iouThresholdRef.current = iouThreshold;
  modelUrlRef.current = modelUrl;
  attireModeRef.current = attireMode;
  personDescriptionsRef.current = personDescriptions;

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

  useEffect(() => {
    if (aiProvider !== "ollama") return;
    let active = true;
    setOllamaStatus("loading");
    setOllamaError("");
    getOllamaModels()
      .then((models) => {
        if (!active) return;
        setOllamaModels(models);
        setOllamaModel((current) =>
          models.some((model) => model.name === current)
            ? current
            : models.find((model) => model.name === "qwen3.5:2b")?.name ?? models[0]?.name ?? "",
        );
        setOllamaStatus(models.length ? "ready" : "error");
        if (!models.length) setOllamaError("ไม่พบโมเดลใน Ollama");
      })
      .catch((error) => {
        if (!active) return;
        setOllamaStatus("error");
        setOllamaError(error instanceof Error ? error.message : "ติดต่อ Ollama ไม่ได้");
      });
    return () => { active = false; };
  }, [aiProvider]);

  useEffect(() => {
    setPersonDescriptions({});
    personDescriptionsRef.current = {};
    imageHistorySessionRef.current = null;
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();
  }, [attireMode]);

  useEffect(() => {
    const session = imageHistorySessionRef.current;
    if (!session || mode !== "image") return;

    const people = detections.filter(
      (det) => det.classId === PERSON_CLASS_ID(),
    );
    const updated = buildHistoryEntry(
      session,
      people,
      personDescriptions,
    );
    imageHistorySessionRef.current = updated;
    saveHistoryEntry(updated);
  }, [detections, mode, personDescriptions, saveHistoryEntry]);

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
    eventRecorderRef.current.resetTracks();
    analysisEpochRef.current += 1;
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();
    cameraTrackEpochRef.current += 1;
    setPersonDescriptions({});
    personDescriptionsRef.current = {};
  }, []);

  const analyzePerson = useCallback(
    async (
      source: HTMLImageElement | HTMLVideoElement,
      det: TrackedDetection,
      trackId: number,
      queuedFrames?: PersonImageFrame[],
    ) => {
      const epoch = analysisEpochRef.current;
      if (!trackerRef.current.hasTrack(trackId) || trackerRef.current.isAnalyzed(trackId) || personDescriptionsRef.current[trackId]?.loading) return;
      const currentApiKey = apiKey.trim();

      if (aiProvider === "gemini" && !currentApiKey) {
        setShowApiKeyInput(true);
        updatePersonDescription(trackId, {
          loading: false,
          error: "กรุณากรอก Gemini API key ก่อน",
        });
        return;
      }

      let thumbnail: string;
      let dashboardThumbnail: string;

      try {
        thumbnail = queuedFrames?.[queuedFrames.length - 1]?.dataUrl ?? cropDetectionToDataUrl(source, det);
        dashboardThumbnail = queuedFrames?.[queuedFrames.length - 1]?.dataUrl ?? cropDetectionToDataUrl(source, det, 320, 0.65, 0.58);
      } catch (err) {
        if (epoch !== analysisEpochRef.current || !trackerRef.current.hasTrack(trackId)) return;
        console.error(err);
        updatePersonDescription(trackId, {
          loading: false,
          error: "ครอปภาพบุคคลไม่สำเร็จ",
        });
        return;
      }

      updatePersonDescription(trackId, { loading: true, thumbnail });
      eventRecorderRef.current.beginAnalysis(trackId);

      try {
        const frames = queuedFrames?.length
          ? queuedFrames
          : [{ dataUrl: thumbnail, frameIndex: 1, elapsedMs: 0 }];
        const text = aiProvider === "ollama"
          ? await describePersonImagesWithOllama(frames, ollamaModel, attireModeRef.current)
          : frames.length > 1
            ? await describePersonImages(frames, currentApiKey, attireModeRef.current)
            : await describePersonImage(thumbnail, currentApiKey, attireModeRef.current);
        if (epoch !== analysisEpochRef.current) return;
        if (!/\[(TARGET|OTHER|UNCERTAIN_ATTIRE)\]/i.test(text)) {
          throw new Error("AI ยังไม่ส่งผลจำแนกที่สมบูรณ์ จะลองใหม่ด้วยภาพชุดเดิม");
        }
        eventRecorderRef.current.attachThumbnail(trackId, dashboardThumbnail);
        const attire = parseAttireType(text);
        const gender = parseGenderType(text);
        const ageGroup = parseAgeGroupType(text);
        const cleanText = cleanGeminiText(text);

        updatePersonDescription(trackId, {
          loading: false,
          thumbnail,
          text: cleanText,
          attire,
          gender,
          ageGroup,
        });

        trackerRef.current.markAnalyzed(trackId);
        personFrameQueuesRef.current.delete(trackId);
      } catch (err) {
        if (epoch !== analysisEpochRef.current || !trackerRef.current.hasTrack(trackId)) return;
        console.error(err);
        updatePersonDescription(trackId, {
          loading: false,
          thumbnail,
          error:
            err instanceof Error
              ? err.message
              : `เกิดข้อผิดพลาดจาก ${aiProvider === "ollama" ? "Ollama" : "Gemini API"}`,
        });
      } finally {
        if (epoch === analysisEpochRef.current) eventRecorderRef.current.endAnalysis(trackId);
      }
    },
    [aiProvider, apiKey, ollamaModel, updatePersonDescription],
  );

  const analyzeAllPeople = useCallback(
    async (
      source: HTMLImageElement | HTMLVideoElement,
      results: TrackedDetection[],
      useCameraQueue = false,
    ) => {
      const people = results.filter((det) => det.classId === PERSON_CLASS_ID());
      if (people.length === 0) return;

      if (aiProvider === "gemini" && !apiKey.trim()) {
        setShowApiKeyInput(true);
        return;
      }

      if (aiProvider === "ollama" && (ollamaStatus !== "ready" || !ollamaModel)) {
        updatePersonDescription(people[0].trackId, {
          loading: false,
          error: ollamaError || "กำลังเชื่อมต่อ Ollama หรือยังไม่มีโมเดลให้เลือก",
        });
        return;
      }

      if (aiAnalysisRunningRef.current) return;

      const toAnalyze = people.filter(
        (det) => {
          if (trackerRef.current.isAnalyzed(det.trackId)) return false;
          const queue = personFrameQueuesRef.current.get(det.trackId);
          return !useCameraQueue || (!!queue && queue.frames.length >= PERSON_QUEUE_FRAME_COUNT &&
            queue.attempts < PERSON_QUEUE_MAX_ATTEMPTS && performance.now() >= queue.retryAfter);
        },
      );

      if (toAnalyze.length === 0) return;

      const epoch = analysisEpochRef.current;
      aiAnalysisRunningRef.current = true;

      try {
        for (const det of toAnalyze) {
          if (epoch !== analysisEpochRef.current) break;
          const queue = useCameraQueue ? personFrameQueuesRef.current.get(det.trackId) : undefined;
          if (useCameraQueue && (!queue || !trackerRef.current.hasTrack(det.trackId))) continue;
          const frames = queue?.frames.slice();
          if (queue) queue.attempts++;
          // Retain a full queue while the request runs: no recropping or image backlog.
          await analyzePerson(source, det, det.trackId, frames);
          if (queue) queue.retryAfter = performance.now() + 10_000 * 2 ** (queue.attempts - 1);
        }
      } finally {
        aiAnalysisRunningRef.current = false;
      }
    },
    [aiProvider, apiKey, ollamaError, ollamaModel, ollamaStatus, analyzePerson, updatePersonDescription],
  );

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    eventRecorderRef.current.finish();

    const url = URL.createObjectURL(file);

    setImageUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return url;
    });

    setDetections([]);
    personDescriptionsRef.current = {};
    imageHistorySessionRef.current = null;
    setPersonDescriptions({});
    setStatus("idle");
    setErrorMsg("");
    setInferenceMs(null);
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();
  }, []);

  const runImageDetection = useCallback(async () => {
    const img = imgRef.current;
    const canvas = imageCanvasRef.current;
    if (!img || !canvas) return;

    const historyStartedAt = Date.now();
    eventRecorderRef.current.begin(createHistoryId(), getCameraId(), "image", attireModeRef.current);
    imageHistorySessionRef.current = null;
    setErrorMsg("");
    setDetections([]);
    personDescriptionsRef.current = {};
    setPersonDescriptions({});
    setStatus("loading-model");
    personFrameQueuesRef.current.clear();
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
      eventRecorderRef.current.observe(
        tracked.filter(det => det.classId === PERSON_CLASS_ID()),
        id => trackerRef.current.hasTrack(id),
      );

      const people = tracked.filter(
        (det) => det.classId === PERSON_CLASS_ID(),
      );
      const historySession = buildHistoryEntry(
        {
          id: createHistoryId(),
          startedAt: historyStartedAt,
          source: "image",
          attireMode: attireModeRef.current,
        },
        people,
        personDescriptionsRef.current,
      );
      imageHistorySessionRef.current = historySession;
      saveHistoryEntry(historySession);

      setInferenceMs(performance.now() - start);
      setDetections(tracked);
      drawImageDetections(canvas, img, tracked, (det) =>
        getDetectionBoxColor(det, personDescriptionsRef.current),
      );
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
  }, [analyzeAllPeople, saveHistoryEntry]);

  useEffect(() => {
    if (mode !== "image" || status !== "done") return;

    const img = imgRef.current;
    const canvas = imageCanvasRef.current;
    if (!img || !canvas || !img.complete) return;

    drawImageDetections(canvas, img, detections, (det) =>
      getDetectionBoxColor(det, personDescriptions),
    );
  }, [detections, imageUrl, mode, personDescriptions, status]);

  const stopCamera = useCallback(() => {
    eventRecorderRef.current.finish();
    cameraRequestIdRef.current += 1;
    analysisEpochRef.current += 1;
    loopGenerationRef.current += 1;
    const shouldStopMipi =
      activeCameraSourceRef.current === "rdk-mipi";
    cameraLoopActiveRef.current = false;
    if (cameraLoopRef.current !== null) {
      window.clearTimeout(cameraLoopRef.current);
      cameraLoopRef.current = null;
    }

    // An in-flight inference owns this flag until its finally block.
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (mipiImageRef.current) {
      mipiImageRef.current.removeAttribute("src");
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (shouldStopMipi) {
      void stopMipiBridge().catch(() => undefined);
    }

    const cameraSession = cameraHistorySessionRef.current;
    if (cameraSession) {
      saveHistoryEntry(
        buildCameraHistoryEntry(
          cameraSession,
          Date.now(),
          [...cameraTrackSummariesRef.current.values()],
          retiredCountsRef.current,
        ),
      );
      cameraHistorySessionRef.current = null;
    }

    setCameraActive(false);
    setMipiStreamUrl("");
    setDetectStreamUrl("");
    setDetectPreviewOk(false);
    setStatus("idle");
    setDetections([]);
    setPersonDescriptions({});
    personDescriptionsRef.current = {};
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();

    const overlay = overlayCanvasRef.current;
    if (overlay) {
      const ctx = overlay.getContext("2d");
      ctx?.clearRect(0, 0, overlay.width, overlay.height);
      overlay.width = 0;
      overlay.height = 0;
    }
  }, [saveHistoryEntry]);

  const cameraLoop = useCallback(async (generation: number) => {
    const isCurrent = () => cameraLoopActiveRef.current && generation === loopGenerationRef.current;
    const source =
      activeCameraSourceRef.current === "rdk-mipi"
        ? mipiImageRef.current
        : videoRef.current;
    const overlay = overlayCanvasRef.current;

    if (!isCurrent()) return;

    // RDK X5 runs its own detect/track/classify pipeline (scripts/rdk_detector.py) and
    // posts results straight to the Data API; the browser only shows the raw MJPEG stream.
    if (activeCameraSourceRef.current === "rdk-mipi") return;

    const sourceReady =
      source &&
      (source instanceof HTMLVideoElement
        ? source.readyState >= 2
        : source.naturalWidth > 0 && source.naturalHeight > 0);

    if (!source || !overlay || !sourceReady) {
      if (isCurrent()) {
        cameraLoopRef.current = window.setTimeout(
          () => cameraLoop(generation),
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
      return;
    }

    if (runningRef.current) {
      if (isCurrent()) {
        cameraLoopRef.current = window.setTimeout(
          () => cameraLoop(generation),
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
      return;
    }

    runningRef.current = true;

    try {
      const start = performance.now();
      const { width, height } = getFrameDimensions(source);

      const rawResults = await detectObjects(source, {
        modelUrl: modelUrlRef.current,
        confThreshold: confThresholdRef.current,
        iouThreshold: iouThresholdRef.current,
      });

      if (!isCurrent()) return;
      const filtered = rawResults.filter((d) =>
        selectedClassesRef.current.has(d.classId),
      );

      const tracked = trackerRef.current.update(filtered);
      eventRecorderRef.current.observe(
        tracked.filter(det => det.classId === PERSON_CLASS_ID()),
        id => trackerRef.current.hasTrack(id),
      );
      const trackedPeople = tracked.filter(det => det.classId === PERSON_CLASS_ID());
      const sampleNow = performance.now();
      for (const trackId of personFrameQueuesRef.current.keys()) {
        if (!trackerRef.current.hasTrack(trackId)) personFrameQueuesRef.current.delete(trackId);
      }
      if (aiProviderRef.current === "ollama" || apiKeyRef.current.trim()) {
        for (const det of trackedPeople) {
          if (trackerRef.current.isAnalyzed(det.trackId)) {
            personFrameQueuesRef.current.delete(det.trackId);
            continue;
          }
          let queue = personFrameQueuesRef.current.get(det.trackId);
          if (!queue) {
            queue = { startedAt: sampleNow, lastCapturedAt: 0, frames: [], attempts: 0, retryAfter: 0 };
            personFrameQueuesRef.current.set(det.trackId, queue);
          }
          const readyToSample = queue.frames.length === 0 ||
            sampleNow - queue.lastCapturedAt >= PERSON_QUEUE_SAMPLE_INTERVAL_MS;
          if (queue.frames.length < PERSON_QUEUE_FRAME_COUNT && readyToSample) {
            try {
              queue.frames.push({
                dataUrl: cropDetectionToDataUrl(source, det, 384, 0.72, 0.58),
                frameIndex: queue.frames.length + 1,
                elapsedMs: sampleNow - queue.startedAt,
              });
              queue.lastCapturedAt = sampleNow;
            } catch (error) {
              console.warn(`เก็บภาพเฟรมของ Track ${det.trackId} ไม่สำเร็จ`, error);
              personFrameQueuesRef.current.delete(det.trackId);
            }
          }
        }
      }
      for (const [key, attire] of cameraTrackSummariesRef.current) {
        const [epoch, id] = key.split(":").map(Number);
        if (epoch !== cameraTrackEpochRef.current || !trackerRef.current.hasTrack(id)) {
          if (attire) retiredCountsRef.current[attire] += 1;
          cameraTrackSummariesRef.current.delete(key);
        }
      }
      const descriptions = Object.fromEntries(
        Object.entries(personDescriptionsRef.current).filter(([id]) =>
          trackerRef.current.hasTrack(Number(id)),
        ),
      );
      personDescriptionsRef.current = descriptions;
      setPersonDescriptions(descriptions);

      tracked
        .filter((det) => det.classId === PERSON_CLASS_ID())
        .forEach((det) => {
          const key = `${cameraTrackEpochRef.current}:${det.trackId}`;
          if (!cameraTrackSummariesRef.current.has(key)) {
            cameraTrackSummariesRef.current.set(
              key,
              personDescriptionsRef.current[det.trackId]?.attire,
            );
          }
        });

      setInferenceMs(performance.now() - start);
      setDetections(tracked);

      if (overlay.width !== width || overlay.height !== height) {
        overlay.width = width;
        overlay.height = height;
      }

      const ctx = overlay.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawBoxes(ctx, width, tracked, (det) =>
          getDetectionBoxColor(det, personDescriptionsRef.current),
        );
      }

      setStatus("done");
      setErrorMsg("");

      if (!aiAnalysisRunningRef.current) void analyzeAllPeople(source, tracked, true);
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Detection failed. Check that the model file exists.",
      );
      setStatus("error");
    } finally {
      runningRef.current = false;

      if (isCurrent()) {
        cameraLoopRef.current = window.setTimeout(
          () => cameraLoop(generation),
          CAMERA_DETECT_INTERVAL_MS,
        );
      }
    }
  }, [analyzeAllPeople]);

  const startCamera = useCallback(async () => {
    const requestId = ++cameraRequestIdRef.current;
    analysisEpochRef.current += 1;
    setErrorMsg("");
    setStatus("loading-model");
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();

    try {
      activeCameraSourceRef.current = cameraSource;

      if (cameraSource === "rdk-mipi") {
        await queueMipiCommand(async () => {
          if (requestId === cameraRequestIdRef.current) await waitForMipiBridge();
        });

        if (requestId !== cameraRequestIdRef.current) {
          return;
        }

        setMipiStreamUrl(`/api/mipi/stream.mjpg?session=${Date.now()}`);
        setDetectStreamUrl(`/api/detect/annotated.mjpg?session=${Date.now()}`);
        setDetectPreviewOk(false);
        cameraLoopActiveRef.current = true;
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (requestId !== cameraRequestIdRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        cameraLoopActiveRef.current = true;
      }

      personFrameQueuesRef.current.clear();
      cameraTrackSummariesRef.current.clear();
      retiredCountsRef.current = { target: 0, other: 0, uncertain: 0, unclassified: 0 };
      cameraTrackEpochRef.current = 0;
      cameraHistorySessionRef.current = {
        id: createHistoryId(),
        startedAt: Date.now(),
        attireMode: attireModeRef.current,
      };
      // RDK X5 posts events from scripts/rdk_detector.py directly; this browser tab
      // never observes tracks for that source, so it never starts a local recorder session.
      if (cameraSource !== "rdk-mipi") {
        eventRecorderRef.current.begin(cameraHistorySessionRef.current.id, getCameraId(), "camera", attireModeRef.current);
      }
      setCameraActive(true);
      setStatus("running");
    } catch (err) {
      if (requestId !== cameraRequestIdRef.current) return;
      console.error(err);
      cameraLoopActiveRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      activeCameraSourceRef.current = "browser";
      setCameraActive(false);
      setStatus("error");
      setErrorMsg(
        err instanceof Error
          ? `เปิดกล้องไม่สำเร็จ: ${err.message}`
          : cameraSource === "rdk-mipi"
            ? "เปิดกล้อง MIPI ไม่สำเร็จ ตรวจสอบบริการบน RDK X5 และการเชื่อมต่อกล้อง"
            : "เปิดกล้องไม่สำเร็จ ตรวจสอบสิทธิ์การเข้าถึงกล้องของเบราว์เซอร์",
      );
    }
  }, [cameraSource]);

  useEffect(() => {
    if (!cameraActive) return;
    const generation = ++loopGenerationRef.current;

    if (activeCameraSourceRef.current === "rdk-mipi") {
      cameraLoopRef.current = window.setTimeout(() => cameraLoop(generation), 200);

      return () => {
        loopGenerationRef.current += 1;
        if (cameraLoopRef.current !== null) {
          window.clearTimeout(cameraLoopRef.current);
          cameraLoopRef.current = null;
        }
      };
    }

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    video
      .play()
      .then(() => {
        if (streamRef.current === stream && generation === loopGenerationRef.current) {
          cameraLoopRef.current = window.setTimeout(() => cameraLoop(generation), 200);
        }
      })
      .catch((err) => {
        if (generation !== loopGenerationRef.current) return;
        console.error("Video play failed:", err);
        setErrorMsg(
          "ไม่สามารถแสดงภาพจากกล้องได้ กรุณาตรวจสอบสิทธิ์กล้องของเบราว์เซอร์",
        );
        setStatus("error");
      });

    return () => {
      loopGenerationRef.current += 1;
      if (cameraLoopRef.current !== null) {
        window.clearTimeout(cameraLoopRef.current);
        cameraLoopRef.current = null;
      }
    };
  }, [cameraActive, cameraLoop]);

  useEffect(() => {
    if (!cameraActive || cameraSource !== "rdk-mipi") return;
    let disposed = false;
    let timer: number;
    let consecutiveFailures = 0;
    let warningShown = false;
    const checkHealth = async () => {
      try {
        const response = await fetch("/api/mipi/status", {
          signal: AbortSignal.timeout(8000), cache: "no-store",
        });
        if (!response.ok) throw new Error("ติดต่อบริการกล้อง MIPI ไม่ได้");
        const health = await response.json();
        if (disposed) return;
        if (health.state === "error" || health.state === "stopped") {
          stopCamera();
          setStatus("error");
          setErrorMsg(health.error || "กล้อง MIPI หยุดส่งภาพแล้ว");
          return;
        }
        consecutiveFailures = 0;
        if (health.state === "ready" && warningShown) {
          warningShown = false;
          setErrorMsg("");
        }
      } catch (error) {
        if (disposed) return;
        consecutiveFailures++;
        if (consecutiveFailures >= 3 && !warningShown) {
          warningShown = true;
          setErrorMsg("ติดต่อสถานะกล้อง MIPI ไม่สำเร็จชั่วคราว กำลังลองเชื่อมต่อใหม่");
        }
      }
      if (!disposed) timer = window.setTimeout(checkHealth, 2000);
    };
    timer = window.setTimeout(checkHealth, 2000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [cameraActive, cameraSource, stopCamera]);

  useEffect(() => {
    if (mode === "image") stopCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const releaseMipiOnPageExit = () => {
      if (activeCameraSourceRef.current === "rdk-mipi") {
        navigator.sendBeacon?.("/api/mipi/stop");
      }
    };

    window.addEventListener("pagehide", releaseMipiOnPageExit);
    return () =>
      window.removeEventListener("pagehide", releaseMipiOnPageExit);
  }, []);

  const switchMode = (next: Mode) => {
    if (next === mode) return;

    setDetections([]);
    setErrorMsg("");
    setStatus("idle");
    setPersonDescriptions({});
    personDescriptionsRef.current = {};
    imageHistorySessionRef.current = null;
    setInferenceMs(null);
    personFrameQueuesRef.current.clear();
    trackerRef.current.reset();

    if (next === "image") stopCamera();
    setMode(next);
  };

  const openDashboard = () => {
    if (cameraActive || (mode === "camera" && status === "loading-model")) stopCamera();
    navigatePage("dashboard");
  };

  const navigatePage = (nextPage: AppPage) => {
    const nextPath = getPathForPage(nextPage, dashboardView);
    if (nextPage === page && window.location.pathname === nextPath) return;
    window.history.pushState(
      { ...(window.history.state ?? {}), aiCameraPage: nextPage, aiCameraDashboardView: dashboardView },
      "",
      `${nextPath}${window.location.search}${window.location.hash}`,
    );
    setPage(nextPage);
    window.scrollTo(0, 0);
  };

  const navigateDashboardView = (nextView: DashboardView) => {
    const nextPath = getPathForPage("dashboard", nextView);
    if (page === "dashboard" && window.location.pathname === nextPath) return;
    window.history.pushState(
      { ...(window.history.state ?? {}), aiCameraPage: "dashboard", aiCameraDashboardView: nextView },
      "",
      `${nextPath}${window.location.search}${window.location.hash}`,
    );
    setPage("dashboard");
    setDashboardView(nextView);
    window.scrollTo(0, 0);
  };

  const startDetectionFromDashboard = (nextMode: Mode) => {
    if (nextMode !== mode) switchMode(nextMode);
    navigatePage("detector");
  };

  useEffect(() => {
    const currentPage = getPageFromPath(window.location.pathname);
    const currentDashboardView = getDashboardViewFromPath(window.location.pathname);
    const canonicalPath = getPathForPage(currentPage, currentDashboardView);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(
        { ...(window.history.state ?? {}), aiCameraPage: currentPage, aiCameraDashboardView: currentDashboardView },
        "",
        `${canonicalPath}${window.location.search}${window.location.hash}`,
      );
    }
    const handlePopState = () => {
      const nextPage = getPageFromPath(window.location.pathname);
      const nextDashboardView = nextPage === "dashboard"
        ? getDashboardViewFromPath(window.location.pathname)
        : window.history.state?.aiCameraDashboardView === "stats" ||
            window.history.state?.aiCameraDashboardView === "events" ||
            window.history.state?.aiCameraDashboardView === "local"
          ? window.history.state.aiCameraDashboardView as DashboardView
          : "today";
      const nextPath = getPathForPage(nextPage, nextDashboardView);
      if (window.location.pathname !== nextPath) {
        window.history.replaceState(
          { ...(window.history.state ?? {}), aiCameraPage: nextPage, aiCameraDashboardView: nextDashboardView },
          "",
          `${nextPath}${window.location.search}${window.location.hash}`,
        );
      }
      if (nextPage === "dashboard") stopCamera();
      setPage(nextPage);
      setDashboardView(nextDashboardView);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [stopCamera]);

  const handleAttireModeChange = (nextMode: AttireDetectionMode) => {
    if (cameraActive) stopCamera();
    setAttireMode(nextMode);
  };

  const handleDescribePerson = useCallback(
    async (det: TrackedDetection) => {
      const source =
        mode === "image"
          ? imgRef.current
          : cameraSource === "rdk-mipi"
            ? mipiImageRef.current
            : videoRef.current;
      if (!source) return;
      if (aiAnalysisRunningRef.current) return;
      const queue = personFrameQueuesRef.current.get(det.trackId);
      if (mode === "camera" && (!queue || queue.frames.length < PERSON_QUEUE_FRAME_COUNT)) return;
      aiAnalysisRunningRef.current = true;
      try {
        await analyzePerson(source, det, det.trackId, mode === "camera" ? queue?.frames.slice() : undefined);
      } finally {
        if (queue) queue.retryAfter = performance.now() + 10_000;
        aiAnalysisRunningRef.current = false;
      }
    },
    [mode, cameraSource, analyzePerson],
  );

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const sortedDetections = [...detections].sort((a, b) => b.score - a.score);

  // RDK X5 runs detection on-device; this tab shows the raw stream only, so the
  // local per-person panel/AI controls (which would just stay empty) are hidden.
  const isRdkLive = mode === "camera" && cameraSource === "rdk-mipi";

  const personResults = detections.filter(
    (det) => det.classId === PERSON_CLASS_ID(),
  );

  const targetCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "target",
  ).length;

  const otherCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "other",
  ).length;

  const uncertainCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.attire === "uncertain",
  ).length;

  const analyzingCount = personResults.filter(
    (det) => personDescriptions[det.trackId]?.loading,
  ).length;

  const analyzedCount = targetCount + otherCount + uncertainCount;

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

  const targetLabel =
    attireMode === "student"
      ? "นักศึกษา/บุคลากร"
      : ATTIRE_DETECTION_MODES.find((m) => m.id === attireMode)?.label ??
        "เป้าหมาย";
  const otherAttireLabel =
    attireMode === "student" ? "บุคคลภายนอก" : "ชุดทั่วไป";

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <a href="#main-content" className="sr-only z-50 rounded-md bg-accent px-4 py-2 font-semibold text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      {(dataSync.authorized || page === "detector") && <header className="border-b border-line bg-panel px-4 py-2 sm:px-6">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <div className="min-w-0">
            <h1 className="font-display text-lg font-semibold tracking-tight text-white sm:text-xl">AI Camera <span className="hidden border-l border-line pl-2 font-sans text-sm font-normal text-slate-400 sm:inline">ตรวจจับและวิเคราะห์บุคคล</span></h1>
          </div>

          <div className="flex w-full flex-wrap items-center justify-between gap-3 lg:w-auto lg:justify-end">
            <nav
              className="inline-flex rounded-lg bg-ink p-1"
              aria-label="เมนูหลัก"
            >
              <button
                onClick={openDashboard}
                aria-current={page === "dashboard" ? "page" : undefined}
              className={`min-h-11 rounded px-4 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  page === "dashboard"
                    ? "bg-accent text-ink"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                ภาพรวม
              </button>
              <button
                onClick={() => navigatePage("detector")}
                aria-current={page === "detector" ? "page" : undefined}
              className={`min-h-11 rounded px-4 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  page === "detector"
                    ? "bg-accent text-ink"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                ตรวจจับ
              </button>
            </nav>
            {page === "detector" && !isRdkLive && <label className="flex items-center gap-2 text-sm text-slate-300">
              <span className="hidden sm:inline">AI สำหรับวิเคราะห์ภาพ</span>
              <span className="sm:hidden">AI</span>
              <select
                value={aiProvider}
                onChange={(event) => {
                  const next = event.target.value as "gemini" | "ollama";
                  setAiProvider(next);
                  if (next === "gemini" && !apiKey.trim()) setShowApiKeyInput(true);
                }}
                className="min-h-11 rounded-md border border-line bg-panel px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                aria-label="เลือก AI สำหรับวิเคราะห์ภาพ"
              >
                <option value="gemini">Gemini</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>}
            {page === "detector" && !isRdkLive && (aiProvider === "gemini" ? (
              <button
                onClick={() => setShowApiKeyInput((value) => !value)}
                aria-expanded={showApiKeyInput}
                className="rounded-md px-2 py-1 text-sm text-slate-300 underline decoration-line underline-offset-4 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {apiKey ? "จัดการ Gemini" : "ตั้งค่า Gemini"}
              </button>
            ) : (
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span className="sr-only">โมเดล Ollama</span>
                <select value={ollamaModel} onChange={(event) => setOllamaModel(event.target.value)} disabled={ollamaStatus !== "ready" || !ollamaModels.length} aria-label="โมเดล Ollama" className="min-h-11 max-w-48 rounded-md border border-line bg-ink px-3 text-sm text-slate-100 disabled:opacity-50">
                  {ollamaModels.length ? ollamaModels.map((model) => <option key={model.name} value={model.name}>{model.name}</option>) : <option value="">{ollamaStatus === "loading" ? "กำลังเชื่อมต่อ…" : "ไม่พบโมเดล"}</option>}
                </select>
              </label>
            ))}
          </div>
        </div>

        {page === "detector" && !isRdkLive && showApiKeyInput && aiProvider === "gemini" && (
          <div id="gemini-settings" className="mx-auto mt-3 flex max-w-screen-2xl flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-4">
            <label htmlFor="gemini-key" className="w-full text-sm font-medium text-slate-200">Gemini API key</label>
            <input
              id="gemini-key"
              type="password"
              autoComplete="off"
              aria-label="Gemini API key"
              placeholder="วาง API key ที่นี่"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:max-w-md"
            />
            <button
              type="button"
              onClick={handleUseEnvApiKey}
              disabled={!envApiKey}
              className="rounded-md border border-line px-3 py-2 text-sm text-slate-200 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              ใช้ API key จาก .env
            </button>
            <button
              type="button"
              onClick={() => {
                setApiKey("");
                sessionStorage.removeItem(SESSION_API_KEY);
              }}
              className="rounded-md border border-line px-3 py-2 text-sm text-slate-300 transition hover:border-warn hover:text-warn"
            >
              ล้าง
            </button>
            <span className="text-sm text-slate-300">
              {envApiKey
                ? "มี API key จาก .env · ค่าที่กรอกเองจะ override"
                : "ไม่พบ API key ใน .env · กรุณากรอกเอง"}
            </span>
          </div>
        )}
        {page === "detector" && !isRdkLive && aiProvider === "ollama" && ollamaStatus === "error" && <p className="mx-auto mt-2 max-w-screen-2xl text-xs text-warn" role="alert">{ollamaError} · ตรวจ OLLAMA_BASE_URL ใน .env.server</p>}
      </header>}

      {page === "dashboard" ? (
        <Dashboard
          history={history}
          onStartDetection={startDetectionFromDashboard}
          onClearHistory={handleClearHistory}
          view={dashboardView}
          onViewChange={navigateDashboardView}
        />
      ) : (
      <main
        id="main-content"
        className={`mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 lg:grid lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)] lg:gap-4 ${
          mode === "camera"
            ? "py-3 lg:h-[calc(100dvh-4.5rem)] lg:min-h-0 lg:overflow-hidden"
            : "py-6 sm:py-8"
        }`}
      >
        <aside className="mb-4 min-w-0 space-y-4 lg:mb-0 lg:min-h-0 lg:overflow-y-auto lg:pr-2" aria-label="ตั้งค่าการตรวจจับ">
        <div className={mode === "camera" ? "mb-1" : "mb-6"}>
          <h2 className={`font-semibold tracking-tight text-white ${mode === "camera" ? "text-xl" : "text-2xl"}`}>ตรวจจับบุคคล</h2>
          <p className="mt-1 text-sm text-slate-400">{mode === "camera" ? "เลือกกล้อง เปิดภาพสด แล้วดูผลทางขวา" : "เลือกรูปภาพ แล้วเริ่มวิเคราะห์"}</p>
        </div>
        <div className="mb-2 text-xs font-semibold text-slate-300">แหล่งภาพ</div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="รูปแบบการตรวจจับ" className="grid w-full grid-cols-2 rounded-lg border border-line bg-panel p-1">
            <button
              onClick={() => switchMode("image")}
              aria-pressed={mode === "image"}
                className={`min-h-11 rounded px-2 py-1.5 text-sm font-medium transition ${
                mode === "image"
                  ? "bg-accent text-ink"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              อัปโหลดรูปภาพ
            </button>
            <button
              onClick={() => switchMode("camera")}
              aria-pressed={mode === "camera"}
                className={`min-h-11 rounded px-2 py-1.5 text-sm font-medium transition ${
                mode === "camera"
                  ? "bg-accent text-ink"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              กล้องสด
            </button>
          </div>

        </div>
        <div className="mb-2 text-xs font-semibold text-slate-300">ประเภทการวิเคราะห์</div>
        <div role="group" aria-label="ประเภทการวิเคราะห์" className="grid gap-2">
          {ATTIRE_DETECTION_MODES.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleAttireModeChange(opt.id)}
              aria-pressed={attireMode === opt.id}
              title={opt.description}
              className={`min-h-10 rounded-lg border px-3 py-2 text-left text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                attireMode === opt.id
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line bg-panel text-slate-300 hover:border-slate-500 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {mode === "image" && (
          <p className="text-sm text-slate-300">
            {ATTIRE_DETECTION_MODES.find((m) => m.id === attireMode)?.description}
          </p>
        )}

        <section className="rounded-xl border border-line bg-panel p-4">
          {mode === "image" ? (
            <div className="grid gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:brightness-110"
              >
                {imageUrl ? "เปลี่ยนรูปภาพ" : "เลือกรูปภาพ"}
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
                className="min-h-11 rounded-md border border-line px-4 py-2 text-sm font-medium transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
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
                  ตรวจจับ {detections.length} รายการ · {inferenceMs.toFixed(0)} ms
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="mb-4 grid gap-2">
                <span className="text-sm font-medium text-slate-300">
                  แหล่งกล้อง
                </span>
                <div
                  role="group"
                  aria-label="เลือกแหล่งกล้อง"
                  className="grid grid-cols-2 rounded-md border border-line bg-ink p-1"
                >
                  {(
                    [
                      ["browser", "กล้องเบราว์เซอร์"],
                      ["rdk-mipi", "RDK X5 · MIPI"],
                    ] as const
                  ).map(([source, label]) => (
                    <button
                      key={source}
                      type="button"
                      onClick={() => setCameraSource(source)}
                      disabled={cameraActive || status === "loading-model"}
                      aria-pressed={cameraSource === source}
                      className={`min-h-11 rounded px-1 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                        cameraSource === source
                          ? "bg-accent text-ink"
                          : "text-slate-300 hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400">
                  {cameraSource === "rdk-mipi"
                    ? "ต้องเปิดแอปจาก RDK X5 และรันบริการกล้องบนบอร์ด"
                    : "ใช้กล้องที่เบราว์เซอร์เลือกให้"}
                </p>
              </div>

              <div className="grid gap-2">
                {!cameraActive ? (
                  <button
                    onClick={startCamera}
                    disabled={status === "loading-model"}
                    className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:brightness-110 disabled:opacity-40"
                  >
                    {status === "loading-model"
                      ? cameraSource === "rdk-mipi"
                        ? "กำลังเชื่อมต่อ MIPI..."
                        : "กำลังเปิดกล้อง..."
                      : cameraSource === "rdk-mipi"
                        ? "เปิดกล้อง MIPI"
                        : "เปิดกล้อง"}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={stopCamera}
                      className="min-h-11 rounded-md border border-warn/50 px-4 py-2 text-sm font-medium text-warn transition hover:bg-warn/10"
                    >
                      ปิดกล้อง
                    </button>
                    {cameraSource !== "rdk-mipi" && (
                      <button
                        onClick={handleResetTracking}
                        className="min-h-11 rounded-md border border-line px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-accent hover:text-accent"
                        title="ล้าง track ID ทั้งหมด แล้ววิเคราะห์ทุกคนใหม่"
                      >
                        รีเซ็ต tracking
                      </button>
                    )}
                  </>
                )}

                {cameraActive && cameraSource !== "rdk-mipi" && (
                  <span className="text-sm text-slate-300" role="status" aria-live="polite">
                    {personResults.length} คนในภาพ · {analyzingCount > 0 ? `กำลังวิเคราะห์ ${analyzingCount} คน` : `${analyzedCount} คนวิเคราะห์แล้ว`}
                  </span>
                )}
                {cameraActive && cameraSource === "rdk-mipi" && (
                  <span className="text-sm text-slate-300" role="status" aria-live="polite">
                    RDK X5 กำลังตรวจจับและบันทึกข้อมูลอัตโนมัติ
                  </span>
                )}
              </div>
            </>
          )}

          {errorMsg && (
            <div className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              {errorMsg}
              <p className="mt-1 text-xs text-warn/80">
                {mode === "camera" && cameraSource === "rdk-mipi"
                  ? "ตรวจสอบกล้อง MIPI และบริการ scripts/rdk_mipi_bridge.py บน RDK X5"
                  : "วางไฟล์โมเดลที่ export แล้วไว้ที่ public/models/"}
              </p>
            </div>
          )}

          <details className="mt-4 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-300 outline-none hover:text-white focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              ตั้งค่าขั้นสูง <span className="ml-2 text-xs font-normal text-slate-400">โมเดลและความแม่นยำ</span>
            </summary>
            <div className="pt-4">
          <div className="mb-4">
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

          <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
                <span>ความมั่นใจขั้นต่ำ</span>
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
              <p className="mt-1 text-xs text-slate-400">
                ค่าสูงช่วยลดการจับผิด แต่อาจพลาดคนที่เห็นไม่ชัด
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
                <span>ลดกรอบตรวจจับที่ซ้อนกัน</span>
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
              <p className="mt-1 text-xs text-slate-400">
                ค่าต่ำจะรวมกรอบที่ทับกันมากขึ้น
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
            </div>
          </details>
        </section>
        </aside>

        <section className={`grid min-w-0 gap-4 ${mode === "camera" ? "min-h-0 lg:h-full lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]" : "items-start xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]"}`}>
          <div className={`min-w-0 ${mode === "camera" ? "min-h-0" : ""}`} ref={leftPanelRef}>
            <div className={`flex w-full flex-col overflow-hidden rounded-xl border border-line bg-panel ${mode === "camera" ? "h-full min-h-0 p-2" : "p-4"}`}>
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
                  <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-ink/50 px-6 text-center text-sm text-slate-300">
                    <span className="text-base font-medium text-slate-100">เลือกรูปภาพเพื่อเริ่มวิเคราะห์</span>
                    <span>รองรับไฟล์ภาพจากอุปกรณ์นี้</span>
                  </div>
                )
              ) : (
                <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black lg:aspect-auto lg:h-full lg:min-h-0">
                  {cameraActive ? (
                    <>
                      {cameraSource === "rdk-mipi" ? (
                        <>
                          <img
                            ref={mipiImageRef}
                            src={mipiStreamUrl}
                            alt="ภาพสดจากกล้อง MIPI ของ RDK X5"
                            onError={() => {
                              if (!cameraLoopActiveRef.current) return;
                              stopCamera();
                              setStatus("error");
                              setErrorMsg(
                                "รับภาพจากกล้อง MIPI ไม่ได้ ตรวจสอบบริการบน RDK X5 แล้วลองปิดและเปิดกล้องใหม่",
                              );
                            }}
                            className="absolute inset-0 block h-full w-full object-contain"
                          />
                          {/* Overlay with boxes drawn by rdk_detector.py. Independent of the raw
                              stream above — if the detector isn't running yet/crashed, this just
                              stays hidden and the plain camera feed underneath keeps showing. */}
                          <img
                            src={detectStreamUrl}
                            alt="ภาพพร้อมกรอบตรวจจับจาก RDK X5"
                            onLoad={() => setDetectPreviewOk(true)}
                            onError={() => setDetectPreviewOk(false)}
                            className={`absolute inset-0 block h-full w-full object-contain ${detectPreviewOk ? "" : "hidden"}`}
                          />
                        </>
                      ) : (
                        <video
                          ref={videoRef}
                          playsInline
                          muted
                          autoPlay
                          className="absolute inset-0 block h-full w-full scale-x-[-1] object-contain"
                        />
                      )}
                      <canvas
                        ref={overlayCanvasRef}
                        className="pointer-events-none absolute inset-0 h-full w-full"
                      />
                    </>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 border border-dashed border-line px-6 text-center text-sm text-[#d6e0da]">
                      <span className="text-base font-medium text-[#f5f8f4]">พร้อมเริ่มตรวจจับ</span>
                      <span>เลือกแหล่งกล้อง แล้วกด “เปิดกล้อง”</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={`min-w-0 ${mode === "camera" ? "min-h-0" : ""}`}>
            <div
              className={`flex w-full flex-col rounded-xl border border-line bg-panel p-4 ${mode === "camera" ? "h-full min-h-0 overflow-hidden" : "min-h-64 overflow-y-auto"}`}
              style={
                mode === "camera"
                  ? undefined
                  : resultsPanelHeight
                  ? {
                      height: resultsPanelHeight,
                      maxHeight: resultsPanelHeight,
                    }
                  : undefined
              }
            >
              {isRdkLive ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm font-medium text-slate-100">
                    RDK X5 กำลังตรวจจับและบันทึกข้อมูลอัตโนมัติ
                  </p>
                  <p className="max-w-xs text-xs text-slate-400">
                    การตรวจจับ ติดตามบุคคล และวิเคราะห์การแต่งกายทำงานบนบอร์ด RDK X5
                    (scripts/rdk_detector.py) แล้วส่งผลเข้าฐานข้อมูลตรง ดูสรุปผลได้ที่หน้าภาพรวม
                  </p>
                  <button
                    onClick={openDashboard}
                    className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink transition hover:brightness-110"
                  >
                    ไปที่หน้าภาพรวม
                  </button>
                </div>
              ) : (
              <>
              <div className="mb-3 flex w-full shrink-0 items-center justify-between border-b border-line pb-3 text-sm text-slate-300">
                <div className="font-semibold text-slate-100">ผลการตรวจจับ</div>
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
                        <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
                          <span
                            aria-hidden="true"
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: ATTIRE_BOX_COLORS.target,
                            }}
                          />
                          {targetLabel}
                        </p>
                        <p className="text-xl font-semibold text-accent">
                          {targetCount}{" "}
                          <span className="text-xs font-normal">คน</span>
                        </p>
                      </div>
                      <div className="rounded-md border border-line bg-black/10 p-3">
                        <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
                          <span
                            aria-hidden="true"
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: ATTIRE_BOX_COLORS.other,
                            }}
                          />
                          {otherAttireLabel}
                        </p>
                        <p className="text-xl font-semibold text-slate-200">
                          {otherCount}{" "}
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
                      const isPerson = det.classId === PERSON_CLASS_ID();
                      const attireLabel = getAttireLabel(
                        desc?.attire,
                        attireMode,
                      );

                      return (
                        <li
                          key={det.trackId}
                          className="rounded-md border border-line px-3 py-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{
                                backgroundColor: getDetectionBoxColor(
                                  det,
                                  personDescriptions,
                                ),
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
                                disabled={desc?.loading || !!desc?.attire || (mode === "camera" && (personFrameQueuesRef.current.get(det.trackId)?.frames.length ?? 0) < PERSON_QUEUE_FRAME_COUNT)}
                                className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-slate-300 transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-50"
                              >
                                {desc?.loading
                                  ? "กำลังวิเคราะห์..."
                                  : desc?.attire
                                    ? "วิเคราะห์แล้ว"
                                    : mode === "camera" && (personFrameQueuesRef.current.get(det.trackId)?.frames.length ?? 0) < PERSON_QUEUE_FRAME_COUNT
                                      ? "กำลังเก็บภาพ"
                                      : desc?.error ? "ลองอีกครั้ง" : "วิเคราะห์"}
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
                                      กำลังวิเคราะห์การแต่งกายด้วย {aiProvider === "ollama" ? "Ollama" : "Gemini"}...
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
              </>
              )}
            </div>
          </div>
        </section>
      </main>
      )}
    </div>
  );
}
