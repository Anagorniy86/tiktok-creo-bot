# TikTok Creo Telegram Bot

Telegram-бот приймає 4–10 фото та створює вертикальне MP4-слайд-шоу 1080×1920. Фото повторюються по колу, затемнюються, отримують віньєтку та змінюються з вибраним інтервалом (стандарт — 0,2 сек).

## Що входить

- Telegram webhook на Cloudflare Worker;
- сесії користувачів у Cloudflare KV;
- фотографії й результати в Cloudflare R2;
- фонова черга Cloudflare Queues;
- FFmpeg у Cloudflare Container;
- тривалість 1–60 сек;
- швидкість 0.05–2 сек;
- автоматичне очищення вхідних фото після завершення.

## 1. Швидка локальна перевірка рендера

Потрібні Docker і `curl`.

```bash
docker compose up --build -d
npm run renderer:test
```

У корені проєкту з’явиться `test-video.mp4`. Відкрий його — має бути 5-секундне вертикальне відео з чотирма кольоровими кадрами, затемненням і віньєткою.

Зупинка:

```bash
docker compose down
```

## 2. Створення Telegram-бота

1. Відкрий у Telegram `@BotFather`.
2. Введи `/newbot`.
3. Задай ім’я та username.
4. Збережи отриманий токен — він потрібен як `TELEGRAM_BOT_TOKEN`.

## 3. Підготовка Cloudflare

Потрібні Node.js 20+, Docker і Cloudflare Workers Paid/доступ до Containers.

```bash
npm install
npx wrangler login
npx wrangler kv namespace create SESSIONS
npx wrangler r2 bucket create tiktok-creo-media
npx wrangler queues create tiktok-creo-render
npx wrangler queues create tiktok-creo-render-dlq
```

Команда KV поверне ID. Встав його у `wrangler.jsonc` замість:

```text
PASTE_KV_NAMESPACE_ID_HERE
```

Якщо назви R2 або Queues змінив — зміни їх також у `wrangler.jsonc`.

## 4. Перший деплой і секрети

Docker має бути запущений.

```bash
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

Для `WEBHOOK_SECRET` введи випадковий рядок. Згенерувати можна так:

```bash
openssl rand -hex 24
```

Запиши URL Worker після деплою, наприклад:

```text
https://tiktok-creo-bot.YOUR-SUBDOMAIN.workers.dev
```

Перший запуск Container після деплою може зайняти кілька хвилин.

## 5. Підключення Telegram webhook

Підстав токен, URL Worker і той самий `WEBHOOK_SECRET`:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tiktok-creo-bot.YOUR-SUBDOMAIN.workers.dev/telegram/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"]
  }'
```

Перевірка webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Перевірка Worker:

```bash
curl "https://tiktok-creo-bot.YOUR-SUBDOMAIN.workers.dev/health"
```

Очікувана відповідь: `{"ok":true}`.

## 6. Перевірка в Telegram

1. Відкрий бота й натисни `/start`.
2. Натисни **Створити слайд-шоу**.
3. Надішли 4–10 фото.
4. Натисни **Далі**.
5. Обери тривалість або надішли число 1–60.
6. Обери швидкість 0,2 сек.
7. Дочекайся готового MP4.

## Логи й діагностика

```bash
npx wrangler tail
npx wrangler containers list
npx wrangler containers images list
```

Також дивись Cloudflare Dashboard → Workers & Pages → Containers / Queues.

## Налаштування ефекту

Фільтри знаходяться у `renderer/server.js`:

```js
eq=brightness=-0.16:contrast=1.04:saturation=0.95
vignette=PI/5
```

- сильніше затемнення: наприклад `brightness=-0.25`;
- слабше затемнення: `brightness=-0.08`;
- сильніша віньєтка: зменшуй знаменник у `PI/5`;
- якість/розмір: змінюй `-crf 25` (менше число = краща якість і більший файл).

## Важливі обмеження MVP

- максимальна тривалість — 60 сек;
- максимум 10 фото по 15 МБ;
- результат зберігається в R2; автоматичне видалення готових відео краще додатково налаштувати через R2 lifecycle rule для `outputs/`;
- для великого публічного запуску додай rate limiting і платні тарифи/ліміти користувачів.

# Версія 5: повністю кнопковий інтерфейс

Звичайний користувач не вводить slash-команди. Telegram автоматично надсилає `/start` при першому запуску, після чого все працює кнопками. Єдина ручна службова команда — `/admin`.

## Головне меню

- Створити слайд-шоу;
- Мої шаблони;
- Мій профіль;
- Допомога;
- Видалити мої дані.

## Керування шаблонами кнопками

У «Мої шаблони» користувач обирає шаблон і бачить кнопки:

- Використати;
- Редагувати;
- Перейменувати;
- Копіювати;
- Видалити.

Редактор шаблону кнопками змінює тривалість, швидкість, затемнення, віньєтку, порядок, ефект і формат. Текст потрібно вводити лише для назви шаблону.

## Профіль і приватність

«Мій профіль» показує Telegram ID, залишок денного ліміту та кількість шаблонів. Видалення всіх даних запускається кнопкою з окремим підтвердженням.

## Адмін-панель

Відкривається єдиною командою:

```text
/admin
```

Далі все кнопками: статистика, користувачі, помилки, технічні роботи, індивідуальні ліміти, скидання ліміту, блокування, розблокування та розсилка. Для ID, числового ліміту й тексту розсилки бот попросить звичайний текст без slash-команд.

Щоб зробити себе адміністратором, відкрий «Мій профіль», скопіюй Telegram ID і виконай у терміналі:

```bash
npx wrangler secret put ADMIN_TELEGRAM_IDS
npx wrangler deploy
```

## Системні можливості

- 5 відео на день;
- без watermark;
- одна активна генерація;
- rate limit 30 дій на хвилину;
- статус і скасування рендера;
- повернення ліміту при помилці або скасуванні;
- автоматичне видалення uploads через 6 годин і outputs через 72 години;
- системні попередження адміністратору;
- детальна статистика.
