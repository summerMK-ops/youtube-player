const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const cacheDir = path.join(rootDir, ".cache");
const transcriptCacheDir = path.join(cacheDir, "transcripts");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let transformersModulePromise = null;
let youtubeiModulePromise = null;
let innertubePromise = null;
const asrPipelineCache = new Map();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function extractVideoId(input) {
  if (!input) {
    return "";
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const parsed = new URL(input);
    if (parsed.searchParams.get("v")) {
      return parsed.searchParams.get("v").slice(0, 11);
    }
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "").slice(0, 11);
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const embedIndex = parts.findIndex((part) => part === "embed" || part === "shorts" || part === "live");
    if (embedIndex >= 0 && parts[embedIndex + 1]) {
      return parts[embedIndex + 1].slice(0, 11);
    }
  } catch (_error) {
    return "";
  }

  return "";
}

function decodeHtmlEntities(text) {
  return String(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"");
}

function textFromRuns(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }

  if (Array.isArray(value.runs)) {
    return decodeHtmlEntities(value.runs.map((run) => run.text || "").join(""));
  }

  if (value.simpleText) {
    return decodeHtmlEntities(value.simpleText);
  }

  return "";
}

function normalizeCueText(text) {
  return decodeHtmlEntities(text)
    .replace(/\s+/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

function parseCaptionEvents(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const cues = [];

  for (const event of events) {
    const start = Number(event?.tStartMs) / 1000;
    const duration = Number(event?.dDurationMs) / 1000;
    const segments = Array.isArray(event?.segs) ? event.segs : [];
    const text = normalizeCueText(segments.map((segment) => segment.utf8 || "").join(""));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || !text) {
      continue;
    }

    cues.push({
      start,
      end: start + duration,
      text
    });
  }

  return cues;
}

function mergeTracks(originalCues, translatedCues) {
  return originalCues.map((cue, index) => {
    const translated = translatedCues[index];
    const translation = translated && Math.abs(translated.start - cue.start) < 1.5 ? translated.text : "";
    return {
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation
    };
  });
}

async function translateTextWithGoogle(text, targetLanguage, sourceLanguage = "") {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sourceLanguage || "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Transcript App"
    }
  });

  if (!response.ok) {
      throw new Error(`Google翻訳の取得に失敗しました: ${response.status}`);
  }

  const payload = await response.json();
  const translated = Array.isArray(payload?.[0])
    ? payload[0].map((part) => part?.[0] || "").join("")
    : "";
  return normalizeCueText(translated);
}

async function translateTextWithDeepL(text, targetLanguage, sourceLanguage = "") {
  const apiKey = process.env.DEEPL_API_KEY || "";
  if (!apiKey) {
    throw new Error("DeepL API key is not configured");
  }

  const params = new URLSearchParams();
  params.set("text", text);
  params.set("target_lang", String(targetLanguage).split("-")[0].toUpperCase());
  if (sourceLanguage) {
    params.set("source_lang", String(sourceLanguage).split("-")[0].toUpperCase());
  }

  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`DeepL translation failed: ${response.status}`);
  }

  const payload = await response.json();
  return normalizeCueText(payload?.translations?.[0]?.text || "");
}

async function translateCues(cues, targetLanguage, sourceLanguage = "", provider = "google") {
  if (!targetLanguage || targetLanguage === sourceLanguage) {
    return cues;
  }

  const translatedCues = [];
  for (const cue of cues) {
    try {
      const translation = provider === "deepl"
        ? await translateTextWithDeepL(cue.text, targetLanguage, sourceLanguage)
        : await translateTextWithGoogle(cue.text, targetLanguage, sourceLanguage);
      translatedCues.push({
        ...cue,
        translation
      });
    } catch (_error) {
      translatedCues.push({
        ...cue,
        translation: cue.translation || ""
      });
    }
  }

  return translatedCues;
}

function trackLabelFrom(track) {
  const language = track.name?.simpleText || track.name?.text || track.languageCode || track.language_code || "unknown";
  const kind = track.kind === "asr" ? "auto-generated" : "standard";
  return `${language} / ${kind}`;
}

function extractJsonObjectAfterMarker(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const startIndex = html.indexOf("{", markerIndex);
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let endIndex = -1;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index + 1;
        break;
      }
    }
  }

  if (endIndex < 0) {
    return null;
  }

  return JSON.parse(html.slice(startIndex, endIndex));
}

function extractAnyJsonObject(html, markers) {
  for (const marker of markers) {
    const parsed = extractJsonObjectAfterMarker(html, marker);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex Transcript App"
    }
  });

  if (!response.ok) {
    throw new Error("YouTubeページを取得できませんでした。");
  }

  return response.text();
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) {
    return "";
  }
  return thumbnails[thumbnails.length - 1].url || thumbnails[0].url || "";
}

function mapVideoRenderer(renderer) {
  const videoId = renderer.videoId;
  if (!videoId) {
    return null;
  }

  return {
    videoId,
    title: textFromRuns(renderer.title),
    channelName: textFromRuns(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText),
    viewCountText: textFromRuns(renderer.viewCountText || renderer.shortViewCountText),
    publishedTimeText: textFromRuns(renderer.publishedTimeText),
    lengthText: textFromRuns(renderer.lengthText),
    thumbnail: pickThumbnail(renderer.thumbnail?.thumbnails),
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function walkForKey(node, key, results = []) {
  if (!node || typeof node !== "object") {
    return results;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkForKey(item, key, results);
    }
    return results;
  }

  if (Object.prototype.hasOwnProperty.call(node, key)) {
    results.push(node[key]);
  }

  for (const value of Object.values(node)) {
    walkForKey(value, key, results);
  }

  return results;
}

function uniqueVideos(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.videoId || seen.has(item.videoId)) {
      return false;
    }
    seen.add(item.videoId);
    return true;
  });
}

async function searchVideos(query) {
  const html = await fetchPage(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
  const data = extractAnyJsonObject(html, ["var ytInitialData = ", "window['ytInitialData'] = "]);
  if (!data) {
    throw new Error("検索結果を解析できませんでした。");
  }

  const renderers = walkForKey(data, "videoRenderer");
  return uniqueVideos(renderers.map(mapVideoRenderer).filter(Boolean)).slice(0, 20);
}

async function fetchRecommendations(videoId) {
  const html = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const data = extractAnyJsonObject(html, ["var ytInitialData = ", "window['ytInitialData'] = "]);
  const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");

  const compactRenderers = data ? walkForKey(data, "compactVideoRenderer") : [];
  const gridRenderers = data ? walkForKey(data, "videoRenderer") : [];
  const directItems = uniqueVideos([...compactRenderers, ...gridRenderers].map(mapVideoRenderer).filter(Boolean))
    .filter((item) => item.videoId !== videoId)
    .slice(0, 16);

  if (directItems.length) {
    return directItems;
  }

  const title = playerResponse?.videoDetails?.title || "";
  const author = playerResponse?.videoDetails?.author || "";
  const fallbackQuery = [title, author].filter(Boolean).join(" ").trim();
  if (!fallbackQuery) {
    return [];
  }

  const fallbackItems = await searchVideos(fallbackQuery);
  return fallbackItems.filter((item) => item.videoId !== videoId).slice(0, 16);
}

async function fetchCaptionTracksFromYoutubei(videoId, client) {
  const innertube = await getInnertube();
  const info = await innertube.getBasicInfo(videoId, { client });
  const tracks = Array.isArray(info.captions?.caption_tracks) ? info.captions.caption_tracks : [];

  return {
    defaultTrackIndex: 0,
    tracks: tracks.map((track) => ({
      baseUrl: track.base_url,
      languageCode: track.language_code,
      kind: track.kind || "",
      isTranslatable: Boolean(track.is_translatable),
      label: trackLabelFrom(track)
    }))
  };
}

async function fetchCaptionTracks(videoId) {
  for (const client of ["IOS", "WEB"]) {
    try {
      const trackData = await fetchCaptionTracksFromYoutubei(videoId, client);
      if (trackData.tracks.length) {
        return trackData;
      }
    } catch (_error) {
      // Fall through to the next client or HTML parsing.
    }
  }

  const html = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const playerResponse = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse = ");
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    throw new Error("利用可能な字幕トラックが見つかりませんでした。");
  }

  const defaultTrackIndex = playerResponse?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex ?? 0;
  return {
    defaultTrackIndex,
    tracks: tracks.map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: track.kind || "",
      isTranslatable: Boolean(track.isTranslatable),
      label: trackLabelFrom(track)
    }))
  };
}

function buildTrackUrl(baseUrl, options = {}) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("fmt", "json3");
  if (options.targetLanguage) {
    parsed.searchParams.set("tlang", options.targetLanguage);
  }
  return parsed.toString();
}

async function fetchTrackCues(track, targetLanguage, provider = "google") {
  const originalResponse = await fetch(buildTrackUrl(track.baseUrl), {
    headers: { "User-Agent": "Mozilla/5.0 Codex Transcript App" }
  });

  if (!originalResponse.ok) {
    throw new Error("字幕本体を取得できませんでした。");
  }

  const originalText = await originalResponse.text();
  if (!originalText.trim()) {
    throw new Error("empty-caption-body");
  }

  const originalCues = parseCaptionEvents(JSON.parse(originalText));
  if (!originalCues.length) {
    throw new Error("字幕イベントを解析できませんでした。");
  }

  const mergedCues = mergeTracks(originalCues, []);
  return translateCues(mergedCues, targetLanguage, track.languageCode, provider);
}

function chooseDefaultTrackIndex(tracks, fallbackIndex = 0) {
  const englishIndex = tracks.findIndex((track) => track.languageCode === "en" && track.kind !== "asr");
  if (englishIndex >= 0) {
    return englishIndex;
  }

  const manualIndex = tracks.findIndex((track) => track.kind !== "asr");
  if (manualIndex >= 0) {
    return manualIndex;
  }

  return fallbackIndex;
}

async function ensureCacheDirs() {
  await fsp.mkdir(transcriptCacheDir, { recursive: true });
}

function cachePathFor(videoId, language) {
  return path.join(transcriptCacheDir, `${videoId}.${language}.json`);
}

async function readCachedTranscript(videoId, language) {
  try {
    const raw = await fsp.readFile(cachePathFor(videoId, language), "utf8");
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

async function writeCachedTranscript(videoId, language, payload) {
  await ensureCacheDirs();
  await fsp.writeFile(cachePathFor(videoId, language), JSON.stringify(payload), "utf8");
}

async function loadTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@xenova/transformers").then((mod) => {
      mod.env.cacheDir = path.join(cacheDir, "transformers");
      mod.env.allowLocalModels = true;
      return mod;
    });
  }
  return transformersModulePromise;
}

async function loadYoutubeiModule() {
  if (!youtubeiModulePromise) {
    youtubeiModulePromise = import("youtubei.js");
  }
  return youtubeiModulePromise;
}

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const youtubeiModule = await loadYoutubeiModule();
      const Innertube = youtubeiModule.default || youtubeiModule.Innertube;
      return Innertube.create();
    })();
  }
  return innertubePromise;
}

async function getAsrPipeline(language) {
  const modelId = language === "en" ? "Xenova/whisper-tiny.en" : "Xenova/whisper-tiny";
  if (!asrPipelineCache.has(modelId)) {
    asrPipelineCache.set(modelId, (async () => {
      const { pipeline } = await loadTransformersModule();
      return pipeline("automatic-speech-recognition", modelId, { quantized: true });
    })());
  }
  return asrPipelineCache.get(modelId);
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function downloadAudioAsFloat32(videoId) {
  return new Promise((resolve, reject) => {
    (async () => {
      const innertube = await getInnertube();
      const audioStream = await innertube.download(videoId, {
        client: "ANDROID",
        type: "audio",
        quality: "best",
        format: "mp4",
        codec: "mp4a"
      });

      const reader = audioStream.getReader();
      const ffmpeg = spawn(ffmpegPath, [
        "-i", "pipe:0",
        "-ac", "1",
        "-ar", "16000",
        "-f", "f32le",
        "pipe:1"
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutChunks = [];
      const stderrChunks = [];

      ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg failed: ${Buffer.concat(stderrChunks).toString("utf8")}`));
          return;
        }

        const buffer = Buffer.concat(stdoutChunks);
        const sampleCount = Math.floor(buffer.byteLength / 4);
        const audio = new Float32Array(sampleCount);
        for (let index = 0; index < sampleCount; index += 1) {
          audio[index] = buffer.readFloatLE(index * 4);
        }
        resolve(audio);
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        ffmpeg.stdin.write(Buffer.from(value));
      }

      ffmpeg.stdin.end();
    })().catch(reject);
  });
}

function normalizeAsrChunks(output) {
  const chunks = Array.isArray(output?.chunks) && output.chunks.length
    ? output.chunks
    : [{ timestamp: [0, 0], text: output?.text || "" }];

  let lastEnd = 0;
  return chunks
    .map((chunk) => {
      const start = Number(chunk?.timestamp?.[0] ?? lastEnd);
      const end = Number(chunk?.timestamp?.[1] ?? start + 3);
      lastEnd = Number.isFinite(end) ? end : start + 3;
      const text = normalizeCueText(chunk?.text || "");
      if (!text || !Number.isFinite(start)) {
        return null;
      }

      return {
        start,
        end: Number.isFinite(end) && end > start ? end : start + 3,
        text,
        translation: ""
      };
    })
    .filter(Boolean);
}

async function transcribeWithAsr(videoId, language, provider = "google") {
  const targetLanguage = language || "ja";
  const cached = await readCachedTranscript(videoId, targetLanguage);
  if (cached) {
    return cached;
  }

  const audio = await downloadAudioAsFloat32(videoId);
  const transcriber = await getAsrPipeline(language === "en" ? "en" : "multi");
  const result = await transcriber(audio, {
    chunk_length_s: 25,
    stride_length_s: 4,
    return_timestamps: true,
    ...(language === "en" ? { language: "english" } : {})
  });

  const subtitles = await translateCues(
    normalizeAsrChunks(result),
    targetLanguage,
    language === "en" ? "en" : "",
    provider
  );
  const payload = {
    source: "asr",
    trackLabel: "ASR fallback",
    availableTracks: [],
    subtitles
  };

  await writeCachedTranscript(videoId, targetLanguage, payload);
  return payload;
}

async function getTranscriptWithFallback(videoId, trackIndex, language, provider = "google") {
  try {
    const trackData = await fetchCaptionTracks(videoId);
    const tracks = trackData.tracks;
    const fallbackIndex = chooseDefaultTrackIndex(tracks, trackData.defaultTrackIndex);
    const normalizedTrackIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? trackIndex : fallbackIndex;
    const selectedTrack = tracks[normalizedTrackIndex] || tracks[fallbackIndex] || tracks[0];
    const selectedTrackIndex = tracks.findIndex((track) => track.baseUrl === selectedTrack.baseUrl);
    const subtitles = await fetchTrackCues(selectedTrack, language, provider);

    return {
      source: "youtube",
      videoId,
      selectedTrackIndex,
      trackLabel: selectedTrack.label,
      availableTracks: tracks.map((track) => ({
        label: track.label,
        languageCode: track.languageCode,
        kind: track.kind
      })),
      subtitles
    };
  } catch (error) {
    const message = String(error?.message || error);
    const shouldTryAsr = message === "empty-caption-body"
      || message.includes("字幕本体")
      || message.includes("empty-caption-body")
      || message.includes("利用可能な字幕トラック")
      || message.includes("字幕イベント");

    if (!shouldTryAsr) {
      throw error;
    }

    const asrPayload = await transcribeWithAsr(videoId, language, provider);
    return {
      source: "asr",
      videoId,
      selectedTrackIndex: 0,
      trackLabel: asrPayload.trackLabel,
      availableTracks: [],
      subtitles: asrPayload.subtitles
    };
  }
}

async function getYoutubeTranscriptOnly(videoId, trackIndex, language, provider = "google") {
  const trackData = await fetchCaptionTracks(videoId);
  const tracks = trackData.tracks;
  const fallbackIndex = chooseDefaultTrackIndex(tracks, trackData.defaultTrackIndex);
  const normalizedTrackIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? trackIndex : fallbackIndex;
  const selectedTrack = tracks[normalizedTrackIndex] || tracks[fallbackIndex] || tracks[0];
  const selectedTrackIndex = tracks.findIndex((track) => track.baseUrl === selectedTrack.baseUrl);
  const subtitles = await fetchTrackCues(selectedTrack, language, provider);

  return {
    source: "youtube",
    videoId,
    selectedTrackIndex,
    trackLabel: selectedTrack.label,
    availableTracks: tracks.map((track) => ({
      label: track.label,
      languageCode: track.languageCode,
      kind: track.kind
    })),
    subtitles
  };
}

async function getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider = "google") {
  try {
    return await getYoutubeTranscriptOnly(videoId, trackIndex, language, provider);
  } catch (error) {
    const captionErrorMessage = String(error?.message || error);

    try {
      const asrPayload = await transcribeWithAsr(videoId, language, provider);
      return {
        source: "asr",
        videoId,
        selectedTrackIndex: 0,
        trackLabel: asrPayload.trackLabel,
        availableTracks: [],
        subtitles: asrPayload.subtitles
      };
    } catch (asrError) {
      const asrErrorMessage = String(asrError?.message || asrError);
      throw new Error(
        `字幕取得とASRフォールバックの両方に失敗しました。caption=${captionErrorMessage} / asr=${asrErrorMessage}`
      );
    }
  }
}

async function handleSearchApi(requestUrl, response) {
  const query = requestUrl.searchParams.get("q")?.trim();
  if (!query) {
    sendJson(response, 400, { error: "検索ワードを指定してください。" });
    return;
  }

  try {
    const items = await searchVideos(query);
    sendJson(response, 200, { query, items });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "検索に失敗しました。" });
  }
}

async function handleRecommendationsApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  if (!videoId) {
    sendJson(response, 400, { error: "有効な videoId を指定してください。" });
    return;
  }

  try {
    const items = await fetchRecommendations(videoId);
    sendJson(response, 200, { videoId, items });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "おすすめ動画の取得に失敗しました。" });
  }
}

async function handleTranscriptApi(requestUrl, response) {
  const videoId = extractVideoId(requestUrl.searchParams.get("videoId"));
  const trackIndex = Number(requestUrl.searchParams.get("trackIndex") || "0");
  const language = requestUrl.searchParams.get("lang") || "ja";
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!videoId) {
    sendJson(response, 400, { error: "有効な videoId を指定してください。" });
    return;
  }

  try {
    const payload = await getTranscriptWithAggressiveFallback(videoId, trackIndex, language, provider);
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "字幕の取得に失敗しました。"
    });
  }
}

async function handleDictionaryApi(requestUrl, response) {
  const word = String(requestUrl.searchParams.get("word") || "").trim();
  const provider = requestUrl.searchParams.get("provider") || "google";

  if (!word) {
    sendJson(response, 400, { error: "word を指定してください。" });
    return;
  }

  try {
    const dictionaryResponse = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Codex Transcript App"
      }
    });

    if (!dictionaryResponse.ok) {
      throw new Error("辞書情報を取得できませんでした。");
    }

    const payload = await dictionaryResponse.json();
    const entry = Array.isArray(payload) ? payload[0] : null;
    if (!entry) {
      throw new Error("辞書情報を取得できませんでした。");
    }

    const phonetic = entry.phonetic || entry.phonetics?.find((item) => item.text)?.text || "";
    const audioUrl = entry.phonetics?.find((item) => item.audio)?.audio || "";
    const meanings = Array.isArray(entry.meanings) ? entry.meanings.slice(0, 3) : [];
    const translate = provider === "deepl" ? translateTextWithDeepL : translateTextWithGoogle;
    const wordTranslation = await translate(entry.word || word, "ja", "en").catch(() => "");

    const translatedMeanings = [];
    for (const meaning of meanings) {
      const definitions = Array.isArray(meaning.definitions) ? meaning.definitions.slice(0, 2) : [];
      const translatedDefinitions = [];

      for (const definition of definitions) {
        const english = normalizeCueText(definition.definition || "");
        const japanese = english
          ? await translate(english, "ja", "en").catch(() => "")
          : "";
        translatedDefinitions.push({
          en: english,
          ja: japanese
        });
      }

      translatedMeanings.push({
        partOfSpeech: meaning.partOfSpeech || "",
        definitions: translatedDefinitions
      });
    }

    sendJson(response, 200, {
      word: entry.word || word,
      phonetic,
      audioUrl,
      wordTranslation,
      meaning: translatedMeanings[0]?.definitions?.[0]?.ja || "",
      meanings: translatedMeanings
    });
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "辞書情報の取得に失敗しました。"
    });
  }
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const targetPath = path.normalize(path.join(rootDir, pathname));
  if (!targetPath.startsWith(rootDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const cacheControl = pathname === "/sw.js"
      ? "no-store"
      : ext === ".png" || ext === ".svg" || ext === ".ico"
        ? "public, max-age=86400"
        : "no-store";
    response.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": cacheControl
    });
    fs.createReadStream(targetPath).pipe(response);
  } catch (_error) {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/api/search") {
    await handleSearchApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/recommendations") {
    await handleRecommendationsApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/transcript") {
    await handleTranscriptApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname === "/api/dictionary") {
    await handleDictionaryApi(requestUrl, response);
    return;
  }

  await serveStatic(requestUrl, response);
});

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

server.listen(port, host, () => {
  const lanAddress = getLanAddress();
  console.log(`Server running at http://localhost:${port}`);
  if (host === "0.0.0.0" && lanAddress) {
    console.log(`Open on iPhone Safari: http://${lanAddress}:${port}`);
  }
});
