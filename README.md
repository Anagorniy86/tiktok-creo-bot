# TikTok Creo Telegram Bot — GitHub Actions edition

Публічний Telegram-бот приймає 4–10 фото та створює MP4-слайд-шоу для TikTok. Фото повторюються по колу протягом вибраної тривалості, підтримуються затемнення, віньєтка, порядок кадрів, формати й ефекти. Watermark відсутній.

## Архітектура без Workers Paid

- **Cloudflare Worker Free** — Telegram webhook, кнопки та API рендерингу;
- **Cloudflare KV** — сесії, шаблони, ліміти та статистика;
- **Cloudflare R2** — тимчасові фото й готові відео;
- **GitHub Actions** — безплатний FFmpeg-рендеринг;
- приватний одноразовий токен захищає кожне завдання.

Cloudflare Containers і Queues не використовуються. Для приватного GitHub-репозиторію діє місячний ліміт GitHub Actions, встановлений GitHub.

## Можливості

- повністю кнопковий інтерфейс, окрім `/admin`;
- 4–10 фотографій;
- тривалість 1–60 секунд;
- інтервал 0,05–2 секунди, стандарт — 0,2;
- формати: 9:16, 4:5, 1:1, 16:9;
- затемнення та віньєтка у чотирьох рівнях;
- ефекти: без ефекту, zoom, flash, glitch;
- порядок: оригінальний, одноразове перемішування, випадковий без повтору;
- приватні шаблони користувачів;
- 5 відео на день для кожного користувача;
- одна активна генерація;
- скасування та повернення ліміту при помилці;
- автоматичне очищення файлів;
- адмін-панель, статистика, блокування та розсилка.

## Необхідні ресурси Cloudflare

Назви вже записані у `wrangler.jsonc`:

- KV: `SESSIONS`;
- R2 bucket: `tiktok-creo-media`.

Змінні:

- `GITHUB_REPOSITORY=Anagorniy86/tiktok-creo-bot`;
- `WORKER_BASE_URL=https://tiktok-creo-bot.anagorniy86.workers.dev`.

## Необхідні секрети Worker

У Cloudflare Workers → `tiktok-creo-bot` → Settings → Variables and Secrets:

- `TELEGRAM_BOT_TOKEN` — токен від BotFather;
- `WEBHOOK_SECRET` — випадковий секрет Telegram webhook;
- `GITHUB_TOKEN` — fine-grained GitHub token лише для `tiktok-creo-bot` з дозволом **Actions: Read and write**;
- `ADMIN_TELEGRAM_IDS` — необов’язково, числові Telegram ID адміністраторів через кому.

Секрети не додаються до GitHub-коду.

## Автоматичний деплой

Cloudflare Workers Builds використовує:

```text
Build command: npm ci
Deploy command: npx wrangler deploy
Production branch: main
Root directory: /
```

Після push у `main` Cloudflare автоматично збирає Worker. Файл `.github/workflows/render.yml` запускає FFmpeg тільки після запиту від бота.

## Telegram webhook

Після успішного деплою встанови webhook:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tiktok-creo-bot.anagorniy86.workers.dev/telegram/webhook",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"]
  }'
```

Перевірка Worker:

```bash
curl https://tiktok-creo-bot.anagorniy86.workers.dev/health
```

Очікується `{"ok":true}`.

## Як проходить рендеринг

1. Worker завантажує фотографії з Telegram у R2.
2. Worker створює одноразовий токен і запускає workflow `render.yml` через GitHub API.
3. GitHub Actions забирає параметри й фотографії через захищені URL.
4. FFmpeg створює MP4.
5. Workflow завантажує MP4 назад у Worker.
6. Worker зберігає результат у R2 та надсилає відео користувачу в Telegram.
7. Одноразовий токен і початкові фотографії видаляються.

## Перевірка

```bash
npm ci
npm run typecheck
node --check scripts/render-action.mjs
```

У GitHub вкладка **Actions → Render TikTok video** показує кожен рендер і його журнал. У Cloudflare журнал доступний у Workers & Pages → `tiktok-creo-bot` → Observability.

## Обмеження безплатної версії

- запуск GitHub runner зазвичай додає 20–120 секунд очікування;
- приватні репозиторії мають обмежену кількість безплатних Actions-хвилин;
- результат має бути до 50 МБ для надсилання через поточний маршрут;
- R2 може стати платним лише після перевищення його безплатних місячних лімітів.
