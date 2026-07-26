import type { Lang } from "./i18n.js";

/**
 * Every string the AWS Face Liveness detector puts on screen, in all five
 * product languages.
 *
 * Why this file exists: the detector ships English-only, and the strings it
 * shows are not decoration — they are the instructions. A user is holding a
 * phone at arm's length with a camera pointed at their face, and the only
 * guidance they get is one line at the top of the screen telling them to move
 * closer, hold still, or recentre. Leaving that in English for a Ukrainian or
 * Polish user does not make the check harder to read; it makes it impossible
 * to pass except by accident.
 *
 * Every key is filled for every language on purpose. `LivenessDisplayText` is
 * all-optional and silently falls back to English, so a partial translation
 * would leak English mid-check exactly when the user is least able to stop and
 * puzzle it out. A parity test enforces this.
 *
 * Translation notes:
 *   - The `hint*` strings are read at a glance mid-capture, so they stay short
 *     and imperative — "Подойдите ближе", not "Пожалуйста, придвиньтесь ближе
 *     к камере". Length here costs comprehension.
 *   - The photosensitivity warning is a safety notice before a flashing-light
 *     sequence, so it is translated faithfully rather than trimmed.
 *   - `a11yVideoLabelText` and `hintCenterFaceInstructionText` are screen-reader
 *     copy, which is why the latter is a full paragraph while its visual
 *     counterpart is three words.
 *
 * Kept out of `i18n.ts` deliberately: this is ~50 keys used by exactly one
 * lazily-loaded island, and merging it would bloat the module every other Mini
 * App imports eagerly.
 */

/**
 * Structural mirror of Amplify's `LivenessDisplayText`. Declared locally rather
 * than imported so this module has no dependency on the heavy liveness package
 * — it is imported by the island, which already pays that cost.
 */
export interface LivenessText {
  // Hints — shown one at a time, over the camera, during the check.
  hintMoveFaceFrontOfCameraText: string;
  hintTooManyFacesText: string;
  hintFaceDetectedText: string;
  hintCanNotIdentifyText: string;
  hintTooCloseText: string;
  hintTooFarText: string;
  hintConnectingText: string;
  hintVerifyingText: string;
  hintCheckCompleteText: string;
  hintIlluminationTooBrightText: string;
  hintIlluminationTooDarkText: string;
  hintIlluminationNormalText: string;
  hintHoldFaceForFreshnessText: string;
  hintCenterFaceText: string;
  hintCenterFaceInstructionText: string;
  hintFaceOffCenterText: string;
  hintMatchIndicatorText: string;
  // Camera availability / permissions.
  cameraMinSpecificationsHeadingText: string;
  cameraMinSpecificationsMessageText: string;
  cameraNotFoundHeadingText: string;
  cameraNotFoundMessageText: string;
  retryCameraPermissionsText: string;
  waitingCameraPermissionText: string;
  a11yVideoLabelText: string;
  // The Get Ready screen.
  goodFitCaptionText: string;
  goodFitAltText: string;
  tooFarCaptionText: string;
  tooFarAltText: string;
  photosensitivityWarningHeadingText: string;
  photosensitivityWarningBodyText: string;
  photosensitivityWarningInfoText: string;
  photosensitivityWarningLabelText: string;
  startScreenBeginCheckText: string;
  // While streaming.
  recordingIndicatorText: string;
  cancelLivenessCheckText: string;
  // Failure screens.
  errorLabelText: string;
  connectionTimeoutHeaderText: string;
  connectionTimeoutMessageText: string;
  timeoutHeaderText: string;
  timeoutMessageText: string;
  faceDistanceHeaderText: string;
  faceDistanceMessageText: string;
  multipleFacesHeaderText: string;
  multipleFacesMessageText: string;
  clientHeaderText: string;
  clientMessageText: string;
  serverHeaderText: string;
  serverMessageText: string;
  landscapeHeaderText: string;
  landscapeMessageText: string;
  portraitMessageText: string;
  tryAgainText: string;
}

const en: LivenessText = {
  hintMoveFaceFrontOfCameraText: "Move your face in front of the camera",
  hintTooManyFacesText: "Only one face should be in front of the camera",
  hintFaceDetectedText: "Face detected",
  hintCanNotIdentifyText: "Move your face in front of the camera",
  hintTooCloseText: "Move back",
  hintTooFarText: "Move closer",
  hintConnectingText: "Connecting…",
  hintVerifyingText: "Checking…",
  hintCheckCompleteText: "Done",
  hintIlluminationTooBrightText: "Too bright — move somewhere dimmer",
  hintIlluminationTooDarkText: "Too dark — move somewhere brighter",
  hintIlluminationNormalText: "Lighting is fine",
  hintHoldFaceForFreshnessText: "Hold still",
  hintCenterFaceText: "Centre your face",
  hintCenterFaceInstructionText:
    "Before the check starts, make sure the camera is at the top centre of the screen and your face is centred. An oval will appear; you will be asked to move closer until your face fills it, then to hold still for a few seconds.",
  hintFaceOffCenterText: "Your face is outside the oval — centre it",
  hintMatchIndicatorText: "50% done. Keep moving closer.",
  cameraMinSpecificationsHeadingText: "The camera is not good enough",
  cameraMinSpecificationsMessageText:
    "The camera must support at least 320×240 and 15 frames per second.",
  cameraNotFoundHeadingText: "No access to the camera",
  cameraNotFoundMessageText:
    "Check that the camera is connected and not being used by another app. You may need to allow camera access in settings and try again.",
  retryCameraPermissionsText: "Try again",
  waitingCameraPermissionText: "Waiting for camera permission…",
  a11yVideoLabelText: "Camera for the liveness check",
  goodFitCaptionText: "Good fit",
  goodFitAltText: "Illustration of a correctly positioned face",
  tooFarCaptionText: "Too far",
  tooFarAltText: "Illustration of a face that is too far from the camera",
  photosensitivityWarningHeadingText: "Photosensitivity warning",
  photosensitivityWarningBodyText:
    "During the check the screen flashes different colours. Take care if you are photosensitive.",
  photosensitivityWarningInfoText:
    "Coloured flashes can trigger seizures in people with photosensitive epilepsy. Take care if you or anyone in your family has this condition.",
  photosensitivityWarningLabelText: "More about photosensitivity",
  startScreenBeginCheckText: "Start the check",
  recordingIndicatorText: "Rec",
  cancelLivenessCheckText: "Cancel the check",
  errorLabelText: "Error",
  connectionTimeoutHeaderText: "Connection timed out",
  connectionTimeoutMessageText: "The connection took too long. Try again.",
  timeoutHeaderText: "Time is up",
  timeoutMessageText:
    "Your face did not fill the oval in time. Try again and fill the oval completely.",
  faceDistanceHeaderText: "You moved too early",
  faceDistanceMessageText: "Don't move closer while the check is connecting.",
  multipleFacesHeaderText: "More than one face",
  multipleFacesMessageText:
    "Make sure only one face is in front of the camera.",
  clientHeaderText: "Something went wrong",
  clientMessageText: "The check could not be completed on this device.",
  serverHeaderText: "Service problem",
  serverMessageText: "The check could not be completed. Try again shortly.",
  landscapeHeaderText: "Landscape is not supported",
  landscapeMessageText: "Turn your phone upright.",
  portraitMessageText: "Keep the phone upright until the check is done.",
  tryAgainText: "Try again",
};

const ru: LivenessText = {
  hintMoveFaceFrontOfCameraText: "Поместите лицо перед камерой",
  hintTooManyFacesText: "В кадре должно быть только одно лицо",
  hintFaceDetectedText: "Лицо найдено",
  hintCanNotIdentifyText: "Поместите лицо перед камерой",
  hintTooCloseText: "Отодвиньтесь",
  hintTooFarText: "Придвиньтесь ближе",
  hintConnectingText: "Соединяемся…",
  hintVerifyingText: "Проверяем…",
  hintCheckCompleteText: "Готово",
  hintIlluminationTooBrightText: "Слишком светло — уйдите из-под яркого света",
  hintIlluminationTooDarkText: "Слишком темно — перейдите к свету",
  hintIlluminationNormalText: "Освещение нормальное",
  hintHoldFaceForFreshnessText: "Не двигайтесь",
  hintCenterFaceText: "Отцентрируйте лицо",
  hintCenterFaceInstructionText:
    "Перед началом проверки убедитесь, что камера сверху по центру экрана, а лицо — по центру кадра. Появится овал: вас попросят придвинуться, пока лицо не заполнит его, а затем несколько секунд не двигаться.",
  hintFaceOffCenterText: "Лицо вне овала — отцентрируйте его",
  hintMatchIndicatorText: "Половина готова. Придвигайтесь ещё.",
  cameraMinSpecificationsHeadingText: "Камера не подходит",
  cameraMinSpecificationsMessageText:
    "Нужна камера с разрешением от 320×240 и частотой от 15 кадров в секунду.",
  cameraNotFoundHeadingText: "Нет доступа к камере",
  cameraNotFoundMessageText:
    "Проверьте, что камера подключена и не занята другим приложением. Возможно, нужно разрешить доступ к камере в настройках и повторить попытку.",
  retryCameraPermissionsText: "Повторить",
  waitingCameraPermissionText: "Ждём разрешения на камеру…",
  a11yVideoLabelText: "Камера для проверки живости",
  goodFitCaptionText: "Так правильно",
  goodFitAltText: "Пример правильного положения лица",
  tooFarCaptionText: "Слишком далеко",
  tooFarAltText: "Пример: лицо слишком далеко от камеры",
  photosensitivityWarningHeadingText: "Предупреждение о вспышках",
  photosensitivityWarningBodyText:
    "Во время проверки экран мигает разными цветами. Будьте осторожны, если у вас светочувствительность.",
  photosensitivityWarningInfoText:
    "Цветные вспышки могут вызвать приступ у людей со светочувствительной эпилепсией. Будьте осторожны, если такое бывает у вас или у ваших близких.",
  photosensitivityWarningLabelText: "Подробнее о светочувствительности",
  startScreenBeginCheckText: "Начать проверку",
  recordingIndicatorText: "Запись",
  cancelLivenessCheckText: "Отменить проверку",
  errorLabelText: "Ошибка",
  connectionTimeoutHeaderText: "Превышено время ожидания",
  connectionTimeoutMessageText: "Соединение заняло слишком долго. Попробуйте ещё раз.",
  timeoutHeaderText: "Время вышло",
  timeoutMessageText:
    "Лицо не заполнило овал вовремя. Попробуйте снова и заполните овал полностью.",
  faceDistanceHeaderText: "Вы двинулись раньше времени",
  faceDistanceMessageText: "Не придвигайтесь, пока идёт соединение.",
  multipleFacesHeaderText: "В кадре несколько лиц",
  multipleFacesMessageText: "Убедитесь, что перед камерой только одно лицо.",
  clientHeaderText: "Что-то пошло не так",
  clientMessageText: "Проверку не удалось выполнить на этом устройстве.",
  serverHeaderText: "Проблема на сервере",
  serverMessageText: "Проверку не удалось завершить. Попробуйте чуть позже.",
  landscapeHeaderText: "Горизонтальная ориентация не поддерживается",
  landscapeMessageText: "Поверните телефон вертикально.",
  portraitMessageText: "Держите телефон вертикально до конца проверки.",
  tryAgainText: "Попробовать ещё раз",
};

const uk: LivenessText = {
  hintMoveFaceFrontOfCameraText: "Розмістіть обличчя перед камерою",
  hintTooManyFacesText: "У кадрі має бути лише одне обличчя",
  hintFaceDetectedText: "Обличчя знайдено",
  hintCanNotIdentifyText: "Розмістіть обличчя перед камерою",
  hintTooCloseText: "Відсуньтеся",
  hintTooFarText: "Присуньтеся ближче",
  hintConnectingText: "З'єднуємось…",
  hintVerifyingText: "Перевіряємо…",
  hintCheckCompleteText: "Готово",
  hintIlluminationTooBrightText: "Забагато світла — відійдіть від яскравого",
  hintIlluminationTooDarkText: "Замало світла — перейдіть до світлішого місця",
  hintIlluminationNormalText: "Освітлення нормальне",
  hintHoldFaceForFreshnessText: "Не рухайтесь",
  hintCenterFaceText: "Відцентруйте обличчя",
  hintCenterFaceInstructionText:
    "Перед початком перевірки переконайтеся, що камера вгорі по центру екрана, а обличчя — по центру кадру. З'явиться овал: вас попросять присунутися, доки обличчя його не заповнить, а потім кілька секунд не рухатись.",
  hintFaceOffCenterText: "Обличчя поза овалом — відцентруйте його",
  hintMatchIndicatorText: "Половину зроблено. Присувайтеся ще.",
  cameraMinSpecificationsHeadingText: "Камера не підходить",
  cameraMinSpecificationsMessageText:
    "Потрібна камера з роздільною здатністю від 320×240 і частотою від 15 кадрів на секунду.",
  cameraNotFoundHeadingText: "Немає доступу до камери",
  cameraNotFoundMessageText:
    "Перевірте, що камера підключена і не зайнята іншим застосунком. Можливо, потрібно дозволити доступ до камери в налаштуваннях і спробувати ще раз.",
  retryCameraPermissionsText: "Повторити",
  waitingCameraPermissionText: "Чекаємо на дозвіл до камери…",
  a11yVideoLabelText: "Камера для перевірки живості",
  goodFitCaptionText: "Так правильно",
  goodFitAltText: "Приклад правильного положення обличчя",
  tooFarCaptionText: "Задалеко",
  tooFarAltText: "Приклад: обличчя задалеко від камери",
  photosensitivityWarningHeadingText: "Попередження про спалахи",
  photosensitivityWarningBodyText:
    "Під час перевірки екран блимає різними кольорами. Будьте обережні, якщо маєте світлочутливість.",
  photosensitivityWarningInfoText:
    "Кольорові спалахи можуть спричинити напад у людей зі світлочутливою епілепсією. Будьте обережні, якщо таке буває у вас або у ваших близьких.",
  photosensitivityWarningLabelText: "Докладніше про світлочутливість",
  startScreenBeginCheckText: "Почати перевірку",
  recordingIndicatorText: "Запис",
  cancelLivenessCheckText: "Скасувати перевірку",
  errorLabelText: "Помилка",
  connectionTimeoutHeaderText: "Перевищено час очікування",
  connectionTimeoutMessageText: "З'єднання тривало надто довго. Спробуйте ще раз.",
  timeoutHeaderText: "Час вичерпано",
  timeoutMessageText:
    "Обличчя не заповнило овал вчасно. Спробуйте знову і заповніть овал повністю.",
  faceDistanceHeaderText: "Ви рушили зарано",
  faceDistanceMessageText: "Не присувайтеся, доки триває з'єднання.",
  multipleFacesHeaderText: "У кадрі кілька облич",
  multipleFacesMessageText: "Переконайтеся, що перед камерою лише одне обличчя.",
  clientHeaderText: "Щось пішло не так",
  clientMessageText: "Не вдалося виконати перевірку на цьому пристрої.",
  serverHeaderText: "Проблема на сервері",
  serverMessageText: "Не вдалося завершити перевірку. Спробуйте трохи згодом.",
  landscapeHeaderText: "Горизонтальна орієнтація не підтримується",
  landscapeMessageText: "Поверніть телефон вертикально.",
  portraitMessageText: "Тримайте телефон вертикально до кінця перевірки.",
  tryAgainText: "Спробувати ще раз",
};

const de: LivenessText = {
  hintMoveFaceFrontOfCameraText: "Halte dein Gesicht vor die Kamera",
  hintTooManyFacesText: "Es darf nur ein Gesicht im Bild sein",
  hintFaceDetectedText: "Gesicht erkannt",
  hintCanNotIdentifyText: "Halte dein Gesicht vor die Kamera",
  hintTooCloseText: "Geh etwas zurück",
  hintTooFarText: "Komm näher",
  hintConnectingText: "Verbinden…",
  hintVerifyingText: "Wird geprüft…",
  hintCheckCompleteText: "Fertig",
  hintIlluminationTooBrightText: "Zu hell — geh an einen dunkleren Ort",
  hintIlluminationTooDarkText: "Zu dunkel — geh an einen helleren Ort",
  hintIlluminationNormalText: "Licht ist in Ordnung",
  hintHoldFaceForFreshnessText: "Halt still",
  hintCenterFaceText: "Zentriere dein Gesicht",
  hintCenterFaceInstructionText:
    "Achte vor dem Start darauf, dass die Kamera oben mittig sitzt und dein Gesicht mittig im Bild ist. Es erscheint ein Oval: Du wirst gebeten, näher zu kommen, bis dein Gesicht es ausfüllt, und dann ein paar Sekunden still zu halten.",
  hintFaceOffCenterText: "Dein Gesicht ist außerhalb des Ovals — zentriere es",
  hintMatchIndicatorText: "50 % geschafft. Komm weiter näher.",
  cameraMinSpecificationsHeadingText: "Die Kamera reicht nicht aus",
  cameraMinSpecificationsMessageText:
    "Die Kamera muss mindestens 320×240 und 15 Bilder pro Sekunde schaffen.",
  cameraNotFoundHeadingText: "Kein Zugriff auf die Kamera",
  cameraNotFoundMessageText:
    "Prüfe, ob die Kamera angeschlossen ist und nicht von einer anderen App benutzt wird. Eventuell musst du den Kamerazugriff in den Einstellungen erlauben und es erneut versuchen.",
  retryCameraPermissionsText: "Erneut versuchen",
  waitingCameraPermissionText: "Warten auf die Kameraerlaubnis…",
  a11yVideoLabelText: "Kamera für die Lebendprüfung",
  goodFitCaptionText: "So ist es richtig",
  goodFitAltText: "Darstellung eines richtig positionierten Gesichts",
  tooFarCaptionText: "Zu weit weg",
  tooFarAltText: "Darstellung: Gesicht zu weit von der Kamera entfernt",
  photosensitivityWarningHeadingText: "Warnung vor Lichtblitzen",
  photosensitivityWarningBodyText:
    "Während der Prüfung blinkt der Bildschirm in verschiedenen Farben. Sei vorsichtig, wenn du lichtempfindlich bist.",
  photosensitivityWarningInfoText:
    "Farbige Lichtblitze können bei photosensitiver Epilepsie Anfälle auslösen. Sei vorsichtig, wenn das bei dir oder in deiner Familie vorkommt.",
  photosensitivityWarningLabelText: "Mehr zur Lichtempfindlichkeit",
  startScreenBeginCheckText: "Prüfung starten",
  recordingIndicatorText: "Aufn.",
  cancelLivenessCheckText: "Prüfung abbrechen",
  errorLabelText: "Fehler",
  connectionTimeoutHeaderText: "Zeitüberschreitung",
  connectionTimeoutMessageText: "Die Verbindung hat zu lange gedauert. Versuch es erneut.",
  timeoutHeaderText: "Zeit abgelaufen",
  timeoutMessageText:
    "Dein Gesicht hat das Oval nicht rechtzeitig ausgefüllt. Versuch es erneut und fülle das Oval ganz aus.",
  faceDistanceHeaderText: "Zu früh bewegt",
  faceDistanceMessageText: "Komm nicht näher, solange die Verbindung aufgebaut wird.",
  multipleFacesHeaderText: "Mehrere Gesichter erkannt",
  multipleFacesMessageText: "Achte darauf, dass nur ein Gesicht vor der Kamera ist.",
  clientHeaderText: "Etwas ist schiefgelaufen",
  clientMessageText: "Die Prüfung konnte auf diesem Gerät nicht abgeschlossen werden.",
  serverHeaderText: "Serverproblem",
  serverMessageText: "Die Prüfung konnte nicht abgeschlossen werden. Versuch es gleich noch mal.",
  landscapeHeaderText: "Querformat wird nicht unterstützt",
  landscapeMessageText: "Dreh dein Handy hochkant.",
  portraitMessageText: "Halte das Handy bis zum Ende der Prüfung hochkant.",
  tryAgainText: "Erneut versuchen",
};

const pl: LivenessText = {
  hintMoveFaceFrontOfCameraText: "Ustaw twarz przed kamerą",
  hintTooManyFacesText: "W kadrze może być tylko jedna twarz",
  hintFaceDetectedText: "Twarz wykryta",
  hintCanNotIdentifyText: "Ustaw twarz przed kamerą",
  hintTooCloseText: "Odsuń się",
  hintTooFarText: "Przysuń się bliżej",
  hintConnectingText: "Łączymy…",
  hintVerifyingText: "Sprawdzamy…",
  hintCheckCompleteText: "Gotowe",
  hintIlluminationTooBrightText: "Za jasno — przejdź w ciemniejsze miejsce",
  hintIlluminationTooDarkText: "Za ciemno — przejdź w jaśniejsze miejsce",
  hintIlluminationNormalText: "Oświetlenie jest w porządku",
  hintHoldFaceForFreshnessText: "Nie ruszaj się",
  hintCenterFaceText: "Wyśrodkuj twarz",
  hintCenterFaceInstructionText:
    "Przed startem upewnij się, że kamera jest na górze pośrodku ekranu, a twarz na środku kadru. Pojawi się owal: poprosimy cię, żebyś przysunął się, aż twarz go wypełni, a potem przez kilka sekund się nie ruszał.",
  hintFaceOffCenterText: "Twarz jest poza owalem — wyśrodkuj ją",
  hintMatchIndicatorText: "Połowa za tobą. Przysuwaj się dalej.",
  cameraMinSpecificationsHeadingText: "Kamera nie spełnia wymagań",
  cameraMinSpecificationsMessageText:
    "Kamera musi obsługiwać co najmniej 320×240 i 15 klatek na sekundę.",
  cameraNotFoundHeadingText: "Brak dostępu do kamery",
  cameraNotFoundMessageText:
    "Sprawdź, czy kamera jest podłączona i nie jest używana przez inną aplikację. Może być konieczne zezwolenie na dostęp do kamery w ustawieniach i ponowna próba.",
  retryCameraPermissionsText: "Spróbuj ponownie",
  waitingCameraPermissionText: "Czekamy na zgodę na dostęp do kamery…",
  a11yVideoLabelText: "Kamera do weryfikacji na żywo",
  goodFitCaptionText: "Tak jest dobrze",
  goodFitAltText: "Ilustracja poprawnie ustawionej twarzy",
  tooFarCaptionText: "Za daleko",
  tooFarAltText: "Ilustracja: twarz za daleko od kamery",
  photosensitivityWarningHeadingText: "Ostrzeżenie o błyskach",
  photosensitivityWarningBodyText:
    "Podczas weryfikacji ekran miga różnymi kolorami. Zachowaj ostrożność, jeśli jesteś światłoczuły.",
  photosensitivityWarningInfoText:
    "Kolorowe błyski mogą wywołać napad u osób z padaczką światłoczułą. Zachowaj ostrożność, jeśli dotyczy to ciebie lub kogoś z twojej rodziny.",
  photosensitivityWarningLabelText: "Więcej o światłoczułości",
  startScreenBeginCheckText: "Rozpocznij weryfikację",
  recordingIndicatorText: "Nagr.",
  cancelLivenessCheckText: "Anuluj weryfikację",
  errorLabelText: "Błąd",
  connectionTimeoutHeaderText: "Przekroczono czas oczekiwania",
  connectionTimeoutMessageText: "Połączenie trwało zbyt długo. Spróbuj ponownie.",
  timeoutHeaderText: "Czas minął",
  timeoutMessageText:
    "Twarz nie wypełniła owalu na czas. Spróbuj ponownie i wypełnij owal w całości.",
  faceDistanceHeaderText: "Ruch za wcześnie",
  faceDistanceMessageText: "Nie przysuwaj się, dopóki trwa łączenie.",
  multipleFacesHeaderText: "Wykryto kilka twarzy",
  multipleFacesMessageText: "Upewnij się, że przed kamerą jest tylko jedna twarz.",
  clientHeaderText: "Coś poszło nie tak",
  clientMessageText: "Nie udało się przeprowadzić weryfikacji na tym urządzeniu.",
  serverHeaderText: "Problem serwera",
  serverMessageText: "Nie udało się zakończyć weryfikacji. Spróbuj za chwilę.",
  landscapeHeaderText: "Orientacja pozioma nie jest obsługiwana",
  landscapeMessageText: "Obróć telefon pionowo.",
  portraitMessageText: "Trzymaj telefon pionowo do końca weryfikacji.",
  tryAgainText: "Spróbuj ponownie",
};

export const LIVENESS_TEXT: Record<Lang, LivenessText> = { en, ru, uk, de, pl };

/** Detector copy for a language, falling back to English for an unknown one. */
export function livenessText(lang: Lang): LivenessText {
  return LIVENESS_TEXT[lang] ?? en;
}
