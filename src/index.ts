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

type Step = "photos" | "template" | "duration" | "speed" | "darkness" | "vignette" | "order" | "transition" | "motion" | "effect" | "format" | "confirm" | "template_name" | "template_rename" | "template_copy" | "promo_input" | "feedback_input" | "admin_input" | "rendering";
type Darkness = "none" | "light" | "standard" | "strong";
type Vignette = "none" | "light" | "standard" | "strong";
type OrderMode = "original" | "shuffle_once" | "random_no_repeat";
type VideoFormat = "vertical" | "portrait" | "square" | "horizontal";
type Effect = "none" | "zoom" | "flash" | "glitch";
type Transition = "cut" | "smooth" | "motion_blur" | "flash";
type Motion = "none" | "zoom_in" | "pan_left" | "pan_right";
type TemplateName = string;

interface Session {
  step: Step;
  imageKeys: string[];
  duration?: number;
  interval?: number;
  darkness?: Darkness;
  vignette?: Vignette;
  orderMode?: OrderMode;
  transition?: Transition;
  motion?: Motion;
  format?: VideoFormat;
  effect?: Effect;
  templateName?: TemplateName;
  templatePreset?: boolean;
  quickMode?: boolean;
  batchCount?: number;
  actionTemplateId?: string;
  feedbackJobId?: string;
  adminAction?: "limit" | "reset_limit" | "block" | "unblock" | "broadcast" | "premium" | "promo" | "user_search";
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
  transition: Transition;
  motion: Motion;
  format: VideoFormat;
  effect: Effect;
  templateName: TemplateName;
  statusMessageId: number;
  dailyCounterKey?: string;
  queuedAt: number;
  priority?: boolean;
  retryCount?: number;
}
interface QueueMeta { chatId: number; statusMessageId: number; language: Language; lastPosition?: number }
interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
interface TelegramUpdate {
  update_id?: number;
  message?: {
    chat: { id: number };
    from?: TgUser;
    text?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    media_group_id?: string;
    successful_payment?: { invoice_payload: string; currency: string; total_amount: number };
  };
  pre_checkout_query?: { id: string; from: TgUser; invoice_payload: string; currency: string; total_amount: number };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { chat: { id: number } };
  };
}
interface StoredUser extends TgUser { lastSeen: string; blocked?: boolean; referrerId?: number; referralQualified?: boolean }
interface SavedSettings {
  duration: number; interval: number; darkness: Darkness; vignette: Vignette;
  orderMode: OrderMode; transition: Transition; motion: Motion; format: VideoFormat; effect: Effect; templateName: TemplateName;
}
interface UserTemplate { id: string; ownerId: number; name: string; settings: SavedSettings; createdAt: string }
interface LimitBoost { amount: number; expiresAt: number; source: string }
interface PromoCode { code: string; type: "videos" | "premium"; value: number; maxUses: number; usedBy: number[] }

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});
const sessionKey = (chatId: number) => `session:${chatId}`;
const userKey = (userId: number) => `user:${userId}`;
const metricKey = (name: string) => `metric:${name}`;
const kyivDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dailyKey = (userId: number) => `daily:${userId}:${kyivDate()}`;
const lastSettingsKey = (userId: number) => `last-settings:${userId}`;
const DAILY_LIMIT = 10;
const PREMIUM_STARS = 100;
const PREMIUM_DAYS = 30;
const SUPPORTER_DAILY_BONUS = 2;
const BOT_USERNAME = "avto_creo_bot";
const RATE_LIMIT_PER_MINUTE = 60;
const OUTPUT_TTL_MS = 60 * 60 * 1000;
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const QUEUE_ALERT_THRESHOLD = 20;
const MAX_CONCURRENT_RENDERS = 2;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const STORAGE_ALERT_BYTES = 5 * 1024 * 1024 * 1024;
const apiUrl = (env: Env, method: string) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isAdmin = (env: Env, userId: number) => (env.ADMIN_TELEGRAM_IDS || "").split(",").map((x) => x.trim()).includes(String(userId));
type Language = "ru" | "uk" | "en";
const languageKey = (userId: number) => `language:${userId}`;
const languageCache = new Map<number, { value: Language; expiresAt: number }>();
const rateCache = new Map<string, number>();
const userSeenCache = new Map<number, number>();
const blockedCache = new Map<number, { value: boolean; expiresAt: number }>();
const recentUpdateIds = new Map<number, number>();
async function getLanguage(env: Env, userId: number): Promise<Language> {
  const cached = languageCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const saved = await env.SESSIONS.get(languageKey(userId));
  const value = saved === "uk" || saved === "en" || saved === "ru" ? saved : "ru";
  languageCache.set(userId, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
  return value;
}

const RU_REPLACEMENTS: Array<[string, string]> = [
  ["Створити декілька відео", "Создать несколько видео"],
  ["Створити одне відео", "Создать одно видео"],
  ["Реферальна програма", "Реферальная программа"],
  ["Видалити мої дані", "Удалить мои данные"],
  ["Зберегти як мій шаблон", "Сохранить как мой шаблон"],
  ["Повідомити про проблему", "Сообщить о проблеме"],
  ["Випадково без повтору підряд", "Случайно без повтора подряд"],
  ["Перемішати один раз", "Перемешать один раз"],
  ["Обери один зі своїх приватних шаблонів або налаштуй відео вручну:", "Выбери один из своих приватных шаблонов или настрой видео вручную:"],
  ["Надішли одним або кількома альбомами", "Отправь одним или несколькими альбомами"],
  ["З них буде створено", "Из них будет создано"],
  ["різних відео", "разных видео"],
  ["Сьогодні залишилося відео", "Сегодня осталось видео"],
  ["Сьогодні залишилося", "Сегодня осталось"],
  ["Залишилося сьогодні", "Осталось сегодня"],
  ["Безкоштовно доступно", "Бесплатно доступно"],
  ["Денний ліміт вичерпано", "Дневной лимит исчерпан"],
  ["Потрібно щонайменше", "Нужно как минимум"],
  ["доступних генерацій", "доступных генераций"],
  ["Зараз залишилося", "Сейчас осталось"],
  ["Недостатньо генерацій", "Недостаточно генераций"],
  ["У тебе вже є активна генерація", "У тебя уже есть активная генерация"],
  ["Фото не знайдено", "Фото не найдены"],
  ["Знайдено", "Найдено"],
  ["Потрібно ще мінімум", "Нужно ещё минимум"],
  ["Можна переходити далі", "Можно переходить дальше"],
  ["Фото прийнято", "Фото принято"],
  ["Уже є максимум", "Уже загружен максимум"],
  ["Це фото завелике", "Это фото слишком большое"],
  ["Спочатку натисни", "Сначала нажми"],
  ["Створити слайд-шоу", "Создать слайд-шоу"],
  ["Коли завершиш — натисни", "Когда закончишь — нажми"],
  ["Надішли", "Отправь"],
  ["Обери швидкість зміни фото", "Выбери скорость смены фото"],
  ["Обери силу затемнення", "Выбери силу затемнения"],
  ["Обери силу віньєтки", "Выбери силу виньетки"],
  ["Обери порядок фотографій", "Выбери порядок фотографий"],
  ["Обери перехід між фотографіями", "Выбери переход между фотографиями"],
  ["Обери рух фотографій", "Выбери движение фотографий"],
  ["Обери додатковий ефект", "Выбери дополнительный эффект"],
  ["Обери тривалість", "Выбери длительность"],
  ["Обери формат відео", "Выбери формат видео"],
  ["Обери шаблон", "Выбери шаблон"],
  ["Обери нове значення", "Выбери новое значение"],
  ["Обери віньєтку", "Выбери виньетку"],
  ["Обери затемнення", "Выбери затемнение"],
  ["Обери швидкість", "Выбери скорость"],
  ["Обери перехід", "Выбери переход"],
  ["Обери порядок", "Выбери порядок"],
  ["Обери ефект", "Выбери эффект"],
  ["Обери рух", "Выбери движение"],
  ["Обери", "Выбери"],
  ["Перевір налаштування", "Проверь настройки"],
  ["Кількість відео", "Количество видео"],
  ["Тривалість", "Длительность"],
  ["Швидкість", "Скорость"],
  ["Затемнення", "Затемнение"],
  ["Віньєтка", "Виньетка"],
  ["Порядок", "Порядок"],
  ["Перехід", "Переход"],
  ["Рух", "Движение"],
  ["без затемнення", "без затемнения"],
  ["слабке", "слабое"],
  ["стандартне", "стандартное"],
  ["сильне", "сильное"],
  ["без віньєтки", "без виньетки"],
  ["легка", "лёгкая"],
  ["стандартна", "стандартная"],
  ["сильна", "сильная"],
  ["як завантажено", "как загружено"],
  ["перемішано", "перемешано"],
  ["випадково без повтору", "случайно без повтора"],
  ["різка", "резкая"],
  ["плавна", "плавная"],
  ["спалах", "вспышка"],
  ["без руху", "без движения"],
  ["наближення", "приближение"],
  ["рух вліво", "движение влево"],
  ["рух вправо", "движение вправо"],
  ["без ефекту", "без эффекта"],
  ["Без затемнення", "Без затемнения"],
  ["Без віньєтки", "Без виньетки"],
  ["Без руху", "Без движения"],
  ["Без додаткового ефекту", "Без дополнительного эффекта"],
  ["Слабке", "Слабое"], ["Стандартне", "Стандартное"], ["Сильне", "Сильное"],
  ["Легка", "Лёгкая"], ["Стандартна", "Стандартная"], ["Сильна", "Сильная"],
  ["Як завантажено", "Как загружено"],
  ["Різка зміна", "Резкая смена"], ["Плавна", "Плавная"], ["Спалах", "Вспышка"],
  ["Наближення", "Приближение"], ["Рух вліво", "Движение влево"], ["Рух вправо", "Движение вправо"],
  ["Головне меню", "Главное меню"],
  ["Мої шаблони", "Мои шаблоны"], ["Мій профіль", "Мой профиль"], ["Допомога", "Помощь"],
  ["Почати заново", "Начать заново"], ["Створити відео", "Создать видео"],
  ["Створити вручну", "Настроить вручную"], ["Створити нове відео", "Создать новое видео"],
  ["Скасувати", "Отмена"], ["Скасовано", "Отменено"], ["Назад", "Назад"], ["Далі", "Далее"],
  ["Так, видалити", "Да, удалить"], ["Точно видалити шаблон", "Точно удалить шаблон"],
  ["Видалити", "Удалить"], ["Копіювати", "Копировать"], ["Перейменувати", "Переименовать"],
  ["Редагувати", "Редактировать"], ["Використати", "Использовать"], ["До шаблонів", "К шаблонам"],
  ["Мої приватні шаблони", "Мои приватные шаблоны"], ["У тебе ще немає шаблонів", "У тебя ещё нет шаблонов"],
  ["Шаблон не знайдено", "Шаблон не найден"], ["Власний", "Свой"],
  ["Працюю", "Работаю"], ["Надсилаю", "Отправляю"], ["Готово", "Готово"],
  ["Можеш створити наступне відео", "Можешь создать следующее видео"],
  ["Не вдалося створити відео. Ліміт повернуто", "Не удалось создать видео. Лимит возвращён"],
  ["Спробуй ще раз трохи пізніше", "Попробуй ещё раз немного позже"],
  ["Створення скасовано. Ліміт повернуто", "Создание отменено. Лимит возвращён"],
  ["Скасування прийнято. Файли буде видалено", "Отмена принята. Файлы будут удалены"],
  ["Це завдання вже завершене", "Это задание уже завершено"],
  ["Дякую за оцінку", "Спасибо за оценку"],
  ["Дякую. Можеш також описати проблему кнопкою нижче", "Спасибо. Можешь также описать проблему кнопкой ниже"],
  ["Скористайся кнопкою нижче", "Используй кнопку ниже"],
  ["Привіт! Я створюю", "Привет! Я создаю"], ["без watermark", "без водяного знака"],
  ["відео на день", "видео в день"], ["безліміт", "безлимит"],
  ["Активних бонусів", "Активных бонусов"], ["Твоє посилання", "Твоя ссылка"],
  ["Запроси друга", "Пригласи друга"], ["Коли він створить перше відео", "Когда он создаст первое видео"],
  ["ти отримаєш", "ты получишь"], ["щодня на 30 днів", "ежедневно на 30 дней"],
  ["Приватних шаблонів", "Приватных шаблонов"], ["Купити безліміт", "Купить безлимит"],
  ["Подякувати автору", "Поддержать автора"], ["Подяка автору", "Спасибо автору"], ["Підтримка автора", "Поддержка автора"],
  ["Пріоритетна черга", "Приоритетная очередь"], ["до 12 відео на день", "до 12 видео в день"],
  ["Активовано статус підтримки", "Активирован статус поддержки"], ["пріоритетна черга", "приоритетная очередь"],
  ["Дякую за підтримку", "Спасибо за поддержку"], ["доступно +2 відео на день", "доступно +2 видео в день"],
  ["Швидке створення", "Быстрое создание"], ["Очікує в черзі", "Ожидает в очереди"],
  ["Твоє місце", "Твоё место"], ["Завантажую фото", "Загружаю фото"], ["Створюю відео", "Создаю видео"],
  ["Запускаю рендер", "Запускаю рендер"],
  ["Рендер затримався", "Рендер задерживается"], ["працює і не завис", "работает и не завис"],
  ["Реферальна статистика", "Реферальная статистика"], ["Переходів", "Переходов"], ["Активували бонус", "Активировали бонус"],
  ["Одне відео", "Одно видео"], ["Декілька відео", "Несколько видео"],
  ["завантаж", "загрузи"], ["Безкоштовно", "Бесплатно"],
  ["Усі функції доступні кнопками", "Все функции доступны кнопками"],
  ["Забагато дій. Спробуй через хвилину", "Слишком много действий. Попробуй через минуту"],
  ["Бот тимчасово оновлюється. Спробуй пізніше", "Бот временно обновляется. Попробуй позже"],
  ["Мова", "Язык"],
];

const EN_REPLACEMENTS: Array<[string, string]> = [
  ["Створити декілька відео", "Create multiple videos"], ["Створити одне відео", "Create one video"],
  ["Реферальна програма", "Referral program"], ["Видалити мої дані", "Delete my data"],
  ["Зберегти як мій шаблон", "Save as my template"], ["Повідомити про проблему", "Report a problem"],
  ["Випадково без повтору підряд", "Random without consecutive repeats"], ["Перемішати один раз", "Shuffle once"],
  ["Сьогодні залишилося відео", "Videos left today"], ["Сьогодні залишилося", "Left today"],
  ["Залишилося сьогодні", "Left today"], ["Безкоштовно доступно", "Available for free"],
  ["Денний ліміт вичерпано", "Daily limit reached"], ["Потрібно щонайменше", "At least"],
  ["Недостатньо генерацій", "Not enough generations"], ["У тебе вже є активна генерація", "You already have an active generation"],
  ["Фото не знайдено", "Photos not found"], ["Фото прийнято", "Photos accepted"],
  ["Потрібно ще мінімум", "Still needed"], ["Можна переходити далі", "You can continue"],
  ["Спочатку натисни", "First press"], ["Коли завершиш — натисни", "When finished, press"], ["Надішли", "Send"],
  ["Обери швидкість зміни фото", "Choose the photo change speed"], ["Обери силу затемнення", "Choose darkening strength"],
  ["Обери силу віньєтки", "Choose vignette strength"], ["Обери порядок фотографій", "Choose photo order"],
  ["Обери перехід між фотографіями", "Choose a transition"], ["Обери рух фотографій", "Choose photo motion"],
  ["Обери додатковий ефект", "Choose an additional effect"], ["Обери тривалість", "Choose duration"],
  ["Обери формат відео", "Choose video format"], ["Обери нове значення", "Choose a new value"],
  ["Обери шаблон", "Choose a template"], ["Обери", "Choose"],
  ["Перевір налаштування", "Check settings"], ["Кількість відео", "Number of videos"],
  ["Тривалість", "Duration"], ["Швидкість", "Speed"], ["Затемнення", "Darkening"],
  ["Віньєтка", "Vignette"], ["Порядок", "Order"], ["Перехід", "Transition"], ["Рух", "Motion"],
  ["Без затемнення", "No darkening"], ["Без віньєтки", "No vignette"], ["Без руху", "No motion"],
  ["Без додаткового ефекту", "No additional effect"], ["Слабке", "Light"], ["Стандартне", "Standard"],
  ["Сильне", "Strong"], ["Легка", "Light"], ["Стандартна", "Standard"], ["Сильна", "Strong"],
  ["Як завантажено", "As uploaded"], ["Різка зміна", "Cut"], ["Плавна", "Smooth"], ["Спалах", "Flash"],
  ["Наближення", "Zoom in"], ["Рух вліво", "Move left"], ["Рух вправо", "Move right"],
  ["Головне меню", "Main menu"], ["Мої шаблони", "My templates"], ["Мій профіль", "My profile"],
  ["Допомога", "Help"], ["Почати заново", "Start over"], ["Створити відео", "Create video"],
  ["Створити вручну", "Set up manually"], ["Створити нове відео", "Create a new video"],
  ["Скасувати", "Cancel"], ["Скасовано", "Cancelled"], ["Назад", "Back"], ["Далі", "Next"],
  ["Так, видалити", "Yes, delete"], ["Видалити", "Delete"], ["Копіювати", "Copy"],
  ["Перейменувати", "Rename"], ["Редагувати", "Edit"], ["Використати", "Use"],
  ["Працюю", "Working"], ["Надсилаю", "Sending"], ["Готово", "Done"],
  ["Можеш створити наступне відео", "You can create the next video"],
  ["Спробуй ще раз трохи пізніше", "Please try again later"], ["Скористайся кнопкою нижче", "Use the button below"],
  ["Привіт! Я створюю", "Hi! I create"], ["відео на день", "videos per day"], ["безліміт", "unlimited"],
  ["Активних бонусів", "Active bonuses"], ["Твоє посилання", "Your link"],
  ["Запроси друга", "Invite a friend"], ["Коли він створить перше відео", "When they create their first video"],
  ["ти отримаєш", "you will receive"], ["щодня на 30 днів", "daily for 30 days"],
  ["Приватних шаблонів", "Private templates"], ["Купити безліміт", "Buy unlimited"],
  ["Подякувати автору", "Support the creator"], ["Подяка автору", "Thank the creator"], ["Підтримка автора", "Creator support"],
  ["Пріоритетна черга", "Priority queue"], ["до 12 відео на день", "up to 12 videos per day"],
  ["Активовано статус підтримки", "Supporter status activated"], ["пріоритетна черга", "priority queue"],
  ["Дякую за підтримку", "Thank you for your support"], ["доступно +2 відео на день", "+2 videos per day are available"],
  ["Швидке створення", "Quick create"], ["Очікує в черзі", "Waiting in queue"],
  ["Твоє місце", "Your position"], ["Завантажую фото", "Downloading photos"], ["Створюю відео", "Creating video"],
  ["Запускаю рендер", "Starting render"],
  ["Рендер затримався", "The render is delayed"], ["працює і не завис", "is working and has not frozen"],
  ["Реферальна статистика", "Referral statistics"], ["Переходів", "Visits"], ["Активували бонус", "Activated bonus"],
  ["Одне відео", "One video"], ["Декілька відео", "Multiple videos"], ["завантаж", "upload"],
  ["Безкоштовно", "Free"], ["Усі функції доступні кнопками", "All features are available through buttons"],
  ["Забагато дій. Спробуй через хвилину", "Too many actions. Try again in a minute"],
  ["Бот тимчасово оновлюється. Спробуй пізніше", "The bot is being updated. Try again later"],
  ["Мова", "Language"], ["сек", "sec"],
];

function localizeText(text: string, language: Language) {
  if (language === "uk") return text;
  const replacements = language === "ru" ? RU_REPLACEMENTS : EN_REPLACEMENTS;
  return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}
function localizeMarkup(markup: unknown, language: Language): unknown {
  if (!markup || typeof markup !== "object") return markup;
  if (Array.isArray(markup)) return markup.map((item) => localizeMarkup(item, language));
  const localized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(markup as Record<string, unknown>)) {
    localized[key] = key === "text" && typeof value === "string" ? localizeText(value, language) : localizeMarkup(value, language);
  }
  return localized;
}

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
  const language = await getLanguage(env, chatId);
  return telegram(env, "sendMessage", {
    chat_id: chatId, text: localizeText(text, language), parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: localizeMarkup(replyMarkup, language) } : {}),
  });
}
async function editMessage(env: Env, chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  const language = await getLanguage(env, chatId);
  return telegram(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: localizeText(text, language), parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: localizeMarkup(replyMarkup, language) } : {}),
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
  const used = rateCache.get(key) || 0;
  if (used >= RATE_LIMIT_PER_MINUTE) return false;
  rateCache.set(key, used + 1);
  if (rateCache.size > 5000) {
    const oldestMinute = minute - 2;
    for (const cachedKey of rateCache.keys()) {
      const cachedMinute = Number(cachedKey.split(":").pop());
      if (cachedMinute < oldestMinute) rateCache.delete(cachedKey);
    }
  }
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
  if (list[0]?.where === item.where && list[0]?.message === item.message && Date.now() - Date.parse(list[0].at) < 10 * 60 * 1000) return;
  list.unshift(item);
  await env.SESSIONS.put("admin:errors", JSON.stringify(list.slice(0, 20)));
}
async function registerUser(env: Env, user?: TgUser) {
  if (!user) return;
  const now = Date.now();
  if (now - (userSeenCache.get(user.id) || 0) < 6 * 60 * 60 * 1000) return;
  const key = userKey(user.id);
  const existing = await env.SESSIONS.get<StoredUser>(key, "json");
  userSeenCache.set(user.id, now);
  blockedCache.set(user.id, { value: Boolean(existing?.blocked), expiresAt: now + 30 * 60 * 1000 });
  if (existing && now - new Date(existing.lastSeen).getTime() < 6 * 60 * 60 * 1000) return;
  const saved: StoredUser = { ...existing, ...user, lastSeen: new Date().toISOString(), blocked: existing?.blocked || false };
  await env.SESSIONS.put(key, JSON.stringify(saved));
  if (!existing) {
    await incMetric(env, "total_users");
    const recent = ((await env.SESSIONS.get("admin:recent_users", "json")) as number[] | null) || [];
    await env.SESSIONS.put("admin:recent_users", JSON.stringify([user.id, ...recent.filter((id) => id !== user.id)].slice(0, 50)));
  }
}
async function isBlocked(env: Env, userId: number) {
  const cached = blockedCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const user = await env.SESSIONS.get<StoredUser>(userKey(userId), "json");
  const value = Boolean(user?.blocked);
  blockedCache.set(userId, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
  return value;
}

const createKeyboard = { inline_keyboard: [
  [{ text: "🎞 Створити одне відео", callback_data: "create" }],
  [{ text: "⚡ Швидке створення", callback_data: "quick_create" }],
  [{ text: "🎬 Створити декілька відео", callback_data: "batch_create" }],
  [{ text: "❤️ Подякувати автору — 100 Stars", callback_data: "buy_premium" }],
  [{ text: "🎁 Реферальна програма", callback_data: "referral" }, { text: "🎟 Промокод", callback_data: "promo" }],
  [{ text: "📁 Мої шаблони", callback_data: "my_templates" }],
  [{ text: "👤 Мій профіль", callback_data: "profile" }, { text: "ℹ️ Допомога", callback_data: "help" }],
  [{ text: "🌐 Мова", callback_data: "language_menu" }],
  [{ text: "🗑 Видалити мої дані", callback_data: "delete_my_data" }],
] };
const languageKeyboard = { inline_keyboard: [
  [{ text: "Русский", callback_data: "language:ru" }],
  [{ text: "Українська", callback_data: "language:uk" }],
  [{ text: "English", callback_data: "language:en" }],
  [{ text: "⬅️ Головне меню", callback_data: "main_menu" }],
] };
const batchCountKeyboard = { inline_keyboard: [
  [3, 4].map((n) => ({ text: `${n} відео`, callback_data: `batch_count:${n}` })),
  [5, 6].map((n) => ({ text: `${n} відео`, callback_data: `batch_count:${n}` })),
  [{ text: "⬅️ Головне меню", callback_data: "main_menu" }],
] };
const photosKeyboard = { inline_keyboard: [
  [{ text: "✅ Далі", callback_data: "photos_done" }],
  [{ text: "🗑 Почати заново", callback_data: "photos_restart" }],
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
const transitionKeyboard = { inline_keyboard: [
  [{ text: "⚡ Різка зміна", callback_data: "transition:cut" }, { text: "🌫 Плавна", callback_data: "transition:smooth" }],
  [{ text: "💨 Motion blur", callback_data: "transition:motion_blur" }, { text: "✨ Спалах", callback_data: "transition:flash" }],
  [{ text: "⬅️ Назад", callback_data: "back" }],
] };
const motionKeyboard = { inline_keyboard: [
  [{ text: "Без руху", callback_data: "motion:none" }, { text: "🔍 Наближення", callback_data: "motion:zoom_in" }],
  [{ text: "⬅️ Рух вліво", callback_data: "motion:pan_left" }, { text: "➡️ Рух вправо", callback_data: "motion:pan_right" }],
  [{ text: "⬅️ Назад", callback_data: "back" }],
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
  [{ text: "🔎 Знайти користувача", callback_data: "admin:user_search" }, { text: "🩺 Стан бота", callback_data: "admin:system" }],
  [{ text: "🔐 Безпека", callback_data: "admin:security" }],
  [{ text: "⚠️ Помилки", callback_data: "admin:errors" }, { text: "🧹 Очистити", callback_data: "admin:clear_errors" }],
  [{ text: "🔧 Технічні роботи", callback_data: "admin:maintenance" }],
  [{ text: "🎚 Встановити ліміт", callback_data: "admin:limit" }, { text: "♻️ Скинути ліміт", callback_data: "admin:reset_limit" }],
  [{ text: "🚫 Заблокувати", callback_data: "admin:block" }, { text: "✅ Розблокувати", callback_data: "admin:unblock" }],
  [{ text: "❤️ Видати статус підтримки", callback_data: "admin:premium" }, { text: "🎟 Створити промокод", callback_data: "admin:promo" }],
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
  return (await listAllUploadKeys(env, chatId)).slice(0, 30);
}
async function resolveImageKeys(env: Env, chatId: number, session: Session) {
  const listed = await listUploadKeys(env, chatId);
  const candidates = [...new Set([...listed, ...session.imageKeys])].slice(0, 30);
  const existing = await Promise.all(candidates.map(async (key) => await env.MEDIA.head(key) ? key : null));
  return existing.filter((key): key is string => Boolean(key));
}
async function removeAllUploadImages(env: Env, chatId: number) {
  await removeImages(env, await listAllUploadKeys(env, chatId));
}
async function dailyUsed(env: Env, userId: number) { return Number((await env.SESSIONS.get(dailyKey(userId))) || 0); }
async function premiumUntil(env: Env, userId: number) { return Number((await env.SESSIONS.get(`premium:${userId}`)) || 0); }
async function activeBoosts(env: Env, userId: number) {
  const boosts = ((await env.SESSIONS.get(`limit-boosts:${userId}`, "json")) as LimitBoost[] | null) || [];
  const active = boosts.filter((boost) => boost.expiresAt > Date.now());
  if (active.length !== boosts.length) await env.SESSIONS.put(`limit-boosts:${userId}`, JSON.stringify(active));
  return active;
}
async function checkDailyLimit(env: Env, userId: number) {
  const [used, premium, custom, boosts] = await Promise.all([
    dailyUsed(env, userId),
    premiumUntil(env, userId),
    env.SESSIONS.get(`limit:${userId}`),
    activeBoosts(env, userId),
  ]);
  const supporter = premium > Date.now();
  const boost = boosts.reduce((sum, item) => sum + item.amount, 0);
  const limit = (custom === null ? DAILY_LIMIT : Number(custom)) + boost + (supporter ? SUPPORTER_DAILY_BONUS : 0);
  return { allowed: used < limit, used, left: Math.max(0, limit - used), limit, premiumUntil: supporter ? premium : 0 };
}
async function grantPremium(env: Env, userId: number, days = PREMIUM_DAYS) {
  const current = await premiumUntil(env, userId);
  const base = Math.max(Date.now(), current);
  const until = base + days * 86400000;
  await env.SESSIONS.put(`premium:${userId}`, String(until));
  return until;
}
async function addLimitBoost(env: Env, userId: number, amount: number, days: number, source: string) {
  const boosts = await activeBoosts(env, userId);
  boosts.push({ amount, expiresAt: Date.now() + days * 86400000, source });
  await env.SESSIONS.put(`limit-boosts:${userId}`, JSON.stringify(boosts));
}
async function refundDailyLimit(env: Env, key?: string) {
  if (!key) return;
  const used = Number((await env.SESSIONS.get(key)) || 0);
  await env.SESSIONS.put(key, String(Math.max(0, used - 1)), { expirationTtl: 172800 });
}
async function consumeDailyLimit(env: Env, userId: number, count = 1) {
  const key = dailyKey(userId); const used = await dailyUsed(env, userId);
  await env.SESSIONS.put(key, String(used + count), { expirationTtl: 172800 });
}
const leftLabel = (limit: Awaited<ReturnType<typeof checkDailyLimit>>) => String(limit.left);
async function resetSession(env: Env, chatId: number) {
  const limit = await checkDailyLimit(env, chatId);
  if (!limit.allowed) return sendMessage(env, chatId, "⛔ Денний ліміт вичерпано. Безкоштовно доступно <b>10 відео на день</b>.");
  await removeAllUploadImages(env, chatId);
  await putSession(env, chatId, { step: "photos", imageKeys: [] });
  await sendMessage(env, chatId, `Надішли <b>4–10 фото</b>. Коли завершиш — натисни «Далі».
Сьогодні залишилося відео: <b>${leftLabel(limit)}</b>`, photosKeyboard);
}
async function startQuickCreation(env: Env, chatId: number) {
  const limit = await checkDailyLimit(env, chatId);
  if (!limit.allowed) return sendMessage(env, chatId, "⛔ Денний ліміт вичерпано.");
  const settings = await env.SESSIONS.get<SavedSettings>(lastSettingsKey(chatId), "json");
  if (!settings) return sendMessage(env, chatId, "Спочатку створи хоча б одне відео вручну. Після цього швидкий режим запам’ятає налаштування.", {
    inline_keyboard: [[{ text: "🎞 Створити перше відео", callback_data: "create" }], [{ text: "⬅️ Головне меню", callback_data: "main_menu" }]],
  });
  await removeAllUploadImages(env, chatId);
  await putSession(env, chatId, { ...settings, step: "photos", imageKeys: [], templatePreset: true, quickMode: true });
  await sendMessage(env, chatId, `⚡ <b>Швидке створення</b>\n\nНадішли 4–10 фото і натисни «Далі». Бот одразу запустить рендер з останніми налаштуваннями.\nЗалишилося сьогодні: <b>${limit.left}</b>.`, photosKeyboard);
}
async function resetBatchSession(env: Env, chatId: number, batchCount: number) {
  if (![3, 4, 5, 6].includes(batchCount)) return;
  const limit = await checkDailyLimit(env, chatId);
  if (limit.left < batchCount) return sendMessage(env, chatId, `Потрібно щонайменше <b>${batchCount}</b> доступних генерацій. Зараз залишилося: <b>${limit.left}</b>.`);
  await removeAllUploadImages(env, chatId);
  await putSession(env, chatId, { step: "photos", imageKeys: [], batchCount });
  await sendMessage(env, chatId, `Надішли одним або кількома альбомами <b>${batchCount * 4}–${batchCount * 5} фото</b>. З них буде створено <b>${batchCount} різних відео</b> по 4–5 фото.`, photosKeyboard);
}
async function downloadTelegramPhoto(env: Env, fileId: string) {
  const result = (await telegram(env, "getFile", { file_id: fileId })) as { file_path: string };
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${result.file_path}`);
  if (!response.ok) throw new Error("Не вдалося завантажити фото з Telegram");
  const ext = result.file_path.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "jpg";
  return { data: await response.arrayBuffer(), ext };
}
async function acceptPhoto(env: Env, chatId: number, photos: Array<{ file_id: string }>, mediaGroupId?: string) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "photos") return sendMessage(env, chatId, "Спочатку натисни «Створити слайд-шоу».", createKeyboard);
  const existingKeys = await listUploadKeys(env, chatId);
  const maxPhotos = session.batchCount ? session.batchCount * 5 : 10;
  const minPhotos = session.batchCount ? session.batchCount * 4 : 4;
  if (existingKeys.length >= maxPhotos) return sendMessage(env, chatId, `Уже є максимум ${maxPhotos} фото. Натисни «Далі».`, photosKeyboard);
  const { data, ext } = await downloadTelegramPhoto(env, photos[photos.length - 1].file_id);
  if (data.byteLength > 15 * 1024 * 1024) return sendMessage(env, chatId, "Це фото завелике. Максимум — 15 МБ.");
  const key = `uploads/${chatId}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, data, { httpMetadata: { contentType: `image/${ext === "jpg" ? "jpeg" : ext}` } });
  if (mediaGroupId) {
    const markerPrefix = `album-markers/${chatId}/${mediaGroupId}/`;
    const markerKey = `${markerPrefix}${crypto.randomUUID()}`;
    await env.MEDIA.put(markerKey, String(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const markers = await env.MEDIA.list({ prefix: markerPrefix, limit: 100 });
    const latest = [...markers.objects].sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime() || b.key.localeCompare(a.key))[0];
    if (!latest || latest.key !== markerKey) return;
    if (markers.objects.length) await env.MEDIA.delete(markers.objects.map((object) => object.key));
  }
  const keys = (await resolveImageKeys(env, chatId, session)).slice(0, maxPhotos);
  session.imageKeys = keys;
  await putSession(env, chatId, session);
  const count = keys.length;
  await sendMessage(env, chatId, `✅ Фото прийнято: <b>${count}/${maxPhotos}</b>${count < minPhotos ? `\nПотрібно ще мінімум ${minPhotos - count}.` : "\nМожна переходити далі."}`, photosKeyboard);
}
async function chooseCreationMode(env: Env, chatId: number) {
  const session = await getSession(env, chatId);
  if (!session) return sendMessage(env, chatId, "Спочатку натисни «Створити слайд-шоу».", createKeyboard);
  session.imageKeys = await resolveImageKeys(env, chatId, session);
  const minPhotos = session.batchCount ? session.batchCount * 4 : 4;
  if (session.imageKeys.length < minPhotos) return sendMessage(env, chatId, `Знайдено <b>${session.imageKeys.length}</b> фото. Потрібно щонайменше <b>${minPhotos}</b>.`, photosKeyboard);
  if (session.templatePreset) { session.transition ||= "cut"; session.motion ||= "none"; }
  if (session.templatePreset && session.duration && session.interval && session.darkness && session.vignette && session.orderMode && session.transition && session.motion && session.format && session.effect && session.templateName) {
    session.step = "confirm"; await putSession(env, chatId, session);
    if (session.quickMode) return startRender(env, chatId);
    return showConfirmation(env, chatId, session);
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
  session.orderMode = value; session.step = "transition"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери перехід між фотографіями:", transitionKeyboard);
}
async function setTransition(env: Env, chatId: number, value: Transition) {
  const session = await getSession(env, chatId); if (!session || session.step !== "transition") return;
  session.transition = value; session.step = "motion"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери рух фотографій:", motionKeyboard);
}
async function setMotion(env: Env, chatId: number, value: Motion) {
  const session = await getSession(env, chatId); if (!session || session.step !== "motion") return;
  session.motion = value; session.step = "effect"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Обери додатковий ефект:", effectKeyboard);
}
const labels = {
  darkness: { none: "без затемнення", light: "слабке", standard: "стандартне", strong: "сильне" },
  vignette: { none: "без віньєтки", light: "легка", standard: "стандартна", strong: "сильна" },
  order: { original: "як завантажено", shuffle_once: "перемішано", random_no_repeat: "випадково без повтору" },
  transition: { cut: "різка", smooth: "плавна", motion_blur: "motion blur", flash: "спалах" },
  motion: { none: "без руху", zoom_in: "наближення", pan_left: "рух вліво", pan_right: "рух вправо" },
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
  Object.assign(session, { transition: "cut", motion: "none" }, template.settings, { templateName: template.name, step: "confirm" });
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
  if (!session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.transition || !session.motion || !session.format || !session.templateName) return;
  await sendMessage(env, chatId, `<b>Перевір налаштування</b>\n\n${session.batchCount ? `Кількість відео: ${session.batchCount}\n` : ""}Шаблон: ${escapeHtml(session.templateName)}\nТривалість: ${session.duration} сек\nШвидкість: ${session.interval} сек\nЗатемнення: ${labels.darkness[session.darkness]}\nВіньєтка: ${labels.vignette[session.vignette]}\nПорядок: ${labels.order[session.orderMode]}\nПерехід: ${labels.transition[session.transition]}\nРух: ${labels.motion[session.motion]}\nФормат: ${labels.format[session.format]}\nWatermark: немає`, confirmKeyboard);
}
function shuffled<T>(values: T[]) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function splitBatchImages(keys: string[], count: number) {
  const pool = shuffled(keys); const groups = Array.from({ length: count }, () => [] as string[]);
  for (let i = 0; i < count * 4; i++) groups[i % count].push(pool[i]);
  for (let i = count * 4; i < Math.min(pool.length, count * 5); i++) groups[i - count * 4].push(pool[i]);
  return groups;
}
const renderQueueKey = (jobId: string, priority: boolean, queuedAt = Date.now()) =>
  `render-queue/${priority ? "0" : "1"}/${String(queuedAt).padStart(13, "0")}/${jobId}`;
const renderActiveKey = (jobId: string) => `render-active/${jobId}`;
async function enqueueRender(env: Env, job: RenderJob) {
  const meta: QueueMeta = { chatId: job.chatId, statusMessageId: job.statusMessageId, language: await getLanguage(env, job.chatId), lastPosition: 0 };
  await env.MEDIA.put(renderQueueKey(job.jobId, Boolean(job.priority), job.queuedAt), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
}
async function startRender(env: Env, chatId: number) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "confirm" || !session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.transition || !session.motion || !session.format || !session.effect || !session.templateName) return;
  session.imageKeys = await resolveImageKeys(env, chatId, session);
  const batchCount = session.batchCount || 1;
  const minPhotos = session.batchCount ? batchCount * 4 : 4;
  if (session.imageKeys.length < minPhotos) return sendMessage(env, chatId, `Фото не знайдено. Потрібно щонайменше ${minPhotos}.`, createKeyboard);
  const limit = await checkDailyLimit(env, chatId);
  if (limit.left < batchCount) return sendMessage(env, chatId, `⛔ Недостатньо генерацій. Потрібно <b>${batchCount}</b>, залишилося <b>${limit.left}</b>.`);
  if (await env.SESSIONS.get(`active-job:${chatId}`)) return sendMessage(env, chatId, "У тебе вже є активна генерація.");
  const groups = session.batchCount ? splitBatchImages(session.imageKeys, batchCount) : [session.imageKeys.slice(0, 10)];
  const pending = await actualPendingJobs(env) + groups.length;
  const priority = Boolean(limit.premiumUntil);
  const [completedCount, totalRenderMs] = await Promise.all([metric(env, "completed"), metric(env, "render_ms")]);
  const averageSeconds = completedCount ? Math.max(30, totalRenderMs / completedCount / 1000) : 90;
  const etaMinutes = Math.max(1, Math.ceil((priority ? averageSeconds : averageSeconds * Math.max(1, pending)) / 60));
  const settings: SavedSettings = { duration: session.duration, interval: session.interval, darkness: session.darkness, vignette: session.vignette, orderMode: session.orderMode, transition: session.transition, motion: session.motion, format: session.format, effect: session.effect, templateName: session.templateName };
  session.step = "rendering";
  await Promise.all([putSession(env, chatId, session), env.SESSIONS.put(lastSettingsKey(chatId), JSON.stringify(settings)), consumeDailyLimit(env, chatId, groups.length)]);
  const counterKey = dailyKey(chatId);
  const jobs: Array<{ job: RenderJob; token: string }> = [];
  for (let i = 0; i < groups.length; i++) {
    const jobId = crypto.randomUUID();
    const position = Math.max(1, pending - groups.length + i + 1);
    const status = await sendMessage(env, chatId, groups.length > 1 ? `⏳ <b>Очікує в черзі ${i + 1}/${groups.length}</b>\nТвоє місце: ${position}. Приблизно ${etaMinutes} хв.` : `⏳ <b>Очікує в черзі</b>\nТвоє місце: ${position}. Приблизно ${etaMinutes} хв.`, {
      inline_keyboard: [[{ text: "❌ Скасувати", callback_data: `cancel_job:${jobId}` }]],
    }) as { message_id: number };
    const job: RenderJob = { jobId, chatId, imageKeys: groups[i], duration: session.duration, interval: session.interval, darkness: session.darkness, vignette: session.vignette, orderMode: session.orderMode, transition: session.transition, motion: session.motion, format: session.format, effect: session.effect, templateName: session.templateName, statusMessageId: status.message_id, dailyCounterKey: counterKey, queuedAt: Date.now(), priority };
    jobs.push({ job, token: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "") });
  }
  await Promise.all([
    ...jobs.flatMap(({ job, token }) => [
      env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "queued", chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
      env.SESSIONS.put(`render-job:${job.jobId}`, JSON.stringify({ job, token }), { expirationTtl: 86400 }),
      enqueueRender(env, job),
    ]),
    env.SESSIONS.put(`active-job:${chatId}`, jobs[0].job.jobId, { expirationTtl: 3600 }),
  ]);
  await Promise.all([incMetric(env, "total_jobs", groups.length), incMetric(env, `format:${session.format}`, groups.length), incMetric(env, `user-jobs:${chatId}`, groups.length)]);
  if (pending >= QUEUE_ALERT_THRESHOLD) await alertAdmins(env, `Черга досягла ${pending} завдань.`);
}
async function askUserTemplateName(env: Env, chatId: number) {
  const session = await getSession(env, chatId); if (!session || session.step !== "confirm") return;
  session.step = "template_name"; await putSession(env, chatId, session);
  await sendMessage(env, chatId, "Надішли назву свого приватного шаблону, наприклад: <b>Мій темний</b>.");
}
async function saveUserTemplate(env: Env, chatId: number, name: string) {
  const session = await getSession(env, chatId);
  if (!session || session.step !== "template_name" || !session.duration || !session.interval || !session.darkness || !session.vignette || !session.orderMode || !session.transition || !session.motion || !session.format || !session.effect) return;
  const cleanName = name.trim().slice(0, 40); if (!cleanName) return sendMessage(env, chatId, "Назва не може бути порожньою.");
  const id = crypto.randomUUID().slice(0, 8); const indexKey = `user-templates:${chatId}:index`;
  const settings: SavedSettings = { duration: session.duration, interval: session.interval, darkness: session.darkness, vignette: session.vignette, orderMode: session.orderMode, transition: session.transition, motion: session.motion, format: session.format, effect: session.effect, templateName: cleanName };
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
    orderMode: ["original","shuffle_once","random_no_repeat"], transition: ["cut","smooth","motion_blur","flash"], motion: ["none","zoom_in","pan_left","pan_right"], effect: ["none","zoom","flash","glitch"],
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
  await putSession(env, chatId, { step: "photos", imageKeys: [], ...t.settings, transition: t.settings.transition || "cut", motion: t.settings.motion || "none", templatePreset: true });
  await sendMessage(env, chatId, `Шаблон <b>${escapeHtml(t.name)}</b> вибрано. Надішли 4–10 фото.`, photosKeyboard);
}
async function showTemplateEditor(env: Env, chatId: number, id: string) {
  await sendMessage(env, chatId, "Що змінити?", { inline_keyboard: [
    [{ text: "⏱ Тривалість", callback_data: `tplprop:${id}:duration` }, { text: "⚡ Швидкість", callback_data: `tplprop:${id}:interval` }],
    [{ text: "🌑 Затемнення", callback_data: `tplprop:${id}:darkness` }, { text: "⭕ Віньєтка", callback_data: `tplprop:${id}:vignette` }],
    [{ text: "🔀 Порядок", callback_data: `tplprop:${id}:orderMode` }, { text: "✨ Ефект", callback_data: `tplprop:${id}:effect` }],
    [{ text: "🔄 Перехід", callback_data: `tplprop:${id}:transition` }, { text: "🎥 Рух", callback_data: `tplprop:${id}:motion` }],
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
    transition: [["Різка","cut"],["Плавна","smooth"],["Motion blur","motion_blur"],["Спалах","flash"]],
    motion: [["Без руху","none"],["Наближення","zoom_in"],["Вліво","pan_left"],["Вправо","pan_right"]],
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
async function registerReferral(env: Env, userId: number, payload: string) {
  const match = payload.match(/^ref_(\d+)$/);
  if (!match) return;
  const referrerId = Number(match[1]);
  if (!referrerId || referrerId === userId) return;
  const user = await env.SESSIONS.get<StoredUser>(userKey(userId), "json");
  if (!user || user.referrerId || user.referralQualified) return;
  user.referrerId = referrerId;
  await Promise.all([env.SESSIONS.put(userKey(userId), JSON.stringify(user)), incMetric(env, `referral-clicks:${referrerId}`)]);
}
async function qualifyReferral(env: Env, userId: number) {
  const user = await env.SESSIONS.get<StoredUser>(userKey(userId), "json");
  if (!user?.referrerId || user.referralQualified) return;
  user.referralQualified = true;
  await Promise.all([
    env.SESSIONS.put(userKey(userId), JSON.stringify(user)),
    addLimitBoost(env, user.referrerId, 2, 30, `referral:${userId}`),
    incMetric(env, "qualified_referrals"),
    incMetric(env, `referral-qualified:${user.referrerId}`),
  ]);
  try { await sendMessage(env, user.referrerId, "🎁 Друг створив перше відео! Твій денний ліміт збільшено на <b>+2 відео</b> протягом 30 днів."); } catch {}
}
async function showReferral(env: Env, chatId: number) {
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
  const boosts = (await activeBoosts(env, chatId)).filter((item) => item.source.startsWith("referral:"));
  const [clicks, qualified] = await Promise.all([metric(env, `referral-clicks:${chatId}`), metric(env, `referral-qualified:${chatId}`)]);
  await sendMessage(env, chatId, `<b>🎁 Реферальна програма</b>\n\nЗапроси друга. Коли він створить перше відео, ти отримаєш <b>+2 відео щодня на 30 днів</b>.\n\nТвоє посилання:\n<code>${link}</code>\n\n<b>📊 Реферальна статистика</b>\nПереходів: <b>${clicks}</b>\nАктивували бонус: <b>${qualified}</b>\nАктивних бонусів: <b>${boosts.length}</b>.`, { inline_keyboard: [[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]] });
}
async function buyPremium(env: Env, chatId: number) {
  const language = await getLanguage(env, chatId);
  const copy = {
    ru: {
      title: "Поддержать автора",
      description: "Разовая благодарность автору. На 30 дней: +2 видео в день и приоритетная очередь.",
      label: "Спасибо автору",
    },
    uk: {
      title: "Подякувати автору",
      description: "Разова подяка автору. На 30 днів: +2 відео на день і пріоритетна черга.",
      label: "Подяка автору",
    },
    en: {
      title: "Support the creator",
      description: "A one-time thank you. For 30 days: +2 videos per day and priority queue.",
      label: "Thank the creator",
    },
  }[language];
  await telegram(env, "sendInvoice", {
    chat_id: chatId,
    title: copy.title,
    description: copy.description,
    payload: `support30:${chatId}`,
    currency: "XTR",
    prices: [{ label: copy.label, amount: PREMIUM_STARS }],
  });
}
async function askPromo(env: Env, chatId: number) {
  await putSession(env, chatId, { step: "promo_input", imageKeys: [] });
  await sendMessage(env, chatId, "Надішли промокод одним повідомленням:");
}
async function redeemPromo(env: Env, userId: number, rawCode: string) {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const key = `promo:${code}`;
  const promo = await env.SESSIONS.get<PromoCode>(key, "json");
  if (!promo) return sendMessage(env, userId, "❌ Промокод не знайдено.", createKeyboard);
  if (promo.usedBy.includes(userId)) return sendMessage(env, userId, "Цей промокод уже активовано тобою.", createKeyboard);
  if (promo.usedBy.length >= promo.maxUses) return sendMessage(env, userId, "Термін використання промокоду завершено.", createKeyboard);
  promo.usedBy.push(userId);
  if (promo.type === "premium") await grantPremium(env, userId, promo.value);
  else await addLimitBoost(env, userId, promo.value, 30, `promo:${code}`);
  await Promise.all([env.SESSIONS.put(key, JSON.stringify(promo)), env.SESSIONS.delete(sessionKey(userId)), incMetric(env, "promo_redemptions")]);
  await sendMessage(env, userId, promo.type === "premium" ? `✅ Активовано статус підтримки на <b>${promo.value} днів</b>: +2 відео на день і пріоритетна черга.` : `✅ Денний ліміт збільшено на <b>+${promo.value}</b> протягом 30 днів.`, createKeyboard);
}
async function askFeedback(env: Env, chatId: number, jobId: string) {
  await putSession(env, chatId, { step: "feedback_input", imageKeys: [], feedbackJobId: jobId });
  await sendMessage(env, chatId, "Опиши проблему з відео одним повідомленням. Я передам її адміністратору.");
}
async function saveFeedback(env: Env, chatId: number, session: Session, text: string) {
  const item = { at: new Date().toISOString(), userId: chatId, jobId: session.feedbackJobId, text: text.slice(0, 1000) };
  const list = ((await env.SESSIONS.get("admin:feedback", "json")) as typeof item[] | null) || [];
  await Promise.all([env.SESSIONS.put("admin:feedback", JSON.stringify([item, ...list].slice(0, 100))), env.SESSIONS.delete(sessionKey(chatId)), alertAdmins(env, `Скарга на відео ${session.feedbackJobId || ""} від ${chatId}: ${item.text}`)]);
  await sendMessage(env, chatId, "✅ Повідомлення передано. Дякую!", createKeyboard);
}
async function showProfile(env: Env, chatId: number) {
  const limit = await checkDailyLimit(env, chatId);
  const ids = ((await env.SESSIONS.get(`user-templates:${chatId}:index`, "json")) as string[] | null) || [];
  const status = `${limit.premiumUntil ? `❤️ Підтримка автора до ${new Date(limit.premiumUntil).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" })}\n` : ""}Залишилося сьогодні: <b>${limit.left}/${limit.limit}</b>`;
  await sendMessage(env, chatId, `<b>👤 Мій профіль</b>\n\nTelegram ID: <code>${chatId}</code>\n${status}\nПриватних шаблонів: <b>${ids.length}/20</b>\nWatermark: <b>немає</b>`, {
    inline_keyboard: [[{ text: "❤️ Подякувати автору", callback_data: "buy_premium" }],[{ text: "🎁 Реферальна програма", callback_data: "referral" }, { text: "🎟 Промокод", callback_data: "promo" }],[{ text: "📁 Мої шаблони", callback_data: "my_templates" }],[{ text: "🗑 Видалити мої дані", callback_data: "delete_my_data" }],[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]],
  });
}
async function showHelp(env: Env, chatId: number) {
  await sendMessage(env, chatId, "<b>ℹ️ Допомога</b>\n\n• Одне відео: завантаж 4–10 фото.\n• Декілька відео: обери 3–6 та завантаж 4–5 фото на кожне.\n• Безкоштовно: 10 відео на день.\n• Подяка автору — 100 Stars: до 12 відео на день і пріоритетна черга протягом 30 днів.\n\nУсі функції доступні кнопками.", { inline_keyboard: [[{ text: "🎞 Створити", callback_data: "create" }, { text: "🎬 Декілька", callback_data: "batch_create" }],[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]] });
}
async function promptAdmin(env: Env, chatId: number, action: Session["adminAction"]) {
  await putSession(env, chatId, { step: "admin_input", imageKeys: [], adminAction: action });
  const prompts = {
    limit: "Надішли: <code>USER_ID ЛІМІТ</code>",
    reset_limit: "Надішли Telegram ID користувача:",
    block: "Надішли Telegram ID для блокування:",
    unblock: "Надішли Telegram ID для розблокування:",
    broadcast: "Надішли текст розсилки:",
    premium: "Надішли: <code>USER_ID КІЛЬКІСТЬ_ДНІВ</code>, наприклад <code>123456 30</code>",
    promo: "Надішли: <code>КОД ТИП ЗНАЧЕННЯ ВИКОРИСТАНЬ</code>\nТипи: <code>PREMIUM</code> (дні) або <code>VIDEOS</code> (+відео щодня на 30 днів).\nПриклад: <code>SALE PREMIUM 30 100</code>",
    user_search: "Надішли Telegram ID, @username або ім’я користувача:",
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
  else if (action === "user_search") await searchAdminUsers(env, chatId, text);
  else if (action === "premium") {
    const [idRaw, daysRaw] = text.trim().split(/\s+/); const id = Number(idRaw); const days = Number(daysRaw || 30);
    if (!id || !days) await sendMessage(env, chatId, "Неправильний формат.", adminKeyboard);
    else { await grantPremium(env, id, days); await sendMessage(env, chatId, `✅ Користувачу <code>${id}</code> видано статус підтримки на <b>${days} днів</b>.`, adminKeyboard); }
  }
  else if (action === "promo") {
    const [codeRaw, typeRaw, valueRaw, usesRaw] = text.trim().split(/\s+/);
    const code = (codeRaw || "").toUpperCase().replace(/[^A-Z0-9_-]/g, ""); const type = typeRaw?.toLowerCase(); const value = Number(valueRaw); const maxUses = Number(usesRaw);
    if (!code || !["premium", "videos"].includes(type) || value <= 0 || maxUses <= 0) await sendMessage(env, chatId, "Неправильний формат промокоду.", adminKeyboard);
    else { const promo: PromoCode = { code, type: type as PromoCode["type"], value, maxUses, usedBy: [] }; await env.SESSIONS.put(`promo:${code}`, JSON.stringify(promo)); await sendMessage(env, chatId, `✅ Промокод <code>${code}</code> створено.`, adminKeyboard); }
  }
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
  if (s.step === "transition") { s.step = "order"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери порядок:", orderKeyboard); }
  if (s.step === "motion") { s.step = "transition"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери перехід:", transitionKeyboard); }
  if (s.step === "effect") { s.step = "motion"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери рух:", motionKeyboard); }
  if (s.step === "format" || s.step === "confirm") { s.step = "effect"; await putSession(env, chatId, s); return sendMessage(env, chatId, "Обери ефект:", effectKeyboard); }
  if (s.step === "template_name") { s.step = "confirm"; await putSession(env, chatId, s); return showConfirmation(env, chatId, s); }
}

async function adminStats(env: Env, chatId: number) {
  const names = ["total_users", "total_jobs", "completed", "failed", "rendered_seconds", "blocked"];
  const [users, jobs, completed, failed, seconds, blocked] = await Promise.all(names.map((n) => metric(env, n)));
  const formats = await Promise.all(["vertical", "portrait", "square", "horizontal"].map((n) => metric(env, `format:${n}`)));
  const [todayCompleted, todayFailed, totalRenderMs, outputBytes, pending] = await Promise.all([
    env.SESSIONS.get(`daily-metric:${kyivDate()}:completed`), env.SESSIONS.get(`daily-metric:${kyivDate()}:failed`),
    metric(env, "render_ms"), metric(env, "output_bytes"), actualPendingJobs(env),
  ]);
  const averageSeconds = completed ? (totalRenderMs / completed / 1000).toFixed(1) : "0";
  await sendMessage(env, chatId,
    `<b>📊 Детальна статистика</b>\n\nКористувачів: <b>${users}</b>\nЗавдань: <b>${jobs}</b>\nУспішно: <b>${completed}</b>\nПомилок: <b>${failed}</b>\nСьогодні успішно: <b>${todayCompleted || 0}</b>\nСьогодні помилок: <b>${todayFailed || 0}</b>\nУ черзі: <b>${pending || 0}</b>\nСередній рендер: <b>${averageSeconds} сек</b>\nВідео-секунд: <b>${seconds}</b>\nВихідних даних: <b>${(outputBytes / 1024 / 1024).toFixed(1)} МБ</b>\nЗаблоковано: <b>${blocked}</b>\n\n<b>Формати</b>\n9:16 — ${formats[0]}\n4:5 — ${formats[1]}\n1:1 — ${formats[2]}\n16:9 — ${formats[3]}`,
    adminKeyboard,
  );
}
async function loadAllUsers(env: Env) {
  let cursor: string | undefined; const users: StoredUser[] = [];
  do {
    const page = await env.SESSIONS.list({ prefix: "user:", cursor, limit: 1000 });
    const loaded = await Promise.all(page.keys.map((key) => env.SESSIONS.get<StoredUser>(key.name, "json")));
    users.push(...loaded.filter((user): user is StoredUser => Boolean(user)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return users.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}
async function adminUsers(env: Env, chatId: number, requestedPage = 0) {
  const users = await loadAllUsers(env); const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const selected = users.slice(page * pageSize, page * pageSize + pageSize);
  const details = await Promise.all(selected.map(async (user) => {
    const [used, totalJobs, supporter] = await Promise.all([dailyUsed(env, user.id), metric(env, `user-jobs:${user.id}`), premiumUntil(env, user.id)]);
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Без імені";
    return `${user.blocked ? "🚫" : "👤"}${supporter > Date.now() ? " ❤️" : ""} <code>${user.id}</code> ${escapeHtml(name)}${user.username ? ` @${escapeHtml(user.username)}` : ""}\n└ сьогодні: ${used}, усього: ${totalJobs}, активність: ${user.lastSeen.slice(0, 10)}`;
  }));
  const navigation: Array<Array<{text:string;callback_data:string}>> = [];
  const row: Array<{text:string;callback_data:string}> = [];
  if (page > 0) row.push({ text: "⬅️ Назад", callback_data: `admin:users:${page - 1}` });
  if (page + 1 < totalPages) row.push({ text: "Далі ➡️", callback_data: `admin:users:${page + 1}` });
  if (row.length) navigation.push(row);
  navigation.push([{ text: "🔎 Пошук", callback_data: "admin:user_search" }], [{ text: "⬅️ В адмін-панель", callback_data: "admin:home" }]);
  await sendMessage(env, chatId, `<b>👥 Усі користувачі</b>\nУсього: <b>${users.length}</b> · сторінка ${page + 1}/${totalPages}\n\n${details.join("\n\n") || "Ще немає користувачів."}`, { inline_keyboard: navigation });
}
async function searchAdminUsers(env: Env, chatId: number, query: string) {
  const clean = query.trim().replace(/^@/, "").toLowerCase(); const users = await loadAllUsers(env);
  const matches = users.filter((user) => String(user.id) === clean || (user.username || "").toLowerCase().includes(clean) || [user.first_name, user.last_name].filter(Boolean).join(" ").toLowerCase().includes(clean)).slice(0, 20);
  const lines = matches.map((user) => `${user.blocked ? "🚫" : "👤"} <code>${user.id}</code> ${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ") || "Без імені")}${user.username ? ` @${escapeHtml(user.username)}` : ""}`);
  await sendMessage(env, chatId, `<b>🔎 Результати пошуку</b>\n\n${lines.join("\n") || "Нічого не знайдено."}`, { inline_keyboard: [[{ text: "🔎 Шукати ще", callback_data: "admin:user_search" }], [{ text: "👥 Усі користувачі", callback_data: "admin:users:0" }], [{ text: "⬅️ В адмін-панель", callback_data: "admin:home" }]] });
}
async function adminSystemStatus(env: Env, chatId: number) {
  const [queue, active, storageBytes, lastCleanup, lastSuccess] = await Promise.all([
    countR2Prefix(env, "render-queue/"), env.MEDIA.list({ prefix: "render-active/", limit: 1000 }),
    env.SESSIONS.get("storage:last_bytes"), env.SESSIONS.get("storage:last_cleanup"), env.SESSIONS.get("system:last_success"),
  ]);
  let github = "⚠️ Недоступний";
  try {
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs?created=%3E%3D${monthStart}&per_page=100`, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tiktok-creo-bot" } });
    const body = await response.json() as { total_count?:number; workflow_runs?:Array<{status:string}> };
    github = response.ok ? `✅ працює · активних: ${(body.workflow_runs || []).filter((run) => run.status !== "completed").length} · запусків за місяць: ${body.total_count || 0}` : `⚠️ GitHub ${response.status}`;
  } catch {}
  const oldest = active.objects.length ? Math.max(...active.objects.map((object) => Math.floor((Date.now() - object.uploaded.getTime()) / 60000))) : 0;
  await sendMessage(env, chatId, `<b>🩺 Стан бота</b>\n\nTelegram webhook: ✅\nCloudflare KV: ✅ запити оптимізовано\nGitHub Actions: ${github}\nУ черзі: <b>${queue}</b>\nАктивних рендерів: <b>${active.objects.length}/${MAX_CONCURRENT_RENDERS}</b>\nНайстаріший: <b>${oldest} хв</b>\nR2: <b>${(Number(storageBytes || 0) / 1024 / 1024).toFixed(1)} МБ</b>\nОстаннє очищення: <b>${lastCleanup ? lastCleanup.slice(0, 16) : "ще не було"}</b>\nОстанній успішний рендер: <b>${lastSuccess ? lastSuccess.slice(0, 16) : "ще не було"}</b>`, { inline_keyboard: [[{ text: "🔄 Оновити", callback_data: "admin:system" }], [{ text: "⬅️ В адмін-панель", callback_data: "admin:home" }]] });
}
async function adminSecurity(env: Env, chatId: number) {
  await sendMessage(env, chatId, `<b>🔐 Безпека</b>\n\n✅ Webhook захищено секретом\n✅ Повторні запити блокуються\n✅ Deploy keys видаляються після деплою\n\n⚠️ Після деплою потрібно перевипустити Telegram Bot Token і GitHub Token.`, { inline_keyboard: [[{ text: "⬅️ В адмін-панель", callback_data: "admin:home" }]] });
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
  blockedCache.set(userId, { value: blocked, expiresAt: Date.now() + 30 * 60 * 1000 });
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
    env.SESSIONS.delete(indexKey), env.SESSIONS.delete(sessionKey(chatId)), env.SESSIONS.delete(userKey(chatId)), env.SESSIONS.delete(languageKey(chatId)),
    env.SESSIONS.delete(dailyKey(chatId)), env.SESSIONS.delete(`premium:${chatId}`), env.SESSIONS.delete(`limit-boosts:${chatId}`), env.SESSIONS.delete(lastSettingsKey(chatId)),
    deletePrefix(env, `uploads/${chatId}/`), deletePrefix(env, `outputs/${chatId}/`),
  ]);
  languageCache.delete(chatId); userSeenCache.delete(chatId); blockedCache.delete(chatId);
  await sendMessage(env, chatId, "✅ Твої файли, шаблони, сесія та профіль видалені.");
}

async function handleUpdate(env: Env, update: TelegramUpdate) {
  const callback = update.callback_query;
  const checkout = update.pre_checkout_query;
  const user = callback?.from || checkout?.from || update.message?.from;
  await registerUser(env, user);
  if (checkout) {
    const language = await getLanguage(env, checkout.from.id);
    const validPayload = checkout.invoice_payload === `support30:${checkout.from.id}` || checkout.invoice_payload === `premium30:${checkout.from.id}`;
    const valid = checkout.currency === "XTR" && checkout.total_amount === PREMIUM_STARS && validPayload;
    const paymentError = language === "ru" ? "Неверные параметры платежа." : language === "en" ? "Invalid payment parameters." : "Неправильні параметри платежу.";
    await telegram(env, "answerPreCheckoutQuery", { pre_checkout_query_id: checkout.id, ok: valid, ...(valid ? {} : { error_message: paymentError }) });
    return;
  }
  if (user && await isBlocked(env, user.id) && !isAdmin(env, user.id)) return;
  if (user && !update.message?.photo?.length && !await rateAllowed(env, user.id)) return sendMessage(env, user.id, "Забагато дій. Спробуй через хвилину.");
  if (user && !isAdmin(env, user.id) && await env.SESSIONS.get("admin:maintenance") === "1") return sendMessage(env, user.id, "🔧 Бот тимчасово оновлюється. Спробуй пізніше.");
  if (callback?.message) {
    const chatId = callback.message.chat.id; const data = callback.data || "";
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
    if (data.startsWith("admin:") && isAdmin(env, callback.from.id)) {
      if (data === "admin:home") return sendMessage(env, chatId, "<b>🛠 Адмін-панель</b>", adminKeyboard);
      if (data === "admin:stats") return adminStats(env, chatId);
      if (data === "admin:users") return adminUsers(env, chatId, 0);
      if (data.startsWith("admin:users:")) return adminUsers(env, chatId, Number(data.split(":")[2]) || 0);
      if (data === "admin:user_search") return promptAdmin(env, chatId, "user_search");
      if (data === "admin:system") return adminSystemStatus(env, chatId);
      if (data === "admin:security") return adminSecurity(env, chatId);
      if (data === "admin:errors") return adminErrors(env, chatId);
      if (data === "admin:clear_errors") { await env.SESSIONS.delete("admin:errors"); return sendMessage(env, chatId, "✅ Журнал помилок очищено.", adminKeyboard); }
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
      if (data === "admin:premium") return promptAdmin(env, chatId, "premium");
      if (data === "admin:promo") return promptAdmin(env, chatId, "promo");
    }
    if (data === "language_menu") return sendMessage(env, chatId, "<b>Оберіть мову / Выберите язык / Choose language</b>", languageKeyboard);
    if (data.startsWith("language:")) {
      const language = data.split(":")[1] as Language;
      if (!["ru", "uk", "en"].includes(language)) return;
      await env.SESSIONS.put(languageKey(chatId), language);
      languageCache.set(chatId, { value: language, expiresAt: Date.now() + 30 * 60 * 1000 });
      const saved = language === "ru" ? "✅ Язык изменён на русский." : language === "uk" ? "✅ Мову змінено на українську." : "✅ Language changed to English.";
      return sendMessage(env, chatId, saved, createKeyboard);
    }
    if (data === "main_menu") return sendMessage(env, chatId, "<b>Головне меню</b>", createKeyboard);
    if (data === "batch_create") return sendMessage(env, chatId, "Скільки різних відео створити?", batchCountKeyboard);
    if (data.startsWith("batch_count:")) return resetBatchSession(env, chatId, Number(data.split(":")[1]));
    if (data === "buy_premium") return buyPremium(env, chatId);
    if (data === "referral") return showReferral(env, chatId);
    if (data === "promo") return askPromo(env, chatId);
    if (data.startsWith("rate:")) { const [, value, jobId] = data.split(":"); await env.SESSIONS.put(`rating:${jobId}:${chatId}`, value, { expirationTtl: 90 * 86400 }); await incMetric(env, `rating:${value}`); return sendMessage(env, chatId, value === "up" ? "👍 Дякую за оцінку!" : "👎 Дякую. Можеш також описати проблему кнопкою нижче."); }
    if (data.startsWith("report:")) return askFeedback(env, chatId, data.split(":")[1]);
    if (data === "profile") return showProfile(env, chatId);
    if (data === "help") return showHelp(env, chatId);
    if (data === "create") return resetSession(env, chatId);
    if (data === "quick_create") return startQuickCreation(env, chatId);
    if (data === "photos_restart") { const current = await getSession(env, chatId); return current?.batchCount ? resetBatchSession(env, chatId, current.batchCount) : resetSession(env, chatId); }
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
    if (data.startsWith("transition:")) return setTransition(env, chatId, data.split(":")[1] as Transition);
    if (data.startsWith("motion:")) return setMotion(env, chatId, data.split(":")[1] as Motion);
    if (data.startsWith("effect:")) return setEffect(env, chatId, data.split(":")[1] as Effect);
    if (data.startsWith("format:")) return setFormat(env, chatId, data.split(":")[1] as VideoFormat);
    if (data === "render") return startRender(env, chatId);
    if (data === "save_my_template") return askUserTemplateName(env, chatId);
    return;
  }
  const message = update.message; if (!message) return;
  const chatId = message.chat.id; const userId = message.from?.id || chatId;
  if ([`support30:${userId}`, `premium30:${userId}`].includes(message.successful_payment?.invoice_payload || "") && message.successful_payment?.currency === "XTR" && message.successful_payment.total_amount === PREMIUM_STARS) {
    const until = await grantPremium(env, userId, PREMIUM_DAYS); await incMetric(env, "premium_purchases");
    return sendMessage(env, chatId, `❤️ Дякую за підтримку! До <b>${new Date(until).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" })}</b> доступно +2 відео на день і пріоритетна черга.`, createKeyboard);
  }
  if (message.text && await handleAdminCommand(env, chatId, userId, message.text)) return;
  if (message.text?.startsWith("/start")) {
    const payload = message.text.trim().split(/\s+/)[1] || ""; await registerReferral(env, userId, payload);
    const limit = await checkDailyLimit(env, userId);
    return sendMessage(env, chatId, `Привіт! Я створюю слайд-шоу без watermark. Безкоштовно доступно <b>10 відео на день</b>.\nСьогодні залишилося: <b>${leftLabel(limit)}</b>.`, createKeyboard);
  }
  if (message.photo?.length) return acceptPhoto(env, chatId, message.photo, message.media_group_id);
  if (message.text) {
    const session = await getSession(env, chatId); const value = Number(message.text.replace(",", "."));
    if (session?.step === "template_rename" && session.actionTemplateId) { await renameUserTemplate(env, chatId, session.actionTemplateId, message.text); await env.SESSIONS.delete(sessionKey(chatId)); return showTemplateMenu(env, chatId, session.actionTemplateId); }
    if (session?.step === "template_copy" && session.actionTemplateId) { await copyUserTemplate(env, chatId, session.actionTemplateId, message.text); await env.SESSIONS.delete(sessionKey(chatId)); return listUserTemplates(env, chatId); }
    if (session?.step === "admin_input" && isAdmin(env, userId)) return handleAdminInput(env, chatId, session, message.text);
    if (session?.step === "template_name") return saveUserTemplate(env, chatId, message.text);
    if (session?.step === "promo_input") return redeemPromo(env, chatId, message.text);
    if (session?.step === "feedback_input") return saveFeedback(env, chatId, session, message.text);
    if (session?.step === "duration") return setDuration(env, chatId, value);
    if (session?.step === "speed") return setSpeed(env, chatId, value);
  }
  await sendMessage(env, chatId, "Скористайся кнопкою нижче.", createKeyboard);
}

async function isDuplicateTelegramUpdate(request: Request, update: TelegramUpdate) {
  if (typeof update.update_id !== "number") return false;
  const now = Date.now();
  if ((recentUpdateIds.get(update.update_id) || 0) > now) return true;
  recentUpdateIds.set(update.update_id, now + 60 * 60 * 1000);
  if (recentUpdateIds.size > 5000) for (const [id, expiresAt] of recentUpdateIds) if (expiresAt <= now) recentUpdateIds.delete(id);
  try {
    const cache = await caches.open("telegram-dedupe");
    const cacheRequest = new Request(`${new URL(request.url).origin}/_telegram-update/${update.update_id}`);
    if (await cache.match(cacheRequest)) return true;
    await cache.put(cacheRequest, new Response("1", { headers: { "cache-control": "public, max-age=3600" } }));
  } catch {}
  return false;
}

async function sendVideo(env: Env, chatId: number, video: ArrayBuffer, duration: number, jobId: string) {
  const language = await getLanguage(env, chatId);
  const form = new FormData(); form.append("chat_id", String(chatId)); form.append("supports_streaming", "true");
  form.append("caption", localizeText(`✅ Готово: ${duration} сек`, language));
  form.append("reply_markup", JSON.stringify(localizeMarkup({ inline_keyboard: [[{ text: "👍", callback_data: `rate:up:${jobId}` }, { text: "👎", callback_data: `rate:down:${jobId}` }], [{ text: "⚠️ Повідомити про проблему", callback_data: `report:${jobId}` }]] }, language)));
  form.append("video", new Blob([video], { type: "video/mp4" }), "tiktok-creo.mp4");
  const response = await fetch(apiUrl(env, "sendVideo"), { method: "POST", body: form });
  const result = (await response.json()) as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || "Telegram sendVideo failed");
}
interface StoredRenderJob { job: RenderJob; token: string }
async function dispatchGitHubRender(env: Env, jobId: string, jobToken: string, priority = false) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/render.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "tiktok-creo-bot",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, job_token: jobToken, worker_url: env.WORKER_BASE_URL, priority: String(priority) } }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 500)}`);
}
async function loadRenderJob(env: Env, jobId: string, token: string | null) {
  if (!token) return null;
  const stored = await env.SESSIONS.get<StoredRenderJob>(`render-job:${jobId}`, "json");
  if (!stored || stored.token !== token) return null;
  return stored;
}
async function countR2Prefix(env: Env, prefix: string) {
  let cursor: string | undefined; let total = 0;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    total += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}
async function actualPendingJobs(env: Env) {
  const [queued, active] = await Promise.all([countR2Prefix(env, "render-queue/"), countR2Prefix(env, "render-active/")]);
  return queued + active;
}
async function failRender(env: Env, job: RenderJob, detail: string) {
  const state = await env.SESSIONS.get<{status:string}>(`job:${job.jobId}`, "json");
  if (state?.status === "failed" || state?.status === "done") return;
  await Promise.all([
    removeImages(env, job.imageKeys), env.SESSIONS.delete(sessionKey(job.chatId)),
    env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(`render-job:${job.jobId}`),
    env.MEDIA.delete(renderActiveKey(job.jobId)),
    refundDailyLimit(env, job.dailyCounterKey),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "failed", chatId: job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
    incMetric(env, "failed"), incDailyMetric(env, "failed"), recordError(env, "github_render", detail),
  ]);
  await Promise.all([
    editMessage(env, job.chatId, job.statusMessageId, "❌ <b>Не вдалося створити відео. Ліміт повернуто.</b>"),
    sendMessage(env, job.chatId, "Спробуй ще раз трохи пізніше 👇", createKeyboard),
    alertAdmins(env, `Рендер ${job.jobId} завершився помилкою: ${detail}`),
  ]);
}
async function retryOrFailRender(env: Env, stored: StoredRenderJob, detail: string) {
  const { job } = stored;
  const state = await env.SESSIONS.get<{status:string}>(`job:${job.jobId}`, "json");
  if (state?.status === "done" || state?.status === "failed" || state?.status === "cancelled") return;
  if ((job.retryCount || 0) >= 1) return failRender(env, job, detail);
  job.retryCount = 1; job.queuedAt = Date.now();
  await Promise.all([
    env.MEDIA.delete(renderActiveKey(job.jobId)),
    env.SESSIONS.put(`render-job:${job.jobId}`, JSON.stringify({ ...stored, job }), { expirationTtl: 86400 }),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "queued", chatId: job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
    enqueueRender(env, job), incMetric(env, "retried"),
    editMessage(env, job.chatId, job.statusMessageId, "🔄 <b>Сталася тимчасова помилка. Автоматично повторюю рендер…</b>"),
  ]);
}
async function finalizeCancelledRender(env: Env, stored: StoredRenderJob) {
  const { job } = stored;
  await Promise.all([
    removeImages(env, job.imageKeys), refundDailyLimit(env, job.dailyCounterKey),
    env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(sessionKey(job.chatId)),
    env.SESSIONS.delete(`render-job:${job.jobId}`), env.MEDIA.delete(renderActiveKey(job.jobId)),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "cancelled", chatId: job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
  ]);
  await editMessage(env, job.chatId, job.statusMessageId, "❌ <b>Створення скасовано. Ліміт повернуто.</b>");
}
async function completeRender(env: Env, stored: StoredRenderJob, request: Request) {
  const { job } = stored;
  const state = await env.SESSIONS.get<{status:string}>(`job:${job.jobId}`, "json");
  if (state?.status === "done" || state?.status === "failed") return json({ ok: true, duplicate: true });
  if (state?.status === "cancelled") {
    await finalizeCancelledRender(env, stored);
    return json({ ok: true, cancelled: true });
  }
  if (!request.body) return json({ error: "empty video" }, 400);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 50 * 1024 * 1024) return json({ error: "video too large" }, 413);
  const outputKey = `outputs/${job.chatId}/${job.jobId}.mp4`;
  await env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "uploading", chatId: job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 });
  await editMessage(env, job.chatId, job.statusMessageId, "📤 <b>Надсилаю…</b>");
  const video = await request.arrayBuffer();
  await Promise.all([
    env.MEDIA.put(outputKey, video, { httpMetadata: { contentType: "video/mp4" } }),
    sendVideo(env, job.chatId, video, job.duration, job.jobId),
  ]);
  const renderMs = Date.now() - job.queuedAt;
  await Promise.all([
    removeImages(env, job.imageKeys), env.SESSIONS.delete(sessionKey(job.chatId)),
    env.SESSIONS.delete(`active-job:${job.chatId}`), env.SESSIONS.delete(`render-job:${job.jobId}`),
    env.MEDIA.delete(renderActiveKey(job.jobId)),
    env.SESSIONS.put(`job:${job.jobId}`, JSON.stringify({ status: "done", chatId: job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
    incMetric(env, "completed"), incMetric(env, "rendered_seconds", job.duration), incMetric(env, "render_ms", renderMs),
    incMetric(env, "output_bytes", video.byteLength), incDailyMetric(env, "completed"), env.SESSIONS.put("system:last_success", new Date().toISOString()),
  ]);
  await qualifyReferral(env, job.chatId);
  await sendMessage(env, job.chatId, "Можеш створити наступне відео 👇", createKeyboard);
  return json({ ok: true });
}

async function migrateLegacyQueue(env: Env) {
  const legacy = ((await env.SESSIONS.get("render:free-queue", "json")) as string[] | null) || [];
  if (!legacy.length) return;
  for (const jobId of legacy) {
    const stored = await env.SESSIONS.get<StoredRenderJob>(`render-job:${jobId}`, "json");
    if (stored) await enqueueRender(env, stored.job);
  }
  await env.SESSIONS.delete("render:free-queue");
}
async function updateQueuePositions(env: Env) {
  const queued = [
    ...(await env.MEDIA.list({ prefix: "render-queue/0/", limit: 100 })).objects,
    ...(await env.MEDIA.list({ prefix: "render-queue/1/", limit: 100 })).objects,
  ];
  for (let index = 0; index < queued.length; index++) {
    const marker = queued[index]; const position = index + 1;
    const object = await env.MEDIA.get(marker.key); if (!object) continue;
    const meta = await object.json<QueueMeta>();
    if (meta.lastPosition === position) continue;
    const text = localizeText(`⏳ <b>Очікує в черзі</b>\nТвоє місце: ${position}.`, meta.language);
    try {
      await telegram(env, "editMessageText", { chat_id: meta.chatId, message_id: meta.statusMessageId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: localizeText("❌ Скасувати", meta.language), callback_data: `cancel_job:${marker.key.split("/").pop()}` }]] } });
      meta.lastPosition = position;
      await env.MEDIA.put(marker.key, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
    } catch {}
  }
}
async function recoverStaleRenders(env: Env) {
  const active = await env.MEDIA.list({ prefix: "render-active/", limit: 1000 });
  for (const marker of active.objects) {
    const age = Date.now() - marker.uploaded.getTime();
    const jobId = marker.key.slice("render-active/".length);
    const stored = await env.SESSIONS.get<StoredRenderJob>(`render-job:${jobId}`, "json");
    if (!stored) { await env.MEDIA.delete(marker.key); continue; }
    const state = await env.SESSIONS.get<{status:string}>(`job:${jobId}`, "json");
    if (state?.status === "cancelled") { await finalizeCancelledRender(env, stored); continue; }
    if (state?.status === "done" || state?.status === "failed") { await env.MEDIA.delete(marker.key); continue; }
    if (age > 10 * 60 * 1000 && age < 12 * 60 * 1000) {
      try { await editMessage(env, stored.job.chatId, stored.job.statusMessageId, "⏱ <b>Рендер затримався, але працює і не завис.</b>"); } catch {}
    }
    if (age >= RENDER_TIMEOUT_MS) {
      await env.MEDIA.delete(marker.key);
      await retryOrFailRender(env, stored, "Рендер перевищив максимальний час.");
    }
  }
}
async function processRenderQueue(env: Env) {
  await migrateLegacyQueue(env); await recoverStaleRenders(env); await updateQueuePositions(env);
  const active = await env.MEDIA.list({ prefix: "render-active/", limit: 1000 });
  let slots = Math.max(0, MAX_CONCURRENT_RENDERS - active.objects.length); if (!slots) return;
  const queued = [...(await env.MEDIA.list({ prefix: "render-queue/0/", limit: 100 })).objects, ...(await env.MEDIA.list({ prefix: "render-queue/1/", limit: 100 })).objects];
  for (const marker of queued) {
    if (slots <= 0) break;
    const jobId = marker.key.split("/").pop() || "";
    const stored = await env.SESSIONS.get<StoredRenderJob>(`render-job:${jobId}`, "json");
    if (!stored) { await env.MEDIA.delete(marker.key); continue; }
    const state = await env.SESSIONS.get<{status:string}>(`job:${jobId}`, "json");
    if (state?.status === "cancelled") { await env.MEDIA.delete(marker.key); await finalizeCancelledRender(env, stored); continue; }
    if (state?.status === "done" || state?.status === "failed") { await env.MEDIA.delete(marker.key); continue; }
    await Promise.all([
      env.MEDIA.delete(marker.key), env.MEDIA.put(renderActiveKey(jobId), String(Date.now())),
      env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "dispatching", chatId: stored.job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
      editMessage(env, stored.job.chatId, stored.job.statusMessageId, "🚀 <b>Запускаю рендер…</b>"),
    ]);
    try { await dispatchGitHubRender(env, jobId, stored.token, Boolean(stored.job.priority)); slots--; }
    catch (error) { await env.MEDIA.delete(renderActiveKey(jobId)); await retryOrFailRender(env, stored, `Не вдалося запустити GitHub Actions: ${String(error)}`); }
  }
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
async function checkGitHubUsage(env: Env) {
  const last = Date.parse((await env.SESSIONS.get("system:last_github_check")) || "0");
  if (Number.isFinite(last) && Date.now() - last < 6 * 60 * 60 * 1000) return;
  const month = new Date().toISOString().slice(0, 7);
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs?created=%3E%3D${month}-01&per_page=1`, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tiktok-creo-bot" } });
  await env.SESSIONS.put("system:last_github_check", new Date().toISOString());
  if (!response.ok) return;
  const body = await response.json() as { total_count?:number }; const runs = body.total_count || 0;
  const key = `system:github_alert:${month}`;
  if (runs >= 1600 && !await env.SESSIONS.get(key)) {
    await env.SESSIONS.put(key, "1", { expirationTtl: 40 * 86400 });
    await alertAdmins(env, `GitHub Actions запущено ${runs} разів цього місяця. Перевір безкоштовні хвилини в GitHub Billing.`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      const update = (await request.json()) as TelegramUpdate;
      if (await isDuplicateTelegramUpdate(request, update)) return json({ ok: true, duplicate: true });
      ctx.waitUntil(handleUpdate(env, update).catch(async (error) => { console.error("Update failed", error); await recordError(env, "telegram_update", error); }));
      return json({ ok: true });
    }
    const match = url.pathname.match(/^\/github\/render\/([0-9a-f-]+)\/(job|image\/([0-9]+)|stage|complete|failed)$/);
    if (match) {
      const [, jobId, action, imageIndex] = match;
      const token = request.headers.get("X-Render-Token") || url.searchParams.get("token");
      const stored = await loadRenderJob(env, jobId, token);
      if (!stored) return json({ error: "unauthorized" }, 401);
      if (action === "job" && request.method === "GET") {
        await env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "downloading", chatId: stored.job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 });
        await editMessage(env, stored.job.chatId, stored.job.statusMessageId, "📥 <b>Завантажую фото…</b>");
        return json({ ...stored.job, imageCount: stored.job.imageKeys.length, imageKeys: undefined, dailyCounterKey: undefined });
      }
      if (action.startsWith("image/") && request.method === "GET") {
        const index = Number(imageIndex); const key = stored.job.imageKeys[index];
        if (!key) return json({ error: "image not found" }, 404);
        const object = await env.MEDIA.get(key); if (!object) return json({ error: "image missing" }, 404);
        return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "image/jpeg" } });
      }
      if (action === "stage" && request.method === "POST") {
        await env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "rendering", chatId: stored.job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 });
        await editMessage(env, stored.job.chatId, stored.job.statusMessageId, "⚙️ <b>Створюю відео…</b>");
        return json({ ok: true });
      }
      if (action === "complete" && request.method === "POST") {
        try { return await completeRender(env, stored, request); }
        catch (error) { await retryOrFailRender(env, stored, String(error)); return json({ error: "completion failed" }, 500); }
      }
      if (action === "failed" && request.method === "POST") {
        const body = await request.text(); await retryOrFailRender(env, stored, body.slice(0, 1000)); return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }
    return new Response("TikTok Creo Bot is running", { status: 200 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await processRenderQueue(env);
    await checkGitHubUsage(env);
    const lastCleanup = Date.parse((await env.SESSIONS.get("storage:last_cleanup")) || "0");
    if (!Number.isFinite(lastCleanup) || Date.now() - lastCleanup > 15 * 60 * 1000) await cleanupStorage(env);
  },
} satisfies ExportedHandler<Env, RenderJob>;
