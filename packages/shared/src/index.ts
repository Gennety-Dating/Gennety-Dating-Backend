export { APP_NAME, ALLOWED_EMAIL_DOMAINS, OTP_TTL_MS, OTP_LENGTH, MIN_PHOTOS, MAX_PHOTOS, PHOTO_BONUS_TICKET_THRESHOLD, STUDENT_BONUS_TICKETS, LIVE_PHOTO_MAX_DURATION_SECONDS, LIVE_PHOTO_MAX_FILE_SIZE_BYTES, PROFILE_VIDEO_MAX_DURATION_SECONDS, PROFILE_VIDEO_MAX_FILE_SIZE_BYTES, PROFILE_MEDIA_VALIDATION_VERSION, FACE_SIMILARITY_THRESHOLD, DUPLICATE_HASH_DISTANCE, VIDEO_FACE_PRESENCE_THRESHOLD, VIDEO_IDENTITY_MATCH_THRESHOLD, VIDEO_SAMPLE_TARGET_FRAMES, TICKET_BUNDLES, ticketBundleFor, FAMINE_DISCOUNT_PCT, FAMINE_DISCOUNT_TTL_DAYS, FAMINE_DISCOUNT_MIN_TIER, MIN_AGE, MAX_AGE, MAX_BIO_LENGTH, MAX_PARTNER_PREFERENCES_LENGTH, MAX_MAJOR_LENGTH, DATE_ALERT_HOURS, PRE_DATE_SAFETY_HOURS, PRE_DATE_WINGMAN_HOURS, FEEDBACK_DELAY_HOURS, COORD_OFFER_HOURS, PROXY_OPEN_HOURS, PROXY_CLOSE_AFTER_HOURS, PROXY_MAX_MESSAGE_LEN, VENUE_CHANGE_RADIUS_KM, VENUE_CHANGE_TTL_HOURS, VENUE_CHANGE_MIN_COMMENT_LEN, VENUE_CHANGE_MAX_COMMENT_LEN, PROFILER_ENTRY_DELAY_MS, PROFILER_BATCH_SIZE_NORMAL, PROFILER_BATCH_SIZE_RUSH, PROFILER_INTER_BATCH_GAP_HOURS, PROFILER_MORNING_HOUR, PROFILER_EVENING_HOUR, PROFILER_RUSH_WINDOW_HOURS, PROFILER_MAX_ANSWER_LEN, PROFILER_PRIORITY_WEIGHTS, PROFILER_PENALTY_COEFFICIENTS, MAX_DUMP_BUFFER_CHARS, MAX_HISTORY_FOR_API, SUMMARIZE_THRESHOLD, KEEP_RECENT_MESSAGES } from "./constants.js";
export type { TicketBundleSize } from "./constants.js";
export {
  profilerQuestionBank,
  profilerQuestionById,
  profilerQuestionText,
  profilerPriorityWeight,
  scoreProfilerAnswers,
  formatProfilerAnswersBlock,
} from "./profiler-questions.js";
export type {
  ProfilerPriority,
  ProfilerQuestion,
  ScoredProfilerAnswer,
} from "./profiler-questions.js";
export { cityKeyToTimeZone, isValidTimeZone, DEFAULT_TIME_ZONE } from "./timezone.js";
export { t, escapeMd, interpolate } from "./i18n.js";
export type { TranslationKey } from "./i18n.js";
export { tv, setVariantRng, variantAlternates, VARIANT_KEYS } from "./i18n-variants.js";
export type { VariantRng } from "./i18n-variants.js";
export { contextDumpInstruction } from "./onboarding-copy.js";
export {
  FEMALE_ATTRIBUTES,
  MALE_ATTRIBUTES,
  FEMALE_PHOTOS,
  MALE_PHOTOS,
  AGE_BANDS,
  ageBandFor,
  photosForSet,
  radarPhotoById,
  attributeKeysForSet,
  setsForPreference,
  setForGender,
  reasonChipsFor,
  reasonChipById,
  buildPreferenceVector,
  candidateTypeScore,
  hasTypeSignal,
  CHIP_ATTR_BOOST,
  CHIP_ATTR_DISCOUNT,
  CONF_FULL,
} from "./type-radar.js";
export type {
  RadarSet,
  RadarScene,
  RadarPhoto,
  PhotoAttrs,
  AttributeKey,
  AgeBand,
  AgeBandDef,
  ReasonChip,
  ChipEffect,
  Verdict,
  RadarAnswer,
  AttrValuePreference,
  PreferenceVector,
} from "./type-radar.js";
export {
  computeStatusSnapshot,
  formatStatusText,
  formatDateCountdownText,
  nextMatchDispatchAt,
  isMatchBatchProcessing,
} from "./status/format-status.js";
export type {
  StatusTimerPhase,
  StatusTimerInput,
  StatusTimerSnapshot,
  DateCountdownInput,
} from "./status/format-status.js";
export type {
  OnboardingStep,
  Language,
  Gender,
  GenderPreference,
  MenuState,
  MatchFlowState,
  WeeklyMatchStatus,
  SessionData,
} from "./types.js";
export { DEFAULT_SESSION, SUPPORTED_LANGUAGES, LANGUAGE_LABELS } from "./types.js";
export {
  normalizeProfileMedia,
  parseProfileMediaItem,
  profileLivePhotoMedia,
  profilePhotoMedia,
  profileVideoMedia,
  profileMediaHasVideo,
  staticPhotosFromProfileMedia,
} from "./profile-media.js";
export type {
  ProfileLivePhotoMedia,
  ProfileMedia,
  ProfilePhotoMedia,
  ProfileVideoMedia,
} from "./profile-media.js";
export { isUniversityEmail, generateOtp } from "./email.js";
export { isE164, normalizePhoneE164 } from "./phone.js";
export {
  STORE_INVOICE_PREFIX,
  buildStoreInvoicePayload,
  parseStoreInvoicePayload,
  GATE_INVOICE_PREFIX,
  buildGateInvoicePayload,
  parseGateInvoicePayload,
  type GateInvoiceScope,
  VENUE_INVOICE_PREFIX,
  buildVenueInvoicePayload,
  parseVenueInvoicePayload,
  type VenueInvoiceMode,
} from "./stars.js";
export {
  MAGIC_CONTEXT_PROMPT,
  VOICE_CORE,
  magicContextPrompt,
  parseLLMDumpPrompt,
  pitchAndSynergyPrompt,
  proposeSchedulingPrompt,
  venueSelectionPrompt,
  generateIceBreakersPrompt,
  generateWingmanHintPrompt,
  generateVenueBlurbPrompt,
  parseRejectionFeedbackPrompt,
  parsePostDateFeedbackPrompt,
  parseReportTriagePrompt,
} from "./ai/prompts.js";
export type {
  ParseLLMDumpInput,
  PitchAndSynergyInput,
  ProposeSchedulingInput,
  VenueSelectionInput,
  IceBreakersInput,
  WingmanHintInput,
  VenueBlurbInput,
  RejectionFeedbackInput,
  PostDateFeedbackInput,
  ReportTriageInput,
} from "./ai/prompts.js";
