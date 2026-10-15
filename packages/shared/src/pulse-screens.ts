/**
 * Pulse: the closed list of screen keys that clients send in `screen_view`,
 * `screen_left`, `tap`, `dead_tap` and `seen` events
 * (docs/product/domains/pulse-analytics.md §4).
 *
 * The server does not reject keys missing from this list (an app version can
 * ship before the server is deployed), but every client MUST send keys from it,
 * and the admin panel and the agent playbook resolve titles and code hints here.
 *
 * `codeHint` is a repo-relative path the agent opens when a finding points at
 * the screen: `ios:` = the Gennety-iOS repo, `backend:` = this repo.
 */

export type PulsePlatform = "ios" | "miniapp";

export type PulseScreen = {
  platform: PulsePlatform;
  /** Russian label for the admin panel. */
  title: string;
  /** Where the screen lives in code. */
  codeHint: string;
  /** Records `tap` / `dead_tap` (key screens only — spec §3.5). */
  tracksTaps?: true;
  /** Belongs to the onboarding funnel, in order. */
  onboardingOrder?: number;
};

const IOS = "ios:App/";
const MINI = "backend:apps/webapp/src/";

export const PULSE_SCREENS = {
  // iOS — before the shell (GennetyApp.rootStep)
  language: { platform: "ios", title: "Язык", codeHint: `${IOS}Features/Language/LanguageOnboardingView.swift`, tracksTaps: true, onboardingOrder: 1 },
  phone_login: { platform: "ios", title: "Вход", codeHint: `${IOS}Features/Auth/PhoneLoginView.swift`, tracksTaps: true, onboardingOrder: 2 },
  promo: { platform: "ios", title: "Промо-подарок", codeHint: `${IOS}Features/Onboarding/PromoWowView.swift`, tracksTaps: true },
  consent: { platform: "ios", title: "Согласие", codeHint: `${IOS}Features/Onboarding/ConsentView.swift`, tracksTaps: true, onboardingOrder: 3 },
  city: { platform: "ios", title: "Город", codeHint: `${IOS}Features/Onboarding/CityView.swift`, tracksTaps: true, onboardingOrder: 4 },
  interview_basics: { platform: "ios", title: "Анкета: основное", codeHint: `${IOS}Features/Onboarding/OnboardingBasicsView.swift`, tracksTaps: true, onboardingOrder: 5 },
  interview_chat: { platform: "ios", title: "Анкета: разговор", codeHint: `${IOS}Features/Onboarding/OnboardingInterviewView.swift`, tracksTaps: true, onboardingOrder: 6 },
  photos: { platform: "ios", title: "Фото", codeHint: `${IOS}Features/Onboarding/PhotoManagerView.swift`, tracksTaps: true, onboardingOrder: 7 },
  verification: { platform: "ios", title: "Проверка лица", codeHint: `${IOS}Features/Onboarding/VerificationView.swift`, tracksTaps: true, onboardingOrder: 8 },
  push_prompt: { platform: "ios", title: "Уведомления", codeHint: `${IOS}Features/Onboarding/PreNotificationView.swift`, tracksTaps: true, onboardingOrder: 9 },
  update_required: { platform: "ios", title: "Нужно обновление", codeHint: `${IOS}UpdateRequiredView.swift` },
  offline: { platform: "ios", title: "Нет сети", codeHint: `${IOS}GennetyApp.swift` },

  // iOS — shell (RootView)
  map: { platform: "ios", title: "Карта", codeHint: `${IOS}Features/Canvas/CanvasView.swift` },
  today: { platform: "ios", title: "Сегодня", codeHint: `${IOS}Features/Today/TodayView.swift` },
  tickets_wallet: { platform: "ios", title: "Билеты", codeHint: `${IOS}Features/Tickets/TicketsWalletView.swift` },
  chat: { platform: "ios", title: "Чат с агентом", codeHint: `${IOS}Features/Chat/ChatView.swift` },
  chat_hub: { platform: "ios", title: "Чаты", codeHint: `${IOS}Features/ChatHub/` },
  proxy_chat: { platform: "ios", title: "Прокси-чат", codeHint: `${IOS}Features/ChatHub/ChatHubProxyChat.swift` },
  profile: { platform: "ios", title: "Профиль", codeHint: `${IOS}Features/Profile/ProfileView.swift` },
  settings: { platform: "ios", title: "Настройки", codeHint: `${IOS}Features/Settings/SettingsView.swift` },
  premium: { platform: "ios", title: "Premium", codeHint: `${IOS}Features/Premium/PremiumView.swift`, tracksTaps: true },
  paywall: { platform: "ios", title: "Пейвол", codeHint: `${IOS}Features/Premium/Paywall/PaywallView.swift`, tracksTaps: true },
  referral: { platform: "ios", title: "Пригласить", codeHint: `${IOS}Features/Referral/ReferralHubView.swift` },

  // iOS — date path (TodayModel.scene)
  today_pitch: { platform: "ios", title: "Питч пары", codeHint: `${IOS}Features/Pitch/PitchView.swift`, tracksTaps: true },
  today_awaiting_peer: { platform: "ios", title: "Ждём ответа пары", codeHint: `${IOS}Features/Today/TodayView.swift` },
  today_calendar: { platform: "ios", title: "Выбор времени", codeHint: `${IOS}Features/Scheduling/CalendarView.swift`, tracksTaps: true },
  today_planning: { platform: "ios", title: "Планирование", codeHint: `${IOS}Features/Today/PlanningStep.swift` },
  today_ticket_gate: { platform: "ios", title: "Билет на свидание", codeHint: `${IOS}Features/Tickets/TicketGateView.swift`, tracksTaps: true },
  today_venue_intent: { platform: "ios", title: "Выбор места", codeHint: `${IOS}Features/VenueIntent/VenueIntentView.swift`, tracksTaps: true },
  today_scheduled: { platform: "ios", title: "Свидание назначено", codeHint: `${IOS}Features/DateCard/DateCardView.swift` },
  today_waiting: { platform: "ios", title: "Ожидание пары", codeHint: `${IOS}Features/Today/SearchScene.swift` },
  today_famine: { platform: "ios", title: "Пары нет", codeHint: `${IOS}Features/Today/SearchScene.swift` },
  today_paused: { platform: "ios", title: "Поиск на паузе", codeHint: `${IOS}Features/Today/TodayView.swift` },
  today_frozen: { platform: "ios", title: "Аккаунт заморожен", codeHint: `${IOS}Features/Today/FrozenScene.swift` },

  // iOS — sheets
  ticket_store: { platform: "ios", title: "Магазин билетов", codeHint: `${IOS}Features/Tickets/TicketStoreSheet.swift`, tracksTaps: true },
  prime_time: { platform: "ios", title: "Prime Time", codeHint: `${IOS}Features/Scheduling/PrimeTimeSheet.swift`, tracksTaps: true },
  venue_change: { platform: "ios", title: "Смена места", codeHint: `${IOS}Features/VenueChange/VenueChangeView.swift` },
  feedback: { platform: "ios", title: "Отзыв о свидании", codeHint: `${IOS}Features/Feedback/FeedbackView.swift` },
  date_mode: { platform: "ios", title: "Режим свидания", codeHint: `${IOS}Features/DateMode/DateModeView.swift` },

  // Mini App — onboarding phases (src/onboarding-route.ts)
  mini_onb_visual: { platform: "miniapp", title: "Mini: вступление", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 1 },
  mini_onb_detail: { platform: "miniapp", title: "Mini: подробности", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 2 },
  mini_onb_syncing: { platform: "miniapp", title: "Mini: синхронизация", codeHint: `${MINI}onboarding.tsx` },
  mini_onb_consent: { platform: "miniapp", title: "Mini: согласие", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 3 },
  mini_onb_language: { platform: "miniapp", title: "Mini: язык", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 4 },
  mini_onb_path: { platform: "miniapp", title: "Mini: путь входа", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 5 },
  mini_onb_email: { platform: "miniapp", title: "Mini: почта", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 6 },
  mini_onb_otp: { platform: "miniapp", title: "Mini: код", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 7 },
  mini_onb_phone: { platform: "miniapp", title: "Mini: телефон", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 6 },
  mini_onb_city: { platform: "miniapp", title: "Mini: город", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 8 },
  mini_onb_waitlist: { platform: "miniapp", title: "Mini: лист ожидания", codeHint: `${MINI}onboarding.tsx` },
  mini_onb_theme: { platform: "miniapp", title: "Mini: тема", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 9 },
  mini_onb_promo_gift: { platform: "miniapp", title: "Mini: промо-подарок", codeHint: `${MINI}onboarding.tsx` },
  mini_onb_referral_gift: { platform: "miniapp", title: "Mini: подарок друга", codeHint: `${MINI}onboarding.tsx` },
  mini_onb_basics: { platform: "miniapp", title: "Mini: анкета", codeHint: `${MINI}onboarding.tsx`, tracksTaps: true, onboardingOrder: 10 },
  mini_onb_loading: { platform: "miniapp", title: "Mini: загрузка", codeHint: `${MINI}onboarding.tsx` },
  mini_onb_done: { platform: "miniapp", title: "Mini: готово", codeHint: `${MINI}onboarding.tsx`, onboardingOrder: 11 },

  // Mini App — pages (vite.config.ts entries)
  mini_calendar: { platform: "miniapp", title: "Mini: календарь", codeHint: `${MINI}main.ts` },
  mini_verification: { platform: "miniapp", title: "Mini: проверка лица", codeHint: `${MINI}verification.ts` },
  mini_location: { platform: "miniapp", title: "Mini: место", codeHint: `${MINI}location.ts` },
  mini_ticket: { platform: "miniapp", title: "Mini: билет", codeHint: `${MINI}ticket/main.tsx` },
  mini_tickets: { platform: "miniapp", title: "Mini: магазин билетов", codeHint: `${MINI}tickets/main.tsx` },
  mini_venue_change: { platform: "miniapp", title: "Mini: смена места", codeHint: `${MINI}venue-change.ts` },
  mini_premium: { platform: "miniapp", title: "Mini: Premium", codeHint: `${MINI}premium.ts` },
  mini_radar: { platform: "miniapp", title: "Mini: радар типа", codeHint: `${MINI}radar/main.tsx` },
  mini_referral: { platform: "miniapp", title: "Mini: пригласить", codeHint: `${MINI}referral.ts` },
  mini_canvas: { platform: "miniapp", title: "Mini: карта", codeHint: `${MINI}canvas.ts` },
  mini_date_terminal: { platform: "miniapp", title: "Mini: терминал свидания", codeHint: `${MINI}date-terminal/main.tsx` },
  mini_feedback: { platform: "miniapp", title: "Mini: отзыв", codeHint: `${MINI}feedback.ts` },
} as const satisfies Record<string, PulseScreen>;

export type PulseScreenKey = keyof typeof PULSE_SCREENS;

export function pulseScreen(key: string): PulseScreen | null {
  return (PULSE_SCREENS as Record<string, PulseScreen>)[key] ?? null;
}

/** Onboarding funnel steps of one platform, in order. */
export function pulseOnboardingSteps(platform: PulsePlatform): string[] {
  return Object.entries(PULSE_SCREENS as Record<string, PulseScreen>)
    .filter(([, s]) => s.platform === platform && s.onboardingOrder !== undefined)
    .sort((a, b) => a[1].onboardingOrder! - b[1].onboardingOrder!)
    .map(([key]) => key);
}

/** Pulse event types added by contract v2 (spec §3.4). */
export const PULSE_EVENT_TYPES = ["screen_view", "screen_left", "tap", "dead_tap", "seen"] as const;

/** `screen_left.exit` values. */
export const PULSE_EXITS = ["next", "back", "background", "dismiss"] as const;
