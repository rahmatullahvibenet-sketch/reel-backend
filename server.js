// Light reel backend for free hosting: script (Gemini), voice (Edge TTS), footage (Pixabay/Pexels).
// Video rendering happens in the user's browser, so no FFmpeg or heavy CPU is needed here.
import express from "express";
import cors from "cors";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EdgeTTS } from "node-edge-tts";

const { PORT = 10000, GEMINI_API_KEY, GEMINI_MODEL = "gemini-2.5-flash", PEXELS_API_KEY, PIXABAY_API_KEY, ALLOWED_ORIGIN = "*" } = process.env;
const VOICES = { female: "ps-AF-LatifaNeural", male: "ps-AF-GulNawazNeural" };

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "10kb" }));

// Per-IP hourly limits protect the free API quotas
const hits = new Map();
const limit = (name, max) => (req, res, next) => {
  const k = name + req.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 36e5);
  if (a.length >= max) return res.status(429).json({ error: "limit" });
  a.push(now); hits.set(k, a); next();
};

app.get("/", (_, res) => res.send("reel-light-backend ok"));

// 1. Script
app.post("/api/script", limit("s", 8), async (req, res) => {
  const topic = String(req.body?.topic || "").trim().slice(0, 300);
  if (!topic) return res.status(400).json({ error: "topic required" });
  const prompt = `Write a viral vertical short-video script about: "${topic}".
Write the spoken text in the same language as the topic (Pashto if the topic is Pashto).
Rules: scene 1 is a curiosity hook (max 8 words); 4 to 5 punchy middle scenes (max 14 words each); last scene is a short call to action.
For every scene add "query": 2-3 English words describing relevant stock footage.
Return ONLY JSON: {"scenes":[{"text":"...","query":"..."}]}`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const d = await r.json();
    const scenes = JSON.parse(d.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim()).scenes;
    if (!Array.isArray(scenes) || scenes.length < 3) throw new Error("bad script");
    res.json({ scenes: scenes.slice(0, 8) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 2. Voice (returns MP3 bytes)
app.post("/api/voice", limit("v", 60), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 400);
  if (!text) return res.status(400).json({ error: "text required" });
  const voice = VOICES[req.body?.voice] || VOICES.female;
  const f = path.join(os.tmpdir(), crypto.randomBytes(8).toString("hex") + ".mp3");
  try {
    await new EdgeTTS({ voice, lang: "ps-AF", outputFormat: "audio-24khz-96kbitrate-mono-mp3", rate: "+5%", timeout: 30000 }).ttsPromise(text, f);
    res.type("audio/mpeg").send(await fs.readFile(f));
  } catch (e) { res.status(502).json({ error: "tts failed" }); }
  finally { fs.rm(f, { force: true }).catch(() => {}); }
});

// 3. Footage: returns a direct link plus a proxy link (used if the browser is blocked by CORS)
async function pickPixabay(query) {
  const r = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query.slice(0, 90))}&per_page=10&safesearch=true`);
  if (!r.ok) throw new Error(`pixabay ${r.status}`);
  const hits = (await r.json()).hits || [];
  if (!hits.length) throw new Error("no footage");
  const h = hits[Math.floor(Math.random() * Math.min(5, hits.length))];
  const v = [h.videos.medium, h.videos.small, h.videos.tiny, h.videos.large].find(x => x && x.url);
  if (!v) throw new Error("no file");
  return v.url;
}
async function pick(query) {
  if (PIXABAY_API_KEY) return pickPixabay(query);
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=8`,
    { headers: { Authorization: PEXELS_API_KEY } });
  if (!r.ok) throw new Error(`pexels ${r.status}`);
  const vids = (await r.json()).videos || [];
  if (!vids.length) throw new Error("no footage");
  const v = vids[Math.floor(Math.random() * Math.min(5, vids.length))];
  const files = v.video_files.filter(f => f.width && f.file_type === "video/mp4").sort((a, b) => Math.abs(a.width - 720) - Math.abs(b.width - 720));
  if (!files[0]) throw new Error("no file");
  return files[0].link;
}
app.get("/api/clip", limit("c", 60), async (req, res) => {
  try {
    const link = await pick(String(req.query.q || "nature").slice(0, 60));
    res.json({ direct: link, proxy: `/api/proxy?u=${encodeURIComponent(link)}` });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/proxy", limit("p", 120), async (req, res) => {
  const u = String(req.query.u || ""); let host;
  try { host = new URL(u).hostname; } catch { return res.sendStatus(400); }
  if (!/(^|\.)(pexels|pixabay|vimeo)\.com$/.test(host)) return res.sendStatus(403); // only proxy known stock-footage hosts
  try {
    const r = await fetch(u); if (!r.ok) return res.sendStatus(502);
    res.set("content-type", "video/mp4"); Readable.fromWeb(r.body).pipe(res);
  } catch { res.sendStatus(502); }
});

app.listen(PORT, () => console.log(`reel-light-backend on :${PORT}`));
