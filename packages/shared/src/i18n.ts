import type { Language } from "./types.js";

const translations = {
  en: {
    // --- Onboarding ---
    consentMessage:
      "Welcome to Gennety Dating!\n\n" +
      "Before we begin, please review our Privacy Policy and agree to our data retention terms.",
    consentAgree: "I Agree",
    welcome: "Gennety Dating 👀\nAI matchmaking built for students.",
    chooseLanguage: "Pick your language:",
    philosophyPitch:
      "Gennety runs on one idea: *Zero Chat*.\n\n" +
      "You never message your match. Our AI gets who you are, " +
      "finds someone actually compatible, and handles everything — time, place, the whole thing.\n\n" +
      "You just show up. Sound good?",
    philosophyContinue: "I'm in 🚀",
    askEmail: "Drop your uni email (like name@stanford.edu):",
    invalidEmail: "Hmm, that doesn't look like a uni email. Try your .edu or .ac.uk address.",
    otpSent: "Sent a 6-digit code to *{email}*. Drop it here:",
    otpInvalid: "That code didn't work. Try again:",
    otpExpired: "Code expired. Enter your email again:",
    otpTooManyAttempts: "Too many tries. Enter your email again for a fresh code.",
    otpCooldown: "Hold on — wait a minute before requesting a new code.",
    emailVerified: "Email confirmed ✅",
    askFirstName: "What's your name?",
    askSurname: "And your last name?",
    askAge: "How old are you?",
    invalidAge: "Enter an age between {min} and {max}.",
    askGender: "What's your gender?",
    askPreference: "Who are you into?",
    btnMale: "Male",
    btnFemale: "Female",
    btnMen: "Men",
    btnWomen: "Women",
    btnBoth: "Both",
    llmAnalysing1: "Reading your profile... 🧠",
    llmAnalysing2: "Pulling out personality traits...",
    llmAnalysing3: "Building your psychological fingerprint...",
    llmDumpReceived: "Profile ready ✨",
    askPhotos: "Almost done! Send {min}–{max} photos of yourself. One at a time.",
    photoReceived: "Photo {n}/{max} ✅",
    photoRejected:
      "I need a clear photo of just *you* — one person, face visible.\n\n" +
      "No memes, no landscapes, no group shots. Try another one.",
    photoVisionError:
      "Couldn't process that photo. Try sending it again in a sec.",
    livePhotoMissingStatic:
      "That Live Photo is missing its still frame, so I can't verify it. Send it as a regular photo or choose another Live Photo.",
    livePhotoTooLong:
      "Live Photos need to be 10 seconds or shorter. Send a shorter one or a regular photo.",
    livePhotoTooLarge:
      "Live Photos need to be 10 MB or smaller. Send a smaller one or a regular photo.",
    videoTooLong:
      "Profile videos need to be 60 seconds or shorter. Send a shorter clip.",
    videoTooLarge:
      "Profile videos need to be 50 MB or smaller. Send a smaller clip.",
    ticketRewardPhoto:
      "🎟️ Nice — you just earned a *free Date Ticket*!\n\nHere's the deal: every date you go on costs 1 ticket, and tickets normally cost money. Adding photos got you one on the house. Balance: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ A profile video — love it! That's another *free Date Ticket*.\n\nEach date costs 1 ticket (normally paid), so you're set for your next one. Balance: *{balance}* 🎟️",
    menuMyTickets: "🎟️ My Tickets",
    ticketWalletText:
      "🎟️ *My Tickets*\n\nYou have *{balance}* ticket(s). Each date costs 1 ticket — buy more anytime.",
    ticketWalletOpenStore: "🎟️ Buy tickets",
    photosEnough: "You can send more (up to {max}) or hit the button to continue.",
    photosDone: "Photos uploaded ✅",
    profileReview:
      "Here's your profile:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Look good?",
    profileConfirm: "Looks good ✅",
    profileEdit: "Change something",
    onboardingComplete:
      "You're in! 🎉\n\n" +
      "Our AI is already looking for your match. " +
      "I'll hit you up as soon as someone special comes along.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Continue ➡️",
    finishOnboardingFirst:
      "Finish registration first, then the menu and settings will be available.\nType /start to continue.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "Final step. We need to confirm you're a real person.\n\n" +
      "We compare the selfie captured during verification with every photo in your profile. " +
      "Photos that don't match you will be rejected.\n\n" +
      "Skipping verification will significantly lower your starting ELO rating, " +
      "and the algorithm will surface fewer matches for you.",
    verifyBtnGo: "🟢 Verify now",
    verifyBtnCheck: "✅ I've finished verification",
    verifyBtnSkip: "⚪️ Skip for now",
    verifySkipNudgeCaption:
      "One sec — listen to this before you skip 👆",
    verifyBtnReconsider: "🟢 OK, I'll verify",
    verifyBtnSkipConfirm: "⚪️ Skip anyway",
    verifySkipped:
      "Skipped verification. You can run it later from the profile menu " +
      "to restore your ELO rating.",
    verifyCheckPending:
      "🔍 Persona has your verification but is still processing it. " +
      "Give it a minute and tap the button again.",
    verifyCheckNoInquiry:
      "I don't see a verification attempt yet. Tap 🟢 Verify now first, " +
      "complete the flow, then come back and tap this button.",
    verifyCheckPersonaFailed:
      "❌ Verification didn't pass on Persona's side. Tap 🟢 Verify now " +
      "to try again.",
    verifyCheckAlreadyDone:
      "Already processed — you should have gotten the result message above. " +
      "If something looks wrong, tap 🟢 Verify now to retry.",
    verifyCheckInfraError:
      "Couldn't reach the verification service just now. Try again in a moment.",
    verifyOutcomeVerified:
      "✅ Verification complete — your profile is live. I'll reach out when I find a match.",
    verifyOutcomePendingReview:
      "🔍 We're double-checking your profile photos against your verification selfie. This usually takes a few hours — I'll message you the moment it's done.",
    verifyOutcomeRejected:
      "⚠️ The photos in your profile don't appear to match the selfie we captured during verification. Please replace them with clear photos of yourself, then open Settings → Verify your account to retry.",
    verifyAutoPollStarted:
      "✨ Got it. Grab a coffee ☕ — I'm cross-checking your selfie against your profile photos. " +
      "Should take a minute or two.",
    verifyAutoPollTimeout:
      "Hmm, taking longer than usual. Tap the button below when you want me to check again.",
    verifyAutoPollPersonaFailed:
      "Verification didn't pass on Persona's side. Tap 🟢 Verify now to retry.",
    verifyAutoPollInfraError:
      "Couldn't reach the verification service. Try again in a moment.",
    // Persona Embedded Mini App copy (verification.html)
    verifyMiniAppLoading: "Opening verification…",
    verifyMiniAppFinishing: "Almost done. Checking results…",
    verifyMiniAppError:
      "Couldn't start verification. Please try again.",
    verifyMiniAppCloseBtn: "Close",
    photoMatchMismatch:
      "⚠️ This photo doesn't match your verification selfie. " +
      "Please upload a clear photo of yourself, taken under similar lighting.",

    // --- Main Menu ---
    menuTitle: "🎓 *Gennety Menu*\nWhat's up?",
    menuMyProfile: "👤 My Profile",
    menuEdit: "✏️ Edit Profile",
    menuPause: "⏸ Pause Matching",
    menuResume: "▶️ Resume Matching",
    menuSettings: "⚙️ Settings",
    menuHelp: "💬 Help",
    menuBack: "⬅️ Back",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_No bio yet._",

    // --- Edit Profile ---
    editProfileBody:
      "These are locked in:\n\n" +
      "• *Name:* {firstName} {surname}\n" +
      "• *Age:* {age}\n" +
      "• *University:* {university}\n\n" +
      "You can edit:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Search Prefs",
    editMajorBtn: "🎓 Major",
    editProfilePhotosBtn: "📸 Re-upload Photos",
    editBioPrompt: "Send your new bio (max 500 chars):",
    editBioTooLong: "Too long — keep it under 500.",
    editBioSaved: "Bio updated ✅",
    editMajorPrompt: "What's your major? (max 100 chars):",
    editMajorTooLong: "Too long — keep it under 100.",
    editMajorSaved: "Major updated ✅",
    editPrefsTitle: "🔍 *Search Prefs*\n\nWhat do you want to change?",
    editPrefsAgeBtn: "🎂 Age Range",
    editPrefsBack: "⬅️ Back to Edit",
    editAgeRangePrompt: "What age range? (e.g. 20-28)\nMin: {min}, Max: {max}.",
    editAgeRangeInvalid: "Didn't get that. Two numbers like 20-28 (range {min}–{max}).",
    editAgeRangeSaved: "Age range updated ✅",
    editProfilePhotosStart: "Send new photos ({min}–{max}). One at a time.",
    editProfilePhotosSaved: "Photos updated ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Matching paused ⏸\nNo new matches until you resume.",
    resumeConfirmed: "Matching back on ▶️\nOur AI is on it.",

    // --- Settings ---
    settingsTitle: "⚙️ Settings",
    settingsLanguage: "🌐 Language",
    settingsLanguagePick: "Pick a language:",
    settingsLanguageSaved: "Language updated ✅",
    settingsVerify: "🛡 Verify your account",
    settingsVerifyNotNeeded: "You're already verified ✅",
    settingsVerifyUnavailable:
      "Verification is temporarily unavailable. Please try again later.",
    helpBody:
      "*Need help?* 💬\n\n" +
      "We don't do chats between users — that's by design. " +
      "Got an issue with a match, date, or the bot? Hit up support:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Delete Account",
    deleteAccountConfirm:
      "You sure? This will *permanently delete* your account.\n\n" +
      "Everything goes — profile, photos, matches, embeddings. " +
      "*Can't undo this.*",
    deleteAccountYes: "Yes, delete everything",
    deleteAccountNo: "Cancel",
    deleteAccountDone:
      "Account deleted. All data wiped.\n" +
      "Want to come back? Just send /start.",

    // --- Matching ---
    matchHeadline: "💘 Found you a match!",
    matchDeadlineNotice:
      "You've got 24h to reply. " +
      "Once you tap — *the decision is final*. No take-backs.",
    matchStreamStart: "Figuring out why you two click…",
    matchBtnAccept: "✅ Accept",
    matchBtnDecline: "❌ Pass",
    matchAccepted: "Nice! Waiting on the other person…",
    matchBothAccepted: "It's mutual 🔥 Let's find a time.",
    matchDeclined:
      "All good. What was the main reason you passed?\n\n" +
      "Pick one below, or send a short text or voice note. The AI will analyze it and use it for the next drop.\n\n" +
      "If it's something else, tell us - next time, we'll suggest someone who better fits your interests and preferences.",
    matchDeclineReasonType: "Not my type",
    matchDeclineReasonVibe: "Different vibe",
    matchDeclineReasonInterests: "Interests don't match",
    matchDeclineReasonLifestyle: "Lifestyle mismatch",
    matchDeclineReasonOther: "Something else",
    matchDeclineOtherAsk:
      "Sure - send a short text or voice note with the reason. The AI will analyze it and use it for the next drop.",
    matchDeclineFeedbackSaved:
      "Got it. We'll use this to tune your next recommendations 🎯",
    matchDeclineAlreadyNoted: "Already noted - thanks.",
    matchDeclineFeedbackFailed:
      "Couldn't save that right now. You can still send a short text or voice note.",
    matchDeclineThanks: "Noted. We'll keep looking 🎯",
    matchPeerDecided:
      "Your match has already given their answer. Your turn.\n\n" +
      "*What* they chose — you'll see only after you reply yourself. " +
      "And remember: your reply is final.",
    matchPeerWasAccepted: "FYI — your match was in. Just didn't line up this time.",
    matchPeerWasDeclined: "FYI — your match passed this time.",
    matchAcceptedPeerDeclined:
      "Unfortunately, your match didn't agree to meet. " +
      "That's okay. In Gennety, dates only happen when the interest is mutual. " +
      "We'll keep looking for a more relevant match.",
    matchAcceptedPeerDeclinedPriority:
      "Unfortunately, your match didn't agree to meet. " +
      "That's okay. In Gennety, dates only happen when the interest is mutual.\n\n" +
      "We've boosted your priority for next Thursday so you have a better chance to have a genuinely pleasant evening.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Verified",
    matchVerifiedQuote:
      "We verified this person. They passed our face-match check — " +
      "the photos in this profile match their real identity and belong to them.",
    matchSynergyHeader: "💎 *Synergy {score}/99* — {reason}",
    pitchCountdownHours: "⏳ {hours}h left to reply",
    pitchCountdownMinutes: "⏳ {minutes} min left to reply",
    pitchExpired: "⏳ Time's up — this proposal expired.",
    matchExpiredSilentWarning:
      "Time's up — you didn't reply to your match in 24h. " +
      "Wait for next Thursday's drop.\n\n" +
      "Please don't ignore proposals — it's disrespectful to your partner. " +
      "Next time we'll lower your rating for this.",
    matchExpiredSilentPenalty:
      "Time's up — you didn't reply to your match in 24h. " +
      "Wait for next Thursday's drop.\n\n" +
      "Your rating has been lowered for ignoring the proposal — it's disrespectful to your partner.",
    matchExpiredYouMissedDate:
      "Heads up — your match was actually in. You missed a real date.\n\n",
    matchExpiredPeerIgnored:
      "Your match didn't reply within 24h, so the date won't happen. " +
      "We'll see you in next week's drop.",
    matchStandbyStatus:
      "STATUS: STANDBY\n\n" +
      "We don't compromise on quality. There isn't a high-synergy match for you this week.\n\n" +
      "Your priority for next week's drop has been boosted.",
    noMatchThisWeekTier1:
      "Hey 💫\n\n" +
      "This week our matchmaker couldn't find you a partner who actually meets our quality bar — " +
      "and we'd rather wait than pair you with someone who isn't worth your time.\n\n" +
      "A few honest things to know:\n" +
      "• We're growing the community fast and refining the matchmaking algorithm every day.\n" +
      "• A truly fitting partner should arrive in one of the next drops.\n" +
      "• Every date we set up is *fully on us* — coffee, dinner, the whole thing. ☕️🎬\n\n" +
      "See you next Thursday at 18:00 ✨",
    noMatchThisWeekTier2:
      "Hey 🌿\n\n" +
      "Second week running and our matchmaker still hasn't found anyone we'd be excited to introduce you to. " +
      "Thank you for your patience — it means a lot.\n\n" +
      "What we want you to know:\n" +
      "• We're actively bringing more students like you into the community and tuning the algorithm in your favour.\n" +
      "• A genuinely great partner should be just a few drops away.\n" +
      "• When that date happens, it's *fully covered by us* — that doesn't change.\n\n" +
      "See you next Thursday at 18:00 — we're working for you 🤍",
    noMatchThisWeekTier3:
      "Hey ✨\n\n" +
      "We owe you another honest update — still no partner that's truly worth your time. " +
      "We hate this even more than you do, and we're not going to pretend otherwise.\n\n" +
      "What's actually happening on our side:\n" +
      "• We're personally watching your queue and pushing the community to grow in your area.\n" +
      "• The right person will land in one of the coming drops — we won't stop until they do.\n" +
      "• Your date — whenever it happens — is *fully on us*. That's our promise.\n\n" +
      "Thank you for trusting us. See you Thursday at 18:00 🤍",
    matchScheduleProposal:
      "How about one of these? Tap what works:",
    matchScheduleIter3:
      "Open the calendar, pick dates, then mark every time that works for you. Your match sees them live and can lock in the date with one tap.",
    matchScheduleBtnCalendar: "📅 Open Calendar",
    // --- Date Ticket (premium post-accept gate) ---
    ticketCardCaption:
      "It's mutual 🔥\n\nOne last step before you plan: claim your *Date Ticket* — a curated, verified, zero-drama first date. Tap below to open it.",
    ticketButton: "🎟️ Get your date ticket",
    ticketBothSecuredDm: "Both tickets secured 🎟️✨ Your date is on — let's pick a time.",
    ticketPartnerPaidDm: "{name} already covered your date ticket ❤️ You're all set — nothing to pay.",
    ticketRefundedDm:
      "Your match didn't grab their ticket in time, so we've refunded yours. No worries — we've opened scheduling for free. Let's find a time 📅",
    matchScheduleNoOverlap:
      "No overlap yet — next round.",
    matchScheduled: "Locked in! {venue} — see you there 🤝",
    matchScheduledBtnOpenMaps: "📍 Open in Maps",
    matchSchedulePickedPrefix: "You picked: ",
    matchScheduleWaitingPeer: "Waiting on the other person…",
    matchSchedulePeerProposed:
      "Your match marked dates and times in the calendar. Open it to confirm one or suggest your own:",
    matchSchedulePeerSuggestedAlternative:
      "Your match suggested a different time. Check their answer: you can agree with it or suggest your own.",
    matchScheduleSavedConfirmation:
      "✅ Saved your dates and times. We pinged your match — I'll let you know the moment they reply.",
    matchScheduleNoOverlapYet:
      "You both marked dates and times, but none overlap. Open the calendar and add a few more — we'll lock it in as soon as one slot matches:",
    venueConciergeIntro:
      "Time's locked 🗓️ Last step — let's nail the place.\n\n" +
      "Tell me the *vibe* (e.g. _quiet cafe_, _vegan spot_, _park walk_, _small museum_), " +
      "then tap *Pick on map* below to choose where you'll be coming from " +
      "(metro, address, friend's place — anything works).",
    venueConciergeBtnLocation: "📍 Send my location",
    venueConciergeBtnMap: "🗺️ Pick on map",
    venueVibeNoted: "Vibe noted ✅ Now pick where you'll be coming from:",
    venueLocationNoted:
      "Location saved ✅ Now tell me the *vibe* — e.g. _quiet cafe_, _vegan brunch_, _park walk_.",
    venueSafetyOverride:
      "Heads up — picked a public café instead. We keep first dates in public spots.",
    venueWaitingPeer: "Got yours ✅ Waiting on the other person…",
    venueSearching: "Searching for the perfect spot between you two… 🔍",
    venueSearchStep2: "📍 Comparing routes and travel time for you both…",
    venueSearchStep3: "✨ Picking the best spot for your vibe…",
    onbAnalyzeStep1: "🧠 Reading your context…",
    onbAnalyzeStep2: "🧩 Extracting your key traits and values…",
    onbAnalyzeStep3: "🧮 Building your psychological profile…",
    verifyAnalyzeStep1: "🔍 Matching your selfie against your photos…",
    verifyAnalyzeStep2: "🧬 Analyzing facial features…",
    verifyAnalyzeStep3: "⏳ Finalizing the check…",
    skipAnalyzeStep1: "✨ Got it. Finishing your profile…",
    skipAnalyzeStep2: "🧮 Finalizing your psychological profile…",
    skipAnalyzeStep3: "💞 Getting you ready for the weekly matching…",
    profilerBatchSaving: "🧩 Adding your answers to your profile…",
    profilerBatchSaved:
      "✅ Updated your preference notes — I'll factor this into the next match.",

    // --- Phase 3.7: Venue change (female-exclusive one-shot) ---
    venueChangeFemaleButton: "🔄 Change venue",
    venueChangeFemaleHint:
      "By the way — you have a one-time option to change this venue. " +
      "Tap *Change venue* above to pick another spot nearby. Your match will " +
      "have to confirm it, and you can only do this once.",
    venueChangeMaleIntro: "Your match would like to change the venue.",
    venueChangeMaleNewVenue: "New place: {venue}",
    venueChangeMaleComment: "Their note:",
    venueChangeMaleAsk:
      "Accept the new place, or decline. Declining cancels the date.",
    venueChangeBtnAccept: "✅ Accept new place",
    venueChangeBtnDecline: "❌ Decline (cancel date)",
    venueChangeDeclineConfirm:
      "Are you sure? If you don't accept the proposed place, your date and match " +
      "will be cancelled permanently — there's no undo.",
    venueChangeBtnConfirmCancel: "Yes, cancel the match",
    venueChangeBtnBack: "No, I changed my mind",
    venueChangeAcceptedFemale: "Your match accepted the new place! 🎉 {venue}",
    venueChangeAcceptedMaleAck: "Done — the venue is updated. {venue}",
    venueChangeCancelledFemale:
      "Your match didn't accept the new place, so the date was cancelled.",
    venueChangeCancelledMale: "The date has been cancelled.",
    venueChangeExpiredCancel:
      "The window to confirm the new place ran out, so the date was cancelled.",
    venueChangeAlreadyResolved: "This venue change has already been decided.",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Your date is in 5 hours! Some convo starters for you:\n\n",
    dateHintsIntro: "\n\n💡 A couple of tips to plan it:\n",
    profilerSkip: "Skip",
    wingmanHintIntro:
      "👋 Insider tip — your date's in 90 minutes:\n\n",
    emergencyUnlocked:
      "Emergency cancel window is open.\n" +
      "If you really can't make it, tap below.\n" +
      "*You'll need to write a reason — it gets forwarded to your match exactly as you write it.*",
    emergencyBtn: "🚨 Cancel Date",
    emergencyConfirmPrompt:
      "Are you sure you want to cancel this date?\n" +
      "*This is final — once cancelled, the match can't be restored.*",
    emergencyBtnConfirm: "Yes, cancel the date",
    emergencyBtnBack: "No, keep the date",
    emergencyAborted: "Okay — your date is still on. 👍",
    emergencyAskReason:
      "Write your reason. This goes to your match *word for word*.",
    emergencyConfirmed:
      "Date cancelled. Your message was forwarded.",
    emergencyReceivedOther:
      "Your match cancelled the date. Here's what they said:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Your match cancelled the date. Here's what they wrote:",
    emergencyReceivedOtherSoftNote:
      "This isn't because of you. Gennety will raise your priority a little for next week.",
    feedbackInvitation:
      "How did your date go? ✨\n\n" +
      "Tell us a few things — chemistry, vibe, anything you'd change. " +
      "We'll use it to find someone even better for you next time.",
    feedbackBtnForm: "✍️ Open feedback form",
    feedbackBtnVoice: "🎤 Send voice instead",
    feedbackVoiceAsk:
      "Just record a voice note 🎙️\n\n" +
      "Tell us how the date went — was there chemistry? What did you like? " +
      "Anything that didn't work? A minute is plenty.",
    feedbackThanks: "Thanks for the feedback ✨ We'll use it to improve your future matches.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Report",
    reportAsk:
      "This report is private. What best describes the problem?",
    reportCategoryFakePhotos: "Fake or misleading photos",
    reportCategoryWrongPerson: "Wrong person in the photo",
    reportCategoryOffensive: "Offensive or disturbing behavior",
    reportCategoryUnsafe: "Unsafe / red flag",
    reportCategorySpam: "Spam or fraud",
    reportCategoryInappropriate: "Inappropriate profile",
    reportCategoryOther: "Other",
    reportDetailAsk:
      "Anything else that would help review this faster? You can type, send a voice note, or skip.",
    reportDetailAskOther:
      "Please briefly describe what happened. You can type or send a voice note.",
    reportSkipBtn: "Skip",
    reportThanksT1: "Got it — we'll use this to tune your future matches 🎯",
    reportThanksT2: "Reported. Thanks — we'll act on this.",
    reportThanksT3: "Reported. We're freezing their account for manual review — thanks for flagging.",
    reportFailed: "Couldn't process your report right now. Try again in a minute.",
    reportDuplicate: "You've already reported this match.",
    reportWarningStrike1:
      "⚠️ Heads up: we received a report about your recent match behavior. " +
      "Gennety expects respectful, reliable conduct. Another confirmed report will suspend your account.",
    reportSuspendedDM:
      "🚫 Your account has been suspended for 14 days due to repeated reports. " +
      "You won't receive matches during this period. It will auto-reactivate once the suspension ends.",
    reportBannedDM:
      "⛔ Your account has been permanently banned due to multiple confirmed reports.",
    reportPendingInvestigationDM:
      "🚫 Your account has been frozen pending a safety review. " +
      "Our team will contact you via @gennetysupport if further action is needed.",
    safetyNoteFemale:
      "Hey! Your Gennety date starts in 90 minutes at **{location_name}**.\n\n" +
      "We care about your safety, so while you're getting ready, a quick first-date checklist:\n\n" +
      "📍 **Stick to the plan.** We picked a safe public venue for you. Don't agree to move the meeting to a private location or go to someone's place.\n" +
      "🚗 **Transport.** Get there and back on your own — public transport, taxi, or walking works. Just don't get in a car with someone you barely know.\n" +
      "📱 **Tell someone close.** Forward the meeting details to a friend or family, and if possible share your live location for the evening.\n" +
      "☕ **Stay aware.** Try not to leave your belongings or drink unattended.\n" +
      "🛑 **Your boundaries.** If you feel uncomfortable or your date's behavior seems off — you have every right to just get up and leave at any moment. Your safety always beats politeness.\n\n" +
      "Have a great evening ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Next match in {d}d {h}h",
    statusHoursMinutes: "⏳ Matches drop in {h}h {m}m",
    statusMinutes: "🔥 Almost ready! Matches drop in {m}m",
    statusProcessing: "✨ Analyzing campus… Check back shortly.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Sorry, I couldn't hear that clearly — could you type it instead?",
    voiceTooLong:
      "That voice note's a bit long for me. Keep it under 5 minutes, or just type it out.",

    // --- Pre-date coordination (feature-flagged) ---
    coordOfferIntro:
      "Your date is in about an hour 🕐\n\n" +
      "Want a way to find each other at the spot — flag a delay, or say where you're sitting? Pick one:",
    coordOfferNoContactNote:
      "Your date is in about an hour 🕐\n\n" +
      "Heads up: your match has no public Telegram username, so direct contact isn't possible. You can still use a private anonymous chat through me:",
    coordBtnShareSelf: "📲 Share my Telegram",
    coordBtnRequestPartner: "🙋 Ask them for theirs",
    coordBtnProxy: "🕶 Anonymous chat",
    coordSharedToPartner:
      "Your date shared their Telegram so you can find each other 💬\n\n" +
      "{name}: {link}\n\nTap to say hi — see you there!",
    coordRequestAck: "On it — I've asked them. I'll ping you the moment they say yes ✅",
    coordPartnerAskApprove:
      "Your date in ~1h would love a way to find you at the spot 💬\n\n" +
      "Share your Telegram with {name}?",
    coordPartnerBtnApprove: "✅ Share my Telegram",
    coordPartnerBtnDecline: "Not now",
    coordRevealToInitiator:
      "{name} shared their Telegram so you can find each other 💬\n\n" +
      "{link}\n\nTap to say hi — have a great date!",
    coordPartnerDeclined:
      "Your match would rather not share contacts right now — no worries. The anonymous chat opens ~30 min before, if you'd like to use that instead.",
    coordProxyOpenedEnterPrompt:
      "Your anonymous chat is open 🕶\n\n" +
      "Messages go through me — no contacts shared. Use it to find each other or flag a delay. It closes a couple hours after the date.",
    coordEnterBtn: "💬 Enter chat",
    coordExitBtn: "❌ Leave chat",
    coordReportBtn: "🚨 Report",
    coordChatEntered:
      "You're in the anonymous chat 🕶 Just type — I'll pass it along. Leave any time.",
    coordChatExited: "Left the chat. Type /menu any time.",
    coordProxyRelayPrefix: "💬 Your date: ",
    coordProxyTextOnly: "Only text messages work in this chat — photos and voice notes aren't passed on.",
    coordProxyClosed: "The anonymous chat has closed. Hope the date went well — I'll check in tomorrow ✨",
    coordAlreadyChosen: "You've already picked a coordination option for this date.",
    coordSharedAck: "Done — they can find you now 💬 Have a great date!",
    coordProxyChosenAck:
      "Got it 🕶 Your anonymous chat opens about 30 minutes before the date — I'll send you the button then.",
  },
  ru: {
    // --- Onboarding ---
    consentMessage:
      "Добро пожаловать в Gennety Dating!\n\n" +
      "Перед началом ознакомьтесь с нашей Политикой конфиденциальности и примите условия хранения данных.",
    consentAgree: "Согласен",
    welcome: "Gennety Dating 👀\nAI-мэтчмейкинг для студентов.",
    chooseLanguage: "Выбери язык:",
    philosophyPitch:
      "Gennety работает по одному принципу: *Zero Chat*.\n\n" +
      "Ты не пишешь мэтчу. Наш ИИ разбирается, кто ты, " +
      "находит реально совместимого человека и берёт на себя всё — время, место, всю логистику.\n\n" +
      "Тебе только прийти. Заходишь?",
    philosophyContinue: "Го! 🚀",
    askEmail: "Скинь свою универскую почту (типа name@msu.edu.ru):",
    invalidEmail: "Хм, не похоже на универскую почту. Нужен адрес .edu / .ac.uk.",
    otpSent: "Код из 6 цифр улетел на *{email}*. Скинь сюда:",
    otpInvalid: "Не тот код. Попробуй ещё:",
    otpExpired: "Код протух. Введи почту заново:",
    otpTooManyAttempts: "Слишком много попыток. Введи почту заново — пришлём новый код.",
    otpCooldown: "Подожди минутку перед повторной отправкой.",
    emailVerified: "Почта подтверждена ✅",
    askFirstName: "Как тебя зовут?",
    askSurname: "Фамилия?",
    askAge: "Сколько тебе лет?",
    invalidAge: "Введи возраст от {min} до {max}.",
    askGender: "Твой пол?",
    askPreference: "Кто тебе интересен?",
    btnMale: "Мужчина",
    btnFemale: "Женщина",
    btnMen: "Мужчины",
    btnWomen: "Женщины",
    btnBoth: "Оба",
    llmAnalysing1: "Читаю твой профиль... 🧠",
    llmAnalysing2: "Вытягиваю черты характера...",
    llmAnalysing3: "Собираю психологический портрет...",
    llmDumpReceived: "Профиль готов ✨",
    askPhotos: "Почти всё! Скинь {min}–{max} фото. По одному.",
    photoReceived: "Фото {n}/{max} ✅",
    photoRejected:
      "Нужно чёткое фото *только тебя* — одного человека, лицо видно.\n\n" +
      "Без мемов, пейзажей и групповых. Скинь другое.",
    photoVisionError:
      "Не получилось обработать фото. Попробуй ещё раз через секунду.",
    livePhotoMissingStatic:
      "В этом Live Photo нет статичного кадра, поэтому я не смогу его проверить. Скинь обычное фото или другое Live Photo.",
    livePhotoTooLong:
      "Live Photo должно быть не длиннее 10 секунд. Скинь короче или обычное фото.",
    livePhotoTooLarge:
      "Live Photo должно быть не больше 10 МБ. Скинь файл поменьше или обычное фото.",
    videoTooLong:
      "Видео для профиля должно быть не длиннее 60 секунд. Скинь покороче.",
    videoTooLarge:
      "Видео для профиля должно быть не больше 50 МБ. Скинь поменьше.",
    ticketRewardPhoto:
      "🎟️ Класс — ты только что получил *бесплатный билет на свидание*!\n\nКак это работает: каждое свидание стоит 1 билет, и обычно билеты платные. За добавленные фото — один в подарок. Баланс: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ Видео в профиле — супер! Вот ещё *бесплатный билет на свидание*.\n\nКаждое свидание стоит 1 билет (обычно платный), так что на следующее ты готов. Баланс: *{balance}* 🎟️",
    menuMyTickets: "🎟️ Мои билеты",
    ticketWalletText:
      "🎟️ *Мои билеты*\n\nУ тебя *{balance}* билет(ов). Каждое свидание стоит 1 билет — докупить можно в любой момент.",
    ticketWalletOpenStore: "🎟️ Купить билеты",
    photosEnough: "Можешь скинуть ещё (до {max}) или жми кнопку.",
    photosDone: "Фото загружены ✅",
    profileReview:
      "Вот твой профиль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Всё ок?",
    profileConfirm: "Всё ок ✅",
    profileEdit: "Поменять",
    onboardingComplete:
      "Ты в деле! 🎉\n\n" +
      "Наш ИИ уже ищет тебе пару. " +
      "Напишу, как только найду кого-то стоящего.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Дальше ➡️",
    finishOnboardingFirst:
      "Сначала заверши регистрацию — тогда меню и настройки станут доступны.\nНапиши /start, чтобы продолжить.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "Финальный шаг. Нам нужно убедиться, что вы реальный человек.\n\n" +
      "Селфи, которое мы сделаем во время верификации, мы сравним с каждой фотографией в вашем профиле. " +
      "Фото, на которых не вы, будут отклонены.\n\n" +
      "Отказ от верификации значительно снизит ваш стартовый ELO-рейтинг, " +
      "и алгоритм будет предлагать вам меньше встреч.",
    verifyBtnGo: "🟢 Пройти верификацию",
    verifyBtnCheck: "✅ Я прошёл проверку",
    verifyBtnSkip: "⚪️ Пропустить пока",
    verifySkipNudgeCaption:
      "Секунду — послушай это, прежде чем пропустить 👆",
    verifyBtnReconsider: "🟢 Всё-таки пройти верификацию",
    verifyBtnSkipConfirm: "⚪️ Всё равно пропустить",
    verifySkipped:
      "Верификация пропущена. Можешь пройти её позже из меню профиля, " +
      "чтобы вернуть ELO-рейтинг.",
    verifyCheckPending:
      "🔍 Persona получила твою верификацию, но ещё обрабатывает её. " +
      "Подожди минуту и нажми кнопку ещё раз.",
    verifyCheckNoInquiry:
      "Пока не вижу попытки верификации. Сначала нажми 🟢 Пройти верификацию, " +
      "пройди флоу, потом возвращайся и нажми эту кнопку.",
    verifyCheckPersonaFailed:
      "❌ Верификация не прошла на стороне Persona. Нажми 🟢 Пройти верификацию, " +
      "чтобы попробовать ещё раз.",
    verifyCheckAlreadyDone:
      "Уже обработано — сообщение с результатом должно быть выше. " +
      "Если что-то пошло не так — нажми 🟢 Пройти верификацию ещё раз.",
    verifyCheckInfraError:
      "Не получилось достучаться до сервиса верификации. Попробуй ещё раз через минуту.",
    verifyOutcomeVerified:
      "✅ Верификация пройдена — профиль активен. Напишу, как только найду подходящий метч.",
    verifyOutcomePendingReview:
      "🔍 Мы дополнительно проверяем фото профиля по селфи из верификации. Обычно это занимает несколько часов — я напишу, как только проверка завершится.",
    verifyOutcomeRejected:
      "⚠️ Фото в профиле не совпали с селфи из верификации. Замени их на чёткие фотографии себя, затем открой Настройки → Верифицировать аккаунт и попробуй ещё раз.",
    verifyAutoPollStarted:
      "✨ Принято. Хватай кофе ☕ — я сверяю твоё селфи с фото из профиля. " +
      "Это займёт минуту-две.",
    verifyAutoPollTimeout:
      "Хм, дольше обычного. Нажми кнопку ниже, когда захочешь, чтобы я проверил ещё раз.",
    verifyAutoPollPersonaFailed:
      "Верификация не прошла на стороне Persona. Нажми 🟢 Пройти верификацию, чтобы попробовать ещё раз.",
    verifyAutoPollInfraError:
      "Не получилось достучаться до сервиса верификации. Попробуй ещё раз через минуту.",
    // Persona Embedded Mini App copy (verification.html)
    verifyMiniAppLoading: "Открываем верификацию…",
    verifyMiniAppFinishing: "Готово. Проверяем результат…",
    verifyMiniAppError:
      "Не удалось запустить проверку. Попробуйте ещё раз.",
    verifyMiniAppCloseBtn: "Закрыть",
    photoMatchMismatch:
      "⚠️ Это фото не совпадает с селфи из верификации. " +
      "Загрузи, пожалуйста, чёткое фото себя при похожем освещении.",

    // --- Main Menu ---
    menuTitle: "🎓 *Меню Gennety*\nЧто делаем?",
    menuMyProfile: "👤 Мой профиль",
    menuEdit: "✏️ Редактировать",
    menuPause: "⏸ Пауза",
    menuResume: "▶️ Искать",
    menuSettings: "⚙️ Настройки",
    menuHelp: "💬 Помощь",
    menuBack: "⬅️ Назад",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Описания пока нет._",

    // --- Edit Profile ---
    editProfileBody:
      "Это зафиксировано:\n\n" +
      "• *Имя:* {firstName} {surname}\n" +
      "• *Возраст:* {age}\n" +
      "• *Универ:* {university}\n\n" +
      "Можно поменять:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Параметры поиска",
    editMajorBtn: "🎓 Специальность",
    editProfilePhotosBtn: "📸 Обновить фото",
    editBioPrompt: "Скинь новое описание (до 500 символов):",
    editBioTooLong: "Слишком длинно — уложись в 500.",
    editBioSaved: "Bio обновлён ✅",
    editMajorPrompt: "Какая у тебя специальность? (до 100 символов):",
    editMajorTooLong: "Слишком длинно — уложись в 100.",
    editMajorSaved: "Специальность обновлена ✅",
    editPrefsTitle: "🔍 *Параметры поиска*\n\nЧто меняем?",
    editPrefsAgeBtn: "🎂 Возраст",
    editPrefsBack: "⬅️ К редактированию",
    editAgeRangePrompt: "Какой возраст? (напр. 20-28)\nМин: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не понял. Два числа через дефис, напр. 20-28 (от {min} до {max}).",
    editAgeRangeSaved: "Диапазон обновлён ✅",
    editProfilePhotosStart: "Скинь новые фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото обновлены ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Поиск на паузе ⏸\nНовых мэтчей не будет, пока не включишь.",
    resumeConfirmed: "Поиск запущен ▶️\nИИ уже работает.",

    // --- Settings ---
    settingsTitle: "⚙️ Настройки",
    settingsLanguage: "🌐 Язык",
    settingsLanguagePick: "Выбери язык:",
    settingsLanguageSaved: "Язык обновлён ✅",
    settingsVerify: "🛡 Пройти верификацию",
    settingsVerifyNotNeeded: "Ты уже верифицирован ✅",
    settingsVerifyUnavailable:
      "Верификация временно недоступна. Попробуй позже.",
    helpBody:
      "*Нужна помощь?* 💬\n\n" +
      "Чатов между юзерами у нас нет — это by design. " +
      "Проблема с мэтчем, свиданием или ботом? Пиши в саппорт:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Удалить аккаунт",
    deleteAccountConfirm:
      "Точно? Аккаунт будет *удалён навсегда*.\n\n" +
      "Всё пропадёт — профиль, фото, мэтчи, эмбеддинги. " +
      "*Это не откатить.*",
    deleteAccountYes: "Да, удалить всё",
    deleteAccountNo: "Отмена",
    deleteAccountDone:
      "Аккаунт удалён. Все данные стёрты.\n" +
      "Захочешь вернуться — отправь /start.",

    // --- Matching ---
    matchHeadline: "💘 Нашли тебе мэтч!",
    matchDeadlineNotice:
      "У тебя 24 часа на ответ. " +
      "Как только нажмёшь — *решение окончательное*. Изменить нельзя.",
    matchStreamStart: "Думаю, почему вы подходите…",
    matchBtnAccept: "✅ Принять",
    matchBtnDecline: "❌ Пас",
    matchAccepted: "Круто! Ждём ответа второй стороны…",
    matchBothAccepted: "Взаимно 🔥 Найдём время.",
    matchDeclined:
      "Ок, всё нормально. Что стало главной причиной?\n\n" +
      "Выбери вариант ниже или отправь короткий текст/голосовое. ИИ разберёт фидбэк и учтёт его в следующем дропе.\n\n" +
      "Если причина в чём-то другом - напиши: в следующий раз предложим человека, который лучше подходит под твои интересы и предпочтения.",
    matchDeclineReasonType: "Не мой тип",
    matchDeclineReasonVibe: "Не тот вайб",
    matchDeclineReasonInterests: "Не совпали интересы",
    matchDeclineReasonLifestyle: "Разный образ жизни",
    matchDeclineReasonOther: "Другая причина",
    matchDeclineOtherAsk:
      "Ок - отправь короткий текст или голосовое с причиной. ИИ разберёт это и учтёт в следующем дропе.",
    matchDeclineFeedbackSaved:
      "Принято. Учтём это в следующих рекомендациях 🎯",
    matchDeclineAlreadyNoted: "Уже записали - спасибо.",
    matchDeclineFeedbackFailed:
      "Не получилось сохранить прямо сейчас. Можешь всё равно отправить короткий текст или голосовое.",
    matchDeclineThanks: "Понял. Ищем дальше 🎯",
    matchPeerDecided:
      "Твой мэтч уже дал ответ. Твоя очередь.\n\n" +
      "*Что* именно он выбрал — увидишь только после своего ответа. " +
      "И помни: твой выбор окончательный.",
    matchPeerWasAccepted: "Кстати — твой мэтч был согласен. В этот раз просто не сошлось.",
    matchPeerWasDeclined: "Кстати — твой мэтч в этот раз отказался.",
    matchAcceptedPeerDeclined:
      "К сожалению, твой партнер не согласился на встречу. " +
      "Это нормально. В Gennety свидания случаются только при взаимном интересе. " +
      "Мы продолжаем искать для тебя более релевантный мэтч.",
    matchAcceptedPeerDeclinedPriority:
      "К сожалению, твой партнер не согласился на встречу. " +
      "Это нормально. В Gennety свидания случаются только при взаимном интересе.\n\n" +
      "Мы повысили твой приоритет на следующий четверг, чтобы у тебя было больше шансов провести по-настоящему приятный вечер.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Подтверждён",
    matchVerifiedQuote:
      "Мы проверили этого пользователя. Он успешно прошёл проверку лица, " +
      "что означает: фотографии в профиле соответствуют его личности и принадлежат лично ему.",
    matchSynergyHeader: "💎 *Синергия {score}/99* — {reason}",
    pitchCountdownHours: "⏳ Осталось {hours}ч на ответ",
    pitchCountdownMinutes: "⏳ Осталось {minutes} мин на ответ",
    pitchExpired: "⏳ Время вышло — предложение больше не актуально.",
    matchExpiredSilentWarning:
      "Время вышло — за сутки ты так и не ответил(-а) на мэтч. " +
      "Жди следующего четверга.\n\n" +
      "Пожалуйста, не игнорируй предложения — это неуважение к твоему партнёру. " +
      "В следующий раз за такое поведение мы снизим твой рейтинг.",
    matchExpiredSilentPenalty:
      "Время вышло — за сутки ты так и не ответил(-а) на мэтч. " +
      "Жди следующего четверга.\n\n" +
      "Твой рейтинг снижен за игнор — это неуважение к твоему партнёру.",
    matchExpiredYouMissedDate:
      "Важно: твой мэтч был согласен прийти — ты пропустил настоящее свидание.\n\n",
    matchExpiredPeerIgnored:
      "Партнёр не ответил в течение суток — свидание не состоится. " +
      "Увидимся в дропе на следующей неделе.",
    matchStandbyStatus:
      "STATUS: STANDBY\n\n" +
      "Мы не идём на компромиссы по качеству. На этой неделе для тебя нет мэтча с высокой синергией.\n\n" +
      "Твой приоритет на следующую неделю повышен.",
    noMatchThisWeekTier1:
      "Привет 💫\n\n" +
      "На этой неделе наш матчмейкер не нашёл для тебя пары, которая по-настоящему соответствовала бы нашему уровню качества — " +
      "и мы не готовы пускать «лишь бы было».\n\n" +
      "Несколько честных вещей:\n" +
      "• Мы активно расширяем сообщество и каждый день улучшаем алгоритм подбора партнёра.\n" +
      "• По-настоящему подходящий человек должен появиться в ближайшие дропы.\n" +
      "• Каждое свидание — *полностью за наш счёт*: кофе, ужин, всё. ☕️🎬\n\n" +
      "До следующего четверга в 18:00 ✨",
    noMatchThisWeekTier2:
      "Привет 🌿\n\n" +
      "Уже вторая неделя подряд, как наш матчмейкер не находит кого-то, кого мы были бы рады тебе показать. " +
      "Спасибо, что остаёшься с нами — это правда важно.\n\n" +
      "Что мы хотим сказать честно:\n" +
      "• Мы активно приводим новых студентов и настраиваем алгоритм под твои критерии.\n" +
      "• Действительно стоящий партнёр должен быть всего в нескольких дропах от тебя.\n" +
      "• Когда свидание случится — оно *полностью за наш счёт*, это не меняется.\n\n" +
      "До следующего четверга в 18:00 — мы работаем для тебя 🤍",
    noMatchThisWeekTier3:
      "Привет ✨\n\n" +
      "Должны снова быть честными — пары, которая правда стоит твоего времени, всё ещё нет. " +
      "Нам это не нравится даже сильнее, чем тебе, и мы не будем делать вид, что всё хорошо.\n\n" +
      "Что мы реально делаем:\n" +
      "• Лично следим за твоей очередью и подталкиваем рост сообщества в твоём районе.\n" +
      "• Тот самый человек обязательно появится в одном из ближайших дропов — мы не остановимся.\n" +
      "• Твоё свидание — когда бы оно ни случилось — *полностью за нами*. Это наше обещание.\n\n" +
      "Спасибо, что доверяешь. До четверга в 18:00 🤍",
    matchSchedulePeerProposed:
      "Твой собеседник уже отметил даты и время в календаре. Открой его, чтобы согласиться или предложить своё:",
    matchSchedulePeerSuggestedAlternative:
      "Твой собеседник предложил другое время. Проверь его ответ: ты можешь согласиться с предложением или предложить свой вариант.",
    matchScheduleSavedConfirmation:
      "✅ Сохранил твои даты и время. Пингнул собеседника — напишу, как только он(а) ответит.",
    matchScheduleNoOverlapYet:
      "Вы оба отметили даты и время, но варианты не пересеклись. Открой календарь и допиши несколько слотов — как только один совпадёт, я зафиксирую дату:",
    matchScheduleProposal: "Как тебе эти варианты? Жми подходящий:",
    matchScheduleIter3:
      "Открой календарь, выбери даты и отметь все удобные варианты времени. Собеседник увидит их вживую и сможет одним тапом согласиться на ваше общее время.",
    matchScheduleBtnCalendar: "📅 Открыть календарь",
    // --- Date Ticket (премиум-шаг после взаимного метча) ---
    ticketCardCaption:
      "Взаимно 🔥\n\nОстался один шаг перед планированием: получи свой *билет на свидание* — кураторское, проверенное свидание без лишней драмы. Нажми ниже, чтобы открыть.",
    ticketButton: "🎟️ Получить билет на свидание",
    ticketBothSecuredDm: "Оба билета у вас 🎟️✨ Свидание в силе — давай выберем время.",
    ticketPartnerPaidDm: "{name} уже оплатил твой билет на свидание ❤️ Тебе ничего не нужно делать.",
    ticketRefundedDm:
      "Собеседник не успел взять свой билет, поэтому твой мы вернули. Ничего страшного — открыли планирование бесплатно. Давай найдём время 📅",
    matchScheduleNoOverlap: "Не совпало — попробуем ещё.",
    matchScheduled: "Готово! {venue} — до встречи 🤝",
    matchScheduledBtnOpenMaps: "📍 Открыть в картах",
    matchSchedulePickedPrefix: "Ты выбрал: ",
    matchScheduleWaitingPeer: "Ждём выбор второй стороны…",
    venueConciergeIntro:
      "Время есть 🗓️ Последний шаг — выбираем место.\n\n" +
      "Напиши *вайб* (например _тихое кафе_, _веган_, _прогулка в парке_, _маленький музей_), " +
      "а потом нажми *Выбрать на карте* ниже — укажи метро, адрес или место друга, откуда поедешь.",
    venueConciergeBtnLocation: "📍 Отправить геолокацию",
    venueConciergeBtnMap: "🗺️ Выбрать на карте",
    venueVibeNoted: "Вайб записан ✅ Теперь укажи, откуда поедешь:",
    venueLocationNoted:
      "Место сохранено ✅ Теперь напиши *вайб* — например _тихое кафе_, _веган-бранч_, _прогулка в парке_.",
    venueSafetyOverride:
      "Небольшое уточнение — заменил на публичное кафе. Первые свидания у нас в людных местах.",
    venueWaitingPeer: "Принял ✅ Ждём вторую сторону…",
    venueSearching: "Ищу место, удобное обоим… 🔍",
    venueSearchStep2: "📍 Сверяю маршруты и время в пути для вас обоих…",
    venueSearchStep3: "✨ Выбираю лучшее место под вашу атмосферу…",
    onbAnalyzeStep1: "🧠 Читаю твой контекст…",
    onbAnalyzeStep2: "🧩 Выделяю ключевые черты и ценности…",
    onbAnalyzeStep3: "🧮 Собираю твой психологический профиль…",
    verifyAnalyzeStep1: "🔍 Сверяю селфи с твоими фотографиями…",
    verifyAnalyzeStep2: "🧬 Анализирую черты лица…",
    verifyAnalyzeStep3: "⏳ Завершаю проверку…",
    skipAnalyzeStep1: "✨ Принято. Завершаю сборку профиля…",
    skipAnalyzeStep2: "🧮 Финализирую твой психологический профиль…",
    skipAnalyzeStep3: "💞 Готовлю тебя к недельному подбору…",
    profilerBatchSaving: "🧩 Добавляю твои ответы в профиль…",
    profilerBatchSaved:
      "✅ Обновил твою карточку предпочтений — учту это при следующем подборе.",

    // --- Phase 3.7: Venue change (female-exclusive one-shot) ---
    venueChangeFemaleButton: "🔄 Сменить место",
    venueChangeFemaleHint:
      "Кстати — у тебя есть одноразовая возможность сменить это место. " +
      "Нажми *Сменить место* выше, чтобы выбрать другое заведение поблизости. " +
      "Партнёру нужно будет это подтвердить, и сделать так можно только один раз.",
    venueChangeMaleIntro: "Твоя пара хочет изменить место встречи.",
    venueChangeMaleNewVenue: "Новое место: {venue}",
    venueChangeMaleComment: "Объяснение партнёрши:",
    venueChangeMaleAsk:
      "Подтверди новое место или откажись. Отказ отменяет свидание.",
    venueChangeBtnAccept: "✅ Согласиться с новым местом",
    venueChangeBtnDecline: "❌ Не соглашаться (отменить свидание)",
    venueChangeDeclineConfirm:
      "Точно? Если ты не согласишься на предложенное место, свидание и метч будут " +
      "аннулированы навсегда — отменить это будет нельзя.",
    venueChangeBtnConfirmCancel: "Да, аннулировать метч",
    venueChangeBtnBack: "Нет, я передумал",
    venueChangeAcceptedFemale: "Партнёр согласился на новое место! 🎉 {venue}",
    venueChangeAcceptedMaleAck: "Готово — место обновлено. {venue}",
    venueChangeCancelledFemale:
      "Партнёр не согласился на новое место, поэтому свидание отменено.",
    venueChangeCancelledMale: "Свидание отменено.",
    venueChangeExpiredCancel:
      "Время на подтверждение нового места истекло, поэтому свидание отменено.",
    venueChangeAlreadyResolved: "Решение по смене места уже принято.",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Свидание через 5 часов! Вот темы для разговора:\n\n",
    dateHintsIntro: "\n\n💡 Пара советов, как всё спланировать:\n",
    profilerSkip: "Пропустить",
    wingmanHintIntro:
      "👋 Маленькая подсказка — свидание через полтора часа:\n\n",
    emergencyUnlocked:
      "Окно экстренной отмены открыто.\n" +
      "Совсем не можешь прийти — жми кнопку ниже.\n" +
      "*Нужна причина — она уйдёт мэтчу ровно так, как ты её напишешь.*",
    emergencyBtn: "🚨 Отменить свидание",
    emergencyConfirmPrompt:
      "Точно отменить это свидание?\n" +
      "*Это окончательно — после отмены вернуть мэтч уже нельзя.*",
    emergencyBtnConfirm: "Да, отменить свидание",
    emergencyBtnBack: "Нет, оставить свидание",
    emergencyAborted: "Хорошо — свидание остаётся в силе. 👍",
    emergencyAskReason:
      "Напиши причину. Текст уйдёт мэтчу *как есть*.",
    emergencyConfirmed:
      "Свидание отменено. Сообщение переслано.",
    emergencyReceivedOther:
      "Мэтч отменил свидание. Вот что написал:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Мэтч отменил свидание. Вот что написал:",
    emergencyReceivedOtherSoftNote:
      "Это не из-за тебя. Gennety немного поднимет твой приоритет на следующей неделе.",
    feedbackInvitation:
      "Как прошло свидание? ✨\n\n" +
      "Поделись парой штук — была ли химия, какой был вайб, что бы поменял. " +
      "Используем, чтобы в следующий раз найти кого-то ещё точнее.",
    feedbackBtnForm: "✍️ Открыть форму",
    feedbackBtnVoice: "🎤 Записать голосом",
    feedbackVoiceAsk:
      "Просто запиши голосовое 🎙️\n\n" +
      "Расскажи, как прошло — была ли химия, что зашло, что не очень. " +
      "Минуты вполне хватит.",
    feedbackThanks: "Спасибо за фидбэк ✨ Используем для улучшения.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Пожаловаться",
    reportAsk:
      "Эта жалоба приватная. Что лучше всего описывает проблему?",
    reportCategoryFakePhotos: "Фейковые или вводящие в заблуждение фото",
    reportCategoryWrongPerson: "На фото другой человек",
    reportCategoryOffensive: "Оскорбительное или тревожное поведение",
    reportCategoryUnsafe: "Небезопасно / красный флаг",
    reportCategorySpam: "Спам или мошенничество",
    reportCategoryInappropriate: "Неподходящий профиль",
    reportCategoryOther: "Другое",
    reportDetailAsk:
      "Есть что-то ещё, что поможет быстрее разобраться? Можно написать, отправить голосовое или пропустить.",
    reportDetailAskOther:
      "Пожалуйста, коротко опиши, что случилось. Можно написать или отправить голосовое.",
    reportSkipBtn: "Пропустить",
    reportThanksT1: "Принято — учтём в будущих мэтчах 🎯",
    reportThanksT2: "Жалоба зарегистрирована. Спасибо — разберёмся.",
    reportThanksT3: "Жалоба зарегистрирована. Замораживаем их аккаунт для ручной проверки — спасибо, что сообщил(а).",
    reportFailed: "Не получилось обработать жалобу. Попробуй через минуту.",
    reportDuplicate: "Ты уже жаловался(ась) на этот мэтч.",
    reportWarningStrike1:
      "⚠️ На тебя поступила жалоба по недавнему мэтчу. " +
      "Gennety ожидает уважительного и надёжного поведения. Ещё одна подтверждённая жалоба — и аккаунт будет временно заблокирован.",
    reportSuspendedDM:
      "🚫 Твой аккаунт заблокирован на 14 дней из-за повторных жалоб. " +
      "В этот период мэтчи приходить не будут. Автоматически разблокируется после окончания срока.",
    reportBannedDM:
      "⛔ Твой аккаунт заблокирован навсегда из-за многократных подтверждённых жалоб.",
    reportPendingInvestigationDM:
      "🚫 Твой аккаунт заморожен для проверки безопасности. " +
      "Команда свяжется через @gennetysupport, если потребуются дальнейшие действия.",
    safetyNoteFemale:
      "Привет! Твое свидание от Gennety начнется уже через полтора часа в **{location_name}**.\n\n" +
      "Мы заботимся о твоей безопасности, поэтому, пока ты собираешься, вот небольшая памятка для первой встречи:\n\n" +
      "📍 **Придерживайся плана.** Мы подобрали для вас безопасное публичное место. Не соглашайся переносить встречу в уединенную локацию или ехать в гости.\n" +
      "🚗 **Транспорт.** Добирайся до места и обратно самостоятельно любым удобным тебе способом (на общественном транспорте, такси или пешком). Главное — не садись в машину к малознакомому человеку.\n" +
      "📱 **Предупреди близких.** Перешли подруге или кому-то из близких детали этой встречи и, по возможности, расшарь свою геопозицию на вечер.\n" +
      "☕ **Контроль.** Старайся не оставлять свои вещи и напиток без присмотра.\n" +
      "🛑 **Твои границы.** Если тебе некомфортно или поведение партнера кажется странным — ты имеешь полное право просто встать и уйти в любой момент. Твоя безопасность всегда важнее вежливости.\n\n" +
      "Желаем отличного вечера и приятных впечатлений! ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Следующий мэтч через {d}д {h}ч",
    statusHoursMinutes: "⏳ Мэтчи прилетят через {h}ч {m}мин",
    statusMinutes: "🔥 Почти готово! Мэтчи прилетят через {m} мин",
    statusProcessing: "✨ Сканируем кампус… Загляни чуть позже.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не расслышал — можешь написать текстом?",
    voiceTooLong:
      "Голосовое слишком длинное. До 5 минут — или просто напиши текстом.",

    // --- Pre-date coordination (feature-flagged) ---
    coordOfferIntro:
      "Свидание примерно через час 🕐\n\n" +
      "Хочешь способ найти друг друга на месте — предупредить об опоздании или сказать, где сидишь? Выбери:",
    coordOfferNoContactNote:
      "Свидание примерно через час 🕐\n\n" +
      "Важно: у твоего мэтча нет публичного Telegram-юзернейма, поэтому обмен контактами невозможен. Но можно использовать анонимный чат через меня:",
    coordBtnShareSelf: "📲 Поделиться своим Telegram",
    coordBtnRequestPartner: "🙋 Попросить его контакт",
    coordBtnProxy: "🕶 Анонимный чат",
    coordSharedToPartner:
      "Твой мэтч поделился своим Telegram, чтобы вы нашли друг друга 💬\n\n" +
      "{name}: {link}\n\nНапиши пару слов — до встречи!",
    coordRequestAck: "Готово — я спросил. Сообщу сразу, как только согласятся ✅",
    coordPartnerAskApprove:
      "Твоему свиданию через ~1ч пригодится способ найти тебя на месте 💬\n\n" +
      "Поделиться своим Telegram с {name}?",
    coordPartnerBtnApprove: "✅ Поделиться Telegram",
    coordPartnerBtnDecline: "Не сейчас",
    coordRevealToInitiator:
      "{name} поделился своим Telegram, чтобы вы нашли друг друга 💬\n\n" +
      "{link}\n\nНапиши пару слов — хорошего свидания!",
    coordPartnerDeclined:
      "Твой мэтч пока не хочет делиться контактами — это окей. За ~30 минут до встречи откроется анонимный чат, если захочешь.",
    coordProxyOpenedEnterPrompt:
      "Анонимный чат открыт 🕶\n\n" +
      "Сообщения идут через меня — контакты не раскрываются. Используй его, чтобы найти друг друга или предупредить об опоздании. Закроется через пару часов после свидания.",
    coordEnterBtn: "💬 Войти в чат",
    coordExitBtn: "❌ Выйти из чата",
    coordReportBtn: "🚨 Пожаловаться",
    coordChatEntered:
      "Ты в анонимном чате 🕶 Просто пиши — я передам. Выйти можно в любой момент.",
    coordChatExited: "Вышел из чата. Напиши /menu в любой момент.",
    coordProxyRelayPrefix: "💬 Твоё свидание: ",
    coordProxyTextOnly: "В этом чате работают только текстовые сообщения — фото и голосовые не передаются.",
    coordProxyClosed: "Анонимный чат закрылся. Надеюсь, свидание прошло отлично — загляну завтра ✨",
    coordAlreadyChosen: "Ты уже выбрал способ координации для этого свидания.",
    coordSharedAck: "Готово — теперь тебя смогут найти 💬 Хорошего свидания!",
    coordProxyChosenAck:
      "Принято 🕶 Анонимный чат откроется примерно за 30 минут до свидания — тогда пришлю кнопку.",
  },
  uk: {
    // --- Onboarding ---
    consentMessage:
      "Ласкаво просимо до Gennety Dating!\n\n" +
      "Перш ніж почати, ознайомтеся з нашою Політикою конфіденційності та прийміть умови зберігання даних.",
    consentAgree: "Згоден",
    welcome: "Gennety Dating 👀\nAI-метчмейкінг для студентів.",
    chooseLanguage: "Обери мову:",
    philosophyPitch:
      "Gennety працює за одним принципом: *Zero Chat*.\n\n" +
      "Ти не пишеш метчу. Наш ШІ розбирається, хто ти, " +
      "знаходить реально сумісну людину і бере на себе все — час, місце, всю логістику.\n\n" +
      "Тобі лише прийти. Заходиш?",
    philosophyContinue: "Го! 🚀",
    askEmail: "Скинь свою університетську пошту (типу name@knu.edu.ua):",
    invalidEmail: "Хм, не схоже на університетську пошту. Потрібна адреса .edu / .ac.uk.",
    otpSent: "Код із 6 цифр полетів на *{email}*. Скинь сюди:",
    otpInvalid: "Не той код. Спробуй ще:",
    otpExpired: "Код протермінувався. Введи пошту знову:",
    otpTooManyAttempts: "Забагато спроб. Введи пошту знову — надішлемо новий код.",
    otpCooldown: "Зачекай хвилинку перед повторним надсиланням.",
    emailVerified: "Пошту підтверджено ✅",
    askFirstName: "Як тебе звати?",
    askSurname: "Прізвище?",
    askAge: "Скільки тобі років?",
    invalidAge: "Введи вік від {min} до {max}.",
    askGender: "Твоя стать?",
    askPreference: "Хто тобі цікавий?",
    btnMale: "Чоловік",
    btnFemale: "Жінка",
    btnMen: "Чоловіки",
    btnWomen: "Жінки",
    btnBoth: "Обидва",
    llmAnalysing1: "Читаю твій профіль... 🧠",
    llmAnalysing2: "Витягую риси характеру...",
    llmAnalysing3: "Збираю психологічний портрет...",
    llmDumpReceived: "Профіль готовий ✨",
    askPhotos: "Майже все! Скинь {min}–{max} фото. По одному.",
    photoReceived: "Фото {n}/{max} ✅",
    photoRejected:
      "Потрібне чітке фото *тільки тебе* — одна людина, обличчя видно.\n\n" +
      "Без мемів, пейзажів та групових фото. Скинь інше.",
    photoVisionError:
      "Не вдалося обробити фото. Спробуй ще раз через секунду.",
    livePhotoMissingStatic:
      "У цьому Live Photo немає статичного кадру, тому я не зможу його перевірити. Надішли звичайне фото або інше Live Photo.",
    livePhotoTooLong:
      "Live Photo має бути не довше 10 секунд. Надішли коротше або звичайне фото.",
    livePhotoTooLarge:
      "Live Photo має бути не більше 10 МБ. Надішли менший файл або звичайне фото.",
    videoTooLong:
      "Відео для профілю має бути не довше 60 секунд. Надішли коротше.",
    videoTooLarge:
      "Відео для профілю має бути не більше 50 МБ. Надішли менше.",
    ticketRewardPhoto:
      "🎟️ Клас — ти щойно отримав *безкоштовний квиток на побачення*!\n\nЯк це працює: кожне побачення коштує 1 квиток, і зазвичай квитки платні. За додані фото — один у подарунок. Баланс: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ Відео в профілі — супер! Ось ще *безкоштовний квиток на побачення*.\n\nКожне побачення коштує 1 квиток (зазвичай платний), тож на наступне ти готовий. Баланс: *{balance}* 🎟️",
    menuMyTickets: "🎟️ Мої квитки",
    ticketWalletText:
      "🎟️ *Мої квитки*\n\nУ тебе *{balance}* квиток(ів). Кожне побачення коштує 1 квиток — докупити можна будь-коли.",
    ticketWalletOpenStore: "🎟️ Купити квитки",
    photosEnough: "Можеш надіслати ще (до {max}) або тисни кнопку.",
    photosDone: "Фото завантажено ✅",
    profileReview:
      "Ось твій профіль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Все ок?",
    profileConfirm: "Все ок ✅",
    profileEdit: "Змінити",
    onboardingComplete:
      "Ти в грі! 🎉\n\n" +
      "Наш ШІ вже шукає тобі пару. " +
      "Напишу, як тільки знайду когось стоящого.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Далі ➡️",
    finishOnboardingFirst:
      "Спочатку заверши реєстрацію — тоді меню та налаштування стануть доступні.\nНапиши /start, щоб продовжити.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "Фінальний крок. Нам треба переконатися, що ти реальна людина.\n\n" +
      "Селфі, яке ми зробимо під час верифікації, ми порівняємо з кожним фото у твоєму профілі. " +
      "Фото, на яких не ти, буде відхилено.\n\n" +
      "Відмова від верифікації суттєво знизить твій стартовий ELO-рейтинг, " +
      "і алгоритм пропонуватиме тобі менше зустрічей.",
    verifyBtnGo: "🟢 Пройти верифікацію",
    verifyBtnCheck: "✅ Я пройшов перевірку",
    verifyBtnSkip: "⚪️ Пропустити поки",
    verifySkipNudgeCaption:
      "Секунду — послухай це, перш ніж пропустити 👆",
    verifyBtnReconsider: "🟢 Все ж таки пройти верифікацію",
    verifyBtnSkipConfirm: "⚪️ Все одно пропустити",
    verifySkipped:
      "Верифікацію пропущено. Можеш пройти її пізніше з меню профілю, " +
      "щоб повернути ELO-рейтинг.",
    verifyCheckPending:
      "🔍 Persona отримала твою верифікацію, але ще обробляє її. " +
      "Зачекай хвилину і натисни кнопку ще раз.",
    verifyCheckNoInquiry:
      "Поки не бачу спроби верифікації. Спочатку натисни 🟢 Пройти верифікацію, " +
      "пройди флоу, потім повертайся і натисни цю кнопку.",
    verifyCheckPersonaFailed:
      "❌ Верифікація не пройшла на стороні Persona. Натисни 🟢 Пройти верифікацію, " +
      "щоб спробувати ще раз.",
    verifyCheckAlreadyDone:
      "Вже оброблено — повідомлення з результатом має бути вище. " +
      "Якщо щось не так — натисни 🟢 Пройти верифікацію ще раз.",
    verifyCheckInfraError:
      "Не вдалося достукатися до сервісу верифікації. Спробуй ще раз за хвилину.",
    verifyOutcomeVerified:
      "✅ Верифікацію пройдено — профіль активний. Напишу, щойно знайду відповідний метч.",
    verifyOutcomePendingReview:
      "🔍 Ми додатково перевіряємо фото профілю за селфі з верифікації. Зазвичай це займає кілька годин — я напишу, щойно перевірка завершиться.",
    verifyOutcomeRejected:
      "⚠️ Фото в профілі не збіглися з селфі з верифікації. Заміни їх на чіткі фото себе, потім відкрий Налаштування → Верифікувати акаунт і спробуй ще раз.",
    verifyAutoPollStarted:
      "✨ Прийнято. Хапай каву ☕ — я звіряю твоє селфі з фото у профілі. " +
      "Це займе хвилину-дві.",
    verifyAutoPollTimeout:
      "Хм, довше ніж зазвичай. Натисни кнопку нижче, коли захочеш, щоб я перевірив ще раз.",
    verifyAutoPollPersonaFailed:
      "Верифікація не пройшла на стороні Persona. Натисни 🟢 Пройти верифікацію, щоб спробувати ще раз.",
    verifyAutoPollInfraError:
      "Не вдалося достукатися до сервісу верифікації. Спробуй ще раз за хвилину.",
    // Persona Embedded Mini App copy (verification.html)
    verifyMiniAppLoading: "Відкриваємо верифікацію…",
    verifyMiniAppFinishing: "Готово. Перевіряємо результат…",
    verifyMiniAppError:
      "Не вдалося запустити перевірку. Спробуйте ще раз.",
    verifyMiniAppCloseBtn: "Закрити",
    photoMatchMismatch:
      "⚠️ Це фото не збігається з селфі верифікації. " +
      "Будь ласка, завантаж чітке фото себе при схожому освітленні.",

    // --- Main Menu ---
    menuTitle: "🎓 *Меню Gennety*\nЩо робимо?",
    menuMyProfile: "👤 Мій профіль",
    menuEdit: "✏️ Редагувати",
    menuPause: "⏸ Пауза",
    menuResume: "▶️ Шукати",
    menuSettings: "⚙️ Налаштування",
    menuHelp: "💬 Допомога",
    menuBack: "⬅️ Назад",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Опису ще немає._",

    // --- Edit Profile ---
    editProfileBody:
      "Це зафіксовано:\n\n" +
      "• *Ім'я:* {firstName} {surname}\n" +
      "• *Вік:* {age}\n" +
      "• *Універ:* {university}\n\n" +
      "Можна змінити:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Параметри пошуку",
    editMajorBtn: "🎓 Спеціальність",
    editProfilePhotosBtn: "📸 Оновити фото",
    editBioPrompt: "Скинь новий опис (до 500 символів):",
    editBioTooLong: "Задовге — вклади в 500.",
    editBioSaved: "Опис оновлено ✅",
    editMajorPrompt: "Яка в тебе спеціальність? (до 100 символів):",
    editMajorTooLong: "Задовге — вклади в 100.",
    editMajorSaved: "Спеціальність оновлено ✅",
    editPrefsTitle: "🔍 *Параметри пошуку*\n\nЩо міняємо?",
    editPrefsAgeBtn: "🎂 Вік",
    editPrefsBack: "⬅️ До редагування",
    editAgeRangePrompt: "Який вік? (напр. 20-28)\nМін: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не зрозумів. Два числа через дефіс, напр. 20-28 (від {min} до {max}).",
    editAgeRangeSaved: "Діапазон оновлено ✅",
    editProfilePhotosStart: "Скинь нові фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото оновлено ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Пошук на паузі ⏸\nНових метчів не буде, поки не ввімкнеш.",
    resumeConfirmed: "Пошук запущено ▶️\nШІ вже працює.",

    // --- Settings ---
    settingsTitle: "⚙️ Налаштування",
    settingsLanguage: "🌐 Мова",
    settingsLanguagePick: "Обери мову:",
    settingsLanguageSaved: "Мову оновлено ✅",
    settingsVerify: "🛡 Пройти верифікацію",
    settingsVerifyNotNeeded: "Ти вже верифікований ✅",
    settingsVerifyUnavailable:
      "Верифікація тимчасово недоступна. Спробуй пізніше.",
    helpBody:
      "*Потрібна допомога?* 💬\n\n" +
      "Чатів між юзерами у нас немає — це by design. " +
      "Проблема з метчем, побаченням чи ботом? Пиши в сапорт:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Видалити акаунт",
    deleteAccountConfirm:
      "Точно? Акаунт буде *видалено назавжди*.\n\n" +
      "Все зникне — профіль, фото, метчі, ембедінги. " +
      "*Це не відкотити.*",
    deleteAccountYes: "Так, видалити все",
    deleteAccountNo: "Скасувати",
    deleteAccountDone:
      "Акаунт видалено. Усі дані стерто.\n" +
      "Захочеш повернутись — надішли /start.",

    // --- Matching ---
    matchHeadline: "💘 Знайшли тобі метч!",
    matchDeadlineNotice:
      "У тебе 24 години на відповідь. " +
      "Щойно натиснеш — *рішення остаточне*. Змінити не можна.",
    matchStreamStart: "Думаю, чому ви підходите…",
    matchBtnAccept: "✅ Прийняти",
    matchBtnDecline: "❌ Пас",
    matchAccepted: "Круто! Чекаємо на відповідь іншої сторони…",
    matchBothAccepted: "Взаємно 🔥 Знайдемо час.",
    matchDeclined:
      "Ок, усе нормально. Що стало головною причиною?\n\n" +
      "Обери варіант нижче або надішли короткий текст/голосове. ШІ проаналізує фідбек і врахує його в наступному дропі.\n\n" +
      "Якщо причина в чомусь іншому - напиши: наступного разу запропонуємо людину, яка краще підходить під твої інтереси й уподобання.",
    matchDeclineReasonType: "Не мій тип",
    matchDeclineReasonVibe: "Не той вайб",
    matchDeclineReasonInterests: "Не збіглися інтереси",
    matchDeclineReasonLifestyle: "Різний спосіб життя",
    matchDeclineReasonOther: "Інша причина",
    matchDeclineOtherAsk:
      "Ок - надішли короткий текст або голосове з причиною. ШІ проаналізує це й врахує в наступному дропі.",
    matchDeclineFeedbackSaved:
      "Прийнято. Врахуємо це в наступних рекомендаціях 🎯",
    matchDeclineAlreadyNoted: "Уже записали - дякую.",
    matchDeclineFeedbackFailed:
      "Не вдалося зберегти просто зараз. Можеш усе одно надіслати короткий текст або голосове.",
    matchDeclineThanks: "Зрозуміли. Шукаємо далі 🎯",
    matchPeerDecided:
      "Твій метч уже дав відповідь. Твоя черга.\n\n" +
      "*Що* саме він обрав — побачиш лише після своєї відповіді. " +
      "І пам'ятай: твій вибір остаточний.",
    matchPeerWasAccepted: "До речі — твій метч був згодний. Цього разу просто не склалось.",
    matchPeerWasDeclined: "До речі — твій метч цього разу відмовився.",
    matchAcceptedPeerDeclined:
      "На жаль, твій партнер не погодився на зустріч. " +
      "Це нормально. У Gennety побачення відбуваються лише за взаємного інтересу. " +
      "Ми продовжуємо шукати для тебе релевантніший метч.",
    matchAcceptedPeerDeclinedPriority:
      "На жаль, твій партнер не погодився на зустріч. " +
      "Це нормально. У Gennety побачення відбуваються лише за взаємного інтересу.\n\n" +
      "Ми підвищили твій пріоритет на наступний четвер, щоб у тебе було більше шансів провести справді приємний вечір.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Підтверджено",
    matchVerifiedQuote:
      "Ми перевірили цього користувача. Він успішно пройшов перевірку обличчя — " +
      "фотографії в профілі відповідають його особистості та належать саме йому.",
    matchSynergyHeader: "💎 *Синергія {score}/99* — {reason}",
    pitchCountdownHours: "⏳ Залишилось {hours}год на відповідь",
    pitchCountdownMinutes: "⏳ Залишилось {minutes} хв на відповідь",
    pitchExpired: "⏳ Час вийшов — пропозиція більше не актуальна.",
    matchExpiredSilentWarning:
      "Час вийшов — за добу ти так і не відповів(-ла) на метч. " +
      "Чекай наступного четверга.\n\n" +
      "Будь ласка, не ігноруй пропозиції — це неповага до твого партнера. " +
      "Наступного разу за таку поведінку ми знизимо твій рейтинг.",
    matchExpiredSilentPenalty:
      "Час вийшов — за добу ти так і не відповів(-ла) на метч. " +
      "Чекай наступного четверга.\n\n" +
      "Твій рейтинг знижено за ігнор — це неповага до твого партнера.",
    matchExpiredYouMissedDate:
      "Важливо: твій метч був згодний прийти — ти пропустив справжнє побачення.\n\n",
    matchExpiredPeerIgnored:
      "Партнер не відповів протягом доби — побачення не відбудеться. " +
      "Побачимось у дропі наступного тижня.",
    matchStandbyStatus:
      "STATUS: STANDBY\n\n" +
      "Ми не йдемо на компроміси щодо якості. Цього тижня для тебе немає метчу з високою синергією.\n\n" +
      "Твій пріоритет на наступний тиждень підвищено.",
    noMatchThisWeekTier1:
      "Привіт 💫\n\n" +
      "Цього тижня наш матчмейкер не знайшов для тебе пари, яка справді відповідала б нашому рівню якості — " +
      "і ми не готові пропонувати «аби було».\n\n" +
      "Кілька чесних речей:\n" +
      "• Ми активно розширюємо спільноту й щодня покращуємо алгоритм підбору партнера.\n" +
      "• По-справжньому відповідна людина має з'явитися в одному з найближчих дропів.\n" +
      "• Кожне побачення — *повністю за наш кошт*: кава, вечеря, все. ☕️🎬\n\n" +
      "До наступного четверга о 18:00 ✨",
    noMatchThisWeekTier2:
      "Привіт 🌿\n\n" +
      "Уже другий тиждень поспіль, як наш матчмейкер не знаходить когось, кого ми були б раді тобі показати. " +
      "Дякуємо, що лишаєшся з нами — це справді важливо.\n\n" +
      "Що ми хочемо сказати чесно:\n" +
      "• Ми активно приводимо нових студентів і налаштовуємо алгоритм під твої критерії.\n" +
      "• Дійсно вартий партнер має бути всього за кілька дропів від тебе.\n" +
      "• Коли побачення станеться — воно *повністю за наш кошт*, це не змінюється.\n\n" +
      "До наступного четверга о 18:00 — ми працюємо для тебе 🤍",
    noMatchThisWeekTier3:
      "Привіт ✨\n\n" +
      "Маємо знову бути чесними — пари, яка справді варта твого часу, досі немає. " +
      "Нам це не подобається ще більше, ніж тобі, і ми не вдаватимемо, що все добре.\n\n" +
      "Що ми насправді робимо:\n" +
      "• Особисто стежимо за твоєю чергою і підштовхуємо ріст спільноти у твоєму районі.\n" +
      "• Та сама людина обов'язково з'явиться в одному з найближчих дропів — ми не зупинимось.\n" +
      "• Твоє побачення — коли б воно не сталося — *повністю за нами*. Це наша обіцянка.\n\n" +
      "Дякуємо, що довіряєш. До четверга о 18:00 🤍",
    matchScheduleProposal: "Як тобі ці варіанти? Тисни зручний:",
    matchScheduleIter3:
      "Відкрий календар, обери дати й познач усі зручні варіанти часу. Співрозмовник побачить їх наживо й одним тапом погодиться на ваш спільний час.",
    matchScheduleBtnCalendar: "📅 Відкрити календар",
    // --- Date Ticket (преміум-крок після взаємного метчу) ---
    ticketCardCaption:
      "Взаємно 🔥\n\nЗалишився один крок перед плануванням: отримай свій *квиток на побачення* — кураторське, перевірене побачення без зайвої драми. Натисни нижче, щоб відкрити.",
    ticketButton: "🎟️ Отримати квиток на побачення",
    ticketBothSecuredDm: "Обидва квитки у вас 🎟️✨ Побачення в силі — оберімо час.",
    ticketPartnerPaidDm: "{name} вже сплатив твій квиток на побачення ❤️ Тобі нічого не потрібно робити.",
    ticketRefundedDm:
      "Співрозмовник не встиг узяти свій квиток, тож твій ми повернули. Нічого страшного — відкрили планування безкоштовно. Знайдімо час 📅",
    matchScheduleNoOverlap: "Не збіглося — спробуємо ще.",
    matchScheduled: "Готово! {venue} — до зустрічі 🤝",
    matchScheduledBtnOpenMaps: "📍 Відкрити в картах",
    matchSchedulePickedPrefix: "Ти обрав: ",
    matchScheduleWaitingPeer: "Чекаємо на вибір іншої сторони…",
    matchSchedulePeerProposed:
      "Співрозмовник позначив дати й час у календарі. Відкрий його, щоб погодитись або запропонувати свій:",
    matchSchedulePeerSuggestedAlternative:
      "Співрозмовник запропонував інший час. Перевір відповідь: можеш погодитись із пропозицією або запропонувати свій варіант.",
    matchScheduleSavedConfirmation:
      "✅ Зберіг твої дати й час. Пінганув співрозмовника — напишу, щойно він(вона) відповість.",
    matchScheduleNoOverlapYet:
      "Ви обидва позначили дати й час, але варіанти не збіглись. Відкрий календар і додай ще кілька слотів — щойно один збіжиться, я зафіксую дату:",
    venueConciergeIntro:
      "Час зафіксовано 🗓️ Останній крок — обираємо місце.\n\n" +
      "Напиши *вайб* (наприклад _тихе кафе_, _веган_, _прогулянка в парку_, _невеликий музей_), " +
      "а потім натисни *Обрати на карті* — вкажи метро, адресу чи місце друга, звідки поїдеш.",
    venueConciergeBtnLocation: "📍 Надіслати геолокацію",
    venueConciergeBtnMap: "🗺️ Обрати на карті",
    venueVibeNoted: "Вайб записано ✅ Тепер вкажи, звідки поїдеш:",
    venueLocationNoted:
      "Місце збережено ✅ Тепер напиши *вайб* — наприклад _тихе кафе_, _веган-бранч_, _прогулянка у парку_.",
    venueSafetyOverride:
      "Невеличке уточнення — заміняю на публічне кафе. Перші побачення у нас у людних місцях.",
    venueWaitingPeer: "Прийняв ✅ Чекаємо на іншу сторону…",
    venueSearching: "Шукаю місце, зручне обом… 🔍",
    venueSearchStep2: "📍 Звіряю маршрути та час у дорозі для вас обох…",
    venueSearchStep3: "✨ Обираю найкраще місце під вашу атмосферу…",
    onbAnalyzeStep1: "🧠 Читаю твій контекст…",
    onbAnalyzeStep2: "🧩 Виділяю ключові риси та цінності…",
    onbAnalyzeStep3: "🧮 Збираю твій психологічний профіль…",
    verifyAnalyzeStep1: "🔍 Звіряю селфі з твоїми фотографіями…",
    verifyAnalyzeStep2: "🧬 Аналізую риси обличчя…",
    verifyAnalyzeStep3: "⏳ Завершую перевірку…",
    skipAnalyzeStep1: "✨ Прийнято. Завершую збірку профілю…",
    skipAnalyzeStep2: "🧮 Фіналізую твій психологічний профіль…",
    skipAnalyzeStep3: "💞 Готую тебе до щотижневого підбору…",
    profilerBatchSaving: "🧩 Додаю твої відповіді до профілю…",
    profilerBatchSaved:
      "✅ Оновив твою картку вподобань — врахую це під час наступного підбору.",

    // --- Phase 3.7: Venue change (female-exclusive one-shot) ---
    venueChangeFemaleButton: "🔄 Змінити місце",
    venueChangeFemaleHint:
      "До речі — у тебе є одноразова можливість змінити це місце. " +
      "Натисни *Змінити місце* вище, щоб обрати інший заклад поблизу. " +
      "Парі потрібно буде це підтвердити, і зробити так можна лише один раз.",
    venueChangeMaleIntro: "Твоя пара хоче змінити місце зустрічі.",
    venueChangeMaleNewVenue: "Нове місце: {venue}",
    venueChangeMaleComment: "Пояснення партнерки:",
    venueChangeMaleAsk:
      "Підтверди нове місце або відмов. Відмова скасовує побачення.",
    venueChangeBtnAccept: "✅ Погодитися на нове місце",
    venueChangeBtnDecline: "❌ Не погоджуватися (скасувати побачення)",
    venueChangeDeclineConfirm:
      "Точно? Якщо ти не погодишся на запропоноване місце, побачення та метч буде " +
      "анульовано назавжди — скасувати це буде неможливо.",
    venueChangeBtnConfirmCancel: "Так, анулювати метч",
    venueChangeBtnBack: "Ні, я передумав",
    venueChangeAcceptedFemale: "Партнер погодився на нове місце! 🎉 {venue}",
    venueChangeAcceptedMaleAck: "Готово — місце оновлено. {venue}",
    venueChangeCancelledFemale:
      "Партнер не погодився на нове місце, тому побачення скасовано.",
    venueChangeCancelledMale: "Побачення скасовано.",
    venueChangeExpiredCancel:
      "Час на підтвердження нового місця вичерпано, тому побачення скасовано.",
    venueChangeAlreadyResolved: "Рішення щодо зміни місця вже прийнято.",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Побачення через 5 годин! Ось теми для розмови:\n\n",
    dateHintsIntro: "\n\n💡 Кілька порад, як усе спланувати:\n",
    profilerSkip: "Пропустити",
    wingmanHintIntro:
      "👋 Маленька підказка — побачення через півтори години:\n\n",
    emergencyUnlocked:
      "Вікно екстреного скасування відкрите.\n" +
      "Зовсім не можеш прийти — тисни кнопку нижче.\n" +
      "*Потрібна причина — вона піде метчу саме так, як ти її напишеш.*",
    emergencyBtn: "🚨 Скасувати побачення",
    emergencyConfirmPrompt:
      "Точно скасувати це побачення?\n" +
      "*Це остаточно — після скасування повернути метч уже не можна.*",
    emergencyBtnConfirm: "Так, скасувати побачення",
    emergencyBtnBack: "Ні, залишити побачення",
    emergencyAborted: "Гаразд — побачення залишається в силі. 👍",
    emergencyAskReason:
      "Напиши причину. Текст піде метчу *як є*.",
    emergencyConfirmed:
      "Побачення скасовано. Повідомлення переслано.",
    emergencyReceivedOther:
      "Метч скасував побачення. Ось що написав:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Метч скасував побачення. Ось що написав:",
    emergencyReceivedOtherSoftNote:
      "Це не через тебе. Gennety трохи підніме твій пріоритет наступного тижня.",
    feedbackInvitation:
      "Як пройшло побачення? ✨\n\n" +
      "Поділись парою речей — чи була хімія, який був вайб, що б змінив. " +
      "Використаємо, щоб наступного разу знайти когось ще точніше.",
    feedbackBtnForm: "✍️ Відкрити форму",
    feedbackBtnVoice: "🎤 Записати голосом",
    feedbackVoiceAsk:
      "Просто запиши голосове 🎙️\n\n" +
      "Розкажи, як пройшло — чи була хімія, що сподобалось, що не дуже. " +
      "Хвилини цілком вистачить.",
    feedbackThanks: "Дякую за фідбек ✨ Використаємо для покращення.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Поскаржитися",
    reportAsk:
      "Ця скарга приватна. Що найкраще описує проблему?",
    reportCategoryFakePhotos: "Фейкові або оманливі фото",
    reportCategoryWrongPerson: "На фото інша людина",
    reportCategoryOffensive: "Образлива або тривожна поведінка",
    reportCategoryUnsafe: "Небезпечно / червоний прапорець",
    reportCategorySpam: "Спам або шахрайство",
    reportCategoryInappropriate: "Неприйнятний профіль",
    reportCategoryOther: "Інше",
    reportDetailAsk:
      "Є щось іще, що допоможе швидше розібратися? Можна написати, надіслати голосове або пропустити.",
    reportDetailAskOther:
      "Будь ласка, коротко опиши, що сталося. Можна написати або надіслати голосове.",
    reportSkipBtn: "Пропустити",
    reportThanksT1: "Прийнято — врахуємо в майбутніх мєтчах 🎯",
    reportThanksT2: "Скаргу зареєстровано. Дякуємо — розберемося.",
    reportThanksT3: "Скаргу зареєстровано. Заморожуємо їхній акаунт для ручної перевірки — дякуємо, що повідомив(ла).",
    reportFailed: "Не вдалося обробити скаргу. Спробуй за хвилину.",
    reportDuplicate: "Ти вже скаржився(лася) на цей мєтч.",
    reportWarningStrike1:
      "⚠️ На тебе надійшла скарга щодо нещодавнього мєтчу. " +
      "Gennety очікує шанобливої та надійної поведінки. Ще одна підтверджена скарга — і акаунт буде тимчасово заблоковано.",
    reportSuspendedDM:
      "🚫 Твій акаунт заблоковано на 14 днів через повторні скарги. " +
      "У цей період мєтчі не надходитимуть. Автоматично розблокується після завершення терміну.",
    reportBannedDM:
      "⛔ Твій акаунт заблоковано назавжди через численні підтверджені скарги.",
    reportPendingInvestigationDM:
      "🚫 Твій акаунт заморожено для перевірки безпеки. " +
      "Команда зв'яжеться через @gennetysupport, якщо знадобляться подальші дії.",
    safetyNoteFemale:
      "Привіт! Твоє побачення від Gennety почнеться вже за півтори години в **{location_name}**.\n\n" +
      "Ми дбаємо про твою безпеку, тож поки ти збираєшся — невелика пам'ятка для першої зустрічі:\n\n" +
      "📍 **Дотримуйся плану.** Ми підібрали для вас безпечне публічне місце. Не погоджуйся переносити зустріч до усамітненої локації чи їхати в гості.\n" +
      "🚗 **Транспорт.** Добирайся туди і назад самостійно будь-яким зручним способом (громадським транспортом, таксі чи пішки). Головне — не сідай у машину до малознайомої людини.\n" +
      "📱 **Попередь близьких.** Перешли подрузі або комусь із близьких деталі цієї зустрічі і, якщо є можливість, поділися геолокацією на вечір.\n" +
      "☕ **Контроль.** Намагайся не залишати речі й напій без нагляду.\n" +
      "🛑 **Твої межі.** Якщо тобі некомфортно або поведінка партнера здається дивною — маєш повне право просто встати і піти в будь-який момент. Твоя безпека завжди важливіша за ввічливість.\n\n" +
      "Бажаємо чудового вечора і приємних вражень ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Наступний метч через {d}д {h}г",
    statusHoursMinutes: "⏳ Метчі прилетять через {h}г {m}хв",
    statusMinutes: "🔥 Майже готово! Метчі прилетять за {m} хв",
    statusProcessing: "✨ Скануємо кампус… Зазирни трохи згодом.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не розчув — можеш написати текстом?",
    voiceTooLong:
      "Голосове задовге. До 5 хвилин — або просто напиши текстом.",

    // --- Pre-date coordination (feature-flagged) ---
    coordOfferIntro:
      "Побачення приблизно за годину 🕐\n\n" +
      "Хочеш спосіб знайти одне одного на місці — попередити про запізнення чи сказати, де сидиш? Обери:",
    coordOfferNoContactNote:
      "Побачення приблизно за годину 🕐\n\n" +
      "Важливо: у твого метчу немає публічного Telegram-юзернейму, тож обмін контактами неможливий. Але можна скористатись анонімним чатом через мене:",
    coordBtnShareSelf: "📲 Поділитися своїм Telegram",
    coordBtnRequestPartner: "🙋 Попросити його контакт",
    coordBtnProxy: "🕶 Анонімний чат",
    coordSharedToPartner:
      "Твій метч поділився своїм Telegram, щоб ви знайшли одне одного 💬\n\n" +
      "{name}: {link}\n\nНапиши пару слів — до зустрічі!",
    coordRequestAck: "Готово — я запитав. Повідомлю одразу, щойно погодяться ✅",
    coordPartnerAskApprove:
      "Твоєму побаченню за ~1год знадобиться спосіб знайти тебе на місці 💬\n\n" +
      "Поділитися своїм Telegram з {name}?",
    coordPartnerBtnApprove: "✅ Поділитися Telegram",
    coordPartnerBtnDecline: "Не зараз",
    coordRevealToInitiator:
      "{name} поділився своїм Telegram, щоб ви знайшли одне одного 💬\n\n" +
      "{link}\n\nНапиши пару слів — гарного побачення!",
    coordPartnerDeclined:
      "Твій метч поки не хоче ділитися контактами — це окей. За ~30 хвилин до зустрічі відкриється анонімний чат, якщо захочеш.",
    coordProxyOpenedEnterPrompt:
      "Анонімний чат відкрито 🕶\n\n" +
      "Повідомлення йдуть через мене — контакти не розкриваються. Користуйся, щоб знайти одне одного чи попередити про запізнення. Закриється за пару годин після побачення.",
    coordEnterBtn: "💬 Увійти в чат",
    coordExitBtn: "❌ Вийти з чату",
    coordReportBtn: "🚨 Поскаржитися",
    coordChatEntered:
      "Ти в анонімному чаті 🕶 Просто пиши — я передам. Вийти можна будь-коли.",
    coordChatExited: "Вийшов із чату. Напиши /menu будь-коли.",
    coordProxyRelayPrefix: "💬 Твоє побачення: ",
    coordProxyTextOnly: "У цьому чаті працюють лише текстові повідомлення — фото й голосові не передаються.",
    coordProxyClosed: "Анонімний чат закрився. Сподіваюсь, побачення пройшло чудово — зазирну завтра ✨",
    coordAlreadyChosen: "Ти вже обрав спосіб координації для цього побачення.",
    coordSharedAck: "Готово — тепер тебе зможуть знайти 💬 Гарного побачення!",
    coordProxyChosenAck:
      "Прийнято 🕶 Анонімний чат відкриється приблизно за 30 хвилин до побачення — тоді надішлю кнопку.",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];

type TranslationTable = Record<TranslationKey, string>;

const deTranslations: TranslationTable = {
  ...translations.en,
  consentMessage:
    "Willkommen bei Gennety Dating!\n\n" +
    "Bevor wir anfangen, lies bitte unsere Datenschutzerklärung und stimme den Bedingungen zur Datenspeicherung zu.",
  consentAgree: "Ich stimme zu",
  welcome: "Gennety Dating 👀\nAI-Matchmaking für Studierende.",
  chooseLanguage: "Wähle deine Sprache:",
  philosophyPitch:
    "Gennety basiert auf einer Idee: *Zero Chat*.\n\n" +
    "Du schreibst deinem Match nicht. Unsere AI versteht, wer du bist, " +
    "findet jemanden, der wirklich passt, und kümmert sich um alles - Zeit, Ort, das ganze Setup.\n\n" +
    "Du musst nur auftauchen. Klingt gut?",
  philosophyContinue: "Ich bin dabei 🚀",
  askEmail: "Schick deine Uni-Mail (z. B. name@stanford.edu):",
  invalidEmail: "Hm, das sieht nicht nach einer Uni-Mail aus. Versuch es mit einer .edu- oder .ac.uk-Adresse.",
  otpSent: "Ich habe einen 6-stelligen Code an *{email}* gesendet. Schreib ihn hier rein:",
  otpInvalid: "Der Code hat nicht funktioniert. Versuch es nochmal:",
  otpExpired: "Der Code ist abgelaufen. Gib deine E-Mail erneut ein:",
  otpTooManyAttempts: "Zu viele Versuche. Gib deine E-Mail erneut ein, damit wir einen neuen Code senden.",
  otpCooldown: "Warte kurz - bitte erst in einer Minute einen neuen Code anfordern.",
  emailVerified: "E-Mail bestätigt ✅",
  askFirstName: "Wie heißt du?",
  askSurname: "Und dein Nachname?",
  askAge: "Wie alt bist du?",
  invalidAge: "Gib ein Alter zwischen {min} und {max} ein.",
  askGender: "Was ist dein Geschlecht?",
  askPreference: "Auf wen stehst du?",
  btnMale: "Mann",
  btnFemale: "Frau",
  btnMen: "Männer",
  btnWomen: "Frauen",
  btnBoth: "Beides",
  llmAnalysing1: "Ich lese dein Profil... 🧠",
  llmAnalysing2: "Ich extrahiere Persönlichkeitsmerkmale...",
  llmAnalysing3: "Ich baue deinen psychologischen Fingerabdruck...",
  llmDumpReceived: "Profil bereit ✨",
  askPhotos: "Fast fertig! Sende {min}-{max} Fotos von dir. Eins nach dem anderen.",
  photoReceived: "Foto {n}/{max} ✅",
  photoRejected:
    "Ich brauche ein klares Foto nur von *dir* - eine Person, Gesicht sichtbar.\n\n" +
    "Keine Memes, Landschaften oder Gruppenfotos. Versuch ein anderes.",
  photoVisionError: "Konnte das Foto nicht verarbeiten. Sende es gleich nochmal.",
  photosEnough: "Du kannst mehr senden (bis {max}) oder auf den Button tippen, um weiterzumachen.",
  photosDone: "Fotos hochgeladen ✅",
  profileReview:
    "Hier ist dein Profil:\n\n" +
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n\n" +
    "{summary}\n\n" +
    "Passt das?",
  profileConfirm: "Passt ✅",
  profileEdit: "Etwas ändern",
  onboardingComplete:
    "Du bist drin! 🎉\n\n" +
    "Unsere AI sucht schon nach deinem Match. " +
    "Ich melde mich, sobald jemand Besonderes auftaucht.",
  btnContinuePhotos: "Weiter ➡️",
  finishOnboardingFirst:
    "Schließe zuerst die Registrierung ab, dann sind Menü und Einstellungen verfügbar.\nSchreib /start, um weiterzumachen.",
  verifyPitch:
    "Letzter Schritt. Wir müssen bestätigen, dass du eine echte Person bist.\n\n" +
    "Wir vergleichen das Selfie aus der Verifizierung mit jedem Foto in deinem Profil. " +
    "Fotos, die nicht zu dir passen, werden abgelehnt.\n\n" +
    "Wenn du die Verifizierung überspringst, sinkt dein Start-ELO deutlich " +
    "und der Algorithmus zeigt dir weniger Matches.",
  verifyBtnGo: "🟢 Jetzt verifizieren",
  verifyBtnCheck: "✅ Ich habe die Verifizierung abgeschlossen",
  verifyBtnSkip: "⚪️ Erstmal überspringen",
  verifySkipNudgeCaption:
    "Kurz — hör dir das an, bevor du überspringst 👆",
  verifyBtnReconsider: "🟢 OK, ich verifiziere mich",
  verifyBtnSkipConfirm: "⚪️ Trotzdem überspringen",
  verifySkipped:
    "Verifizierung übersprungen. Du kannst sie später im Profilmenü starten, " +
    "um dein ELO wiederherzustellen.",
  verifyCheckPending:
    "🔍 Persona hat deine Verifizierung, verarbeitet sie aber noch. " +
    "Warte kurz und tippe dann nochmal auf den Button.",
  verifyCheckNoInquiry:
    "Ich sehe noch keinen Verifizierungsversuch. Tippe zuerst auf 🟢 Jetzt verifizieren, " +
    "schließe den Flow ab und komm dann zurück.",
  verifyCheckPersonaFailed:
    "❌ Die Verifizierung ist bei Persona fehlgeschlagen. Tippe auf 🟢 Jetzt verifizieren, " +
    "um es erneut zu versuchen.",
  verifyCheckAlreadyDone:
    "Schon verarbeitet - du solltest die Ergebnisnachricht oben bekommen haben. " +
    "Wenn etwas falsch wirkt, tippe auf 🟢 Jetzt verifizieren, um es erneut zu versuchen.",
  verifyCheckInfraError: "Der Verifizierungsdienst ist gerade nicht erreichbar. Versuch es gleich nochmal.",
  verifyOutcomeVerified:
    "✅ Verifizierung abgeschlossen - dein Profil ist live. Ich melde mich, sobald ich ein Match finde.",
  verifyOutcomePendingReview:
    "🔍 Wir prüfen deine Profilfotos noch einmal gegen dein Verifizierungs-Selfie. Das dauert normalerweise ein paar Stunden - ich melde mich, sobald es erledigt ist.",
  verifyOutcomeRejected:
    "⚠️ Die Fotos in deinem Profil scheinen nicht zum Selfie aus der Verifizierung zu passen. Ersetze sie bitte durch klare Fotos von dir und öffne dann Einstellungen → Konto verifizieren, um es erneut zu versuchen.",
  verifyAutoPollStarted:
    "✨ Verstanden. Hol dir einen Kaffee ☕ - ich vergleiche dein Selfie mit deinen Profilfotos. " +
    "Das dauert ein bis zwei Minuten.",
  verifyAutoPollTimeout:
    "Hm, das dauert länger als sonst. Tippe unten auf den Button, wenn ich nochmal prüfen soll.",
  verifyAutoPollPersonaFailed: "Die Verifizierung ist bei Persona fehlgeschlagen. Tippe auf 🟢 Jetzt verifizieren, um es erneut zu versuchen.",
  verifyAutoPollInfraError: "Der Verifizierungsdienst ist nicht erreichbar. Versuch es gleich nochmal.",
  // Persona Embedded Mini App copy (verification.html)
  verifyMiniAppLoading: "Verifizierung wird geöffnet…",
  verifyMiniAppFinishing: "Gleich fertig. Ergebnis wird geprüft…",
  verifyMiniAppError: "Verifizierung konnte nicht gestartet werden. Bitte versuch es erneut.",
  verifyMiniAppCloseBtn: "Schließen",
  photoMatchMismatch:
    "⚠️ Dieses Foto passt nicht zu deinem Verifizierungs-Selfie. " +
    "Bitte lade ein klares Foto von dir hoch, möglichst bei ähnlichem Licht.",
  menuTitle: "🎓 *Gennety Menü*\nWas geht?",
  menuMyProfile: "👤 Mein Profil",
  menuEdit: "✏️ Profil bearbeiten",
  menuPause: "⏸ Matching pausieren",
  menuResume: "▶️ Matching fortsetzen",
  menuSettings: "⚙️ Einstellungen",
  menuHelp: "💬 Hilfe",
  menuMyTickets: "🎟️ Meine Tickets",
  videoTooLong:
    "Profilvideos dürfen höchstens 60 Sekunden lang sein. Schick ein kürzeres.",
  videoTooLarge:
    "Profilvideos dürfen höchstens 50 MB groß sein. Schick ein kleineres.",
  ticketRewardPhoto:
    "🎟️ Stark — du hast gerade ein *kostenloses Date-Ticket* verdient!\n\nSo läuft's: Jedes Date kostet 1 Ticket, und Tickets kosten normalerweise Geld. Für deine Fotos gibt's eins gratis. Guthaben: *{balance}* 🎟️",
  ticketRewardVideo:
    "🎟️ Ein Profilvideo — top! Noch ein *kostenloses Date-Ticket* für dich.\n\nJedes Date kostet 1 Ticket (sonst kostenpflichtig). Guthaben: *{balance}* 🎟️",
  ticketWalletText:
    "🎟️ *Meine Tickets*\n\nDu hast *{balance}* Ticket(s). Jedes Date kostet 1 Ticket — jederzeit nachkaufbar.",
  ticketWalletOpenStore: "🎟️ Tickets kaufen",
  menuBack: "⬅️ Zurück",
  myProfileBody:
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n" +
    "🌐 {language}\n\n" +
    "{summary}",
  myProfileNoBio: "_Noch keine Bio._",
  editProfileBody:
    "Das ist fest gespeichert:\n\n" +
    "• *Name:* {firstName} {surname}\n" +
    "• *Alter:* {age}\n" +
    "• *Universität:* {university}\n\n" +
    "Du kannst bearbeiten:",
  editBioBtn: "📝 Bio",
  editPrefsBtn: "🔍 Suchpräferenzen",
  editMajorBtn: "🎓 Studienfach",
  editProfilePhotosBtn: "📸 Fotos neu hochladen",
  editBioPrompt: "Sende deine neue Bio (max. 500 Zeichen):",
  editBioTooLong: "Zu lang - bleib unter 500 Zeichen.",
  editBioSaved: "Bio aktualisiert ✅",
  editMajorPrompt: "Was studierst du? (max. 100 Zeichen):",
  editMajorTooLong: "Zu lang - bleib unter 100 Zeichen.",
  editMajorSaved: "Studienfach aktualisiert ✅",
  editPrefsTitle: "🔍 *Suchpräferenzen*\n\nWas möchtest du ändern?",
  editPrefsAgeBtn: "🎂 Altersbereich",
  editPrefsBack: "⬅️ Zurück zu Bearbeiten",
  editAgeRangePrompt: "Welcher Altersbereich? (z. B. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Das habe ich nicht verstanden. Zwei Zahlen wie 20-28 (Bereich {min}-{max}).",
  editAgeRangeSaved: "Altersbereich aktualisiert ✅",
  editProfilePhotosStart: "Sende neue Fotos ({min}-{max}). Eins nach dem anderen.",
  editProfilePhotosSaved: "Fotos aktualisiert ✅",
  pauseConfirmed: "Matching pausiert ⏸\nKeine neuen Matches, bis du fortsetzt.",
  resumeConfirmed: "Matching läuft wieder ▶️\nUnsere AI ist dran.",
  settingsTitle: "⚙️ Einstellungen",
  settingsLanguage: "🌐 Sprache",
  settingsLanguagePick: "Wähle eine Sprache:",
  settingsLanguageSaved: "Sprache aktualisiert ✅",
  settingsVerify: "🛡 Account verifizieren",
  settingsVerifyNotNeeded: "Du bist schon verifiziert ✅",
  settingsVerifyUnavailable: "Verifizierung ist vorübergehend nicht verfügbar. Versuch es später erneut.",
  helpBody:
    "*Brauchst du Hilfe?* 💬\n\n" +
    "Wir machen bewusst keine Chats zwischen Nutzern. " +
    "Problem mit Match, Date oder Bot? Schreib dem Support:\n\n" +
    "💬 [@gennetysupport](https://t.me/gennetysupport)",
  settingsDeleteAccount: "🗑 Account löschen",
  deleteAccountConfirm:
    "Sicher? Das löscht deinen Account *dauerhaft*.\n\n" +
    "Alles ist weg - Profil, Fotos, Matches, Embeddings. " +
    "*Das kann nicht rückgängig gemacht werden.*",
  deleteAccountYes: "Ja, alles löschen",
  deleteAccountNo: "Abbrechen",
  deleteAccountDone:
    "Account gelöscht. Alle Daten entfernt.\n" +
    "Wenn du zurückkommen willst, sende einfach /start.",
  matchHeadline: "💘 Wir haben ein Match für dich!",
  matchDeadlineNotice:
    "Du hast 24h zum Antworten. " +
    "Sobald du tippst, ist *die Entscheidung final*. Kein Zurück.",
  matchStreamStart: "Ich finde heraus, warum ihr klickt...",
  matchBtnAccept: "✅ Annehmen",
  matchBtnDecline: "❌ Passen",
  matchAccepted: "Nice! Warten auf die andere Person...",
  matchBothAccepted: "Beidseitig 🔥 Lass uns eine Zeit finden.",
  matchDeclined:
    "Alles gut. Was war der Hauptgrund, warum du gepasst hast?\n\n" +
    "Wähle unten etwas aus oder schick einen kurzen Text bzw. eine Sprachnachricht. Die AI analysiert das für den nächsten Drop.\n\n" +
    "Wenn es etwas anderes war, sag es uns - nächstes Mal schlagen wir jemanden vor, der besser zu deinen Interessen und Vorlieben passt.",
  matchDeclineReasonType: "Nicht mein Typ",
  matchDeclineReasonVibe: "Anderer Vibe",
  matchDeclineReasonInterests: "Interessen passen nicht",
  matchDeclineReasonLifestyle: "Lifestyle passt nicht",
  matchDeclineReasonOther: "Etwas anderes",
  matchDeclineOtherAsk:
    "Klar - schick einen kurzen Text oder eine Sprachnachricht mit dem Grund. Die AI nutzt das für den nächsten Drop.",
  matchDeclineFeedbackSaved: "Verstanden. Wir nutzen das, um deine nächsten Empfehlungen zu verbessern 🎯",
  matchDeclineAlreadyNoted: "Schon notiert - danke.",
  matchDeclineFeedbackFailed: "Konnte das gerade nicht speichern. Du kannst trotzdem einen kurzen Text oder eine Sprachnachricht senden.",
  matchDeclineThanks: "Notiert. Wir suchen weiter 🎯",
  matchPeerDecided:
    "Dein Match hat schon geantwortet. Jetzt bist du dran.\n\n" +
    "*Was* sie gewählt haben, siehst du erst nach deiner eigenen Antwort. " +
    "Und denk dran: deine Antwort ist final.",
  matchPeerWasAccepted: "Zur Info - dein Match war dabei. Es hat diesmal nur nicht gepasst.",
  matchPeerWasDeclined: "Zur Info - dein Match hat diesmal gepasst.",
  matchAcceptedPeerDeclined:
    "Leider wollte dein Match sich nicht treffen. " +
    "Das ist okay. Bei Gennety passieren Dates nur, wenn Interesse beidseitig ist. " +
    "Wir suchen weiter nach einem passenderen Match.",
  matchAcceptedPeerDeclinedPriority:
    "Leider wollte dein Match sich nicht treffen. " +
    "Das ist okay. Bei Gennety passieren Dates nur, wenn Interesse beidseitig ist.\n\n" +
    "Wir haben deine Priorität für nächsten Donnerstag erhöht, damit du bessere Chancen auf einen wirklich angenehmen Abend hast.",
  matchPhotoCaption: "{name}, {age}",
  matchVerifiedLabel: "Verifiziert",
  matchVerifiedQuote:
    "Wir haben diese Person verifiziert. Sie hat unseren Face-Match-Check bestanden - " +
    "die Fotos in diesem Profil passen zu ihrer echten Identität.",
  matchSynergyHeader: "💎 *Synergie {score}/99* — {reason}",
  pitchCountdownHours: "⏳ Noch {hours}h zum Antworten",
  pitchCountdownMinutes: "⏳ Noch {minutes} Min zum Antworten",
  pitchExpired: "⏳ Zeit abgelaufen - dieser Vorschlag ist verfallen.",
  matchExpiredSilentWarning:
    "Zeit abgelaufen - du hast deinem Match innerhalb von 24h nicht geantwortet. " +
    "Warte auf den nächsten Donnerstags-Drop.\n\n" +
    "Bitte ignoriere Vorschläge nicht - das ist deinem Gegenüber gegenüber unfair. " +
    "Beim nächsten Mal senken wir dafür dein Rating.",
  matchExpiredSilentPenalty:
    "Zeit abgelaufen - du hast deinem Match innerhalb von 24h nicht geantwortet. " +
    "Warte auf den nächsten Donnerstags-Drop.\n\n" +
    "Dein Rating wurde gesenkt, weil das Ignorieren eines Vorschlags unfair gegenüber deinem Gegenüber ist.",
  matchExpiredYouMissedDate: "Heads up - dein Match war tatsächlich dabei. Du hast ein echtes Date verpasst.\n\n",
  matchExpiredPeerIgnored:
    "Dein Match hat innerhalb von 24h nicht geantwortet, also findet das Date nicht statt. " +
    "Wir sehen uns beim nächsten Drop.",
  matchStandbyStatus:
    "STATUS: STANDBY\n\n" +
    "Wir machen keine Kompromisse bei Qualität. Diese Woche gibt es kein High-Synergy-Match für dich.\n\n" +
    "Deine Priorität für den nächsten Drop wurde erhöht.",
  noMatchThisWeekTier1:
    "Hey 💫\n\n" +
    "Diese Woche konnte unser Matchmaker niemanden finden, der wirklich unsere Qualitätslatte für dich erreicht - " +
    "und wir warten lieber, als dich mit jemandem zu matchen, der deine Zeit nicht wert ist.\n\n" +
    "Ein paar ehrliche Punkte:\n" +
    "• Wir bauen die Community schnell aus und verbessern den Algorithmus jeden Tag.\n" +
    "• Ein wirklich passender Mensch sollte in einem der nächsten Drops auftauchen.\n" +
    "• Jedes Date, das wir organisieren, geht *komplett auf uns* - Kaffee, Dinner, alles. ☕️🎬\n\n" +
    "Bis nächsten Donnerstag um 18:00 ✨",
  noMatchThisWeekTier2:
    "Hey 🌿\n\n" +
    "Zweite Woche in Folge und unser Matchmaker hat noch niemanden gefunden, den wir dir wirklich gern vorstellen würden. " +
    "Danke für deine Geduld - das bedeutet uns viel.\n\n" +
    "Was du wissen solltest:\n" +
    "• Wir bringen aktiv mehr passende Studierende in die Community und tunen den Algorithmus für dich.\n" +
    "• Ein wirklich guter Partner sollte nur ein paar Drops entfernt sein.\n" +
    "• Wenn das Date passiert, ist es *komplett von uns gedeckt* - daran ändert sich nichts.\n\n" +
    "Bis Donnerstag um 18:00 - wir arbeiten für dich 🤍",
  noMatchThisWeekTier3:
    "Hey ✨\n\n" +
    "Wir schulden dir ein ehrliches Update - immer noch niemand, der deine Zeit wirklich wert wäre. " +
    "Uns nervt das selbst, und wir tun nicht so, als wäre es anders.\n\n" +
    "Was bei uns gerade passiert:\n" +
    "• Wir beobachten deine Queue persönlich und pushen das Community-Wachstum in deiner Gegend.\n" +
    "• Die richtige Person kommt in einem der nächsten Drops - wir hören nicht auf, bis es klappt.\n" +
    "• Dein Date ist *komplett auf uns*, sobald es passiert. Das ist unser Versprechen.\n\n" +
    "Danke für dein Vertrauen. Bis Donnerstag um 18:00 🤍",
  matchScheduleProposal: "Wie wäre es mit einer dieser Zeiten? Tipp an, was passt:",
  matchScheduleIter3:
    "Öffne den Kalender, wähle Daten und markiere alle Zeiten, die dir passen. Dein Match sieht sie live und kann das Date mit einem Tap fixieren.",
  matchScheduleBtnCalendar: "📅 Kalender öffnen",
  matchScheduleNoOverlap: "Noch keine Überschneidung - nächste Runde.",
  matchScheduled: "Fixiert! {venue} - bis dann 🤝",
  matchScheduledBtnOpenMaps: "📍 In Maps öffnen",
  matchSchedulePickedPrefix: "Du hast gewählt: ",
  matchScheduleWaitingPeer: "Warten auf die andere Person...",
  matchSchedulePeerProposed:
    "Dein Match hat Daten und Zeiten im Kalender markiert. Öffne ihn, um eine zu bestätigen oder eine eigene vorzuschlagen:",
  matchSchedulePeerSuggestedAlternative:
    "Dein Match hat eine andere Zeit vorgeschlagen. Schau dir die Antwort an: du kannst zustimmen oder selbst etwas vorschlagen.",
  matchScheduleSavedConfirmation:
    "✅ Deine Daten und Zeiten sind gespeichert. Wir haben dein Match gepingt - ich sage Bescheid, sobald eine Antwort kommt.",
  matchScheduleNoOverlapYet:
    "Ihr habt beide Daten und Zeiten markiert, aber noch keine Überschneidung. Öffne den Kalender und füge ein paar Optionen hinzu - sobald ein Slot passt, fixieren wir es:",
  venueConciergeIntro:
    "Zeit ist fix 🗓️ Letzter Schritt - der Ort.\n\n" +
    "Sag mir den *Vibe* (z. B. _ruhiges Cafe_, _veganer Spot_, _Parkspaziergang_, _kleines Museum_), " +
    "und tippe dann unten auf *Auf Karte wählen*, um auszuwählen, von wo du kommst " +
    "(Metro, Adresse, bei Freunden - alles geht).",
  venueConciergeBtnLocation: "📍 Standort senden",
  venueConciergeBtnMap: "🗺️ Auf Karte wählen",
  venueVibeNoted: "Vibe notiert ✅ Jetzt wähle, von wo du kommst:",
  venueLocationNoted:
    "Standort gespeichert ✅ Sag mir jetzt den *Vibe* - z. B. _ruhiges Cafe_, _veganer Brunch_, _Parkspaziergang_.",
  venueSafetyOverride: "Heads up - ich habe stattdessen ein öffentliches Cafe gewählt. Erste Dates bleiben bei uns öffentlich.",
  venueWaitingPeer: "Deins ist da ✅ Warten auf die andere Person...",
  venueSearching: "Suche den perfekten Spot zwischen euch beiden... 🔍",
  venueSearchStep2: "📍 Ich vergleiche Routen und Fahrzeiten für euch beide…",
  venueSearchStep3: "✨ Ich wähle den besten Ort für eure Stimmung…",
  onbAnalyzeStep1: "🧠 Ich lese deinen Kontext…",
  onbAnalyzeStep2: "🧩 Ich erfasse deine zentralen Eigenschaften und Werte…",
  onbAnalyzeStep3: "🧮 Ich erstelle dein psychologisches Profil…",
  verifyAnalyzeStep1: "🔍 Ich gleiche dein Selfie mit deinen Fotos ab…",
  verifyAnalyzeStep2: "🧬 Ich analysiere die Gesichtsmerkmale…",
  verifyAnalyzeStep3: "⏳ Ich schließe die Prüfung ab…",
  skipAnalyzeStep1: "✨ Alles klar. Ich stelle dein Profil fertig…",
  skipAnalyzeStep2: "🧮 Ich finalisiere dein psychologisches Profil…",
  skipAnalyzeStep3: "💞 Ich bereite dich auf das wöchentliche Matching vor…",
  profilerBatchSaving: "🧩 Ich füge deine Antworten deinem Profil hinzu…",
  profilerBatchSaved:
    "✅ Deine Präferenznotizen aktualisiert — ich berücksichtige das beim nächsten Match.",

  // --- Phase 3.7: Venue change (female-exclusive one-shot) ---
  venueChangeFemaleButton: "🔄 Ort ändern",
  venueChangeFemaleHint:
    "Übrigens — du hast die einmalige Möglichkeit, diesen Ort zu ändern. " +
    "Tippe oben auf *Ort ändern*, um einen anderen Ort in der Nähe zu wählen. " +
    "Dein Match muss zustimmen, und du kannst das nur einmal tun.",
  venueChangeMaleIntro: "Dein Match möchte den Ort ändern.",
  venueChangeMaleNewVenue: "Neuer Ort: {venue}",
  venueChangeMaleComment: "Ihre Notiz:",
  venueChangeMaleAsk:
    "Stimme dem neuen Ort zu oder lehne ab. Ablehnen sagt das Date ab.",
  venueChangeBtnAccept: "✅ Neuen Ort akzeptieren",
  venueChangeBtnDecline: "❌ Ablehnen (Date absagen)",
  venueChangeDeclineConfirm:
    "Bist du sicher? Wenn du den vorgeschlagenen Ort nicht akzeptierst, werden " +
    "dein Date und dein Match endgültig abgesagt — das lässt sich nicht rückgängig machen.",
  venueChangeBtnConfirmCancel: "Ja, Match absagen",
  venueChangeBtnBack: "Nein, ich habe es mir anders überlegt",
  venueChangeAcceptedFemale: "Dein Match hat den neuen Ort akzeptiert! 🎉 {venue}",
  venueChangeAcceptedMaleAck: "Erledigt — der Ort wurde aktualisiert. {venue}",
  venueChangeCancelledFemale:
    "Dein Match hat den neuen Ort nicht akzeptiert, daher wurde das Date abgesagt.",
  venueChangeCancelledMale: "Das Date wurde abgesagt.",
  venueChangeExpiredCancel:
    "Die Frist zur Bestätigung des neuen Ortes ist abgelaufen, daher wurde das Date abgesagt.",
  venueChangeAlreadyResolved: "Über diese Ortsänderung wurde bereits entschieden.",
  icebreakerIntro: "Dein Date ist in 5 Stunden! Ein paar Gesprächsstarter für dich:\n\n",
  wingmanHintIntro: "👋 Insider-Tipp - dein Date ist in 90 Minuten:\n\n",
  dateHintsIntro: "\n\n💡 Ein paar Tipps zum Planen:\n",
  profilerSkip: "Überspringen",
  emergencyUnlocked:
    "Das Notfall-Storno-Fenster ist offen.\n" +
    "Wenn du wirklich nicht kannst, tippe unten.\n" +
    "*Du musst einen Grund schreiben - er wird exakt so an dein Match weitergeleitet.*",
  emergencyBtn: "🚨 Date absagen",
  emergencyConfirmPrompt:
    "Willst du dieses Date wirklich absagen?\n" +
    "*Das ist endgültig — nach dem Absagen lässt sich das Match nicht wiederherstellen.*",
  emergencyBtnConfirm: "Ja, Date absagen",
  emergencyBtnBack: "Nein, Date behalten",
  emergencyAborted: "Okay — dein Date bleibt bestehen. 👍",
  emergencyAskReason: "Schreib deinen Grund. Das geht *wortwörtlich* an dein Match.",
  emergencyConfirmed: "Date abgesagt. Deine Nachricht wurde weitergeleitet.",
  emergencyReceivedOther: "Dein Match hat das Date abgesagt. Das wurde geschrieben:\n\n\"{reason}\"",
  emergencyReceivedOtherIntro: "Dein Match hat das Date abgesagt. Das wurde geschrieben:",
  emergencyReceivedOtherSoftNote: "Das liegt nicht an dir. Gennety erhöht deine Priorität für nächste Woche ein wenig.",
  feedbackInvitation:
    "Wie lief dein Date? ✨\n\n" +
    "Erzähl uns ein paar Dinge - Chemie, Vibe, was du ändern würdest. " +
    "Wir nutzen es, um nächstes Mal jemanden noch besseren zu finden.",
  feedbackBtnForm: "✍️ Feedback-Formular öffnen",
  feedbackBtnVoice: "🎤 Stattdessen Sprachnachricht senden",
  feedbackVoiceAsk:
    "Nimm einfach eine Sprachnachricht auf 🎙️\n\n" +
    "Erzähl, wie das Date lief - gab es Chemie? Was mochtest du? " +
    "Was hat nicht funktioniert? Eine Minute reicht.",
  feedbackThanks: "Danke für dein Feedback ✨ Wir nutzen es, um deine zukünftigen Matches zu verbessern.",
  reportBtn: "🚨 Melden",
  reportAsk: "Diese Meldung ist privat. Was beschreibt das Problem am besten?",
  reportCategoryFakePhotos: "Fake- oder irreführende Fotos",
  reportCategoryWrongPerson: "Falsche Person auf dem Foto",
  reportCategoryOffensive: "Beleidigendes oder verstörendes Verhalten",
  reportCategoryUnsafe: "Unsicher / Red Flag",
  reportCategorySpam: "Spam oder Betrug",
  reportCategoryInappropriate: "Unangemessenes Profil",
  reportCategoryOther: "Anderes",
  reportDetailAsk: "Noch etwas, das die Prüfung beschleunigt? Du kannst tippen, eine Sprachnachricht senden oder überspringen.",
  reportDetailAskOther: "Beschreib bitte kurz, was passiert ist. Du kannst tippen oder eine Sprachnachricht senden.",
  reportSkipBtn: "Überspringen",
  reportThanksT1: "Verstanden - wir nutzen das, um deine zukünftigen Matches zu verbessern 🎯",
  reportThanksT2: "Gemeldet. Danke - wir kümmern uns darum.",
  reportThanksT3: "Gemeldet. Wir frieren den Account für eine manuelle Prüfung ein - danke fürs Bescheid sagen.",
  reportFailed: "Konnte die Meldung gerade nicht verarbeiten. Versuch es in einer Minute nochmal.",
  reportDuplicate: "Du hast dieses Match bereits gemeldet.",
  reportWarningStrike1:
    "⚠️ Heads up: Wir haben eine Meldung zu deinem Verhalten bei einem aktuellen Match erhalten. " +
    "Gennety erwartet respektvolles und verlässliches Verhalten. Eine weitere bestätigte Meldung sperrt deinen Account vorübergehend.",
  reportSuspendedDM:
    "🚫 Dein Account wurde wegen wiederholter Meldungen für 14 Tage gesperrt. " +
    "In dieser Zeit erhältst du keine Matches. Danach wird er automatisch reaktiviert.",
  reportBannedDM: "⛔ Dein Account wurde wegen mehrerer bestätigter Meldungen dauerhaft gesperrt.",
  reportPendingInvestigationDM:
    "🚫 Dein Account wurde für eine Sicherheitsprüfung eingefroren. " +
    "Unser Team meldet sich über @gennetysupport, falls weitere Schritte nötig sind.",
  safetyNoteFemale:
    "Hey! Dein Gennety-Date startet in 90 Minuten bei **{location_name}**.\n\n" +
    "Deine Sicherheit ist uns wichtig, deshalb eine kurze Checkliste für das erste Treffen:\n\n" +
    "📍 **Bleib beim Plan.** Wir haben einen sicheren öffentlichen Ort gewählt. Stimm keinem Wechsel an einen privaten Ort zu und geh nicht zu jemandem nach Hause.\n" +
    "🚗 **Transport.** Komm selbst hin und zurück - ÖPNV, Taxi oder zu Fuß. Steig nicht bei jemandem ins Auto, den du kaum kennst.\n" +
    "📱 **Sag jemandem Bescheid.** Schick die Treffdetails an eine Freundin, einen Freund oder Familie und teile wenn möglich deinen Live-Standort.\n" +
    "☕ **Bleib aufmerksam.** Lass Sachen und Getränk möglichst nicht unbeaufsichtigt.\n" +
    "🛑 **Deine Grenzen.** Wenn du dich unwohl fühlst oder das Verhalten komisch wirkt, kannst du jederzeit gehen. Deine Sicherheit ist wichtiger als Höflichkeit.\n\n" +
    "Hab einen schönen Abend ✨",
  statusDaysHours: "⏳ Nächstes Match in {d}T {h}Std",
  statusHoursMinutes: "⏳ Matches droppen in {h}Std {m}Min",
  statusMinutes: "🔥 Fast bereit! Matches droppen in {m} Min",
  statusProcessing: "✨ Analysiere den Campus... Schau später nochmal rein.",
  voiceTranscriptionFailed: "Ich konnte das nicht klar verstehen - kannst du es tippen?",
  voiceTooLong: "Die Sprachnachricht ist etwas lang. Maximal 5 Minuten - oder schreib es einfach.",
};

const plTranslations: TranslationTable = {
  ...translations.en,
  consentMessage:
    "Witamy w Gennety Dating!\n\n" +
    "Zanim zaczniemy, przeczytaj Politykę prywatności i zaakceptuj warunki przechowywania danych.",
  consentAgree: "Akceptuję",
  welcome: "Gennety Dating 👀\nAI matchmaking dla studentów.",
  chooseLanguage: "Wybierz język:",
  philosophyPitch:
    "Gennety działa według jednej zasady: *Zero Chat*.\n\n" +
    "Nie piszesz do swojego dopasowania. Nasza AI rozumie, kim jesteś, " +
    "znajduje naprawdę kompatybilną osobę i ogarnia wszystko - czas, miejsce, cały plan.\n\n" +
    "Ty po prostu przychodzisz. Brzmi dobrze?",
  philosophyContinue: "Wchodzę w to 🚀",
  askEmail: "Wyślij swój e-mail uniwersytecki (np. name@stanford.edu):",
  invalidEmail: "Hm, to nie wygląda jak e-mail uniwersytecki. Spróbuj adresu .edu albo .ac.uk.",
  otpSent: "Wysłaliśmy 6-cyfrowy kod na *{email}*. Wpisz go tutaj:",
  otpInvalid: "Ten kod nie zadziałał. Spróbuj ponownie:",
  otpExpired: "Kod wygasł. Wpisz e-mail jeszcze raz:",
  otpTooManyAttempts: "Za dużo prób. Wpisz e-mail ponownie, wyślemy nowy kod.",
  otpCooldown: "Poczekaj chwilę - nowy kod możesz zamówić za minutę.",
  emailVerified: "E-mail potwierdzony ✅",
  askFirstName: "Jak masz na imię?",
  askSurname: "A nazwisko?",
  askAge: "Ile masz lat?",
  invalidAge: "Wpisz wiek od {min} do {max}.",
  askGender: "Jaka jest Twoja płeć?",
  askPreference: "Kto Ci się podoba?",
  btnMale: "Mężczyzna",
  btnFemale: "Kobieta",
  btnMen: "Mężczyźni",
  btnWomen: "Kobiety",
  btnBoth: "Obie opcje",
  llmAnalysing1: "Czytam Twój profil... 🧠",
  llmAnalysing2: "Wyciągam cechy osobowości...",
  llmAnalysing3: "Buduję Twój psychologiczny odcisk...",
  llmDumpReceived: "Profil gotowy ✨",
  askPhotos: "Prawie gotowe! Wyślij {min}-{max} zdjęć siebie. Po jednym.",
  photoReceived: "Zdjęcie {n}/{max} ✅",
  photoRejected:
    "Potrzebuję wyraźnego zdjęcia tylko *Ciebie* - jedna osoba, widoczna twarz.\n\n" +
    "Bez memów, krajobrazów i zdjęć grupowych. Spróbuj inne.",
  photoVisionError: "Nie udało się przetworzyć zdjęcia. Wyślij je za chwilę ponownie.",
  photosEnough: "Możesz wysłać więcej (do {max}) albo kliknąć przycisk, żeby iść dalej.",
  photosDone: "Zdjęcia przesłane ✅",
  profileReview:
    "Oto Twój profil:\n\n" +
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n\n" +
    "{summary}\n\n" +
    "Wygląda dobrze?",
  profileConfirm: "Wygląda dobrze ✅",
  profileEdit: "Zmień coś",
  onboardingComplete:
    "Jesteś w środku! 🎉\n\n" +
    "Nasza AI już szuka Twojego dopasowania. " +
    "Odezwę się, gdy pojawi się ktoś wyjątkowy.",
  btnContinuePhotos: "Dalej ➡️",
  finishOnboardingFirst:
    "Najpierw dokończ rejestrację, potem menu i ustawienia będą dostępne.\nWpisz /start, aby kontynuować.",
  verifyPitch:
    "Ostatni krok. Musimy potwierdzić, że jesteś prawdziwą osobą.\n\n" +
    "Porównujemy selfie z weryfikacji z każdym zdjęciem w Twoim profilu. " +
    "Zdjęcia, które nie pasują do Ciebie, zostaną odrzucone.\n\n" +
    "Pominięcie weryfikacji mocno obniży Twój startowy ranking ELO, " +
    "a algorytm będzie pokazywał Ci mniej dopasowań.",
  verifyBtnGo: "🟢 Zweryfikuj teraz",
  verifyBtnCheck: "✅ Zakończyłem/am weryfikację",
  verifyBtnSkip: "⚪️ Pomiń na razie",
  verifySkipNudgeCaption:
    "Chwila — posłuchaj tego, zanim pominiesz 👆",
  verifyBtnReconsider: "🟢 Dobra, zweryfikuję się",
  verifyBtnSkipConfirm: "⚪️ Pomiń mimo to",
  verifySkipped:
    "Weryfikacja pominięta. Możesz uruchomić ją później z menu profilu, " +
    "aby przywrócić swój ranking ELO.",
  verifyCheckPending:
    "🔍 Persona ma Twoją weryfikację, ale nadal ją przetwarza. " +
    "Daj jej chwilę i kliknij przycisk ponownie.",
  verifyCheckNoInquiry:
    "Nie widzę jeszcze próby weryfikacji. Najpierw kliknij 🟢 Zweryfikuj teraz, " +
    "przejdź flow, potem wróć i kliknij ten przycisk.",
  verifyCheckPersonaFailed:
    "❌ Weryfikacja nie przeszła po stronie Persona. Kliknij 🟢 Zweryfikuj teraz, " +
    "aby spróbować ponownie.",
  verifyCheckAlreadyDone:
    "Już przetworzone - powinna pojawić się wiadomość z wynikiem powyżej. " +
    "Jeśli coś wygląda źle, kliknij 🟢 Zweryfikuj teraz, aby spróbować ponownie.",
  verifyCheckInfraError: "Nie udało się teraz połączyć z usługą weryfikacji. Spróbuj za chwilę.",
  verifyOutcomeVerified:
    "✅ Weryfikacja zakończona - Twój profil jest aktywny. Odezwę się, gdy znajdę dopasowanie.",
  verifyOutcomePendingReview:
    "🔍 Jeszcze raz sprawdzamy zdjęcia z profilu względem selfie z weryfikacji. Zwykle zajmuje to kilka godzin - napiszę, gdy będzie gotowe.",
  verifyOutcomeRejected:
    "⚠️ Zdjęcia w profilu nie wyglądają na zgodne z selfie z weryfikacji. Zmień je na wyraźne zdjęcia siebie, potem otwórz Ustawienia → Zweryfikuj konto i spróbuj ponownie.",
  verifyAutoPollStarted:
    "✨ Jasne. Złap kawę ☕ - porównuję selfie z Twoimi zdjęciami profilowymi. " +
    "To potrwa minutę albo dwie.",
  verifyAutoPollTimeout:
    "Hm, trwa to dłużej niż zwykle. Kliknij przycisk poniżej, gdy mam sprawdzić ponownie.",
  verifyAutoPollPersonaFailed: "Weryfikacja nie przeszła po stronie Persona. Kliknij 🟢 Zweryfikuj teraz, aby spróbować ponownie.",
  verifyAutoPollInfraError: "Nie udało się połączyć z usługą weryfikacji. Spróbuj za chwilę.",
  // Persona Embedded Mini App copy (verification.html)
  verifyMiniAppLoading: "Otwieramy weryfikację…",
  verifyMiniAppFinishing: "Już prawie. Sprawdzamy wynik…",
  verifyMiniAppError: "Nie udało się uruchomić weryfikacji. Spróbuj ponownie.",
  verifyMiniAppCloseBtn: "Zamknij",
  photoMatchMismatch:
    "⚠️ To zdjęcie nie pasuje do selfie z weryfikacji. " +
    "Prześlij wyraźne zdjęcie siebie, najlepiej w podobnym świetle.",
  menuTitle: "🎓 *Menu Gennety*\nCo słychać?",
  menuMyProfile: "👤 Mój profil",
  menuEdit: "✏️ Edytuj profil",
  menuPause: "⏸ Wstrzymaj matching",
  menuResume: "▶️ Wznów matching",
  menuSettings: "⚙️ Ustawienia",
  menuHelp: "💬 Pomoc",
  menuMyTickets: "🎟️ Moje bilety",
  videoTooLong:
    "Wideo do profilu może mieć maksymalnie 60 sekund. Wyślij krótsze.",
  videoTooLarge:
    "Wideo do profilu może ważyć maksymalnie 50 MB. Wyślij mniejsze.",
  ticketRewardPhoto:
    "🎟️ Świetnie — właśnie zdobyłeś *darmowy bilet na randkę*!\n\nJak to działa: każda randka kosztuje 1 bilet, a bilety zwykle są płatne. Za dodane zdjęcia masz jeden gratis. Saldo: *{balance}* 🎟️",
  ticketRewardVideo:
    "🎟️ Wideo w profilu — super! Oto kolejny *darmowy bilet na randkę*.\n\nKażda randka kosztuje 1 bilet (zwykle płatny). Saldo: *{balance}* 🎟️",
  ticketWalletText:
    "🎟️ *Moje bilety*\n\nMasz *{balance}* bilet(ów). Każda randka kosztuje 1 bilet — dokupisz w każdej chwili.",
  ticketWalletOpenStore: "🎟️ Kup bilety",
  menuBack: "⬅️ Wstecz",
  myProfileBody:
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n" +
    "🌐 {language}\n\n" +
    "{summary}",
  myProfileNoBio: "_Brak bio._",
  editProfileBody:
    "Te dane są zablokowane:\n\n" +
    "• *Imię i nazwisko:* {firstName} {surname}\n" +
    "• *Wiek:* {age}\n" +
    "• *Uniwersytet:* {university}\n\n" +
    "Możesz edytować:",
  editBioBtn: "📝 Bio",
  editPrefsBtn: "🔍 Preferencje",
  editMajorBtn: "🎓 Kierunek",
  editProfilePhotosBtn: "📸 Prześlij zdjęcia ponownie",
  editBioPrompt: "Wyślij nowe bio (maks. 500 znaków):",
  editBioTooLong: "Za długie - zmieść się w 500 znakach.",
  editBioSaved: "Bio zaktualizowane ✅",
  editMajorPrompt: "Jaki masz kierunek? (maks. 100 znaków):",
  editMajorTooLong: "Za długie - zmieść się w 100 znakach.",
  editMajorSaved: "Kierunek zaktualizowany ✅",
  editPrefsTitle: "🔍 *Preferencje wyszukiwania*\n\nCo chcesz zmienić?",
  editPrefsAgeBtn: "🎂 Zakres wieku",
  editPrefsBack: "⬅️ Wróć do edycji",
  editAgeRangePrompt: "Jaki zakres wieku? (np. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Nie łapię. Podaj dwie liczby, np. 20-28 (zakres {min}-{max}).",
  editAgeRangeSaved: "Zakres wieku zaktualizowany ✅",
  editProfilePhotosStart: "Wyślij nowe zdjęcia ({min}-{max}). Po jednym.",
  editProfilePhotosSaved: "Zdjęcia zaktualizowane ✅",
  pauseConfirmed: "Matching wstrzymany ⏸\nNie będzie nowych dopasowań, dopóki go nie wznowisz.",
  resumeConfirmed: "Matching znowu działa ▶️\nNasza AI już pracuje.",
  settingsTitle: "⚙️ Ustawienia",
  settingsLanguage: "🌐 Język",
  settingsLanguagePick: "Wybierz język:",
  settingsLanguageSaved: "Język zaktualizowany ✅",
  settingsVerify: "🛡 Zweryfikuj konto",
  settingsVerifyNotNeeded: "Masz już weryfikację ✅",
  settingsVerifyUnavailable: "Weryfikacja jest tymczasowo niedostępna. Spróbuj później.",
  helpBody:
    "*Potrzebujesz pomocy?* 💬\n\n" +
    "Nie tworzymy czatów między użytkownikami - tak działa nasz model. " +
    "Problem z dopasowaniem, randką albo botem? Napisz do supportu:\n\n" +
    "💬 [@gennetysupport](https://t.me/gennetysupport)",
  settingsDeleteAccount: "🗑 Usuń konto",
  deleteAccountConfirm:
    "Na pewno? To *trwale usunie* Twoje konto.\n\n" +
    "Zniknie wszystko - profil, zdjęcia, dopasowania, embeddingi. " +
    "*Tego nie da się cofnąć.*",
  deleteAccountYes: "Tak, usuń wszystko",
  deleteAccountNo: "Anuluj",
  deleteAccountDone:
    "Konto usunięte. Wszystkie dane wyczyszczone.\n" +
    "Chcesz wrócić? Po prostu wyślij /start.",
  matchHeadline: "💘 Znaleźliśmy dla Ciebie dopasowanie!",
  matchDeadlineNotice:
    "Masz 24h na odpowiedź. " +
    "Gdy klikniesz, *decyzja jest ostateczna*. Bez cofania.",
  matchStreamStart: "Sprawdzam, dlaczego do siebie pasujecie...",
  matchBtnAccept: "✅ Akceptuj",
  matchBtnDecline: "❌ Odpuść",
  matchAccepted: "Nice! Czekamy na drugą osobę...",
  matchBothAccepted: "Wzajemne 🔥 Znajdźmy termin.",
  matchDeclined:
    "W porządku. Jaki był główny powód, że odpuściłeś/odpuściłaś?\n\n" +
    "Wybierz poniżej albo wyślij krótki tekst lub wiadomość głosową. AI przeanalizuje to dla kolejnego dropu.\n\n" +
    "Jeśli chodzi o coś innego, powiedz nam - następnym razem zaproponujemy kogoś lepiej pasującego do Twoich zainteresowań i preferencji.",
  matchDeclineReasonType: "Nie mój typ",
  matchDeclineReasonVibe: "Inny vibe",
  matchDeclineReasonInterests: "Zainteresowania nie pasują",
  matchDeclineReasonLifestyle: "Styl życia nie pasuje",
  matchDeclineReasonOther: "Coś innego",
  matchDeclineOtherAsk:
    "Jasne - wyślij krótki tekst albo wiadomość głosową z powodem. AI użyje tego w kolejnym dropie.",
  matchDeclineFeedbackSaved: "Jasne. Użyjemy tego, żeby lepiej stroić kolejne rekomendacje 🎯",
  matchDeclineAlreadyNoted: "Już zapisane - dzięki.",
  matchDeclineFeedbackFailed: "Nie udało się teraz zapisać. Nadal możesz wysłać krótki tekst albo głosówkę.",
  matchDeclineThanks: "Zapisane. Szukamy dalej 🎯",
  matchPeerDecided:
    "Twoje dopasowanie już odpowiedziało. Teraz Twoja kolej.\n\n" +
    "*Co* wybrali, zobaczysz dopiero po własnej odpowiedzi. " +
    "I pamiętaj: Twoja odpowiedź jest ostateczna.",
  matchPeerWasAccepted: "FYI - Twoje dopasowanie było na tak. Tym razem po prostu się nie złożyło.",
  matchPeerWasDeclined: "FYI - Twoje dopasowanie tym razem odpuściło.",
  matchAcceptedPeerDeclined:
    "Niestety Twoje dopasowanie nie zgodziło się na spotkanie. " +
    "To okej. W Gennety randki dzieją się tylko wtedy, gdy zainteresowanie jest wzajemne. " +
    "Będziemy szukać lepszego dopasowania.",
  matchAcceptedPeerDeclinedPriority:
    "Niestety Twoje dopasowanie nie zgodziło się na spotkanie. " +
    "To okej. W Gennety randki dzieją się tylko wtedy, gdy zainteresowanie jest wzajemne.\n\n" +
    "Podnieśliśmy Twoją priorytetowość na kolejny czwartek, żeby zwiększyć szansę na naprawdę przyjemny wieczór.",
  matchPhotoCaption: "{name}, {age}",
  matchVerifiedLabel: "Zweryfikowano",
  matchVerifiedQuote:
    "Zweryfikowaliśmy tę osobę. Przeszła face-match check - " +
    "zdjęcia w profilu pasują do jej prawdziwej tożsamości.",
  matchSynergyHeader: "💎 *Synergia {score}/99* — {reason}",
  pitchCountdownHours: "⏳ Zostało {hours}h na odpowiedź",
  pitchCountdownMinutes: "⏳ Zostało {minutes} min na odpowiedź",
  pitchExpired: "⏳ Czas minął - ta propozycja wygasła.",
  matchExpiredSilentWarning:
    "Czas minął - nie odpowiedziałeś/odpowiedziałaś na dopasowanie w ciągu 24h. " +
    "Poczekaj na kolejny czwartkowy drop.\n\n" +
    "Prosimy, nie ignoruj propozycji - to nie fair wobec drugiej osoby. " +
    "Następnym razem obniżymy za to Twój rating.",
  matchExpiredSilentPenalty:
    "Czas minął - nie odpowiedziałeś/odpowiedziałaś na dopasowanie w ciągu 24h. " +
    "Poczekaj na kolejny czwartkowy drop.\n\n" +
    "Twój rating został obniżony za ignorowanie propozycji - to nie fair wobec drugiej osoby.",
  matchExpiredYouMissedDate: "Heads up - Twoje dopasowanie było naprawdę na tak. Przegapiłeś/przegapiłaś realną randkę.\n\n",
  matchExpiredPeerIgnored:
    "Twoje dopasowanie nie odpowiedziało w ciągu 24h, więc randka się nie odbędzie. " +
    "Widzimy się przy kolejnym dropie.",
  matchStandbyStatus:
    "STATUS: STANDBY\n\n" +
    "Nie idziemy na kompromis w jakości. W tym tygodniu nie ma dla Ciebie wysokosynergicznego dopasowania.\n\n" +
    "Twoja priorytetowość na kolejny drop została podniesiona.",
  noMatchThisWeekTier1:
    "Hej 💫\n\n" +
    "W tym tygodniu nasz matchmaker nie znalazł osoby, która naprawdę spełniałaby nasz próg jakości dla Ciebie - " +
    "wolimy poczekać niż łączyć Cię z kimś niewartym Twojego czasu.\n\n" +
    "Kilka szczerych rzeczy:\n" +
    "• Szybko rozwijamy społeczność i codziennie dopracowujemy algorytm.\n" +
    "• Naprawdę pasująca osoba powinna pojawić się w jednym z kolejnych dropów.\n" +
    "• Każda randka, którą organizujemy, jest *w pełni po naszej stronie* - kawa, kolacja, wszystko. ☕️🎬\n\n" +
    "Do zobaczenia w następny czwartek o 18:00 ✨",
  noMatchThisWeekTier2:
    "Hej 🌿\n\n" +
    "Drugi tydzień z rzędu nasz matchmaker nadal nie znalazł osoby, którą naprawdę chcielibyśmy Ci przedstawić. " +
    "Dzięki za cierpliwość - to dla nas ważne.\n\n" +
    "Co chcemy, żebyś wiedział(a):\n" +
    "• Aktywnie sprowadzamy więcej studentów podobnych do Ciebie i stroimy algorytm pod Twoją korzyść.\n" +
    "• Naprawdę świetna osoba powinna być już tylko kilka dropów stąd.\n" +
    "• Gdy randka się wydarzy, jest *w pełni pokryta przez nas* - to się nie zmienia.\n\n" +
    "Do czwartku o 18:00 - pracujemy dla Ciebie 🤍",
  noMatchThisWeekTier3:
    "Hej ✨\n\n" +
    "Należy Ci się kolejne szczere info - nadal nie ma osoby, która naprawdę byłaby warta Twojego czasu. " +
    "Nas też to frustruje i nie będziemy udawać inaczej.\n\n" +
    "Co dzieje się po naszej stronie:\n" +
    "• Osobiście obserwujemy Twoją kolejkę i rozwijamy społeczność w Twojej okolicy.\n" +
    "• Właściwa osoba trafi do jednego z kolejnych dropów - nie przestaniemy, dopóki się nie uda.\n" +
    "• Twoja randka, gdy już się wydarzy, jest *w pełni po naszej stronie*. To nasza obietnica.\n\n" +
    "Dzięki za zaufanie. Do czwartku o 18:00 🤍",
  matchScheduleProposal: "Co powiesz na jedną z tych opcji? Kliknij, co pasuje:",
  matchScheduleIter3:
    "Otwórz kalendarz, wybierz daty i zaznacz wszystkie godziny, które Ci pasują. Twoje dopasowanie zobaczy je na żywo i może ustalić randkę jednym kliknięciem.",
  matchScheduleBtnCalendar: "📅 Otwórz kalendarz",
  matchScheduleNoOverlap: "Jeszcze brak wspólnego terminu - kolejna runda.",
  matchScheduled: "Ustalone! {venue} - do zobaczenia 🤝",
  matchScheduledBtnOpenMaps: "📍 Otwórz w Mapach",
  matchSchedulePickedPrefix: "Wybrałeś/wybrałaś: ",
  matchScheduleWaitingPeer: "Czekamy na drugą osobę...",
  matchSchedulePeerProposed:
    "Twoje dopasowanie zaznaczyło daty i godziny w kalendarzu. Otwórz go, żeby potwierdzić jedną albo zaproponować własną:",
  matchSchedulePeerSuggestedAlternative:
    "Twoje dopasowanie zaproponowało inny termin. Sprawdź odpowiedź: możesz się zgodzić albo zaproponować swój.",
  matchScheduleSavedConfirmation:
    "✅ Zapisaliśmy Twoje daty i godziny. Daliśmy znać dopasowaniu - odezwę się, gdy odpowiedzą.",
  matchScheduleNoOverlapYet:
    "Oboje zaznaczyliście daty i godziny, ale jeszcze nic się nie pokrywa. Otwórz kalendarz i dodaj kilka opcji - ustalimy randkę, gdy tylko slot się zgodzi:",
  venueConciergeIntro:
    "Termin ustalony 🗓️ Ostatni krok - miejsce.\n\n" +
    "Powiedz mi, jaki *vibe* chcesz (np. _cicha kawiarnia_, _wegańskie miejsce_, _spacer po parku_, _małe muzeum_), " +
    "a potem kliknij *Wybierz na mapie* poniżej, żeby wskazać, skąd będziesz jechać " +
    "(metro, adres, dom znajomego - cokolwiek działa).",
  venueConciergeBtnLocation: "📍 Wyślij lokalizację",
  venueConciergeBtnMap: "🗺️ Wybierz na mapie",
  venueVibeNoted: "Vibe zapisany ✅ Teraz wybierz, skąd będziesz jechać:",
  venueLocationNoted:
    "Lokalizacja zapisana ✅ Teraz powiedz mi *vibe* - np. _cicha kawiarnia_, _wegański brunch_, _spacer po parku_.",
  venueSafetyOverride: "Heads up - wybraliśmy publiczną kawiarnię. Pierwsze randki trzymamy w publicznych miejscach.",
  venueWaitingPeer: "Twoje zapisane ✅ Czekamy na drugą osobę...",
  venueSearching: "Szukam idealnego miejsca między Wami... 🔍",
  venueSearchStep2: "📍 Porównuję trasy i czas dojazdu dla was obojga…",
  venueSearchStep3: "✨ Wybieram najlepsze miejsce pod waszą atmosferę…",
  onbAnalyzeStep1: "🧠 Czytam twój kontekst…",
  onbAnalyzeStep2: "🧩 Wyodrębniam twoje kluczowe cechy i wartości…",
  onbAnalyzeStep3: "🧮 Buduję twój profil psychologiczny…",
  verifyAnalyzeStep1: "🔍 Porównuję selfie z twoimi zdjęciami…",
  verifyAnalyzeStep2: "🧬 Analizuję rysy twarzy…",
  verifyAnalyzeStep3: "⏳ Kończę weryfikację…",
  skipAnalyzeStep1: "✨ Przyjąłem. Kończę twój profil…",
  skipAnalyzeStep2: "🧮 Finalizuję twój profil psychologiczny…",
  skipAnalyzeStep3: "💞 Przygotowuję cię do cotygodniowego doboru…",
  profilerBatchSaving: "🧩 Dodaję twoje odpowiedzi do profilu…",
  profilerBatchSaved:
    "✅ Zaktualizowałem twoje notatki preferencji — uwzględnię to przy następnym doborze.",

  // --- Phase 3.7: Venue change (female-exclusive one-shot) ---
  venueChangeFemaleButton: "🔄 Zmień miejsce",
  venueChangeFemaleHint:
    "À propos — masz jednorazową możliwość zmiany tego miejsca. " +
    "Naciśnij *Zmień miejsce* powyżej, aby wybrać inny lokal w pobliżu. " +
    "Twoja para będzie musiała to potwierdzić, a zrobić to możesz tylko raz.",
  venueChangeMaleIntro: "Twoja para chce zmienić miejsce spotkania.",
  venueChangeMaleNewVenue: "Nowe miejsce: {venue}",
  venueChangeMaleComment: "Jej notatka:",
  venueChangeMaleAsk:
    "Zaakceptuj nowe miejsce albo odrzuć. Odrzucenie odwołuje randkę.",
  venueChangeBtnAccept: "✅ Akceptuj nowe miejsce",
  venueChangeBtnDecline: "❌ Odrzuć (odwołaj randkę)",
  venueChangeDeclineConfirm:
    "Na pewno? Jeśli nie zaakceptujesz proponowanego miejsca, Twoja randka i " +
    "dopasowanie zostaną trwale odwołane — nie da się tego cofnąć.",
  venueChangeBtnConfirmCancel: "Tak, odwołaj dopasowanie",
  venueChangeBtnBack: "Nie, zmieniłem zdanie",
  venueChangeAcceptedFemale: "Twoja para zaakceptowała nowe miejsce! 🎉 {venue}",
  venueChangeAcceptedMaleAck: "Gotowe — miejsce zaktualizowane. {venue}",
  venueChangeCancelledFemale:
    "Twoja para nie zaakceptowała nowego miejsca, więc randka została odwołana.",
  venueChangeCancelledMale: "Randka została odwołana.",
  venueChangeExpiredCancel:
    "Czas na potwierdzenie nowego miejsca minął, więc randka została odwołana.",
  venueChangeAlreadyResolved: "Decyzja o zmianie miejsca została już podjęta.",
  icebreakerIntro: "Twoja randka jest za 5 godzin! Kilka tematów na start:\n\n",
  wingmanHintIntro: "👋 Wskazówka od środka - randka jest za 90 minut:\n\n",
  dateHintsIntro: "\n\n💡 Kilka wskazówek, jak to zaplanować:\n",
  profilerSkip: "Pomiń",
  emergencyUnlocked:
    "Okno awaryjnego odwołania jest otwarte.\n" +
    "Jeśli naprawdę nie możesz przyjść, kliknij poniżej.\n" +
    "*Musisz napisać powód - przekażemy go dopasowaniu dokładnie tak, jak go napiszesz.*",
  emergencyBtn: "🚨 Odwołaj randkę",
  emergencyConfirmPrompt:
    "Na pewno chcesz odwołać tę randkę?\n" +
    "*To nieodwracalne — po odwołaniu nie da się przywrócić dopasowania.*",
  emergencyBtnConfirm: "Tak, odwołaj randkę",
  emergencyBtnBack: "Nie, zostaw randkę",
  emergencyAborted: "Okej — Twoja randka jest aktualna. 👍",
  emergencyAskReason: "Napisz powód. To pójdzie do Twojego dopasowania *słowo w słowo*.",
  emergencyConfirmed: "Randka odwołana. Twoja wiadomość została przekazana.",
  emergencyReceivedOther: "Twoje dopasowanie odwołało randkę. Oto co napisali:\n\n\"{reason}\"",
  emergencyReceivedOtherIntro: "Twoje dopasowanie odwołało randkę. Oto co napisali:",
  emergencyReceivedOtherSoftNote: "To nie przez Ciebie. Gennety trochę podniesie Twoją priorytetowość na przyszły tydzień.",
  feedbackInvitation:
    "Jak poszła randka? ✨\n\n" +
    "Powiedz nam kilka rzeczy - chemia, vibe, co byś zmienił(a). " +
    "Użyjemy tego, żeby następnym razem znaleźć kogoś jeszcze lepszego.",
  feedbackBtnForm: "✍️ Otwórz formularz feedbacku",
  feedbackBtnVoice: "🎤 Wyślij głosówkę zamiast tego",
  feedbackVoiceAsk:
    "Po prostu nagraj wiadomość głosową 🎙️\n\n" +
    "Opowiedz, jak poszła randka - była chemia? Co Ci się podobało? " +
    "Co nie zadziałało? Minuta wystarczy.",
  feedbackThanks: "Dzięki za feedback ✨ Użyjemy go, żeby ulepszyć przyszłe dopasowania.",
  reportBtn: "🚨 Zgłoś",
  reportAsk: "To zgłoszenie jest prywatne. Co najlepiej opisuje problem?",
  reportCategoryFakePhotos: "Fałszywe albo mylące zdjęcia",
  reportCategoryWrongPerson: "Inna osoba na zdjęciu",
  reportCategoryOffensive: "Obraźliwe albo niepokojące zachowanie",
  reportCategoryUnsafe: "Niebezpieczne / red flag",
  reportCategorySpam: "Spam albo oszustwo",
  reportCategoryInappropriate: "Nieodpowiedni profil",
  reportCategoryOther: "Inne",
  reportDetailAsk: "Coś jeszcze, co pomoże szybciej to sprawdzić? Możesz napisać, wysłać głosówkę albo pominąć.",
  reportDetailAskOther: "Opisz krótko, co się stało. Możesz napisać albo wysłać głosówkę.",
  reportSkipBtn: "Pomiń",
  reportThanksT1: "Jasne - użyjemy tego, żeby lepiej stroić przyszłe dopasowania 🎯",
  reportThanksT2: "Zgłoszone. Dzięki - zajmiemy się tym.",
  reportThanksT3: "Zgłoszone. Zamrażamy konto tej osoby do ręcznej weryfikacji - dzięki za sygnał.",
  reportFailed: "Nie udało się teraz obsłużyć zgłoszenia. Spróbuj za minutę.",
  reportDuplicate: "Już zgłosiłeś/zgłosiłaś to dopasowanie.",
  reportWarningStrike1:
    "⚠️ Uwaga: otrzymaliśmy zgłoszenie dotyczące Twojego zachowania przy ostatnim dopasowaniu. " +
    "Gennety oczekuje szacunku i odpowiedzialności. Kolejne potwierdzone zgłoszenie tymczasowo zawiesi konto.",
  reportSuspendedDM:
    "🚫 Twoje konto zostało zawieszone na 14 dni z powodu powtarzających się zgłoszeń. " +
    "W tym czasie nie otrzymasz dopasowań. Konto automatycznie wróci po zakończeniu zawieszenia.",
  reportBannedDM: "⛔ Twoje konto zostało trwale zablokowane z powodu wielu potwierdzonych zgłoszeń.",
  reportPendingInvestigationDM:
    "🚫 Twoje konto zostało zamrożone do przeglądu bezpieczeństwa. " +
    "Nasz zespół skontaktuje się przez @gennetysupport, jeśli będą potrzebne dalsze kroki.",
  safetyNoteFemale:
    "Hej! Twoja randka od Gennety zaczyna się za 90 minut w **{location_name}**.\n\n" +
    "Dbamy o Twoje bezpieczeństwo, więc krótka checklista przed pierwszym spotkaniem:\n\n" +
    "📍 **Trzymaj się planu.** Wybraliśmy bezpieczne publiczne miejsce. Nie zgadzaj się na przeniesienie spotkania do prywatnej lokalizacji ani na wizytę u kogoś.\n" +
    "🚗 **Transport.** Dojedź i wróć samodzielnie - komunikacją, taksówką albo pieszo. Nie wsiadaj do auta z osobą, której prawie nie znasz.\n" +
    "📱 **Powiedz bliskim.** Prześlij szczegóły spotkania znajomej osobie albo rodzinie i jeśli możesz, udostępnij lokalizację na wieczór.\n" +
    "☕ **Uważaj.** Staraj się nie zostawiać rzeczy ani napoju bez opieki.\n" +
    "🛑 **Twoje granice.** Jeśli czujesz dyskomfort albo zachowanie drugiej osoby jest dziwne, masz pełne prawo wstać i wyjść w każdej chwili. Twoje bezpieczeństwo jest ważniejsze niż uprzejmość.\n\n" +
    "Dobrego wieczoru ✨",
  statusDaysHours: "⏳ Następne dopasowanie za {d}d {h}h",
  statusHoursMinutes: "⏳ Dopasowania wlecą za {h}h {m}min",
  statusMinutes: "🔥 Prawie gotowe! Dopasowania wlecą za {m} min",
  statusProcessing: "✨ Analizujemy kampus... Zajrzyj trochę później.",
  voiceTranscriptionFailed: "Nie usłyszałem/am wyraźnie - możesz napisać tekstem?",
  voiceTooLong: "Ta głosówka jest trochę długa. Do 5 minut albo po prostu napisz tekst.",
};

const translationsByLanguage: Record<Language, TranslationTable> = {
  en: translations.en,
  ru: translations.ru,
  uk: translations.uk,
  de: deTranslations,
  pl: plTranslations,
};

/** Get a translated string, with optional placeholder replacement */
export function t(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  let text: string = translationsByLanguage[lang][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/**
 * Escape Telegram Markdown v1 special characters so user-provided
 * content doesn't break `parse_mode: "Markdown"`.
 */
export function escapeMd(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}
