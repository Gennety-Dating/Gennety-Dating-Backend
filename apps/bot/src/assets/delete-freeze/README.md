# Delete/freeze video notes (кружки) — retired

**No longer sent.** `handlers/menu/settings.ts` used to play one of these
video notes as the first step when a user taps **Delete Account** in Settings,
before the Freeze / Delete text fork. That send was removed (founder decision)
so the flow is text-only; `services/delete-freeze-video.ts` was deleted along
with it. These MP4s are kept here only in case the video note is reinstated
later — they are not read by any code path today.
