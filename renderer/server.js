import express from "express";
import multer from "multer";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 10, fileSize: 15 * 1024 * 1024, fieldSize: 1024 } });
const allowed = {
  darkness: ["none", "light", "standard", "strong"],
  vignette: ["none", "light", "standard", "strong"],
  order: ["original", "shuffle_once", "random_no_repeat"],
  format: ["vertical", "portrait", "square", "horizontal"],
  effect: ["none", "zoom", "flash", "glitch"],
};
const formats = {
  vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], horizontal: [1920, 1080],
};
const brightness = { none: 0, light: -0.08, standard: -0.16, strong: -0.25 };
const vignetteFilters = { none: null, light: "vignette=PI/7", standard: "vignette=PI/5", strong: "vignette=PI/3" };

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}
function shuffle(values) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [output[i], output[j]] = [output[j], output[i]]; }
  return output;
}
function makeSequence(count, framesNeeded, mode) {
  const base = Array.from({ length: count }, (_, i) => i);
  if (mode === "original") return Array.from({ length: framesNeeded }, (_, i) => i % count);
  if (mode === "shuffle_once") { const order = shuffle(base); return Array.from({ length: framesNeeded }, (_, i) => order[i % count]); }
  const result = [];
  while (result.length < framesNeeded) {
    const choices = base.filter((i) => i !== result[result.length - 1]);
    result.push(choices[Math.floor(Math.random() * choices.length)]);
  }
  return result;
}
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/render", upload.array("images", 10), async (req, res) => {
  const files = req.files || []; const duration = Number(req.body.duration); const interval = Number(req.body.interval);
  const darkness = req.body.darkness || "standard"; const vignette = req.body.vignette || "standard";
  const orderMode = req.body.orderMode || "original"; const format = req.body.format || "vertical";
  const effect = req.body.effect || "none";
  if (files.length < 4 || files.length > 10) return res.status(400).json({ error: "Upload 4-10 images" });
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) return res.status(400).json({ error: "Duration must be 1-60" });
  if (!Number.isFinite(interval) || interval < 0.05 || interval > 2) return res.status(400).json({ error: "Interval must be 0.05-2" });
  if (!allowed.darkness.includes(darkness) || !allowed.vignette.includes(vignette) || !allowed.order.includes(orderMode) || !allowed.format.includes(format) || !allowed.effect.includes(effect)) return res.status(400).json({ error: "Invalid option" });
  const dir = await mkdtemp(join(tmpdir(), "creo-"));
  try {
    const paths = [];
    for (let i = 0; i < files.length; i++) { const path = join(dir, `image-${i}`); await writeFile(path, files[i].buffer); paths.push(path); }
    const framesNeeded = Math.ceil(duration / interval) + 1; const sequence = makeSequence(paths.length, framesNeeded, orderMode); const concat = [];
    for (const index of sequence) { concat.push(`file '${paths[index]}'`); concat.push(`duration ${interval}`); }
    concat.push(`file '${paths[sequence[sequence.length - 1]]}'`);
    const listPath = join(dir, "frames.ffconcat"); const outputPath = join(dir, "output.mp4");
    await writeFile(listPath, `ffconcat version 1.0\n${concat.join("\n")}\n`);
    const [width, height] = formats[format];
    const effectFilter = effect === "zoom"
      ? `scale=w='trunc(iw*(1+0.06*mod(t\\,1))/2)*2':h='trunc(ih*(1+0.06*mod(t\\,1))/2)*2':eval=frame,crop=${width}:${height}`
      : effect === "flash"
        ? `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=fill:enable='lt(mod(t\\,${interval})\\,0.04)'`
        : effect === "glitch"
          ? "rgbashift=rh=4:bh=-4,noise=alls=7:allf=t+u"
          : null;
    const filter = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`,
      `eq=brightness=${brightness[darkness]}:contrast=1.04:saturation=0.95`,
      vignetteFilters[vignette], effectFilter, "fps=30", "format=yuv420p",
    ].filter(Boolean).join(",");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-t", String(duration), "-vf", filter, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-movflags", "+faststart", outputPath]);
    const output = await readFile(outputPath); res.setHeader("content-type", "video/mp4"); res.setHeader("content-length", String(output.length)); res.send(output);
  } catch (error) { console.error(error); res.status(500).json({ error: error instanceof Error ? error.message : "Render failed" }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
app.listen(8080, "0.0.0.0", () => console.log("Renderer listening on :8080"));
