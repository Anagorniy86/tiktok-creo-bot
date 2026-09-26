import { mkdtemp, writeFile, readFile, rm, link, copyFile, stat } from "node:fs/promises";
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
};
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
  const paths = [];
  for (let i = 0; i < job.imageCount; i++) {
    const response = await fetch(`${workerUrl}/github/render/${jobId}/image/${i}`, { headers: { "X-Render-Token": token } });
    if (!response.ok) throw new Error(`Image ${i}: HTTP ${response.status}`);
    const path = join(dir, `image-${i}.jpg`); await writeFile(path, Buffer.from(await response.arrayBuffer())); paths.push(path);
  }
  const framesNeeded = Math.max(1, Math.ceil(job.duration / job.interval));
  const seq = sequence(paths.length, framesNeeded, job.orderMode);
  for (let i = 0; i < seq.length; i++) {
    const framePath = join(dir, `frame-${String(i).padStart(6, "0")}.jpg`);
    try { await link(paths[seq[i]], framePath); } catch { await copyFile(paths[seq[i]], framePath); }
  }
  const [width, height] = formats[job.format];
  const effect = job.effect === "zoom" ? `scale=w='trunc(iw*(1+0.06*mod(t\\,1))/2)*2':h='trunc(ih*(1+0.06*mod(t\\,1))/2)*2':eval=frame,crop=${width}:${height}`
    : job.effect === "flash" ? `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=fill:enable='lt(mod(t\\,${job.interval})\\,0.04)'`
    : job.effect === "glitch" ? "rgbashift=rh=4:bh=-4,noise=alls=7:allf=t+u" : null;
  const filter = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, `eq=brightness=${brightness[job.darkness]}:contrast=1.04:saturation=0.95`, vignettes[job.vignette], effect, "fps=30", "format=yuv420p"].filter(Boolean).join(",");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", (1 / job.interval).toFixed(6), "-start_number", "0", "-i", join(dir, "frame-%06d.jpg"), "-t", String(job.duration), "-vf", filter, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-movflags", "+faststart", outputPath]);
  const output = await stat(outputPath);
  if (output.size < 10 * 1024) throw new Error(`Rendered video is unexpectedly small: ${output.size} bytes`);
} finally { await rm(dir, { recursive: true, force: true }); }
