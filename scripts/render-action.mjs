import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [jobPath, outputPath, workerUrl, jobId, token] = process.argv.slice(2);
if (!jobPath || !outputPath || !workerUrl || !jobId || !token) throw new Error("Missing arguments");
const job = JSON.parse(await readFile(jobPath, "utf8"));
const allowed = {
  darkness: ["none", "light", "standard", "strong"], vignette: ["none", "light", "standard", "strong"],
  orderMode: ["original", "shuffle_once", "random_no_repeat"], format: ["vertical", "portrait", "square", "horizontal"],
  effect: ["none", "zoom", "flash", "glitch"],
  transition: ["cut", "smooth", "motion_blur", "flash"],
  motion: ["none", "zoom_in", "pan_left", "pan_right"],
};
job.transition ||= "cut";
job.motion ||= "none";
const formats = { vertical: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], horizontal: [1920, 1080] };
const brightness = { none: 0, light: -0.08, standard: -0.16, strong: -0.25 };
const vignettes = { none: null, light: "vignette=PI/7", standard: "vignette=PI/5", strong: "vignette=PI/3" };
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}
function shuffle(values) { const out = [...values]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
function sequence(count, needed, mode) {
  const base = Array.from({ length: count }, (_, i) => i);
  if (mode === "original") return Array.from({ length: needed }, (_, i) => i % count);
  if (mode === "shuffle_once") { const order = shuffle(base); return Array.from({ length: needed }, (_, i) => order[i % count]); }
  const out = []; while (out.length < needed) { const choices = base.filter((i) => i !== out.at(-1)); out.push(choices[Math.floor(Math.random() * choices.length)]); } return out;
}
for (const [key, values] of Object.entries(allowed)) if (!values.includes(job[key])) throw new Error(`Invalid ${key}`);
if (job.imageCount < 4 || job.imageCount > 10 || job.duration < 1 || job.duration > 60 || job.interval < 0.05 || job.interval > 2) throw new Error("Invalid job limits");
const dir = await mkdtemp(join(tmpdir(), "creo-action-"));
try {
  const paths = await Promise.all(Array.from({ length: job.imageCount }, async (_, i) => {
    const response = await fetch(`${workerUrl}/github/render/${jobId}/image/${i}`, { headers: { "X-Render-Token": token } });
    if (!response.ok) throw new Error(`Image ${i}: HTTP ${response.status}`);
    const path = join(dir, `image-${i}.jpg`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    return path;
  }));
  await fetch(`${workerUrl}/github/render/${jobId}/stage`, {
    method: "POST",
    headers: { "X-Render-Token": token, "Content-Type": "text/plain" },
    body: "rendering",
  }).catch(() => {});
  const framesNeeded = Math.max(1, Math.ceil(job.duration / job.interval));
  const seq = sequence(paths.length, framesNeeded, job.orderMode);
  const [width, height] = formats[job.format];
  const effect = job.effect === "zoom" ? `scale=w='trunc(iw*(1+0.06*mod(t\\,1))/2)*2':h='trunc(ih*(1+0.06*mod(t\\,1))/2)*2':eval=frame,crop=${width}:${height}`
    : job.effect === "flash" ? `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=fill:enable='lt(mod(t\\,${job.interval})\\,0.04)'`
    : job.effect === "glitch" ? "rgbashift=rh=4:bh=-4,noise=alls=7:allf=t+u" : null;

  // 1) Decode + scale every photo ONCE (in parallel) instead of 30 times per second.
  const used = [...new Set(seq)];
  const prepared = new Map();
  await Promise.all(used.map(async (index) => {
    const out = join(dir, `prepared-${index}.jpg`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", paths[index], "-frames:v", "1",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1`, "-q:v", "2", out]);
    prepared.set(index, out);
  }));

  // 2) Build a frame-accurate slideshow timeline (30 fps) for the concat demuxer.
  const FPS = 30;
  const totalFrames = Math.max(1, Math.round(job.duration * FPS));
  const entries = [];
  for (let frame = 0; frame < totalFrames; frame++) {
    const slot = Math.min(seq.length - 1, Math.floor((frame / FPS + 1e-9) / job.interval));
    const image = seq[slot];
    const last = entries.at(-1);
    if (last && last.image === image) last.frames++; else entries.push({ image, frames: 1 });
  }
  const concatLines = ["ffconcat version 1.0"];
  for (const entry of entries) concatLines.push(`file '${prepared.get(entry.image)}'`, `duration ${(entry.frames / FPS).toFixed(6)}`);
  concatLines.push(`file '${prepared.get(entries.at(-1).image)}'`);
  const listPath = join(dir, "timeline.ffconcat");
  await writeFile(listPath, concatLines.join("\n") + "\n");

  const motion = job.motion === "zoom_in" ? `scale=w='trunc(iw*(1+0.06*mod(t\,${job.interval})/${job.interval})/2)*2':h='trunc(ih*(1+0.06*mod(t\,${job.interval})/${job.interval})/2)*2':eval=frame,crop=${width}:${height}`
    : job.motion === "pan_left" ? `scale=${Math.ceil(width * 1.08 / 2) * 2}:${Math.ceil(height * 1.08 / 2) * 2},crop=${width}:${height}:x='(iw-ow)*mod(t\,${job.interval})/${job.interval}':y='(ih-oh)/2'`
    : job.motion === "pan_right" ? `scale=${Math.ceil(width * 1.08 / 2) * 2}:${Math.ceil(height * 1.08 / 2) * 2},crop=${width}:${height}:x='(iw-ow)*(1-mod(t\,${job.interval})/${job.interval})':y='(ih-oh)/2'` : null;
  const transition = job.transition === "smooth" ? "tmix=frames=3:weights='1 2 1'"
    : job.transition === "motion_blur" ? "tmix=frames=5:weights='1 1 2 1 1'"
    : job.transition === "flash" ? `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.45:t=fill:enable='lt(mod(t\,${job.interval})\,0.05)'` : null;
  const filters = [`fps=${FPS}`, "setsar=1", motion, transition, `eq=brightness=${brightness[job.darkness]}:contrast=1.04:saturation=0.95`, vignettes[job.vignette], effect, "format=yuv420p"].filter(Boolean).join(",");
  const stillOnly = !motion && !transition && !effect;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", filters, "-r", String(FPS), "-t", String(job.duration), "-an",
    "-c:v", "libx264", "-preset", "veryfast", ...(stillOnly ? ["-tune", "stillimage"] : []), "-crf", "28", "-maxrate", "3M", "-bufsize", "6M",
    "-g", String(FPS * 2), "-threads", "0", "-movflags", "+faststart", outputPath]);
  const output = await stat(outputPath);
  if (output.size < 10 * 1024) throw new Error(`Rendered video is unexpectedly small: ${output.size} bytes`);
  const duration = Number(await capture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath]));
  if (!Number.isFinite(duration) || duration < job.duration - 0.25) throw new Error(`Rendered duration is invalid: ${duration}s instead of ${job.duration}s`);
} finally { await rm(dir, { recursive: true, force: true }); }
