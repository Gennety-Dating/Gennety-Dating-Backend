<!-- WHEN_TO_READ: changing the Telegram ticket gate (ticket.html), the «Чего хочется?» step of location.html, or the bot's pitch confirm cards — and whenever asking why they look like the native app. -->

# 2026-11-04 — Telegram takes the native variant B: ticket gate, «Чего хочется?», pitch confirm copy

**Why.** The founder asked to identify the stages the iOS app reworked and to replace the Telegram versions with the same UI. The rework is the iOS founder's pick of 2026-10-30 (iOS journal «Выбор основателя: анкета, подтверждение, билет — вариант Б»), together with the two decisions it builds on: 2026-10-25 (cover panel at the bottom edge, «Беру на себя» on a second tap) and 2026-10-23 (the two-tap «Подтвердить» + «✕» ask). The reference is iOS `origin/main` 353cffba; the screenshots of the pick are on artifact YUVQSNMnyNwvYyLXjQGB8w.

1. Ticket gate (`apps/webapp/src/ticket/`).
   1. Offer: the countdown moved into a glass capsule at the top left (`HH:MM:SS`, iOS `DropCountdownBadge`); partner portrait 84 on an accent glow; headline «Свиданию нужен билет» and the native body copy; the ticket drawn at the reader's proportion (`zoom: 0.62`) without the wallet count on its stub.
   2. One action instead of two equal buttons: «Использовать 2 билета» / «Использовать билет» / «Оплатить · {price}». The other scope is a quiet line under it («Оплатить только свой» ↔ «Оплатить оба билета»), shown only when there is one (a male who can still cover). The button logic (`deriveOfferButtons`) is unchanged — the line picks between its two answers.
   3. Waiting and cover: the iOS ticket glyph on light, «Твой билет на месте» / «Ждём второй билет.». The cover offer is a frosted panel along the bottom edge (top corners 30, portrait 52, «Оплатить и второй билет?», «{name} узнает, что он уже оплачен.»). «Беру на себя» asks first: a glass capsule «Подтвердить» + «✕» materialises over it; «Подтвердить» ignores taps for 350 ms and an abandoned ask folds back after 6 s unless a spend is in flight (`confirm-ask.ts`, same constants as iOS `TimeAcceptRow`). An empty wallet skips the ask — the Stars sheet is its own confirmation, as the App Store sheet is on iOS. Under the action: «N билетов в кошельке · Пополнить» → the ticket store.
   4. Removed with the old layout: «Пусть возьмёт свой» and «Всё-таки оплатить за пару» (there is no defer step any more — the panel just waits), the timer sentence `PartialTimer`, the waiting screen's «Закрыть», the two-avatar buttons.
   5. Result: «Оба билета на месте» with two rows («Твой билет» ✓, partner ✓) that stands until «Выбрать время»; the confetti and the big ticket on this screen are gone. Partner-paid and closed screens are unchanged.
2. «Чего хочется?» (`location.html` + `location.ts` + `location.css`).
   1. The whole step fits one screen: the five scene cards share the free height (rows clamp between 108 and 230 px, the iOS `VenueSceneGrid` numbers); scrolling remains only as the floor for a screen too short for the minimum.
   2. The bottom row is the native one: round «‹», the field as a one-line capsule «Или своими словами». With a picture or words «Дальше» rises beside them and the field folds into a circle (its glyph burgundy once words are in). Tapping the field opens it above the row and the keyboard, with the cards blurred and pinned behind a 30 % scrim.
   3. Submission is unchanged (interpret → confirm in one tap, decision 2026-10-21).
3. Bot pitch confirm cards (`packages/shared/src/i18n.ts`, five languages).
   1. «💫 Да, иду на свидание» → «Подтвердить — иду»; «❌ Да, пас» → «Точно не иду» — the native labels.
   2. The decline prompt loses «Это решение окончательное — …», as the native decline did on 2026-10-30. The pitch's deadline notice at the top of the stream is untouched.
   3. The live deadline button reads «⏳ Ответить за 19ч 40м» (native «Ответить за» under the name).
   4. The pitch itself stays a conversation (photos, streamed text, voice, «да/нет» in words → confirm card); turning it into a Mini App screen is a product change nobody asked for.
4. Not ported, deliberately.
   1. «Мне подходит» two-tap ask: it lives on the native «Сегодня» block; the Telegram calendar already commits with a separate button.
   2. Market circle without fill and the removed Home/Work chips: the Telegram departure map has neither.

5. Founder's review of the screenshots, same day (supersedes 1.1, 1.2 and the countdown in 1.3).
   1. The offer is NOT ported: «it looks unclear in iOS too» — the native offer goes to its own redesign first. Telegram keeps its offer («Это мэтч», the ticket with the wallet count, the two-avatar «pay for both» and the secondary), and only its two buttons become capsules (`border-radius: 999px`, scoped to `.gate-offer`).
   2. No countdown capsule anywhere in the Telegram gate: the chat card above the Mini App already carries the window. The native app keeps its capsule on the offer and the cover screens.
   3. Cover panel (1.3) and the result (1.5) ship as built; the result's «Твой билет» row leads with the brand ticket glyph (the same skewed plate with the butterfly as the waiting screen) instead of the drawn `ticket.fill`.
   4. «Чего хочется?» ships as built; checked for overlap at 390×844, 375×667, 360×600 and 390×460 — on the shortest the grid scrolls inside its frame and the last card stops above the row.

**Demo mode.** Identical — the demo gate settles on the tap (`settle-no-charge`) behind the same panel and ask; nothing here branches on demo.

**Deploy.** Client-only (webapp bundle) plus bot copy; no schema, no API change. Shipping follows the founder's approval of the screenshots.
