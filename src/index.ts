interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TELEGRAM_IDS?: string;
  SESSIONS: KVNamespace;
  MEDIA: R2Bucket;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  WORKER_BASE_URL: string;
}

type Step = "photos" | "template" | "duration" | "speed" | "darkness" | "vignette" | "order" | "effect" | "format" | "confirm" | "template_name" | "template_rename" | "template_copy" | "admin_input" | "rendering";
type Darkness = "none" | "light" | "standard" | "strong";
type Vignette = "none" | "light" | "standard" | "strong";
type OrderMode = "original" | "shuffle_once" | "random_no_repeat";
type VideoFormat = "vertical" | "portrait" | "square" | "horizontal";
type Effect = "none" | "zoom" | "flash" | "glitch";
type TemplateName = string;

interface Session {
  step: Step;
  imageKeys: string[];
  duration?: number;
  interval?: number;
  darkness?: Darkness;
  vignette?: Vignette;
  orderMode?: OrderMode;
  format?: VideoFormat;
  effect?: Effect;
  templateName?: TemplateName;
  templatePreset?: boolean;
  actionTemplateId?: string;
  adminAction?: "limit" | "reset_limit" | "block" | "unblock" | "broadcast";
}
interface RenderJob {
  jobId: string;
  chatId: number;
  imageKeys: string[];
  duration: number;
  interval: number;
  darkness: Darkness;
  vignette: Vignette;
  orderMode: OrderMode;
  format: VideoFormat;
  effect: Effect;
  templateName: TemplateName;
  statusMessageId: number;
  dailyCounterKey?: string;
  queuedAt: number;
}
interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: TgUser;
    text?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    media_group_id?: string;
  };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { chat: { id: number } };
  };
}
interface StoredUser extends TgUser { lastSeen: string; blocked?: boolean }
interface SavedSettings {
  duration: number; interval: number; darkness: Darkness; vignette: Vignette;
  orderMode: OrderMode; format: VideoFormat; effect: Effect; templateName: TemplateName;
}
interface UserTemplate { id: string; ownerId: number; name: string; settings: SavedSettings; createdAt: string }

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});
const sessionKey = (chatId: number) => `session:${chatId}`;
const userKey = (userId: number) => `user:${userId}`;
const metricKey = (name: string) => `metric:${name}`;
const kyivDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dailyKey = (userId: number) => `daily:${userId}:${kyivDate()}`;
const DAILY_LIMIT = 5;
const RATE_LIMIT_PER_MINUTE = 30;
const OUTPUT_TTL_MS = 72 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const QUEUE_ALERT_THRESHOLD = 20;
const STORAGE_ALERT_BYTES = 5 * 1024 * 1024 * 1024;
const apiUrl = (env: Env, method: string) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isAdmin = (env: Env, userId: number) => (env.ADMIN_TELEGRAM_IDS || "").split(",").map((x) => x.trim()).includes(String(userId));

async function telegram(env: Env, method: string, payload: Record<string, unknown>) {
  const response = await fetch(apiUrl(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram ${method} failed`);
  return body.result;
}
async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown) {
  return telegram(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
async function editMessage(env: Env, chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  return telegram(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
async function alertAdmins(env: Env, text: string) {
  for (const id of (env.ADMIN_TELEGRAM_IDS || "").split(",").map(Number).filter(Boolean)) {
    try { await sendMessage(env, id, `⚠️ <b>Системне попередження</b>\n${escapeHtml(text)}`); } catch {}
  }
}
async function rateAllowed(env: Env, userId: number) {
  if (isAdmin(env, userId)) return true;
  const minute = Math.floor(Date.now() / 60000);
  const key = `rate:${userId}:${minute}`;
  const used = Number((await env.SESSIONS.get(key)) || 0);
  if (used >= RATE_LIMIT_PER_MINUTE) return false;
  await env.SESSIONS.put(key, String(used + 1), { expirationTtl: 120 });
  return true;
}
async function incMetric(env: Env, name: string, delta = 1) {
  const key = metricKey(name);
  const current = Number((await env.SESSIONS.get(key)) || 0);
  await env.SESSIONS.put(key, String(current + delta));
}
async function metric(env: Env, name: string) { return Number((await env.SESSIONS.get(metricKey(name))) || 0); }
async function incDailyMetric(env: Env, name: string, delta = 1) {
  const key = `daily-metric:${kyivDate()}:${name}`;
  const current = Number((await env.SESSIONS.get(key)) || 0);
  await env.SESSIONS.put(key, String(current + delta), { expirationTtl: 90 * 86400 });
}
async function recordError(env: Env, where: string, error: unknown) {
  const item = { at: new Date().toISOString(), where, message: error instanceof Error ? error.message : String(error) };
  const list = ((await env.SESSIONS.get("admin:errors", "json")) as typeof item[] | null) || [];
  list.unshift(item);
  await env.SESSIONS.put("admin:errors", JSON.stringify(list.slice(0, 20)));
}
async function registerUser(env: Env, user?: TgUser) {
  if (!user) return;
  const key = userKey(user.id);
  const existing = await env.SESSIONS.get<StoredUser>(key, "json");
  const saved: StoredUser = { ...user, lastSeen: new Date().toISOString(), blocked: existing?.blocked || false };
  await env.SESSIONS.put(key, JSON.stringify(saved));
  if (!existing) await incMetric(env, "total_users");
  const recent = ((await env.SESSIONS.get("admin:recent_users", "json")) as number[] | null) || [];
  await env.SESSIONS.put("admin:recent_users", JSON.stringify([user.id, ...recent.filter((id) => id !== user.id)].slice(0, 50)));
}
async function isBlocked(env: Env, userId: number) {
  const user = await env.SESSIONS.get<StoredUser>(userKey(userId), "json");
  return Boolean(user?.blocked);
}

const createKeyboard = { inline_keyboard: [
  [{ text: "🎞 Створити слайд-шоу", callback_data: "create" }],
  [{ text: "📁 Мої шаблони", callback_data: "my_templates" }],
  [{ text: "👤 Мій профіль", callback_data: "profile" }, { text: "ℹ️ Допомога", callback_data: "help" }],
  [{ text: "🗑 Видалити мої дані", callback_data: "delete_my_data" }],
] };
const photosKeyboard = { inline_keyboard: [
  [{ text: "✅ Далі", callback_data: "photos_done" }],
  [{ text: "🗑 Почати заново", callback_data: "create" }],
] };
const durationKeyboard = { inline_keyboard: [
  [10, 15, 30, 60].map((n) => ({ text: `${n} сек`, callback_data: `duration:${n}` })),
  [{ text: "⬅️ Назад", callback_data: "back" }, { text: "❌ Скасувати", callback_data: "cancel" }],
] };
const speedKeyboard = { inline_keyboard: [
  [0.1, 0.2, 0.3, 0.5].map((n) => ({ text: `${n} сек`, callback_data: `speed:${n}` })),
  [{ text: "⬅️ Назад", callback_data: "back" }, { text: "❌ Скасувати", callback_data: "cancel" }],
] };
const darknessKeyboard = { inline_keyboard: [
  [{ text: "Без затемнення", callback_data: "darkness:none" }, { text: "Слабке", callback_data: "darkness:light" }],
  [{ text: "Стандартне", callback_data: "darkness:standard" }, { text: "Сильне", callback_data: "darkness:strong" }],  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
const vignetteKeyboard = { inline_keyboard: [
  [{ text: "Без віньєтки", callback_data: "vignette:none" }, { text: "Легка", callback_data: "vignette:light" }],
  [{ text: "Стандартна", callback_data: "vignette:standard" }, { text: "Сильна", callback_data: "vignette:strong" }],  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
const orderKeyboard = { inline_keyboard: [
  [{ text: "Як завантажено", callback_data: "order:original" }],
  [{ text: "Перемішати один раз", callback_data: "order:shuffle_once" }],
  [{ text: "Випадково без повтору підряд", callback_data: "order:random_no_repeat" }],  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
const effectKeyboard = { inline_keyboard: [
  [{ text: "Без додаткового ефекту", callback_data: "effect:none" }],
  [{ text: "⚡ Flash", callback_data: "effect:flash" }, { text: "🔍 Zoom", callback_data: "effect:zoom" }],
  [{ text: "📺 Glitch", callback_data: "effect:glitch" }],  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
async function userTemplateKeyboard(env: Env, userId: number) {
  const indexKey = `user-templates:${userId}:index`;
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  const templates = (await Promise.all(ids.map((id) => env.SESSIONS.get<UserTemplate>(`user-template:${userId}:${id}`, "json")))).filter(Boolean) as UserTemplate[];
  return { inline_keyboard: [
    ...templates.map((t) => [{ text: `🎨 ${t.name}`, callback_data: `user_template:${t.id}` }]),
    [{ text: "⚙️ Створити вручну", callback_data: "template:custom" }],
  ] };
}
const formatKeyboard = { inline_keyboard: [
  [{ text: "📱 TikTok / Reels / Shorts — 9:16", callback_data: "format:vertical" }],
  [{ text: "🖼 Instagram Post — 4:5", callback_data: "format:portrait" }],
  [{ text: "⬜ Квадрат — 1:1", callback_data: "format:square" }],
  [{ text: "🖥 Горизонтальне — 16:9", callback_data: "format:horizontal" }],  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
const confirmKeyboard = { inline_keyboard: [
  [{ text: "🎬 Створити відео", callback_data: "render" }],
  [{ text: "💾 Зберегти як мій шаблон", callback_data: "save_my_template" }],
  [{ text: "❌ Скасувати", callback_data: "cancel" }],
] };
const adminKeyboard = { inline_keyboard: [
  [{ text: "📊 Статистика", callback_data: "admin:stats" }, { text: "👥 Користувачі", callback_data: "admin:users" }],
  [{ text: "⚠️ Помилки", callback_data: "admin:errors" }],
  [{ text: "🔧 Технічні роботи", callback_data: "admin:maintenance" }],
  [{ text: "🎚 Встановити ліміт", callback_data: "admin:limit" }, { text: "♻️ Скинути ліміт", callback_data: "admin:reset_limit" }],
  [{ text: "🚫 Заблокувати", callback_data: "admin:block" }, { text: "✅ Розблокувати", callback_data: "admin:unblock" }],
  [{ text: "📣 Розсилка", callback_data: "admin:broadcast" }],
  [{ text: "⬅️ Головне меню", callback_data: "main_menu" }],
] };

async function getSession(env: Env, chatId: number): Promise<Session | null> { return env.SESSIONS.get(sessionKey(chatId), "json"); }
async function putSession(env: Env, chatId: number, session: Session) {
  await env.SESSIONS.put(sessionKey(chatId), JSON.stringify(session), { expirationTtl: 3600 });
}
async function removeImages(env: Env, keys: string[]) { if (keys.length) await env.MEDIA.delete(keys); }
async function listAllUploadKeys(env: Env, chatId: number) {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix: `uploads/${chatId}/`, limit: 1000, cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects
    .sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime() || a.key.localeCompare(b.key))
    .map((object) => object.key);
}
async function listUploadKeys(env: Env, chatId: number) {
  return (await listAllUploadKeys(env, chatId)).slice(0, 10);
}
async function removeAllUploadImages(env: Env, chatId: number) {
  await removeImages(env, await listAllUploadKeys(env, chatId));
}
async function dailyUsed(env: Env, userId: number) { return Number((await env.SESSIONS.get(dailyKey(userId))) || 0); }
async function checkDailyLimit(env: Env, userId: number) {
  if (isAdmin(env, userId)) return { allowed: true, used: 0, left: DAILY_LIMIT };
  const used = await dailyUsed(env, userId);
  const custom = await env.SESSIONS.get(`limit:${userId}`);
  const limit = custom === null ? DAILY_LIMIT : Number(custom);
  return { allowed: used < limit, used, left: Math.max(0, limit - used) };
}
async function refundDailyLimit(env: Env, key?: string) {
  if (!key) return;
  const used = Number((await env.SESSIONS.get(key)) || 0);
  await env.SESSIONS.put(key, String(Math.max(0, used - 1)), { expirationTtl: 172800 });
}
async function consumeDailyLimit(env: Env, userId: number) {
  if (isAdmin(env, userId)) return;
  const key = dailyKey(userId); const used = await dailyUsed(env, userId);
  await env.SESSIONS.put(key, String(used + 1), { expirationTtl: 172800 });
}
async function resetSession(env: Env, chatId: number) {
  const limit = await checkDailyLimit(env, chatId);
  if (!limit.allowed) return sendMessage(env, chatId, "⛔ Денний ліміт вичерпано. Доступно <b>5 відео на день</b>. Ліміт оновиться опівночі за Києвом.");
  await removeAllUploadImages(env, chatId);
  await putSession(env, chatId, { step: "photos", imageKeys: [] });
  await sendMessage(env, chatId, `Надішли <b>4–10 фото</b>. Коли завершиш — натисни «Далі».
Сьогодні залишилося відео: <b>${limit.left}</b>`, photosKeyboard);
}
async function downloadTelegramPhoto(env: Env, fileId: string) {
  const result = (await telegram(env, "getFile", { file_id: fileId })) as { file_path: string };
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${result.file_path}`);
  if (!response.ok) throw new Error("Не вдалося завантажити фото з Telegram");
  const ext = result.file_path.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "jpg";
  return { data: await response.arrayBuffer(), ext };
}
async function acceptPhoto(env: Env, chatId: number, photos: Array<{ file_id: string }>) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "photos") return sendMessage(env, chatId, "Спочатку натисни «Створити слайд-шоу».", createKeyboard);
  const existingKeys = await listUploadKeys(env, chatId);
  if (existingKeys.length >= 10) return sendMessage(env, chatId, "Уже є максимум 10 фото. Натисни «Далі».", photosKeyboard);
  const { data, ext } = await downloadTelegramPhoto(env, photos[photos.length - 1].file_id);
  if (data.byteLength > 15 * 1024 * 1024) return sendMessage(env, chatId, "Це фото завелике. Максимум — 15 МБ.");
  const key = `uploads/${chatId}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, data, { httpMetadata: { contentType: `image/${ext === "jpg" ? "jpeg" : ext}` } });
  const keys = await listUploadKeys(env, chatId);
  session.imageKeys = keys;
  await putSession(env, chatId, session);
  const count = keys.length;
  await sendMessage(env, chatId, `Фото додано: <b>${count}/10</b>${count < 4 ? `\nПотрібно ще мінімум ${4 - count}.` : "\nМожна переходити далі."}`, photosKeyboard);
}
async function chooseCreationMode(env: Env, chatId: number) {
  const session = await getSession(env, chatId);
  if (!session) return sendMessage(env, chatId, "Спочатку натисни «Створити слайд-шоу».", createKeyboard);
  session.imageKeys = await listUploadKeys(env, chatId);
  if (session.imageKeys.length < 4) return sendMessage(env, chatId, `Знайдено <b>${session.imageKeys.length}</b> фото. Потрібно завантажити щонайменше 4.`, photosKeyboard);
  if (session.templatePreset && session.duration && session.interval && session.darkness && session.vignette && session.orderMode && session.format && session.effect && session.templateName) {
    session.step = "confirm"; await putSession(env, chatId, session); return showConfirmation(env, chatId, session);
  }
  session.step = "template"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери один зі своїх приватних шаблонів або налаштуй відео вручну:", await userTemplateKeyboard(env, chatId));
}
async function setDuration(env: Env, chatId: number, duration: number) {
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) return sendMessage(env, chatId, "Тривалість має бути від 1 до 60 секунд.", durationKeyboard);
  const session = await getSession(env, chatId); if (!session || session.step !== "duration") return;
  session.duration = duration; session.step = "speed"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери швидкість зміни фото. Стандарт — <b>0,2 сек</b>:", speedKeyboard);
}
async function setSpeed(env: Env, chatId: number, interval: number) {
  if (!Number.isFinite(interval) || interval < 0.05 || interval > 2) return sendMessage(env, chatId, "Швидкість має бути від 0.05 до 2 секунд.", speedKeyboard);
  const session = await getSession(env, chatId); if (!session || session.step !== "speed") return;
  session.interval = interval; session.step = "darkness"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери силу затемнення:", darknessKeyboard);
}
async function setDarkness(env: Env, chatId: number, value: Darkness) {
  const session = await getSession(env, chatId); if (!session || session.step !== "darkness") return;
  session.darkness = value; session.step = "vignette"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери силу віньєтки:", vignetteKeyboard);
}
async function setVignette(env: Env, chatId: number, value: Vignette) {
  const session = await getSession(env, chatId); if (!session || session.step !== "vignette") return;
  session.vignette = value; session.step = "order"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери порядок фотографій:", orderKeyboard);
}
async function setOrder(env: Env, chatId: number, value: OrderMode) {
  const session = await getSession(env, chatId); if (!session || session.step !== "order") return;
  session.orderMode = value; session.step = "effect"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери додатковий ефект:", effectKeyboard);
}
const labels = {
  darkness: { none: "без затемнення", light: "слабке", standard: "стандартне", strong: "сильне" },
  vignette: { none: "без віньєтки", light: "легка", standard: "стандартна", strong: "сильна" },
  order: { original: "як завантажено", shuffle_once: "перемішано", random_no_repeat: "випадково без повтору" },
  format: { vertical: "9:16", portrait: "4:5", square: "1:1", horizontal: "16:9" },
  effect: { none: "без ефекту", zoom: "Zoom", flash: "Flash", glitch: "Glitch" },
} as const;
async function chooseManual(env: Env, chatId: number) {
  const session = await getSession(env, chatId); if (!session || session.step !== "template") return;
  session.templateName = "Власний"; session.step = "duration"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери тривалість або надішли число від <b>1 до 60</b>:", durationKeyboard);
}
async function chooseUserTemplate(env: Env, chatId: number, id: string) {
  const session = await getSession(env, chatId); if (!session || session.step !== "template") return;
  const template = await env.SESSIONS.get<UserTemplate>(`user-template:${chatId}:${id}`, "json");
  if (!template || template.ownerId !== chatId) return sendMessage(env, chatId, "Шаблон не знайдено.", await userTemplateKeyboard(env, chatId));
  Object.assign(session, template.settings, { templateName: template.name, step: "confirm" });
  await putSession(env, chatId, session); await showConfirmation(env, chatId, session);
}
async function setEffect(env: Env, chatId: number, effect: Effect) {
  const session = await getSession(env, chatId); if (!session || session.step !== "effect") return;
  session.effect = effect; session.templateName = "Власний"; session.step = "format"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери формат відео:", formatKeyboard);
}
async function setFormat(env: Env, chatId: number, format: VideoFormat) {
  const session = await getSession(env, chatId); if (!session || session.step !== "format") return;
  session.format = format; session.step = "confirm"; await putSession(env, chatId, session); await showConfirmation(env, chatId, session);
}
async function showConfirmation(env: Env, chatId: number, session: Session) {
  if (!session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.format || !session.templateName) return;
  await sendMessage(env, chatId, `<b>Перевір налаштування</b>\n\nШаблон: ${escapeHtml(session.templateName)}\nТривалість: ${session.duration} сек\nШвидкість: ${session.interval} сек\nЗатемнення: ${labels.darkness[session.darkness]}\nВіньєтка: ${labels.vignette[session.vignette]}\nПорядок: ${labels.order[session.orderMode]}\nФормат: ${labels.format[session.format]}\nWatermark: немає`, confirmKeyboard);
}
async function startRender(env: Env, chatId: number) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "confirm" || !session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.format || !session.effect || !session.templateName) return;
  session.imageKeys = await listUploadKeys(env, chatId);
  if (session.imageKeys.length < 4) return sendMessage(env, chatId, "Фото не знайдено. Почни створення заново й надішли 4–10 фото.", createKeyboard);
  const limit = await checkDailyLimit(env, chatId);
  if (!limit.allowed) return sendMessage(env, chatId, "⛔ Денний ліміт у 5 відео вичерпано. Спробуй після опівночі за Києвом.");
  if (await env.SESSIONS.get(`active-job:${chatId}`)) return sendMessage(env, chatId, "У тебе вже є активна генерація.");
  const jobId = crypto.randomUUID();
  const pending = Number((await env.SESSIONS.get("queue:pending")) || 0) + 1;
  const status = await sendMessage(env, chatId, `🕒 <b>Завдання прийнято</b>\nПозиція в черзі: приблизно <b>${pending}</b>`, {
    inline_keyboard: [[{ text: "❌ Скасувати створення", callback_data: `cancel_job:${jobId}` }]],
  }) as { message_id: number };
  session.step = "rendering"; await putSession(env, chatId, session); await consumeDailyLimit(env, chatId);
  const counterKey = isAdmin(env, chatId) ? undefined : dailyKey(chatId);
  const job: RenderJob = { jobId, chatId, imageKeys: session.imageKeys, duration: session.duration, interval: session.interval, darkness: session.darkness, vignette: session.vignette, orderMode: session.orderMode, format: session.format, effect: session.effect, templateName: session.templateName, statusMessageId: status.message_id, dailyCounterKey: counterKey, queuedAt: Date.now() };
  const jobToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await Promise.all([
    env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "queued", chatId }), { expirationTtl: 86400 }),
    env.SESSIONS.put(`render-job:${jobId}`, JSON.stringify({ job, token: jobToken }), { expirationTtl: 86400 }),
    env.SESSIONS.put(`active-job:${chatId}`, jobId, { expirationTtl: 3600 }),
    env.SESSIONS.put("queue:pending", String(pending)),
  ]);
  try {
    await dispatchGitHubRender(env, jobId, jobToken);
  } catch (error) {
    await failRender(env, job, `Не вдалося запустити GitHub Actions: ${String(error)}`);
    return;
  }
  await Promise.all([incMetric(env, "total_jobs"), incDailyMetric(env, "queued"), incMetric(env, `format:${session.format}`), incMetric(env, `template:${session.templateName}`), incMetric(env, `darkness:${session.darkness}`), incMetric(env, `vignette:${session.vignette}`), incMetric(env, `order:${session.orderMode}`)]);
  if (pending >= QUEUE_ALERT_THRESHOLD) await alertAdmins(env, `Черга досягла ${pending} завдань.`);
}
async function askUserTemplateName(env: Env, chatId: number) {
  const session = await getSession(env, chatId); if (!session || session.step !== "confirm") return;
  session.step = "template_name"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Надішли назву свого приватного шаблону, наприклад: <b>Мій темний</b>.");
}
async function saveUserTemplate(env: Env, chatId: number, name: string) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "template_name" || !session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.format || !session.effect) return;
  const cleanName = name.trim().slice(0, 40); if (!cleanName) return sendMessage(env, chatId, "Назва не може бути порожньою.");
  const id = crypto.randomUUID().slice(0, 8); const indexKey = `user-templates:${chatId}:index`;
  const settings: SavedSettings = { duration: session.duration, interval: session.interval, darkness: session.darkness, vignette: session.vignette, orderMode: session.orderMode, format: session.format, effect: session.effect, templateName: cleanName };
  const template: UserTemplate = { id, ownerId: chatId, name: cleanName, settings, createdAt: new Date().toISOString() };
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  if (ids.length >= 20) return sendMessage(env, chatId, "Можна зберегти максимум 20 шаблонів. Видали непотрібний через «Мої шаблони».");
  await Promise.all([env.SESSIONS.put(`user-template:${chatId}:${id}`, JSON.stringify(template)), env.SESSIONS.put(indexKey, JSON.stringify([...ids, id]))]);
  session.templateName = cleanName; session.step = "confirm"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, `✅ Приватний шаблон <b>${escapeHtml(cleanName)}</b> збережено. Його бачиш лише ти.`);
  await showConfirmation(env, chatId, session);
}
async function listUserTemplates(env: Env, chatId: number) {
  const indexKey = `user-templates:${chatId}:index`;
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  const templates = (await Promise.all(ids.map((id) => env.SESSIONS.get<UserTemplate>(`user-template:${chatId}:${id}`, "json")))).filter(Boolean) as UserTemplate[];
  await sendMessage(env, chatId, `<b>📁 Мої приватні шаблони</b>\n\n${templates.length ? "Обери шаблон:" : "У тебе ще немає шаблонів."}`, {
    inline_keyboard: [
      ...templates.map((t) => [{ text: `🎨 ${t.name}`, callback_data: `manage_tpl:${t.id}` }]),
      [{ text: "➕ Створити нове відео", callback_data: "create" }],
      [{ text: "⬅️ Головне меню", callback_data: "main_menu" }],
    ],
  });
}
async function deleteUserTemplate(env: Env, chatId: number, id: string) {
  const indexKey = `user-templates:${chatId}:index`;
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  if (!ids.includes(id)) return sendMessage(env, chatId, "Шаблон не знайдено.");
  await Promise.all([env.SESSIONS.delete(`user-template:${chatId}:${id}`), env.SESSIONS.put(indexKey, JSON.stringify(ids.filter((x) => x !== id)))]);
  await sendMessage(env, chatId, `Шаблон <code>${escapeHtml(id)}</code> видалено.`, createKeyboard);
}
async function renameUserTemplate(env: Env, chatId: number, id: string, name: string) {
  const key = `user-template:${chatId}:${id}`;
  const template = await env.SESSIONS.get<UserTemplate>(key, "json");
  if (!template) return sendMessage(env, chatId, "Шаблон не знайдено.");
  template.name = name.trim().slice(0, 40); template.settings.templateName = template.name;
  await env.SESSIONS.put(key, JSON.stringify(template));
  await sendMessage(env, chatId, `✅ Нове ім’я: <b>${escapeHtml(template.name)}</b>.`);
}
async function copyUserTemplate(env: Env, chatId: number, id: string, name: string) {
  const source = await env.SESSIONS.get<UserTemplate>(`user-template:${chatId}:${id}`, "json");
  if (!source) return sendMessage(env, chatId, "Шаблон не знайдено.");
  const newId = crypto.randomUUID().slice(0, 8); const indexKey = `user-templates:${chatId}:index`;
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  if (ids.length >= 20) return sendMessage(env, chatId, "Досягнуто ліміт у 20 шаблонів.");
  const copy: UserTemplate = { ...source, id: newId, name: name.trim().slice(0, 40), createdAt: new Date().toISOString(), settings: { ...source.settings, templateName: name.trim().slice(0, 40) } };
  await Promise.all([env.SESSIONS.put(`user-template:${chatId}:${newId}`, JSON.stringify(copy)), env.SESSIONS.put(indexKey, JSON.stringify([...ids, newId]))]);
  await sendMessage(env, chatId, `✅ Копію створено: <b>${escapeHtml(copy.name)}</b> (<code>${newId}</code>).`);
}
async function setTemplateProperty(env: Env, chatId: number, id: string, property: string, raw: string) {
  const key = `user-template:${chatId}:${id}`; const t = await env.SESSIONS.get<UserTemplate>(key, "json");
  if (!t) return sendMessage(env, chatId, "Шаблон не знайдено.");
  const allowed: Record<string, string[]> = {
    darkness: ["none","light","standard","strong"], vignette: ["none","light","standard","strong"],
    orderMode: ["original","shuffle_once","random_no_repeat"], effect: ["none","zoom","flash","glitch"],
    format: ["vertical","portrait","square","horizontal"],
  };
  if (property === "duration") t.settings.duration = Math.min(60, Math.max(1, Number(raw)));
  else if (property === "interval") t.settings.interval = Math.min(2, Math.max(0.05, Number(raw)));
  else if (allowed[property]?.includes(raw)) (t.settings as unknown as Record<string, unknown>)[property] = raw;
  else return sendMessage(env, chatId, "Неправильна властивість або значення.");
  await env.SESSIONS.put(key, JSON.stringify(t));
  await sendMessage(env, chatId, `✅ Параметр <code>${escapeHtml(property)}</code> змінено.`);
}
async function showTemplateMenu(env: Env, chatId: number, id: string) {
  const t = await env.SESSIONS.get<UserTemplate>(`user-template:${chatId}:${id}`, "json");
  if (!t) return listUserTemplates(env, chatId);
  await sendMessage(env, chatId, `<b>${escapeHtml(t.name)}</b>\n\nТривалість: ${t.settings.duration} сек\nШвидкість: ${t.settings.interval} сек\nЕфект: ${labels.effect[t.settings.effect]}\nФормат: ${labels.format[t.settings.format]}`, {
    inline_keyboard: [
      [{ text: "▶️ Використати", callback_data: `tpl_use:${id}` }, { text: "✏️ Редагувати", callback_data: `tpl_edit:${id}` }],
      [{ text: "📝 Перейменувати", callback_data: `tpl_rename:${id}` }, { text: "📋 Копіювати", callback_data: `tpl_copy:${id}` }],
      [{ text: "🗑 Видалити", callback_data: `tpl_delete:${id}` }],
      [{ text: "⬅️ До шаблонів", callback_data: "my_templates" }],
    ],
  });
}
async function startWithTemplate(env: Env, chatId: number, id: string) {
  const t = await env.SESSIONS.get<UserTemplate>(`user-template:${chatId}:${id}`, "json");
  if (!t) return listUserTemplates(env, chatId);
  const limit = await checkDailyLimit(env, chatId); if (!limit.allowed) return sendMessage(env, chatId, "Денний ліміт вичерпано.");
  await removeAllUploadImages(env, chatId);
  await putSession(env, chatId, { step: "photos", imageKeys: [], ...t.settings, templatePreset: true });
  await sendMessage(env, chatId, `Шаблон <b>${escapeHtml(t.name)}</b> вибрано. Надішли 4–10 фото.`, photosKeyboard);
}
async function showTemplateEditor(env: Env, chatId: number, id: string) {
  await sendMessage(env, chatId, "Що змінити?", { inline_keyboard: [
    [{ text: "⏱ Тривалість", callback_data: `tplprop:${id}:duration` }, { text: "⚡ Швидкість", callback_data: `tplprop:${id}:interval` }],
    [{ text: "🌑 Затемнення", callback_data: `tplprop:${id}:darkness` }, { text: "⭕ Віньєтка", callback_data: `tplprop:${id}:vignette` }],
    [{ text: "🔀 Порядок", callback_data: `tplprop:${id}:orderMode` }, { text: "✨ Ефект", callback_data: `tplprop:${id}:effect` }],
    [{ text: "📐 Формат", callback_data: `tplprop:${id}:format` }],
    [{ text: "⬅️ Назад", callback_data: `manage_tpl:${id}` }],
  ]});
}
async function showTemplateProperty(env: Env, chatId: number, id: string, prop: string) {
  const values: Record<string, Array<[string,string]>> = {
    duration: [["10 сек","10"],["15 сек","15"],["30 сек","30"],["60 сек","60"]],
    interval: [["0.1","0.1"],["0.2","0.2"],["0.3","0.3"],["0.5","0.5"]],
    darkness: [["Без","none"],["Слабке","light"],["Стандарт","standard"],["Сильне","strong"]],
    vignette: [["Без","none"],["Легка","light"],["Стандарт","standard"],["Сильна","strong"]],
    orderMode: [["Як завантажено","original"],["Перемішати","shuffle_once"],["Випадково","random_no_repeat"]],
    effect: [["Без","none"],["Zoom","zoom"],["Flash","flash"],["Glitch","glitch"]],
    format: [["9:16","vertical"],["4:5","portrait"],["1:1","square"],["16:9","horizontal"]],
  };
  const rows = (values[prop] || []).map(([label,value]) => [{ text: label, callback_data: `tplset:${id}:${prop}:${value}` }]);
  await sendMessage(env, chatId, "Обери нове значення:", { inline_keyboard: [...rows, [{ text: "⬅️ Назад", callback_data: `tpl_edit:${id}` }]] });
}
async function promptTemplateName(env: Env, chatId: number, id: string, action: "template_rename" | "template_copy") {
  await putSession(env, chatId, { step: action, imageKeys: [], actionTemplateId: id });
  await sendMessage(env, chatId, action === "template_rename" ? "Надішли нову назву шаблону:" : "Надішли назву копії:");
}
async function showProfile(env: Env, chatId: number) {
  const limit = await checkDailyLimit(env, chatId);
  const ids = ((await env.SESSIONS.get(`user-templates:${chatId}:index`, "json")) as string[] | null) || [];
  await sendMessage(env, chatId, `<b>👤 Мій профіль</b>\n\nTelegram ID: <code>${chatId}</code>\nЗалишилося відео сьогодні: <b>${limit.left}</b>\nПриватних шаблонів: <b>${ids.length}/20</b>\nWatermark: <b>немає</b>`, {
    inline_keyboard: [[{ text: "📁 Мої шаблони", callback_data: "my_templates" }],[{ text: "🗑 Видалити мої дані", callback_data: "delete_my_data" }],[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]],
  });
}
async function showHelp(env: Env, chatId: number) {
  await sendMessage(env, chatId, "<b>ℹ️ Допомога</b>\n\n1. Натисни «Створити слайд-шоу».\n2. Завантаж 4–10 фото.\n3. Обери свій шаблон або налаштуй відео.\n4. Натисни «Створити».\n\nУсі функції доступні кнопками.", { inline_keyboard: [[{ text: "🎞 Створити", callback_data: "create" }],[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]] });
}
async function promptAdmin(env: Env, chatId: number, action: Session["adminAction"]) {
  await putSession(env, chatId, { step: "admin_input", imageKeys: [], adminAction: action });
  const prompts = {
    limit: "Надішли: <code>USER_ID ЛІМІТ</code>",
    reset_limit: "Надішли Telegram ID користувача:",
    block: "Надішли Telegram ID для блокування:",
    unblock: "Надішли Telegram ID для розблокування:",
    broadcast: "Надішли текст розсилки:",
  };
  await sendMessage(env, chatId, prompts[action!], { inline_keyboard: [[{ text: "⬅️ В адмін-панель", callback_data: "admin:home" }]] });
}
async function handleAdminInput(env: Env, chatId: number, session: Session, text: string) {
  const action = session.adminAction;
  if (action === "limit") { const [id, limit] = text.split(/\s+/); await env.SESSIONS.put(`limit:${id}`, String(Math.max(0, Number(limit)))); await sendMessage(env, chatId, "✅ Ліміт встановлено.", adminKeyboard); }
  else if (action === "reset_limit") { await env.SESSIONS.delete(dailyKey(Number(text))); await sendMessage(env, chatId, "✅ Ліміт скинуто.", adminKeyboard); }
  else if (action === "block") await setBlocked(env, chatId, Number(text), true);
  else if (action === "unblock") await setBlocked(env, chatId, Number(text), false);
  else if (action === "broadcast") await broadcast(env, chatId, text);
  await env.SESSIONS.delete(sessionKey(chatId));
}
async function cancel(env: Env, chatId: number) {
  const session = await getSession(env, chatId); if (session) await removeImages(env, session.imageKeys);
  await env.SESSIONS.delete(sessionKey(chatId)); await sendMessage(env, chatId, "Скасовано.", createKeyboard);
}
async function goBack(env: Env, chatId: number) {
  const s = await getSession(env, chatId); if (!s) return;
  if (s.step === "template") { s.step = "photos"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Можеш додати фото або натиснути «Далі».", photosKeyboard); }
  if (s.step === "duration") { s.step = "template"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери шаблон:", await userTemplateKeyboard(env, chatId)); }
  if (s.step === "speed") { s.step = "duration"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери тривалість:", durationKeyboard); }
  if (s.step === "darkness") { s.step = "speed"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери швидкість:", speedKeyboard); }
  if (s.step === "vignette") { s.step = "darkness"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери затемнення:", darknessKeyboard); }
  if (s.step === "order") { s.step = "vignette"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери віньєтку:", vignetteKeyboard); }
  if (s.step === "effect") { s.step = "order"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери порядок:", orderKeyboard); }
  if (s.step === "format" || s.step === "confirm") { s.step = "effect"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери ефект:", effectKeyboard); }
  if (s.step === "template_name") { s.step = "confirm"; await putSession(env, chatId, s); return showConfirmation(env, chatId, s); }
}

async function adminStats(env: Env, chatId: number) {
  const names = ["total_users", "total_jobs", "completed", "failed", "rendered_seconds", "blocked"];
  const [users, jobs, completed, failed, seconds, blocked] = await Promise.all(names.map((n) => metric(env, n)));
  const formats = await Promise.all(["vertical", "portrait", "square", "horizontal"].map((n) => metric(env, `format:${n}`)));
  const [todayCompleted, todayFailed, totalRenderMs, outputBytes, pending] = await Promise.all([
    env.SESSIONS.get(`daily-metric:${kyivDate()}:completed`), env.SESSIONS.get(`daily-metric:${kyivDate()}:failed`),
    metric(env, "render_ms"), metric(env, "output_bytes"), env.SESSIONS.get("queue:pending"),
  ]);
  const averageSeconds = completed ? (totalRenderMs / completed / 1000).toFixed(1) : "0";
  await sendMessage(env, chatId,
    `<b>📊 Детальна статистика</b>\n\nКористувачів: <b>${users}</b>\nЗавдань: <b>${jobs}</b>\nУспішно: <b>${completed}</b>\nПомилок: <b>${failed}</b>\nСьогодні успішно: <b>${todayCompleted || 0}</b>\nСьогодні помилок: <b>${todayFailed || 0}</b>\nУ черзі: <b>${pending || 0}</b>\nСередній рендер: <b>${averageSeconds} сек</b>\nВідео-секунд: <b>${seconds}</b>\nВихідних даних: <b>${(outputBytes / 1024 / 1024).toFixed(1)} МБ</b>\nЗаблоковано: <b>${blocked}</b>\n\n<b>Формати</b>\n9:16 — ${formats[0]}\n4:5 — ${formats[1]}\n1:1 — ${formats[2]}\n16:9 — ${formats[3]}`,
    adminKeyboard,
  );
}
async function adminUsers(env: Env, chatId: number) {
  const ids = ((await env.SESSIONS.get("admin:recent_users", "json")) as number[] | null) || [];
  const users = await Promise.all(ids.slice(0, 10).map((id) => env.SESSIONS.get<StoredUser>(userKey(id), "json")));
  const lines = users.filter(Boolean).map((u) => {
    const name = [u!.first_name, u!.last_name].filter(Boolean).join(" ") || "Без імені";
    return `${u!.blocked ? "🚫" : "👤"} <code>${u!.id}</code> ${escapeHtml(name)}${u!.username ? ` @${escapeHtml(u!.username)}` : ""}`;
  });
  await sendMessage(env, chatId, `<b>Останні користувачі</b>\n\n${lines.join("\n") || "Ще немає користувачів."}\n\nКерування користувачами доступне кнопками в адмін-панелі.`, adminKeyboard);
}
async function adminErrors(env: Env, chatId: number) {
  const errors = ((await env.SESSIONS.get("admin:errors", "json")) as Array<{at:string;where:string;message:string}> | null) || [];
  const text = errors.slice(0, 8).map((e) => `• ${e.at.slice(0, 16)} <b>${escapeHtml(e.where)}</b>\n${escapeHtml(e.message).slice(0, 300)}`).join("\n\n");
  await sendMessage(env, chatId, `<b>⚠️ Останні помилки</b>\n\n${text || "Помилок немає."}`, adminKeyboard);
}
async function setBlocked(env: Env, chatId: number, userId: number, blocked: boolean) {
  const user = await env.SESSIONS.get<StoredUser>(userKey(userId), "json");
  if (!user) return sendMessage(env, chatId, "Користувача не знайдено.");
  if (user.blocked !== blocked) await incMetric(env, "blocked", blocked ? 1 : -1);
  user.blocked = blocked; await env.SESSIONS.put(userKey(userId), JSON.stringify(user));
  await sendMessage(env, chatId, blocked ? `🚫 Користувача <code>${userId}</code> заблоковано.` : `✅ Користувача <code>${userId}</code> розблоковано.`);
}
async function broadcast(env: Env, chatId: number, text: string) {
  if (!text) return sendMessage(env, chatId, "Використання: <code>/admin_broadcast текст</code>");
  let cursor: string | undefined; let sent = 0; let failed = 0;
  do {
    const page = await env.SESSIONS.list({ prefix: "user:", cursor, limit: 100 });
    for (const key of page.keys) {
      const user = await env.SESSIONS.get<StoredUser>(key.name, "json");
      if (!user || user.blocked) continue;
      try { await sendMessage(env, user.id, escapeHtml(text)); sent++; } catch { failed++; }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await sendMessage(env, chatId, `Розсилку завершено. Надіслано: <b>${sent}</b>, помилок: <b>${failed}</b>.`);
}
async function handleAdminCommand(env: Env, chatId: number, userId: number, text: string) {
  if (!isAdmin(env, userId)) return false;
  if (text === "/admin") { await sendMessage(env, chatId, "<b>🛠 Адмін-панель</b>", adminKeyboard); return true; }
  return false;
}

async function cancelJob(env: Env, chatId: number, jobId: string) {
  const state = await env.SESSIONS.get<{status:string;chatId:number}>(`job:${jobId}`, "json");
  if (!state || state.chatId !== chatId || ["done","failed","cancelled"].includes(state.status)) return sendMessage(env, chatId, "Це завдання вже завершене.");
  await env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ ...state, status: "cancelled" }), { expirationTtl: 86400 });
  await sendMessage(env, chatId, "Скасування прийнято. Файли буде видалено.");
}
async function deletePrefix(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function deleteMyData(env: Env, chatId: number) {
  const active = await env.SESSIONS.get(`active-job:${chatId}`);
  if (active) await cancelJob(env, chatId, active);
  const indexKey = `user-templates:${chatId}:index`;
  const ids = ((await env.SESSIONS.get(indexKey, "json")) as string[] | null) || [];
  await Promise.all([
    ...ids.map((id) => env.SESSIONS.delete(`user-template:${chatId}:${id}`)),
    env.SESSIONS.delete(indexKey), env.SESSIONS.delete(sessionKey(chatId)), env.SESSIONS.delete(userKey(chatId)),
    env.SESSIONS.delete(dailyKey(chatId)), deletePrefix(env, `uploads/${chatId}/`), deletePrefix(env, `outputs/${chatId}/`),
  ]);
  await sendMessage(env, chatId, "✅ Твої файли, шаблони, сесія та профіль видалені.");
}

async function handleUpdate(env: Env, update: TelegramUpdate) {
  const callback = update.callback_query;
  const user = callback?.from || update.message?.from;
  await registerUser(env, user);
  if (user && await isBlocked(env, user.id) && !isAdmin(env, user.id)) return;
  if (user && !await rateAllowed(env, user.id)) return sendMessage(env, user.id, "Забагато дій. Спробуй через хвилину.");
  if (user && !isAdmin(env, user.id) && await env.SESSIONS.get("admin:maintenance") === "1") return sendMessage(env, user.id, "🔧 Бот тимчасово оновлюється. Спробуй пізніше.");
  if (callback?.message) {
    const chatId = callback.message.chat.id; const data = callback.data || "";
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
    if (data.startsWith("admin:") && isAdmin(env, callback.from.id)) {
      if (data === "admin:home") return sendMessage(env, chatId, "<b>🛠 Адмін-панель</b>", adminKeyboard);
      if (data === "admin:stats") return adminStats(env, chatId);
      if (data === "admin:users") return adminUsers(env, chatId);
      if (data === "admin:errors") return adminErrors(env, chatId);
      if (data === "admin:maintenance") {
        const enabled = await env.SESSIONS.get("admin:maintenance") !== "1";
        await env.SESSIONS.put("admin:maintenance", enabled ? "1" : "0");
        return sendMessage(env, chatId, enabled ? "🔧 Технічні роботи увімкнено." : "✅ Технічні роботи вимкнено.", adminKeyboard);
      }
      if (data === "admin:limit") return promptAdmin(env, chatId, "limit");
      if (data === "admin:reset_limit") return promptAdmin(env, chatId, "reset_limit");
      if (data === "admin:block") return promptAdmin(env, chatId, "block");
      if (data === "admin:unblock") return promptAdmin(env, chatId, "unblock");
      if (data === "admin:broadcast") return promptAdmin(env, chatId, "broadcast");
    }
    if (data === "main_menu") return sendMessage(env, chatId, "<b>Головне меню</b>", createKeyboard);
    if (data === "profile") return showProfile(env, chatId);
    if (data === "help") return showHelp(env, chatId);
    if (data === "create") return resetSession(env, chatId);
    if (data === "back") return goBack(env, chatId);
    if (data.startsWith("cancel_job:")) return cancelJob(env, chatId, data.split(":")[1]);
    if (data === "delete_my_data") return sendMessage(env, chatId, "⚠️ Видалити всі твої файли, шаблони та дані?", { inline_keyboard: [[{ text: "Так, видалити", callback_data: "delete_my_data_confirm" }],[{ text: "Ні", callback_data: "main_menu" }]] });
    if (data === "delete_my_data_confirm") return deleteMyData(env, chatId);
    if (data === "my_templates") return listUserTemplates(env, chatId);
    if (data.startsWith("manage_tpl:")) return showTemplateMenu(env, chatId, data.split(":")[1]);
    if (data.startsWith("tpl_use:")) return startWithTemplate(env, chatId, data.split(":")[1]);
    if (data.startsWith("tpl_edit:")) return showTemplateEditor(env, chatId, data.split(":")[1]);
    if (data.startsWith("tplprop:")) { const [,id,prop] = data.split(":"); return showTemplateProperty(env, chatId, id, prop); }
    if (data.startsWith("tplset:")) { const [,id,prop,value] = data.split(":"); await setTemplateProperty(env, chatId, id, prop, value); return showTemplateMenu(env, chatId, id); }
    if (data.startsWith("tpl_rename:")) return promptTemplateName(env, chatId, data.split(":")[1], "template_rename");
    if (data.startsWith("tpl_copy:")) return promptTemplateName(env, chatId, data.split(":")[1], "template_copy");
    if (data.startsWith("tpl_delete:")) { const id = data.split(":")[1]; return sendMessage(env, chatId, "Точно видалити шаблон?", { inline_keyboard: [[{ text: "🗑 Так", callback_data: `tpl_delete_confirm:${id}` }],[{ text: "⬅️ Ні", callback_data: `manage_tpl:${id}` }]] }); }
    if (data.startsWith("tpl_delete_confirm:")) return deleteUserTemplate(env, chatId, data.split(":")[1]);
    if (data === "photos_done") return chooseCreationMode(env, chatId);
    if (data === "cancel") return cancel(env, chatId);
    if (data.startsWith("duration:")) return setDuration(env, chatId, Number(data.split(":")[1]));
    if (data === "template:custom") return chooseManual(env, chatId);
    if (data.startsWith("user_template:")) return chooseUserTemplate(env, chatId, data.split(":")[1]);
    if (data.startsWith("speed:")) return setSpeed(env, chatId, Number(data.split(":")[1]));
    if (data.startsWith("darkness:")) return setDarkness(env, chatId, data.split(":")[1] as Darkness);
    if (data.startsWith("vignette:")) return setVignette(env, chatId, data.split(":")[1] as Vignette);
    if (data.startsWith("order:")) return setOrder(env, chatId, data.split(":")[1] as OrderMode);
    if (data.startsWith("effect:")) return setEffect(env, chatId, data.split(":")[1] as Effect);
    if (data.startsWith("format:")) return setFormat(env, chatId, data.split(":")[1] as VideoFormat);
    if (data === "render") return startRender(env, chatId);
    if (data === "save_my_template") return askUserTemplateName(env, chatId);
    return;
  }
  const message = update.message; if (!message) return;
  const chatId = message.chat.id; const userId = message.from?.id || chatId;
  if (message.text && await handleAdminCommand(env, chatId, userId, message.text)) return;
  if (message.text === "/start") {
    const limit = await checkDailyLimit(env, userId);
    return sendMessage(env, chatId, `Привіт! Я створюю слайд-шоу без watermark. Доступно <b>5 відео на день</b>.\nСьогодні залишилося: <b>${limit.left}</b>.`, createKeyboard);
  }
  if (message.photo?.length) return acceptPhoto(env, chatId, message.photo);
  if (message.text) {
    const session = await getSession(env, chatId); const value = Number(message.text.replace(",", "."));
    if (session?.step === "template_rename" && session.actionTemplateId) { await renameUserTemplate(env, chatId, session.actionTemplateId, message.text); await env.SESSIONS.delete(sessionKey(chatId)); return showTemplateMenu(env, chatId, session.actionTemplateId); }
    if (session?.step === "template_copy" && session.actionTemplateId) { await copyUserTemplate(env, chatId, session.actionTemplateId, message.text); await env.SESSIONS.delete(sessionKey(chatId)); return listUserTemplates(env, chatId); }
    if (session?.step === "admin_input" && isAdmin(env, userId)) return handleAdminInput(env, chatId, session, message.text);
    if (session?.step === "template_name") return saveUserTemplate(env, chatId, message.text);
    if (session?.step === "duration") return setDuration(env, chatId, value);
    if (session?.step === "speed") return setSpeed(env, chatId, value);
  }
  await sendMessage(env, chatId, "Скористайся кнопкою нижче.", createKeyboard);
}

async function sendVideo(env: Env, chatId: number, video: ArrayBuffer, duration: number) {
  const form = new FormData(); form.append("chat_id", String(chatId)); form.append("supports_streaming", "true");
  form.append("caption", `✅ Готово: ${duration} сек`);
  form.append("video", new Blob([video], { type: "video/mp4" }), "tiktok-creo.mp4");
  const response = await fetch(apiUrl(env, "sendVideo"), { method: "POST", body: form });
  const result = (await response.json()) as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || "Telegram sendVideo failed");
}
interface StoredRenderJob { job: RenderJob; token: string }
async function dispatchGitHubRender(env: Env, jobId: string, jobToken: string) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/render.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "tiktok-creo-bot",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, job_token: jobToken, worker_url: env.WORKER_BASE_URL } }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 500)}`);
}
async function loadRenderJob(env: Env, jobId: string, token: string | null) {
  if (!token) return null;
  const stored = await env.SESSIONS.get<StoredRenderJob>(`render-job:${jobId}`, "json");
  if (!stored || stored.token !== token) return null;
  return stored;
}
async function decrementPending(env: Env) {
  const pending = Math.max(0, Number((await env.SESSIONS.get("queue:pending")) || 1) - 1);
  await env.SESSIONS.put("queue:pending", String(pending));
}
async function failRender(env: Env, job: RenderJob, detail: string) {
  const state = await env.SESSIONS.get<{status:string}>(`job:${job.jobId}`, "json");
  if (state?.status === "failed" || state?.status === "done") return;
  await Promise.all([
    decrementPending(env), removeImages(env, job.imageKeys), env.SESSIONS.delete(sessionKey(job.chatId)),
    env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(`render-job:${job.jobId}`),
    refundDailyLimit(env, job.dailyCounterKey),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "failed", chatId: job.chatId }), { expirationTtl: 86400 }),
    incMetric(env, "failed"), incDailyMetric(env, "failed"), recordError(env, "github_render", detail),
  ]);
  await Promise.all([
    editMessage(env, job.chatId, job.statusMessageId, "❌ <b>Не вдалося створити відео. Ліміт повернуто.</b>"),
    sendMessage(env, job.chatId, "Спробуй ще раз трохи пізніше 👇", createKeyboard),
    alertAdmins(env, `Рендер ${job.jobId} завершився помилкою: ${detail}`),
  ]);
}
async function completeRender(env: Env, stored: StoredRenderJob, request: Request) {
  const { job } = stored;
  const state = await env.SESSIONS.get<{status:string}>(`job:${job.jobId}`, "json");
  if (state?.status === "cancelled") {
    await Promise.all([decrementPending(env), removeImages(env, job.imageKeys), refundDailyLimit(env, job.dailyCounterKey), env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(sessionKey(job.chatId)), env.SESSIONS.delete(`render-job:${job.jobId}`)]);
    await editMessage(env, job.chatId, job.statusMessageId, "❌ <b>Створення скасовано. Ліміт повернуто.</b>");
    return json({ ok: true, cancelled: true });
  }
  if (!request.body) return json({ error: "empty video" }, 400);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 50 * 1024 * 1024) return json({ error: "video too large" }, 413);
  const outputKey = `outputs/${job.chatId}/${job.jobId}.mp4`;
  await env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "uploading", chatId: job.chatId }), { expirationTtl: 86400 });
  await editMessage(env, job.chatId, job.statusMessageId, "📤 <b>Надсилання відео…</b>");
  await env.MEDIA.put(outputKey, request.body, { httpMetadata: { contentType: "video/mp4" } });
  const object = await env.MEDIA.get(outputKey); if (!object) throw new Error("Rendered video missing in R2");
  const video = await object.arrayBuffer();
  await sendVideo(env, job.chatId, video, job.duration);
  const renderMs = Date.now() - job.queuedAt;
  await Promise.all([
    decrementPending(env), removeImages(env, job.imageKeys), env.SESSIONS.delete(sessionKey(job.chatId)),
    env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(`render-job:${job.jobId}`),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "done", chatId: job.chatId }), { expirationTtl: 86400 }),
    incMetric(env, "completed"), incMetric(env, "rendered_seconds", job.duration), incMetric(env, "render_ms", renderMs),
    incMetric(env, "output_bytes", video.byteLength), incDailyMetric(env, "completed"), incDailyMetric(env, "render_ms", renderMs),
    incDailyMetric(env, "output_bytes", video.byteLength),
  ]);
  await editMessage(env, job.chatId, job.statusMessageId, "✅ <b>Готово</b>");
  await sendMessage(env, job.chatId, "Можеш створити наступне відео 👇", createKeyboard);
  return json({ ok: true });
}

async function cleanupStorage(env: Env) {
  const now = Date.now(); let cursor: string | undefined; let totalBytes = 0; let deleted = 0;
  do {
    const page = await env.MEDIA.list({ cursor, limit: 1000 });
    const expired = page.objects.filter((o) => {
      totalBytes += o.size;
      const ttl = o.key.startsWith("outputs/") ? OUTPUT_TTL_MS : UPLOAD_TTL_MS;
      return now - o.uploaded.getTime() > ttl;
    });
    if (expired.length) { await env.MEDIA.delete(expired.map((o) => o.key)); deleted += expired.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await Promise.all([env.SESSIONS.put("storage:last_bytes", String(totalBytes)), env.SESSIONS.put("storage:last_cleanup", new Date().toISOString())]);
  if (totalBytes >= STORAGE_ALERT_BYTES) await alertAdmins(env, `R2 займає приблизно ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} ГБ. Видалено прострочених файлів: ${deleted}.`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      const update = (await request.json()) as TelegramUpdate;
      ctx.waitUntil(handleUpdate(env, update).catch(async (error) => { console.error("Update failed", error); await recordError(env, "telegram_update", error); }));
      return json({ ok: true });
    }
    const match = url.pathname.match(/^\/github\/render\/([0-9a-f-]+)\/(job|image\/([0-9]+)|complete|failed)$/);
    if (match) {
      const [, jobId, action, imageIndex] = match;
      const token = request.headers.get("X-Render-Token") || url.searchParams.get("token");
      const stored = await loadRenderJob(env, jobId, token);
      if (!stored) return json({ error: "unauthorized" }, 401);
      if (action === "job" && request.method === "GET") {
        await env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "rendering", chatId: stored.job.chatId }), { expirationTtl: 86400 });
        await editMessage(env, stored.job.chatId, stored.job.statusMessageId, "🎬 <b>Рендер відео через GitHub Actions…</b>");
        return json({ ...stored.job, imageCount: stored.job.imageKeys.length, imageKeys: undefined, dailyCounterKey: undefined });
      }
      if (action.startsWith("image/") && request.method === "GET") {
        const index = Number(imageIndex); const key = stored.job.imageKeys[index];
        if (!key) return json({ error: "image not found" }, 404);
        const object = await env.MEDIA.get(key); if (!object) return json({ error: "image missing" }, 404);
        return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "image/jpeg" } });
      }
      if (action === "complete" && request.method === "POST") {
        try { return await completeRender(env, stored, request); }
        catch (error) { await failRender(env, stored.job, String(error)); return json({ error: "completion failed" }, 500); }
      }
      if (action === "failed" && request.method === "POST") {
        const body = await request.text(); await failRender(env, stored.job, body.slice(0, 1000)); return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }
    return new Response("TikTok Creo Bot is running", { status: 200 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupStorage(env);
  },
} satisfies ExportedHandler<Env, RenderJob>;
