<!-- WHEN_TO_READ: You are preparing the first (or any) App Store submission of the Gennety iOS app and need the list of manual steps only the founder can do — server switches, Apple Developer portal, App Store Connect. -->

# Подача в App Store — чек-лист основателя

Составлен 2026-10-16 по аудиту кода и живого прода (решение в журнале от 2026-10-16). Здесь только то, что
делается руками: прод-переменные, слияния и кабинеты Apple. Правки кода закрыты отдельными ветками, они
перечислены в разделе 0.

## 0. Слить и выкатить (до всего остального)

1. **Бэкенд, ветка `worktree-app-review-demo`** → main. В ней демо-аккаунт ревьюера и этот чек-лист.
2. **Сайт, ветка `legal-v44-support`** (PR в `gennetydating-website`) → main. Публикует Privacy v4.4, Terms v3.2
   и страницу `/support`. Слияние в main = выкат на Vercel.
3. **iOS, ветка `appstore-review-risks`** (PR в `gennety-ios`) → main. Манифест приватности, условия автопродления
   у кнопки покупки, переводы разрешений, ключ экспорта, заметки для ревью.
4. **Выкат бэкенда** по `deploy-journal/pending.md`: прод `3edf3b15` отстаёт от main на 122 коммита, 7 миграций
   (`db:deploy` до перезапуска).

## 1. Прод `.env` (бэкенд)

| Переменная | Значение | Зачем |
|---|---|---|
| `APP_REVIEW_EMAIL` | отдельный адрес, напр. `appreview@gennety.com` | вход ревьюера ([app-review-account.md](app-review-account.md)) |
| `APP_REVIEW_CODE` | 6 случайных цифр (не повтор, не подряд) | код входа ревьюера |
| `PHONE_AUTH_ENABLED` | `false`, пока Twilio отвечает 403 | иначе приложение предлагает вход по телефону, а сервер отвечает 503 — ревьюер упрётся в ошибку. Альтернатива: `TELEGRAM_GATEWAY_TOKEN` или тикет в Twilio. Приложение прячет поле телефона по этому флагу только начиная со сборки из iOS-ветки `appstore-review-risks` — старые сборки флаг не читают |
| `APNS_ENVIRONMENT` | `production` | с 03.10 сервер сам пробует второй хост APNs, переменная лишь задаёт порядок |
| `APPSTORE_ENVIRONMENT` | `production` | то же: проверка покупки идёт в оба стора, sandbox-покупки ревьюера принимаются |

После правки — перезапуск и **один вход самому** с адресом и кодом ревьюера: за ~20 с на «Сегодня» появляется
Gleb, пройти пару до конца (точка отправления — в Киеве).

## 2. Apple Developer → Certificates, IDs & Profiles → Identifiers

1. `com.gennety.ios` — включить: Push Notifications, **Time Sensitive Notifications**, **HealthKit**, Associated
   Domains, App Groups (`group.com.gennety.ios`), на вкладке App Services — **MusicKit**.
2. `com.gennety.ios.widgets` — App Groups (`group.com.gennety.ios`).
3. `com.gennety.ios.notifications` (расширение уведомлений) — просто зарегистрирован.
4. Ключ APNs (.p8) и ключ App Store Server API — уже на сервере (`APPSTORE_KEY_*`); проверить, что не отозваны.

## 3. App Store Connect

**Договоры.** Business → Agreements: договор Paid Apps активен, налоги и банк заполнены. Без него покупки не
работают даже у ревьюера.

**Встроенные покупки** (ID ровно такие; у каждого — название, описание, цена, скриншот для ревью; подаются вместе с
первой версией):

| ID | Тип |
|---|---|
| `premium_monthly` | автовозобновляемая подписка, 1 месяц, в своей группе подписок |
| `ticket_1`, `ticket_3`, `ticket_6` | расходуемые |
| `venue_change_1` | расходуемая (ID приходит с сервера, в локальном `.storekit` его нет) |
| `prime_time_pass`, `date_wishlist_unlock` | расходуемые; сейчас выключены флагами — можно не подавать в первой версии |

**App Store Server Notifications (V2)**: в App Information → App Store Server Notifications указать для
Production и для Sandbox `https://dating-api.gennety.com/v1/webhooks/appstore`.

**App Information**: категория (Lifestyle или Social Networking), Content Rights, **Age Rating** — анкета
честно; приложение знакомств получает 18+, это совпадает с Terms (возраст от 18).

**App Privacy**: Privacy Policy URL `https://gennety.com/privacy`; ответы — по таблице §7
`Gennety-iOS/docs/operations/appstore-review-notes.md` (после слияния iOS-ветки она совпадает с манифестом).
Tracking — No.

**Страница версии**:
- Версия: решить номер (сейчас 0.1.0, build 2; для релиза обычно 1.0). Build растёт на каждую загрузку.
- Скриншоты iPhone 6,9″ (iPad не нужен — приложение только для iPhone).
- Описание, ключевые слова, Promotional text, Copyright.
- Support URL `https://gennety.com/support`, Marketing URL `https://gennety.com`.
- Экспорт-шифрование: после iOS-ветки в Info.plist стоит `ITSAppUsesNonExemptEncryption = NO`, вопрос не всплывает.

**App Review Information**:
- Sign-in required: адрес и код из раздела 1.
- Контакт: имя, телефон, почта основателя.
- Notes: блок из §2 `appstore-review-notes.md` (англ.), плюс про Apple Health (Tempo Sync включён) и модерацию
  (жалоба/блок из чата и с экрана свидания, удаление аккаунта: Settings → Delete account).
- Version Release: вручную (Manually release).

## 4. Перед кнопкой «Submit for Review»

1. Sandbox-тестер (Users and Access → Sandbox) и проверочная покупка Premium и билета на iPhone.
2. TestFlight: прогон двумя живыми аккаунтами от регистрации до свидания и отзыва.
3. Живой iPhone: Live Activity, виджет, ответ из уведомления, Reduce Motion.
4. Вход ревьюера проверен на проде (раздел 1).

## 5. После одобрения

Очистить `APP_REVIEW_EMAIL` и `APP_REVIEW_CODE`, перезапустить; при желании удалить оба аккаунта через админку
([app-review-account.md](app-review-account.md)).
