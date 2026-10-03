interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TELEGRAM_IDS?: string;
  SESSIONS: KVNamespace;
  MEDIA: R2Bucket;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  WORKER_BASE_URL: string;
  IMAGES: ImagesBinding;
}

type Step = "photos" | "template" | "duration" | "speed" | "darkness" | "vignette" | "order" | "transition" | "motion" | "effect" | "format" | "confirm" | "template_name" | "template_rename" | "template_copy" | "promo_input" | "feedback_input" | "admin_input" | "rendering" | "uniq";
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
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
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
const DAILY_LIMIT = 5;
const PREMIUM_STARS = 100;
const PREMIUM_DAYS = 30;
const SUPPORTER_DAILY_BONUS = 2;
const BOT_USERNAME = "avto_creo_bot";
const RATE_LIMIT_PER_MINUTE = 60;
const OUTPUT_TTL_MS = 60 * 60 * 1000;
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const QUEUE_ALERT_THRESHOLD = 20;
const MAX_CONCURRENT_RENDERS = 4;
const UNIQ_DAILY_LIMIT = 30;
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
  ["Пріоритетна черга", "Приоритетная очередь"], ["до 7 відео на день", "до 7 видео в день"],
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
  ["Унікалізація фото", "Уникализация фото"],
  ["Надішли 1 фото", "Отправь 1 фото"],
  ["Краще надсилай як файл — без стиснення Telegram", "Лучше отправляй как файл — без сжатия Telegram"],
  ["Я зроблю сильну унікалізацію: кадрування 5–12%, нові пропорції, колір, зерно, нові метадані", "Я сделаю сильную уникализацию: кадрирование 5–12%, новые пропорции, цвет, зерно, новые метаданные"],
  ["Дзеркальний", "Зеркальный"],
  ["Унікальна копія готова", "Уникальная копия готова"],
  ["Ще варіант", "Ещё вариант"],
  ["Обробляю фото", "Обрабатываю фото"],
  ["Ліміт унікалізації на сьогодні вичерпано", "Лимит уникализации на сегодня исчерпан"],
  ["Не вдалося обробити фото. Спробуй інше фото або пізніше", "Не удалось обработать фото. Попробуй другое фото или позже"],
  ["Це не схоже на фото", "Это не похоже на фото"],
  ["Можеш надіслати ще фото", "Можешь отправить ещё фото"],
  ["Оригінал вже видалено. Надішли фото ще раз", "Оригинал уже удалён. Отправь фото ещё раз"],
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
  ["Пріоритетна черга", "Priority queue"], ["до 7 відео на день", "up to 7 videos per day"],
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
  ["Унікалізація фото", "Photo uniqualizer"], ["Надішли 1 фото", "Send 1 photo"],
  ["Краще надсилай як файл — без стиснення Telegram", "Better send it as a file — no Telegram compression"],
  ["Я зроблю сильну унікалізацію: кадрування 5–12%, нові пропорції, колір, зерно, нові метадані", "I will apply strong uniqualization: 5–12% crop, new proportions, color, grain, new metadata"],
  ["Дзеркальний", "Mirrored"],
  ["Унікальна копія готова", "Unique copy is ready"], ["Ще варіант", "Another variant"], ["Обробляю фото", "Processing photo"],
  ["Ліміт унікалізації на сьогодні вичерпано", "Today's uniqualization limit is reached"],
  ["Не вдалося обробити фото. Спробуй інше фото або пізніше", "Could not process the photo. Try another photo or later"],
  ["Це не схоже на фото", "This does not look like a photo"], ["Можеш надіслати ще фото", "You can send more photos"],
  ["Оригінал вже видалено. Надішли фото ще раз", "The original was deleted. Send the photo again"],
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
  [{ text: "🪄 Унікалізація фото", callback_data: "uniq" }],
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
  if (!limit.allowed) return sendMessage(env, chatId, "⛔ Денний ліміт вичерпано. Безкоштовно доступно <b>5 відео на день</b>.");
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
const uniqSourceKey = (chatId: number) => `uniq/${chatId}/source`;
const uniqKeyboard = { inline_keyboard: [
  [{ text: "🔁 Ще варіант", callback_data: "uniq_again" }, { text: "🪞 Дзеркальний", callback_data: "uniq_mirror" }],
  [{ text: "⬅️ Головне меню", callback_data: "main_menu" }],
] };
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const round3 = (value: number) => Math.round(value * 1000) / 1000;
async function startUniq(env: Env, chatId: number) {
  await putSession(env, chatId, { step: "uniq", imageKeys: [] });
  await sendMessage(env, chatId, "<b>🪄 Унікалізація фото</b>\n\nНадішли 1 фото (можна кілька по черзі).\nЯ зроблю сильну унікалізацію: кадрування 5–12%, нові пропорції, колір, зерно, нові метадані.\n\n💡 Краще надсилай як файл — без стиснення Telegram.", { inline_keyboard: [[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]] });
}
async function uniqAllowed(env: Env, chatId: number) {
  if (isAdmin(env, chatId)) return true;
  const key = `uniq-daily:${chatId}:${kyivDate()}`;
  const used = Number((await env.SESSIONS.get(key)) || 0);
  if (used >= UNIQ_DAILY_LIMIT) return false;
  await env.SESSIONS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
  return true;
}
const GRAIN_PNG_BASE64 = "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";
let grainBytes: Uint8Array<ArrayBuffer> | null = null;
const grainStream = () => {
  grainBytes ||= Uint8Array.from(atob(GRAIN_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(grainBytes).body as ReadableStream<Uint8Array>;
};
// "Strong" uniqualization: off-center crop 5–12%, new proportions, color shift, ghost layer, film grain, optional mirror.
async function renderUniqueVariant(env: Env, source: ArrayBuffer, mirror = false) {
  const toStream = () => new Response(source).body as ReadableStream<Uint8Array>;
  const info = await env.IMAGES.info(toStream());
  if (!("width" in info) || !info.width || !info.height) throw new Error("not a raster image");
  const { width, height } = info;
  const cropX = rand(0.05, 0.12), cropY = rand(0.05, 0.12);
  const splitX = rand(0.15, 0.85), splitY = rand(0.15, 0.85);
  const trim = {
    left: Math.round(width * cropX * splitX), right: Math.round(width * cropX * (1 - splitX)),
    top: Math.round(height * cropY * splitY), bottom: Math.round(height * cropY * (1 - splitY)),
  };
  const trimmedWidth = width - trim.left - trim.right;
  const targetWidth = Math.max(320, Math.round(trimmedWidth * rand(0.93, 0.99)));
  const look = {
    brightness: round3(rand(0.95, 1.06)), contrast: round3(rand(0.95, 1.08)),
    saturation: round3(rand(0.9, 1.12)), gamma: round3(rand(0.95, 1.05)), sharpen: round3(rand(0.5, 1.8)),
  };
  const geometry = (handle: ImageTransformer) => {
    let h = handle.transform({ trim });
    if (mirror) h = h.transform({ flip: "h" });
    return h.transform({ width: targetWidth, fit: "scale-down" });
  };
  const ghost = geometry(env.IMAGES.input(toStream()));
  const result = await geometry(env.IMAGES.input(toStream()))
    .transform(look)
    .draw(ghost, { top: Math.round(rand(2, 6)), left: Math.round(rand(2, 6)), opacity: round3(rand(0.04, 0.08)) })
    .draw(env.IMAGES.input(grainStream()), { top: 0, left: 0, repeat: true, opacity: round3(rand(0.05, 0.09)) })
    .output({ format: "image/jpeg", quality: Math.round(rand(86, 94)) });
  return await result.response().arrayBuffer();
}
async function sendUniqueVariant(env: Env, chatId: number, source: ArrayBuffer, mirror = false) {
  if (!await uniqAllowed(env, chatId)) return sendMessage(env, chatId, `⛔ Ліміт унікалізації на сьогодні вичерпано (${UNIQ_DAILY_LIMIT}).`, createKeyboard);
  await telegram(env, "sendChatAction", { chat_id: chatId, action: "upload_document" }).catch(() => {});
  let output: ArrayBuffer;
  try { output = await renderUniqueVariant(env, source, mirror); }
  catch (error) { await recordError(env, "uniq_photo", error); return sendMessage(env, chatId, "❌ Не вдалося обробити фото. Спробуй інше фото або пізніше.", uniqKeyboard); }
  const language = await getLanguage(env, chatId);
  const fileName = `IMG_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${Math.floor(rand(1000, 9999))}.jpg`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", localizeText("✅ Унікальна копія готова. Можеш надіслати ще фото.", language));
  form.append("reply_markup", JSON.stringify(localizeMarkup(uniqKeyboard, language)));
  form.append("document", new Blob([output], { type: "image/jpeg" }), fileName);
  const response = await fetch(apiUrl(env, "sendDocument"), { method: "POST", body: form });
  const body = (await response.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(body.description || "Telegram sendDocument failed");
  await incMetric(env, "uniq_done");
}
async function acceptUniqPhoto(env: Env, chatId: number, fileId: string, fileSize = 0) {
  if (fileSize > 15 * 1024 * 1024) return sendMessage(env, chatId, "Це фото завелике. Максимум — 15 МБ.");
  const { data, ext } = await downloadTelegramPhoto(env, fileId);
  if (data.byteLength > 15 * 1024 * 1024) return sendMessage(env, chatId, "Це фото завелике. Максимум — 15 МБ.");
  await env.MEDIA.put(uniqSourceKey(chatId), data, { httpMetadata: { contentType: `image/${ext === "jpg" ? "jpeg" : ext}` } });
  await sendUniqueVariant(env, chatId, data);
}
async function uniqAgain(env: Env, chatId: number, mirror = false) {
  const object = await env.MEDIA.get(uniqSourceKey(chatId));
  if (!object) return sendMessage(env, chatId, "Оригінал вже видалено. Надішли фото ще раз.", { inline_keyboard: [[{ text: "🪄 Унікалізація фото", callback_data: "uniq" }]] });
  const session = await getSession(env, chatId);
  if (session?.step !== "uniq") await putSession(env, chatId, { step: "uniq", imageKeys: [] });
  await sendUniqueVariant(env, chatId, await object.arrayBuffer(), mirror);
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
  await dispatchQueuedRenders(env).catch((error) => recordError(env, "dispatch_now", error));
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
  await sendMessage(env, chatId, "<b>ℹ️ Допомога</b>\n\n• Одне відео: завантаж 4–10 фото.\n• Декілька відео: обери 3–6 та завантаж 4–5 фото на кожне.\n• Безкоштовно: 5 відео на день.\n• Подяка автору — 100 Stars: до 7 відео на день і пріоритетна черга протягом 30 днів.\n\nУсі функції доступні кнопками.", { inline_keyboard: [[{ text: "🎞 Створити", callback_data: "create" }, { text: "🎬 Декілька", callback_data: "batch_create" }],[{ text: "⬅️ Головне меню", callback_data: "main_menu" }]] });
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
    deletePrefix(env, `uploads/${chatId}/`), deletePrefix(env, `outputs/${chatId}/`), deletePrefix(env, `uniq/${chatId}/`),
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
    if (data === "uniq") return startUniq(env, chatId);
    if (data === "uniq_again") return uniqAgain(env, chatId);
    if (data === "uniq_mirror") return uniqAgain(env, chatId, true);
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
    return sendMessage(env, chatId, `Привіт! Я створюю слайд-шоу без watermark. Безкоштовно доступно <b>5 відео на день</b>.\nСьогодні залишилося: <b>${leftLabel(limit)}</b>.`, createKeyboard);
  }
  const imageDocument = message.document && (message.document.mime_type || "").startsWith("image/") ? message.document : undefined;
  if (message.photo?.length || message.document) {
    const current = await getSession(env, chatId);
    if (current?.step === "uniq") {
      if (message.photo?.length) { const best = message.photo[message.photo.length - 1]; return acceptUniqPhoto(env, chatId, best.file_id, best.file_size); }
      if (imageDocument) return acceptUniqPhoto(env, chatId, imageDocument.file_id, imageDocument.file_size);
      return sendMessage(env, chatId, "Це не схоже на фото. Надішли JPG або PNG.");
    }
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
async function claimRender(env: Env, jobId: string) {
  try {
    const claimed = await env.MEDIA.put(renderActiveKey(jobId), String(Date.now()), { onlyIf: new Headers({ "If-None-Match": "*" }) });
    return claimed !== null;
  } catch {
    await env.MEDIA.put(renderActiveKey(jobId), String(Date.now()));
    return true;
  }
}
async function dispatchQueuedRenders(env: Env) {
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
    if (!await claimRender(env, jobId)) continue; // already being dispatched by a parallel invocation
    await Promise.all([
      env.MEDIA.delete(marker.key),
      env.SESSIONS.put(`job:${jobId}`, JSON.stringify({ status: "dispatching", chatId: stored.job.chatId, updatedAt: Date.now() }), { expirationTtl: 86400 }),
      editMessage(env, stored.job.chatId, stored.job.statusMessageId, "🚀 <b>Запускаю рендер…</b>").catch(() => {}),
    ]);
    try { await dispatchGitHubRender(env, jobId, stored.token, Boolean(stored.job.priority)); slots--; }
    catch (error) { await env.MEDIA.delete(renderActiveKey(jobId)); await retryOrFailRender(env, stored, `Не вдалося запустити GitHub Actions: ${String(error)}`); }
  }
}
async function processRenderQueue(env: Env) {
  await migrateLegacyQueue(env); await recoverStaleRenders(env);
  await dispatchQueuedRenders(env);
  await updateQueuePositions(env);
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
        try { const result = await completeRender(env, stored, request); ctx.waitUntil(dispatchQueuedRenders(env).catch(() => {})); return result; }
        catch (error) { await retryOrFailRender(env, stored, String(error)); return json({ error: "completion failed" }, 500); }
      }
      if (action === "failed" && request.method === "POST") {
        const body = await request.text(); await retryOrFailRender(env, stored, body.slice(0, 1000)); ctx.waitUntil(dispatchQueuedRenders(env).catch(() => {})); return json({ ok: true });
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
