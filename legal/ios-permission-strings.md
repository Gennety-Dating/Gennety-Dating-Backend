# iOS permission texts — Info.plist purpose strings and pre-permission screens

Written 2026-10-13, together with Privacy Policy v4.4 (§4.4 "Permissions on your
phone, and why we ask") and Terms v3.2. These are the texts the iOS app shows when
it asks for a system permission. App Review rejects an app under Guideline
5.1.1(ii) when a purpose string is vague ("We need your location"), names no
feature, or asks for something the app does not visibly use. Every string below
therefore says **which feature** needs the permission, **what it does with it**,
and **what we do not do**.

The strings live in the iOS repository (`Gennety-iOS`), not here. This file is the
source text: copy each block into the matching `InfoPlist.strings` (the `en`
block also goes into `Info.plist` as the development-language value). When a
string changes, change it here first, in the same commit as the policy if the
meaning changes.

## 1. Which keys the app declares, and which it must not

1. The app declares exactly these purpose-string keys:
   - `NSCameraUsageDescription` — profile photos and video, the liveness selfie.
   - `NSPhotoLibraryUsageDescription` — only if the app reads the library itself.
     With `PHPickerViewController` (or SwiftUI `PhotosPicker`) no permission is
     asked and the key can be dropped; keep it only if some path uses
     `PHPhotoLibrary` directly.
   - `NSLocationWhenInUseUsageDescription` — city, date logistics, Date Radar,
     Date Bump, frequently visited places.
   - `NSMicrophoneUsageDescription` — voice notes to the concierge and the
     wishlist, the recorded voice answer.
   - `NSHealthShareUsageDescription` — Tempo Sync (step count, read only).
   - `NSAppleMusicUsageDescription` — music on the profile (recently played).
2. The app must **not** declare these, because the product does not do what they
   describe, and an unused key is itself a review risk:
   - `NSLocationAlwaysAndWhenInUseUsageDescription` and `UIBackgroundModes`
     `location` — frequent places are foreground-only by invariant
     (`docs/product/domains/frequent-places.md`, invariant 2).
   - `NSUserTrackingUsageDescription` — no ATT prompt; there is no IDFA use.
   - `NSContactsUsageDescription` — "Contact Sync" is only a UI name for the Date
     Bump; the address book is never read.
   - `NSMotionUsageDescription` — the Date Bump is a press-and-hold since
     2026-09-29. If the native canvas reads raw accelerometer data through
     `CMMotionManager`, that needs no permission; add the key only if
     `CMMotionActivityManager` or `CMPedometer` is ever used.
   - `NSHealthUpdateUsageDescription` — Tempo Sync never writes to Health.
     Request only read types in `requestAuthorization(toShare: [], read: …)`.
   - `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`,
     `NSCalendarsUsageDescription`, `NSFaceIDUsageDescription`.
3. Push notifications have no purpose-string key. Their explanation is the
   pre-permission screen in section 3.
4. The clipboard read of a promo code (iOS 16+ shows the system "Allow Paste"
   alert) has no key either. Read `UIPasteboard` only on first launch and only
   when `hasStrings` is true, so the alert never appears out of context.

## 2. Purpose strings (InfoPlist.strings)

> **2026-10-16:** the shipped English in the iOS `project.yml` has moved past the
> camera and microphone texts below (it also names chat photos, the shared
> photo taken on a date, and promises that concierge voice notes are never shown
> to the match). The iOS translations were made from the shipped English, not
> from this section. Bring this section up to the shipped text before the next
> edit here.

### en (Base)

```
"NSCameraUsageDescription" = "Gennety uses the camera to take your profile photos and video, and for the identity check: a short selfie video that confirms you're a real person and that your photos are of you. Nothing is recorded until you start.";
"NSPhotoLibraryUsageDescription" = "Choose profile photos or a video, or screenshots of things you love for your Date Wishlist. Gennety only receives the items you pick.";
"NSLocationWhenInUseUsageDescription" = "Gennety uses your location while you use the app: to find your city, to choose a date spot that's fair for both of you, to tell your date you're on the way, and to notice cafés and places you often go to. Your date never sees where you are, and we never track you in the background.";
"NSMicrophoneUsageDescription" = "The microphone is used only while you record a voice note — for example, telling the concierge what kind of date you want, or a voice answer for your profile.";
"NSHealthShareUsageDescription" = "Tempo Sync reads your step count for the last 28 days and turns it, on your iPhone, into two labels — how active you are and when your day peaks — to plan dates that fit your rhythm. Step counts never leave your phone.";
"NSAppleMusicUsageDescription" = "Gennety reads your recently played songs so you can pin up to three of them to your profile. Only the songs you choose are shown, and we never change your library.";
```

### ru

```
"NSCameraUsageDescription" = "Камера нужна для фото и видео в профиле и для проверки личности: короткое селфи-видео подтверждает, что ты — реальный человек и на фото именно ты. Запись начинается, только когда ты сам её запускаешь.";
"NSPhotoLibraryUsageDescription" = "Выбери фото или видео для профиля — или скриншоты любимых вещей для вишлиста. Gennety получает только то, что ты выберешь.";
"NSLocationWhenInUseUsageDescription" = "Gennety использует геопозицию, пока приложение открыто: чтобы определить твой город, выбрать место свидания, удобное вам обоим, сказать партнёру, что ты уже в пути, и заметить кафе и места, где ты часто бываешь. Партнёр никогда не видит, где ты, и мы не следим за тобой в фоне.";
"NSMicrophoneUsageDescription" = "Микрофон работает, только пока ты записываешь голосовое — например, рассказываешь консьержу, какое свидание хочешь, или записываешь голосовой ответ для профиля.";
"NSHealthShareUsageDescription" = "Tempo Sync читает количество шагов за последние 28 дней и прямо на iPhone превращает его в две метки — насколько ты активен и на какое время приходится пик дня, — чтобы планировать свидания под твой ритм. Сами шаги не покидают телефон.";
"NSAppleMusicUsageDescription" = "Gennety читает недавно прослушанные песни, чтобы ты мог закрепить до трёх из них в профиле. Показываются только выбранные песни, медиатеку мы не меняем.";
```

### uk

```
"NSCameraUsageDescription" = "Камера потрібна для фото й відео в профілі та для перевірки особи: коротке селфі-відео підтверджує, що ти — справжня людина і на фото саме ти. Запис починається, лише коли ти сам його запускаєш.";
"NSPhotoLibraryUsageDescription" = "Обери фото чи відео для профілю — або скріншоти улюблених речей для вішлиста. Gennety отримує лише те, що ти обереш.";
"NSLocationWhenInUseUsageDescription" = "Gennety використовує геопозицію, поки застосунок відкритий: щоб визначити твоє місто, обрати місце побачення, зручне вам обом, сказати партнерові, що ти вже в дорозі, і помітити кав'ярні та місця, де ти часто буваєш. Партнер ніколи не бачить, де ти, і ми не стежимо за тобою у фоні.";
"NSMicrophoneUsageDescription" = "Мікрофон працює, лише поки ти записуєш голосове — наприклад, розповідаєш консьєржу, яке побачення хочеш, або записуєш голосову відповідь для профілю.";
"NSHealthShareUsageDescription" = "Tempo Sync читає кількість кроків за останні 28 днів і просто на iPhone перетворює її на дві мітки — наскільки ти активний і на який час припадає пік дня, — щоб планувати побачення під твій ритм. Самі кроки не залишають телефон.";
"NSAppleMusicUsageDescription" = "Gennety читає нещодавно прослухані пісні, щоб ти міг закріпити до трьох із них у профілі. Показуються лише обрані пісні, медіатеку ми не змінюємо.";
```

### de

```
"NSCameraUsageDescription" = "Gennety nutzt die Kamera für deine Profilfotos und dein Video und für die Identitätsprüfung: Ein kurzes Selfie-Video bestätigt, dass du ein echter Mensch bist und die Fotos dich zeigen. Aufgenommen wird erst, wenn du startest.";
"NSPhotoLibraryUsageDescription" = "Wähle Profilfotos oder ein Video – oder Screenshots von Dingen, die du liebst, für deine Date-Wunschliste. Gennety erhält nur, was du auswählst.";
"NSLocationWhenInUseUsageDescription" = "Gennety nutzt deinen Standort, solange die App geöffnet ist: um deine Stadt zu finden, einen Ort für das Date zu wählen, der für euch beide passt, deinem Date zu zeigen, dass du unterwegs bist, und Cafés und Orte zu erkennen, an denen du oft bist. Dein Date sieht nie, wo du bist, und wir verfolgen dich nie im Hintergrund.";
"NSMicrophoneUsageDescription" = "Das Mikrofon läuft nur, während du eine Sprachnachricht aufnimmst – etwa um dem Concierge zu sagen, welches Date du dir wünschst, oder für eine Sprachantwort in deinem Profil.";
"NSHealthShareUsageDescription" = "Tempo Sync liest deine Schritte der letzten 28 Tage und macht daraus direkt auf deinem iPhone zwei Merkmale – wie aktiv du bist und wann dein Tag am lebhaftesten ist –, um Dates zu planen, die zu deinem Rhythmus passen. Die Schrittzahlen verlassen dein Telefon nie.";
"NSAppleMusicUsageDescription" = "Gennety liest deine zuletzt gehörten Songs, damit du bis zu drei davon in deinem Profil anheften kannst. Gezeigt werden nur die Songs, die du wählst – deine Mediathek ändern wir nie.";
```

### pl

```
"NSCameraUsageDescription" = "Gennety używa aparatu do zdjęć i wideo w profilu oraz do weryfikacji tożsamości: krótkie selfie wideo potwierdza, że jesteś prawdziwą osobą i że zdjęcia przedstawiają ciebie. Nagrywanie zaczyna się dopiero, gdy je uruchomisz.";
"NSPhotoLibraryUsageDescription" = "Wybierz zdjęcia lub wideo do profilu – albo zrzuty ekranu ulubionych rzeczy do listy życzeń. Gennety dostaje tylko to, co wybierzesz.";
"NSLocationWhenInUseUsageDescription" = "Gennety używa twojej lokalizacji, gdy aplikacja jest otwarta: żeby ustalić twoje miasto, wybrać miejsce randki wygodne dla was obojga, dać znać twojej randce, że jesteś w drodze, i zauważyć kawiarnie i miejsca, w których często bywasz. Twoja randka nigdy nie widzi, gdzie jesteś, i nigdy nie śledzimy cię w tle.";
"NSMicrophoneUsageDescription" = "Mikrofon działa tylko podczas nagrywania wiadomości głosowej – na przykład gdy mówisz konsjerżowi, jakiej randki chcesz, albo nagrywasz odpowiedź głosową do profilu.";
"NSHealthShareUsageDescription" = "Tempo Sync odczytuje liczbę kroków z ostatnich 28 dni i bezpośrednio na iPhonie zamienia ją na dwie etykiety – jak bardzo jesteś aktywny i kiedy przypada szczyt twojego dnia – żeby planować randki w twoim rytmie. Same kroki nie opuszczają telefonu.";
"NSAppleMusicUsageDescription" = "Gennety odczytuje ostatnio słuchane utwory, żebyś mógł przypiąć do trzech z nich w profilu. Pokazujemy tylko wybrane utwory i nigdy nie zmieniamy twojej biblioteki.";
```

## 3. Pre-permission screens (in-app, before the system alert)

The system alert appears once; if it is declined, iOS will not show it again and
the person must go to Settings. So the app shows its own short screen first, at
the moment the feature is used, and calls the system request only from its
primary button. The secondary button never triggers the alert and never blocks
the flow (App Review rejects a pre-prompt whose only exit is "Continue" to the
system alert, Guideline 5.1.1(iv)). These strings belong in the iOS app's own
localisation; the shared i18n in this repository does not carry iOS-only screens.

1. Notifications — shown after onboarding finishes, not at launch.
   - en: title "Don't miss your match"; body "We'll tell you when someone is
     picked for you, when they answer, and when your date is set. A new match
     never shows a name on your lock screen."; primary "Turn on
     notifications"; secondary "Not now".
   - ru: title «Не пропусти свой матч»; body «Сообщим, когда мы кого-то для тебя
     подобрали, когда человек ответил и когда свидание назначено. Имя нового
     матча на заблокированном экране не показываем.»; primary «Включить
     уведомления»; secondary «Не сейчас».
2. Location — shown when the person taps "Use my location" for the city, or
   opens the date screen for the first time.
   - en: title "Location, only while the app is open"; body "We use it to find
     your city and to pick a place that's fair for both of you. Your date never
     sees where you are. You can type your city instead."; primary "Allow
     location"; secondary "Type my city".
   - ru: title «Геопозиция — только пока приложение открыто»; body «Так мы
     определим твой город и выберем место, удобное вам обоим. Партнёр никогда не
     видит, где ты. Можно просто ввести город вручную.»; primary «Разрешить»;
     secondary «Ввести город».
3. Frequently visited places — an in-app explanation, not a system permission.
   It is shown once, the first time the block can fill, with the switch on the
   same screen, because the feature is on by default (see the open item in
   `legal/README.md`).
   - en: "Gennety notices the cafés, restaurants and museums you keep going
     back to while the app is open, and shows up to three on your profile — to
     you and your match, as something to talk about. We keep only the place and
     the day, never your route or the time. You can switch this off or hide a
     place at any time."
   - ru: «Пока приложение открыто, Gennety замечает кафе, рестораны и музеи, куда
     ты возвращаешься, и показывает до трёх в профиле — тебе и твоему матчу, как
     повод для разговора. Мы храним только место и день — без маршрута и
     времени. Выключить это или скрыть любое место можно в любой момент.»
4. Camera for verification — the existing biometric-consent screen
   (`recordBiometricConsent`) already precedes the camera request; the system
   alert must be triggered from its "I agree" button, never before it.
5. Apple Health and Apple Music — the existing Tempo Sync and music screens
   already explain the feature; trigger the system request only from their
   "Connect" buttons.

## 4. App Store Connect — App Privacy answers that match this text

The App Privacy "nutrition label" must agree with the policy, or the review
fails on 5.1.2. **Since 2026-10-16 the exact table lives in the iOS repo**
(`docs/operations/appstore-review-notes.md` §7), generated from
`App/PrivacyInfo.xcprivacy` — fill App Store Connect from there. Summary of the
answers, audited against the iOS code on 2026-10-16:

1. Tracking: **No** — no data is used to track across other companies' apps or
   websites, no IDFA, no ATT prompt.
2. Data linked to the user (none used for tracking):
   - Contact info: email address (university-email sign-in), phone number,
     name — App Functionality; name also Product Personalization.
   - Health & Fitness: fitness (two derived Tempo Sync labels) — App
     Functionality, Product Personalization. Declared even though only labels
     leave the device.
   - Financial info: purchase history — App Functionality.
   - Location: precise location (date logistics, frequent places) and coarse
     location (city) — App Functionality.
   - Sensitive info: orientation and liveness biometrics (policy §10) — App
     Functionality, Product Personalization.
   - User content: photos or videos, audio data (voice notes to the concierge,
     profile voice answer, profile-video sound), customer support, other user
     content (answers, wishlist) — App Functionality; photos/videos and other
     user content also Product Personalization.
   - Identifiers: user ID (account ID, Telegram ID); device ID — always, since
     the push token is always sent (App Functionality), plus the random install
     id when `CLIENT_EVENTS_ENABLED` is on (Analytics).
   - Usage data: product interaction — App Functionality, and Analytics if
     client events are on.
   - Diagnostics: other diagnostic data — the opt-in `fatal_client_error`
     client event (Analytics). No crash SDK; MetricKit stays on the device.
   - Other data types: age, height, hobbies and similar profile fields — App
     Functionality, Product Personalization.
3. Account deletion (Guideline 5.1.1(v)): Settings → Delete account in the app,
   `DELETE /v1/me`; state the path in the App Review notes.
