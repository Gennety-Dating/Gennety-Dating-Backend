import type { Language } from "./types.js";

const translations = {
  en: {
    // --- Onboarding ---
    consentMessage:
      "Welcome to Gennety Dating!\n\n" +
      "Before we begin, please review our Terms of Service and Privacy Policy and agree to our data retention terms.",
    consentAgree: "I Agree",
    consentPrivacyButton: "Privacy Policy",
    consentTermsButton: "Terms of Service",
    welcome: "Gennety Dating 👀\nAI matchmaking for real dates.",
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
    emailVerified: "Email confirmed ✨",
    contextDumpAck: "Got it ✨ Processing now…",
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
    askPhotos:
      "Almost done! Send {min}–{max} different photos. Every photo must clearly show you, and explicit content isn't allowed. A profile video may include friends or scenery, but you must appear clearly in several moments.",
    photoReceived: "Photo {n}/{max} ✨",
    photoRejected:
      "Your face needs to be visible in the photo. Try another shot.",
    photoDuplicate:
      "This photo is already in your profile. Add a different shot — every photo must be unique.",
    photoDuplicateNear:
      "This photo is already in your profile. Add a different shot — every photo must be unique.",
    photoUnsafeContent:
      "That photo can't be published in a profile. Please choose a different, non-explicit photo.",
    photoFaceObscured:
      "Your face is hard to make out. Take off sunglasses or a face covering and send a clearer shot.",
    photoMultipleFaces:
      "Your face needs to be visible in the photo. Try another shot.",
    photoIdentityMismatch:
      "All photos must belong to the same person. Make sure your face is in every shot.",
    photoIdentityUncertain:
      "I couldn't match that face reliably. Try a clearer photo with better light and a more visible face.",
    photoConsensusPending:
      "I haven't fixed the profile identity yet. Send one more different photo where the same person is visible.",
    photoConsensusOutlierRejected:
      "One pending photo showed a different person, so I left it out.",
    photoConsensusConfirmed:
      "Identity confirmed from matching photos ✨",
    photoConsensusNoPairCap:
      "I still don't see two photos of the same person. Nothing has been fixed yet — send another clear photo of you.",
    photoVisionError:
      "Couldn't process the file. Try again.",
    photoInvalidMedia:
      "That file isn't a supported photo. Send a JPEG, PNG, WebP, or HEIC image.",
    livePhotoMissingStatic:
      "That Live Photo is missing its still frame, so I can't verify it. Send it as a regular photo or choose another Live Photo.",
    livePhotoTooLong:
      "Live Photos need to be 10 seconds or shorter. Send a shorter one or a regular photo.",
    livePhotoTooLarge:
      "Live Photos need to be 10 MB or smaller. Send a smaller one or a regular photo.",
    videoTooLong:
      "Profile videos need to be 60 seconds or shorter. Send a shorter clip.",
    videoTooLarge:
      "Profile videos need to be {mb} MB or smaller. Send a smaller clip.",
    videoChecking:
      "Checking the video for safety and making sure you appear in several moments...",
    videoUnsafeContent:
      "That video contains content that can't be published in a profile. Please choose a different clip.",
    videoOwnerMissing:
      "Your face needs to be in frame for most of the video. Record a new video.",
    videoOwnerTooBrief:
      "Your face appears too briefly or only in one moment. Choose a clip where you appear clearly in several separate moments.",
    videoIdentityMismatch:
      "The video must belong to the same person as the photos in your profile.",
    videoMostlyOtherPerson:
      "That video mainly presents someone else. Choose a clip where you appear clearly in several moments.",
    videoNeedsPhotoFirst:
      "Send at least one clear profile photo first, then I can verify that you appear in the video.",
    videoProcessingUnavailable:
      "I couldn't check that video right now. Your existing video was not changed. Please try again shortly.",
    ticketRewardPhoto:
      "🎟️ Nice — you just earned a *free Date Ticket*!\n\nHere's the deal: every date you go on costs 1 ticket, and tickets normally cost money. Adding photos got you one on the house. Balance: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ A profile video — love it! That's another *free Date Ticket*.\n\nEach date costs 1 ticket (normally paid), so you're set for your next one. Balance: *{balance}* 🎟️",
    ticketRewardVerification:
      "🎟️ Verification complete — your *free Date Ticket* is already in your wallet.\n\nIt covers one date. Balance: *{balance}* 🎟️",
    ticketRewardStudent:
      "🎓 University email verified — student perk unlocked: *2 free Date Tickets* are in your wallet.\n\nEach date costs 1 ticket, so your first two dates are covered. Balance: *{balance}* 🎟️",
    welcomeGiftTicket:
      "🎟 Your first ticket — on me, personally.\n\nEvery date here costs 1 ticket, normally ~$6.99\nThis one's free — let your first step be about the person, not the price\n\nIt's already in your wallet ❤️",
    ticketStorePurchased:
      "✨ Payment received — *{count}* ticket(s) added!\n\nBalance: *{balance}* 🎟️",
    ticketStoreCheckoutError: "Couldn't confirm that payment. Please try again.",
    ticketStoreInvoiceTitle: "Gennety Date Tickets",
    ticketStoreInvoiceDesc:
      "{count} Date Ticket(s) added to your wallet. Each ticket covers one date.",
    ticketGateInvoiceDesc:
      "Securing your date — {count} Date Ticket(s). Each ticket covers one person.",
    ticketStoreInvoiceLabel: "{count} Date Ticket(s)",
    onboardingPhotosNeedMore:
      "Photo progress: {count}/{min}. Clear photos still needed: {remaining}.",
    onboardingPhotosBonusOffer:
      "Your required photos are ready ✨\n\nReach {threshold} photos ({remaining} remaining) to earn a free Date Ticket. You can also send one short profile video for another free ticket.\n\nBoth are optional — send more media now, or continue.",
    onboardingPhotosBonusOfferAfterVideo:
      "Your required photos are ready, and your video bonus is secured ✨\n\nReach {threshold} photos ({remaining} remaining) to earn a second free Date Ticket, or continue.",
    onboardingPhotosBonusProgress:
      "{count}/{threshold} photos ✨ One more unlocks a free Date Ticket. Send it now or continue.",
    onboardingPhotosBonusProgressAfterVideo:
      "{count}/{threshold} photos ✨ One more unlocks your second free Date Ticket. Send it now or continue.",
    onboardingPhotosPhotoBonusEarned:
      "{count} photos are ready, and your free photo Date Ticket is secured ✨\n\nYou may still add photos up to {max}, or send one short profile video for another free ticket. Otherwise, continue.",
    onboardingPhotosBothBonusesEarned:
      "{count} photos and your profile video are ready — both free Date Tickets are secured ✨\n\nYou may still add photos up to {max}, or continue.",
    onboardingPhotosPhotoBonusEarnedMax:
      "All {max} photos are ready, and your free photo Date Ticket is secured ✨\n\nYou may still send one short profile video for another free ticket, or continue.",
    onboardingPhotosBothBonusesEarnedMax:
      "All {max} photos and your profile video are ready — both free Date Tickets are secured ✨\n\nContinue when you're ready.",
    onboardingPhotosOptional:
      "Your required photos are ready ✨\n\nYou may add more photos up to {max}, send one short profile video, or continue.",
    onboardingPhotosOptionalAfterVideo:
      "Your required photos and profile video are ready ✨\n\nYou may add more photos up to {max}, or continue.",
    onboardingPhotosOptionalMax:
      "All {max} photos are ready ✨\n\nYou may send one short profile video, or continue.",
    onboardingPhotosOptionalMaxAfterVideo:
      "All {max} photos and your profile video are ready ✨\n\nContinue when you're ready.",
    menuMyTickets: "🎟️ My Tickets",
    ticketWalletText:
      "🎟️ *My Tickets*\n\nYou have *{balance}* ticket(s). Each date costs 1 ticket — buy more anytime.",
    ticketWalletOpenStore: "🎟️ Buy tickets",
    photosEnough: "You can send more (up to {max}) or hit the button to continue.",
    photosDone: "Photos uploaded ✨",
    profileReview:
      "Here's your profile:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Look good?",
    profileConfirm: "Looks good ✨",
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
    verifyPitchTicket:
      "Final step: confirm that this profile is really yours.\n\n" +
      "We'll compare a verification selfie with your profile photos. Complete the check and get *1 free Date Ticket* for one date.\n\n" +
      "If you skip, you give up the free ticket, lose {penalty} starting ELO points, and reduce your chances of receiving a strong match.",
    verifyPitchMandatory:
      "Final step. We confirm every member is a real person.\n\n" +
      "We'll compare the selfie captured during verification with every photo in your profile — " +
      "photos that don't match you will be rejected.\n\n" +
      "Verification is required: matching starts right after you pass it.",
    verifyPitchMandatoryTicket:
      "Final step: confirm this profile is really yours.\n\n" +
      "We'll compare a verification selfie with your profile photos, and you'll get *1 free Date Ticket* for passing.\n\n" +
      "Verification is required: matching starts right after you pass it.",
    verifyMandatoryNotice:
      "Verification is now required for all new profiles — matching starts right after you pass it. It takes about a minute:",
    verifyReminderNudge:
      "Your profile is ready — verification is the only step left. It takes about a minute, and matching starts right after:",
    verifyBtnGo: "🟢 Verify now",
    verifyBtnCheck: "✨ I've finished verification",
    verifyBtnSkip: "⚪️ Skip for now",
    verifySkipNudgeCaption:
      "One sec — listen to this before you skip 👆",
    verifySkipNudgeCaptionTicket:
      "Before you give this up: skipping costs your free ticket, {penalty} ELO points, and some of your match priority. Listen first 👆",
    verifyBtnReconsider: "🟢 OK, I'll verify",
    verifyBtnSkipConfirm: "🔴 Skip anyway",
    verifyBtnSkipConfirmTicket: "🔴 Give up the bonus and skip",
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
      "Verified ✨ Profile is live. I'll message you when I find a match.",
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
      "{occupationLine}" +
      "{universityLine}" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_No bio yet._",
    myProfilePreviewHeader: "This is how your match sees you 👇",
    myProfileEditLabel: "✏️ What to change:",

    // --- Edit Profile ---
    editProfileBody:
      "These are locked in:\n\n" +
      "• *Name:* {firstName} {surname}\n" +
      "• *Age:* {age}\n" +
      "• *University:* {university}\n\n" +
      "You can edit:",
    editBioBtn: "📝 About me",
    editPrefsBtn: "💘 Who I want",
    editMajorBtn: "💼 What I do",
    editProfilePhotosBtn: "📸 My photos",
    editBioPrompt:
      "Write a few lines about yourself (max 500 chars).\n👀 Your match reads this before the date.",
    editBioTooLong: "Too long — keep it under 500.",
    editBioSaved: "About me updated ✨",
    editMajorPrompt:
      "What do you do? (job / studies / field, max 100 chars)\n👀 Shown to your match.",
    editMajorTooLong: "Too long — keep it under 100.",
    editMajorSaved: "Saved ✨",
    editPrefsTitle: "💘 *Who I want*\n\n👀 Affects who you get matched with. What to change?",
    editPrefsAgeBtn: "🎂 Partner age range",
    editPrefsBack: "⬅️ Back to Edit",
    editAgeRangePrompt: "What partner age range are you looking for? (e.g. 20-28)\nMin: {min}, Max: {max}.",
    editAgeRangeInvalid: "Didn't get that. Two numbers like 20-28 (range {min}–{max}).",
    editAgeRangeSaved: "Age range updated ✨",
    editProfilePhotosStart: "Send new photos ({min}–{max}). One at a time.",
    editProfilePhotosSaved: "Photos updated ✨",
    photoManagerTitle:
      "Your photos. Delete the ones you don't want or add new ones (min {min}, max {max}).",
    photoManagerDeleteBtn: "🗑 {n}",
    photoManagerAddBtn: "➕ Add photo",
    photoManagerDoneBtn: "✅ Done",
    photoManagerMinReached: "You need at least {min} photos. Add a new one first.",
    photoManagerDeleted: "Photo deleted.",
    menuVideo: "🎬 Profile Video",
    editVideoPrompt:
      "🎬 Send a short profile video (up to {sec}s, max {mb} MB). Friends, scenery, or a party clip are all fine — it just makes your profile feel alive.",
    editVideoRewardLine: "🎁 Add one now and earn a free Date Ticket.",
    editVideoHasOne:
      "You already have a profile video. Send a new one to replace it, or remove it below.",
    editVideoRemoveBtn: "🗑 Remove video",
    editVideoRemoved: "Profile video removed.",
    editVideoNotAVideo: "Please send a *video* (up to {sec}s, max {mb} MB).",
    myProfileAddVideoHint:
      "🎬 Tip: add a short profile video from the menu — it makes your profile stand out.",
    myProfileAddVideoHintReward:
      "🎬 Tip: add a short profile video from the menu and earn a free Date Ticket 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Matching paused ⏸\nNo new matches until you resume.",
    resumeConfirmed: "Matching back on ▶️\nOur AI is on it.",

    // --- Settings ---
    settingsTitle: "⚙️ Settings",
    settingsLanguage: "🌐 Language",
    settingsLanguagePick: "Pick a language:",
    settingsLanguageSaved: "Language updated ✨",
    settingsTheme: "🎨 Theme",
    settingsThemePick: "Choose your look:",
    settingsThemeSaved: "Theme updated ✨",
    themeDarkOption: "🌙 Dark",
    themeLightOption: "☀️ Light",
    settingsVerify: "🛡 Verify your account",
    settingsVerifyNotNeeded: "You're already verified ✨",
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
    deleteFreezeIntro:
      "Wait — before you delete everything 👀\n\n" +
      "You don't have to lose it all. *Freeze* your account instead: your profile, " +
      "photos and verification stay safe, you disappear from matching, and next time " +
      "you just send /start to land right back in your ready profile — no re-onboarding.\n\n" +
      "Still want to delete? That one's permanent.",
    deleteFreezeBtn: "❄️ Freeze my account",
    deleteProceedBtn: "Delete my account anyway",
    freezeConfirmed:
      "Done — your account is *frozen* ❄️\n\n" +
      "You're hidden from matching and won't get pinged. " +
      "Come back anytime with /start and everything's still here.",
    freezeWelcomeBack:
      "Welcome back! ❄️ → ☀️ Your account is *unfrozen* and live again. " +
      "Here's your profile:",
    deleteFinalYes: "Yes, I'm 100% sure",
    deleteFinalNoSoft: "No",
    deleteFinalNoHard: "Oh god, no",
    freezePartnerNotice:
      "Heads up — your match is no longer available, so this one won't go ahead. " +
      "No worries: you'll get priority in the next batch 💛",

    // --- Matching ---
    matchHeadline: "💘 Found you a match!",
    matchDeadlineNotice:
      "You've got 24h to reply. " +
      "Once you tap — *the decision is final*. No take-backs.",
    matchStreamStart: "✨ Why you two click…",
    matchBtnAccept: "✨ Accept",
    matchBtnDecline: "❌ Pass",
    matchDeclineConfirmPrompt:
      "Pass on this match?\n\n" +
      "This is final — you won't be matched with this person again. " +
      "Tap to confirm, or go back.",
    matchBtnConfirmDecline: "❌ Yes, pass",
    matchBtnKeepDeciding: "← Go back",
    matchDecisionQuestionM:
      "So — want to go on a date with him? 😊 Just answer me right here, in your own words.",
    matchDecisionQuestionF:
      "So — want to go on a date with her? 😊 Just answer me right here, in your own words.",
    matchTextYesConfirm: "Love that ✨ Confirm below — and I'll take care of the rest:",
    matchBtnConfirmGo: "💫 Yes, I'm going",
    matchTextUnsure:
      "No rush — when you know, just tell me “yes” or “no”.",
    matchDeclineDismissed:
      "No rush — this match is still waiting for your answer. 💛",
    matchAcceptedToast: "Accepted ✨",
    matchDecisionSavedToast: "Saved ✨",
    matchAccepted: "Accepted ✨ Waiting on them.",
    matchBothAccepted: "It's mutual 🤍 Let's find a time.",
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
      "Where things stand:\n" +
      "• We're growing the community fast and refining the matchmaking algorithm every day.\n" +
      "• A truly fitting partner should arrive in one of the next drops.\n" +
      "• Every week you wait bumps up your priority in the next drop.\n\n" +
      "See you next Thursday at 18:00 ✨",
    noMatchThisWeekTier2:
      "Hey 🌿\n\n" +
      "Second week running and our matchmaker still hasn't found anyone we'd be excited to introduce you to. " +
      "Thank you for your patience — it means a lot.\n\n" +
      "Where we are right now:\n" +
      "• We're actively bringing more people like you into the community and tuning the algorithm in your favour.\n" +
      "• A genuinely great partner should be just a few drops away.\n" +
      "• Your priority for the next drop is already raised for the wait.\n\n" +
      "See you next Thursday at 18:00 — we're working for you 🤍",
    noMatchThisWeekTier3:
      "Hey ✨\n\n" +
      "We owe you another honest update — still no partner that's truly worth your time. " +
      "We hate this even more than you do, and we're not going to pretend otherwise.\n\n" +
      "What's actually happening on our side:\n" +
      "• We're personally watching your queue and pushing the community to grow in your area.\n" +
      "• The right person will land in one of the coming drops — we won't stop until they do.\n" +
      "• Every week you wait, we move you higher up the priority list for the next drop.\n\n" +
      "Thank you for trusting us. See you Thursday at 18:00 🤍",
    noMatchDiscountOffer:
      "🎟️ A small thank-you for your patience: your next first date is {pct}% off — one Date Ticket, almost on us. " +
      "We'll apply the discount automatically the next time you get a match or open your tickets.",
    matchScheduleProposal:
      "How about one of these? Tap what works:",
    matchScheduleIter3:
      "It's mutual 🤍 Open the calendar and mark every time that works.",
    matchScheduleAfterTicket:
      "📅 Now pick your time — open the calendar and mark every slot that works.",
    matchScheduleBtnCalendar: "📅 Open Calendar",
    // --- Date Ticket (premium post-accept gate) ---
    ticketCardCaption:
      "It's mutual 🤍 Get your *Date Ticket* to unlock planning.",
    ticketButton: "🎟️ Get your date ticket",
    ticketViewButton: "🎟️ View your date ticket",
    ticketStatusButton: "Open date",
    ticketGateWaiting: "Ticket ready ✨ Waiting on them.",
    ticketBothSecuredDm: "Both tickets secured 🎟️✨ Your date is on — let's pick a time.",
    ticketPartnerPaidDm: "{name} already covered your date ticket ❤️ You're all set — nothing to pay.",
    // Goodwill "he covered her ticket" read-receipt (§3.5b): confirm his gesture
    // landed (takt 1), then let him know once she's actually seen it (takt 2).
    ticketCoveredHerConfirm:
      "💛 Done — you covered {name}'s ticket. The moment she sees it, I'll let you know.",
    ticketPartnerSawItDm: "❤️ {name} saw that you covered her ticket.",
    ticketRefundedDm:
      "Your match didn't grab their ticket in time, so we've refunded yours. No worries — we've opened scheduling for free. Let's find a time 📅",
    matchScheduleNoOverlap:
      "No overlap yet — next round.",
    matchScheduled: "Locked in — see you there 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 It might be packed at peak time — no stress: grab a coffee to go and take a walk, or duck into another nice spot nearby.",
    matchScheduledBtnOpenMaps: "📍 Open in Maps",
    matchScheduledBtnShare: "📤 Share this card",
    dateCardWhen: "WHEN",
    dateCardSlogan: "Error 404:\nChat not found.\nTry real life.",
    dateCardShareCaption:
      "Share away — your match's face is hidden to protect their privacy 💞",
    dateCardShareFailed:
      "Couldn't prepare a shareable card right now — try again in a moment.",
    matchSchedulePickedPrefix: "You picked: ",
    matchScheduleWaitingPeer: "Waiting on the other person…",
    matchSchedulePeerProposed:
      "Your match marked dates and times in the calendar. Open it to confirm one or suggest your own:",
    matchSchedulePeerSuggestedAlternative:
      "Your match suggested a different time. Check their answer: you can agree with it or suggest your own.",
    matchScheduleSavedConfirmation:
      "✨ Saved your dates and times. We pinged your match — I'll let you know the moment they reply.",
    matchScheduleNoOverlapYet:
      "You both marked dates and times, but none overlap. Open the calendar and add a few more — we'll lock it in as soon as one slot matches:",
    venueConciergeIntro:
      "Time's locked 🗓️ One thing before I find your spot.\n\n" +
      "📍 *Mark where you'll be setting off from* for the date — your place, a metro station, a friend's flat, wherever you'll actually be leaving from.\n\n" +
      "I'll use that point to find a comfortable meeting spot that's easy for *both* of you to reach, close to where you start out. Tap below to drop it on the map:",
    venueConciergeBtnLocation: "📍 Send my location",
    venueConciergeBtnMap: "🗺️ Pick on map",
    venueLocationFirst:
      "First things first — *mark where you'll be setting off from* 📍 Tap below to drop it on the map. I'll ask about the vibe right after.",
    venueVibeNoted: "Vibe noted ✨ Now pick where you'll be coming from:",
    venueLocationNoted:
      "Starting point saved ✨ Now — what *vibe* are you after? e.g. _quiet cafe_, _vegan brunch_, _park walk_, _small museum_.",
    venueSafetyOverride:
      "Heads up — picked a public café instead. We keep first dates in public spots.",
    venueWaitingPeer: "Got yours ✨ Waiting for them…",
    venueSearching: "🔍 Finding your spot…",
    venueSearchStep2: "📍 Comparing your routes…",
    venueSearchStep3: "✨ Matching your vibe…",
    dateCardStep1: "📋 Confirming your date details…",
    dateCardStep2: "🎨 Putting your date card together…",
    dateCardStep3: "✨ Adding the final touches…",
    dateCardShareStep1: "✨ Preparing your shareable card…",
    dateCardShareStep2: "💫 Blurring your match's face…",
    dateCardShareStep3: "⭐ Polishing the photo…",
    dateCardShareStep4: "🌠 Almost ready…",
    onbAnalyzeStep1: "🧠 Reading your context…",
    onbAnalyzeStep1b: "💭 Thinking…",
    onbAnalyzeStep2: "🧩 Extracting key traits…",
    onbAnalyzeStep3: "🧮 Building your profile…",
    verifyAnalyzeStep1: "🔍 Matching your selfie…",
    verifyAnalyzeStep2: "🧬 Reading facial features…",
    verifyAnalyzeStep3: "⏳ Finalizing the check…",
    videoCheckStep1: "🎬 Looking through your video…",
    videoCheckStep2: "🙂 Checking it's you…",
    videoCheckStep3: "✨ Almost ready…",
    skipAnalyzeStep1: "✨ Polishing your profile…",
    skipAnalyzeStep2: "🧮 Tying it all together…",
    skipAnalyzeStep3: "💞 Prepping you for matching…",
    profilerBatchThinking: "💭 Thinking…",
    profilerBatchSaving: "🧩 Saving your answers…",
    profilerBatchSaved:
      "Preference card updated ✨ I'll use it for the next match.",
    profilerNextAck: "✍️ Got it…",
    profilerNextFormulating: "💭 Thinking…",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "📍 Change venue",
    venueBoardPingFromF: "{name} is eyeing a cozier spot for your date 👀",
    venueBoardPingFromM: "{name} suggests a look at a couple of other spots for your date 👀",
    venueBoardPingBtn: "Take a look",
    venueKeepNotice: "Your match would like to keep {venue} 👍 You can still suggest another spot below.",
    venueBothKeepDm: "You're both keeping {venue} — nothing changes, see you there 👍",
    venueDeclinedKeepDm: "You're keeping {venue}, as originally planned 👍",
    venuePayPromptDm:
      "You two picked a new place for your date together!\n📍 {venue}\n" +
      "Lock it in — and we'll update your date cards.",
    venuePayBtn: "⭐ Lock it in — {stars}",
    venueWishText:
      "{name} found a place she loves for your date ✨\n📍 {venue}\n" +
      "She'd be happy if you locked it in.",
    venueWishPayBtn: "💫 Lock it in — {stars} ⭐",
    venueWishDeclineBtn: "Not this time",
    venuePayDeclineAck:
      "Got it — the venue stays as planned for now. If it changes, you'll get an updated card.",
    venuePaySelfDm:
      "You two agreed on a new place!\n📍 {venue}\nLock it in — and we'll update your date cards ✨",
    venuePaySelfBtn: "⭐ Lock it in — {stars}",
    venueSettledCard: "Done — your date has a new home! 📍 {venue}",
    venueSettledPaidByM: "{name} covered the venue change ❤️ Your date now happens at 📍 {venue}",
    venueSettledPaidByF: "{name} covered the venue change ❤️ Your date now happens at 📍 {venue}",
    venueExpressPartnerFromF: "{name} picked a cozier spot for your date ✨ New place: 📍 {venue}",
    venueExpressPartnerFromM: "{name} picked a new spot for your date ✨ New place: 📍 {venue}",
    venueLapsedDm: "The venue change wasn't locked in — you're meeting at {venue}, as planned 👌",
    venueKeepOriginalDm: "Your match decided to keep the original spot — you're meeting at {venue}, as planned 👌",
    venueInvoiceTitle: "Venue change",
    venueInvoiceDesc: "New date venue: {venue}",
    venueInvoiceLabel: "Venue change",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Your date is in 5 hours! Some convo starters for you:\n\n",
    // "Thinking" lead beat for the live ice-breaker / no-match streams.
    // Product delivery uses bottom-of-chat message edits; rich drafts are
    // explicit dev-only demos.
    icebreakerStreamStart: "✨ Lining up a few things you two could talk about…",
    noMatchStreamStart: "💫 Going over this week's matches for you…",
    profilerSkip: "Skip",
    wingmanHintIntro:
      "👋 Insider tip — your date's in 90 minutes:\n\n",
    emergencyUnlocked:
      "Emergency cancel window is open.\n" +
      "If you really can't make it, tap below.\n" +
      "*You'll need to write a reason — it gets forwarded to your match exactly as you write it.*",
    emergencyBtn: "🚨 Cancel Date",
    emergencyConfirmPrompt:
      "Before you cancel, quick check.\n\n" +
      "If this is nerves, being a little late, or uncertainty, keep the date. " +
      "Your match has cleared time for you, and showing up still gives the evening a chance.\n\n" +
      "*Cancel only if you truly can't make it; the match can't be restored.* " +
      "If you continue, I'll ask for a reason and send it to your match word for word.",
    emergencyBtnConfirm: "🔴 Yes, cancel the date",
    emergencyBtnBack: "🟢 Keep the date",
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
      "👥 **If it's crowded.** It happens — no worries: grab a coffee and walk a bit, or move to a café nearby where it's busy and well-lit.\n" +
      "🚗 **Transport.** Get there and back on your own — public transport, taxi, or walking works. Just don't get in a car with someone you barely know.\n" +
      "📱 **Tell someone close.** Forward the meeting details to a friend or family, and if possible share your live location for the evening.\n" +
      "☕ **Stay aware.** Try not to leave your belongings or drink unattended.\n" +
      "🛑 **Your boundaries.** If you feel uncomfortable or your date's behavior seems off — you have every right to just get up and leave at any moment. Your safety always beats politeness.\n\n" +
      "Have a great evening ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Next match in {d}d {h}h",
    statusHoursMinutes: "⏳ Matches drop in {h}h {m}m",
    statusMinutes: "✨ Almost ready! Matches drop in {m}m",
    statusProcessing: "✨ Analyzing your city… Check back shortly.",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Date in {d}d {h}h",
    statusDateHoursMinutes: "💫 Date in {h}h {m}m",
    statusDateMinutes: "💫 Date in {m}m",
    statusDateSoon: "💫 Date is today ✨",
    menuMyDateDays: "💫 My date · in {d}d {h}h",
    menuMyDateHours: "💫 My date · in {h}h {m}m",
    menuMyDateMinutes: "💫 My date · in {m}m",
    menuMyDateSoon: "💫 My date · today ✨",
    menuMyDatePlanning: "⏳ Date being planned",
    dateHubNoActive: "You don't have an active date right now.",
    dateHubHeaderScheduled: "💫 Your date with {name}",
    dateHubPlanningProposed:
      "You have a match with {name}. Check the pitch above — then just tell me if you'd like to go.",
    dateHubPlanningNegotiating: "You matched with {name}! Pick a time that suits you:",
    dateHubPlanningVenue:
      "Almost set with {name}. Mark where you'll be heading out from:",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Sorry, I couldn't hear that clearly — could you type it instead?",
    voiceTooLong:
      "That voice note's a bit long for me. Keep it under 5 minutes, or just type it out.",
    rateLimitFloodNotice:
      "Whoa, that's a lot of messages at once — give me a few seconds to catch up, then go again. 🙂",
    rateLimitDailyBudgetNotice:
      "You've been super active today 🙂 Let's pick this up again tomorrow — we've reached today's limit so I can keep things running smoothly for everyone.",

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
    coordRequestAck: "On it — I've asked them. I'll ping you the moment they say yes ✨",
    coordPartnerAskApprove:
      "Your date in ~1h would love a way to find you at the spot 💬\n\n" +
      "Share your Telegram with {name}?",
    coordPartnerBtnApprove: "✨ Share my Telegram",
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
    coordProxyRelayNamedPrefix: "💬 {name}: ",
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
      "Перед началом ознакомьтесь с нашими Условиями использования и Политикой конфиденциальности и примите условия хранения данных.",
    consentAgree: "Согласен",
    consentPrivacyButton: "Политика конфиденциальности",
    consentTermsButton: "Условия использования",
    welcome: "Gennety Dating 👀\nAI-мэтчмейкинг для настоящих свиданий.",
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
    emailVerified: "Почта подтверждена ✨",
    contextDumpAck: "Принял ✨ Обрабатываю…",
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
    askPhotos:
      "Почти всё! Пришли {min}–{max} разных фото. На каждом должен быть хорошо виден ты, откровенный контент запрещён. В видео могут быть друзья или пейзажи, но ты должен хорошо появляться в нескольких моментах.",
    photoReceived: "Фото {n}/{max} ✨",
    photoRejected:
      "На фото должно быть видно твоё лицо. Попробуй другой снимок.",
    photoDuplicate:
      "Это фото уже есть в профиле. Добавь другой снимок — все фотографии должны быть уникальными.",
    photoDuplicateNear:
      "Это фото уже есть в профиле. Добавь другой снимок — все фотографии должны быть уникальными.",
    photoUnsafeContent:
      "Это фото нельзя публиковать в профиле. Выбери другой снимок без откровенного контента.",
    photoFaceObscured:
      "Лицо плохо видно. Сними тёмные очки или маску и пришли более чёткий снимок.",
    photoMultipleFaces:
      "На фото должно быть видно твоё лицо. Попробуй другой снимок.",
    photoIdentityMismatch:
      "Все фото должны принадлежать одному человеку. Убедись, что твоё лицо есть на каждом снимке.",
    photoIdentityUncertain:
      "Не получилось надёжно сопоставить лицо. Пришли более чёткое фото с хорошим освещением и хорошо видимым лицом.",
    photoConsensusPending:
      "Я пока не зафиксировал личность в профиле. Пришли ещё одно другое фото, где виден тот же человек.",
    photoConsensusOutlierRejected:
      "Одно ожидающее фото было с другим человеком, поэтому я его не добавил.",
    photoConsensusConfirmed:
      "Личность подтверждена по совпадающим фото ✨",
    photoConsensusNoPairCap:
      "Я всё ещё не вижу двух фото одного человека. Пока ничего не зафиксировано — пришли ещё одно чёткое фото себя.",
    photoVisionError:
      "Не удалось обработать файл. Попробуй ещё раз.",
    photoInvalidMedia:
      "Этот файл не является поддерживаемым фото. Пришли изображение JPEG, PNG, WebP или HEIC.",
    livePhotoMissingStatic:
      "В этом Live Photo нет статичного кадра, поэтому я не смогу его проверить. Скинь обычное фото или другое Live Photo.",
    livePhotoTooLong:
      "Live Photo должно быть не длиннее 10 секунд. Скинь короче или обычное фото.",
    livePhotoTooLarge:
      "Live Photo должно быть не больше 10 МБ. Скинь файл поменьше или обычное фото.",
    videoTooLong:
      "Видео для профиля должно быть не длиннее 60 секунд. Скинь покороче.",
    videoTooLarge:
      "Видео для профиля должно быть не больше {mb} МБ. Скинь поменьше.",
    videoChecking:
      "Проверяю безопасность видео и ищу твоё лицо в нескольких моментах...",
    videoUnsafeContent:
      "В этом видео есть контент, который нельзя публиковать в профиле. Выбери другой ролик.",
    videoOwnerMissing:
      "В видео твоё лицо должно быть в кадре большую часть времени. Запиши новое видео.",
    videoOwnerTooBrief:
      "Твоё лицо появляется слишком ненадолго или только в одном моменте. Выбери ролик, где тебя хорошо видно в нескольких отдельных сценах.",
    videoIdentityMismatch:
      "Видео должно принадлежать тому же человеку, что и фото в профиле.",
    videoMostlyOtherPerson:
      "В этом видео главным образом показан другой человек. Выбери ролик, где тебя хорошо видно в нескольких моментах.",
    videoNeedsPhotoFirst:
      "Сначала пришли хотя бы одно чёткое фото для профиля. После этого я смогу проверить, что в видео именно ты.",
    videoProcessingUnavailable:
      "Сейчас не получилось проверить видео. Предыдущее видео не изменено. Попробуй ещё раз немного позже.",
    ticketRewardPhoto:
      "🎟️ Класс — ты только что получил *бесплатный билет на свидание*!\n\nКак это работает: каждое свидание стоит 1 билет, и обычно билеты платные. За добавленные фото — один в подарок. Баланс: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ Видео в профиле — супер! Вот ещё *бесплатный билет на свидание*.\n\nКаждое свидание стоит 1 билет (обычно платный), так что на следующее ты готов. Баланс: *{balance}* 🎟️",
    ticketRewardVerification:
      "🎟️ Верификация пройдена — *бесплатный билет на свидание* уже на балансе.\n\nОн покрывает одну встречу. Баланс: *{balance}* 🎟️",
    ticketRewardStudent:
      "🎓 Университетская почта подтверждена — студенческий бонус: *2 бесплатных билета на свидания* уже на балансе.\n\nКаждое свидание стоит 1 билет, так что первые две встречи за наш счёт. Баланс: *{balance}* 🎟️",
    welcomeGiftTicket:
      "🎟 Твой первый билет — от меня лично.\n\nКаждое свидание здесь стоит 1 билет, обычно ~$6.99\nЭтот — бесплатно: пусть первый шаг будет про человека, а не про цену\n\nБилет уже в твоём кошельке ❤️",
    ticketStorePurchased:
      "✨ Оплата прошла — добавлено *{count}* 🎟️!\n\nБаланс: *{balance}* 🎟️",
    ticketStoreCheckoutError: "Не удалось подтвердить оплату. Попробуй ещё раз.",
    ticketStoreInvoiceTitle: "Билеты Gennety",
    ticketStoreInvoiceDesc:
      "Пополнение кошелька: {count} 🎟️. Каждый билет покрывает одно свидание.",
    ticketGateInvoiceDesc:
      "Оплата вашего свидания — {count} билет(а/ов). Один билет — на одного человека.",
    ticketStoreInvoiceLabel: "Билеты Gennety × {count}",
    onboardingPhotosNeedMore:
      "Фото: {count}/{min}. Осталось загрузить ещё {remaining} чёткое фото до обязательного минимума.",
    onboardingPhotosBonusOffer:
      "Обязательные фото готовы ✨\n\nДоведи количество фото до {threshold} (осталось: {remaining}) и получишь бесплатный билет на свидание. Ещё один бесплатный билет можно получить за короткое видео для профиля.\n\nОба бонуса необязательны — можешь прислать медиа сейчас или продолжить.",
    onboardingPhotosBonusOfferAfterVideo:
      "Обязательные фото готовы, а билет за видео уже твой ✨\n\nДоведи количество фото до {threshold} (осталось: {remaining}) и получишь второй бесплатный билет. Или продолжай.",
    onboardingPhotosBonusProgress:
      "{count}/{threshold} фото ✨ Ещё одно откроет бесплатный билет на свидание. Пришли его сейчас или продолжай.",
    onboardingPhotosBonusProgressAfterVideo:
      "{count}/{threshold} фото ✨ Ещё одно откроет второй бесплатный билет. Пришли его сейчас или продолжай.",
    onboardingPhotosPhotoBonusEarned:
      "Готово {count} фото, и бесплатный билет за фотографии уже твой ✨\n\nМожно добавить фото до {max} или короткое видео за ещё один бесплатный билет. Либо продолжай.",
    onboardingPhotosBothBonusesEarned:
      "Готово {count} фото и видео — оба бесплатных билета уже твои ✨\n\nМожно добавить фото до {max} или продолжить.",
    onboardingPhotosPhotoBonusEarnedMax:
      "Все {max} фото готовы, и бесплатный билет за фотографии уже твой ✨\n\nМожно отправить короткое видео за ещё один бесплатный билет или продолжить.",
    onboardingPhotosBothBonusesEarnedMax:
      "Все {max} фото и видео готовы — оба бесплатных билета уже твои ✨\n\nПродолжай, когда будешь готов.",
    onboardingPhotosOptional:
      "Обязательные фото готовы ✨\n\nМожешь добавить ещё фото до {max}, отправить короткое видео для профиля или продолжить.",
    onboardingPhotosOptionalAfterVideo:
      "Обязательные фото и видео готовы ✨\n\nМожешь добавить ещё фото до {max} или продолжить.",
    onboardingPhotosOptionalMax:
      "Все {max} фото готовы ✨\n\nМожешь отправить короткое видео для профиля или продолжить.",
    onboardingPhotosOptionalMaxAfterVideo:
      "Все {max} фото и видео готовы ✨\n\nПродолжай, когда будешь готов.",
    menuMyTickets: "🎟️ Мои билеты",
    ticketWalletText:
      "🎟️ *Мои билеты*\n\nУ тебя *{balance}* билет(ов). Каждое свидание стоит 1 билет — докупить можно в любой момент.",
    ticketWalletOpenStore: "🎟️ Купить билеты",
    photosEnough: "Можешь скинуть ещё (до {max}) или жми кнопку.",
    photosDone: "Фото загружены ✨",
    profileReview:
      "Вот твой профиль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Всё ок?",
    profileConfirm: "Всё ок ✨",
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
    verifyPitchTicket:
      "Финальный шаг — подтвердить, что профиль действительно твой.\n\n" +
      "Мы сравним селфи с фотографиями профиля. Пройди проверку и получи *1 бесплатный билет на свидание*.\n\n" +
      "Если пропустить, ты откажешься от билета, потеряешь {penalty} стартовых ELO-пунктов и снизишь свои шансы на подходящую встречу.",
    verifyPitchMandatory:
      "Финальный шаг. Мы подтверждаем, что каждый участник — реальный человек.\n\n" +
      "Селфи, сделанное во время верификации, мы сравним с каждой фотографией в твоём профиле — " +
      "фото, на которых не ты, будут отклонены.\n\n" +
      "Верификация обязательна: подбор пар начнётся сразу после её прохождения.",
    verifyPitchMandatoryTicket:
      "Финальный шаг — подтвердить, что профиль действительно твой.\n\n" +
      "Мы сравним верификационное селфи с фотографиями профиля, а за прохождение ты получишь *1 бесплатный билет на свидание*.\n\n" +
      "Верификация обязательна: подбор пар начнётся сразу после её прохождения.",
    verifyMandatoryNotice:
      "Верификация теперь обязательна для всех новых профилей — подбор пар начнётся сразу после её прохождения. Это займёт около минуты:",
    verifyReminderNudge:
      "Твой профиль готов — остался только шаг верификации. Это займёт около минуты, и подбор пар начнётся сразу после:",
    verifyBtnGo: "🟢 Пройти верификацию",
    verifyBtnCheck: "✨ Я прошёл проверку",
    verifyBtnSkip: "⚪️ Пропустить пока",
    verifySkipNudgeCaption:
      "Секунду — послушай это, прежде чем пропустить 👆",
    verifySkipNudgeCaptionTicket:
      "Прежде чем отказаться: пропуск лишит тебя бесплатного билета, {penalty} ELO-пунктов и части приоритета в подборе. Сначала послушай 👆",
    verifyBtnReconsider: "🟢 Всё-таки пройти верификацию",
    verifyBtnSkipConfirm: "🔴 Всё равно пропустить",
    verifyBtnSkipConfirmTicket: "🔴 Отказаться от бонуса и пропустить",
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
      "Проверка пройдена ✨ Профиль активен. Напишу, когда найду метч.",
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
      "{occupationLine}" +
      "{universityLine}" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Описания пока нет._",
    myProfilePreviewHeader: "Так тебя видит пара 👇",
    myProfileEditLabel: "✏️ Что поменять:",

    // --- Edit Profile ---
    editProfileBody:
      "Это зафиксировано:\n\n" +
      "• *Имя:* {firstName} {surname}\n" +
      "• *Возраст:* {age}\n" +
      "• *Универ:* {university}\n\n" +
      "Можно поменять:",
    editBioBtn: "📝 О себе",
    editPrefsBtn: "💘 Кого ищу",
    editMajorBtn: "💼 Чем занимаешься",
    editProfilePhotosBtn: "📸 Мои фото",
    editBioPrompt:
      "Напиши пару строк о себе (до 500 символов).\n👀 Это читает твоя пара перед свиданием.",
    editBioTooLong: "Слишком длинно — уложись в 500.",
    editBioSaved: "«О себе» обновлено ✨",
    editMajorPrompt:
      "Чем занимаешься? (работа / учёба / сфера, до 100 символов)\n👀 Видно твоей паре.",
    editMajorTooLong: "Слишком длинно — уложись в 100.",
    editMajorSaved: "Сохранено ✨",
    editPrefsTitle: "💘 *Кого ищу*\n\n👀 Влияет на то, кто тебе попадётся. Что меняем?",
    editPrefsAgeBtn: "🎂 Возраст партнёра",
    editPrefsBack: "⬅️ К редактированию",
    editAgeRangePrompt: "В каком возрастном диапазоне искать тебе пару? (напр. 20-28)\nМин: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не понял. Два числа через дефис, напр. 20-28 (от {min} до {max}).",
    editAgeRangeSaved: "Диапазон обновлён ✨",
    editProfilePhotosStart: "Скинь новые фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото обновлены ✨",
    photoManagerTitle:
      "Твои фото. Удали лишние или добавь новые (мин {min}, макс {max}).",
    photoManagerDeleteBtn: "🗑 {n}",
    photoManagerAddBtn: "➕ Добавить",
    photoManagerDoneBtn: "✅ Готово",
    photoManagerMinReached: "Нужно минимум {min} фото. Сначала добавь новое.",
    photoManagerDeleted: "Фото удалено.",
    menuVideo: "🎬 Видео профиля",
    editVideoPrompt:
      "🎬 Пришли короткое видео для профиля (до {sec} сек, не больше {mb} МБ). Друзья, пейзаж или клип с вечеринки — всё подойдёт, видео оживляет анкету.",
    editVideoRewardLine: "🎁 Добавь видео сейчас и получи бесплатный билет на свидание.",
    editVideoHasOne:
      "У тебя уже есть видео в профиле. Пришли новое, чтобы заменить, или удали его кнопкой ниже.",
    editVideoRemoveBtn: "🗑 Удалить видео",
    editVideoRemoved: "Видео из профиля удалено.",
    editVideoNotAVideo: "Пришли, пожалуйста, *видео* (до {sec} сек, не больше {mb} МБ).",
    myProfileAddVideoHint:
      "🎬 Совет: добавь короткое видео в профиль через меню — так анкета заметнее.",
    myProfileAddVideoHintReward:
      "🎬 Совет: добавь короткое видео в профиль через меню и получи бесплатный билет 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Поиск на паузе ⏸\nНовых мэтчей не будет, пока не включишь.",
    resumeConfirmed: "Поиск запущен ▶️\nИИ уже работает.",

    // --- Settings ---
    settingsTitle: "⚙️ Настройки",
    settingsLanguage: "🌐 Язык",
    settingsLanguagePick: "Выбери язык:",
    settingsLanguageSaved: "Язык обновлён ✨",
    settingsTheme: "🎨 Тема",
    settingsThemePick: "Выбери оформление:",
    settingsThemeSaved: "Тема обновлена ✨",
    themeDarkOption: "🌙 Тёмная",
    themeLightOption: "☀️ Светлая",
    settingsVerify: "🛡 Пройти верификацию",
    settingsVerifyNotNeeded: "Ты уже верифицирован ✨",
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
    deleteFreezeIntro:
      "Подожди — прежде чем всё удалять 👀\n\n" +
      "Необязательно терять всё. Лучше *заморозь* аккаунт: профиль, фото и верификация " +
      "останутся, ты пропадёшь из подбора, а в следующий раз просто отправишь /start — и " +
      "сразу попадёшь в свой готовый профиль, без повторного онбординга.\n\n" +
      "Всё-таки удалить? Это уже навсегда.",
    deleteFreezeBtn: "❄️ Заморозить аккаунт",
    deleteProceedBtn: "Всё равно удалить аккаунт",
    freezeConfirmed:
      "Готово — аккаунт *заморожен* ❄️\n\n" +
      "Тебя не видно в подборе и я не буду писать. " +
      "Возвращайся когда угодно через /start — всё на месте.",
    freezeWelcomeBack:
      "С возвращением! ❄️ → ☀️ Аккаунт *разморожен* и снова в строю. " +
      "Вот твой профиль:",
    deleteFinalYes: "Да, я уверен на 100%",
    deleteFinalNoSoft: "Нет",
    deleteFinalNoHard: "О боже, нет",
    freezePartnerNotice:
      "Важное: твой мэтч больше недоступен, так что это свидание не состоится. " +
      "Не переживай — в следующем подборе у тебя будет приоритет 💛",

    // --- Matching ---
    matchHeadline: "💘 Нашли тебе мэтч!",
    matchDeadlineNotice:
      "У тебя 24 часа на ответ. " +
      "Как только нажмёшь — *решение окончательное*. Изменить нельзя.",
    matchStreamStart: "✨ Почему вы подходите…",
    matchBtnAccept: "✨ Принять",
    matchBtnDecline: "❌ Пас",
    matchDeclineConfirmPrompt:
      "Точно пасуешь?\n\n" +
      "Это решение окончательное — этого человека ты больше не увидишь. " +
      "Нажми, чтобы подтвердить, или вернись назад.",
    matchBtnConfirmDecline: "❌ Да, пас",
    matchBtnKeepDeciding: "← Назад",
    matchDecisionQuestionM:
      "Ну что — хочешь пойти с ним на свидание? 😊 Просто ответь мне словами прямо здесь.",
    matchDecisionQuestionF:
      "Ну что — хочешь пойти с ней на свидание? 😊 Просто ответь мне словами прямо здесь.",
    matchTextYesConfirm: "Отлично ✨ Подтверди — и дальше всё сделаю я:",
    matchBtnConfirmGo: "💫 Да, иду на свидание",
    matchTextUnsure:
      "Не спеши — когда решишь, просто напиши мне «да» или «нет».",
    matchDeclineDismissed:
      "Без спешки — этот мэтч всё ещё ждёт твоего ответа. 💛",
    matchAcceptedToast: "Принято ✨",
    matchDecisionSavedToast: "Записал ✨",
    matchAccepted: "Принято ✨ Ждём вторую сторону.",
    matchBothAccepted: "Взаимно 🤍 Найдём время.",
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
      "и мы не готовы предлагать «лишь бы было».\n\n" +
      "Что сейчас происходит:\n" +
      "• Мы активно расширяем сообщество и каждый день улучшаем алгоритм подбора.\n" +
      "• По-настоящему подходящий человек должен появиться в одном из ближайших дропов.\n" +
      "• Каждая неделя ожидания повышает твой приоритет в следующем дропе.\n\n" +
      "До следующего четверга в 18:00 ✨",
    noMatchThisWeekTier2:
      "Привет 🌿\n\n" +
      "Уже вторая неделя подряд, как наш матчмейкер не находит кого-то, кого мы были бы рады тебе показать. " +
      "Спасибо, что остаёшься с нами — это правда важно.\n\n" +
      "Где мы сейчас:\n" +
      "• Мы активно приводим новых людей и настраиваем алгоритм под твои критерии.\n" +
      "• Действительно стоящий партнёр должен быть всего в нескольких дропах от тебя.\n" +
      "• За ожидание твой приоритет в следующем дропе уже повышен.\n\n" +
      "До следующего четверга в 18:00 — мы работаем для тебя 🤍",
    noMatchThisWeekTier3:
      "Привет ✨\n\n" +
      "Должны снова быть честными — пары, которая правда стоит твоего времени, всё ещё нет. " +
      "Нам это не нравится даже сильнее, чем тебе, и мы не будем делать вид, что всё хорошо.\n\n" +
      "Что мы реально делаем:\n" +
      "• Лично следим за твоей очередью и подталкиваем рост сообщества в твоём районе.\n" +
      "• Тот самый человек обязательно появится в одном из ближайших дропов — мы не остановимся.\n" +
      "• Каждую неделю ожидания мы поднимаем тебя выше в приоритете следующего дропа.\n\n" +
      "Спасибо, что доверяешь. До четверга в 18:00 🤍",
    noMatchDiscountOffer:
      "🎟️ Небольшая благодарность за терпение: твоё следующее первое свидание — со скидкой {pct}% на один билет. " +
      "Мы применим скидку автоматически, когда тебе выпадет пара или ты откроешь свои билеты.",
    matchSchedulePeerProposed:
      "Твой собеседник уже отметил даты и время в календаре. Открой его, чтобы согласиться или предложить своё:",
    matchSchedulePeerSuggestedAlternative:
      "Твой собеседник предложил другое время. Проверь его ответ: ты можешь согласиться с предложением или предложить свой вариант.",
    matchScheduleSavedConfirmation:
      "✨ Сохранил твои даты и время. Пингнул собеседника — напишу, как только он(а) ответит.",
    matchScheduleNoOverlapYet:
      "Вы оба отметили даты и время, но варианты не пересеклись. Открой календарь и допиши несколько слотов — как только один совпадёт, я зафиксирую дату:",
    matchScheduleProposal: "Как тебе эти варианты? Жми подходящий:",
    matchScheduleIter3:
      "Взаимно 🤍 Открой календарь и отметь удобное время.",
    matchScheduleAfterTicket:
      "📅 Теперь выбери время — открой календарь и отметь все удобные слоты.",
    matchScheduleBtnCalendar: "📅 Открыть календарь",
    // --- Date Ticket (премиум-шаг после взаимного метча) ---
    ticketCardCaption:
      "Взаимно 🤍 Получи *билет на свидание*, чтобы открыть планирование.",
    ticketButton: "🎟️ Получить билет на свидание",
    ticketViewButton: "🎟️ Посмотреть свой билет на свидание",
    ticketStatusButton: "Открыть свидание",
    ticketGateWaiting: "Билет готов ✨ Ждём вторую сторону.",
    ticketBothSecuredDm: "Оба билета у вас 🎟️✨ Свидание в силе — давай выберем время.",
    ticketPartnerPaidDm: "{name} уже оплатил твой билет на свидание ❤️ Тебе ничего не нужно делать.",
    ticketCoveredHerConfirm:
      "💛 Готово — ты оплатил билет за {name}. Как только она это увидит, я дам тебе знать.",
    ticketPartnerSawItDm: "❤️ {name} увидела, что ты оплатил её билет.",
    ticketRefundedDm:
      "Собеседник не успел взять свой билет, поэтому твой мы вернули. Ничего страшного — открыли планирование бесплатно. Давай найдём время 📅",
    matchScheduleNoOverlap: "Не совпало — попробуем ещё.",
    matchScheduled: "Готово — до встречи 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 В час пик там может не оказаться мест — это ок: можно взять кофе с собой и прогуляться или заглянуть в другое место рядом.",
    matchScheduledBtnOpenMaps: "📍 Открыть в картах",
    matchScheduledBtnShare: "📤 Поделиться карточкой",
    dateCardWhen: "КОГДА",
    dateCardSlogan: "Error 404:\nChat not found.\nTry real life.",
    dateCardShareCaption:
      "Делитесь смело — лицо вашего мэтча скрыто, чтобы сохранить его приватность 💞",
    dateCardShareFailed:
      "Не получилось подготовить карточку для отправки — попробуйте через минуту.",
    matchSchedulePickedPrefix: "Ты выбрал: ",
    matchScheduleWaitingPeer: "Ждём выбор второй стороны…",
    venueConciergeIntro:
      "Время выбрано 🗓️ Один момент перед тем, как подобрать место.\n\n" +
      "📍 *Отметь, откуда ты будешь выезжать* на свидание — дом, станция метро, квартира друга, откуда тебе реально удобно стартовать.\n\n" +
      "По этой точке я подберу удобное место встречи, до которого легко добраться вам *обоим*, недалеко от твоего старта. Нажми кнопку ниже и отметь точку на карте:",
    venueConciergeBtnLocation: "📍 Отправить геолокацию",
    venueConciergeBtnMap: "🗺️ Выбрать на карте",
    venueLocationFirst:
      "Сначала самое главное — *отметь, откуда ты будешь выезжать* 📍 Нажми кнопку ниже и поставь точку на карте. Про вайб спрошу сразу после.",
    venueVibeNoted: "Вайб записан ✨ Теперь укажи, откуда поедешь:",
    venueLocationNoted:
      "Точку выезда сохранил ✨ Теперь — какой *вайб* хочешь? Например: _тихое кафе_, _веган-завтрак_, _прогулка в парке_, _небольшой музей_.",
    venueSafetyOverride:
      "Небольшое уточнение — заменил на публичное кафе. Первые свидания у нас в людных местах.",
    venueWaitingPeer: "Принял ✨ Ждём вторую сторону…",
    venueSearching: "🔍 Ищу удобное место…",
    venueSearchStep2: "📍 Сверяю ваши маршруты…",
    venueSearchStep3: "✨ Подбираю по атмосфере…",
    dateCardStep1: "📋 Подтверждаю детали свидания…",
    dateCardStep2: "🎨 Собираю карточку свидания…",
    dateCardStep3: "✨ Навожу красоту…",
    dateCardShareStep1: "✨ Готовлю карточку для отправки…",
    dateCardShareStep2: "💫 Размываю лицо мэтча…",
    dateCardShareStep3: "⭐ Навожу красоту на фото…",
    dateCardShareStep4: "🌠 Почти готово…",
    onbAnalyzeStep1: "🧠 Читаю твой контекст…",
    onbAnalyzeStep1b: "💭 Думаю…",
    onbAnalyzeStep2: "🧩 Выделяю ключевые черты…",
    onbAnalyzeStep3: "🧮 Собираю твой профиль…",
    verifyAnalyzeStep1: "🔍 Сверяю селфи с фото…",
    verifyAnalyzeStep2: "🧬 Анализирую черты лица…",
    verifyAnalyzeStep3: "⏳ Завершаю проверку…",
    videoCheckStep1: "🎬 Просматриваю твоё видео…",
    videoCheckStep2: "🙂 Проверяю, что это ты…",
    videoCheckStep3: "✨ Почти готово…",
    skipAnalyzeStep1: "✨ Дорабатываю профиль…",
    skipAnalyzeStep2: "🧮 Свожу всё воедино…",
    skipAnalyzeStep3: "💞 Готовлю к подбору…",
    profilerBatchThinking: "💭 Думаю…",
    profilerBatchSaving: "🧩 Сохраняю твои ответы…",
    profilerBatchSaved:
      "Карточка обновлена ✨ Учту при следующем подборе.",
    profilerNextAck: "✍️ Принято…",
    profilerNextFormulating: "💭 Думаю…",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "📍 Сменить место",
    venueBoardPingFromF: "{name} присматривает местечко поуютнее для вашего свидания 👀",
    venueBoardPingFromM: "{name} предлагает взглянуть на пару других мест для вашего свидания 👀",
    venueBoardPingBtn: "Взглянуть",
    venueKeepNotice: "Партнёр хотел бы остаться в {venue} 👍 Можно предложить другое место ниже.",
    venueBothKeepDm: "Вы оба остаётесь в {venue} — ничего не меняется, до встречи 👍",
    venueDeclinedKeepDm: "Остаётесь в {venue}, как и планировали изначально 👍",
    venuePayPromptDm:
      "Вы вместе выбрали новое место для свидания!\n📍 {venue}\n" +
      "Закрепи его — и мы обновим ваши карточки.",
    venuePayBtn: "⭐ Закрепить — {stars}",
    venueWishText:
      "{name} нашла место, которое ей очень нравится ✨\n📍 {venue}\n" +
      "Ей будет приятно, если закрепишь его ты.",
    venueWishPayBtn: "💫 Закрепить — {stars} ⭐",
    venueWishDeclineBtn: "Не в этот раз",
    venuePayDeclineAck:
      "Понял — место пока остаётся прежним. Если оно изменится, придёт обновлённая карточка.",
    venuePaySelfDm:
      "Вы сошлись на новом месте!\n📍 {venue}\nЗакрепи его — и мы обновим ваши карточки ✨",
    venuePaySelfBtn: "⭐ Закрепить — {stars}",
    venueSettledCard: "Готово — у вашего свидания новое место! 📍 {venue}",
    venueSettledPaidByM: "{name} оплатил смену места ❤️ Ваше свидание теперь в 📍 {venue}",
    venueSettledPaidByF: "{name} оплатила смену места ❤️ Ваше свидание теперь в 📍 {venue}",
    venueExpressPartnerFromF: "{name} выбрала для вас место поуютнее ✨ Новое место: 📍 {venue}",
    venueExpressPartnerFromM: "{name} выбрал для вас новое место ✨ Новое место: 📍 {venue}",
    venueLapsedDm: "Смена места не была закреплена — встречаетесь в {venue}, как и планировали 👌",
    venueKeepOriginalDm: "Партнёр решил оставить исходное место — встречаетесь в {venue}, как и планировали 👌",
    venueInvoiceTitle: "Смена места свидания",
    venueInvoiceDesc: "Новое место свидания: {venue}",
    venueInvoiceLabel: "Смена места",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Свидание через 5 часов! Вот темы для разговора:\n\n",
    icebreakerStreamStart: "✨ Подбираю, о чём вам двоим поговорить…",
    noMatchStreamStart: "💫 Просматриваю кандидатов этой недели для тебя…",
    profilerSkip: "Пропустить",
    wingmanHintIntro:
      "👋 Маленькая подсказка — свидание через полтора часа:\n\n",
    emergencyUnlocked:
      "Окно экстренной отмены открыто.\n" +
      "Совсем не можешь прийти — жми кнопку ниже.\n" +
      "*Нужна причина — она уйдёт мэтчу ровно так, как ты её напишешь.*",
    emergencyBtn: "🚨 Отменить свидание",
    emergencyConfirmPrompt:
      "Перед отменой — короткая проверка.\n\n" +
      "Если это волнение, небольшое опоздание или сомнение, лучше оставь свидание. " +
      "Мэтч уже выделил время для тебя, а личная встреча всё ещё может приятно удивить.\n\n" +
      "*Отменяй только если точно не можешь прийти: вернуть мэтч после этого нельзя.* " +
      "Если продолжишь, я попрошу причину и отправлю её мэтчу как есть.",
    emergencyBtnConfirm: "🔴 Да, отменить свидание",
    emergencyBtnBack: "🟢 Оставить свидание",
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
      "👥 **Если будет людно.** Так бывает — не страшно: можно взять кофе и пройтись или зайти в соседнее кафе, где людно и светло.\n" +
      "🚗 **Транспорт.** Добирайся до места и обратно самостоятельно любым удобным тебе способом (на общественном транспорте, такси или пешком). Главное — не садись в машину к малознакомому человеку.\n" +
      "📱 **Предупреди близких.** Перешли подруге или кому-то из близких детали этой встречи и, по возможности, расшарь свою геопозицию на вечер.\n" +
      "☕ **Контроль.** Старайся не оставлять свои вещи и напиток без присмотра.\n" +
      "🛑 **Твои границы.** Если тебе некомфортно или поведение партнера кажется странным — ты имеешь полное право просто встать и уйти в любой момент. Твоя безопасность всегда важнее вежливости.\n\n" +
      "Желаем отличного вечера и приятных впечатлений! ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Следующий мэтч через {d}д {h}ч",
    statusHoursMinutes: "⏳ Мэтчи прилетят через {h}ч {m}мин",
    statusMinutes: "✨ Почти готово! Мэтчи прилетят через {m} мин",
    statusProcessing: "✨ Сканируем твой город… Загляни чуть позже.",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Свидание через {d}д {h}ч",
    statusDateHoursMinutes: "💫 Свидание через {h}ч {m}мин",
    statusDateMinutes: "💫 Свидание через {m} мин",
    statusDateSoon: "💫 Свидание сегодня ✨",
    menuMyDateDays: "💫 Моё свидание · через {d}д {h}ч",
    menuMyDateHours: "💫 Моё свидание · через {h}ч {m}мин",
    menuMyDateMinutes: "💫 Моё свидание · через {m} мин",
    menuMyDateSoon: "💫 Моё свидание · сегодня ✨",
    menuMyDatePlanning: "⏳ Свидание планируется",
    dateHubNoActive: "Сейчас у тебя нет запланированного свидания.",
    dateHubHeaderScheduled: "💫 Твоё свидание с {name}",
    dateHubPlanningProposed:
      "У тебя мэтч с {name}. Посмотри карточку выше — и просто скажи, хочешь ли пойти.",
    dateHubPlanningNegotiating: "У тебя мэтч с {name}! Выбери удобное время:",
    dateHubPlanningVenue:
      "Почти всё готово с {name}. Отметь, откуда будешь добираться:",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не расслышал — можешь написать текстом?",
    voiceTooLong:
      "Голосовое слишком длинное. До 5 минут — или просто напиши текстом.",
    rateLimitFloodNotice:
      "Ого, как много сообщений сразу — дай пару секунд догнать, потом продолжим. 🙂",
    rateLimitDailyBudgetNotice:
      "Ты сегодня супер активн(а) 🙂 Давай продолжим завтра — на сегодня лимит исчерпан, чтобы всё работало стабильно для всех.",

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
    coordRequestAck: "Готово — я спросил. Сообщу сразу, как только согласятся ✨",
    coordPartnerAskApprove:
      "Твоему свиданию через ~1ч пригодится способ найти тебя на месте 💬\n\n" +
      "Поделиться своим Telegram с {name}?",
    coordPartnerBtnApprove: "✨ Поделиться Telegram",
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
    coordProxyRelayNamedPrefix: "💬 {name}: ",
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
      "Перш ніж почати, ознайомтеся з нашими Умовами використання та Політикою конфіденційності та прийміть умови зберігання даних.",
    consentAgree: "Згоден",
    consentPrivacyButton: "Політика конфіденційності",
    consentTermsButton: "Умови використання",
    welcome: "Gennety Dating 👀\nAI-метчмейкінг для справжніх побачень.",
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
    emailVerified: "Пошту підтверджено ✨",
    contextDumpAck: "Прийняв ✨ Обробляю…",
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
    askPhotos:
      "Майже все! Надішли {min}–{max} різних фото. На кожному маєш бути добре видимий ти, відвертий контент заборонений. У відео можуть бути друзі або краєвиди, але ти маєш добре з'являтися в кількох моментах.",
    photoReceived: "Фото {n}/{max} ✨",
    photoRejected:
      "На фото має бути видно твоє обличчя. Спробуй інший знімок.",
    photoDuplicate:
      "Це фото вже є в профілі. Додай інший знімок — усі фотографії мають бути унікальними.",
    photoDuplicateNear:
      "Це фото вже є в профілі. Додай інший знімок — усі фотографії мають бути унікальними.",
    photoUnsafeContent:
      "Це фото не можна публікувати у профілі. Обери інший знімок без відвертого контенту.",
    photoFaceObscured:
      "Обличчя погано видно. Зніми темні окуляри або маску й надішли чіткіший знімок.",
    photoMultipleFaces:
      "На фото має бути видно твоє обличчя. Спробуй інший знімок.",
    photoIdentityMismatch:
      "Усі фото мають належати одній людині. Переконайся, що твоє обличчя є на кожному знімку.",
    photoIdentityUncertain:
      "Не вдалося надійно зіставити обличчя. Надішли чіткіше фото з хорошим освітленням і добре видимим обличчям.",
    photoConsensusPending:
      "Я поки не зафіксував особу в профілі. Надішли ще одне інше фото, де видно ту саму людину.",
    photoConsensusOutlierRejected:
      "Одне очікуване фото було з іншою людиною, тому я його не додав.",
    photoConsensusConfirmed:
      "Особу підтверджено за збіжними фото ✨",
    photoConsensusNoPairCap:
      "Я досі не бачу двох фото однієї людини. Поки нічого не зафіксовано — надішли ще одне чітке фото себе.",
    photoVisionError:
      "Не вдалося обробити файл. Спробуй ще раз.",
    photoInvalidMedia:
      "Цей файл не є підтримуваним фото. Надішли зображення JPEG, PNG, WebP або HEIC.",
    livePhotoMissingStatic:
      "У цьому Live Photo немає статичного кадру, тому я не зможу його перевірити. Надішли звичайне фото або інше Live Photo.",
    livePhotoTooLong:
      "Live Photo має бути не довше 10 секунд. Надішли коротше або звичайне фото.",
    livePhotoTooLarge:
      "Live Photo має бути не більше 10 МБ. Надішли менший файл або звичайне фото.",
    videoTooLong:
      "Відео для профілю має бути не довше 60 секунд. Надішли коротше.",
    videoTooLarge:
      "Відео для профілю має бути не більше {mb} МБ. Надішли менше.",
    videoChecking:
      "Перевіряю безпечність відео та шукаю твоє обличчя в кількох моментах...",
    videoUnsafeContent:
      "У цьому відео є контент, який не можна публікувати у профілі. Обери інший ролик.",
    videoOwnerMissing:
      "У відео твоє обличчя має бути в кадрі більшу частину часу. Запиши нове відео.",
    videoOwnerTooBrief:
      "Твоє обличчя з'являється надто ненадовго або лише в одному моменті. Обери ролик, де тебе добре видно в кількох окремих сценах.",
    videoIdentityMismatch:
      "Відео має належати тій самій людині, що й фото в профілі.",
    videoMostlyOtherPerson:
      "У цьому відео переважно показана інша людина. Обери ролик, де тебе добре видно в кількох моментах.",
    videoNeedsPhotoFirst:
      "Спочатку надішли хоча б одне чітке фото для профілю. Після цього я зможу перевірити, що у відео саме ти.",
    videoProcessingUnavailable:
      "Зараз не вдалося перевірити відео. Попереднє відео не змінено. Спробуй ще раз трохи пізніше.",
    ticketRewardPhoto:
      "🎟️ Клас — ти щойно отримав *безкоштовний квиток на побачення*!\n\nЯк це працює: кожне побачення коштує 1 квиток, і зазвичай квитки платні. За додані фото — один у подарунок. Баланс: *{balance}* 🎟️",
    ticketRewardVideo:
      "🎟️ Відео в профілі — супер! Ось ще *безкоштовний квиток на побачення*.\n\nКожне побачення коштує 1 квиток (зазвичай платний), тож на наступне ти готовий. Баланс: *{balance}* 🎟️",
    ticketRewardVerification:
      "🎟️ Верифікацію пройдено — *безкоштовний квиток на побачення* вже на балансі.\n\nВін покриває одну зустріч. Баланс: *{balance}* 🎟️",
    ticketRewardStudent:
      "🎓 Університетську пошту підтверджено — студентський бонус: *2 безкоштовні квитки на побачення* вже на балансі.\n\nКожне побачення коштує 1 квиток, тож перші дві зустрічі за наш рахунок. Баланс: *{balance}* 🎟️",
    welcomeGiftTicket:
      "🎟 Твій перший квиток — від мене особисто.\n\nКожне побачення тут коштує 1 квиток, зазвичай ~$6.99\nЦе — безкоштовно: нехай перший крок буде про людину, а не про ціну\n\nКвиток уже у твоєму гаманці ❤️",
    ticketStorePurchased:
      "✨ Оплату отримано — додано *{count}* 🎟️!\n\nБаланс: *{balance}* 🎟️",
    ticketStoreCheckoutError: "Не вдалося підтвердити оплату. Спробуй ще раз.",
    ticketStoreInvoiceTitle: "Квитки Gennety",
    ticketStoreInvoiceDesc:
      "Поповнення гаманця: {count} 🎟️. Кожен квиток покриває одне побачення.",
    ticketGateInvoiceDesc:
      "Оплата вашого побачення — {count} квиток(ів). Один квиток — на одну людину.",
    ticketStoreInvoiceLabel: "Квитки Gennety × {count}",
    onboardingPhotosNeedMore:
      "Фото: {count}/{min}. Залишилося надіслати ще {remaining} чітке фото до обов'язкового мінімуму.",
    onboardingPhotosBonusOffer:
      "Обов'язкові фото готові ✨\n\nДоведи кількість фото до {threshold} (залишилося: {remaining}) й отримаєш безкоштовний квиток на побачення. Ще один безкоштовний квиток можна отримати за коротке відео для профілю.\n\nОбидва бонуси необов'язкові — можеш надіслати медіа зараз або продовжити.",
    onboardingPhotosBonusOfferAfterVideo:
      "Обов'язкові фото готові, а квиток за відео вже твій ✨\n\nДоведи кількість фото до {threshold} (залишилося: {remaining}) й отримаєш другий безкоштовний квиток. Або продовжуй.",
    onboardingPhotosBonusProgress:
      "{count}/{threshold} фото ✨ Ще одне відкриє безкоштовний квиток на побачення. Надішли його зараз або продовжуй.",
    onboardingPhotosBonusProgressAfterVideo:
      "{count}/{threshold} фото ✨ Ще одне відкриє другий безкоштовний квиток. Надішли його зараз або продовжуй.",
    onboardingPhotosPhotoBonusEarned:
      "Готово {count} фото, і безкоштовний квиток за фотографії вже твій ✨\n\nМожна додати фото до {max} або коротке відео за ще один безкоштовний квиток. Або продовжуй.",
    onboardingPhotosBothBonusesEarned:
      "Готово {count} фото й відео — обидва безкоштовні квитки вже твої ✨\n\nМожна додати фото до {max} або продовжити.",
    onboardingPhotosPhotoBonusEarnedMax:
      "Усі {max} фото готові, і безкоштовний квиток за фотографії вже твій ✨\n\nМожна надіслати коротке відео за ще один безкоштовний квиток або продовжити.",
    onboardingPhotosBothBonusesEarnedMax:
      "Усі {max} фото й відео готові — обидва безкоштовні квитки вже твої ✨\n\nПродовжуй, коли будеш готовий.",
    onboardingPhotosOptional:
      "Обов'язкові фото готові ✨\n\nМожеш додати ще фото до {max}, надіслати коротке відео для профілю або продовжити.",
    onboardingPhotosOptionalAfterVideo:
      "Обов'язкові фото й відео готові ✨\n\nМожеш додати ще фото до {max} або продовжити.",
    onboardingPhotosOptionalMax:
      "Усі {max} фото готові ✨\n\nМожеш надіслати коротке відео для профілю або продовжити.",
    onboardingPhotosOptionalMaxAfterVideo:
      "Усі {max} фото й відео готові ✨\n\nПродовжуй, коли будеш готовий.",
    menuMyTickets: "🎟️ Мої квитки",
    ticketWalletText:
      "🎟️ *Мої квитки*\n\nУ тебе *{balance}* квиток(ів). Кожне побачення коштує 1 квиток — докупити можна будь-коли.",
    ticketWalletOpenStore: "🎟️ Купити квитки",
    photosEnough: "Можеш надіслати ще (до {max}) або тисни кнопку.",
    photosDone: "Фото завантажено ✨",
    profileReview:
      "Ось твій профіль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Все ок?",
    profileConfirm: "Все ок ✨",
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
    verifyPitchTicket:
      "Фінальний крок — підтвердити, що профіль справді твій.\n\n" +
      "Ми порівняємо селфі з фотографіями профілю. Пройди перевірку й отримай *1 безкоштовний квиток на побачення*.\n\n" +
      "Якщо пропустити, ти відмовишся від квитка, втратиш {penalty} стартових ELO-пунктів і знизиш свої шанси на вдалу зустріч.",
    verifyPitchMandatory:
      "Фінальний крок. Ми підтверджуємо, що кожен учасник — реальна людина.\n\n" +
      "Селфі, зроблене під час верифікації, ми порівняємо з кожним фото у твоєму профілі — " +
      "фото, на яких не ти, буде відхилено.\n\n" +
      "Верифікація обов'язкова: підбір пар почнеться одразу після її проходження.",
    verifyPitchMandatoryTicket:
      "Фінальний крок — підтвердити, що профіль справді твій.\n\n" +
      "Ми порівняємо верифікаційне селфі з фотографіями профілю, а за проходження ти отримаєш *1 безкоштовний квиток на побачення*.\n\n" +
      "Верифікація обов'язкова: підбір пар почнеться одразу після її проходження.",
    verifyMandatoryNotice:
      "Верифікація тепер обов'язкова для всіх нових профілів — підбір пар почнеться одразу після її проходження. Це займе близько хвилини:",
    verifyReminderNudge:
      "Твій профіль готовий — залишився тільки крок верифікації. Це займе близько хвилини, і підбір пар почнеться одразу після:",
    verifyBtnGo: "🟢 Пройти верифікацію",
    verifyBtnCheck: "✨ Я пройшов перевірку",
    verifyBtnSkip: "⚪️ Пропустити поки",
    verifySkipNudgeCaption:
      "Секунду — послухай це, перш ніж пропустити 👆",
    verifySkipNudgeCaptionTicket:
      "Перш ніж відмовитися: пропуск позбавить тебе безкоштовного квитка, {penalty} ELO-пунктів і частини пріоритету в підборі. Спочатку послухай 👆",
    verifyBtnReconsider: "🟢 Все ж таки пройти верифікацію",
    verifyBtnSkipConfirm: "🔴 Все одно пропустити",
    verifyBtnSkipConfirmTicket: "🔴 Відмовитися від бонусу й пропустити",
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
      "Перевірку пройдено ✨ Профіль активний. Напишу, коли знайду метч.",
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
      "{occupationLine}" +
      "{universityLine}" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Опису ще немає._",
    myProfilePreviewHeader: "Так тебе бачить пара 👇",
    myProfileEditLabel: "✏️ Що змінити:",

    // --- Edit Profile ---
    editProfileBody:
      "Це зафіксовано:\n\n" +
      "• *Ім'я:* {firstName} {surname}\n" +
      "• *Вік:* {age}\n" +
      "• *Універ:* {university}\n\n" +
      "Можна змінити:",
    editBioBtn: "📝 Про себе",
    editPrefsBtn: "💘 Кого шукаю",
    editMajorBtn: "💼 Чим займаєшся",
    editProfilePhotosBtn: "📸 Мої фото",
    editBioPrompt:
      "Напиши кілька рядків про себе (до 500 символів).\n👀 Це читає твоя пара перед побаченням.",
    editBioTooLong: "Задовге — вклади в 500.",
    editBioSaved: "«Про себе» оновлено ✨",
    editMajorPrompt:
      "Чим займаєшся? (робота / навчання / сфера, до 100 символів)\n👀 Видно твоїй парі.",
    editMajorTooLong: "Задовге — вклади в 100.",
    editMajorSaved: "Збережено ✨",
    editPrefsTitle: "💘 *Кого шукаю*\n\n👀 Впливає на те, хто тобі трапиться. Що міняємо?",
    editPrefsAgeBtn: "🎂 Вік партнера",
    editPrefsBack: "⬅️ До редагування",
    editAgeRangePrompt: "У якому віковому діапазоні шукати тобі пару? (напр. 20-28)\nМін: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не зрозумів. Два числа через дефіс, напр. 20-28 (від {min} до {max}).",
    editAgeRangeSaved: "Діапазон оновлено ✨",
    editProfilePhotosStart: "Скинь нові фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото оновлено ✨",
    photoManagerTitle:
      "Твої фото. Видали зайві або додай нові (мін {min}, макс {max}).",
    photoManagerDeleteBtn: "🗑 {n}",
    photoManagerAddBtn: "➕ Додати",
    photoManagerDoneBtn: "✅ Готово",
    photoManagerMinReached: "Потрібно щонайменше {min} фото. Спершу додай нове.",
    photoManagerDeleted: "Фото видалено.",
    menuVideo: "🎬 Відео профілю",
    editVideoPrompt:
      "🎬 Надішли коротке відео для профілю (до {sec} сек, не більше {mb} МБ). Друзі, краєвид чи кліп з вечірки — усе підійде, відео оживляє анкету.",
    editVideoRewardLine: "🎁 Додай відео зараз і отримай безкоштовний квиток на побачення.",
    editVideoHasOne:
      "У тебе вже є відео в профілі. Надішли нове, щоб замінити, або видали його кнопкою нижче.",
    editVideoRemoveBtn: "🗑 Видалити відео",
    editVideoRemoved: "Відео з профілю видалено.",
    editVideoNotAVideo: "Надішли, будь ласка, *відео* (до {sec} сек, не більше {mb} МБ).",
    myProfileAddVideoHint:
      "🎬 Порада: додай коротке відео в профіль через меню — так анкета помітніша.",
    myProfileAddVideoHintReward:
      "🎬 Порада: додай коротке відео в профіль через меню та отримай безкоштовний квиток 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Пошук на паузі ⏸\nНових метчів не буде, поки не ввімкнеш.",
    resumeConfirmed: "Пошук запущено ▶️\nШІ вже працює.",

    // --- Settings ---
    settingsTitle: "⚙️ Налаштування",
    settingsLanguage: "🌐 Мова",
    settingsLanguagePick: "Обери мову:",
    settingsLanguageSaved: "Мову оновлено ✨",
    settingsTheme: "🎨 Тема",
    settingsThemePick: "Обери оформлення:",
    settingsThemeSaved: "Тему оновлено ✨",
    themeDarkOption: "🌙 Темна",
    themeLightOption: "☀️ Світла",
    settingsVerify: "🛡 Пройти верифікацію",
    settingsVerifyNotNeeded: "Ти вже верифікований ✨",
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
    deleteFreezeIntro:
      "Зачекай — перш ніж усе видаляти 👀\n\n" +
      "Необов'язково втрачати все. Краще *заморозь* акаунт: профіль, фото та верифікація " +
      "залишаться, ти зникнеш із підбору, а наступного разу просто надішлеш /start — і " +
      "одразу потрапиш у свій готовий профіль, без повторного онбордингу.\n\n" +
      "Все-таки видалити? Це вже назавжди.",
    deleteFreezeBtn: "❄️ Заморозити акаунт",
    deleteProceedBtn: "Все одно видалити акаунт",
    freezeConfirmed:
      "Готово — акаунт *заморожено* ❄️\n\n" +
      "Тебе не видно в підборі і я не писатиму. " +
      "Повертайся будь-коли через /start — усе на місці.",
    freezeWelcomeBack:
      "З поверненням! ❄️ → ☀️ Акаунт *розморожено* і знову в строю. " +
      "Ось твій профіль:",
    deleteFinalYes: "Так, я впевнений на 100%",
    deleteFinalNoSoft: "Ні",
    deleteFinalNoHard: "О боже, ні",
    freezePartnerNotice:
      "Важливо: твій метч більше недоступний, тож це побачення не відбудеться. " +
      "Не хвилюйся — у наступному підборі в тебе буде пріоритет 💛",

    // --- Matching ---
    matchHeadline: "💘 Знайшли тобі метч!",
    matchDeadlineNotice:
      "У тебе 24 години на відповідь. " +
      "Щойно натиснеш — *рішення остаточне*. Змінити не можна.",
    matchStreamStart: "✨ Чому ви підходите…",
    matchBtnAccept: "✨ Прийняти",
    matchBtnDecline: "❌ Пас",
    matchDeclineConfirmPrompt:
      "Точно пасуєш?\n\n" +
      "Це рішення остаточне — цю людину ти більше не побачиш. " +
      "Натисни, щоб підтвердити, або повернись назад.",
    matchBtnConfirmDecline: "❌ Так, пас",
    matchBtnKeepDeciding: "← Назад",
    matchDecisionQuestionM:
      "Ну що — хочеш піти з ним на побачення? 😊 Просто відповідай мені словами прямо тут.",
    matchDecisionQuestionF:
      "Ну що — хочеш піти з нею на побачення? 😊 Просто відповідай мені словами прямо тут.",
    matchTextYesConfirm: "Чудово ✨ Підтверди — і далі все зроблю я:",
    matchBtnConfirmGo: "💫 Так, іду на побачення",
    matchTextUnsure:
      "Не поспішай — коли вирішиш, просто напиши мені «так» або «ні».",
    matchDeclineDismissed:
      "Без поспіху — цей мэтч ще чекає на твою відповідь. 💛",
    matchAcceptedToast: "Прийнято ✨",
    matchDecisionSavedToast: "Записав ✨",
    matchAccepted: "Прийнято ✨ Чекаємо на іншу сторону.",
    matchBothAccepted: "Взаємно 🤍 Знайдемо час.",
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
      "Що зараз відбувається:\n" +
      "• Ми активно розширюємо спільноту й щодня покращуємо алгоритм підбору партнера.\n" +
      "• По-справжньому відповідна людина має з'явитися в одному з найближчих дропів.\n" +
      "• Кожен тиждень очікування підвищує твій пріоритет у наступному дропі.\n\n" +
      "До наступного четверга о 18:00 ✨",
    noMatchThisWeekTier2:
      "Привіт 🌿\n\n" +
      "Уже другий тиждень поспіль, як наш матчмейкер не знаходить когось, кого ми були б раді тобі показати. " +
      "Дякуємо, що лишаєшся з нами — це справді важливо.\n\n" +
      "Де ми зараз:\n" +
      "• Ми активно приводимо нових людей і налаштовуємо алгоритм під твої критерії.\n" +
      "• Дійсно вартий партнер має бути всього за кілька дропів від тебе.\n" +
      "• За очікування твій пріоритет у наступному дропі вже підвищено.\n\n" +
      "До наступного четверга о 18:00 — ми працюємо для тебе 🤍",
    noMatchThisWeekTier3:
      "Привіт ✨\n\n" +
      "Маємо знову бути чесними — пари, яка справді варта твого часу, досі немає. " +
      "Нам це не подобається ще більше, ніж тобі, і ми не вдаватимемо, що все добре.\n\n" +
      "Що ми насправді робимо:\n" +
      "• Особисто стежимо за твоєю чергою і підштовхуємо ріст спільноти у твоєму районі.\n" +
      "• Та сама людина обов'язково з'явиться в одному з найближчих дропів — ми не зупинимось.\n" +
      "• Щотижня очікування ми піднімаємо тебе вище у пріоритеті наступного дропу.\n\n" +
      "Дякуємо, що довіряєш. До четверга о 18:00 🤍",
    noMatchDiscountOffer:
      "🎟️ Невелика подяка за терпіння: твоє наступне перше побачення — зі знижкою {pct}% на один квиток. " +
      "Ми застосуємо знижку автоматично, коли тобі випаде пара або ти відкриєш свої квитки.",
    matchScheduleProposal: "Як тобі ці варіанти? Тисни зручний:",
    matchScheduleIter3:
      "Взаємно 🤍 Відкрий календар і познач зручний час.",
    matchScheduleAfterTicket:
      "📅 Тепер обери час — відкрий календар і познач усі зручні слоти.",
    matchScheduleBtnCalendar: "📅 Відкрити календар",
    // --- Date Ticket (преміум-крок після взаємного метчу) ---
    ticketCardCaption:
      "Взаємно 🤍 Отримай *квиток на побачення*, щоб відкрити планування.",
    ticketButton: "🎟️ Отримати квиток на побачення",
    ticketViewButton: "🎟️ Переглянути свій квиток на побачення",
    ticketStatusButton: "Відкрити побачення",
    ticketGateWaiting: "Квиток готовий ✨ Чекаємо на іншу сторону.",
    ticketBothSecuredDm: "Обидва квитки у вас 🎟️✨ Побачення в силі — оберімо час.",
    ticketPartnerPaidDm: "{name} вже сплатив твій квиток на побачення ❤️ Тобі нічого не потрібно робити.",
    ticketCoveredHerConfirm:
      "💛 Готово — ти оплатив квиток за {name}. Щойно вона це побачить, я дам тобі знати.",
    ticketPartnerSawItDm: "❤️ {name} побачила, що ти оплатив її квиток.",
    ticketRefundedDm:
      "Співрозмовник не встиг узяти свій квиток, тож твій ми повернули. Нічого страшного — відкрили планування безкоштовно. Знайдімо час 📅",
    matchScheduleNoOverlap: "Не збіглося — спробуємо ще.",
    matchScheduled: "Готово — до зустрічі 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 У час пік там може не бути місць — це ок: можна взяти каву з собою і прогулятися або зазирнути в інше місце поруч.",
    matchScheduledBtnOpenMaps: "📍 Відкрити в картах",
    matchScheduledBtnShare: "📤 Поділитися карткою",
    dateCardWhen: "КОЛИ",
    dateCardSlogan: "Error 404:\nChat not found.\nTry real life.",
    dateCardShareCaption:
      "Діліться сміливо — обличчя вашого метчу приховане, щоб зберегти його приватність 💞",
    dateCardShareFailed:
      "Не вдалося підготувати картку для надсилання — спробуйте за хвилину.",
    matchSchedulePickedPrefix: "Ти обрав: ",
    matchScheduleWaitingPeer: "Чекаємо на вибір іншої сторони…",
    matchSchedulePeerProposed:
      "Співрозмовник позначив дати й час у календарі. Відкрий його, щоб погодитись або запропонувати свій:",
    matchSchedulePeerSuggestedAlternative:
      "Співрозмовник запропонував інший час. Перевір відповідь: можеш погодитись із пропозицією або запропонувати свій варіант.",
    matchScheduleSavedConfirmation:
      "✨ Зберіг твої дати й час. Пінганув співрозмовника — напишу, щойно він(вона) відповість.",
    matchScheduleNoOverlapYet:
      "Ви обидва позначили дати й час, але варіанти не збіглись. Відкрий календар і додай ще кілька слотів — щойно один збіжиться, я зафіксую дату:",
    venueConciergeIntro:
      "Час зафіксовано 🗓️ Один момент, перш ніж підібрати місце.\n\n" +
      "📍 *Познач, звідки ти будеш виїжджати* на побачення — дім, станція метро, квартира друга, звідки тобі реально зручно стартувати.\n\n" +
      "За цією точкою я підберу зручне місце зустрічі, до якого легко дістатися вам *обом*, неподалік від твого старту. Натисни кнопку нижче й познач точку на карті:",
    venueConciergeBtnLocation: "📍 Надіслати геолокацію",
    venueConciergeBtnMap: "🗺️ Обрати на карті",
    venueLocationFirst:
      "Спершу головне — *познач, звідки ти будеш виїжджати* 📍 Натисни кнопку нижче й постав точку на карті. Про вайб запитаю одразу після.",
    venueVibeNoted: "Вайб записано ✨ Тепер вкажи, звідки поїдеш:",
    venueLocationNoted:
      "Точку виїзду збережено ✨ Тепер — який *вайб* хочеш? Наприклад: _тихе кафе_, _веган-сніданок_, _прогулянка в парку_, _невеликий музей_.",
    venueSafetyOverride:
      "Невеличке уточнення — заміняю на публічне кафе. Перші побачення у нас у людних місцях.",
    venueWaitingPeer: "Прийняв ✨ Чекаємо на іншу сторону…",
    venueSearching: "🔍 Шукаю зручне місце…",
    venueSearchStep2: "📍 Звіряю ваші маршрути…",
    venueSearchStep3: "✨ Підбираю за атмосферою…",
    dateCardStep1: "📋 Підтверджую деталі побачення…",
    dateCardStep2: "🎨 Збираю картку побачення…",
    dateCardStep3: "✨ Наводжу красу…",
    dateCardShareStep1: "✨ Готую картку для надсилання…",
    dateCardShareStep2: "💫 Розмиваю обличчя метчу…",
    dateCardShareStep3: "⭐ Наводжу красу на фото…",
    dateCardShareStep4: "🌠 Майже готово…",
    onbAnalyzeStep1: "🧠 Читаю твій контекст…",
    onbAnalyzeStep1b: "💭 Думаю…",
    onbAnalyzeStep2: "🧩 Виділяю ключові риси…",
    onbAnalyzeStep3: "🧮 Збираю твій профіль…",
    verifyAnalyzeStep1: "🔍 Звіряю селфі з фото…",
    verifyAnalyzeStep2: "🧬 Аналізую риси обличчя…",
    verifyAnalyzeStep3: "⏳ Завершую перевірку…",
    videoCheckStep1: "🎬 Переглядаю твоє відео…",
    videoCheckStep2: "🙂 Перевіряю, що це ти…",
    videoCheckStep3: "✨ Майже готово…",
    skipAnalyzeStep1: "✨ Допрацьовую профіль…",
    skipAnalyzeStep2: "🧮 Зводжу все воєдино…",
    skipAnalyzeStep3: "💞 Готую до підбору…",
    profilerBatchThinking: "💭 Думаю…",
    profilerBatchSaving: "🧩 Зберігаю твої відповіді…",
    profilerBatchSaved:
      "Картку оновлено ✨ Врахую під час наступного підбору.",
    profilerNextAck: "✍️ Прийнято…",
    profilerNextFormulating: "💭 Думаю…",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "📍 Змінити місце",
    venueBoardPingFromF: "{name} придивляється до затишнішого місця для вашого побачення 👀",
    venueBoardPingFromM: "{name} пропонує поглянути на кілька інших місць для вашого побачення 👀",
    venueBoardPingBtn: "Поглянути",
    venueKeepNotice: "Партнер хотів би залишитися у {venue} 👍 Можна запропонувати інше місце нижче.",
    venueBothKeepDm: "Ви обоє залишаєтесь у {venue} — нічого не змінюється, до зустрічі 👍",
    venueDeclinedKeepDm: "Залишаєтесь у {venue}, як і планували спочатку 👍",
    venuePayPromptDm:
      "Ви разом обрали нове місце для побачення!\n📍 {venue}\n" +
      "Закріпи його — і ми оновимо ваші картки.",
    venuePayBtn: "⭐ Закріпити — {stars}",
    venueWishText:
      "{name} знайшла місце, яке їй дуже подобається ✨\n📍 {venue}\n" +
      "Їй буде приємно, якщо закріпиш його ти.",
    venueWishPayBtn: "💫 Закріпити — {stars} ⭐",
    venueWishDeclineBtn: "Не цього разу",
    venuePayDeclineAck:
      "Зрозумів — місце поки лишається тим самим. Якщо воно зміниться, прийде оновлена картка.",
    venuePaySelfDm:
      "Ви зійшлися на новому місці!\n📍 {venue}\nЗакріпи його — і ми оновимо ваші картки ✨",
    venuePaySelfBtn: "⭐ Закріпити — {stars}",
    venueSettledCard: "Готово — у вашого побачення нове місце! 📍 {venue}",
    venueSettledPaidByM: "{name} оплатив зміну місця ❤️ Ваше побачення тепер у 📍 {venue}",
    venueSettledPaidByF: "{name} оплатила зміну місця ❤️ Ваше побачення тепер у 📍 {venue}",
    venueExpressPartnerFromF: "{name} обрала для вас затишніше місце ✨ Нове місце: 📍 {venue}",
    venueExpressPartnerFromM: "{name} обрав для вас нове місце ✨ Нове місце: 📍 {venue}",
    venueLapsedDm: "Зміну місця не закріплено — зустрічаєтесь у {venue}, як і планували 👌",
    venueKeepOriginalDm: "Партнер вирішив залишити початкове місце — зустрічаєтесь у {venue}, як і планували 👌",
    venueInvoiceTitle: "Зміна місця побачення",
    venueInvoiceDesc: "Нове місце побачення: {venue}",
    venueInvoiceLabel: "Зміна місця",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Побачення через 5 годин! Ось теми для розмови:\n\n",
    icebreakerStreamStart: "✨ Добираю, про що вам двом поговорити…",
    noMatchStreamStart: "💫 Переглядаю кандидатів цього тижня для тебе…",
    profilerSkip: "Пропустити",
    wingmanHintIntro:
      "👋 Маленька підказка — побачення через півтори години:\n\n",
    emergencyUnlocked:
      "Вікно екстреного скасування відкрите.\n" +
      "Зовсім не можеш прийти — тисни кнопку нижче.\n" +
      "*Потрібна причина — вона піде метчу саме так, як ти її напишеш.*",
    emergencyBtn: "🚨 Скасувати побачення",
    emergencyConfirmPrompt:
      "Перед скасуванням — коротка перевірка.\n\n" +
      "Якщо це хвилювання, невелике запізнення або сумнів, краще залиш побачення. " +
      "Метч уже виділив час для тебе, а жива зустріч ще може приємно здивувати.\n\n" +
      "*Скасовуй лише якщо точно не можеш прийти: після цього метч не можна відновити.* " +
      "Якщо продовжиш, я попрошу причину й надішлю її метчу як є.",
    emergencyBtnConfirm: "🔴 Так, скасувати побачення",
    emergencyBtnBack: "🟢 Залишити побачення",
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
      "👥 **Якщо буде людно.** Таке буває — не страшно: можна взяти каву й прогулятися або зайти в сусіднє кафе, де людно і світло.\n" +
      "🚗 **Транспорт.** Добирайся туди і назад самостійно будь-яким зручним способом (громадським транспортом, таксі чи пішки). Головне — не сідай у машину до малознайомої людини.\n" +
      "📱 **Попередь близьких.** Перешли подрузі або комусь із близьких деталі цієї зустрічі і, якщо є можливість, поділися геолокацією на вечір.\n" +
      "☕ **Контроль.** Намагайся не залишати речі й напій без нагляду.\n" +
      "🛑 **Твої межі.** Якщо тобі некомфортно або поведінка партнера здається дивною — маєш повне право просто встати і піти в будь-який момент. Твоя безпека завжди важливіша за ввічливість.\n\n" +
      "Бажаємо чудового вечора і приємних вражень ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Наступний метч через {d}д {h}г",
    statusHoursMinutes: "⏳ Метчі прилетять через {h}г {m}хв",
    statusMinutes: "✨ Майже готово! Метчі прилетять за {m} хв",
    statusProcessing: "✨ Скануємо твоє місто… Зазирни трохи згодом.",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Побачення через {d}д {h}г",
    statusDateHoursMinutes: "💫 Побачення через {h}г {m}хв",
    statusDateMinutes: "💫 Побачення через {m} хв",
    statusDateSoon: "💫 Побачення сьогодні ✨",
    menuMyDateDays: "💫 Моє побачення · через {d}д {h}г",
    menuMyDateHours: "💫 Моє побачення · через {h}г {m}хв",
    menuMyDateMinutes: "💫 Моє побачення · через {m} хв",
    menuMyDateSoon: "💫 Моє побачення · сьогодні ✨",
    menuMyDatePlanning: "⏳ Побачення планується",
    dateHubNoActive: "Зараз у тебе немає запланованого побачення.",
    dateHubHeaderScheduled: "💫 Твоє побачення з {name}",
    dateHubPlanningProposed:
      "У тебе метч із {name}. Поглянь на картку вище — і просто скажи, чи хочеш піти.",
    dateHubPlanningNegotiating: "У тебе метч із {name}! Обери зручний час:",
    dateHubPlanningVenue:
      "Майже все готово з {name}. Познач, звідки вирушатимеш:",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не розчув — можеш написати текстом?",
    voiceTooLong:
      "Голосове задовге. До 5 хвилин — або просто напиши текстом.",
    rateLimitFloodNotice:
      "Ого, як багато повідомлень одразу — дай кілька секунд наздогнати, потім продовжимо. 🙂",
    rateLimitDailyBudgetNotice:
      "Ти сьогодні дуже активний(на) 🙂 Продовжимо завтра — на сьогодні ліміт вичерпано, щоб усе працювало стабільно для всіх.",

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
    coordRequestAck: "Готово — я запитав. Повідомлю одразу, щойно погодяться ✨",
    coordPartnerAskApprove:
      "Твоєму побаченню за ~1год знадобиться спосіб знайти тебе на місці 💬\n\n" +
      "Поділитися своїм Telegram з {name}?",
    coordPartnerBtnApprove: "✨ Поділитися Telegram",
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
    coordProxyRelayNamedPrefix: "💬 {name}: ",
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
    "Bevor wir anfangen, lies bitte unsere Nutzungsbedingungen und Datenschutzerklärung und stimme den Bedingungen zur Datenspeicherung zu.",
  consentAgree: "Ich stimme zu",
  consentPrivacyButton: "Datenschutzerklärung",
  consentTermsButton: "Nutzungsbedingungen",
  welcome: "Gennety Dating 👀\nAI-Matchmaking für echte Dates.",
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
  emailVerified: "E-Mail bestätigt ✨",
  contextDumpAck: "Verstanden ✨ Ich verarbeite es…",
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
  askPhotos:
    "Fast fertig! Sende {min}-{max} verschiedene Fotos. Auf jedem musst du klar zu sehen sein; explizite Inhalte sind nicht erlaubt. Ein Profilvideo darf Freunde oder Landschaften zeigen, aber du musst in mehreren Momenten klar erscheinen.",
  photoReceived: "Foto {n}/{max} ✨",
  photoRejected:
    "Dein Gesicht muss auf dem Foto sichtbar sein. Versuch ein anderes Bild.",
  photoDuplicate:
    "Dieses Foto ist bereits in deinem Profil. Füge ein anderes Bild hinzu - alle Fotos müssen eindeutig sein.",
  photoDuplicateNear:
    "Dieses Foto ist bereits in deinem Profil. Füge ein anderes Bild hinzu - alle Fotos müssen eindeutig sein.",
  photoUnsafeContent:
    "Dieses Foto kann nicht im Profil veröffentlicht werden. Wähle bitte ein anderes, nicht explizites Foto.",
  photoFaceObscured:
    "Dein Gesicht ist schlecht zu erkennen. Nimm Sonnenbrille oder Maske ab und sende ein klareres Foto.",
  photoMultipleFaces:
    "Dein Gesicht muss auf dem Foto sichtbar sein. Versuch ein anderes Bild.",
  photoIdentityMismatch:
    "Alle Fotos müssen zur selben Person gehören. Stelle sicher, dass dein Gesicht auf jedem Bild zu sehen ist.",
  photoIdentityUncertain:
    "Das Gesicht konnte nicht zuverlässig zugeordnet werden. Sende ein klareres Foto mit gutem Licht und gut sichtbarem Gesicht.",
  photoConsensusPending:
    "Ich habe die Profilidentität noch nicht festgelegt. Sende ein weiteres anderes Foto, auf dem dieselbe Person zu sehen ist.",
  photoConsensusOutlierRejected:
    "Ein wartendes Foto zeigte eine andere Person, deshalb habe ich es nicht hinzugefügt.",
  photoConsensusConfirmed:
    "Identität durch übereinstimmende Fotos bestätigt ✨",
  photoConsensusNoPairCap:
    "Ich sehe immer noch keine zwei Fotos derselben Person. Es wurde noch nichts festgelegt - sende ein weiteres klares Foto von dir.",
  photoVisionError: "Die Datei konnte nicht verarbeitet werden. Versuch es erneut.",
  photoInvalidMedia:
    "Diese Datei ist kein unterstütztes Foto. Sende ein JPEG-, PNG-, WebP- oder HEIC-Bild.",
  photosEnough: "Du kannst mehr senden (bis {max}) oder auf den Button tippen, um weiterzumachen.",
  photosDone: "Fotos hochgeladen ✨",
  profileReview:
    "Hier ist dein Profil:\n\n" +
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n\n" +
    "{summary}\n\n" +
    "Passt das?",
  profileConfirm: "Passt ✨",
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
  verifyPitchTicket:
    "Letzter Schritt: Bestätige, dass dieses Profil wirklich dir gehört.\n\n" +
    "Wir vergleichen ein Verifizierungs-Selfie mit deinen Profilfotos. Schließe die Prüfung ab und erhalte *1 kostenloses Date-Ticket*.\n\n" +
    "Wenn du überspringst, verzichtest du auf das Ticket, verlierst {penalty} Start-ELO-Punkte und senkst deine Chancen auf ein starkes Match.",
  verifyPitchMandatory:
    "Letzter Schritt. Wir bestätigen, dass jedes Mitglied eine echte Person ist.\n\n" +
    "Wir vergleichen das Selfie aus der Verifizierung mit jedem Foto in deinem Profil — " +
    "Fotos, die nicht zu dir passen, werden abgelehnt.\n\n" +
    "Die Verifizierung ist verpflichtend: das Matching startet direkt nach dem Bestehen.",
  verifyPitchMandatoryTicket:
    "Letzter Schritt: Bestätige, dass dieses Profil wirklich dir gehört.\n\n" +
    "Wir vergleichen ein Verifizierungs-Selfie mit deinen Profilfotos — und fürs Bestehen bekommst du *1 kostenloses Date-Ticket*.\n\n" +
    "Die Verifizierung ist verpflichtend: das Matching startet direkt nach dem Bestehen.",
  verifyMandatoryNotice:
    "Die Verifizierung ist jetzt für alle neuen Profile verpflichtend — das Matching startet direkt nach dem Bestehen. Dauert etwa eine Minute:",
  verifyReminderNudge:
    "Dein Profil ist fertig — es fehlt nur noch die Verifizierung. Sie dauert etwa eine Minute, und das Matching startet direkt danach:",
  verifyBtnGo: "🟢 Jetzt verifizieren",
  verifyBtnCheck: "✨ Ich habe die Verifizierung abgeschlossen",
  verifyBtnSkip: "⚪️ Erstmal überspringen",
  verifySkipNudgeCaption:
    "Kurz — hör dir das an, bevor du überspringst 👆",
  verifySkipNudgeCaptionTicket:
    "Bevor du verzichtest: Überspringen kostet dich das kostenlose Ticket, {penalty} ELO-Punkte und einen Teil deiner Match-Priorität. Hör erst kurz rein 👆",
  verifyBtnReconsider: "🟢 OK, ich verifiziere mich",
  verifyBtnSkipConfirm: "🔴 Trotzdem überspringen",
  verifyBtnSkipConfirmTicket: "🔴 Bonus aufgeben und überspringen",
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
    "Verifiziert ✨ Dein Profil ist live. Ich melde mich, wenn ich ein Match finde.",
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
    "Profilvideos dürfen höchstens {mb} MB groß sein. Schick ein kleineres.",
  videoChecking:
    "Ich prüfe das Video auf Sicherheit und suche dein Gesicht in mehreren Momenten...",
  videoUnsafeContent:
    "Dieses Video enthält Inhalte, die nicht im Profil veröffentlicht werden können. Wähle bitte einen anderen Clip.",
  videoOwnerMissing:
    "Dein Gesicht muss die meiste Zeit im Video im Bild sein. Nimm ein neues Video auf.",
  videoOwnerTooBrief:
    "Dein Gesicht erscheint zu kurz oder nur in einem Moment. Wähle einen Clip, in dem du in mehreren getrennten Momenten klar zu sehen bist.",
  videoIdentityMismatch:
    "Das Video muss zur selben Person gehören wie die Fotos im Profil.",
  videoMostlyOtherPerson:
    "Dieses Video zeigt hauptsächlich eine andere Person. Wähle einen Clip, in dem du in mehreren Momenten klar zu sehen bist.",
  videoNeedsPhotoFirst:
    "Sende zuerst mindestens ein klares Profilfoto. Danach kann ich prüfen, ob du im Video zu sehen bist.",
  videoProcessingUnavailable:
    "Ich konnte das Video gerade nicht prüfen. Dein bisheriges Video wurde nicht geändert. Versuch es bitte gleich noch einmal.",
  ticketRewardPhoto:
    "🎟️ Stark — du hast gerade ein *kostenloses Date-Ticket* verdient!\n\nSo läuft's: Jedes Date kostet 1 Ticket, und Tickets kosten normalerweise Geld. Für deine Fotos gibt's eins gratis. Guthaben: *{balance}* 🎟️",
  ticketRewardVideo:
    "🎟️ Ein Profilvideo — top! Noch ein *kostenloses Date-Ticket* für dich.\n\nJedes Date kostet 1 Ticket (sonst kostenpflichtig). Guthaben: *{balance}* 🎟️",
  ticketRewardVerification:
    "🎟️ Verifizierung abgeschlossen — dein *kostenloses Date-Ticket* ist schon im Guthaben.\n\nEs deckt ein Date ab. Guthaben: *{balance}* 🎟️",
  ticketRewardStudent:
    "🎓 Universitäts-E-Mail bestätigt — Studi-Bonus freigeschaltet: *2 kostenlose Date-Tickets* sind in deinem Guthaben.\n\nJedes Date kostet 1 Ticket — deine ersten zwei Dates gehen auf uns. Guthaben: *{balance}* 🎟️",
  welcomeGiftTicket:
    "🎟 Dein erstes Ticket — von mir persönlich.\n\nJedes Date hier kostet 1 Ticket, normalerweise ~$6,99\nDieses ist gratis — dein erster Schritt soll um den Menschen gehen, nicht um den Preis\n\nEs liegt schon in deinem Guthaben ❤️",
  ticketStorePurchased:
    "✨ Zahlung erhalten — *{count}* Ticket(s) hinzugefügt!\n\nGuthaben: *{balance}* 🎟️",
  ticketStoreCheckoutError: "Zahlung konnte nicht bestätigt werden. Bitte versuch es erneut.",
  ticketStoreInvoiceTitle: "Gennety Date-Tickets",
  ticketStoreInvoiceDesc:
    "{count} Date-Ticket(s) für deine Wallet. Jedes Ticket deckt ein Date ab.",
  ticketGateInvoiceDesc:
    "Dein Date wird gesichert — {count} Date-Ticket(s). Ein Ticket pro Person.",
  ticketStoreInvoiceLabel: "{count} Date-Ticket(s)",
  onboardingPhotosNeedMore:
    "Fotostand: {count}/{min}. Noch benötigte klare Fotos: {remaining}.",
  onboardingPhotosBonusOffer:
    "Die Pflichtfotos sind fertig ✨\n\nErreiche {threshold} Fotos (noch {remaining}), um ein kostenloses Date-Ticket zu bekommen. Für ein kurzes Profilvideo erhältst du ein weiteres kostenloses Ticket.\n\nBeide Boni sind optional — sende jetzt weitere Medien oder fahre fort.",
  onboardingPhotosBonusOfferAfterVideo:
    "Die Pflichtfotos sind fertig und dein Video-Bonus ist gesichert ✨\n\nErreiche {threshold} Fotos (noch {remaining}), um ein zweites kostenloses Date-Ticket zu bekommen, oder fahre fort.",
  onboardingPhotosBonusProgress:
    "{count}/{threshold} Fotos ✨ Noch ein Foto schaltet ein kostenloses Date-Ticket frei. Sende es jetzt oder fahre fort.",
  onboardingPhotosBonusProgressAfterVideo:
    "{count}/{threshold} Fotos ✨ Noch ein Foto schaltet dein zweites kostenloses Date-Ticket frei. Sende es jetzt oder fahre fort.",
  onboardingPhotosPhotoBonusEarned:
    "{count} Fotos sind fertig und dein kostenloses Foto-Date-Ticket ist gesichert ✨\n\nDu kannst noch Fotos bis maximal {max} oder ein kurzes Profilvideo für ein weiteres kostenloses Ticket senden. Sonst fahre fort.",
  onboardingPhotosBothBonusesEarned:
    "{count} Fotos und dein Profilvideo sind fertig — beide kostenlosen Date-Tickets sind gesichert ✨\n\nDu kannst noch Fotos bis maximal {max} senden oder fortfahren.",
  onboardingPhotosPhotoBonusEarnedMax:
    "Alle {max} Fotos sind fertig und dein kostenloses Foto-Date-Ticket ist gesichert ✨\n\nDu kannst noch ein kurzes Profilvideo für ein weiteres kostenloses Ticket senden oder fortfahren.",
  onboardingPhotosBothBonusesEarnedMax:
    "Alle {max} Fotos und dein Profilvideo sind fertig — beide kostenlosen Date-Tickets sind gesichert ✨\n\nFahre fort, wenn du bereit bist.",
  onboardingPhotosOptional:
    "Die Pflichtfotos sind fertig ✨\n\nDu kannst weitere Fotos bis maximal {max}, ein kurzes Profilvideo senden oder fortfahren.",
  onboardingPhotosOptionalAfterVideo:
    "Die Pflichtfotos und dein Profilvideo sind fertig ✨\n\nDu kannst weitere Fotos bis maximal {max} senden oder fortfahren.",
  onboardingPhotosOptionalMax:
    "Alle {max} Fotos sind fertig ✨\n\nDu kannst noch ein kurzes Profilvideo senden oder fortfahren.",
  onboardingPhotosOptionalMaxAfterVideo:
    "Alle {max} Fotos und dein Profilvideo sind fertig ✨\n\nFahre fort, wenn du bereit bist.",
  ticketWalletText:
    "🎟️ *Meine Tickets*\n\nDu hast *{balance}* Ticket(s). Jedes Date kostet 1 Ticket — jederzeit nachkaufbar.",
  ticketWalletOpenStore: "🎟️ Tickets kaufen",
  menuBack: "⬅️ Zurück",
  myProfileBody:
    "*{firstName} {surname}*, {age}\n" +
    "{occupationLine}" +
    "{universityLine}" +
    "🌐 {language}\n\n" +
    "{summary}",
  myProfileNoBio: "_Noch keine Bio._",
  myProfilePreviewHeader: "So sieht dich dein Match 👇",
  myProfileEditLabel: "✏️ Was ändern:",
  editProfileBody:
    "Das ist fest gespeichert:\n\n" +
    "• *Name:* {firstName} {surname}\n" +
    "• *Alter:* {age}\n" +
    "• *Universität:* {university}\n\n" +
    "Du kannst bearbeiten:",
  editBioBtn: "📝 Über mich",
  editPrefsBtn: "💘 Wen ich suche",
  editMajorBtn: "💼 Was ich mache",
  editProfilePhotosBtn: "📸 Meine Fotos",
  editBioPrompt:
    "Schreib ein paar Zeilen über dich (max. 500 Zeichen).\n👀 Dein Match liest das vor dem Date.",
  editBioTooLong: "Zu lang - bleib unter 500 Zeichen.",
  editBioSaved: "„Über mich“ aktualisiert ✨",
  editMajorPrompt:
    "Was machst du? (Job / Studium / Bereich, max. 100 Zeichen)\n👀 Für dein Match sichtbar.",
  editMajorTooLong: "Zu lang - bleib unter 100 Zeichen.",
  editMajorSaved: "Gespeichert ✨",
  editPrefsTitle: "💘 *Wen ich suche*\n\n👀 Beeinflusst, wer dir vorgeschlagen wird. Was ändern?",
  editPrefsAgeBtn: "🎂 Partner-Alter",
  editPrefsBack: "⬅️ Zurück zu Bearbeiten",
  editAgeRangePrompt: "In welcher Altersspanne sollen wir nach einem Partner für dich suchen? (z. B. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Das habe ich nicht verstanden. Zwei Zahlen wie 20-28 (Bereich {min}-{max}).",
  editAgeRangeSaved: "Altersbereich aktualisiert ✨",
  editProfilePhotosStart: "Sende neue Fotos ({min}-{max}). Eins nach dem anderen.",
  editProfilePhotosSaved: "Fotos aktualisiert ✨",
  photoManagerTitle:
    "Deine Fotos. Lösche unerwünschte oder füge neue hinzu (min {min}, max {max}).",
  photoManagerDeleteBtn: "🗑 {n}",
  photoManagerAddBtn: "➕ Hinzufügen",
  photoManagerDoneBtn: "✅ Fertig",
  photoManagerMinReached: "Du brauchst mindestens {min} Fotos. Füge zuerst ein neues hinzu.",
  photoManagerDeleted: "Foto gelöscht.",
  menuVideo: "🎬 Profilvideo",
  editVideoPrompt:
    "🎬 Sende ein kurzes Profilvideo (bis {sec} Sek., max. {mb} MB). Freunde, Landschaft oder ein Party-Clip sind völlig okay — es macht dein Profil lebendiger.",
  editVideoRewardLine: "🎁 Füge jetzt eins hinzu und sichere dir ein kostenloses Date-Ticket.",
  editVideoHasOne:
    "Du hast bereits ein Profilvideo. Sende ein neues, um es zu ersetzen, oder entferne es unten.",
  editVideoRemoveBtn: "🗑 Video entfernen",
  editVideoRemoved: "Profilvideo entfernt.",
  editVideoNotAVideo: "Bitte sende ein *Video* (bis {sec} Sek., max. {mb} MB).",
  myProfileAddVideoHint:
    "🎬 Tipp: Füge über das Menü ein kurzes Profilvideo hinzu — so fällt dein Profil mehr auf.",
  myProfileAddVideoHintReward:
    "🎬 Tipp: Füge über das Menü ein kurzes Profilvideo hinzu und sichere dir ein kostenloses Ticket 🎁.",
  pauseConfirmed: "Matching pausiert ⏸\nKeine neuen Matches, bis du fortsetzt.",
  resumeConfirmed: "Matching läuft wieder ▶️\nUnsere AI ist dran.",
  settingsTitle: "⚙️ Einstellungen",
  settingsLanguage: "🌐 Sprache",
  settingsLanguagePick: "Wähle eine Sprache:",
  settingsLanguageSaved: "Sprache aktualisiert ✨",
  settingsTheme: "🎨 Thema",
  settingsThemePick: "Wähle dein Design:",
  settingsThemeSaved: "Thema aktualisiert ✨",
  themeDarkOption: "🌙 Dunkel",
  themeLightOption: "☀️ Hell",
  settingsVerify: "🛡 Account verifizieren",
  settingsVerifyNotNeeded: "Du bist schon verifiziert ✨",
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
  deleteFreezeIntro:
    "Warte — bevor du alles löschst 👀\n\n" +
    "Du musst nicht alles verlieren. *Friere* deinen Account lieber ein: Profil, Fotos " +
    "und Verifizierung bleiben erhalten, du verschwindest aus dem Matching, und beim " +
    "nächsten Mal sendest du einfach /start und landest direkt in deinem fertigen Profil " +
    "— kein erneutes Onboarding.\n\n" +
    "Trotzdem löschen? Das ist endgültig.",
  deleteFreezeBtn: "❄️ Account einfrieren",
  deleteProceedBtn: "Account trotzdem löschen",
  freezeConfirmed:
    "Erledigt — dein Account ist *eingefroren* ❄️\n\n" +
    "Du bist im Matching nicht sichtbar und bekommst keine Nachrichten. " +
    "Komm jederzeit mit /start zurück — alles ist noch da.",
  freezeWelcomeBack:
    "Willkommen zurück! ❄️ → ☀️ Dein Account ist *aufgetaut* und wieder aktiv. " +
    "Hier ist dein Profil:",
  deleteFinalYes: "Ja, ich bin mir zu 100% sicher",
  deleteFinalNoSoft: "Nein",
  deleteFinalNoHard: "Oh Gott, nein",
  freezePartnerNotice:
    "Kurze Info — dein Match ist nicht mehr verfügbar, dieses Date findet also nicht statt. " +
    "Kein Stress: Beim nächsten Durchlauf hast du Priorität 💛",
  matchHeadline: "💘 Wir haben ein Match für dich!",
  matchDeadlineNotice:
    "Du hast 24h zum Antworten. " +
    "Sobald du tippst, ist *die Entscheidung final*. Kein Zurück.",
  matchStreamStart: "✨ Warum ihr zusammenpasst…",
  matchBtnAccept: "✨ Annehmen",
  matchBtnDecline: "❌ Passen",
  matchDeclineConfirmPrompt:
    "Dieses Match passen?\n\n" +
    "Das ist endgültig — diese Person wird dir nicht noch einmal vorgeschlagen. " +
    "Tippe zum Bestätigen oder geh zurück.",
  matchBtnConfirmDecline: "❌ Ja, passen",
  matchBtnKeepDeciding: "← Zurück",
  matchDecisionQuestionM:
    "Und — willst du mit ihm auf ein Date gehen? 😊 Antworte mir einfach hier in deinen eigenen Worten.",
  matchDecisionQuestionF:
    "Und — willst du mit ihr auf ein Date gehen? 😊 Antworte mir einfach hier in deinen eigenen Worten.",
  matchTextYesConfirm: "Stark ✨ Bestätige unten — den Rest übernehme ich:",
  matchBtnConfirmGo: "💫 Ja, ich gehe hin",
  matchTextUnsure:
    "Kein Stress — sag mir einfach „ja“ oder „nein“, wenn du so weit bist.",
  matchDeclineDismissed:
    "Kein Stress — dieses Match wartet noch auf deine Antwort. 💛",
  matchAcceptedToast: "Angenommen ✨",
  matchDecisionSavedToast: "Gespeichert ✨",
  matchAccepted: "Angenommen ✨ Warten auf die andere Person.",
  matchBothAccepted: "Beidseitig 🤍 Lass uns eine Zeit finden.",
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
    "Wie der Stand ist:\n" +
    "• Wir bauen die Community schnell aus und verbessern den Algorithmus jeden Tag.\n" +
    "• Ein wirklich passender Mensch sollte in einem der nächsten Drops auftauchen.\n" +
    "• Jede Woche Wartezeit erhöht deine Priorität im nächsten Drop.\n\n" +
    "Bis nächsten Donnerstag um 18:00 ✨",
  noMatchThisWeekTier2:
    "Hey 🌿\n\n" +
    "Zweite Woche in Folge und unser Matchmaker hat noch niemanden gefunden, den wir dir wirklich gern vorstellen würden. " +
    "Danke für deine Geduld - das bedeutet uns viel.\n\n" +
    "Was du wissen solltest:\n" +
    "• Wir bringen aktiv mehr passende Menschen in die Community und tunen den Algorithmus für dich.\n" +
    "• Ein wirklich guter Partner sollte nur ein paar Drops entfernt sein.\n" +
    "• Deine Priorität für den nächsten Drop ist für die Wartezeit bereits erhöht.\n\n" +
    "Bis Donnerstag um 18:00 - wir arbeiten für dich 🤍",
  noMatchThisWeekTier3:
    "Hey ✨\n\n" +
    "Wir schulden dir ein ehrliches Update - immer noch niemand, der deine Zeit wirklich wert wäre. " +
    "Uns nervt das selbst, und wir tun nicht so, als wäre es anders.\n\n" +
    "Was bei uns gerade passiert:\n" +
    "• Wir beobachten deine Queue persönlich und pushen das Community-Wachstum in deiner Gegend.\n" +
    "• Die richtige Person kommt in einem der nächsten Drops - wir hören nicht auf, bis es klappt.\n" +
    "• Jede Woche Wartezeit rücken wir dich in der Priorität für den nächsten Drop weiter nach oben.\n\n" +
    "Danke für dein Vertrauen. Bis Donnerstag um 18:00 🤍",
  noMatchDiscountOffer:
    "🎟️ Ein kleines Dankeschön für deine Geduld: dein nächstes erstes Date gibt es mit {pct}% Rabatt auf ein Ticket. " +
    "Wir ziehen den Rabatt automatisch ab, sobald du ein Match bekommst oder deine Tickets öffnest.",
  matchScheduleProposal: "Wie wäre es mit einer dieser Zeiten? Tipp an, was passt:",
  matchScheduleIter3:
    "Beidseitig 🤍 Öffne den Kalender und markiere passende Zeiten.",
  matchScheduleAfterTicket:
    "📅 Jetzt eure Zeit — öffne den Kalender und markiere alle passenden Slots.",
  matchScheduleBtnCalendar: "📅 Kalender öffnen",
  ticketCardCaption:
    "Beidseitig 🤍 Hol dir dein *Date-Ticket*, um die Planung zu öffnen.",
  ticketButton: "🎟️ Date-Ticket holen",
  ticketViewButton: "🎟️ Dein Date-Ticket ansehen",
  ticketStatusButton: "Date öffnen",
  ticketGateWaiting: "Ticket bereit ✨ Warten auf die andere Person.",
  matchScheduleNoOverlap: "Noch keine Überschneidung - nächste Runde.",
  matchScheduled: "Fixiert — bis dann 🤝\n\n{venue}",
  matchScheduledNoReservation:
    "🍵 Zur Stoßzeit kann's voll sein - kein Stress: einfach einen Kaffee to go holen und eine Runde drehen, oder in einen anderen netten Laden nebenan schauen.",
  matchScheduledBtnOpenMaps: "📍 In Maps öffnen",
  matchScheduledBtnShare: "📤 Karte teilen",
  dateCardWhen: "WANN",
  dateCardSlogan: "Error 404:\nChat not found.\nTry real life.",
  dateCardShareCaption:
    "Teile sie ruhig — das Gesicht deines Matches ist zum Schutz seiner Privatsphäre verdeckt 💞",
  dateCardShareFailed:
    "Konnte gerade keine teilbare Karte erstellen — versuch es gleich noch einmal.",
  matchSchedulePickedPrefix: "Du hast gewählt: ",
  matchScheduleWaitingPeer: "Warten auf die andere Person...",
  matchSchedulePeerProposed:
    "Dein Match hat Daten und Zeiten im Kalender markiert. Öffne ihn, um eine zu bestätigen oder eine eigene vorzuschlagen:",
  matchSchedulePeerSuggestedAlternative:
    "Dein Match hat eine andere Zeit vorgeschlagen. Schau dir die Antwort an: du kannst zustimmen oder selbst etwas vorschlagen.",
  matchScheduleSavedConfirmation:
    "✨ Deine Daten und Zeiten sind gespeichert. Wir haben dein Match gepingt - ich sage Bescheid, sobald eine Antwort kommt.",
  matchScheduleNoOverlapYet:
    "Ihr habt beide Daten und Zeiten markiert, aber noch keine Überschneidung. Öffne den Kalender und füge ein paar Optionen hinzu - sobald ein Slot passt, fixieren wir es:",
  venueConciergeIntro:
    "Zeit steht 🗓️ Eine Sache, bevor ich den Ort finde.\n\n" +
    "📍 *Markiere, von wo du losfährst* zum Date - dein Zuhause, eine Metro-Station, die Wohnung einer Freundin, wo immer du tatsächlich startest.\n\n" +
    "Anhand dieses Punkts finde ich einen angenehmen Treffpunkt, der für *euch beide* gut erreichbar ist, nah an deinem Start. Tippe unten, um ihn auf der Karte zu setzen:",
  venueConciergeBtnLocation: "📍 Standort senden",
  venueConciergeBtnMap: "🗺️ Auf Karte wählen",
  venueLocationFirst:
    "Zuerst das Wichtigste - *markiere, von wo du losfährst* 📍 Tippe unten, um den Punkt auf der Karte zu setzen. Nach dem Vibe frage ich gleich danach.",
  venueVibeNoted: "Vibe notiert ✨ Jetzt wähle, von wo du kommst:",
  venueLocationNoted:
    "Startpunkt gespeichert ✨ Jetzt - welchen *Vibe* willst du? z. B. _ruhiges Cafe_, _veganer Brunch_, _Parkspaziergang_, _kleines Museum_.",
  venueSafetyOverride: "Heads up - ich habe stattdessen ein öffentliches Cafe gewählt. Erste Dates bleiben bei uns öffentlich.",
  venueWaitingPeer: "Deins ist da ✨ Wir warten auf sie...",
  venueSearching: "🔍 Suche euren Treffpunkt…",
  venueSearchStep2: "📍 Vergleiche eure Routen…",
  venueSearchStep3: "✨ Wähle nach eurer Stimmung…",
  dateCardStep1: "📋 Bestätige eure Date-Details…",
  dateCardStep2: "🎨 Erstelle eure Date-Karte…",
  dateCardStep3: "✨ Der letzte Schliff…",
  dateCardShareStep1: "✨ Bereite deine teilbare Karte vor…",
  dateCardShareStep2: "💫 Mache das Gesicht deines Matches unkenntlich…",
  dateCardShareStep3: "⭐ Verfeinere das Foto…",
  dateCardShareStep4: "🌠 Fast fertig…",
  onbAnalyzeStep1: "🧠 Lese deinen Kontext…",
  onbAnalyzeStep1b: "💭 Denke nach…",
  onbAnalyzeStep2: "🧩 Erfasse deine Kernzüge…",
  onbAnalyzeStep3: "🧮 Erstelle dein Profil…",
  verifyAnalyzeStep1: "🔍 Gleiche dein Selfie ab…",
  verifyAnalyzeStep2: "🧬 Lese Gesichtszüge…",
  verifyAnalyzeStep3: "⏳ Schließe die Prüfung ab…",
  videoCheckStep1: "🎬 Ich sehe dein Video durch…",
  videoCheckStep2: "🙂 Prüfe, ob du das bist…",
  videoCheckStep3: "✨ Fast fertig…",
  skipAnalyzeStep1: "✨ Verfeinere dein Profil…",
  skipAnalyzeStep2: "🧮 Füge alles zusammen…",
  skipAnalyzeStep3: "💞 Bereite dich aufs Matching vor…",
  profilerBatchThinking: "💭 Denke nach…",
  profilerBatchSaving: "🧩 Speichere deine Antworten…",
  profilerBatchSaved:
    "Präferenzkarte aktualisiert ✨ Ich nutze sie beim nächsten Match.",
  profilerNextAck: "✍️ Notiert…",
  profilerNextFormulating: "💭 Denke nach…",

  // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
  venueChangeButton: "📍 Ort ändern",
  venueBoardPingFromF: "{name} schaut sich nach einem gemütlicheren Ort für euer Date um 👀",
  venueBoardPingFromM: "{name} schlägt vor, ein paar andere Orte für euer Date anzusehen 👀",
  venueBoardPingBtn: "Ansehen",
  venueKeepNotice: "Dein Match möchte lieber bei {venue} bleiben 👍 Du kannst unten trotzdem einen anderen Ort vorschlagen.",
  venueBothKeepDm: "Ihr bleibt beide bei {venue} — nichts ändert sich, bis dann 👍",
  venueDeclinedKeepDm: "Ihr bleibt bei {venue}, wie ursprünglich geplant 👍",
  venuePayPromptDm:
    "Ihr habt zusammen einen neuen Ort für euer Date gewählt!\n📍 {venue}\n" +
    "Sichere ihn — und wir aktualisieren eure Karten.",
  venuePayBtn: "⭐ Sichern — {stars}",
  venueWishText:
    "{name} hat einen Ort gefunden, der ihr sehr gefällt ✨\n📍 {venue}\n" +
    "Sie würde sich freuen, wenn du ihn sicherst.",
  venueWishPayBtn: "💫 Sichern — {stars} ⭐",
  venueWishDeclineBtn: "Nicht diesmal",
  venuePayDeclineAck:
    "Verstanden — der Ort bleibt vorerst wie geplant. Falls er sich ändert, bekommst du eine neue Karte.",
  venuePaySelfDm:
    "Ihr habt euch auf einen neuen Ort geeinigt!\n📍 {venue}\nSichere ihn — und wir aktualisieren eure Karten ✨",
  venuePaySelfBtn: "⭐ Sichern — {stars}",
  venueSettledCard: "Erledigt — euer Date hat einen neuen Ort! 📍 {venue}",
  venueSettledPaidByM: "{name} hat die Ortsänderung übernommen ❤️ Euer Date findet jetzt statt in 📍 {venue}",
  venueSettledPaidByF: "{name} hat die Ortsänderung übernommen ❤️ Euer Date findet jetzt statt in 📍 {venue}",
  venueExpressPartnerFromF: "{name} hat einen gemütlicheren Ort für euer Date gewählt ✨ Neuer Ort: 📍 {venue}",
  venueExpressPartnerFromM: "{name} hat einen neuen Ort für euer Date gewählt ✨ Neuer Ort: 📍 {venue}",
  venueLapsedDm: "Die Ortsänderung wurde nicht gesichert — ihr trefft euch wie geplant in {venue} 👌",
  venueKeepOriginalDm: "Dein Match bleibt beim ursprünglichen Ort — ihr trefft euch wie geplant in {venue} 👌",
  venueInvoiceTitle: "Ortsänderung",
  venueInvoiceDesc: "Neuer Date-Ort: {venue}",
  venueInvoiceLabel: "Ortsänderung",
  icebreakerIntro: "Dein Date ist in 5 Stunden! Ein paar Gesprächsstarter für dich:\n\n",
  icebreakerStreamStart: "✨ Ich stelle ein paar Gesprächsthemen für euch zusammen…",
  noMatchStreamStart: "💫 Ich gehe die Matches dieser Woche für dich durch…",
  wingmanHintIntro: "👋 Insider-Tipp - dein Date ist in 90 Minuten:\n\n",
  profilerSkip: "Überspringen",
  emergencyUnlocked:
    "Das Notfall-Storno-Fenster ist offen.\n" +
    "Wenn du wirklich nicht kannst, tippe unten.\n" +
    "*Du musst einen Grund schreiben - er wird exakt so an dein Match weitergeleitet.*",
  emergencyBtn: "🚨 Date absagen",
  emergencyConfirmPrompt:
    "Bevor du absagst, kurzer Check.\n\n" +
    "Wenn es Nervosität, eine kleine Verspätung oder Unsicherheit ist, behalte das Date. " +
    "Dein Match hat sich Zeit für dich freigehalten, und in echt kann der Abend noch überraschen.\n\n" +
    "*Sag nur ab, wenn du wirklich nicht kommen kannst; das Match lässt sich danach nicht wiederherstellen.* " +
    "Wenn du weitermachst, frage ich nach einem Grund und leite ihn Wort für Wort weiter.",
  emergencyBtnConfirm: "🔴 Ja, Date absagen",
  emergencyBtnBack: "🟢 Date behalten",
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
    "👥 **Wenn es voll ist.** Passiert - kein Ding: einen Kaffee holen und ein Stück laufen, oder in ein Café nebenan wechseln, wo was los und hell ist.\n" +
    "🚗 **Transport.** Komm selbst hin und zurück - ÖPNV, Taxi oder zu Fuß. Steig nicht bei jemandem ins Auto, den du kaum kennst.\n" +
    "📱 **Sag jemandem Bescheid.** Schick die Treffdetails an eine Freundin, einen Freund oder Familie und teile wenn möglich deinen Live-Standort.\n" +
    "☕ **Bleib aufmerksam.** Lass Sachen und Getränk möglichst nicht unbeaufsichtigt.\n" +
    "🛑 **Deine Grenzen.** Wenn du dich unwohl fühlst oder das Verhalten komisch wirkt, kannst du jederzeit gehen. Deine Sicherheit ist wichtiger als Höflichkeit.\n\n" +
    "Hab einen schönen Abend ✨",
  statusDaysHours: "⏳ Nächstes Match in {d}T {h}Std",
  statusHoursMinutes: "⏳ Matches droppen in {h}Std {m}Min",
  statusMinutes: "✨ Fast bereit! Matches droppen in {m} Min",
  statusProcessing: "✨ Analysiere deine Stadt... Schau später nochmal rein.",

  // --- My date (menu row + hub) + scheduled-date banner ---
  statusDateDaysHours: "💫 Date in {d}T {h}Std",
  statusDateHoursMinutes: "💫 Date in {h}Std {m}Min",
  statusDateMinutes: "💫 Date in {m} Min",
  statusDateSoon: "💫 Date ist heute ✨",
  menuMyDateDays: "💫 Mein Date · in {d}T {h}Std",
  menuMyDateHours: "💫 Mein Date · in {h}Std {m}Min",
  menuMyDateMinutes: "💫 Mein Date · in {m} Min",
  menuMyDateSoon: "💫 Mein Date · heute ✨",
  menuMyDatePlanning: "⏳ Date wird geplant",
  dateHubNoActive: "Du hast gerade kein geplantes Date.",
  dateHubHeaderScheduled: "💫 Dein Date mit {name}",
  dateHubPlanningProposed:
    "Du hast ein Match mit {name}. Sieh dir oben den Pitch an — und sag mir einfach, ob du gehen möchtest.",
  dateHubPlanningNegotiating: "Du hast ein Match mit {name}! Wähle eine passende Zeit:",
  dateHubPlanningVenue:
    "Fast geschafft mit {name}. Markiere, von wo aus du losgehst:",
  voiceTranscriptionFailed: "Ich konnte das nicht klar verstehen - kannst du es tippen?",
  voiceTooLong: "Die Sprachnachricht ist etwas lang. Maximal 5 Minuten - oder schreib es einfach.",
  rateLimitFloodNotice:
    "Wow, das sind viele Nachrichten auf einmal — gib mir ein paar Sekunden, dann geht's weiter. 🙂",
  rateLimitDailyBudgetNotice:
    "Du warst heute super aktiv 🙂 Lass uns morgen weitermachen — das heutige Limit ist erreicht, damit alles für alle rund läuft.",
};

const plTranslations: TranslationTable = {
  ...translations.en,
  consentMessage:
    "Witamy w Gennety Dating!\n\n" +
    "Zanim zaczniemy, przeczytaj Warunki usługi i Politykę prywatności oraz zaakceptuj warunki przechowywania danych.",
  consentAgree: "Akceptuję",
  consentPrivacyButton: "Polityka prywatności",
  consentTermsButton: "Warunki usługi",
  welcome: "Gennety Dating 👀\nAI matchmaking dla prawdziwych randek.",
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
  emailVerified: "E-mail potwierdzony ✨",
  contextDumpAck: "Przyjęte ✨ Przetwarzam…",
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
  askPhotos:
    "Prawie gotowe! Wyślij {min}-{max} różnych zdjęć. Na każdym musisz być wyraźnie widoczny; treści erotyczne są niedozwolone. Wideo profilowe może pokazywać znajomych lub krajobrazy, ale musisz pojawić się wyraźnie w kilku momentach.",
  photoReceived: "Zdjęcie {n}/{max} ✨",
  photoRejected:
    "Na zdjęciu musi być widoczna Twoja twarz. Spróbuj innego ujęcia.",
  photoDuplicate:
    "To zdjęcie jest już w Twoim profilu. Dodaj inne ujęcie - wszystkie zdjęcia muszą być unikalne.",
  photoDuplicateNear:
    "To zdjęcie jest już w Twoim profilu. Dodaj inne ujęcie - wszystkie zdjęcia muszą być unikalne.",
  photoUnsafeContent:
    "Tego zdjęcia nie można opublikować w profilu. Wybierz inne zdjęcie bez treści erotycznych.",
  photoFaceObscured:
    "Twarz jest słabo widoczna. Zdejmij okulary przeciwsłoneczne lub maskę i wyślij wyraźniejsze zdjęcie.",
  photoMultipleFaces:
    "Na zdjęciu musi być widoczna Twoja twarz. Spróbuj innego ujęcia.",
  photoIdentityMismatch:
    "Wszystkie zdjęcia muszą należeć do jednej osoby. Upewnij się, że Twoja twarz jest na każdym ujęciu.",
  photoIdentityUncertain:
    "Nie udało się wiarygodnie dopasować twarzy. Wyślij wyraźniejsze zdjęcie z lepszym światłem i dobrze widoczną twarzą.",
  photoConsensusPending:
    "Nie ustaliłem jeszcze tożsamości profilu. Wyślij jeszcze jedno inne zdjęcie, na którym widać tę samą osobę.",
  photoConsensusOutlierRejected:
    "Jedno oczekujące zdjęcie pokazywało inną osobę, więc go nie dodałem.",
  photoConsensusConfirmed:
    "Tożsamość potwierdzona przez pasujące zdjęcia ✨",
  photoConsensusNoPairCap:
    "Nadal nie widzę dwóch zdjęć tej samej osoby. Nic nie zostało jeszcze ustalone - wyślij kolejne wyraźne zdjęcie siebie.",
  photoVisionError: "Nie udało się przetworzyć pliku. Spróbuj ponownie.",
  photoInvalidMedia:
    "Ten plik nie jest obsługiwanym zdjęciem. Wyślij obraz JPEG, PNG, WebP lub HEIC.",
  photosEnough: "Możesz wysłać więcej (do {max}) albo kliknąć przycisk, żeby iść dalej.",
  photosDone: "Zdjęcia przesłane ✨",
  profileReview:
    "Oto Twój profil:\n\n" +
    "*{firstName} {surname}*, {age}\n" +
    "🎓 {university}\n\n" +
    "{summary}\n\n" +
    "Wygląda dobrze?",
  profileConfirm: "Wygląda dobrze ✨",
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
  verifyPitchTicket:
    "Ostatni krok: potwierdź, że ten profil naprawdę należy do Ciebie.\n\n" +
    "Porównamy selfie weryfikacyjne ze zdjęciami profilowymi. Ukończ sprawdzenie i odbierz *1 darmowy bilet na randkę*.\n\n" +
    "Jeśli pominiesz, zrezygnujesz z biletu, stracisz {penalty} startowych punktów ELO i zmniejszysz szanse na dobre dopasowanie.",
  verifyPitchMandatory:
    "Ostatni krok. Potwierdzamy, że każdy uczestnik to prawdziwa osoba.\n\n" +
    "Porównamy selfie z weryfikacji z każdym zdjęciem w Twoim profilu — " +
    "zdjęcia, które nie pasują do Ciebie, zostaną odrzucone.\n\n" +
    "Weryfikacja jest obowiązkowa: dobieranie par zacznie się zaraz po jej zaliczeniu.",
  verifyPitchMandatoryTicket:
    "Ostatni krok: potwierdź, że ten profil naprawdę należy do Ciebie.\n\n" +
    "Porównamy selfie weryfikacyjne ze zdjęciami profilowymi, a za zaliczenie otrzymasz *1 darmowy bilet na randkę*.\n\n" +
    "Weryfikacja jest obowiązkowa: dobieranie par zacznie się zaraz po jej zaliczeniu.",
  verifyMandatoryNotice:
    "Weryfikacja jest teraz obowiązkowa dla wszystkich nowych profili — dobieranie par zacznie się zaraz po jej zaliczeniu. Zajmie to około minuty:",
  verifyReminderNudge:
    "Twój profil jest gotowy — został tylko krok weryfikacji. Zajmie to około minuty, a dobieranie par zacznie się zaraz potem:",
  verifyBtnGo: "🟢 Zweryfikuj teraz",
  verifyBtnCheck: "✨ Zakończyłem/am weryfikację",
  verifyBtnSkip: "⚪️ Pomiń na razie",
  verifySkipNudgeCaption:
    "Chwila — posłuchaj tego, zanim pominiesz 👆",
  verifySkipNudgeCaptionTicket:
    "Zanim zrezygnujesz: pominięcie kosztuje darmowy bilet, {penalty} punktów ELO i część priorytetu dopasowań. Najpierw posłuchaj 👆",
  verifyBtnReconsider: "🟢 Dobra, zweryfikuję się",
  verifyBtnSkipConfirm: "🔴 Pomiń mimo to",
  verifyBtnSkipConfirmTicket: "🔴 Zrezygnuj z bonusu i pomiń",
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
    "Zweryfikowane ✨ Profil aktywny. Odezwę się, gdy znajdę dopasowanie.",
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
    "Wideo do profilu może ważyć maksymalnie {mb} MB. Wyślij mniejsze.",
  videoChecking:
    "Sprawdzam bezpieczeństwo wideo i szukam Twojej twarzy w kilku momentach...",
  videoUnsafeContent:
    "To wideo zawiera treści, których nie można opublikować w profilu. Wybierz inny klip.",
  videoOwnerMissing:
    "W wideo Twoja twarz musi być w kadrze przez większość czasu. Nagraj nowe wideo.",
  videoOwnerTooBrief:
    "Twoja twarz pojawia się zbyt krótko albo tylko w jednym momencie. Wybierz klip, na którym dobrze Cię widać w kilku oddzielnych momentach.",
  videoIdentityMismatch:
    "Wideo musi należeć do tej samej osoby co zdjęcia w profilu.",
  videoMostlyOtherPerson:
    "To wideo pokazuje głównie inną osobę. Wybierz klip, na którym dobrze Cię widać w kilku momentach.",
  videoNeedsPhotoFirst:
    "Najpierw wyślij co najmniej jedno wyraźne zdjęcie profilowe. Potem sprawdzę, czy jesteś widoczny w wideo.",
  videoProcessingUnavailable:
    "Nie udało się teraz sprawdzić wideo. Poprzednie wideo nie zostało zmienione. Spróbuj ponownie za chwilę.",
  ticketRewardPhoto:
    "🎟️ Świetnie — właśnie zdobyłeś *darmowy bilet na randkę*!\n\nJak to działa: każda randka kosztuje 1 bilet, a bilety zwykle są płatne. Za dodane zdjęcia masz jeden gratis. Saldo: *{balance}* 🎟️",
  ticketRewardVideo:
    "🎟️ Wideo w profilu — super! Oto kolejny *darmowy bilet na randkę*.\n\nKażda randka kosztuje 1 bilet (zwykle płatny). Saldo: *{balance}* 🎟️",
  ticketRewardVerification:
    "🎟️ Weryfikacja zakończona — *darmowy bilet na randkę* jest już na koncie.\n\nPokrywa jedną randkę. Saldo: *{balance}* 🎟️",
  ticketRewardStudent:
    "🎓 E-mail uczelniany potwierdzony — bonus studencki: *2 darmowe bilety na randki* są już w Twoim portfelu.\n\nKażda randka kosztuje 1 bilet, więc pierwsze dwie randki są na nasz koszt. Saldo: *{balance}* 🎟️",
  welcomeGiftTicket:
    "🎟 Twój pierwszy bilet — ode mnie osobiście.\n\nKażda randka kosztuje tu 1 bilet, zwykle ~$6.99\nTen jest za darmo — niech pierwszy krok będzie o człowieku, a nie o cenie\n\nBilet jest już w Twoim portfelu ❤️",
  ticketStorePurchased:
    "✨ Płatność otrzymana — dodano *{count}* 🎟️!\n\nSaldo: *{balance}* 🎟️",
  ticketStoreCheckoutError: "Nie udało się potwierdzić płatności. Spróbuj ponownie.",
  ticketStoreInvoiceTitle: "Bilety Gennety",
  ticketStoreInvoiceDesc:
    "{count} bilet(ów) dodanych do portfela. Każdy bilet pokrywa jedną randkę.",
  ticketGateInvoiceDesc:
    "Zabezpieczenie randki — {count} bilet(y/ów). Jeden bilet na jedną osobę.",
  ticketStoreInvoiceLabel: "Bilety Gennety × {count}",
  onboardingPhotosNeedMore:
    "Postęp zdjęć: {count}/{min}. Pozostało wyraźnych zdjęć: {remaining}.",
  onboardingPhotosBonusOffer:
    "Wymagane zdjęcia są gotowe ✨\n\nDodaj zdjęcia do {threshold} (pozostało: {remaining}), aby zdobyć darmowy bilet na randkę. Za krótkie wideo profilowe otrzymasz kolejny darmowy bilet.\n\nOba bonusy są opcjonalne — wyślij media teraz albo przejdź dalej.",
  onboardingPhotosBonusOfferAfterVideo:
    "Wymagane zdjęcia są gotowe, a bonus za wideo jest już zabezpieczony ✨\n\nDodaj zdjęcia do {threshold} (pozostało: {remaining}), aby zdobyć drugi darmowy bilet, albo przejdź dalej.",
  onboardingPhotosBonusProgress:
    "{count}/{threshold} zdjęć ✨ Jeszcze jedno odblokuje darmowy bilet na randkę. Wyślij je teraz albo przejdź dalej.",
  onboardingPhotosBonusProgressAfterVideo:
    "{count}/{threshold} zdjęć ✨ Jeszcze jedno odblokuje drugi darmowy bilet. Wyślij je teraz albo przejdź dalej.",
  onboardingPhotosPhotoBonusEarned:
    "Masz {count} zdjęć, a darmowy bilet za zdjęcia jest już zabezpieczony ✨\n\nMożesz dodać zdjęcia do {max} lub krótkie wideo profilowe za kolejny darmowy bilet. Albo przejdź dalej.",
  onboardingPhotosBothBonusesEarned:
    "Masz {count} zdjęć i wideo profilowe — oba darmowe bilety są zabezpieczone ✨\n\nMożesz dodać zdjęcia do {max} albo przejść dalej.",
  onboardingPhotosPhotoBonusEarnedMax:
    "Wszystkie {max} zdjęć są gotowe, a darmowy bilet za zdjęcia jest zabezpieczony ✨\n\nMożesz wysłać krótkie wideo profilowe za kolejny darmowy bilet albo przejść dalej.",
  onboardingPhotosBothBonusesEarnedMax:
    "Wszystkie {max} zdjęć i wideo profilowe są gotowe — oba darmowe bilety są zabezpieczone ✨\n\nPrzejdź dalej, gdy będziesz gotowy.",
  onboardingPhotosOptional:
    "Wymagane zdjęcia są gotowe ✨\n\nMożesz dodać więcej zdjęć do {max}, wysłać krótkie wideo profilowe albo przejść dalej.",
  onboardingPhotosOptionalAfterVideo:
    "Wymagane zdjęcia i wideo profilowe są gotowe ✨\n\nMożesz dodać więcej zdjęć do {max} albo przejść dalej.",
  onboardingPhotosOptionalMax:
    "Wszystkie {max} zdjęć są gotowe ✨\n\nMożesz wysłać krótkie wideo profilowe albo przejść dalej.",
  onboardingPhotosOptionalMaxAfterVideo:
    "Wszystkie {max} zdjęć i wideo profilowe są gotowe ✨\n\nPrzejdź dalej, gdy będziesz gotowy.",
  ticketWalletText:
    "🎟️ *Moje bilety*\n\nMasz *{balance}* bilet(ów). Każda randka kosztuje 1 bilet — dokupisz w każdej chwili.",
  ticketWalletOpenStore: "🎟️ Kup bilety",
  menuBack: "⬅️ Wstecz",
  myProfileBody:
    "*{firstName} {surname}*, {age}\n" +
    "{occupationLine}" +
    "{universityLine}" +
    "🌐 {language}\n\n" +
    "{summary}",
  myProfileNoBio: "_Brak bio._",
  myProfilePreviewHeader: "Tak widzi Cię Twoja para 👇",
  myProfileEditLabel: "✏️ Co zmienić:",
  editProfileBody:
    "Te dane są zablokowane:\n\n" +
    "• *Imię i nazwisko:* {firstName} {surname}\n" +
    "• *Wiek:* {age}\n" +
    "• *Uniwersytet:* {university}\n\n" +
    "Możesz edytować:",
  editBioBtn: "📝 O mnie",
  editPrefsBtn: "💘 Kogo szukam",
  editMajorBtn: "💼 Czym się zajmujesz",
  editProfilePhotosBtn: "📸 Moje zdjęcia",
  editBioPrompt:
    "Napisz kilka słów o sobie (maks. 500 znaków).\n👀 Twoja para czyta to przed randką.",
  editBioTooLong: "Za długie - zmieść się w 500 znakach.",
  editBioSaved: "„O mnie” zaktualizowane ✨",
  editMajorPrompt:
    "Czym się zajmujesz? (praca / studia / branża, maks. 100 znaków)\n👀 Widoczne dla Twojej pary.",
  editMajorTooLong: "Za długie - zmieść się w 100 znakach.",
  editMajorSaved: "Zapisano ✨",
  editPrefsTitle: "💘 *Kogo szukam*\n\n👀 Wpływa na to, kto Ci się trafi. Co zmienić?",
  editPrefsAgeBtn: "🎂 Wiek partnera",
  editPrefsBack: "⬅️ Wróć do edycji",
  editAgeRangePrompt: "W jakim przedziale wiekowym mamy szukać dla Ciebie partnera? (np. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Nie łapię. Podaj dwie liczby, np. 20-28 (zakres {min}-{max}).",
  editAgeRangeSaved: "Zakres wieku zaktualizowany ✨",
  editProfilePhotosStart: "Wyślij nowe zdjęcia ({min}-{max}). Po jednym.",
  editProfilePhotosSaved: "Zdjęcia zaktualizowane ✨",
  photoManagerTitle:
    "Twoje zdjęcia. Usuń niechciane lub dodaj nowe (min {min}, maks {max}).",
  photoManagerDeleteBtn: "🗑 {n}",
  photoManagerAddBtn: "➕ Dodaj",
  photoManagerDoneBtn: "✅ Gotowe",
  photoManagerMinReached: "Potrzebujesz co najmniej {min} zdjęć. Najpierw dodaj nowe.",
  photoManagerDeleted: "Zdjęcie usunięte.",
  menuVideo: "🎬 Wideo profilu",
  editVideoPrompt:
    "🎬 Wyślij krótkie wideo do profilu (do {sec} s, maks. {mb} MB). Znajomi, krajobraz czy klip z imprezy — wszystko pasuje, wideo ożywia profil.",
  editVideoRewardLine: "🎁 Dodaj je teraz i zdobądź darmowy bilet na randkę.",
  editVideoHasOne:
    "Masz już wideo w profilu. Wyślij nowe, aby je zastąpić, albo usuń je przyciskiem poniżej.",
  editVideoRemoveBtn: "🗑 Usuń wideo",
  editVideoRemoved: "Wideo z profilu usunięte.",
  editVideoNotAVideo: "Wyślij proszę *wideo* (do {sec} s, maks. {mb} MB).",
  myProfileAddVideoHint:
    "🎬 Wskazówka: dodaj krótkie wideo do profilu z menu — dzięki temu profil bardziej się wyróżnia.",
  myProfileAddVideoHintReward:
    "🎬 Wskazówka: dodaj krótkie wideo do profilu z menu i zdobądź darmowy bilet 🎁.",
  pauseConfirmed: "Matching wstrzymany ⏸\nNie będzie nowych dopasowań, dopóki go nie wznowisz.",
  resumeConfirmed: "Matching znowu działa ▶️\nNasza AI już pracuje.",
  settingsTitle: "⚙️ Ustawienia",
  settingsLanguage: "🌐 Język",
  settingsLanguagePick: "Wybierz język:",
  settingsLanguageSaved: "Język zaktualizowany ✨",
  settingsTheme: "🎨 Motyw",
  settingsThemePick: "Wybierz wygląd:",
  settingsThemeSaved: "Motyw zaktualizowany ✨",
  themeDarkOption: "🌙 Ciemny",
  themeLightOption: "☀️ Jasny",
  settingsVerify: "🛡 Zweryfikuj konto",
  settingsVerifyNotNeeded: "Masz już weryfikację ✨",
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
  deleteFreezeIntro:
    "Zaczekaj — zanim wszystko usuniesz 👀\n\n" +
    "Nie musisz tracić wszystkiego. Lepiej *zamroź* konto: profil, zdjęcia i weryfikacja " +
    "zostają, znikasz z dopasowywania, a następnym razem wystarczy wysłać /start, by wrócić " +
    "prosto do swojego gotowego profilu — bez ponownego onboardingu.\n\n" +
    "Nadal chcesz usunąć? Tego nie da się cofnąć.",
  deleteFreezeBtn: "❄️ Zamroź konto",
  deleteProceedBtn: "Mimo to usuń konto",
  freezeConfirmed:
    "Gotowe — Twoje konto jest *zamrożone* ❄️\n\n" +
    "Nie widać Cię w dopasowywaniu i nie będę pisać. " +
    "Wróć kiedy chcesz przez /start — wszystko czeka na swoim miejscu.",
  freezeWelcomeBack:
    "Witaj z powrotem! ❄️ → ☀️ Twoje konto jest *odmrożone* i znów aktywne. " +
    "Oto Twój profil:",
  deleteFinalYes: "Tak, jestem pewien na 100%",
  deleteFinalNoSoft: "Nie",
  deleteFinalNoHard: "O Boże, nie",
  freezePartnerNotice:
    "Ważne — Twoje dopasowanie nie jest już dostępne, więc ta randka się nie odbędzie. " +
    "Spokojnie: w następnej turze masz priorytet 💛",
  matchHeadline: "💘 Znaleźliśmy dla Ciebie dopasowanie!",
  matchDeadlineNotice:
    "Masz 24h na odpowiedź. " +
    "Gdy klikniesz, *decyzja jest ostateczna*. Bez cofania.",
  matchStreamStart: "✨ Czemu do siebie pasujecie…",
  matchBtnAccept: "✨ Akceptuj",
  matchBtnDecline: "❌ Odpuść",
  matchDeclineConfirmPrompt:
    "Na pewno odpuszczasz?\n\n" +
    "Ta decyzja jest ostateczna — tej osoby już więcej nie zobaczysz. " +
    "Kliknij, aby potwierdzić, albo wróć.",
  matchBtnConfirmDecline: "❌ Tak, odpuść",
  matchBtnKeepDeciding: "← Wróć",
  matchDecisionQuestionM:
    "No i jak — chcesz iść z nim na randkę? 😊 Po prostu odpowiedz mi tutaj własnymi słowami.",
  matchDecisionQuestionF:
    "No i jak — chcesz iść z nią na randkę? 😊 Po prostu odpowiedz mi tutaj własnymi słowami.",
  matchTextYesConfirm: "Świetnie ✨ Potwierdź poniżej — resztą zajmę się ja:",
  matchBtnConfirmGo: "💫 Tak, idę na randkę",
  matchTextUnsure:
    "Bez pośpiechu — gdy zdecydujesz, napisz mi po prostu „tak” albo „nie”.",
  matchDeclineDismissed:
    "Bez pośpiechu — to dopasowanie wciąż czeka na Twoją odpowiedź. 💛",
  matchAcceptedToast: "Przyjęte ✨",
  matchDecisionSavedToast: "Zapisane ✨",
  matchAccepted: "Przyjęte ✨ Czekamy na drugą osobę.",
  matchBothAccepted: "Wzajemne 🤍 Znajdźmy termin.",
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
    "Jak teraz wygląda sytuacja:\n" +
    "• Szybko rozwijamy społeczność i codziennie dopracowujemy algorytm.\n" +
    "• Naprawdę pasująca osoba powinna pojawić się w jednym z kolejnych dropów.\n" +
    "• Każdy tydzień oczekiwania podnosi Twój priorytet w kolejnym dropie.\n\n" +
    "Do zobaczenia w następny czwartek o 18:00 ✨",
  noMatchThisWeekTier2:
    "Hej 🌿\n\n" +
    "Drugi tydzień z rzędu nasz matchmaker nadal nie znalazł osoby, którą naprawdę chcielibyśmy Ci przedstawić. " +
    "Dzięki za cierpliwość - to dla nas ważne.\n\n" +
    "Co chcemy, żebyś wiedział(a):\n" +
    "• Aktywnie sprowadzamy więcej osób podobnych do Ciebie i stroimy algorytm pod Twoją korzyść.\n" +
    "• Naprawdę świetna osoba powinna być już tylko kilka dropów stąd.\n" +
    "• Twój priorytet w kolejnym dropie jest już podniesiony za czas oczekiwania.\n\n" +
    "Do czwartku o 18:00 - pracujemy dla Ciebie 🤍",
  noMatchThisWeekTier3:
    "Hej ✨\n\n" +
    "Należy Ci się kolejne szczere info - nadal nie ma osoby, która naprawdę byłaby warta Twojego czasu. " +
    "Nas też to frustruje i nie będziemy udawać inaczej.\n\n" +
    "Co dzieje się po naszej stronie:\n" +
    "• Osobiście obserwujemy Twoją kolejkę i rozwijamy społeczność w Twojej okolicy.\n" +
    "• Właściwa osoba trafi do jednego z kolejnych dropów - nie przestaniemy, dopóki się nie uda.\n" +
    "• Co tydzień oczekiwania podnosimy Cię wyżej w priorytecie kolejnego dropu.\n\n" +
    "Dzięki za zaufanie. Do czwartku o 18:00 🤍",
  noMatchDiscountOffer:
    "🎟️ Małe podziękowanie za cierpliwość: Twoja następna pierwsza randka z rabatem {pct}% na jeden bilet. " +
    "Zastosujemy rabat automatycznie, gdy trafi Ci się para lub otworzysz swoje bilety.",
  matchScheduleProposal: "Co powiesz na jedną z tych opcji? Kliknij, co pasuje:",
  matchScheduleIter3:
    "Wzajemnie ✨ Otwórz kalendarz i zaznacz pasujące godziny.",
  matchScheduleAfterTicket:
    "📅 Teraz wybierz czas — otwórz kalendarz i zaznacz wszystkie pasujące terminy.",
  matchScheduleBtnCalendar: "📅 Otwórz kalendarz",
  ticketCardCaption:
    "Wzajemnie ✨ Odbierz *bilet na randkę*, żeby otworzyć planowanie.",
  ticketButton: "🎟️ Odbierz bilet na randkę",
  ticketViewButton: "🎟️ Zobacz swój bilet na randkę",
  ticketStatusButton: "Otwórz randkę",
  ticketGateWaiting: "Bilet gotowy ✨ Czekamy na drugą osobę.",
  matchScheduleNoOverlap: "Jeszcze brak wspólnego terminu - kolejna runda.",
  matchScheduled: "Ustalone — do zobaczenia 🤝\n\n{venue}",
  matchScheduledNoReservation:
    "🍵 W godzinach szczytu może być pełno - nic się nie stanie: można wziąć kawę na wynos i się przejść albo wpaść do innego miłego miejsca obok.",
  matchScheduledBtnOpenMaps: "📍 Otwórz w Mapach",
  matchScheduledBtnShare: "📤 Udostępnij kartę",
  dateCardWhen: "KIEDY",
  dateCardSlogan: "Error 404:\nChat not found.\nTry real life.",
  dateCardShareCaption:
    "Udostępniaj śmiało — twarz Twojego matcha jest zasłonięta dla ochrony jego prywatności 💞",
  dateCardShareFailed:
    "Nie udało się przygotować karty do udostępnienia — spróbuj za chwilę.",
  matchSchedulePickedPrefix: "Wybrałeś/wybrałaś: ",
  matchScheduleWaitingPeer: "Czekamy na drugą osobę...",
  matchSchedulePeerProposed:
    "Twoje dopasowanie zaznaczyło daty i godziny w kalendarzu. Otwórz go, żeby potwierdzić jedną albo zaproponować własną:",
  matchSchedulePeerSuggestedAlternative:
    "Twoje dopasowanie zaproponowało inny termin. Sprawdź odpowiedź: możesz się zgodzić albo zaproponować swój.",
  matchScheduleSavedConfirmation:
    "✨ Zapisaliśmy Twoje daty i godziny. Daliśmy znać dopasowaniu - odezwę się, gdy odpowiedzą.",
  matchScheduleNoOverlapYet:
    "Oboje zaznaczyliście daty i godziny, ale jeszcze nic się nie pokrywa. Otwórz kalendarz i dodaj kilka opcji - ustalimy randkę, gdy tylko slot się zgodzi:",
  venueConciergeIntro:
    "Termin ustalony 🗓️ Jedna rzecz, zanim znajdę miejsce.\n\n" +
    "📍 *Zaznacz, skąd będziesz wyruszać* na randkę - twój dom, stacja metra, mieszkanie znajomego, skądkolwiek faktycznie ruszasz.\n\n" +
    "Na podstawie tego punktu znajdę wygodne miejsce spotkania, łatwo dostępne dla *was obojga*, blisko twojego startu. Kliknij poniżej, aby zaznaczyć je na mapie:",
  venueConciergeBtnLocation: "📍 Wyślij lokalizację",
  venueConciergeBtnMap: "🗺️ Wybierz na mapie",
  venueLocationFirst:
    "Najpierw najważniejsze - *zaznacz, skąd będziesz wyruszać* 📍 Kliknij poniżej, aby zaznaczyć punkt na mapie. O vibe zapytam zaraz potem.",
  venueVibeNoted: "Vibe zapisany ✨ Teraz wybierz, skąd będziesz jechać:",
  venueLocationNoted:
    "Punkt startowy zapisany ✨ Teraz - jaki *vibe* chcesz? np. _cicha kawiarnia_, _wegański brunch_, _spacer po parku_, _małe muzeum_.",
  venueSafetyOverride: "Heads up - wybraliśmy publiczną kawiarnię. Pierwsze randki trzymamy w publicznych miejscach.",
  venueWaitingPeer: "Twoje zapisane ✨ Czekamy na nich...",
  venueSearching: "🔍 Szukam miejsca dla Was…",
  venueSearchStep2: "📍 Porównuję wasze trasy…",
  venueSearchStep3: "✨ Dobieram pod waszą atmosferę…",
  dateCardStep1: "📋 Potwierdzam szczegóły randki…",
  dateCardStep2: "🎨 Składam waszą kartę randki…",
  dateCardStep3: "✨ Dodaję ostatnie szlify…",
  dateCardShareStep1: "✨ Przygotowuję kartę do udostępnienia…",
  dateCardShareStep2: "💫 Rozmywam twarz twojego matcha…",
  dateCardShareStep3: "⭐ Dopracowuję zdjęcie…",
  dateCardShareStep4: "🌠 Prawie gotowe…",
  onbAnalyzeStep1: "🧠 Czytam twój kontekst…",
  onbAnalyzeStep1b: "💭 Myślę…",
  onbAnalyzeStep2: "🧩 Wyodrębniam kluczowe cechy…",
  onbAnalyzeStep3: "🧮 Buduję twój profil…",
  verifyAnalyzeStep1: "🔍 Porównuję twoje selfie…",
  verifyAnalyzeStep2: "🧬 Analizuję rysy twarzy…",
  verifyAnalyzeStep3: "⏳ Kończę weryfikację…",
  videoCheckStep1: "🎬 Przeglądam twój film…",
  videoCheckStep2: "🙂 Sprawdzam, czy to ty…",
  videoCheckStep3: "✨ Prawie gotowe…",
  skipAnalyzeStep1: "✨ Dopracowuję twój profil…",
  skipAnalyzeStep2: "🧮 Składam wszystko w całość…",
  skipAnalyzeStep3: "💞 Przygotowuję cię do doboru…",
  profilerBatchThinking: "💭 Myślę…",
  profilerBatchSaving: "🧩 Zapisuję twoje odpowiedzi…",
  profilerBatchSaved:
    "Karta preferencji zaktualizowana ✨ Uwzględnię ją przy następnym doborze.",
  profilerNextAck: "✍️ Zapisane…",
  profilerNextFormulating: "💭 Myślę…",

  // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
  venueChangeButton: "📍 Zmień miejsce",
  venueBoardPingFromF: "{name} rozgląda się za przytulniejszym miejscem na waszą randkę 👀",
  venueBoardPingFromM: "{name} proponuje spojrzeć na kilka innych miejsc na waszą randkę 👀",
  venueBoardPingBtn: "Zobacz",
  venueKeepNotice: "Twoja para wolałaby zostać w {venue} 👍 Możesz zaproponować inne miejsce poniżej.",
  venueBothKeepDm: "Oboje zostajecie w {venue} — nic się nie zmienia, do zobaczenia 👍",
  venueDeclinedKeepDm: "Zostajecie w {venue}, zgodnie z pierwotnym planem 👍",
  venuePayPromptDm:
    "Razem wybraliście nowe miejsce na randkę!\n📍 {venue}\n" +
    "Zatwierdź je — a my zaktualizujemy wasze karty.",
  venuePayBtn: "⭐ Zatwierdź — {stars}",
  venueWishText:
    "{name} znalazła miejsce, które bardzo jej się podoba ✨\n📍 {venue}\n" +
    "Będzie jej miło, jeśli to Ty je zatwierdzisz.",
  venueWishPayBtn: "💫 Zatwierdź — {stars} ⭐",
  venueWishDeclineBtn: "Nie tym razem",
  venuePayDeclineAck:
    "Rozumiem — miejsce na razie zostaje bez zmian. Jeśli się zmieni, dostaniesz nową kartę.",
  venuePaySelfDm:
    "Zgodziliście się na nowe miejsce!\n📍 {venue}\nZatwierdź je — a my zaktualizujemy wasze karty ✨",
  venuePaySelfBtn: "⭐ Zatwierdź — {stars}",
  venueSettledCard: "Gotowe — wasza randka ma nowe miejsce! 📍 {venue}",
  venueSettledPaidByM: "{name} opłacił zmianę miejsca ❤️ Wasza randka odbędzie się w 📍 {venue}",
  venueSettledPaidByF: "{name} opłaciła zmianę miejsca ❤️ Wasza randka odbędzie się w 📍 {venue}",
  venueExpressPartnerFromF: "{name} wybrała dla was przytulniejsze miejsce ✨ Nowe miejsce: 📍 {venue}",
  venueExpressPartnerFromM: "{name} wybrał dla was nowe miejsce ✨ Nowe miejsce: 📍 {venue}",
  venueLapsedDm: "Zmiana miejsca nie została zatwierdzona — spotykacie się w {venue}, jak planowano 👌",
  venueKeepOriginalDm: "Twoja para zostaje przy pierwotnym miejscu — spotykacie się w {venue}, jak planowano 👌",
  venueInvoiceTitle: "Zmiana miejsca randki",
  venueInvoiceDesc: "Nowe miejsce randki: {venue}",
  venueInvoiceLabel: "Zmiana miejsca",
  icebreakerIntro: "Twoja randka jest za 5 godzin! Kilka tematów na start:\n\n",
  icebreakerStreamStart: "✨ Dobieram kilka tematów do rozmowy dla was…",
  noMatchStreamStart: "💫 Przeglądam dla ciebie tegotygodniowe dopasowania…",
  wingmanHintIntro: "👋 Wskazówka od środka - randka jest za 90 minut:\n\n",
  profilerSkip: "Pomiń",
  emergencyUnlocked:
    "Okno awaryjnego odwołania jest otwarte.\n" +
    "Jeśli naprawdę nie możesz przyjść, kliknij poniżej.\n" +
    "*Musisz napisać powód - przekażemy go dopasowaniu dokładnie tak, jak go napiszesz.*",
  emergencyBtn: "🚨 Odwołaj randkę",
  emergencyConfirmPrompt:
    "Zanim odwołasz, krótki check.\n\n" +
    "Jeśli to stres, małe spóźnienie albo niepewność, zostaw randkę. " +
    "Twoje dopasowanie zarezerwowało czas dla Ciebie, a spotkanie na żywo nadal może pozytywnie zaskoczyć.\n\n" +
    "*Odwołuj tylko, jeśli naprawdę nie możesz przyjść; potem nie da się przywrócić dopasowania.* " +
    "Jeśli przejdziesz dalej, poproszę o powód i przekażę go słowo w słowo.",
  emergencyBtnConfirm: "🔴 Tak, odwołaj randkę",
  emergencyBtnBack: "🟢 Zostaw randkę",
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
    "👥 **Jeśli jest tłok.** Zdarza się - spokojnie: weź kawę i przejdź się albo przenieś do kawiarni obok, gdzie jest ruch i jasno.\n" +
    "🚗 **Transport.** Dojedź i wróć samodzielnie - komunikacją, taksówką albo pieszo. Nie wsiadaj do auta z osobą, której prawie nie znasz.\n" +
    "📱 **Powiedz bliskim.** Prześlij szczegóły spotkania znajomej osobie albo rodzinie i jeśli możesz, udostępnij lokalizację na wieczór.\n" +
    "☕ **Uważaj.** Staraj się nie zostawiać rzeczy ani napoju bez opieki.\n" +
    "🛑 **Twoje granice.** Jeśli czujesz dyskomfort albo zachowanie drugiej osoby jest dziwne, masz pełne prawo wstać i wyjść w każdej chwili. Twoje bezpieczeństwo jest ważniejsze niż uprzejmość.\n\n" +
    "Dobrego wieczoru ✨",
  statusDaysHours: "⏳ Następne dopasowanie za {d}d {h}h",
  statusHoursMinutes: "⏳ Dopasowania wlecą za {h}h {m}min",
  statusMinutes: "✨ Prawie gotowe! Dopasowania wlecą za {m} min",
  statusProcessing: "✨ Analizujemy Twoje miasto... Zajrzyj trochę później.",

  // --- My date (menu row + hub) + scheduled-date banner ---
  statusDateDaysHours: "💫 Randka za {d}d {h}h",
  statusDateHoursMinutes: "💫 Randka za {h}h {m}min",
  statusDateMinutes: "💫 Randka za {m} min",
  statusDateSoon: "💫 Randka dzisiaj ✨",
  menuMyDateDays: "💫 Moja randka · za {d}d {h}h",
  menuMyDateHours: "💫 Moja randka · za {h}h {m}min",
  menuMyDateMinutes: "💫 Moja randka · za {m} min",
  menuMyDateSoon: "💫 Moja randka · dzisiaj ✨",
  menuMyDatePlanning: "⏳ Randka jest planowana",
  dateHubNoActive: "Nie masz teraz zaplanowanej randki.",
  dateHubHeaderScheduled: "💫 Twoja randka z {name}",
  dateHubPlanningProposed:
    "Masz dopasowanie z {name}. Sprawdź ofertę powyżej — i po prostu daj znać, czy chcesz iść.",
  dateHubPlanningNegotiating: "Masz dopasowanie z {name}! Wybierz pasujący czas:",
  dateHubPlanningVenue:
    "Prawie gotowe z {name}. Zaznacz, skąd będziesz wyruszać:",
  voiceTranscriptionFailed: "Nie usłyszałem/am wyraźnie - możesz napisać tekstem?",
  voiceTooLong: "Ta głosówka jest trochę długa. Do 5 minut albo po prostu napisz tekst.",
  rateLimitFloodNotice:
    "Oho, sporo wiadomości naraz — daj mi kilka sekund, potem ruszamy dalej. 🙂",
  rateLimitDailyBudgetNotice:
    "Dziś jesteś bardzo aktywny/a 🙂 Wróćmy do tego jutro — na dziś limit wyczerpany, żeby wszystko działało płynnie dla wszystkich.",
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
