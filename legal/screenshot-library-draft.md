# Draft: screenshot library (not published, feature off)

Needs legal review. Publish in the Privacy Policy with a new version stamp before
`SCREENSHOT_LIBRARY_ENABLED` is turned on. Same pattern as `tempo-sync-draft.md`.

## Text for the Privacy Policy

**Screenshot library (iPhone app, optional, off by default).** If you connect it,
Gennety imports screenshots from the part of your photo library you allow, so you can
find them later by asking in the chat. You can also pick images one at a time without
giving access to your library.

We store a reduced copy of each screenshot, the text recognised on it, a description
and search data, in your private account. To make it searchable, the copy and text are
processed by OpenAI as our processor, on the basis of your consent, which you give
when connecting and can withdraw at any time. Screenshots can contain personal details,
yours or other people's, including messages, addresses or health information. Do not
connect the library if you are not comfortable with that, and delete anything you would
rather not keep here.

With full Photos access, iOS technically allows the app to read your whole library. Our
code imports only images iOS marks as screenshots; other photos and videos are not
uploaded by this feature. Your originals stay in Photos and we never change them.

This data is not used for matching, not added to your profile and not shown to a match.
It stays until you delete it. "Disconnect and delete" closes the library immediately and
removes the copies and search data; removal from backups follows our backup retention.
Conversations you already had and wishlist items you confirmed are managed separately.
Turning off Photos access in iOS does not itself tell our server: use "Disconnect and
delete" to remove what was imported. Deleting your account removes all of it.

## iOS purpose string (`NSPhotoLibraryUsageDescription`)

- en: Choose photos, videos or screenshots to share with Gennety. If you turn on the screenshot library, Gennety imports your screenshots so you can find them in the chat.
- ru: Выбирай фото, видео или скриншоты для Gennety. Если включишь библиотеку скриншотов, Gennety будет импортировать их, чтобы находить нужное в чате.
- uk: Обирай фото, відео або скриншоти для Gennety. Якщо ввімкнеш бібліотеку скриншотів, Gennety імпортуватиме їх, щоб знаходити потрібне в чаті.
- de: Wähle Fotos, Videos oder Screenshots für Gennety aus. Wenn du die Screenshot-Bibliothek aktivierst, importiert Gennety deine Screenshots, damit du sie im Chat wiederfindest.
- pl: Wybieraj zdjęcia, wideo lub zrzuty ekranu dla Gennety. Jeśli włączysz bibliotekę zrzutów, Gennety będzie je importować, aby można je było znaleźć w czacie.

## App Store Connect App Privacy, when the flag goes on

Photos or Videos: collected, linked to the user, app functionality, not tracking.
