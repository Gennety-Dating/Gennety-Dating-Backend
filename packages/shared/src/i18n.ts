import type { Language } from "./types.js";

const translations = {
  en: {
    // --- Onboarding ---
    consentMessage:
      "*Hi! This is Gennety* 👋\n\nBefore we start, read the Terms of Service and Privacy Policy and agree to the data storage rules.",
    consentAgree: "I accept",
    consentPrivacyButton: "Privacy Policy",
    consentTermsButton: "Terms of Service",
    welcome: "*Gennety Dating*\nWe find your match and set up a real-life date right away.",
    chooseLanguage: "Pick your language:",
    philosophyPitch:
      "*No texting needed here*\n\nI get to know you, find someone who fits and arrange the time and place myself. All you do is show up. Shall we?",
    philosophyContinue: "Let's go 🚀",
    askEmail: "Type your university email — for example, name@knu.ua",
    invalidEmail: "That doesn't look like a university email. Check the address and send it again.",
    otpSent: "Sent a code to *{email}*. Enter it here:",
    otpInvalid: "That code didn't work. Try again:",
    otpExpired: "The code has expired. Enter your email again and I'll send a new one.",
    otpTooManyAttempts: "Too many tries. Enter your email again for a fresh code.",
    otpCooldown: "Hold on — wait a minute before requesting a new code.",
    emailVerified: "Email confirmed ✨",
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
      "Almost done! Send {min}–{max} photos where you're clearly visible. No explicit shots. Videos work too — as long as you can be seen.",
    photoReceived: "Photo {n}/{max}",
    voicePromptSkipButton: "Without a voice note",
    /**
     * The Telegram-only pointer at the skip button, appended by
     * `sendVoicePromptAsk` — NOT part of the shared question text, which the
     * native rail serves verbatim over `/v1/onboarding/interview` and where no
     * such button exists. `{button}` is interpolated from
     * `voicePromptSkipButton` so the copy cannot name a label the keyboard
     * stopped using; a test enforces that.
     */
    voicePromptSkipHint: "To skip: “{button}”, at the bottom of the chat.",
    /** Placeholder of the voice step's bottom panel — see `services/reply-panel.ts`. */
    voicePromptPanelPlaceholder: "Hold the mic — about 15 seconds",
    /**
     * Sent for every accepted recording. The step deliberately stays open, so
     * this states BOTH ways out of it: another recording replaces this one, and
     * the panel button drops it. `{button}` is interpolated from
     * `voicePromptSkipButton` for the same reason `voicePromptSkipHint` does it.
     */
    voicePromptRecorded:
      "Got it — give it a listen. Send another one to replace it, or “{button}” to drop it.",
    /**
     * The confirmation card's only button. Deliberately "Done" rather than
     * "Keep it": the first reads as forward motion, the second as approving an
     * artefact — which is what starts the re-record spiral §4.1 names.
     */
    voicePromptReviewDone: "✅ Done",
    /** Closing line of the skip/drop exit; carries the panel teardown. */
    voicePromptSkipped: "No voice note then — that's fine.",
    voicePromptSaved: "Saved ✨ Your match will hear it before they answer.",
    voicePromptTooShort: "That was barely a second — the mic button needs holding. Try again, aim for about 15 seconds.",
    voicePromptTooLong: "A bit long — keep it under 30 seconds, otherwise it doesn't get listened to. Record another one?",
    voicePromptUnsafe: "I can't put that on a profile. Record a different one — or skip, it's optional.",
    voicePromptContactInfo: "Leave out handles and phone numbers — I'll arrange the meeting myself, that's the whole point. Record another one about you instead.",
    voicePromptUnavailable: "I couldn't process that recording. Send it again in a moment.",
    voicePromptPitchCaption: "{name} recorded this for you",
    photoRejected:
      "Your face needs to be visible in the photo. Try another shot.",
    photoDuplicate: "This photo is already in your profile — send a different one.",
    photoDuplicateNear: "This photo is already in your profile — send a different one.",
    photoUnsafeContent:
      "That photo can't be published in a profile. Pick a different, non-explicit one.",
    photoFaceObscured:
      "Your face is covered in this one. Send a shot where a mask or scarf isn't hiding it.",
    photoMultipleFaces:
      "Your face needs to be visible in the photo. Try another shot.",
    photoIdentityMismatch:
      "All photos must belong to the same person. Make sure your face is in every shot.",
    photoIdentityUncertain:
      "I couldn't match that face reliably. Try a clearer photo with better light and a more visible face.",
    photoConsensusPending: "Send one more photo — with two shots I can tell it's you on them.",
    photoConsensusOutlierRejected: "One photo shows someone else — I didn't add it.",
    photoConsensusConfirmed: "Great, it's you in every photo ✨",
    photoConsensusNoPairCap:
      "I still don't see two photos of the same person. Send one more clear photo of you.",
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
      "That video contains content that can't be published in a profile. Pick a different clip.",
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
      "I couldn't check that video right now. Your existing video was not changed. Try again in a bit.",
    ticketRewardPhoto:
      "🎟️ *A free Date Ticket is yours!*\n\nIt's a gift for your photos. One date = 1 ticket. Balance: *{balance}*",
    ticketRewardVideo:
      "🎟️ *Another free Date Ticket is yours!*\n\nIt's a gift for your video. One date = 1 ticket. Balance: *{balance}*",
    ticketRewardStudent:
      "🎓 *Two free Date Tickets are yours!*\n\nA gift for verifying your university email. One date = 1 ticket. Balance: *{balance}*",
    welcomeGiftTicket:
      "*Your first ticket is on me* ❤️\n\nA date normally costs 1 ticket (~$8.49). This one is free — it's already in your wallet.",
    ticketStorePurchased: "✨ *Payment received!* Tickets added: *{count}*. Balance: *{balance}*",
    ticketStoreCheckoutError: "Couldn't confirm that payment. Try again in a moment.",
    premiumCheckoutAlreadySubscribed:
      "You already have an active Premium subscription, so this payment was stopped — nothing was charged.",
    paymentStuckDm:
      "Your payment went through, but we couldn't hand over what you bought — something broke on our side.\n\nDon't pay again. We've already been alerted and will either deliver it or return your Stars.",
    ticketStoreInvoiceTitle: "Gennety Date Tickets",
    ticketStoreInvoiceDesc:
      "Date Tickets added to your wallet: {count}. Each ticket covers one date.",
    ticketGateInvoiceDesc: "Date payment. Date Tickets: {count}. Each ticket covers one person.",
    ticketStoreInvoiceLabel: "Date Tickets × {count}",
    onboardingFinalizeBlocked:
      "I can't finish setting you up just yet — a couple of details are still missing on my side. Give it another go in a minute; if it keeps happening, write to @gennetysupport and we'll sort it out.",
    onboardingPhotosNeedMore: "Photos: {count}/{min}. Send {remaining} more.",
    onboardingPhotosBonusOffer:
      "Required photos done ✨\n{remaining} more photos (up to {threshold}) earn a free ticket. A short video earns another.",
    onboardingPhotosBonusOfferAfterVideo:
      "Required photos done, the video ticket is yours ✨\n{remaining} more photos (up to {threshold}) earn a second free ticket.",
    onboardingPhotosBonusProgress:
      "Photos: {count}/{threshold}.\n{remaining} more and a free ticket is yours.",
    onboardingPhotosBonusProgressAfterVideo:
      "Photos: {count}/{threshold}.\n{remaining} more and a second free ticket is yours.",
    onboardingPhotosPhotoBonusEarned:
      "Photos: {count}. The free photo ticket is yours ✨\nYou can add photos (up to {max}) or a video — it earns another ticket.",
    onboardingPhotosBothBonusesEarned:
      "Photos: {count}, video done — both free tickets are yours ✨\nYou can add more photos (up to {max}).",
    onboardingPhotosPhotoBonusEarnedMax:
      "All {max} photos done, the photo ticket is yours ✨\nA short video earns another free ticket.",
    onboardingPhotosBothBonusesEarnedMax:
      "All {max} photos and the video are done ✨\nBoth free tickets are yours.",
    onboardingPhotosOptional:
      "Required photos done.\nYou can add more (up to {max}) or a short video.",
    onboardingPhotosOptionalAfterVideo:
      "Required photos and video done.\nYou can add more photos (up to {max}).",
    onboardingPhotosOptionalMax: "All {max} photos done.\nYou can add a short video.",
    onboardingPhotosOptionalMaxAfterVideo: "All {max} photos and the video are done ✨",
    menuMyTickets: "🎟️ My Tickets",
    ticketWalletText:
      "🎟️ *My Tickets*\n\nTickets: *{balance}*. Each date costs 1 ticket — buy more anytime.",
    ticketWalletOpenStore: "🎟️ Buy tickets",
    photosEnough: "You can send more (up to {max}) or hit the button to continue.",
    photosDone: "Photos uploaded ✨",
    profileReview:
      "Here's your profile:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Look good?",
    profileConfirm: "Looks good",
    profileEdit: "Change something",
    onboardingComplete:
      "*Done, you're in!* 🎉\n\nI'm already looking for your match — I'll write as soon as I find someone.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Continue ➡️",
    finishOnboardingFirst:
      "Finish registration first, then the menu and settings will be available.\nType /start to continue.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "*Last step — confirm it's you*\n\nTake a selfie and I'll compare it with your profile photos. Photos that aren't you will be removed.\n\nWithout the check you'll get fewer matches.",
    verifyPitchMandatory:
      "*Last step — confirm it's you*\n\nTake a selfie and I'll compare it with your profile photos. If the photos aren't of you, replace them first. Once you pass, I start looking for your match right away.",
    verifyMandatoryNotice:
      "Verification is now required for all new profiles — matching starts right after you pass it. It takes about a minute:",
    verifyReminderNudge:
      "Your profile is ready — verification is the only step left. It takes about a minute, and matching starts right after:",
    verifyBtnGo: "🟢 Verify now",
    verifyBtnSkip: "⚪️ Skip for now",
    verifySkipNudgeCaption:
      "One sec — listen to this before you skip 👆",
    verifyBtnReconsider: "🟢 OK, I'll verify",
    verifyBtnSkipConfirm: "🔴 Skip anyway",
    // --- Photo re-upload path (a way back before/after verification) ---
    verifyBtnRedoPhotos: "📷 Upload different photos",
    verifyBtnRedoPhotosSecondary: "📷 I'll change my photos first",
    verifyBtnAddPhotos: "📷 Add photos",
    // `beginLivenessCheck` refuses a check while the profile has no photos
    // (audit A13-H11): a pass would have nothing to be compared against.
    verifyPhotosRequired:
      "Verification compares your selfie with the photos on your profile — and there aren't any yet. " +
      "Add at least {min} photos of yourself first, then run the check:",
    verifyBtnClearPhotos: "🗑 Delete all and start over",
    verifyGateLocked:
      "The menu and matching open the moment verification is done. That's the only step left:",
    verifyPhotosRedoIntro:
      "No problem — here are your current photos. Delete the ones that aren't you and upload your own.",
    // Used instead of the line above only when a reference selfie is still on
    // file, so the promise of an automatic recheck is never made falsely (see
    // PRODUCT_SPEC §1.4 — the 90-day scrub can make it untrue).
    verifyPhotosRedoIntroRecheck:
      "No problem — here are your current photos. Delete the ones that aren't you and upload your own; I'll re-check them automatically once you're done, no new selfie needed.",
    verifyPhotosCleared: "Photos deleted. Send {min}–{max} photos of yourself.",
    verifyPhotosSavedRecheck:
      "Photos updated ✅ I'm re-checking them against your verification selfie — no need to redo it. I'll message you the moment it's done.",
    verifyPhotosSavedNowVerify:
      "Photos updated ✅ One step left — verification:",
    verifySkipped: "Verification skipped. You can do it later from the profile menu.",
    verifyCheckAlreadyDone:
      "Already processed — you should have gotten the result message above. " +
      "If something looks wrong, tap 🟢 Verify now to retry.",
    // --- Liveness retry copy (PRODUCT_SPEC §1.4) ---
    // Split by the outcome AWS actually returned, because these are genuinely
    // different situations and profile photos are never even in scope on this
    // path: CompareFaces only runs after a `passed` liveness result.
    verifyRetryNotLive:
      "*Couldn't recognise your face*\n\nFace a bright light, take off your glasses and tap 🟢 Verify now again.",
    verifyRetryUnfinished:
      "*The check was interrupted*\n\nGo through it in one go without leaving Telegram — it takes about 15 seconds. Tap 🟢 Verify now.",
    verifyRetryTechnical:
      "*A glitch on our side*\n\nTap 🟢 Verify now again — it should work this time.",
    verifyReferenceExpired:
      "We delete your verification selfie after 90 days, so there's nothing left " +
      "here to check your new photos against. One more 10-second check and " +
      "you're set — your profile stays live in the meantime:",
    verifyOutcomeVerified:
      "Verified ✨ Profile is live. I'll message you when I find a match.",
    profilerHeadsUp:
      "While I'm looking for someone for you, I'll send you the odd simple question — " +
      "what you're watching, how you spend your weekends, what you're into.\n\n" +
      "Answer honestly and don't sit on them — the better I know you, the better I can " +
      "set the two of you up for the date: what to open with, what to steer clear of.",
    verifyOutcomePendingReview:
      "🔍 We're double-checking your profile photos against your verification selfie. This usually takes a few hours — I'll message you the moment it's done.",
    verifyOutcomeRejected:
      "⚠️ *Your photos don't match the selfie*\n\nIf they aren't you, replace them with the 📷 button and I'll re-check. If they are you, run the check again in good light.",
    verifyPhotosDropped:
      "One thing: some photos didn't match your verification selfie, so I took them off your profile. Everything else is live. Add a couple more shots of yourself whenever you like 📷",
    verifyPhotosBelowMinimum:
      "You're verified ✅\n\nBut some photos didn't match your selfie, so I took them off, and now your profile is under the {min}-photo minimum. Add {need} more of yourself and I'll start looking for a match right away 📷",
    // --- Native-app push copy for the same verification outcomes (§1.4). Own
    // strings rather than reused DM copy: these land on a lock screen, so they
    // need a title, they must stay short, and they cannot point at a Telegram
    // keyboard ("tap 📷 below") that does not exist in the app.
    verifyPushVerifiedTitle: "Verified ✨",
    verifyPushVerifiedBody: "Your profile is live. I'll message you when I find a match.",
    verifyPushRejectedTitle: "Your photos don't match",
    verifyPushRejectedBody:
      "The photos on your profile aren't the person in your verification selfie. If they aren't you, swap them and I'll re-check automatically.",
    verifyPushPendingReviewTitle: "Checking your photos",
    verifyPushPendingReviewBody:
      "We're comparing your profile photos with your verification selfie. Usually a few hours — I'll let you know.",
    verifyPushRetryTitle: "One step left",
    verifyPushRetryBody:
      "Your profile is ready — only verification is missing. It takes about a minute, and matching starts right after.",
    verifyPushPhotosNeededTitle: "Add {need} more photos",
    verifyPushPhotosNeededBody:
      "You're verified, but your profile is under the {min}-photo minimum. Add {need} of yourself and I'll start looking.",
    verifyPushPhotosDroppedTitle: "Some photos came off",
    verifyPushPhotosDroppedBody:
      "A few didn't match your verification selfie, so I removed them. Everything else is live.",
    verifyMiniAppLoading: "Opening verification…",
    verifyMiniAppFinishing: "Almost done. Checking results…",
    verifyMiniAppError:
      "Couldn't start verification. Try again.",
    verifyMiniAppCloseBtn: "Close",
    photoMatchMismatch:
      "⚠️ This photo doesn't match your verification selfie. " +
      "Upload a clear photo of yourself, taken in similar lighting.",

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
    // --- Relationship intent (PRODUCT_SPEC §1.3) ---
    // The four labels are the axis itself. Each has to read as a taste, never
    // as a confession — the moment `spark` reads as "I'm not serious", social
    // desirability drags everyone rightward and the axis stops measuring.
    intentSpark: "A bright story",
    intentOpen: "See where it goes",
    intentFalling: "Fall for someone",
    intentLongterm: "Something long-term",
    // Owner-only by founder decision: the pitch never carries this, so the
    // line has to say so wherever the owner meets it.
    intentPrivateNote: "only you can see this",
    myProfileIntentLine: "🎯 Looking for: {intent}",
    myProfileIntentUnset: "🎯 Looking for: not set",
    editIntentBtn: "🎯 What I'm looking for",
    editIntentPrompt:
      "What are you looking for right now? Pick as many as fit — most people hold more than one.\n\nOnly you ever see this — I use it to match you better.",
    editIntentCleared: "Nothing selected",

    // --- Edit Profile ---
    editProfileBody:
      "These can't be changed:\n\n• *Name:* {firstName} {surname}\n• *Age:* {age}\n• *University:* {university}\n\nYou can edit:",
    editBioBtn: "📝 About me",
    editPrefsBtn: "💘 Who I want",
    editMajorBtn: "💼 What I do",
    editProfilePhotosBtn: "📸 My photos",
    editBioPrompt:
      "Write a few lines about yourself (up to 500 characters) — your match will read them before the date.",
    editBioCurrent: "Here's what it says now. New text will replace it:",
    editBioTooLong: "Too long — keep it under 500.",
    editBioSaved: "About me updated",
    editMajorPrompt:
      "What do you do? (job / studies / field, max 100 chars)\n👀 Shown to your match.",
    editMajorTooLong: "Too long — keep it under 100.",
    editMajorSaved: "Saved",
    editPrefsTitle: "💘 *Who I want*\n\nWhat to change?",
    editPrefsAgeBtn: "🎂 Partner age range",
    editPrefsDescriptionBtn: "✨ The kind of person",
    editPrefsCurrent:
      "Current preferences:\n• Person: {preferences}\n• Age: {ageRange}",
    editPrefsNotSet: "Not set",
    editPrefsDescriptionPrompt: "Describe the kind of person you want to meet (max 500 chars).",
    editPrefsDescriptionEmpty: "Please add a short description — it can't be empty.",
    editPrefsDescriptionTooLong: "Too long — keep it under 500.",
    editPrefsDescriptionSaved: "Partner preferences updated",
    editHobbiesSaved: "Interests updated",
    agentEntryPrompt: "Here you go:",
    agentFallbackError: "Something went wrong. Please say that again.",
    agentBlockedVerification: "Finish verification first — everything else opens up after that.",
    agentBlockedSuspended:
      "Your account is on hold right now, so I can't help with this. Questions go to @gennetysupport.",
    agentBlockedInvestigation:
      "Your account is under review right now. Nothing to do here for the moment — @gennetysupport can tell you more.",
    agentBlockedBanned: "This account is closed. If you think that's wrong, write to @gennetysupport.",
    profileEmbeddingSyncPending: "Saved. I'll factor it into the next round.",
    editPrefsBack: "⬅️ Back to Edit",
    editAgeRangePrompt: "What partner age range are you looking for? (e.g. 20-28)\nMin: {min}, Max: {max}.",
    editAgeRangeInvalid: "Didn't get that. Two numbers like 20-28 (range {min}–{max}).",
    editAgeRangeSaved: "Age range updated",
    editProfilePhotosStart: "Send new photos ({min}–{max}) — one by one or as an album.",
    editProfilePhotosSaved: "Photos updated",
    editProfileSaved: "Profile updated",
    photoManagerTitle: "Photos: {count}/{max} · minimum {min}",
    photoManagerCardDeleteBtn: "🗑 Delete this photo",
    // Fallback caption when a card's own message can no longer be deleted
    // (Telegram only lets a bot delete its own messages for 48 hours), so an
    // abandoned-then-resumed manager can't leave a live-looking card behind.
    photoManagerCardRemoved: "🗑 Photo deleted",
    photoManagerAddBtn: "➕ Add photo",
    photoManagerDoneBtn: "Done",
    photoManagerMinReached: "You need at least {min} photos. Add a new one first.",
    // Shimmer beats held while a whole upload burst is validated (one status
    // for the burst, not one reply per frame). Two scripts, same as the
    // onboarding pair below: the plural one, and a singular one for a burst
    // that is still a single photo. The closing beat says nothing about how
    // many, so both scripts share it rather than carrying two identical keys
    // through five languages.
    photoUploadStep1: "Uploading your photos…",
    photoUploadStep2: "Checking the shots…",
    photoUploadStep3: "Almost there…",
    photoUploadOneStep1: "Uploading your photo…",
    photoUploadOneStep2: "Checking the shot…",
    // Onboarding media stage: held while the first photo burst is validated,
    // so the several-second wait before the progress reply reads as the bot
    // looking at the photos rather than as silence. Two scripts: one photo vs.
    // several, because the plural read as the bot miscounting a single upload.
    photoReviewStep1: "Looking at your photos…",
    photoReviewStep2: "Going through the shots…",
    photoReviewOneStep1: "Looking at your photo…",
    photoReviewOneStep2: "Taking in the shot…",
    photoBatchAdded: "Added {n} · {total}/{max} in your profile",
    photoBatchNoneAdded: "Nothing was added from that batch.",
    photoBatchAtMax: "You're at the {max}-photo limit — delete one to add another.",
    photoManagerDeleted: "Photo deleted.",
    // Onboarding upload stage: the persistent bottom panel (reply keyboard)
    // and the photo editor it opens. PRODUCT_SPEC §1.3.
    photoStagePanelBtn: "🗂 My photos",
    photoStagePanelPlaceholder: "Send more photos, or tap 🗂 to edit",
    photoEditorIntro:
      "Here's everything you've sent. Tap 🗑 under any photo to remove it, or send new ones right here.",
    photoEditorBackBtn: "← Back to uploading",
    menuVideo: "🎬 Profile Video",
    editVideoPrompt:
      "🎬 Send a short profile video (up to {sec}s, max {mb} MB). Friends, scenery, or a party clip are all fine — it just makes your profile feel alive.",
    editVideoRewardLine: "🎁 Add one now and earn a free Date Ticket.",
    editVideoHasOne:
      "You already have a profile video. Send a new one to replace it, or remove it below.",
    editVideoRemoveBtn: "🗑 Remove video",
    editVideoRemoved: "Profile video removed.",
    editVideoNotAVideo: "Send a *video* (up to {sec}s, max {mb} MB).",
    myProfileAddVideoHint:
      "🎬 Tip: add a short profile video from the menu — it makes your profile stand out.",
    myProfileAddVideoHintReward:
      "Tip: add a short profile video from the menu and earn a free Date Ticket 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Matching paused ⏸\nNo new matches until you resume.",
    resumeConfirmed: "Matching back on ▶️\nI'm on it.",

    // --- Settings ---
    settingsTitle: "⚙️ Settings",
    settingsLanguage: "🌐 Language",
    settingsLanguagePick: "Pick a language:",
    settingsLanguageSaved: "Language updated",
    settingsTheme: "🎨 Theme",
    settingsThemePick: "Choose your look:",
    settingsThemeSaved: "Theme updated",
    themeDarkOption: "🌙 Dark",
    themeLightOption: "☀️ Light",
    helpBody:
      "*Need help?*\n\nAn issue with a match, a date or the bot — write to support:\n\n💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Delete Account",
    deleteAccountConfirm:
      "*Delete your account for good?*\n\nYour profile, photos and matches will be gone. This can't be undone.",
    deleteAccountYes: "Yes, delete everything",
    deleteAccountNo: "Cancel",
    deleteAccountDone:
      "Account deleted. All data wiped.\n" +
      "Want to come back? Just send /start.",
    deleteAccountFailed:
      "We couldn't safely erase everything right now. Nothing was deleted — please try again.",
    // A13-H14: a refund a sweep still owns defers deletion — payment rows
    // outlive the account, the Telegram id the Stars go back to does not.
    deleteAccountRefundInProgress:
      "A refund connected to your account is still being processed, and deleting now would leave it with nowhere to go. Nothing was deleted — please try again once the refund has gone through.",
    accountActionExpired: "This confirmation expired. Open the action again.",
    statusActionUnavailable: "This action isn't available for the current account status.",
    deleteFreezeIntro:
      "Wait — before you delete everything 👀\n\nYou don't have to lose it all. *Freeze* your account instead: your profile, photos and verification stay safe, you disappear from matching, and next time you just send /start to land right back in your ready profile — no signing up again.\n\nStill want to delete? That one's permanent.",
    deleteFreezeBtn: "❄️ Freeze my account",
    deleteProceedBtn: "Delete my account anyway",
    freezeConfirmed:
      "Done — your account is *frozen* ❄️\n\n" +
      "You're hidden from matching and won't get pinged. " +
      "Come back anytime with /start and everything's still here.",
    freezeWelcomeBack: "*Welcome back!* Your account is unfrozen.",
    deleteFinalYes: "Yes, delete",
    deleteFinalNoSoft: "No, keep it",
    deleteFinalNoHard: "No, keep it",
    freezePartnerNotice:
      "Heads up — your match is no longer available, so this one won't go ahead. " +
      "No worries: you'll get priority in the next batch 💛",

    // --- Matching ---
    matchHeadline: "💘 Found you a match!",
    matchDeadlineNotice: "You have 24 hours to answer. You can't change it afterwards.",
    matchStreamStart: "Why you two click…",
    matchBtnAccept: "Accept",
    matchBtnDecline: "❌ Pass",
    matchDeclineConfirmPrompt:
      "Pass on this match?\n\nThis is final — you won't be matched with this person again.",
    matchBtnConfirmDecline: "❌ Yes, pass",
    matchBtnKeepDeciding: "← Go back",
    matchDecisionQuestionM:
      "Want to go on a date with him? Just answer yes or no.",
    matchDecisionQuestionF:
      "Want to go on a date with her? Just answer yes or no.",
    matchTextYesConfirm: "Love that ✨ Confirm below — and I'll take care of the rest:",
    matchBtnConfirmGo: "💫 Yes, I'm going",
    matchTextUnsure:
      "No rush — when you know, just tell me “yes” or “no”.",
    matchDeclineDismissed:
      "No rush — this match is still waiting for your answer. 💛",
    matchAcceptedToast: "Accepted",
    matchDecisionSavedToast: "Saved",
    matchAccepted: "Accepted ✨ Waiting on them.",
    matchBothAccepted: "It's mutual 🤍 Let's find a time.",
    matchDeclined:
      "Got it. What didn't fit? Pick an option or say it in your own words — I'll factor it in next time.",
    matchDeclineReasonType: "Not my type physically",
    matchDeclineReasonVibe: "Different vibe",
    matchDeclineReasonInterests: "Interests don't match",
    matchDeclineReasonLifestyle: "Lifestyle mismatch",
    matchDeclineReasonOther: "Something else",
    matchDeclineOtherAsk:
      "Sure — send a short text or voice note with the reason. I'll factor it into the next round.",
    matchDeclineFeedbackSaved:
      "Got it. I'll tune the next picks around this.",
    matchDeclineAlreadyNoted: "Already noted — thanks.",
    matchDeclineFeedbackFailed:
      "Couldn't save that right now. You can still send a short text or voice note.",
    matchDeclineThanks: "Noted. I keep looking.",
    matchPeerDecided:
      "*Your match has already answered*\n\nWhat they said — you'll see after you answer.",
    matchPeerWasAccepted: "FYI — your match was in. Just didn't line up this time.",
    matchPeerWasDeclined: "FYI — your match passed this time.",
    matchAcceptedPeerDeclined:
      "This time it's a no from their side. It happens — here a date only happens when it's mutual. " +
      "I keep looking; the next pick will be closer.",
    matchAcceptedPeerDeclinedPriority:
      "This time it's a no from their side. It happens — here a date only happens when it's mutual.\n\nI've raised your priority for the next round. The next pick will be closer.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Verified",
    matchVerifiedQuote: "Verified: the photos really show this person.",
    // The bold span is applied as a `bold` MessageEntity by the pitch, NOT by
    // markdown: the final pitch message carries `entities` (for the verified
    // blockquote) and Telegram accepts `entities` OR `parse_mode`, never both.
    // Hence the label is its own key — the composer needs its exact bounds, and
    // parsing `*…*` out of the interpolated string is unsafe because {reason}
    // is model-written and may contain an asterisk of its own.
    matchSynergyLabel: "Compatibility {score}/99",
    matchSynergyHeader: "💎 {label} — {reason}",
    pitchCountdownHours: "⏳ {hours}h left to reply",
    pitchCountdownMinutes: "⏳ {minutes} min left to reply",
    pitchDeadlineBtnHm: "⏳ Time left to reply: {h}h {m}m",
    pitchDeadlineBtnMin: "⏳ Time left to reply: {m}m",
    pitchCountdownTapToast: "Just say yes or no whenever you're ready — the window's still open ✨",
    pitchDeadlineNudge:
      "Heads up — your window to answer this match closes in about {hours}h. If you'd like to go, just say yes now; no worries if not.",
    // Planning-stage stall chain (PRODUCT_SPEC §3.5c). Deliberately written
    // without gendered past-tense forms about the PARTNER, so ru/uk/pl need no
    // M/F variants — the only gendered voice is the bot's own.
    stallPartnerFallbackName: "your match",
    // Toast on a check-in button whose match has since resolved. The question
    // message keeps its buttons forever, so this is a normal tap, not an edge case.
    stallActionExpired: "That one's already settled — nothing left to answer here.",
    // Alert on an Accept/Pass button whose match row is gone or already past
    // the deciding stage. Deleting an account cascades the row away and leaves
    // the pitch card in the chat forever, so this is a normal tap, not an edge case.
    matchCardExpiredAlert: "This match card isn't live any more — nothing left to decide here.",
    emergencyStaleAction: "This date is no longer active. Check the latest status before trying again.",
    calendarStaleAction: "This calendar is closed. Open the latest match card to see what changed.",
    stallVenueNudge:
      "All that's left is marking where you'll be setting off from — then I'll pick a place that works for both of you.",
    stallCheckInScheduling:
      "{name} is waiting — you two stopped at picking a time.\nStill on?",
    stallCheckInVenue:
      "{name} is waiting — you two stopped at picking the place.\nStill on?",
    stallBtnStillOn: "🟢 Yes, still on",
    stallBtnPlansChanged: "Plans changed",
    stallPeerAsked:
      "Nudged {name} about you two — waiting to hear back.\n\nNothing needed from you for now.",
    stallStillOnAck: "Got it, still on ✨",
    stallPeerStillOn: "{name} is around, still on ✨",
    stallCancelConfirmPrompt:
      "Cancel the date with {name}?\n\nThis is final — I won't offer this pair again.",
    stallBtnCancelConfirm: "🔴 Yes, cancel",
    stallBtnCancelBack: "🟢 ← Back",
    stallCancelAborted: "Alright — still on. 👍",
    stallCancelDone: "Got it. I've let {name} know — no details.\n\nYou're back in the search.",
    stallPeerCancelled:
      "Date cancelled — {name}'s plans changed.\n\nThis isn't about you. I've bumped your priority in the next round.",
    stallTimeoutPartnerGone:
      "Date cancelled — {name} never got back to us.\n\nA shame, but better now than on the day. I've bumped your priority in the next round.",
    stallTimeoutSelf:
      "Your date with {name} is cancelled — there was no answer for two days, " +
      "and I couldn't keep you both hanging.\n\n" +
      "If plans change, just tell me. That's completely fine.",
    // The hard ceiling ended a venue step both sides had finished: the place
    // search failed for good and nothing was going to retry it. Nobody went
    // quiet, so neither is told their partner did.
    stallTimeoutVenueUnresolved:
      "Your date with {name} is cancelled — I couldn't find a place for you two in time.\n\nThat's on me, not on either of you. I've bumped your priority in the next round.",
    pitchExpired: "⏳ Time's up — this proposal expired.",
    matchExpiredSilentWarning:
      "*Time to answer is up*\n\nNext time, answer at least “no” — someone is waiting.",
    matchExpiredSilentPenalty:
      "*Time to answer is up*\n\nIt's the second time, so your rating has been lowered. Next time, answer at least “no” — someone is waiting.",
    matchExpiredYouMissedDate:
      "Heads up — your match was actually in. This could have been a real date.\n\n",
    matchExpiredPeerIgnored:
      "Your match didn't reply within 24h, so the date won't happen. See you in the next round.",
    // §3.4 — this side PASSED, and the partner then went silent. A first
    // decision leaves the row `proposed` either way, so a decliner reaches
    // expiry classified as a `responder` exactly like someone who accepted
    // and got stood up. They already got their "you passed" ack, so this is
    // deliberately a bare fact with no consolation and no card: it exists
    // only so the match doesn't vanish from the menu and banner unexplained.
    matchExpiredSelfDeclined: "This match is closed. See you in the next round.",
    // Expiry card (PRODUCT_SPEC §3.4). The card states WHAT HAPPENED and the
    // caption adds only the consequence, so nothing is said twice. The
    // `matchExpired*` strings above stay as the plain-text fallback for when
    // the render fails — between them no sentence is ever lost.
    // Headlines are split on "\n"; the last line renders in the accent colour.
    expiryCardOverlineExpired: "WINDOW CLOSED",
    expiryCardHeadlineExpired: "TIME'S\nUP",
    expiryCardSublineExpired: "24 hours passed with no answer.\nSee you in the next round.",
    expiryCardOverlinePenalty: "SECOND TIME, NO ANSWER",
    expiryCardHeadlinePenalty: "RATING\nLOWERED",
    expiryCardSublinePenalty: "A second match left unanswered.\nSee you in the next round.",
    expiryCardOverlinePeerIgnored: "NOT ABOUT YOU",
    expiryCardHeadlinePeerIgnored: "THEY NEVER\nANSWERED",
    expiryCardSublinePeerIgnored:
      "The date won't happen.\nYour part was done on time.",
    expiryCardOverlineMissedDate: "THEY SAID YES",
    expiryCardHeadlineMissedDate: "IT WAS\nMUTUAL",
    expiryCardSublineMissedDate:
      "They were ready to meet.\n24 hours passed with no answer.",
    expiryCaptionSilentWarning: "Next time, answer at least “no” — someone is waiting.",
    expiryCaptionSilentPenalty:
      "It's the second time, so your rating has been lowered. Next time, answer at least “no” — someone is waiting.",
    expiryCaptionPeerIgnored: "See you in the next round.",
    noMatchThisWeekTier1:
      "*No match this week*\n\nI didn't find anyone who truly fits, and I won't offer just anyone. You'll have priority in the next round ✨",
    noMatchThisWeekTier2:
      "*No match again*\n\nFor the second week in a row I don't see anyone who truly fits. Thanks for waiting — your priority in the next round is even higher 🤍",
    noMatchThisWeekTier3:
      "*Still no match*\n\nThere's still no one who truly fits, and I won't offer just anyone. I'm watching your queue — you're among the first in the next round 🤍",
    noMatchDiscountOffer:
      "🎟️ A small thank-you for your patience: your next first date is {pct}% off — one Date Ticket, almost on us. " +
      "We'll apply the discount automatically the next time you get a match or open your tickets.",
    poolExhaustedPauseNotice:
      "*Pausing your search*\n\nRight now there's genuinely no one for you — it's not about you. As soon as someone who fits shows up, I'll bring you back into the search myself.",
    poolExhaustedResumeNotice:
      "Good news — someone who fits showed up, so I've brought you back into the search. You're in the next round 🤍",
    matchScheduleProposal:
      "How about one of these? Tap what works:",
    matchScheduleIter3:
      "It's mutual 🤍 Open the calendar and mark every time that works.",
    matchScheduleAfterTicket:
      "📅 Now pick your time — open the calendar and mark every slot that works.",
    matchScheduleBtnCalendar: "📅 Open Calendar",
    // --- Date Ticket (premium post-accept gate) ---
    ticketCardCaption: "It's a match 🤍 Get your ticket and we'll pick a time.",
    ticketCardCaptionPremium:
      "It's a match 🤍 Premium covers both tickets — straight to picking a time.",
    ticketButton: "🎟️ Get your date ticket",
    ticketViewButton: "🎟️ View your date ticket",
    ticketStatusButton: "Open date",
    ticketGateWaiting: "Ticket ready ✨ Waiting on them.",
    // The other side settled only their own ticket. Without this she learns
    // nothing — her deadline is silently pushed to 24h from HIS payment and the
    // only entry point left is a card that has scrolled away.
    ticketPeerTookTheirs:
      "{name} just grabbed their date ticket 🎟️ Yours is the last one — then we open planning.",
    // Date Bump verified (§6.2). Sent to BOTH sides, and only on the verified
    // event — a single shake notifies nobody, because a nudge to the second
    // person is the first person's phone telling on them.
    bumpVerifiedDm:
      "You're both here ✨ I've counted the date — and the next ticket is on me.",
    bumpDeckIntro: "If the conversation needs somewhere to go:",
    ticketBothSecuredDm: "Both tickets secured 🎟️ Your date is on — let's pick a time.",
    ticketPartnerPaidDm: "{name} already covered your date ticket ❤️ You're all set — nothing to pay.",
    // Goodwill "he covered her ticket" read-receipt (§3.5b): confirm his gesture
    // landed (takt 1), then let him know once she's actually seen it (takt 2).
    ticketCoveredHerConfirm:
      "💛 Done — you covered {name}'s ticket. The moment she sees it, I'll let you know.",
    ticketPartnerSawItDm: "❤️ {name} saw that you covered her ticket.",
    ticketRefundedDm:
      "Your ticket is back in your wallet, and the date is still on. Let's pick a time 📅",
    ticketRefundedToWallet:
      "🎟️ Your Date Ticket is back in your wallet — yours to use on the next date.",
    ticketRefundedToWalletBoth:
      "🎟️ Both Date Tickets you paid for are back in your wallet — yours to use on the next date.",
    matchScheduleNoOverlap:
      "No overlap yet — next round.",
    matchScheduled: "Locked in — see you there 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 It might be packed at peak time — no stress: grab a coffee to go and take a walk, or duck into another nice spot nearby.",
    matchScheduledBtnOpenMaps: "📍 Open in Maps",
    matchScheduledBtnShare: "📤 Share this card",
    dateCardWhen: "WHEN",
    dateCardSlogan: "No texting\nStraight to real life",
    dateCardShareCaption:
      "Share away — your match's face is hidden to protect their privacy 💞",
    dateCardShareFailed:
      "Couldn't prepare a shareable card right now — try again in a moment.",
    matchSchedulePickedPrefix: "You picked: ",
    matchScheduleWaitingPeer: "Waiting on the other person…",
    matchSchedulePeerProposed:
      "Your match marked their times in the calendar. Open it — agree with one, or drop your own:",
    matchSchedulePeerSuggestedAlternative:
      "Your match countered with a different time. Take a look — agree, or suggest your own.",
    matchScheduleSavedConfirmation:
      "Done. Your match got a notification — I'll write when they answer.",
    matchScheduleNoOverlapYet:
      "You've both picked times, but nothing overlaps yet. Add a few more — the second a slot matches, it's locked:",
    // Scheduling reminder for a pair whose calendars already share slots that
    // have not locked — normally several of them. Only a single shared slot
    // locks the date by itself; with several, someone has to confirm the final
    // one, and the server cannot tell which side was shown that choice last —
    // so both hear it.
    matchSchedulePickFinalYet:
      "Your calendars already line up — open it and confirm the time that works best, and it's locked:",
    venueTimeCardLabel: "YOUR DATE",
    venueTimeLockedCaption: "Your date is locked in ✨",
    venueConciergeIntro:
      "*Where will you set off from?*\n\nDrop a point on the map — home, a metro station, anywhere convenient. I'll find a place that's easy for both of you to reach.",
    venueConciergeBtnLocation: "📍 Send my location",
    venueConciergeBtnMap: "🗺️ Pick on map",
    venueLocationFirst:
      "First things first — *mark where you'll be setting off from* 📍 Tap below to drop it on the map.",
    venueOriginOutsideMarket:
      "That point is outside {city}, and Gennety only works in {city} for now — I look for a place within a short trip of you both, so I can't find one from there. Mark the spot in {city} you'll be setting off from:",
    venueVibeNoted: "Vibe noted ✨ Now pick where you'll be coming from:",
    venueLocationNoted:
      "Starting point saved ✨ Now — what *vibe* are you after? e.g. _quiet cafe_, _vegan brunch_, _park walk_, _small museum_.",
    venueSafetyOverride:
      "Heads up — picked a public café instead. We keep first dates in public spots.",
    venueWaitingPeer: "Got yours ✨ Waiting for them…",
    venueLocationUseMap:
      "Pins shared in the chat don't reach the venue search any more — mark your starting point on the map below 📍",
    venueTimeLapsedBackToCalendar:
      "Your date time is too close now to find a spot in time, so let's pick a new one.",
    venueSelectionFailedRetry:
      "I couldn't pick a spot for your date just now — the venue search failed on our side. Open the venue screen and confirm your starting point again to retry.",
    peerWaitT1Sent: "Passed it to {name}, waiting for an answer",
    peerWaitT2Waiting: "{name} is still thinking it over",
    peerWaitT3Quiet: "No word from {name} yet, still waiting",
    peerWaitT4Nudged: "We nudged {name}, waiting for an answer",
    peerWaitT5Deadline: "Still no answer from {name}",
    peerWaitAnon: "Waiting on your match",
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
    onbAnalyzeStep1b: "💭 Thinking…",
    verifyAnalyzeStep1: "🔍 Matching your selfie…",
    verifyAnalyzeStep2: "🧬 Reading facial features…",
    verifyAnalyzeStep3: "⏳ Finalizing the check…",
    voiceCheckStep1: "🎧 Listening to your recording…",
    voiceCheckStep2: "Making sure it's all good…",
    videoCheckStep1: "🎬 Looking through your video…",
    videoCheckStep2: "🙂 Checking it's you…",
    videoCheckStep3: "✨ Almost ready…",
    skipAnalyzeStep1: "✨ Polishing your profile…",
    skipAnalyzeStep2: "🧮 Tying it all together…",
    skipAnalyzeStep3: "💞 Prepping you for matching…",
    profilerBatchThinking: "Thinking…",
    profilerBatchSaving: "Saving your answers…",
    profilerBatchSaved:
      "Preference card updated ✨ I'll use it for the next match.",
    profilerNextAck: "Got it…",
    profilerNextFormulating: "Thinking…",
    profilerRefusalAck: "Okay, I won't push. I'll ask again another time 💛",
    profilerImageUnreadable: "Hmm, I couldn't quite make that one out 😅 Tell me in words?",
    profilerLinkUnreadable: "I can't open that one — it may be private or gone 😅 Tell me in words, or send a picture?",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "🔄 Change venue",
    venueBoardPingFromF: "{name} is eyeing a cozier spot for your date 👀",
    venueBoardPingFromM: "{name} suggests a look at a couple of other spots for your date 👀",
    venueBoardPingBtn: "Take a look",
    venueKeepNotice: "Your match would rather keep {venue}. You can still suggest another spot below.",
    venueBothKeepDm: "You're both keeping {venue} — nothing changes, see you there.",
    venueDeclinedKeepDm: "You're keeping {venue}, as originally planned.",
    venueChangeRefunded:
      "The venue change didn't go through, so your Stars are back. Your date is on as planned, at the original place.",
    // Prime Time (PRIME_TIME_PRODUCT_SPEC.md). The invoice copy says what the
    // Stars buy for the PAIR, not for the buyer — the band opens for both, and
    // a description that said "for you" would misdescribe the purchase.
    primeInvoiceTitle: "Late evenings",
    primeInvoiceDesc:
      "Opens 18:30, 19:00 and 19:30 on every day of your calendar — for both of you, for this date.",
    primeInvoiceLabel: "Late evenings",
    primeTimeOpenedDm: "{name} opened late evenings — 18:30 and later are now in your calendar.",
    primeTimeRefunded:
      "Late evenings didn't open, so your Stars are back. The rest of the calendar is unchanged.",
    primeTimeRefundedDateOff:
      "The date is off, so the Stars you spent on late evenings are back with you.",
    // Meme unlock (§Phase 4 pre-date reveal). The offer is a teaser on purpose:
    // it says a meme EXISTS and what knowing it is worth, never anything about
    // the meme itself — a description in the offer would be the product, given
    // away for free.
    memeCardTeaser:
      "🎭 One more thing about {name}.\n\nWhen I asked what actually makes them laugh, they didn't type an answer — they sent a meme. That says more about a person than any three sentences could.\n\nWant to see it before you meet?",
    memeCardBtn: "🎭 Show me",
    memeRevealCaption: "🎭 What makes {name} laugh:",
    memeRevealSource: "▶️ Watch it in full:",
    memeRevealFallback:
      "🎭 I couldn't re-send the picture itself, so here it is in words — what {name} sent when asked what makes them laugh:\n\n_{description}_",
    memeRevealGone: "That question got answered again in words, so there's no meme here any more.",
    // A meme card from a match that is no longer on, or across a block. Neutral
    // for the same reason as `coordProxyUnavailable`.
    memeRevealUnavailable: "This card isn't active any more.",
    venuePayPromptDm: "You two picked a new place for your date.\n\n📍 {venue}",
    venuePayOpenBtn: "📍 See it and decide",
    // Caption under the wish-card PNG, which already shows the venue name and
    // address — so the text must not repeat them.
    venueWishText:
      "{name} found a place she loves for your date.\n\n" +
      "She'd be happy if you locked it in.",
    // Same message when the PNG could not be rendered: with no card there is
    // nothing else naming the place he is being asked to pay for.
    venueWishTextFallback:
      "{name} found a place she loves for your date.\n\n📍 {venue}\n\n" +
      "She'd be happy if you locked it in.",
    venueWishPayBtn: "Lock it in — {stars} ⭐",
    venueWishDeclineBtn: "Not this time",
    venuePayDeclineAck:
      "Got it — the venue stays as planned for now. If it changes, you'll get an updated card.",
    venuePayDeclineStale:
      "This card is out of date — the venue plans have changed since. Tap below to see where things stand now.",
    venuePaySelfDm:
      "You two agreed on a new place.\n📍 {venue}\nLock it in — I'll update your date cards.",
    venuePaySelfBtn: "⭐ Lock it in — {stars}",
    venueSettledCard: "Done — your date has a new home 📍 {venue}",
    venueSettledPaidByM: "{name} covered the venue change ❤️ Your date now happens at {venue}",
    venueSettledPaidByF: "{name} covered the venue change ❤️ Your date now happens at {venue}",
    venueExpressPartnerFromF: "{name} picked a cozier spot for your date. New place: 📍 {venue}",
    venueExpressPartnerFromM: "{name} picked a new spot for your date. New place: 📍 {venue}",
    venueLapsedDm: "The venue change wasn't locked in — you're meeting at {venue}, as planned.",
    venueKeepOriginalDm: "Your match decided to stay put — you're meeting at {venue}, as planned.",
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
    noMatchStreamStart: "💫 Looking through candidates for you…",
    profilerSkip: "Skip",
    wingmanHintIntro:
      "👋 Insider tip — your date's in 90 minutes:\n\n",
    // The Date Terminal's two messages (T-45m / T-15m). "Date Terminal" and
    // "Contact Sync" are product names and stay in English in every locale.
    dateTerminalInvite:
      "*Your date is in {minutes} min*\n📍 {venue}\n\nOpen the date screen — it will show you the way. At the table, hold your phones together, top edges touching, to swap contacts.",
    dateTerminalReminder:
      "*Contact swap is open*\n📍 {venue}\n\nOnce you're both at the table, open the date screen and hold your phones together.",
    dateTerminalBtn: "🎟 Open the date",
    dateDayActivityStartTitle: "Your date is today",
    emergencyPushTitle: "Your date is off",
    emergencyPushBody: "Open Gennety — the reason is there.",
    dateDayActivityStartBody: "Everything you need is on your lock screen.",
    // The venue-change lock-screen card (iOS `venue_change` Live Activity,
    // decision 2026-09-22): the alert a push-to-start must carry. The partner
    // name is only ever the SUBJECT (nominative) — the server declines no names.
    // `{what}` is a venue name or `venuePlacesPhrase` ("2 places").
    venueActivityStartTitle: "Venue change",
    venueActivityStartPartner: "{name} suggests {what}",
    venueActivityStartPartnerKeep: "{name} would rather keep {venue}",
    venueActivityStartWaiting: "Waiting to hear back about the place",
    venueActivityStartMatch: "You both picked {venue}",
    venueActivityPartnerFallback: "Your match",
    // The time-agreement lock-screen card (iOS `time_agreement` Live Activity,
    // decision 2026-09-23): the alert a push-to-start carries, and the one an
    // update carries when the PARTNER moved. `{when}` is a weekday + HH:mm in the
    // RECIPIENT's timezone (the weekday is dropped when the slot is today); the
    // partner name is only ever the SUBJECT — the server declines no names, which
    // is also why waiting has a nameless twin rather than reusing
    // `venueActivityPartnerFallback` ("Ждём, когда Твой мэтч ответит" would
    // capitalise mid-sentence).
    timeActivityStartTitle: "Picking a time",
    timeActivityStartPartner: "{name} suggests {when}",
    timeActivityStartWaiting: "Waiting for {name} to reply",
    timeActivityStartWaitingNoName: "Waiting to hear back about the time",
    timeActivityStartMatch: "Time set: {when}",
    emergencyUnlocked:
      "Plans changed and you really can't make it? You can cancel with the button below.",
    emergencyBtn: "Cancel Date",
    emergencyConfirmPrompt:
      "If it's just nerves or running late, better keep the date. *Cancel only if you truly can't make it:* the match can't be brought back.",
    emergencyBtnConfirm: "🔴 Yes, cancel the date",
    emergencyBtnBack: "🟢 Keep the date",
    emergencyAborted: "Okay — your date is still on. 👍",
    emergencyAskReason:
      "Write your reason. This goes to your match *word for word*.",
    emergencyConfirmed:
      "Date cancelled. Your message was forwarded.",
    // The emergency button stays in the chat after the date begins, but the
    // cancel rail refunds both tickets — so past the start time it refuses and
    // points at the did-you-meet question instead (PRODUCT_SPEC §Phase 4). It
    // promises nothing about money, exactly like that question's own closing.
    emergencyDateStarted:
      "Your date's start time has already passed, so it can't be cancelled any more. " +
      "If it didn't happen, I'll ask you about it the next day.",
    emergencyReceivedOther:
      "Your match cancelled the date. Here's what they said:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Your match cancelled the date. Here's what they wrote:",
    emergencyReceivedOtherSoftNote:
      "This isn't because of you. Gennety will raise your priority a little in the next round.",
    feedbackInvitation:
      "*How did your date go?* ✨\n\nShare a couple of details: was there chemistry, what was the vibe, did you like the place?",
    feedbackBtnForm: "✍️ Open feedback form",
    feedbackBtnVoice: "🎤 Send voice instead",
    // The T+24h attendance question (PRODUCT_SPEC §Phase 4). Asked BEFORE the
    // feedback form, because that form's questions — chemistry 1–10, a second
    // date — are questions ABOUT a date, and they are nonsense to someone who
    // was stood up. Three wordings of ONE question: the evidence classifier
    // picks the tone, never the answer, so a wrong guess costs a sentence
    // rather than a fabricated fact.
    attendanceAsk: "Before I ask how it went — did the two of you actually meet? 🙂",
    attendanceAskLikelyMet:
      "Sounds like yesterday actually happened 🙂 Just confirming — did you meet?",
    attendanceAskLikelyNotMet:
      "Looks like yesterday didn't work out. Did I get that right — you didn't meet?",
    attendanceBtnYes: "Yes, we met",
    attendanceBtnNo: "No, it didn't happen",
    attendanceNoIntro: "Sorry it fell through. What happened?",
    attendanceOutcomePartner: "They didn't come",
    attendanceOutcomeSelf: "I couldn't make it",
    attendanceOutcomeBoth: "We agreed to reschedule",
    attendanceOutcomeOther: "Something else",
    // Promises nothing. There is no priority boost and no refund on this path
    // today, and a surface must not invent one (same rule the expiry card
    // follows in §3.4).
    attendanceNoThanks: "Thanks for telling me — noted. Sorry it went that way.",
    attendanceAlreadyAnswered: "Already noted, thanks ✨",
    attendancePushTitle: "Did you two meet?",
    attendancePushBody: "One tap, and I'll know whether to ask how it went.",
    feedbackVoiceAsk:
      "Just record a voice note 🎙️\n\n" +
      "Tell us how the date went — was there chemistry? What did you like? " +
      "Anything that didn't work? A minute is plenty.",
    feedbackThanks: "Thanks! I'll factor it into the next round ✨",
    // A second answer is refused, not merged: the first one already fed matching.
    feedbackAlreadySubmitted: "You've already told us how this date went — thanks, it's saved ✨",
    feedbackPushTitle: "How was your date?",
    feedbackPushBody: "A minute of your time helps us find you a better match next time.",
    // The drop notification on the app rail (iOS §5.3). Word for word the
    // mock-up the pre-permission screen showed during onboarding — the app
    // promised this notification, and the promise and the thing itself are one
    // sentence in two places. It names nobody: the lock screen is public, and
    // the only trace of the partner is a photo the client blurs on arrival.
    matchDropPushTitle: "Your match is here",
    matchDropPushBody: "Tap to see ✨",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Report",
    reportAsk:
      "This report is private. What best describes the problem?",
    reportCategoryFakePhotos: "Fake or misleading photos",
    reportCategoryWrongPerson: "Wrong person in the photo",
    reportCategoryOffensive: "Rudeness or strange behavior",
    reportCategoryUnsafe: "I felt unsafe",
    reportCategorySpam: "Spam or fraud",
    reportCategoryInappropriate: "Inappropriate profile",
    reportCategoryOther: "Other",
    reportDetailAsk:
      "Anything else that would help review this faster? You can type, send a voice note, or skip.",
    reportDetailAskOther:
      "Briefly describe what happened. You can type or send a voice note.",
    reportSkipBtn: "Skip",
    reportThanksT1: "Got it — we'll use this to tune your future matches 🎯",
    reportThanksT2: "Reported. Thanks — we'll act on this.",
    reportThanksT3:
      "Report received. This person's account is frozen pending review. Thanks for letting us know.",
    reportFailed: "Couldn't process your report right now. Try again in a minute.",
    reportDuplicate: "You've already reported this match.",
    reportBackBtn: "← Go back",
    reportCancelled: "Okay — no report sent.",
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
      "*Your date is in 90 minutes — {location_name}*\n\n📍 *Stick to the plan.* We picked a safe public place for you. Don't agree to move the meeting somewhere private or to go to someone's home.\n🚗 *Transport.* Get there and back on your own — public transport, taxi or on foot. Don't get into a car with someone you barely know.\n📱 *Tell someone close.* Forward the meeting details to a friend or family member and, if you can, share your location for the evening.\n🛑 *Your boundaries.* If you feel uncomfortable or your date's behavior seems off, you can just get up and leave at any moment. Your safety matters more than politeness.\n\nHave a great evening ✨",
    // The T-1.5h safety brief on the app rail (§5.4). The DM above IS the
    // brief; this only says one has arrived, because a checklist does not fit
    // on a lock screen and must not sit there in the first place. It names
    // neither the partner (§5.3's rule) nor the VENUE — a briefing that
    // announces where this woman will be tonight, to anyone who picks up her
    // phone, argues against itself.
    safetyBriefPushTitle: "Before you head out",
    safetyBriefPushBody: "Your safety checklist for tonight is in the app.",
    // The four §4.3 notifications that reached only Telegram until now. Each
    // push is a one-line "this happened, open the app": the DM stays the real
    // message, because a famine tier, a calendar and a model-written nudge do
    // not fit on a lock screen. None names the partner (§5.3's rule), and the
    // famine discount is deliberately absent — its conditions are checked in
    // the DM that grants it, so a push promising it could promise wrongly.
    noMatchPushTitle: "No match this time",
    noMatchPushBody: "No one right turned up yet. The search stays on.",
    matchNudgePushTitle: "Your match is still waiting",
    matchNudgePushBody: "Yes or no — both are fine. The window's still open.",
    planningNudgePushTitle: "Your date still needs a time",
    planningNudgePushBody: "Open the calendar when you have a moment.",
    deadlineNudgePushTitle: "The window is closing",
    deadlineNudgePushBody: "About {hours}h left to answer. Yes or no — both are fine.",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Next match in {d}d {h}h",
    statusHoursMinutes: "⏳ Matches arrive in {h}h {m}m",
    statusMinutes: "✨ Almost ready! Matches arrive in {m}m",
    statusProcessing: "✨ Analyzing your city… Check back shortly.",
    statusBannerSchedule: "Next round: {date}, {time}",
    statusBannerActive: "We're already looking for your person ✦",
    statusBannerSearching:
      "I'm looking for your person — I check every evening.\n" +
      "The moment there's someone worth your time, you'll hear from me.",
    statusButtonDaysHours: "Next round in {d}d {h}h",
    statusButtonHoursMinutes: "Next round in {h}h {m}m",
    statusButtonMinutes: "✨ Next round in {m}m",
    statusButtonProcessing: "✨ Matching in progress",

    // --- Stage-aware banner (PRODUCT_SPEC §2.1) ---
    // A user with a live match is excluded from the weekly batch (§3.2 filter 8),
    // so the drop countdown would be a promise we can't keep.
    //
    // The FIRST LINE names what is being counted and ends with a colon: the
    // collapsed pinned bar shows it on the left and the button's bare time as a
    // badge on the right, so together they read as one sentence. Never put the
    // time itself here, and never let the first line grow — it truncates.
    statusBannerDecision:
      "Time left to reply:\n\n" +
      "Your match is waiting. Answer yes or no right here in the chat.",
    // Covers an accepted-but-unanswered proposal too, so it must never assert
    // what the partner chose (blind-decision invariant §3.4).
    statusBannerPlanning:
      "Your date is being planned ✦\n\n" +
      "The details are still coming together — everything about it is in My date.",
    statusBannerDate: "Time until your date:",
    // Bare countdowns for the banner badge — digits and units only, no label
    // and no emoji, because the badge truncates.
    statusTimeDaysHours: "{d}d {h}h",
    statusTimeHoursMinutes: "{h}h {m}m",
    statusTimeMinutes: "{m}m",
    statusButtonDateOpen: "Details",

    // --- Kyiv-only market gate (PRODUCT_SPEC §1.1) ---
    // For an account registered in a city we haven't launched: matching is
    // strictly same-city, so counting down to a drop they cannot be in would
    // be a promise we can't keep.
    statusBannerMarketPending:
      "Gennety is live in Kyiv for now — we haven't launched in {city} yet, " +
      "so there's nobody here to match you with.\n\n" +
      "Ready to go on dates in Kyiv? Switch your city from the menu.",
    statusButtonMenu: "Open menu",
    menuCitySwitch: "📍 Switch city to Kyiv",
    citySwitchCard:
      "📍 *Your city: {city}*\n\nGennety is live in Kyiv only for now. Matches are always within one city, so until we launch in {city} there's nobody here to introduce you to.\n\nIf you'd like to go on dates in Kyiv, switch — your profile, photos and verification all stay exactly as they are, and you're in the next round.",
    citySwitchConfirm: "📍 Yes, match me in Kyiv",
    citySwitchDone: "Done — your matching city is Kyiv 🤍\n\nYou're in the next round: {date}.",
    citySwitchFailed: "Couldn't switch the city just now. Try again in a moment.",
    noMatchCityNotLaunched:
      "*Gennety isn't in {city} yet*\n\nWe're only in Kyiv so far, and matches always happen inside one city — so there's nobody here to introduce you to yet. Your profile stays as it is, and we'll write the moment we open your city.\n\nIf you'd like to go on dates in Kyiv, switch below and you'll be in the next round.",
    noMatchCitySwitchBtn: "📍 Switch to Kyiv",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Date in {d}d {h}h",
    statusDateHoursMinutes: "💫 Date in {h}h {m}m",
    statusDateMinutes: "💫 Date in {m}m",
    statusDateSoon: "💫 Date is today",
    menuMyDateDays: "💫 My date · in {d}d {h}h",
    menuMyDateHours: "💫 My date · in {h}h {m}m",
    menuMyDateMinutes: "💫 My date · in {m}m",
    menuMyDateSoon: "💫 My date · today",
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
      "You've written a lot today 🙂 Let's continue tomorrow — that's today's limit.",

    // --- Pre-date coordination (feature-flagged) ---
    // The anonymous chat only, for every scheduled date. The T-3h questionnaire
    // and its handle-exchange copy were removed on 2026-09-26 (founder decision:
    // contacts never change hands before the date).
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
    coordProxyPushTitle: "Your date",
    coordProxyTextOnly: "Only text messages work in this chat — photos and voice notes aren't passed on.",
    coordProxyClosed: "The anonymous chat has closed. Hope the date went well — I'll check in tomorrow ✨",
    // The chat of a date that is no longer on. Deliberately says nothing about
    // why: the reason can be a block, and the blocked side must not learn it.
    coordProxyUnavailable: "This anonymous chat isn't available any more.",
    // Coordination card copy (services/coordination-card). Rendered INSIDE the
    // PNG, so: no emoji (the bundled fonts have no color-emoji glyphs and satori
    // drops them), and each `Head` line stays short (~18 Latin / ~14 Cyrillic
    // chars) — the display faces are wide and a wrapped third line breaks the
    // card's vertical rhythm.
    coordCardProxyKicker: "ANONYMOUS CHAT",
    coordCardProxyHead1: "The line",
    coordCardProxyHead2: "is open.",
    coordCardProxySub: "Messages go through me. No contacts are revealed.",
    menuPremium: "✨ Gennety Premium",
    menuPremiumActive: "✨ Premium · until {date}",
    menuInviteFriend: "🎁 Invite a friend",
    referralHubTitle: "Invite your friends to Gennety",
    referralHubTagline:
      "Every friend who passes verification via your link earns you a date ticket 🎟 — and they get one too.",
    referralShareButton: "📤 Invite a friend",
    referralShareCaption: "Gennety finds your best match and sets up the meeting itself.",
    referralShareJoin: "Join Gennety 💫",
    // --- HDYHAU (онбординговый вопрос об источнике, `shared/hdyhau.ts`) ---
    hdyhauQuestion: "Last thing — how did you hear about us?",
    hdyhauFriendInPerson: "A friend told me in person",
    hdyhauFriendOnline: "A friend sent me a link",
    hdyhauSocialMedia: "Social media",
    hdyhauSearch: "Through search",
    hdyhauAd: "An ad",
    hdyhauEvent: "An event or party",
    hdyhauOther: "Somewhere else",
    hdyhauSkip: "Skip",
    hdyhauThanks: "Thanks — that genuinely helps. 💛",
    referralRewardDm:
      "{name} passed verification via your link.\n\nCredited: +{tickets} 🎟\n{next}",
    referralRewardNext: "Invite rewards left: {remaining}.",
    referralRewardNextMax: "That was your last invite reward — thank you 💛",
    referralCardInvitedBy: "Invited by {name}",
    referralCardInvitedGeneric: "You're invited",
    referralCardHeadA: "Real dates.",
    referralCardHeadB: "Zero texting.",
    referralCardSupport:
      "Gennety finds your match on deep compatibility and sets up the meeting in person.",
    referralCardGift: "{ticketsPhrase} — on us",
    referralCardFooter: "gennety.com",
    premiumHubTitle: "✨ Gennety Premium",
    premiumHubBody:
      "*Gennety Premium*\n\n• *Unlimited dates* — your ticket is covered every time, however often you go\n• *Every evening time* — the late slots in the calendar stay open for you\n• *Top venues* — a selection of places a level above\n• *Free venue changes* — up to twice per date, no fee",
    premiumHubActiveNote: "You're Premium ✨ Active until {date}.",
    premiumOpenCta: "Learn more",
    premiumCancelHint:
      "You can cancel anytime — just tell me here, and I'll do it once you confirm.",
    premiumManageNote: "Manage or cancel anytime in Telegram → Settings → Subscriptions.",
    premiumWelcomeDm:
      "Welcome to Gennety Premium ✨\n\nYour dates are covered from now on — no ticket needed. Every evening time in the calendar is open to you, venue changes are on us, and the premium venue tier is unlocked. Active until {date}.",
    premiumExpiring3d:
      "Your Gennety Premium runs out on {date} — three days from now.\n\nNothing renews automatically on this plan, so covered dates, free venue changes and the premium venue tier stop on that day. Pick your next stretch below — a month, or 3 / 6 months at a lower rate.",
    premiumExpiring1d:
      "Last day of your Gennety Premium — it ends {date}.\n\nAfter that, dates go back to costing a ticket and the premium venues lock again. One tap picks the next period: a month, or 3 / 6 months at a lower rate.",
    premiumExpiringCta: "Choose a plan",
    // Stars top-up warning for a RECURRING subscriber (§3.8). Distinct from
    // premiumExpiring* above: nothing is ending here — the charge is coming,
    // and it fails on an empty balance. `{amount}` is premiumRenewalAmount or
    // an empty string, so the sentence has to read correctly BOTH ways.
    premiumRenewal3d:
      "Telegram renews your Gennety Premium in three days, on {date}.{amount}\n\nStars are charged from your Telegram balance — Telegram will not fall back to a card. If there are not enough Stars on the day, the renewal fails and Premium pauses, so it is worth topping up in advance: Settings → My Stars.",
    premiumRenewal1d:
      "Telegram renews your Gennety Premium tomorrow, {date}.{amount}\n\nThe charge comes out of your Telegram Star balance and there is no card fallback — if the balance is short tomorrow, the renewal fails and Premium pauses. Topping up takes a moment: Settings → My Stars.",
    premiumRenewalAmount: " It costs {stars} ⭐.",
    premiumPlanMonthly: "1 month",
    premiumPlan3Months: "3 months",
    premiumPlan6Months: "6 months",
    premiumPlanSaveBadge: "−{pct}%",
    premiumPlanPerMonth: "{price}/mo",
    premiumPackageWelcomeDm:
      "Gennety Premium is yours for {months} months ✨\n\nDates covered, venue changes free, premium venues unlocked — through {date}. This one doesn't auto-renew, so I'll remind you before it runs out.",
    premiumInvoiceTitle: "Gennety Premium",
    premiumInvoiceDesc:
      "Monthly subscription — free venue changes + premium venues. Renews every 30 days; cancel anytime.",
    premiumInvoiceLabel: "Gennety Premium — 1 month",
    premiumCheckoutError: "Couldn't start that subscription. Try again in a moment.",
    premiumCancelConfirm:
      "Cancel Gennety Premium?\n\nPremium stays active until {date} — everything keeps working until then. After that it won't renew and nothing else is charged.",
    premiumCancelConfirmYes: "Yes, cancel",
    premiumCancelKeepBtn: "Keep Premium",
    premiumCancelFinalConfirm:
      "Last check — cancel Gennety Premium?\n\nPremium stays active until {date}, nothing changes before then. After this, auto-renew is off for good — want it back later, you'll pay again.",
    premiumCancelFinalYes: "Yes, cancel",
    premiumCancelFinalNoSoft: "No, keep it",
    premiumCancelFinalNoHard: "No, keep it",
    premiumCancelDone:
      "Done — auto-renew is off. Premium stays active until {date}, and nothing else will be charged. You can resubscribe anytime.",
    premiumCancelKept: "Keeping it ✨ Premium is active until {date}.",
    premiumCancelAppStore:
      "This subscription was bought through the App Store, so it can only be cancelled on your iPhone: Settings → [your name] → Subscriptions → Gennety Premium → Cancel. Your access stays until {date}.",
    premiumCancelNotActive: "You don't have an active Premium subscription right now.",
    premiumCancelReasonAsk:
      "Thanks for being with us 🤍 If you don't mind — what made you cancel? A word or two really helps us improve.",
    premiumCancelReasonSkipBtn: "Rather not say",
    premiumCancelReasonThanks: "Thank you — noted 🤍 You can bring Premium back anytime.",

    // --- Rematch (paid on-demand re-run, REMATCH_PRODUCT_SPEC.md) ---
    // Buyer-facing. The offer must state the honest terms BEFORE payment:
    // it buys an introduction, not a date, and only "found nobody" is refunded.
    rematchOfferFamine:
      "No match this time — it's not about you.\n\nI can search again right now: {price}. If I find no one, I'll refund your Stars.",
    rematchOfferFailed:
      "That one didn't land. Happens.\n\n" +
      "I can go again right now and bring you someone new — {price}.\n\n" +
      "It buys a new introduction, not a guaranteed date. If I find nobody, your Stars come straight back.",
    // He came looking for this himself (the pinned banner, or the concierge),
    // so the copy opens no wound: the other two variants answer a specific
    // disappointment, this one answers a question.
    rematchOfferNeutral:
      "Want me to go again right now? One new person, picked the same way: {price}.\n\n" +
      "It buys a new introduction, not a guaranteed date. If I find nobody, your Stars come straight back.",
    rematchOfferBtn: "Search again — {price}",
    // Pinned-banner entry. Deliberately carries NO price: the banner sits above
    // every conversation, and a permanent price there is a standing sales pitch.
    // The number appears one tap later, on the offer card, before any payment —
    // the same rule §3.8 applies to the Premium hub.
    statusButtonRematch: "Search now",
    rematchInvoiceTitle: "New search",
    rematchInvoiceDesc: "One more search, right now — a new person picked by Gennety.",
    rematchInvoiceLabel: "New search",
    rematchFound: "Found someone. Sending you the details now ✨",
    rematchNoCandidate:
      "I looked — there's nobody new for you in your city right now. Your Stars are back. You stay in the next round.",
    rematchRefundPending:
      "I found nobody new, and the refund didn't go through on the first try. I'm on it — your Stars will be back shortly.",
    rematchUndelivered:
      "I found someone, but I couldn't deliver the profile — that one's on us. Your Stars are back, and it didn't use up a rematch.",
    rematchUndeliveredPending:
      "I found someone, but I couldn't deliver the profile, and the refund didn't go through on the first try. I'm on it — your Stars will be back shortly.",
    rematchRefunded: "Your Stars for the new search are back ✨",
    rematchLimitReached:
      "You've used your extra searches for now. The next one opens in a few days — the regular round is still coming.",
    rematchUnavailable:
      "Can't start a new search right now. If you have a match in progress, finish that one first.",
    // Partner-facing gift framing. NEVER mentions payment, the buyer, or any
    // decision state — it is a prefix on her ordinary pitch.
    rematchGiftFamine:
      "I know I said there was no match for you last time. I kept looking — and found someone worth your time.",
    rematchGiftFailed:
      "The last one didn't work out. I went back to the search and found someone who fits you better.",
    rematchGiftNeutral:
      "I kept working on it — and there's someone I'd like you to meet.",
    rematchSearchStep1: "🔍 Starting a deep search",
    rematchSearchStep2: "Checking who is free in your city right now",
    rematchSearchStep3: "Matching on character and interests",
    rematchSearchStep4: "✨ Almost there — picking one",
    rematchCardOverline: "YOUR MATCHMAKER",
    rematchCardHeadline: "ONE MORE\nSEARCH",
    rematchCardSubline: "A new person, picked the same way.",
  },
  ru: {
    // --- Onboarding ---
    consentMessage:
      "*Привет! Это Gennety* 👋\n\nПрежде чем начать, прочитай Условия использования и Политику конфиденциальности и согласись с правилами хранения данных.",
    consentAgree: "Принимаю",
    consentPrivacyButton: "Политика конфиденциальности",
    consentTermsButton: "Условия использования",
    welcome: "*Gennety Dating*\nПодбираем пару и сразу назначаем свидание вживую.",
    chooseLanguage: "Выбери язык:",
    philosophyPitch:
      "*Здесь не нужно переписываться*\n\nЯ узнаю тебя, найду подходящего человека и сам договорюсь о времени и месте. Тебе останется только прийти. Поехали?",
    philosophyContinue: "Поехали 🚀",
    askEmail: "Напиши свою почту вуза — например, name@knu.ua",
    invalidEmail: "Это не похоже на почту вуза. Проверь адрес и пришли ещё раз.",
    otpSent: "Отправил код на *{email}*. Введи его сюда:",
    otpInvalid: "Не тот код. Попробуй ещё:",
    otpExpired: "Код устарел. Введи почту ещё раз — пришлю новый.",
    otpTooManyAttempts: "Слишком много попыток. Введи почту заново — пришлём новый код.",
    otpCooldown: "Подожди минутку перед повторной отправкой.",
    emailVerified: "Почта подтверждена ✨",
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
      "Почти готово! Пришли {min}–{max} фото, где хорошо видно тебя. Откровенные снимки нельзя. Видео тоже можно — главное, чтобы тебя было видно.",
    photoReceived: "Фото {n}/{max}",
    voicePromptSkipButton: "Без голосового",
    voicePromptSkipHint: "Пропустить — кнопка «{button}» внизу чата.",
    voicePromptPanelPlaceholder: "Зажми микрофон — секунд 15",
    voicePromptRecorded:
      "Записал — послушай. Пришли другое, если хочешь переписать, или «{button}», чтобы убрать.",
    voicePromptReviewDone: "✅ Готово",
    voicePromptSkipped: "Хорошо, обойдёмся без голосового.",
    voicePromptSaved: "Сохранил ✨ Твой мэтч услышит его перед тем, как ответить.",
    voicePromptTooShort: "Это меньше секунды — кнопку микрофона надо держать. Попробуй ещё раз, целься секунд на 15.",
    voicePromptTooLong: "Длинновато — уложись в 30 секунд, иначе такое просто не дослушивают. Запишешь ещё раз?",
    voicePromptUnsafe: "Такое я не могу поставить в анкету. Запиши другое — или пропусти, это по желанию.",
    voicePromptContactInfo: "Ники и номера лучше не называть — встречу я организую сам, в этом весь смысл. Запиши лучше что-нибудь про себя.",
    voicePromptUnavailable: "Не смог обработать запись. Пришли её ещё раз через минуту.",
    voicePromptPitchCaption: "{name}: голосовое для тебя",
    photoRejected:
      "На фото должно быть видно твоё лицо. Попробуй другой снимок.",
    photoDuplicate: "Это фото уже есть в профиле — пришли другое.",
    photoDuplicateNear: "Это фото уже есть в профиле — пришли другое.",
    photoUnsafeContent:
      "Это фото нельзя публиковать в профиле. Выбери другой снимок без откровенного контента.",
    photoFaceObscured:
      "На этом фото лицо закрыто. Пришли снимок, где его не скрывает маска или шарф.",
    photoMultipleFaces:
      "На фото должно быть видно твоё лицо. Попробуй другой снимок.",
    photoIdentityMismatch:
      "Все фото должны принадлежать одному человеку. Убедись, что твоё лицо есть на каждом снимке.",
    photoIdentityUncertain:
      "Не получилось надёжно сопоставить лицо. Пришли более чёткое фото с хорошим освещением и хорошо видимым лицом.",
    photoConsensusPending: "Пришли ещё одно фото — по двум снимкам я пойму, что на них ты.",
    photoConsensusOutlierRejected: "На одном фото другой человек — его я не добавил.",
    photoConsensusConfirmed: "Отлично, на всех фото ты ✨",
    photoConsensusNoPairCap:
      "Пока не вижу двух фото одного человека. Пришли ещё одно чёткое фото, где видно тебя.",
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
      "🎟️ *Бесплатный билет на свидание — твой!*\n\nЭто подарок за фото. Одно свидание = 1 билет. Баланс: *{balance}*",
    ticketRewardVideo:
      "🎟️ *Ещё один бесплатный билет — твой!*\n\nЭто подарок за видео. Одно свидание = 1 билет. Баланс: *{balance}*",
    ticketRewardStudent:
      "🎓 *Два бесплатных билета — твои!*\n\nЭто подарок за подтверждённую почту вуза. Одно свидание = 1 билет. Баланс: *{balance}*",
    welcomeGiftTicket:
      "*Первый билет — от меня* ❤️\n\nОбычно свидание стоит 1 билет (~$8.49). Этот — бесплатно, он уже в кошельке.",
    ticketStorePurchased: "✨ *Оплата прошла!* Билетов добавлено: *{count}*. Баланс: *{balance}*",
    ticketStoreCheckoutError: "Не удалось подтвердить оплату. Попробуй ещё раз.",
    premiumCheckoutAlreadySubscribed:
      "У тебя уже есть активная подписка Premium, поэтому оплата остановлена — ничего не списано.",
    paymentStuckDm:
      "Оплата прошла, но выдать покупку не получилось — сломалось на нашей стороне.\n\nНе плати второй раз. Мы уже знаем и либо выдадим, либо вернём звёзды.",
    ticketStoreInvoiceTitle: "Билеты Gennety",
    ticketStoreInvoiceDesc:
      "Пополнение кошелька: {count} 🎟️. Каждый билет покрывает одно свидание.",
    ticketGateInvoiceDesc: "Оплата свидания. Билетов: {count}. Один билет — на одного человека.",
    ticketStoreInvoiceLabel: "Билеты Gennety × {count}",
    onboardingFinalizeBlocked:
      "Пока не могу завершить настройку — на моей стороне не хватает пары данных. Попробуй ещё раз через минуту; если повторится, напиши в @gennetysupport, разберёмся.",
    onboardingPhotosNeedMore: "Фото: {count}/{min}. Пришли ещё {remaining}.",
    onboardingPhotosBonusOffer:
      "Нужные фото есть ✨\nЕщё {remaining} фото (до {threshold}) — и бесплатный билет. За короткое видео — ещё один.",
    onboardingPhotosBonusOfferAfterVideo:
      "Нужные фото есть, билет за видео — твой ✨\nЕщё {remaining} фото (до {threshold}) — и второй бесплатный билет.",
    onboardingPhotosBonusProgress:
      "Фото: {count}/{threshold}.\nЕщё {remaining} — и бесплатный билет твой.",
    onboardingPhotosBonusProgressAfterVideo:
      "Фото: {count}/{threshold}.\nЕщё {remaining} — и второй бесплатный билет твой.",
    onboardingPhotosPhotoBonusEarned:
      "Фото: {count}. Бесплатный билет за фото — твой ✨\nМожно добавить фото (до {max}) или видео — за него ещё один билет.",
    onboardingPhotosBothBonusesEarned:
      "Фото: {count}, видео есть — оба бесплатных билета твои ✨\nМожно добавить ещё фото (до {max}).",
    onboardingPhotosPhotoBonusEarnedMax:
      "Все {max} фото есть, билет за фото — твой ✨\nЗа короткое видео — ещё один бесплатный билет.",
    onboardingPhotosBothBonusesEarnedMax:
      "Все {max} фото и видео есть ✨\nОба бесплатных билета — твои.",
    onboardingPhotosOptional:
      "Нужные фото есть.\nМожно добавить ещё (до {max}) или короткое видео.",
    onboardingPhotosOptionalAfterVideo:
      "Нужные фото и видео есть.\nМожно добавить ещё фото (до {max}).",
    onboardingPhotosOptionalMax: "Все {max} фото есть.\nМожно добавить короткое видео.",
    onboardingPhotosOptionalMaxAfterVideo: "Все {max} фото и видео есть ✨",
    menuMyTickets: "🎟️ Мои билеты",
    ticketWalletText:
      "🎟️ *Мои билеты*\n\nБилетов: *{balance}*. Каждое свидание стоит 1 билет — докупить можно в любой момент.",
    ticketWalletOpenStore: "🎟️ Купить билеты",
    photosEnough: "Можешь скинуть ещё (до {max}) или жми кнопку.",
    photosDone: "Фото загружены ✨",
    profileReview:
      "Вот твой профиль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Всё ок?",
    profileConfirm: "Всё ок",
    profileEdit: "Поменять",
    onboardingComplete: "*Готово, ты в деле!* 🎉\n\nУже ищу тебе пару — напишу, как найду.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Дальше ➡️",
    finishOnboardingFirst:
      "Сначала заверши регистрацию — тогда меню и настройки станут доступны.\nНапиши /start, чтобы продолжить.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "*Последний шаг — подтверди, что это ты*\n\nСделай селфи, и я сравню его с фото в профиле. Фото, где не ты, я уберу.\n\nБез проверки предложений будет меньше.",
    verifyPitchMandatory:
      "*Последний шаг — подтверди, что это ты*\n\nСделай селфи, и я сравню его с фото в профиле. Если на фото не ты — сначала замени их. После проверки сразу начну искать пару.",
    verifyMandatoryNotice:
      "Верификация теперь обязательна для всех новых профилей — подбор пар начнётся сразу после её прохождения. Это займёт около минуты:",
    verifyReminderNudge:
      "Твой профиль готов — остался только шаг верификации. Это займёт около минуты, и подбор пар начнётся сразу после:",
    verifyBtnGo: "🟢 Пройти верификацию",
    verifyBtnSkip: "⚪️ Пропустить пока",
    verifySkipNudgeCaption:
      "Секунду — послушай это, прежде чем пропустить 👆",
    verifyBtnReconsider: "🟢 Всё-таки пройти верификацию",
    verifyBtnSkipConfirm: "🔴 Всё равно пропустить",
    // --- Photo re-upload path (a way back before/after verification) ---
    verifyBtnRedoPhotos: "📷 Загрузить другие фото",
    verifyBtnRedoPhotosSecondary: "📷 Сначала поменяю фото",
    verifyBtnAddPhotos: "📷 Добавить фото",
    verifyPhotosRequired:
      "Верификация сравнивает селфи с фото в твоём профиле — а их пока нет. " +
      "Сначала добавь хотя бы {min} своих фото, потом запусти проверку:",
    verifyBtnClearPhotos: "🗑 Удалить все и загрузить заново",
    verifyGateLocked:
      "Меню и подбор пар откроются сразу после верификации. Остался только этот шаг:",
    verifyPhotosRedoIntro:
      "Без проблем — вот твои текущие фото. Удали те, на которых не ты, и загрузи свои.",
    verifyPhotosRedoIntroRecheck:
      "Без проблем — вот твои текущие фото. Удали те, на которых не ты, и загрузи свои — как закончишь, я перепроверю их автоматически, новое селфи не понадобится.",
    verifyPhotosCleared: "Фото удалены. Пришли {min}–{max} своих фотографий.",
    verifyPhotosSavedRecheck:
      "Фото обновлены ✅ Перепроверяю их по селфи из верификации — проходить её заново не нужно. Напишу, как только закончу.",
    verifyPhotosSavedNowVerify:
      "Фото обновлены ✅ Остался последний шаг — верификация:",
    verifySkipped: "Проверка пропущена. Пройти её можно позже в меню профиля.",
    verifyCheckAlreadyDone:
      "Уже обработано — сообщение с результатом должно быть выше. " +
      "Если что-то пошло не так — нажми 🟢 Пройти верификацию ещё раз.",
    verifyRetryNotLive:
      "*Не получилось распознать лицо*\n\nВстань лицом к яркому свету, сними очки и нажми 🟢 Пройти верификацию ещё раз.",
    verifyRetryUnfinished:
      "*Проверка прервалась*\n\nПройди её за один раз, не сворачивая Telegram, — это секунд 15. Нажми 🟢 Пройти верификацию.",
    verifyRetryTechnical:
      "*Сбой на нашей стороне*\n\nНажми 🟢 Пройти верификацию ещё раз — теперь должно получиться.",
    verifyReferenceExpired:
      "Мы удаляем селфи с верификации через 90 дней, так что сверить новые фото " +
      "уже не с чем. Ещё одна проверка на 10 секунд — и всё готово. Профиль пока " +
      "остаётся активным:",
    verifyOutcomeVerified:
      "Проверка пройдена ✨ Профиль активен. Напишу, когда найду мэтч.",
    profilerHeadsUp:
      "Пока я ищу тебе человека, я буду время от времени задавать простые вопросы — " +
      "что смотришь, как проводишь выходные, что тебя цепляет.\n\n" +
      "Отвечай честно и не откладывай — чем лучше я тебя знаю, тем лучше подготовлю " +
      "вас обоих к встрече: с чего начать разговор и о чём лучше не заводить.",
    verifyOutcomePendingReview:
      "🔍 Мы дополнительно проверяем фото профиля по селфи из верификации. Обычно это занимает несколько часов — я напишу, как только проверка завершится.",
    verifyOutcomeRejected:
      "⚠️ *Фото не совпали с селфи*\n\nЕсли на них не ты — замени их кнопкой 📷, я перепроверю. Если ты — пройди проверку ещё раз при хорошем свете.",
    verifyPhotosDropped:
      "Один момент: часть фото не совпала с селфи из верификации, я убрал их из профиля. Всё остальное на месте. Добавь ещё пару своих снимков, когда будет удобно 📷",
    verifyPhotosBelowMinimum:
      "Верификация пройдена ✅\n\nНо часть фото не совпала с селфи, я их убрал, и теперь в профиле меньше {min} фотографий. Добавь ещё {need} своих — и я сразу начну искать тебе пару 📷",
    // --- Native-app push copy for the same verification outcomes (§1.4). Own
    // strings rather than reused DM copy: these land on a lock screen, so they
    // need a title, they must stay short, and they cannot point at a Telegram
    // keyboard ("tap 📷 below") that does not exist in the app.
    verifyPushVerifiedTitle: "Проверка пройдена ✨",
    verifyPushVerifiedBody: "Профиль активен. Напишу, когда найду мэтч.",
    verifyPushRejectedTitle: "Фото не совпали",
    verifyPushRejectedBody:
      "На фото в профиле не тот человек, что на селфи из верификации. Если это не ты — замени их, я перепроверю автоматически.",
    verifyPushPendingReviewTitle: "Проверяем фото",
    verifyPushPendingReviewBody:
      "Сверяем фото профиля с селфи из верификации. Обычно несколько часов — напишу, как только закончим.",
    verifyPushRetryTitle: "Остался один шаг",
    verifyPushRetryBody:
      "Профиль готов — не хватает только верификации. Это примерно минута, подбор начнётся сразу после.",
    verifyPushPhotosNeededTitle: "Добавь ещё {need} фото",
    verifyPushPhotosNeededBody:
      "Верификация пройдена, но в профиле меньше {min} фотографий. Добавь ещё {need} своих — и я начну искать.",
    verifyPushPhotosDroppedTitle: "Часть фото убрана",
    verifyPushPhotosDroppedBody:
      "Некоторые не совпали с селфи из верификации, я убрал их из профиля. Всё остальное на месте.",
    verifyMiniAppLoading: "Открываем верификацию…",
    verifyMiniAppFinishing: "Готово. Проверяем результат…",
    verifyMiniAppError: "Не удалось запустить проверку. Попробуй ещё раз.",
    verifyMiniAppCloseBtn: "Закрыть",
    photoMatchMismatch:
      "⚠️ Это фото не совпадает с селфи из верификации. " +
      "Загрузи чёткое фото себя при похожем освещении.",

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
    // --- Relationship intent (PRODUCT_SPEC §1.3) ---
    intentSpark: "Яркая история",
    intentOpen: "Посмотрим, куда приведёт",
    intentFalling: "Влюбиться",
    intentLongterm: "Всерьёз и надолго",
    intentPrivateNote: "видно только тебе",
    myProfileIntentLine: "🎯 Ты ищешь: {intent}",
    myProfileIntentUnset: "🎯 Ты ищешь: не выбрано",
    editIntentBtn: "🎯 Что я ищу",
    editIntentPrompt:
      "Что ты сейчас ищешь? Отметь всё, что подходит — обычно это не одно.\n\nЭто видишь только ты — нужно, чтобы точнее подбирать пару.",
    editIntentCleared: "Ничего не выбрано",

    // --- Edit Profile ---
    editProfileBody:
      "Это поменять нельзя:\n\n• *Имя:* {firstName} {surname}\n• *Возраст:* {age}\n• *Универ:* {university}\n\nМожно поменять:",
    editBioBtn: "📝 О себе",
    editPrefsBtn: "💘 Кого ищу",
    editMajorBtn: "💼 Чем занимаешься",
    editProfilePhotosBtn: "📸 Мои фото",
    editBioPrompt:
      "Напиши пару строк о себе (до 500 символов) — мэтч прочитает их перед свиданием.",
    editBioCurrent: "Сейчас написано так. Новый текст заменит его:",
    editBioTooLong: "Слишком длинно — уложись в 500.",
    editBioSaved: "«О себе» обновлено",
    editMajorPrompt:
      "Чем занимаешься? (работа / учёба / сфера, до 100 символов)\n👀 Видно твоей паре.",
    editMajorTooLong: "Слишком длинно — уложись в 100.",
    editMajorSaved: "Сохранено",
    editPrefsTitle: "💘 *Кого ищу*\n\nЧто меняем?",
    editPrefsAgeBtn: "🎂 Возраст партнёра",
    editPrefsDescriptionBtn: "✨ Какого человека ищу",
    editPrefsCurrent:
      "Текущие настройки:\n• Человек: {preferences}\n• Возраст: {ageRange}",
    editPrefsNotSet: "Не задано",
    editPrefsDescriptionPrompt: "Опиши, какого человека хочешь встретить (до 500 символов).",
    editPrefsDescriptionEmpty: "Добавь короткое описание — оно не может быть пустым.",
    editPrefsDescriptionTooLong: "Слишком длинно — уложись в 500.",
    editPrefsDescriptionSaved: "Предпочтения обновлены",
    editHobbiesSaved: "Интересы обновлены",
    agentEntryPrompt: "Держи:",
    agentFallbackError: "Что-то пошло не так. Повтори, пожалуйста.",
    agentBlockedVerification: "Сначала пройди верификацию — дальше откроется всё остальное.",
    agentBlockedSuspended:
      "Аккаунт сейчас на паузе с нашей стороны, так что тут не помогу. Вопросы — в @gennetysupport.",
    agentBlockedInvestigation:
      "Аккаунт сейчас на проверке. Пока делать нечего — подробности расскажут в @gennetysupport.",
    agentBlockedBanned: "Этот аккаунт закрыт. Если считаешь, что это ошибка — напиши в @gennetysupport.",
    profileEmbeddingSyncPending: "Сохранено. Учту при следующем подборе.",
    editPrefsBack: "⬅️ К редактированию",
    editAgeRangePrompt: "В каком возрастном диапазоне искать тебе пару? (напр. 20-28)\nМин: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не понял. Два числа через дефис, напр. 20-28 (от {min} до {max}).",
    editAgeRangeSaved: "Диапазон обновлён",
    editProfilePhotosStart: "Скинь новые фото ({min}–{max}) — по одному или альбомом.",
    editProfilePhotosSaved: "Фото обновлены",
    editProfileSaved: "Профиль обновлён",
    photoManagerTitle: "Фото: {count}/{max} · минимум {min}",
    photoManagerCardDeleteBtn: "🗑 Удалить это фото",
    photoManagerCardRemoved: "🗑 Фото удалено",
    photoManagerAddBtn: "➕ Добавить",
    photoManagerDoneBtn: "Готово",
    photoManagerMinReached: "Нужно минимум {min} фото. Сначала добавь новое.",
    photoUploadStep1: "Загружаю фотографии…",
    photoUploadStep2: "Проверяю кадры…",
    photoUploadStep3: "Ещё пара секунд…",
    photoUploadOneStep1: "Загружаю фото…",
    photoUploadOneStep2: "Проверяю кадр…",
    photoReviewStep1: "Смотрю твои фото…",
    photoReviewStep2: "Просматриваю кадры…",
    photoReviewOneStep1: "Смотрю твоё фото…",
    photoReviewOneStep2: "Просматриваю кадр…",
    photoBatchAdded: "Добавлено: {n} · в профиле {total}/{max}",
    photoBatchNoneAdded: "Из этой партии ничего не добавилось.",
    photoBatchAtMax: "Достигнут лимит в {max} фото — удали одно, чтобы добавить новое.",
    photoManagerDeleted: "Фото удалено.",
    photoStagePanelBtn: "🗂 Мои фото",
    photoStagePanelPlaceholder: "Пришли ещё фото или нажми 🗂",
    photoEditorIntro:
      "Вот все твои фото. Нажми 🗑 под любым фото, чтобы убрать его, или пришли новые прямо сюда.",
    photoEditorBackBtn: "← Вернуться к загрузке",
    menuVideo: "🎬 Видео профиля",
    editVideoPrompt:
      "🎬 Пришли короткое видео для профиля (до {sec} сек, не больше {mb} МБ). Друзья, пейзаж или клип с вечеринки — всё подойдёт, видео оживляет анкету.",
    editVideoRewardLine: "🎁 Добавь видео сейчас и получи бесплатный билет на свидание.",
    editVideoHasOne:
      "У тебя уже есть видео в профиле. Пришли новое, чтобы заменить, или удали его кнопкой ниже.",
    editVideoRemoveBtn: "🗑 Удалить видео",
    editVideoRemoved: "Видео из профиля удалено.",
    editVideoNotAVideo: "Пришли *видео* (до {sec} сек, не больше {mb} МБ).",
    myProfileAddVideoHint:
      "🎬 Совет: добавь короткое видео в профиль через меню — так анкета заметнее.",
    myProfileAddVideoHintReward:
      "Совет: добавь короткое видео в профиль через меню и получи бесплатный билет 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Поиск на паузе ⏸\nНовых мэтчей не будет, пока не включишь.",
    resumeConfirmed: "Поиск запущен ▶️\nЯ уже в деле.",

    // --- Settings ---
    settingsTitle: "⚙️ Настройки",
    settingsLanguage: "🌐 Язык",
    settingsLanguagePick: "Выбери язык:",
    settingsLanguageSaved: "Язык обновлён",
    settingsTheme: "🎨 Тема",
    settingsThemePick: "Выбери оформление:",
    settingsThemeSaved: "Тема обновлена",
    themeDarkOption: "🌙 Тёмная",
    themeLightOption: "☀️ Светлая",
    helpBody:
      "*Нужна помощь?*\n\nПроблема с мэтчем, свиданием или ботом — напиши в поддержку:\n\n💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Удалить аккаунт",
    deleteAccountConfirm:
      "*Удалить аккаунт навсегда?*\n\nПропадут профиль, фото и мэтчи. Отменить это нельзя.",
    deleteAccountYes: "Да, удалить всё",
    deleteAccountNo: "Отмена",
    deleteAccountDone:
      "Аккаунт удалён. Все данные стёрты.\n" +
      "Захочешь вернуться — отправь /start.",
    deleteAccountFailed:
      "Сейчас не удалось безопасно удалить все данные. Аккаунт сохранён — попробуй ещё раз.",
    deleteAccountRefundInProgress:
      "По твоему аккаунту ещё идёт возврат, и если удалить аккаунт сейчас, деньгам некуда будет вернуться. Ничего не удалено — попробуй ещё раз, когда возврат пройдёт.",
    accountActionExpired: "Подтверждение устарело. Открой действие заново.",
    statusActionUnavailable: "Это действие недоступно для текущего статуса аккаунта.",
    deleteFreezeIntro:
      "Подожди — прежде чем всё удалять 👀\n\nНеобязательно терять всё. Лучше *заморозь* аккаунт: профиль, фото и верификация останутся, ты пропадёшь из подбора, а в следующий раз просто отправишь /start — и сразу попадёшь в свой готовый профиль, без повторной регистрации.\n\nВсё-таки удалить? Это уже навсегда.",
    deleteFreezeBtn: "❄️ Заморозить аккаунт",
    deleteProceedBtn: "Всё равно удалить аккаунт",
    freezeConfirmed:
      "Готово — аккаунт *заморожен* ❄️\n\n" +
      "Тебя не видно в подборе и я не буду писать. " +
      "Возвращайся когда угодно через /start — всё на месте.",
    freezeWelcomeBack: "*С возвращением!* Аккаунт разморожен.",
    deleteFinalYes: "Да, удалить",
    deleteFinalNoSoft: "Нет, оставить",
    deleteFinalNoHard: "Нет, оставить",
    freezePartnerNotice:
      "Важное: твой мэтч больше недоступен, так что это свидание не состоится. " +
      "Не переживай — в следующем подборе у тебя будет приоритет 💛",

    // --- Matching ---
    matchHeadline: "💘 Нашли тебе мэтч!",
    matchDeadlineNotice: "На ответ 24 часа. Передумать потом нельзя.",
    matchStreamStart: "Почему вы подходите…",
    matchBtnAccept: "Принять",
    matchBtnDecline: "❌ Пас",
    matchDeclineConfirmPrompt:
      "Точно пасуешь?\n\nЭто решение окончательное — этого человека ты больше не увидишь.",
    matchBtnConfirmDecline: "❌ Да, пас",
    matchBtnKeepDeciding: "← Назад",
    matchDecisionQuestionM:
      "Хочешь пойти с ним на свидание? Просто ответь да или нет.",
    matchDecisionQuestionF:
      "Хочешь пойти с ней на свидание? Просто ответь да или нет.",
    matchTextYesConfirm: "Отлично ✨ Подтверди — и дальше всё сделаю я:",
    matchBtnConfirmGo: "💫 Да, иду на свидание",
    matchTextUnsure:
      "Не спеши — когда решишь, просто напиши мне «да» или «нет».",
    matchDeclineDismissed:
      "Без спешки — этот мэтч всё ещё ждёт твоего ответа. 💛",
    matchAcceptedToast: "Принято",
    matchDecisionSavedToast: "Записал",
    matchAccepted: "Принято ✨ Ждём вторую сторону.",
    matchBothAccepted: "Взаимно 🤍 Найдём время.",
    matchDeclined:
      "Понял. Что не подошло? Выбери вариант или напиши своими словами — учту в следующий раз.",
    matchDeclineReasonType: "Не мой тип внешне",
    matchDeclineReasonVibe: "Не тот вайб",
    matchDeclineReasonInterests: "Не совпали интересы",
    matchDeclineReasonLifestyle: "Разный образ жизни",
    matchDeclineReasonOther: "Другая причина",
    matchDeclineOtherAsk:
      "Ок — отправь короткий текст или голосовое с причиной. Учту в следующем подборе.",
    matchDeclineFeedbackSaved:
      "Принял. Следующий подбор настрою с учётом этого.",
    matchDeclineAlreadyNoted: "Уже записал — спасибо.",
    matchDeclineFeedbackFailed:
      "Не получилось сохранить прямо сейчас. Можешь всё равно отправить короткий текст или голосовое.",
    matchDeclineThanks: "Понял. Ищу дальше.",
    matchPeerDecided: "*Твой мэтч уже ответил*\n\nЧто именно — узнаешь после своего ответа.",
    matchPeerWasAccepted: "Кстати — твой мэтч был согласен. В этот раз просто не сошлось.",
    matchPeerWasDeclined: "Кстати — твой мэтч в этот раз отказался.",
    matchAcceptedPeerDeclined:
      "В этот раз с той стороны — нет. Бывает: здесь свидание случается только при взаимном интересе. " +
      "Ищу дальше — следующий вариант будет ближе.",
    matchAcceptedPeerDeclinedPriority:
      "В этот раз с той стороны — нет. Бывает: здесь свидание случается только при взаимном интересе.\n\nЯ поднял твой приоритет в следующем подборе. Следующий вариант будет ближе.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Подтверждён",
    matchVerifiedQuote: "Проверено: на фото действительно этот человек.",
    matchSynergyLabel: "Совместимость {score}/99",
    matchSynergyHeader: "💎 {label} — {reason}",
    pitchCountdownHours: "⏳ Осталось {hours}ч на ответ",
    pitchCountdownMinutes: "⏳ Осталось {minutes} мин на ответ",
    pitchDeadlineBtnHm: "⏳ Осталось на ответ: {h}ч {m}м",
    pitchDeadlineBtnMin: "⏳ Осталось на ответ: {m}м",
    pitchCountdownTapToast: "Просто скажи да или нет, когда решишь — окно ещё открыто ✨",
    pitchDeadlineNudge:
      "Небольшое напоминание — окно, чтобы ответить на этот мэтч, закроется примерно через {hours}ч. Если хочешь пойти, просто скажи да сейчас; если нет — тоже окей.",
    stallPartnerFallbackName: "твой мэтч",
    stallActionExpired: "Здесь уже всё решилось — отвечать больше не нужно.",
    matchCardExpiredAlert: "Эта карточка мэтча уже неактивна — решать здесь больше нечего.",
    emergencyStaleAction: "Это свидание уже неактивно. Проверь актуальный статус перед новым действием.",
    calendarStaleAction: "Этот календарь уже закрыт. Открой актуальную карточку мэтча, чтобы увидеть изменения.",
    stallVenueNudge:
      "Осталось отметить, откуда поедешь — и я подберу место, удобное вам обоим.",
    stallCheckInScheduling:
      "{name} ждёт — вы остановились на выборе времени.\nВсё ещё в силе?",
    stallCheckInVenue:
      "{name} ждёт — вы остановились на выборе места.\nВсё ещё в силе?",
    stallBtnStillOn: "🟢 Да, всё в силе",
    stallBtnPlansChanged: "Планы изменились",
    stallPeerAsked: "Напомнил {name} про тебя — жду ответа.\n\nОт тебя пока ничего не нужно.",
    stallStillOnAck: "Понял, всё в силе ✨",
    stallPeerStillOn: "{name} на связи, всё в силе ✨",
    stallCancelConfirmPrompt:
      "Отменяем свидание с {name}?\n\nРешение окончательное — эту пару я больше не предложу.",
    stallBtnCancelConfirm: "🔴 Да, отменить",
    stallBtnCancelBack: "🟢 ← Назад",
    stallCancelAborted: "Хорошо — всё в силе. 👍",
    stallCancelDone:
      "Понял. {name} я предупредил — без подробностей.\n\nТы снова в подборе.",
    stallPeerCancelled:
      "Свидание отменено — у {name} изменились планы.\n\n" +
      "Это не про тебя. Поднял твой приоритет в следующем подборе.",
    stallTimeoutPartnerGone:
      "Свидание отменено — от {name} так и не было ответа.\n\n" +
      "Обидно, но лучше сейчас, чем в день встречи. Поднял твой приоритет в следующем подборе.",
    stallTimeoutSelf:
      "Свидание с {name} отменено — ответа не было двое суток, " +
      "а держать вас обоих в подвешенном состоянии я не мог.\n\n" +
      "Если планы меняются — просто напиши мне. Это нормально.",
    stallTimeoutVenueUnresolved:
      "Свидание с {name} отменено — я так и не смог вовремя подобрать вам место.\n\n" +
      "Это не ваша вина, а моя. Поднял твой приоритет в следующем подборе.",
    pitchExpired: "⏳ Время вышло — предложение больше не актуально.",
    matchExpiredSilentWarning:
      "*Время на ответ вышло*\n\nВ следующий раз ответь хотя бы «нет» — человек ждёт.",
    matchExpiredSilentPenalty:
      "*Время на ответ вышло*\n\nЭто уже второй раз, поэтому рейтинг снижен. В следующий раз ответь хотя бы «нет» — человек ждёт.",
    matchExpiredYouMissedDate:
      "Важно: твой мэтч был согласен прийти — это могло быть настоящее свидание.\n\n",
    matchExpiredPeerIgnored:
      "Твой мэтч не ответил за сутки — свидание не состоится. Увидимся в следующем подборе.",
    // §3.4 — this side PASSED, and the partner then went silent. A first
    // decision leaves the row `proposed` either way, so a decliner reaches
    // expiry classified as a `responder` exactly like someone who accepted
    // and got stood up. They already got their "you passed" ack, so this is
    // deliberately a bare fact with no consolation and no card: it exists
    // only so the match doesn't vanish from the menu and banner unexplained.
    matchExpiredSelfDeclined: "Мэтч закрыт. Увидимся в следующем подборе.",
    // Карточка истечения (PRODUCT_SPEC §3.4). Заголовки намеренно
    // гендерно-нейтральны: род пользователя на карточку не подставляется,
    // а форма «ответил(-а)» в крупном заголовке нечитаема.
    expiryCardOverlineExpired: "ОКНО ЗАКРЫТО",
    expiryCardHeadlineExpired: "ВРЕМЯ\nВЫШЛО",
    expiryCardSublineExpired: "Прошло 24 часа без ответа.\nЖдём тебя в следующем подборе.",
    expiryCardOverlinePenalty: "ВТОРОЙ РАЗ БЕЗ ОТВЕТА",
    expiryCardHeadlinePenalty: "РЕЙТИНГ\nПОНИЖЕН",
    expiryCardSublinePenalty: "Второй мэтч без ответа.\nЖдём тебя в следующем подборе.",
    expiryCardOverlinePeerIgnored: "ЭТО НЕ ПРО ТЕБЯ",
    expiryCardHeadlinePeerIgnored: "ПАРА НЕ\nОТВЕТИЛА",
    expiryCardSublinePeerIgnored:
      "Свидание не состоится.\nТвоя часть была сделана вовремя.",
    expiryCardOverlineMissedDate: "ТЕБЕ СКАЗАЛИ ДА",
    expiryCardHeadlineMissedDate: "ЭТО БЫЛО\nВЗАИМНО",
    expiryCardSublineMissedDate:
      "Пара была готова встретиться.\nЗа 24 часа ответа не было.",
    expiryCaptionSilentWarning: "В следующий раз ответь хотя бы «нет» — человек ждёт.",
    expiryCaptionSilentPenalty:
      "Это уже второй раз, поэтому рейтинг снижен. В следующий раз ответь хотя бы «нет» — человек ждёт.",
    expiryCaptionPeerIgnored: "Увидимся в следующем подборе.",
    noMatchThisWeekTier1:
      "*На этой неделе без мэтча*\n\nНе нашёл того, кто правда подходит, а предлагать кого попало не хочу. В следующем подборе у тебя приоритет ✨",
    noMatchThisWeekTier2:
      "*Снова без мэтча*\n\nВторую неделю подряд не вижу того, кто правда подходит. Спасибо, что ждёшь — в следующем подборе твой приоритет ещё выше 🤍",
    noMatchThisWeekTier3:
      "*Пока без мэтча*\n\nПодходящего человека всё ещё нет, а предлагать кого попало я не буду. Слежу за твоей очередью — в следующем подборе ты среди первых 🤍",
    noMatchDiscountOffer:
      "🎟️ Небольшая благодарность за терпение: твоё следующее первое свидание — со скидкой {pct}% на один билет. " +
      "Мы применим скидку автоматически, когда тебе выпадет пара или ты откроешь свои билеты.",
    poolExhaustedPauseNotice:
      "*Ставлю поиск на паузу*\n\nСейчас для тебя правда никого нет — дело не в тебе. Как появится подходящий человек, сам верну тебя в поиск.",
    poolExhaustedResumeNotice:
      "Хорошие новости — появился тот, кто подходит, и я вернул тебя в поиск. Ты в следующем подборе 🤍",
    matchSchedulePeerProposed:
      "Твой мэтч уже отметил время в календаре. Открой — согласись или предложи своё:",
    matchSchedulePeerSuggestedAlternative:
      "Твой мэтч предложил другое время. Глянь — можно согласиться или предложить свой вариант.",
    matchScheduleSavedConfirmation: "Готово. Твой мэтч получил уведомление — напишу, как ответит.",
    matchScheduleNoOverlapYet:
      "Вы оба отметили время, но пока ничего не совпало. Добавь ещё пару слотов — как только один пересечётся, фиксирую дату:",
    matchSchedulePickFinalYet:
      "Ваши календари уже совпали — открой его и подтверди удобное время, и дата зафиксирована:",
    matchScheduleProposal: "Как тебе эти варианты? Жми подходящий:",
    matchScheduleIter3:
      "Взаимно 🤍 Открой календарь и отметь удобное время.",
    matchScheduleAfterTicket:
      "📅 Теперь выбери время — открой календарь и отметь все удобные слоты.",
    matchScheduleBtnCalendar: "📅 Открыть календарь",
    // --- Date Ticket (премиум-шаг после взаимного метча) ---
    ticketCardCaption: "Это мэтч 🤍 Возьми билет — и выберем время.",
    ticketCardCaptionPremium: "Это мэтч 🤍 Premium покрывает оба билета — сразу выбираем время.",
    ticketButton: "🎟️ Получить билет на свидание",
    ticketViewButton: "🎟️ Посмотреть свой билет на свидание",
    ticketStatusButton: "Открыть свидание",
    ticketGateWaiting: "Билет готов ✨ Ждём вторую сторону.",
    ticketPeerTookTheirs:
      "{name} уже с билетом на свидание 🎟️ Остался твой — и откроем планирование.",
    bumpVerifiedDm:
      "Вы оба на месте ✨ Свидание засчитано, а билет на следующее — от меня.",
    bumpDeckIntro: "Если разговору понадобится, куда пойти:",
    ticketBothSecuredDm: "Оба билета у вас 🎟️ Свидание в силе — давай выберем время.",
    ticketPartnerPaidDm: "{name} уже оплатил твой билет на свидание ❤️ Тебе ничего не нужно делать.",
    ticketCoveredHerConfirm:
      "💛 Готово — ты оплатил билет за {name}. Как только она это увидит, я дам тебе знать.",
    ticketPartnerSawItDm: "❤️ {name} увидела, что ты оплатил её билет.",
    ticketRefundedDm: "Твой билет вернулся в кошелёк, а свидание в силе. Давай выберем время 📅",
    ticketRefundedToWallet:
      "🎟️ Билет вернулся в твой кошелёк — используешь его на следующем свидании.",
    ticketRefundedToWalletBoth:
      "🎟️ Оба билета, которые ты оплатил, вернулись в твой кошелёк — используешь их на следующем свидании.",
    matchScheduleNoOverlap: "Не совпало — попробуем ещё.",
    matchScheduled: "Готово — до встречи 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 В час пик там может не оказаться мест — это ок: можно взять кофе с собой и прогуляться или заглянуть в другое место рядом.",
    matchScheduledBtnOpenMaps: "📍 Открыть в картах",
    matchScheduledBtnShare: "📤 Поделиться карточкой",
    dateCardWhen: "КОГДА",
    dateCardSlogan: "Без переписки\nСразу вживую",
    dateCardShareCaption:
      "Делись смело — лицо твоего мэтча скрыто, чтобы сохранить его приватность 💞",
    dateCardShareFailed: "Не получилось подготовить карточку для отправки — попробуй через минуту.",
    matchSchedulePickedPrefix: "Твой выбор: ",
    matchScheduleWaitingPeer: "Ждём выбор второй стороны…",
    venueTimeCardLabel: "ВАШЕ СВИДАНИЕ",
    venueTimeLockedCaption: "Время вашего свидания закреплено ✨",
    venueConciergeIntro:
      "*Откуда поедешь на свидание?*\n\nОтметь точку на карте — дом, метро, любое удобное место. Подберу место, куда удобно добраться вам обоим.",
    venueConciergeBtnLocation: "📍 Отправить геолокацию",
    venueConciergeBtnMap: "🗺️ Выбрать на карте",
    venueLocationFirst:
      "Сначала самое главное — *отметь, откуда ты будешь выезжать* 📍 Нажми кнопку ниже и поставь точку на карте.",
    venueOriginOutsideMarket:
      "Эта точка за пределами {city}, а Gennety пока работает только там — я ищу место недалеко от вас обоих, и оттуда подобрать не смогу. Отметь точку в {city}, откуда будешь выезжать:",
    venueVibeNoted: "Вайб записан ✨ Теперь укажи, откуда поедешь:",
    venueLocationNoted:
      "Точку выезда сохранил ✨ Теперь — какой *вайб* хочешь? Например: _тихое кафе_, _веган-завтрак_, _прогулка в парке_, _небольшой музей_.",
    venueSafetyOverride:
      "Небольшое уточнение — заменил на публичное кафе. Первые свидания у нас в людных местах.",
    venueWaitingPeer: "Принял ✨ Ждём вторую сторону…",
    venueLocationUseMap:
      "Геоточки из чата больше не попадают в поиск места — отметь точку отправления на карте ниже 📍",
    venueTimeLapsedBackToCalendar:
      "До времени свидания осталось слишком мало, чтобы успеть подобрать место, — давай выберем новое.",
    venueSelectionFailedRetry:
      "Не получилось подобрать место для свидания — поиск мест дал сбой на нашей стороне. Открой экран места и ещё раз подтверди точку отправления, чтобы попробовать снова.",
    peerWaitT1Sent: "Передали {name}, ждём ответа",
    peerWaitT2Waiting: "{name} ещё думает над ответом",
    peerWaitT3Quiet: "{name} пока молчит, ждём",
    peerWaitT4Nudged: "Напомнили {name} о тебе, ждём ответа",
    peerWaitT5Deadline: "{name} долго не отвечает",
    peerWaitAnon: "Ждём вторую сторону",
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
    onbAnalyzeStep1b: "💭 Думаю…",
    verifyAnalyzeStep1: "🔍 Сверяю селфи с фото…",
    verifyAnalyzeStep2: "🧬 Анализирую черты лица…",
    verifyAnalyzeStep3: "⏳ Завершаю проверку…",
    voiceCheckStep1: "🎧 Слушаю твою запись…",
    voiceCheckStep2: "Проверяю, что всё в порядке…",
    videoCheckStep1: "🎬 Просматриваю твоё видео…",
    videoCheckStep2: "🙂 Проверяю, что это ты…",
    videoCheckStep3: "✨ Почти готово…",
    skipAnalyzeStep1: "✨ Дорабатываю профиль…",
    skipAnalyzeStep2: "🧮 Свожу всё воедино…",
    skipAnalyzeStep3: "💞 Готовлю к подбору…",
    profilerBatchThinking: "Думаю…",
    profilerBatchSaving: "Сохраняю твои ответы…",
    profilerBatchSaved:
      "Карточка обновлена ✨ Учту при следующем подборе.",
    profilerNextAck: "Принято…",
    profilerNextFormulating: "Думаю…",
    profilerRefusalAck: "Окей, не буду допытываться. Спрошу в другой раз 💛",
    profilerImageUnreadable: "Хм, не смог разобрать 😅 Расскажи словами?",
    profilerLinkUnreadable: "Не могу открыть — видимо, приватное или удалено 😅 Расскажи словами или скинь картинкой?",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "🔄 Сменить место",
    venueBoardPingFromF: "{name} присматривает местечко поуютнее для вашего свидания 👀",
    venueBoardPingFromM: "{name} предлагает взглянуть на пару других мест для вашего свидания 👀",
    venueBoardPingBtn: "Взглянуть",
    venueKeepNotice: "Твой мэтч хотел бы остаться в {venue}. Можно предложить другое место ниже.",
    venueBothKeepDm: "Вы оба остаётесь в {venue} — ничего не меняется, до встречи.",
    venueDeclinedKeepDm: "Остаётесь в {venue}, как и планировали.",
    venueChangeRefunded:
      "Смена места не прошла, звёзды вернулись к тебе. Свидание в силе — в том месте, о котором договаривались изначально.",
    primeInvoiceTitle: "Поздние вечера",
    primeInvoiceDesc:
      "Откроет 18:30, 19:00 и 19:30 во все дни вашего календаря — для вас обоих, на это свидание.",
    primeInvoiceLabel: "Поздние вечера",
    primeTimeOpenedDm:
      "{name} открывает поздние вечера — 18:30 и позже теперь есть в вашем календаре.",
    primeTimeRefunded:
      "Поздние вечера не открылись, звёзды вернулись к тебе. Остальной календарь без изменений.",
    primeTimeRefundedDateOff:
      "Свидание не состоится, поэтому звёзды за поздние вечера вернулись к тебе.",
    memeCardTeaser:
      "🎭 Ещё кое-что про {name}.\n\nКогда я спросил, что по-настоящему смешит, ответа словами не было — прилетел мем. Это говорит о человеке больше, чем любые три предложения.\n\nХочешь увидеть его до встречи?",
    memeCardBtn: "🎭 Показать",
    memeRevealCaption: "🎭 Что смешит {name}:",
    memeRevealSource: "▶️ Посмотреть целиком:",
    memeRevealFallback:
      "🎭 Саму картинку переслать не вышло, поэтому словами. {name} — о том, что смешит:\n\n_{description}_",
    memeRevealGone: "На этот вопрос ответили заново словами — мема здесь больше нет.",
    memeRevealUnavailable: "Эта карточка уже неактивна.",
    venuePayPromptDm: "Вы вместе выбрали новое место для свидания.\n\n📍 {venue}",
    venuePayOpenBtn: "📍 Посмотреть и решить",
    venueWishText:
      "{name} нашла место, которое ей очень нравится.\n\n" +
      "Ей будет приятно, если закрепишь его ты.",
    venueWishTextFallback:
      "{name} нашла место, которое ей очень нравится.\n\n📍 {venue}\n\n" +
      "Ей будет приятно, если закрепишь его ты.",
    venueWishPayBtn: "Закрепить — {stars} ⭐",
    venueWishDeclineBtn: "Не в этот раз",
    venuePayDeclineAck:
      "Понял — место пока остаётся прежним. Если оно изменится, придёт обновлённая карточка.",
    venuePayDeclineStale:
      "Эта карточка уже неактуальна — планы по месту с тех пор поменялись. Нажми ниже, чтобы посмотреть, что сейчас.",
    venuePaySelfDm:
      "Вы сошлись на новом месте.\n📍 {venue}\nЗакрепи его — и я обновлю ваши карточки.",
    venuePaySelfBtn: "⭐ Закрепить — {stars}",
    venueSettledCard: "Готово — у вашего свидания новое место 📍 {venue}",
    venueSettledPaidByM: "{name} оплатил смену места ❤️ Ваше свидание теперь в {venue}",
    venueSettledPaidByF: "{name} оплатила смену места ❤️ Ваше свидание теперь в {venue}",
    venueExpressPartnerFromF: "{name} выбрала для тебя место поуютнее. Новое место: 📍 {venue}",
    venueExpressPartnerFromM: "{name} выбрал для тебя новое место. Новое место: 📍 {venue}",
    venueLapsedDm: "Смену места так и не закрепили — встречаетесь в {venue}, как и планировали.",
    venueKeepOriginalDm: "Твой мэтч решил ничего не менять — встречаетесь в {venue}, как и планировали.",
    venueInvoiceTitle: "Смена места свидания",
    venueInvoiceDesc: "Новое место свидания: {venue}",
    venueInvoiceLabel: "Смена места",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Свидание через 5 часов! Вот темы для разговора:\n\n",
    icebreakerStreamStart: "✨ Подбираю, о чём вам двоим поговорить…",
    noMatchStreamStart: "💫 Просматриваю кандидатов для тебя…",
    profilerSkip: "Пропустить",
    wingmanHintIntro:
      "👋 Маленькая подсказка — свидание через полтора часа:\n\n",
    dateTerminalInvite:
      "*Свидание через {minutes} мин*\n📍 {venue}\n\nОткрой экран свидания — он покажет дорогу. За столиком приложите телефоны друг к другу и удерживайте, чтобы обменяться контактами.",
    dateTerminalReminder:
      "*Обмен контактами открыт*\n📍 {venue}\n\nКогда вы оба за столиком — открой экран свидания, приложите телефоны друг к другу и удерживайте.",
    dateTerminalBtn: "🎟 Открыть свидание",
    dateDayActivityStartTitle: "Сегодня свидание",
    emergencyPushTitle: "Свидание отменено",
    emergencyPushBody: "Открой Gennety — там причина.",
    dateDayActivityStartBody: "Всё нужное — на экране блокировки.",
    venueActivityStartTitle: "Смена места",
    venueActivityStartPartner: "{name} предлагает {what}",
    venueActivityStartPartnerKeep: "{name} хочет оставить {venue}",
    venueActivityStartWaiting: "Ждём ответ по месту",
    venueActivityStartMatch: "Общий выбор: {venue}",
    venueActivityPartnerFallback: "Твой мэтч",
    // The time-agreement lock-screen card (iOS `time_agreement` Live Activity,
    // decision 2026-09-23): the alert a push-to-start carries, and the one an
    // update carries when the PARTNER moved. `{when}` is a weekday + HH:mm in the
    // RECIPIENT's timezone (the weekday is dropped when the slot is today); the
    // partner name is only ever the SUBJECT — the server declines no names, which
    // is also why waiting has a nameless twin rather than reusing
    // `venueActivityPartnerFallback` ("Ждём, когда Твой мэтч ответит" would
    // capitalise mid-sentence).
    timeActivityStartTitle: "Выбираем время",
    timeActivityStartPartner: "{name} предлагает {when}",
    timeActivityStartWaiting: "Ждём, когда {name} ответит",
    timeActivityStartWaitingNoName: "Ждём ответ по времени",
    timeActivityStartMatch: "Время назначено: {when}",
    emergencyUnlocked: "Планы поменялись и совсем не можешь прийти? Отменить можно кнопкой ниже.",
    emergencyBtn: "Отменить свидание",
    emergencyConfirmPrompt:
      "Если это просто волнение или опоздание — лучше оставь свидание. *Отменяй, только если точно не можешь прийти:* вернуть мэтч будет нельзя.",
    emergencyBtnConfirm: "🔴 Да, отменить свидание",
    emergencyBtnBack: "🟢 Оставить свидание",
    emergencyAborted: "Хорошо — свидание остаётся в силе. 👍",
    emergencyAskReason:
      "Напиши причину. Текст уйдёт мэтчу *как есть*.",
    emergencyConfirmed:
      "Свидание отменено. Сообщение переслано.",
    emergencyDateStarted:
      "Время свидания уже наступило, поэтому отменить его больше нельзя. " +
      "Если встреча не состоялась, я спрошу тебя об этом на следующий день.",
    emergencyReceivedOther:
      "Мэтч отменил свидание. Вот что написал:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Мэтч отменил свидание. Вот что написал:",
    emergencyReceivedOtherSoftNote:
      "Это не из-за тебя. Gennety немного поднимет твой приоритет в следующем подборе.",
    feedbackInvitation:
      "*Как прошло свидание?* ✨\n\nПоделись парой деталей: была ли химия, какой был вайб, понравилось ли место?",
    feedbackBtnForm: "✍️ Открыть форму",
    feedbackBtnVoice: "🎤 Записать голосом",
    attendanceAsk: "Прежде чем спрашивать, как всё прошло — вы вчера встретились? 🙂",
    attendanceAskLikelyMet:
      "Похоже, вчера всё состоялось 🙂 Уточню на всякий случай: вы встретились?",
    attendanceAskLikelyNotMet:
      "Кажется, вчера встреча не сложилась. Правильно понял — вы не встретились?",
    attendanceBtnYes: "Да, встретились",
    attendanceBtnNo: "Нет, не вышло",
    attendanceNoIntro: "Жаль, что так вышло. Что произошло?",
    attendanceOutcomePartner: "Партнёр не пришёл",
    attendanceOutcomeSelf: "Не получилось у меня",
    attendanceOutcomeBoth: "Договорились перенести",
    attendanceOutcomeOther: "Другое",
    attendanceNoThanks: "Спасибо за ответ — зафиксировал. Жаль, что так получилось.",
    attendanceAlreadyAnswered: "Уже отметил, спасибо ✨",
    attendancePushTitle: "Вы встретились?",
    attendancePushBody: "Одно касание — и я пойму, стоит ли спрашивать, как всё прошло.",
    feedbackVoiceAsk:
      "Просто запиши голосовое 🎙️\n\n" +
      "Расскажи, как прошло — была ли химия, что зашло, что не очень. " +
      "Минуты вполне хватит.",
    feedbackThanks: "Спасибо! Учту в следующем подборе ✨",
    feedbackAlreadySubmitted: "Отзыв об этом свидании уже есть — спасибо, всё сохранено ✨",
    feedbackPushTitle: "Как прошло свидание?",
    feedbackPushBody: "Минута твоего времени — и в следующий раз мы подберём точнее.",
    matchDropPushTitle: "Твоя пара найдена",
    matchDropPushBody: "Нажми, чтобы посмотреть ✨",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Пожаловаться",
    reportAsk:
      "Эта жалоба приватная. Что лучше всего описывает проблему?",
    reportCategoryFakePhotos: "Фейковые или вводящие в заблуждение фото",
    reportCategoryWrongPerson: "На фото другой человек",
    reportCategoryOffensive: "Грубость или странное поведение",
    reportCategoryUnsafe: "Мне было небезопасно",
    reportCategorySpam: "Спам или мошенничество",
    reportCategoryInappropriate: "Неподходящий профиль",
    reportCategoryOther: "Другое",
    reportDetailAsk:
      "Есть что-то ещё, что поможет быстрее разобраться? Можно написать, отправить голосовое или пропустить.",
    reportDetailAskOther:
      "Коротко опиши, что случилось. Можно написать или отправить голосовое.",
    reportSkipBtn: "Пропустить",
    reportThanksT1: "Принято — учтём в будущих мэтчах 🎯",
    reportThanksT2: "Жалоба зарегистрирована. Спасибо — разберёмся.",
    reportThanksT3:
      "Жалоба принята. Аккаунт этого человека заморожен до проверки. Спасибо за сигнал.",
    reportFailed: "Не получилось обработать жалобу. Попробуй через минуту.",
    reportDuplicate: "Жалоба на этот мэтч уже отправлена.",
    reportBackBtn: "← Назад",
    reportCancelled: "Хорошо — жалоба не отправлена.",
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
      "*Свидание через полтора часа — {location_name}*\n\n📍 *Придерживайся плана.* Мы подобрали для вас безопасное публичное место. Не соглашайся переносить встречу в уединённое место или ехать в гости.\n🚗 *Транспорт.* Добирайся туда и обратно самостоятельно — на общественном транспорте, такси или пешком. Не садись в машину к малознакомому человеку.\n📱 *Предупреди близких.* Перешли подруге или кому-то из близких детали встречи и, если можешь, поделись геопозицией на вечер.\n🛑 *Твои границы.* Если тебе некомфортно или поведение партнёра кажется странным — можно просто встать и уйти в любой момент. Твоя безопасность важнее вежливости.\n\nХорошего вечера ✨",
    safetyBriefPushTitle: "Перед выходом",
    safetyBriefPushBody: "Памятка безопасности на сегодня уже в приложении.",
    noMatchPushTitle: "В этот раз без мэтча",
    noMatchPushBody: "Пока никого подходящего не нашлось. Поиск продолжается.",
    matchNudgePushTitle: "Мэтч всё ещё ждёт",
    matchNudgePushBody: "Да или нет — оба варианта в порядке. Окно ещё открыто.",
    planningNudgePushTitle: "Свиданию всё ещё нужно время",
    planningNudgePushBody: "Загляни в календарь, когда будет минута.",
    deadlineNudgePushTitle: "Окно закрывается",
    deadlineNudgePushBody: "Ответить можно ещё примерно {hours}ч. Да или нет — оба варианта в порядке.",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Следующий мэтч через {d}д {h}ч",
    statusHoursMinutes: "⏳ Мэтчи прилетят через {h}ч {m}мин",
    statusMinutes: "✨ Почти готово! Мэтчи прилетят через {m} мин",
    statusProcessing: "✨ Сканируем твой город… Загляни чуть позже.",
    statusBannerSchedule: "Следующий подбор: {date}, {time}",
    statusBannerActive: "Мы уже ищем твоего человека ✦",
    statusBannerSearching:
      "Ищу твоего человека — проверяю каждый вечер.\n" +
      "Как только появится кто-то, кто правда стоит твоего времени, я напишу.",
    statusButtonDaysHours: "До подбора: {d}д {h}ч",
    statusButtonHoursMinutes: "До подбора: {h}ч {m}мин",
    statusButtonMinutes: "✨ До подбора: {m}мин",
    statusButtonProcessing: "✨ Подбираем мэтчи",

    // --- Stage-aware banner (PRODUCT_SPEC §2.1) ---
    statusBannerDecision:
      "Осталось на ответ:\n\n" +
      "Твой мэтч ждёт. Ответь «да» или «нет» прямо здесь, в чате.",
    statusBannerPlanning:
      "Свидание планируется ✦\n\n" +
      "Детали ещё утрясаются — всё по нему в «Моём свидании».",
    statusBannerDate: "До свидания:",
    statusTimeDaysHours: "{d}д {h}ч",
    statusTimeHoursMinutes: "{h}ч {m}мин",
    statusTimeMinutes: "{m}мин",
    statusButtonDateOpen: "Подробности",

    // --- Kyiv-only market gate (PRODUCT_SPEC §1.1) ---
    statusBannerMarketPending:
      "Пока Gennety работает только в Киеве — в городе {city} мы ещё не запустились, и мэтчить тебя здесь не с кем.\n\nХочешь ходить на свидания в Киеве? Смени город в меню.",
    statusButtonMenu: "Открыть меню",
    menuCitySwitch: "📍 Сменить город на Киев",
    citySwitchCard:
      "📍 *Твой город: {city}*\n\nПока Gennety работает только в Киеве. Мэтчи всегда внутри одного города, поэтому до запуска в городе {city} знакомить тебя здесь не с кем.\n\nЕсли хочешь ходить на свидания в Киеве — переключись. Анкета, фото и верификация останутся как есть, и ты попадёшь в ближайший подбор.",
    citySwitchConfirm: "📍 Да, ищите мне пару в Киеве",
    citySwitchDone:
      "Готово — твой город для мэтчей теперь Киев 🤍\n\nТы в ближайшем подборе: {date}.",
    citySwitchFailed: "Не получилось сменить город. Попробуй ещё раз через минуту.",
    noMatchCityNotLaunched:
      "*В городе {city} Gennety пока нет*\n\nМы работаем только в Киеве, а мэтчи всегда внутри одного города — знакомить тебя здесь пока не с кем. Анкета остаётся как есть, и мы напишем, как только откроем твой город.\n\nЕсли хочешь ходить на свидания в Киеве — переключись ниже и попадёшь в ближайший подбор.",
    noMatchCitySwitchBtn: "📍 Перейти на Киев",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Свидание через {d}д {h}ч",
    statusDateHoursMinutes: "💫 Свидание через {h}ч {m}мин",
    statusDateMinutes: "💫 Свидание через {m} мин",
    statusDateSoon: "💫 Свидание сегодня",
    menuMyDateDays: "💫 Моё свидание · через {d}д {h}ч",
    menuMyDateHours: "💫 Моё свидание · через {h}ч {m}мин",
    menuMyDateMinutes: "💫 Моё свидание · через {m} мин",
    menuMyDateSoon: "💫 Моё свидание · сегодня",
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
    rateLimitDailyBudgetNotice: "Ты сегодня много пишешь 🙂 Продолжим завтра — на сегодня лимит.",

    // --- Pre-date coordination (feature-flagged) ---
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
    coordProxyPushTitle: "Твоё свидание",
    coordProxyTextOnly: "В этом чате работают только текстовые сообщения — фото и голосовые не передаются.",
    coordProxyClosed: "Анонимный чат закрылся. Надеюсь, свидание прошло отлично — загляну завтра ✨",
    coordProxyUnavailable: "Этот анонимный чат больше недоступен.",
    coordCardProxyKicker: "АНОНИМНЫЙ ЧАТ",
    coordCardProxyHead1: "Линия",
    coordCardProxyHead2: "открыта.",
    coordCardProxySub: "Сообщения идут через меня. Контакты не раскрываются.",
    menuPremium: "✨ Gennety Premium",
    menuPremiumActive: "✨ Premium · до {date}",
    menuInviteFriend: "🎁 Пригласить друга",
    referralHubTitle: "Приглашай друзей в Gennety",
    referralHubTagline:
      "За каждого друга, который пройдёт проверку по твоей ссылке, — билет на свидание 🎟 тебе, и ему тоже.",
    referralShareButton: "📤 Пригласить друга",
    referralShareCaption: "Gennety подбирает лучшую пару и сам организует встречу.",
    referralShareJoin: "Присоединиться к Gennety 💫",
    // --- HDYHAU (онбординговый вопрос об источнике, `shared/hdyhau.ts`) ---
    hdyhauQuestion: "И последнее — откуда ты о нас знаешь?",
    hdyhauFriendInPerson: "Друг рассказал лично",
    hdyhauFriendOnline: "Знакомый прислал ссылку",
    hdyhauSocialMedia: "Соцсети",
    hdyhauSearch: "Через поиск",
    hdyhauAd: "Реклама",
    hdyhauEvent: "Вечеринка или мероприятие",
    hdyhauOther: "Откуда-то ещё",
    hdyhauSkip: "Пропустить",
    hdyhauThanks: "Спасибо — это правда помогает. 💛",
    referralRewardDm:
      "{name} — проверка по твоей ссылке пройдена ✨\n\nНачислено: +{tickets} 🎟\n{next}",
    referralRewardNext: "Осталось наград за приглашения: {remaining}.",
    referralRewardNextMax: "Это была последняя награда за приглашения — спасибо 💛",
    referralCardInvitedBy: "{name} зовёт тебя в Gennety",
    referralCardInvitedGeneric: "Тебя приглашают",
    referralCardHeadA: "Реальные свидания.",
    referralCardHeadB: "Ноль переписки.",
    referralCardSupport:
      "Gennety подбирает пару по глубокой совместимости и сам организует встречу вживую.",
    referralCardGift: "{ticketsPhrase} — в подарок",
    referralCardFooter: "gennety.com",
    premiumHubTitle: "✨ Gennety Premium",
    premiumHubBody:
      "*Gennety Premium*\n\n• *Безлимитные свидания* — твой билет покрыт каждый раз, сколько бы свиданий ни было\n• *Любое вечернее время* — поздние слоты в календаре открыты для тебя\n• *Лучшие заведения* — подборка мест уровнем выше\n• *Бесплатная смена места* — до двух раз за свидание, без оплаты",
    premiumHubActiveNote: "У тебя Premium ✨ Активен до {date}.",
    premiumOpenCta: "Подробнее",
    premiumCancelHint:
      "Отменить можно в любой момент — просто напиши мне, и я отменю подписку после твоего подтверждения.",
    premiumManageNote: "Управлять и отменить — в Telegram → Настройки → Подписки.",
    premiumWelcomeDm:
      "Добро пожаловать в Gennety Premium ✨\n\nТвои свидания теперь покрыты — билет не нужен. Любое вечернее время в календаре тебе открыто, смена места бесплатна, премиум-заведения открыты. Активно до {date}.",
    premiumExpiring3d:
      "Твой Gennety Premium заканчивается {date} — через три дня.\n\nЭтот тариф не продлевается сам, так что покрытые свидания, бесплатная смена места и премиум-заведения в этот день отключатся. Выбери следующий период: месяц или 3 / 6 месяцев по цене ниже.",
    premiumExpiring1d:
      "Последний день твоего Gennety Premium — он заканчивается {date}.\n\nПосле этого свидания снова будут стоить билет, а премиум-заведения закроются. Одно нажатие — и выбираешь следующий период: месяц или 3 / 6 месяцев по цене ниже.",
    premiumExpiringCta: "Выбрать тариф",
    // Stars top-up warning for a RECURRING subscriber (§3.8). Distinct from
    // premiumExpiring* above: nothing is ending here — the charge is coming,
    // and it fails on an empty balance. `{amount}` is premiumRenewalAmount or
    // an empty string, so the sentence has to read correctly BOTH ways.
    premiumRenewal3d:
      "Через три дня, {date}, Telegram продлит твой Gennety Premium.{amount}\n\nСписание идёт звёздами с баланса Telegram — с карты Telegram не спишет. Если звёзд в этот день не хватит, продление не пройдёт и Premium встанет на паузу, так что баланс лучше пополнить заранее: Настройки → Мои звёзды.",
    premiumRenewal1d:
      "Завтра, {date}, Telegram продлит твой Gennety Premium.{amount}\n\nСписание идёт звёздами с баланса Telegram, запасной карты у него нет — если завтра звёзд не хватит, продление не пройдёт и Premium встанет на паузу. Пополнить — минута: Настройки → Мои звёзды.",
    premiumRenewalAmount: " Спишется {stars} ⭐.",
    premiumPlanMonthly: "1 месяц",
    premiumPlan3Months: "3 месяца",
    premiumPlan6Months: "6 месяцев",
    premiumPlanSaveBadge: "−{pct}%",
    premiumPlanPerMonth: "{price}/мес",
    premiumPackageWelcomeDm:
      "Gennety Premium твой на {months} мес. ✨\n\nСвидания покрыты, смена места бесплатна, премиум-заведения открыты — до {date}. Этот тариф не продлевается сам, так что я напомню заранее.",
    premiumInvoiceTitle: "Gennety Premium",
    premiumInvoiceDesc:
      "Месячная подписка — бесплатная смена места + премиум-заведения. Продление каждые 30 дней; отмена в любой момент.",
    premiumInvoiceLabel: "Gennety Premium — 1 месяц",
    premiumCheckoutError: "Не получилось оформить подписку. Попробуй через минуту.",
    premiumCancelConfirm:
      "Отменяем Gennety Premium?\n\nPremium останется активным до {date} — до этой даты всё работает. Дальше подписка не продлится и больше ничего не спишется.",
    premiumCancelConfirmYes: "Да, отменить",
    premiumCancelKeepBtn: "Оставить Premium",
    premiumCancelFinalConfirm:
      "Последняя проверка — точно отменяем Gennety Premium?\n\nPremium останется активным до {date}, до этой даты ничего не изменится. После подтверждения автопродление выключится навсегда — захочешь вернуть Premium позже, придётся оплатить заново.",
    premiumCancelFinalYes: "Да, отменить",
    premiumCancelFinalNoSoft: "Нет, оставить",
    premiumCancelFinalNoHard: "Нет, оставить",
    premiumCancelDone:
      "Готово — автопродление отключено. Premium активен до {date}, больше ничего не спишется. Вернуться можно в любой момент.",
    premiumCancelKept: "Оставляем ✨ Premium активен до {date}.",
    premiumCancelAppStore:
      "Подписка оформлена через App Store, поэтому отменить её можно только на iPhone: Настройки → [твоё имя] → Подписки → Gennety Premium → Отменить. Доступ сохранится до {date}.",
    premiumCancelNotActive: "Сейчас у тебя нет активной подписки Premium.",
    premiumCancelReasonAsk:
      "Спасибо за время с нами 🤍 Если не сложно — расскажи в двух словах, почему отменяешь? Это правда помогает нам стать лучше.",
    premiumCancelReasonSkipBtn: "Не хочу отвечать",
    premiumCancelReasonThanks: "Спасибо, учтём 🤍 Premium всегда можно вернуть.",

    // --- Rematch ---
    rematchOfferFamine:
      "В этот раз пары не нашлось — дело не в тебе.\n\nМогу поискать ещё раз прямо сейчас: {price}. Не найду — верну звёзды.",
    rematchOfferFailed:
      "Не сложилось. Бывает.\n\n" +
      "Могу пойти на второй заход прямо сейчас и найти тебе нового человека — {price}.\n\n" +
      "Это новое знакомство, а не гарантия свидания. Если никого не найду — звёзды сразу вернутся.",
    rematchOfferNeutral:
      "Хочешь, пойду на новый заход прямо сейчас? Один новый человек, подбор тот же: {price}.\n\n" +
      "Это новое знакомство, а не гарантия свидания. Если никого не найду — звёзды сразу вернутся.",
    rematchOfferBtn: "Искать заново — {price}",
    statusButtonRematch: "Искать сейчас",
    rematchInvoiceTitle: "Новый поиск",
    rematchInvoiceDesc: "Ещё один поиск прямо сейчас — новый человек от Gennety.",
    rematchInvoiceLabel: "Новый поиск",
    rematchFound: "Нашёл. Сейчас пришлю ✨",
    rematchNoCandidate:
      "Посмотрел — новых вариантов в твоём городе сейчас нет. Звёзды вернул. В следующем раунде ты остаёшься.",
    rematchRefundPending:
      "Никого нового не нашёл, а возврат с первого раза не прошёл. Уже занимаюсь — звёзды вернутся в ближайшее время.",
    rematchUndelivered:
      "Нашёл человека, но доставить анкету не смог — это на нашей стороне. Звёзды вернул, и попытка не засчиталась.",
    rematchUndeliveredPending:
      "Нашёл человека, но доставить анкету не смог, а возврат с первого раза не прошёл. Уже занимаюсь — звёзды вернутся в ближайшее время.",
    rematchRefunded: "Звёзды за новый поиск вернулись ✨",
    rematchLimitReached:
      "Новые поиски на сейчас закончились. Следующий откроется через пару дней — обычный подбор всё равно будет.",
    rematchUnavailable:
      "Сейчас новый поиск не запустить. Если у тебя есть мэтч в работе — сначала закончи с ним.",
    rematchGiftFamine:
      "Я говорил, что пары для тебя пока нет. Продолжил искать — и нашёл человека, на которого стоит посмотреть.",
    rematchGiftFailed:
      "В прошлый раз не сложилось. Я вернулся к поиску и нашёл того, кто подходит тебе больше.",
    rematchGiftNeutral:
      "Я продолжал искать — и есть человек, которого хочу тебе показать.",
    rematchSearchStep1: "🔍 Включаю глубокий поиск",
    rematchSearchStep2: "Смотрю, кто сейчас свободен в твоём городе",
    rematchSearchStep3: "Сверяю по характеру и интересам",
    rematchSearchStep4: "✨ Почти — выбираю одного",
    rematchCardOverline: "ТВОЙ МЭТЧМЕЙКЕР",
    rematchCardHeadline: "ЕЩЁ ОДИН\nЗАХОД",
    rematchCardSubline: "Новый человек, подбор тот же.",
  },
  uk: {
    // --- Onboarding ---
    consentMessage:
      "*Привіт! Це Gennety* 👋\n\nПерш ніж почати, прочитай Умови використання та Політику конфіденційності й погодься з правилами зберігання даних.",
    consentAgree: "Приймаю",
    consentPrivacyButton: "Політика конфіденційності",
    consentTermsButton: "Умови використання",
    welcome: "*Gennety Dating*\nПідбираємо пару й одразу призначаємо побачення наживо.",
    chooseLanguage: "Обери мову:",
    philosophyPitch:
      "*Тут не треба листуватися*\n\nЯ дізнаюся тебе, знайду людину, яка підходить, і сам домовлюся про час і місце. Тобі залишиться тільки прийти. Поїхали?",
    philosophyContinue: "Поїхали 🚀",
    askEmail: "Напиши свою пошту університету — наприклад, name@knu.ua",
    invalidEmail: "Це не схоже на пошту університету. Перевір адресу й надішли ще раз.",
    otpSent: "Надіслав код на *{email}*. Введи його сюди:",
    otpInvalid: "Не той код. Спробуй ще:",
    otpExpired: "Код застарів. Введи пошту ще раз — надішлю новий.",
    otpTooManyAttempts: "Забагато спроб. Введи пошту знову — надішлемо новий код.",
    otpCooldown: "Зачекай хвилинку перед повторним надсиланням.",
    emailVerified: "Пошту підтверджено ✨",
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
      "Майже готово! Надішли {min}–{max} фото, де тебе добре видно. Відверті знімки не можна. Відео теж можна — головне, щоб тебе було видно.",
    photoReceived: "Фото {n}/{max}",
    voicePromptSkipButton: "Без голосового",
    voicePromptSkipHint: "Пропустити — кнопка «{button}» внизу чату.",
    voicePromptPanelPlaceholder: "Затисни мікрофон — секунд 15",
    voicePromptRecorded:
      "Записав — послухай. Надішли інше, якщо хочеш перезаписати, або «{button}», щоб прибрати.",
    voicePromptReviewDone: "✅ Готово",
    voicePromptSkipped: "Гаразд, обійдемося без голосового.",
    voicePromptSaved: "Зберіг ✨ Твій метч почує його перед тим, як відповісти.",
    voicePromptTooShort: "Це менше секунди — кнопку мікрофона треба тримати. Спробуй ще раз, цілься секунд на 15.",
    voicePromptTooLong: "Задовго — вклади́ся в 30 секунд, інакше таке просто не дослуховують. Запишеш ще раз?",
    voicePromptUnsafe: "Таке я не можу поставити в анкету. Запиши інше — або пропусти, це за бажанням.",
    voicePromptContactInfo: "Ніки та номери краще не називати — зустріч я організую сам, у цьому весь сенс. Запиши краще щось про себе.",
    voicePromptUnavailable: "Не зміг обробити запис. Надішли його ще раз за хвилину.",
    voicePromptPitchCaption: "{name}: голосове для тебе",
    photoRejected:
      "На фото має бути видно твоє обличчя. Спробуй інший знімок.",
    photoDuplicate: "Це фото вже є в профілі — надішли інше.",
    photoDuplicateNear: "Це фото вже є в профілі — надішли інше.",
    photoUnsafeContent:
      "Це фото не можна публікувати у профілі. Обери інший знімок без відвертого контенту.",
    photoFaceObscured:
      "На цьому фото обличчя закрите. Надішли знімок, де його не приховує маска чи шарф.",
    photoMultipleFaces:
      "На фото має бути видно твоє обличчя. Спробуй інший знімок.",
    photoIdentityMismatch:
      "Усі фото мають належати одній людині. Переконайся, що твоє обличчя є на кожному знімку.",
    photoIdentityUncertain:
      "Не вдалося надійно зіставити обличчя. Надішли чіткіше фото з хорошим освітленням і добре видимим обличчям.",
    photoConsensusPending: "Надішли ще одне фото — за двома знімками я зрозумію, що на них ти.",
    photoConsensusOutlierRejected: "На одному фото інша людина — його я не додав.",
    photoConsensusConfirmed: "Чудово, на всіх фото ти ✨",
    photoConsensusNoPairCap:
      "Поки не бачу двох фото однієї людини. Надішли ще одне чітке фото, де видно тебе.",
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
      "🎟️ *Безкоштовний квиток на побачення — твій!*\n\nЦе подарунок за фото. Одне побачення = 1 квиток. Баланс: *{balance}*",
    ticketRewardVideo:
      "🎟️ *Ще один безкоштовний квиток — твій!*\n\nЦе подарунок за відео. Одне побачення = 1 квиток. Баланс: *{balance}*",
    ticketRewardStudent:
      "🎓 *Два безкоштовні квитки — твої!*\n\nЦе подарунок за підтверджену пошту університету. Одне побачення = 1 квиток. Баланс: *{balance}*",
    welcomeGiftTicket:
      "*Перший квиток — від мене* ❤️\n\nЗазвичай побачення коштує 1 квиток (~$8.49). Цей — безкоштовно, він уже в гаманці.",
    ticketStorePurchased: "✨ *Оплата пройшла!* Квитків додано: *{count}*. Баланс: *{balance}*",
    ticketStoreCheckoutError: "Не вдалося підтвердити оплату. Спробуй ще раз.",
    premiumCheckoutAlreadySubscribed:
      "У тебе вже є активна підписка Premium, тож оплату зупинено — нічого не списано.",
    paymentStuckDm:
      "Оплата пройшла, але видати покупку не вдалося — зламалося на нашому боці.\n\nНе плати вдруге. Ми вже знаємо і або видамо, або повернемо зірки.",
    ticketStoreInvoiceTitle: "Квитки Gennety",
    ticketStoreInvoiceDesc:
      "Поповнення гаманця: {count} 🎟️. Кожен квиток покриває одне побачення.",
    ticketGateInvoiceDesc: "Оплата побачення. Квитків: {count}. Один квиток — на одну людину.",
    ticketStoreInvoiceLabel: "Квитки Gennety × {count}",
    onboardingFinalizeBlocked:
      "Поки не можу завершити налаштування — на моєму боці бракує кількох даних. Спробуй ще раз за хвилину; якщо повториться, напиши в @gennetysupport, розберемось.",
    onboardingPhotosNeedMore: "Фото: {count}/{min}. Надішли ще {remaining}.",
    onboardingPhotosBonusOffer:
      "Потрібні фото є ✨\nЩе {remaining} фото (до {threshold}) — і безкоштовний квиток. За коротке відео — ще один.",
    onboardingPhotosBonusOfferAfterVideo:
      "Потрібні фото є, квиток за відео — твій ✨\nЩе {remaining} фото (до {threshold}) — і другий безкоштовний квиток.",
    onboardingPhotosBonusProgress:
      "Фото: {count}/{threshold}.\nЩе {remaining} — і безкоштовний квиток твій.",
    onboardingPhotosBonusProgressAfterVideo:
      "Фото: {count}/{threshold}.\nЩе {remaining} — і другий безкоштовний квиток твій.",
    onboardingPhotosPhotoBonusEarned:
      "Фото: {count}. Безкоштовний квиток за фото — твій ✨\nМожна додати фото (до {max}) або відео — за нього ще один квиток.",
    onboardingPhotosBothBonusesEarned:
      "Фото: {count}, відео є — обидва безкоштовні квитки твої ✨\nМожна додати ще фото (до {max}).",
    onboardingPhotosPhotoBonusEarnedMax:
      "Усі {max} фото є, квиток за фото — твій ✨\nЗа коротке відео — ще один безкоштовний квиток.",
    onboardingPhotosBothBonusesEarnedMax:
      "Усі {max} фото й відео є ✨\nОбидва безкоштовні квитки — твої.",
    onboardingPhotosOptional: "Потрібні фото є.\nМожна додати ще (до {max}) або коротке відео.",
    onboardingPhotosOptionalAfterVideo:
      "Потрібні фото й відео є.\nМожна додати ще фото (до {max}).",
    onboardingPhotosOptionalMax: "Усі {max} фото є.\nМожна додати коротке відео.",
    onboardingPhotosOptionalMaxAfterVideo: "Усі {max} фото й відео є ✨",
    menuMyTickets: "🎟️ Мої квитки",
    ticketWalletText:
      "🎟️ *Мої квитки*\n\nКвитків: *{balance}*. Кожне побачення коштує 1 квиток — докупити можна будь-коли.",
    ticketWalletOpenStore: "🎟️ Купити квитки",
    photosEnough: "Можеш надіслати ще (до {max}) або тисни кнопку.",
    photosDone: "Фото завантажено ✨",
    profileReview:
      "Ось твій профіль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Все ок?",
    profileConfirm: "Все ок",
    profileEdit: "Змінити",
    onboardingComplete: "*Готово, ти в грі!* 🎉\n\nУже шукаю тобі пару — напишу, щойно знайду.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Далі ➡️",
    finishOnboardingFirst:
      "Спочатку заверши реєстрацію — тоді меню та налаштування стануть доступні.\nНапиши /start, щоб продовжити.",

    // --- Persona verification CTA (end of onboarding) ---
    verifyPitch:
      "*Останній крок — підтверди, що це ти*\n\nЗроби селфі, і я порівняю його з фото в профілі. Фото, де не ти, я приберу.\n\nБез перевірки пропозицій буде менше.",
    verifyPitchMandatory:
      "*Останній крок — підтверди, що це ти*\n\nЗроби селфі, і я порівняю його з фото в профілі. Якщо на фото не ти — спершу заміни їх. Після перевірки одразу почну шукати пару.",
    verifyMandatoryNotice:
      "Верифікація тепер обов'язкова для всіх нових профілів — підбір пар почнеться одразу після її проходження. Це займе близько хвилини:",
    verifyReminderNudge:
      "Твій профіль готовий — залишився тільки крок верифікації. Це займе близько хвилини, і підбір пар почнеться одразу після:",
    verifyBtnGo: "🟢 Пройти верифікацію",
    verifyBtnSkip: "⚪️ Пропустити поки",
    verifySkipNudgeCaption:
      "Секунду — послухай це, перш ніж пропустити 👆",
    verifyBtnReconsider: "🟢 Все ж таки пройти верифікацію",
    verifyBtnSkipConfirm: "🔴 Все одно пропустити",
    // --- Photo re-upload path (a way back before/after verification) ---
    verifyBtnRedoPhotos: "📷 Завантажити інші фото",
    verifyBtnRedoPhotosSecondary: "📷 Спершу зміню фото",
    verifyBtnAddPhotos: "📷 Додати фото",
    verifyPhotosRequired:
      "Верифікація порівнює селфі з фото у твоєму профілі — а їх поки немає. " +
      "Спершу додай щонайменше {min} своїх фото, потім запусти перевірку:",
    verifyBtnClearPhotos: "🗑 Видалити всі та завантажити заново",
    verifyGateLocked:
      "Меню й підбір пар відкриються одразу після верифікації. Залишився тільки цей крок:",
    verifyPhotosRedoIntro:
      "Без проблем — ось твої поточні фото. Видали ті, на яких не ти, і завантаж свої.",
    verifyPhotosRedoIntroRecheck:
      "Без проблем — ось твої поточні фото. Видали ті, на яких не ти, і завантаж свої — коли закінчиш, я перевірю їх автоматично, нове селфі не знадобиться.",
    verifyPhotosCleared: "Фото видалено. Надішли {min}–{max} своїх фотографій.",
    verifyPhotosSavedRecheck:
      "Фото оновлено ✅ Перевіряю їх за селфі з верифікації — проходити її заново не треба. Напишу, щойно закінчу.",
    verifyPhotosSavedNowVerify:
      "Фото оновлено ✅ Залишився останній крок — верифікація:",
    verifySkipped: "Перевірку пропущено. Пройти її можна пізніше в меню профілю.",
    verifyCheckAlreadyDone:
      "Вже оброблено — повідомлення з результатом має бути вище. " +
      "Якщо щось не так — натисни 🟢 Пройти верифікацію ще раз.",
    verifyRetryNotLive:
      "*Не вдалося розпізнати обличчя*\n\nСтань обличчям до яскравого світла, зніми окуляри й натисни 🟢 Пройти верифікацію ще раз.",
    verifyRetryUnfinished:
      "*Перевірка перервалася*\n\nПройди її за один раз, не згортаючи Telegram, — це секунд 15. Натисни 🟢 Пройти верифікацію.",
    verifyRetryTechnical:
      "*Збій на нашому боці*\n\nНатисни 🟢 Пройти верифікацію ще раз — тепер має вийти.",
    verifyReferenceExpired:
      "Ми видаляємо селфі з верифікації через 90 днів, тож звірити нові фото вже " +
      "нема з чим. Ще одна перевірка на 10 секунд — і все готово. Профіль поки " +
      "лишається активним:",
    verifyOutcomeVerified:
      "Перевірку пройдено ✨ Профіль активний. Напишу, коли знайду метч.",
    profilerHeadsUp:
      "Поки я шукаю тобі людину, я час від часу ставитиму прості запитання — " +
      "що дивишся, як проводиш вихідні, що тебе чіпляє.\n\n" +
      "Відповідай чесно й не відкладай — що краще я тебе знаю, то краще підготую " +
      "вас обох до зустрічі: з чого почати розмову і чого краще не торкатися.",
    verifyOutcomePendingReview:
      "🔍 Ми додатково перевіряємо фото профілю за селфі з верифікації. Зазвичай це займає кілька годин — я напишу, щойно перевірка завершиться.",
    verifyOutcomeRejected:
      "⚠️ *Фото не збіглися із селфі*\n\nЯкщо на них не ти — заміни їх кнопкою 📷, я перевірю ще раз. Якщо ти — пройди перевірку ще раз при хорошому світлі.",
    verifyPhotosDropped:
      "Один момент: частина фото не збіглася з селфі з верифікації, я прибрав їх із профілю. Усе інше на місці. Додай ще пару своїх знімків, коли буде зручно 📷",
    verifyPhotosBelowMinimum:
      "Верифікацію пройдено ✅\n\nАле частина фото не збіглася із селфі, я їх прибрав, і тепер у профілі менше ніж {min} фотографій. Додай ще {need} своїх — і я одразу почну шукати тобі пару 📷",
    // --- Native-app push copy for the same verification outcomes (§1.4). Own
    // strings rather than reused DM copy: these land on a lock screen, so they
    // need a title, they must stay short, and they cannot point at a Telegram
    // keyboard ("tap 📷 below") that does not exist in the app.
    verifyPushVerifiedTitle: "Перевірку пройдено ✨",
    verifyPushVerifiedBody: "Профіль активний. Напишу, коли знайду метч.",
    verifyPushRejectedTitle: "Фото не збіглися",
    verifyPushRejectedBody:
      "На фото в профілі не та людина, що на селфі з верифікації. Якщо це не ти — заміни їх, я перевірю автоматично.",
    verifyPushPendingReviewTitle: "Перевіряємо фото",
    verifyPushPendingReviewBody:
      "Звіряємо фото профілю із селфі з верифікації. Зазвичай кілька годин — напишу, щойно завершимо.",
    verifyPushRetryTitle: "Лишився один крок",
    verifyPushRetryBody:
      "Профіль готовий — бракує лише верифікації. Це приблизно хвилина, підбір почнеться одразу після.",
    verifyPushPhotosNeededTitle: "Додай ще {need} фото",
    verifyPushPhotosNeededBody:
      "Верифікацію пройдено, але в профілі менше ніж {min} фотографій. Додай ще {need} своїх — і я почну шукати.",
    verifyPushPhotosDroppedTitle: "Частину фото прибрано",
    verifyPushPhotosDroppedBody:
      "Деякі не збіглися із селфі з верифікації, я прибрав їх із профілю. Усе інше на місці.",
    verifyMiniAppLoading: "Відкриваємо верифікацію…",
    verifyMiniAppFinishing: "Готово. Перевіряємо результат…",
    verifyMiniAppError: "Не вдалося запустити перевірку. Спробуй ще раз.",
    verifyMiniAppCloseBtn: "Закрити",
    photoMatchMismatch:
      "⚠️ Це фото не збігається з селфі верифікації. " +
      "Завантаж чітке фото себе при схожому освітленні.",

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
    // --- Relationship intent (PRODUCT_SPEC §1.3) ---
    intentSpark: "Яскрава історія",
    intentOpen: "Подивимось, куди приведе",
    intentFalling: "Закохатися",
    intentLongterm: "Всерйоз і надовго",
    intentPrivateNote: "бачиш тільки ти",
    myProfileIntentLine: "🎯 Ти шукаєш: {intent}",
    myProfileIntentUnset: "🎯 Ти шукаєш: не обрано",
    editIntentBtn: "🎯 Що я шукаю",
    editIntentPrompt:
      "Що ти зараз шукаєш? Познач усе, що підходить — зазвичай це не одне.\n\nЦе бачиш тільки ти — потрібно, щоб точніше добирати пару.",
    editIntentCleared: "Нічого не обрано",

    // --- Edit Profile ---
    editProfileBody:
      "Це змінити не можна:\n\n• *Ім'я:* {firstName} {surname}\n• *Вік:* {age}\n• *Універ:* {university}\n\nМожна змінити:",
    editBioBtn: "📝 Про себе",
    editPrefsBtn: "💘 Кого шукаю",
    editMajorBtn: "💼 Чим займаєшся",
    editProfilePhotosBtn: "📸 Мої фото",
    editBioPrompt:
      "Напиши кілька рядків про себе (до 500 символів) — метч прочитає їх перед побаченням.",
    editBioCurrent: "Зараз написано так. Новий текст замінить його:",
    editBioTooLong: "Задовге — вклади в 500.",
    editBioSaved: "«Про себе» оновлено",
    editMajorPrompt:
      "Чим займаєшся? (робота / навчання / сфера, до 100 символів)\n👀 Видно твоїй парі.",
    editMajorTooLong: "Задовге — вклади в 100.",
    editMajorSaved: "Збережено",
    editPrefsTitle: "💘 *Кого шукаю*\n\nЩо міняємо?",
    editPrefsAgeBtn: "🎂 Вік партнера",
    editPrefsDescriptionBtn: "✨ Яку людину шукаю",
    editPrefsCurrent:
      "Поточні налаштування:\n• Людина: {preferences}\n• Вік: {ageRange}",
    editPrefsNotSet: "Не задано",
    editPrefsDescriptionPrompt: "Опиши, яку людину хочеш зустріти (до 500 символів).",
    editPrefsDescriptionEmpty: "Додай короткий опис — він не може бути порожнім.",
    editPrefsDescriptionTooLong: "Задовге — вклади в 500.",
    editPrefsDescriptionSaved: "Уподобання оновлено",
    editHobbiesSaved: "Інтереси оновлено",
    agentEntryPrompt: "Тримай:",
    agentFallbackError: "Щось пішло не так. Повтори, будь ласка.",
    agentBlockedVerification: "Спочатку пройди верифікацію — далі відкриється все інше.",
    agentBlockedSuspended:
      "Акаунт зараз на паузі з нашого боку, тож тут не допоможу. Питання — у @gennetysupport.",
    agentBlockedInvestigation:
      "Акаунт зараз на перевірці. Поки що робити нічого — подробиці розкажуть у @gennetysupport.",
    agentBlockedBanned: "Цей акаунт закрито. Якщо вважаєш, що це помилка — напиши в @gennetysupport.",
    profileEmbeddingSyncPending: "Збережено. Врахую в наступному підборі.",
    editPrefsBack: "⬅️ До редагування",
    editAgeRangePrompt: "У якому віковому діапазоні шукати тобі пару? (напр. 20-28)\nМін: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не зрозумів. Два числа через дефіс, напр. 20-28 (від {min} до {max}).",
    editAgeRangeSaved: "Діапазон оновлено",
    editProfilePhotosStart: "Скинь нові фото ({min}–{max}) — по одному або альбомом.",
    editProfilePhotosSaved: "Фото оновлено",
    editProfileSaved: "Профіль оновлено",
    photoManagerTitle: "Фото: {count}/{max} · мінімум {min}",
    photoManagerCardDeleteBtn: "🗑 Видалити це фото",
    photoManagerCardRemoved: "🗑 Фото видалено",
    photoManagerAddBtn: "➕ Додати",
    photoManagerDoneBtn: "Готово",
    photoManagerMinReached: "Потрібно щонайменше {min} фото. Спершу додай нове.",
    photoUploadStep1: "Завантажую фотографії…",
    photoUploadStep2: "Перевіряю кадри…",
    photoUploadStep3: "Ще пара секунд…",
    photoUploadOneStep1: "Завантажую фото…",
    photoUploadOneStep2: "Перевіряю кадр…",
    photoReviewStep1: "Дивлюся твої фото…",
    photoReviewStep2: "Переглядаю кадри…",
    photoReviewOneStep1: "Дивлюся твоє фото…",
    photoReviewOneStep2: "Переглядаю кадр…",
    photoBatchAdded: "Додано: {n} · у профілі {total}/{max}",
    photoBatchNoneAdded: "З цієї партії нічого не додалося.",
    photoBatchAtMax: "Досягнуто ліміт у {max} фото — видали одне, щоб додати нове.",
    photoManagerDeleted: "Фото видалено.",
    photoStagePanelBtn: "🗂 Мої фото",
    photoStagePanelPlaceholder: "Надішли ще фото або натисни 🗂",
    photoEditorIntro:
      "Ось усі твої фото. Натисни 🗑 під будь-яким фото, щоб прибрати його, або надішли нові прямо сюди.",
    photoEditorBackBtn: "← Повернутися до завантаження",
    menuVideo: "🎬 Відео профілю",
    editVideoPrompt:
      "🎬 Надішли коротке відео для профілю (до {sec} сек, не більше {mb} МБ). Друзі, краєвид чи кліп з вечірки — усе підійде, відео оживляє анкету.",
    editVideoRewardLine: "🎁 Додай відео зараз і отримай безкоштовний квиток на побачення.",
    editVideoHasOne:
      "У тебе вже є відео в профілі. Надішли нове, щоб замінити, або видали його кнопкою нижче.",
    editVideoRemoveBtn: "🗑 Видалити відео",
    editVideoRemoved: "Відео з профілю видалено.",
    editVideoNotAVideo: "Надішли *відео* (до {sec} сек, не більше {mb} МБ).",
    myProfileAddVideoHint:
      "🎬 Порада: додай коротке відео в профіль через меню — так анкета помітніша.",
    myProfileAddVideoHintReward:
      "Порада: додай коротке відео в профіль через меню та отримай безкоштовний квиток 🎁.",

    // --- Pause / Resume ---
    pauseConfirmed: "Пошук на паузі ⏸\nНових метчів не буде, поки не ввімкнеш.",
    resumeConfirmed: "Пошук запущено ▶️\nЯ вже в ділі.",

    // --- Settings ---
    settingsTitle: "⚙️ Налаштування",
    settingsLanguage: "🌐 Мова",
    settingsLanguagePick: "Обери мову:",
    settingsLanguageSaved: "Мову оновлено",
    settingsTheme: "🎨 Тема",
    settingsThemePick: "Обери оформлення:",
    settingsThemeSaved: "Тему оновлено",
    themeDarkOption: "🌙 Темна",
    themeLightOption: "☀️ Світла",
    helpBody:
      "*Потрібна допомога?*\n\nПроблема з метчем, побаченням чи ботом — напиши в підтримку:\n\n💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Видалити акаунт",
    deleteAccountConfirm:
      "*Видалити акаунт назавжди?*\n\nЗникнуть профіль, фото й метчі. Скасувати це не можна.",
    deleteAccountYes: "Так, видалити все",
    deleteAccountNo: "Скасувати",
    deleteAccountDone:
      "Акаунт видалено. Усі дані стерто.\n" +
      "Захочеш повернутись — надішли /start.",
    deleteAccountFailed:
      "Зараз не вдалося безпечно видалити всі дані. Акаунт збережено — спробуй ще раз.",
    deleteAccountRefundInProgress:
      "За твоїм акаунтом ще триває повернення коштів, і якщо видалити акаунт зараз, їм не буде куди повернутися. Нічого не видалено — спробуй ще раз, коли повернення пройде.",
    accountActionExpired: "Підтвердження застаріло. Відкрий дію знову.",
    statusActionUnavailable: "Ця дія недоступна для поточного статусу акаунта.",
    deleteFreezeIntro:
      "Зачекай — перш ніж усе видаляти 👀\n\nНеобов'язково втрачати все. Краще *заморозь* акаунт: профіль, фото та верифікація залишаться, ти зникнеш із підбору, а наступного разу просто надішлеш /start — і одразу потрапиш у свій готовий профіль, без повторної реєстрації.\n\nВсе-таки видалити? Це вже назавжди.",
    deleteFreezeBtn: "❄️ Заморозити акаунт",
    deleteProceedBtn: "Все одно видалити акаунт",
    freezeConfirmed:
      "Готово — акаунт *заморожено* ❄️\n\n" +
      "Тебе не видно в підборі і я не писатиму. " +
      "Повертайся будь-коли через /start — усе на місці.",
    freezeWelcomeBack: "*З поверненням!* Акаунт розморожено.",
    deleteFinalYes: "Так, видалити",
    deleteFinalNoSoft: "Ні, залишити",
    deleteFinalNoHard: "Ні, залишити",
    freezePartnerNotice:
      "Важливо: твій метч більше недоступний, тож це побачення не відбудеться. " +
      "Не хвилюйся — у наступному підборі в тебе буде пріоритет 💛",

    // --- Matching ---
    matchHeadline: "💘 Знайшли тобі метч!",
    matchDeadlineNotice: "На відповідь 24 години. Передумати потім не можна.",
    matchStreamStart: "Чому ви підходите…",
    matchBtnAccept: "Прийняти",
    matchBtnDecline: "❌ Пас",
    matchDeclineConfirmPrompt:
      "Точно пасуєш?\n\nЦе рішення остаточне — цю людину ти більше не побачиш.",
    matchBtnConfirmDecline: "❌ Так, пас",
    matchBtnKeepDeciding: "← Назад",
    matchDecisionQuestionM:
      "Хочеш піти з ним на побачення? Просто відповідай так або ні.",
    matchDecisionQuestionF:
      "Хочеш піти з нею на побачення? Просто відповідай так або ні.",
    matchTextYesConfirm: "Чудово ✨ Підтверди — і далі все зроблю я:",
    matchBtnConfirmGo: "💫 Так, іду на побачення",
    matchTextUnsure:
      "Не поспішай — коли вирішиш, просто напиши мені «так» або «ні».",
    matchDeclineDismissed:
      "Без поспіху — цей метч ще чекає на твою відповідь. 💛",
    matchAcceptedToast: "Прийнято",
    matchDecisionSavedToast: "Записав",
    matchAccepted: "Прийнято ✨ Чекаємо на іншу сторону.",
    matchBothAccepted: "Взаємно 🤍 Знайдемо час.",
    matchDeclined:
      "Зрозумів. Що не підійшло? Обери варіант або напиши своїми словами — врахую наступного разу.",
    matchDeclineReasonType: "Не мій тип зовні",
    matchDeclineReasonVibe: "Не той вайб",
    matchDeclineReasonInterests: "Не збіглися інтереси",
    matchDeclineReasonLifestyle: "Різний спосіб життя",
    matchDeclineReasonOther: "Інша причина",
    matchDeclineOtherAsk:
      "Ок — надішли короткий текст або голосове з причиною. Врахую в наступному підборі.",
    matchDeclineFeedbackSaved:
      "Прийняв. Наступний підбір налаштую з урахуванням цього.",
    matchDeclineAlreadyNoted: "Уже записав — дякую.",
    matchDeclineFeedbackFailed:
      "Не вдалося зберегти просто зараз. Можеш усе одно надіслати короткий текст або голосове.",
    matchDeclineThanks: "Зрозумів. Шукаю далі.",
    matchPeerDecided: "*Твій метч уже відповів*\n\nЩо саме — дізнаєшся після своєї відповіді.",
    matchPeerWasAccepted: "До речі — твій метч був згодний. Цього разу просто не склалось.",
    matchPeerWasDeclined: "До речі — твій метч цього разу відмовився.",
    matchAcceptedPeerDeclined:
      "Цього разу з того боку — ні. Буває: тут побачення стається лише за взаємного інтересу. " +
      "Шукаю далі — наступний варіант буде ближчим.",
    matchAcceptedPeerDeclinedPriority:
      "Цього разу з того боку — ні. Буває: тут побачення стається лише за взаємного інтересу.\n\nЯ підняв твій пріоритет у наступному підборі. Наступний варіант буде ближчим.",
    matchPhotoCaption: "{name}, {age}",
    matchVerifiedLabel: "Підтверджено",
    matchVerifiedQuote: "Перевірено: на фото справді ця людина.",
    matchSynergyLabel: "Сумісність {score}/99",
    matchSynergyHeader: "💎 {label} — {reason}",
    pitchCountdownHours: "⏳ Залишилось {hours}год на відповідь",
    pitchCountdownMinutes: "⏳ Залишилось {minutes} хв на відповідь",
    pitchDeadlineBtnHm: "⏳ Залишилось на відповідь: {h}год {m}хв",
    pitchDeadlineBtnMin: "⏳ Залишилось на відповідь: {m}хв",
    pitchCountdownTapToast: "Просто скажи так чи ні, коли вирішиш — вікно ще відкрите ✨",
    pitchDeadlineNudge:
      "Невелике нагадування — вікно, щоб відповісти на цей метч, закриється приблизно за {hours}год. Якщо хочеш піти, просто скажи так зараз; якщо ні — теж окей.",
    stallPartnerFallbackName: "твій метч",
    stallActionExpired: "Тут уже все вирішилося — відповідати більше не потрібно.",
    matchCardExpiredAlert: "Ця картка метчу вже неактивна — вирішувати тут більше нічого.",
    emergencyStaleAction: "Це побачення вже неактивне. Перевір актуальний статус перед новою дією.",
    calendarStaleAction: "Цей календар уже закритий. Відкрий актуальну картку метчу, щоб побачити зміни.",
    stallVenueNudge:
      "Залишилося відмітити, звідки поїдеш — і я підберу місце, зручне вам обом.",
    stallCheckInScheduling:
      "{name} чекає — ви зупинилися на виборі часу.\nВсе ще в силі?",
    stallCheckInVenue:
      "{name} чекає — ви зупинилися на виборі місця.\nВсе ще в силі?",
    stallBtnStillOn: "🟢 Так, все в силі",
    stallBtnPlansChanged: "Плани змінилися",
    stallPeerAsked:
      "Нагадав {name} про тебе — чекаю відповіді.\n\nВід тебе поки нічого не потрібно.",
    stallStillOnAck: "Зрозумів, усе в силі ✨",
    stallPeerStillOn: "{name} на зв'язку, усе в силі ✨",
    stallCancelConfirmPrompt:
      "Скасовуємо побачення з {name}?\n\nРішення остаточне — цю пару я більше не запропоную.",
    stallBtnCancelConfirm: "🔴 Так, скасувати",
    stallBtnCancelBack: "🟢 ← Назад",
    stallCancelAborted: "Добре — усе в силі. 👍",
    stallCancelDone:
      "Зрозумів. {name} я попередив — без подробиць.\n\nТи знову в підборі.",
    stallPeerCancelled:
      "Побачення скасовано — у {name} змінилися плани.\n\n" +
      "Це не про тебе. Підняв твій пріоритет у наступному підборі.",
    stallTimeoutPartnerGone:
      "Побачення скасовано — від {name} так і не було відповіді.\n\n" +
      "Шкода, але краще зараз, ніж у день зустрічі. Підняв твій пріоритет у наступному підборі.",
    stallTimeoutSelf:
      "Побачення з {name} скасовано — відповіді не було дві доби, " +
      "а тримати вас обох у підвішеному стані я не міг.\n\n" +
      "Якщо плани змінюються — просто напиши мені. Це нормально.",
    stallTimeoutVenueUnresolved:
      "Побачення з {name} скасовано — я так і не зміг вчасно підібрати вам місце.\n\n" +
      "Це не ваша провина, а моя. Підняв твій пріоритет у наступному підборі.",
    pitchExpired: "⏳ Час вийшов — пропозиція більше не актуальна.",
    matchExpiredSilentWarning:
      "*Час на відповідь вийшов*\n\nНаступного разу відповідай хоча б «ні» — людина чекає.",
    matchExpiredSilentPenalty:
      "*Час на відповідь вийшов*\n\nЦе вже вдруге, тому рейтинг знижено. Наступного разу відповідай хоча б «ні» — людина чекає.",
    matchExpiredYouMissedDate:
      "Важливо: твій метч був згоден прийти — це могло бути справжнє побачення.\n\n",
    matchExpiredPeerIgnored:
      "Твій метч не відповів за добу — побачення не відбудеться. Побачимось у наступному підборі.",
    // §3.4 — this side PASSED, and the partner then went silent. A first
    // decision leaves the row `proposed` either way, so a decliner reaches
    // expiry classified as a `responder` exactly like someone who accepted
    // and got stood up. They already got their "you passed" ack, so this is
    // deliberately a bare fact with no consolation and no card: it exists
    // only so the match doesn't vanish from the menu and banner unexplained.
    matchExpiredSelfDeclined: "Метч закрито. Побачимось у наступному підборі.",
    // Картка спливання (PRODUCT_SPEC §3.4) — заголовки гендерно-нейтральні.
    expiryCardOverlineExpired: "ВІКНО ЗАЧИНЕНО",
    expiryCardHeadlineExpired: "ЧАС\nВИЙШОВ",
    expiryCardSublineExpired:
      "Минуло 24 години без відповіді.\nЧекаємо на тебе в наступному підборі.",
    expiryCardOverlinePenalty: "ВДРУГЕ БЕЗ ВІДПОВІДІ",
    expiryCardHeadlinePenalty: "РЕЙТИНГ\nЗНИЖЕНО",
    expiryCardSublinePenalty: "Другий метч без відповіді.\nЧекаємо на тебе в наступному підборі.",
    expiryCardOverlinePeerIgnored: "ЦЕ НЕ ПРО ТЕБЕ",
    expiryCardHeadlinePeerIgnored: "ПАРА НЕ\nВІДПОВІЛА",
    expiryCardSublinePeerIgnored:
      "Побачення не відбудеться.\nТвою частину було зроблено вчасно.",
    expiryCardOverlineMissedDate: "ТОБІ СКАЗАЛИ ТАК",
    expiryCardHeadlineMissedDate: "ЦЕ БУЛО\nВЗАЄМНО",
    expiryCardSublineMissedDate:
      "Пара була готова зустрітися.\nЗа 24 години відповіді не було.",
    expiryCaptionSilentWarning: "Наступного разу відповідай хоча б «ні» — людина чекає.",
    expiryCaptionSilentPenalty:
      "Це вже вдруге, тому рейтинг знижено. Наступного разу відповідай хоча б «ні» — людина чекає.",
    expiryCaptionPeerIgnored: "Побачимось у наступному підборі.",
    noMatchThisWeekTier1:
      "*Цього тижня без метчу*\n\nНе знайшов того, хто справді підходить, а пропонувати будь-кого не хочу. У наступному підборі в тебе пріоритет ✨",
    noMatchThisWeekTier2:
      "*Знову без метчу*\n\nДругий тиждень поспіль не бачу того, хто справді підходить. Дякую, що чекаєш — у наступному підборі твій пріоритет ще вищий 🤍",
    noMatchThisWeekTier3:
      "*Поки без метчу*\n\nЛюдини, яка підходить, досі немає, а пропонувати будь-кого я не буду. Стежу за твоєю чергою — у наступному підборі ти серед перших 🤍",
    noMatchDiscountOffer:
      "🎟️ Невелика подяка за терпіння: твоє наступне перше побачення — зі знижкою {pct}% на один квиток. " +
      "Ми застосуємо знижку автоматично, коли тобі випаде пара або ти відкриєш свої квитки.",
    poolExhaustedPauseNotice:
      "*Ставлю пошук на паузу*\n\nЗараз для тебе справді нікого немає — справа не в тобі. Щойно з'явиться людина, яка підходить, сам поверну тебе в пошук.",
    poolExhaustedResumeNotice:
      "Гарні новини — з'явився той, хто підходить, і я повернув тебе в пошук. Ти в наступному підборі 🤍",
    matchScheduleProposal: "Як тобі ці варіанти? Тисни зручний:",
    matchScheduleIter3:
      "Взаємно 🤍 Відкрий календар і познач зручний час.",
    matchScheduleAfterTicket:
      "📅 Тепер обери час — відкрий календар і познач усі зручні слоти.",
    matchScheduleBtnCalendar: "📅 Відкрити календар",
    // --- Date Ticket (преміум-крок після взаємного метчу) ---
    ticketCardCaption: "Це метч 🤍 Візьми квиток — і оберемо час.",
    ticketCardCaptionPremium: "Це метч 🤍 Premium покриває обидва квитки — одразу обираємо час.",
    ticketButton: "🎟️ Отримати квиток на побачення",
    ticketViewButton: "🎟️ Переглянути свій квиток на побачення",
    ticketStatusButton: "Відкрити побачення",
    ticketGateWaiting: "Квиток готовий ✨ Чекаємо на іншу сторону.",
    ticketPeerTookTheirs:
      "{name} уже з квитком на побачення 🎟️ Залишився твій — і відкриємо планування.",
    bumpVerifiedDm:
      "Ви обидва на місці ✨ Побачення зараховано, а квиток на наступне — від мене.",
    bumpDeckIntro: "Якщо розмові знадобиться, куди піти:",
    ticketBothSecuredDm: "Обидва квитки у вас 🎟️ Побачення в силі — оберімо час.",
    ticketPartnerPaidDm: "{name} вже сплатив твій квиток на побачення ❤️ Тобі нічого не потрібно робити.",
    ticketCoveredHerConfirm:
      "💛 Готово — ти оплатив квиток за {name}. Щойно вона це побачить, я дам тобі знати.",
    ticketPartnerSawItDm: "❤️ {name} побачила, що ти оплатив її квиток.",
    ticketRefundedDm: "Твій квиток повернувся в гаманець, а побачення в силі. Давай оберемо час 📅",
    ticketRefundedToWallet:
      "🎟️ Квиток повернувся до твого гаманця — використаєш його на наступному свіданні.",
    ticketRefundedToWalletBoth:
      "🎟️ Обидва квитки, які ти оплатив, повернулися до твого гаманця — використаєш їх на наступному свіданні.",
    matchScheduleNoOverlap: "Не збіглося — спробуємо ще.",
    matchScheduled: "Готово — до зустрічі 🤝\n\n{venue}",
    matchScheduledNoReservation:
      "🍵 У час пік там може не бути місць — це ок: можна взяти каву з собою і прогулятися або зазирнути в інше місце поруч.",
    matchScheduledBtnOpenMaps: "📍 Відкрити в картах",
    matchScheduledBtnShare: "📤 Поділитися карткою",
    dateCardWhen: "КОЛИ",
    dateCardSlogan: "Без листування\nОдразу наживо",
    dateCardShareCaption:
      "Ділися сміливо — обличчя твого метчу приховане, щоб зберегти його приватність 💞",
    dateCardShareFailed: "Не вдалося підготувати картку для надсилання — спробуй за хвилину.",
    matchSchedulePickedPrefix: "Твій вибір: ",
    matchScheduleWaitingPeer: "Чекаємо на вибір іншої сторони…",
    matchSchedulePeerProposed:
      "Твій метч уже позначив час у календарі. Відкрий — погодься або запропонуй свій:",
    matchSchedulePeerSuggestedAlternative:
      "Твій метч запропонував інший час. Глянь — можна погодитись або запропонувати свій варіант.",
    matchScheduleSavedConfirmation:
      "Готово. Твій метч отримав сповіщення — напишу, щойно відповість.",
    matchScheduleNoOverlapYet:
      "Ви обоє позначили час, але поки нічого не збіглося. Додай ще кілька слотів — щойно один перетнеться, фіксую дату:",
    matchSchedulePickFinalYet:
      "Ваші календарі вже збіглися — відкрий його й підтверди зручний час, і дату зафіксовано:",
    venueTimeCardLabel: "ВАШЕ ПОБАЧЕННЯ",
    venueTimeLockedCaption: "Час вашого побачення зафіксовано ✨",
    venueConciergeIntro:
      "*Звідки поїдеш на побачення?*\n\nПознач точку на карті — дім, метро, будь-яке зручне місце. Підберу місце, куди зручно дістатися вам обом.",
    venueConciergeBtnLocation: "📍 Надіслати геолокацію",
    venueConciergeBtnMap: "🗺️ Обрати на карті",
    venueLocationFirst:
      "Спершу головне — *познач, звідки ти будеш виїжджати* 📍 Натисни кнопку нижче й постав точку на карті.",
    venueOriginOutsideMarket:
      "Ця точка за межами {city}, а Gennety поки працює лише там — я шукаю місце неподалік від вас обох, і звідти підібрати не зможу. Познач точку в {city}, звідки будеш виїжджати:",
    venueVibeNoted: "Вайб записано ✨ Тепер вкажи, звідки поїдеш:",
    venueLocationNoted:
      "Точку виїзду збережено ✨ Тепер — який *вайб* хочеш? Наприклад: _тихе кафе_, _веган-сніданок_, _прогулянка в парку_, _невеликий музей_.",
    venueSafetyOverride:
      "Невеличке уточнення — заміняю на публічне кафе. Перші побачення у нас у людних місцях.",
    venueWaitingPeer: "Прийняв ✨ Чекаємо на іншу сторону…",
    venueLocationUseMap:
      "Геоточки з чату більше не потрапляють у пошук місця — познач точку відправлення на карті нижче 📍",
    venueTimeLapsedBackToCalendar:
      "До часу побачення лишилося надто мало, щоб встигнути підібрати місце, — оберімо новий.",
    venueSelectionFailedRetry:
      "Не вдалося підібрати місце для побачення — пошук місць дав збій на нашому боці. Відкрий екран місця й ще раз підтвердь точку відправлення, щоб спробувати знову.",
    peerWaitT1Sent: "Передали {name}, чекаємо відповіді",
    peerWaitT2Waiting: "{name} ще думає над відповіддю",
    peerWaitT3Quiet: "{name} поки мовчить, чекаємо",
    peerWaitT4Nudged: "Нагадали {name} про тебе, чекаємо відповіді",
    peerWaitT5Deadline: "{name} довго не відповідає",
    peerWaitAnon: "Чекаємо на іншу сторону",
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
    onbAnalyzeStep1b: "💭 Обмірковую…",
    verifyAnalyzeStep1: "🔍 Звіряю селфі з фото…",
    verifyAnalyzeStep2: "🧬 Аналізую риси обличчя…",
    verifyAnalyzeStep3: "⏳ Завершую перевірку…",
    voiceCheckStep1: "🎧 Слухаю твій запис…",
    voiceCheckStep2: "Перевіряю, що все гаразд…",
    videoCheckStep1: "🎬 Переглядаю твоє відео…",
    videoCheckStep2: "🙂 Перевіряю, що це ти…",
    videoCheckStep3: "✨ Майже готово…",
    skipAnalyzeStep1: "✨ Допрацьовую профіль…",
    skipAnalyzeStep2: "🧮 Зводжу все воєдино…",
    skipAnalyzeStep3: "💞 Готую до підбору…",
    profilerBatchThinking: "Обмірковую…",
    profilerBatchSaving: "Зберігаю твої відповіді…",
    profilerBatchSaved:
      "Картку оновлено ✨ Врахую під час наступного підбору.",
    profilerNextAck: "Прийнято…",
    profilerNextFormulating: "Обмірковую…",
    profilerRefusalAck: "Окей, не наполягаю. Запитаю іншим разом 💛",
    profilerImageUnreadable: "Хм, не зміг розібрати 😅 Розкажи словами?",
    profilerLinkUnreadable: "Не можу відкрити — мабуть, приватне або видалене 😅 Розкажи словами або скинь картинкою?",

    // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
    venueChangeButton: "🔄 Змінити місце",
    venueBoardPingFromF: "{name} придивляється до затишнішого місця для вашого побачення 👀",
    venueBoardPingFromM: "{name} пропонує поглянути на кілька інших місць для вашого побачення 👀",
    venueBoardPingBtn: "Поглянути",
    venueKeepNotice: "Твій метч хотів би залишитися у {venue}. Можна запропонувати інше місце нижче.",
    venueBothKeepDm: "Ви обоє залишаєтесь у {venue} — нічого не змінюється, до зустрічі.",
    venueDeclinedKeepDm: "Залишаєтесь у {venue}, як і планували.",
    venueChangeRefunded:
      "Зміна місця не пройшла, тож зірки повернулися до тебе. Побачення в силі — у тому місці, про яке домовлялися спочатку.",
    primeInvoiceTitle: "Пізні вечори",
    primeInvoiceDesc:
      "Відкриє 18:30, 19:00 і 19:30 в усі дні вашого календаря — для вас обох, на це побачення.",
    primeInvoiceLabel: "Пізні вечори",
    primeTimeOpenedDm:
      "{name} відкриває пізні вечори — 18:30 і пізніше тепер є у вашому календарі.",
    primeTimeRefunded:
      "Пізні вечори не відкрилися, зірки повернулися до тебе. Решта календаря без змін.",
    primeTimeRefundedDateOff:
      "Побачення не відбудеться, тож зірки за пізні вечори повернулися до тебе.",
    memeCardTeaser:
      "🎭 Ще дещо про {name}.\n\nКоли я запитав, що по-справжньому смішить, відповіді словами не було — прилетів мем. Це говорить про людину більше, ніж будь-які три речення.\n\nХочеш побачити його до зустрічі?",
    memeCardBtn: "🎭 Показати",
    memeRevealCaption: "🎭 Що смішить {name}:",
    memeRevealSource: "▶️ Подивитися повністю:",
    memeRevealFallback:
      "🎭 Саму картинку переслати не вийшло, тому словами. {name} — про те, що смішить:\n\n_{description}_",
    memeRevealGone: "На це питання відповіли наново словами — мема тут більше немає.",
    memeRevealUnavailable: "Ця картка вже неактивна.",
    venuePayPromptDm: "Ви разом обрали нове місце для побачення.\n\n📍 {venue}",
    venuePayOpenBtn: "📍 Подивитися й вирішити",
    venueWishText:
      "{name} знайшла місце, яке їй дуже подобається.\n\n" +
      "Їй буде приємно, якщо закріпиш його ти.",
    venueWishTextFallback:
      "{name} знайшла місце, яке їй дуже подобається.\n\n📍 {venue}\n\n" +
      "Їй буде приємно, якщо закріпиш його ти.",
    venueWishPayBtn: "Закріпити — {stars} ⭐",
    venueWishDeclineBtn: "Не цього разу",
    venuePayDeclineAck:
      "Зрозумів — місце поки лишається тим самим. Якщо воно зміниться, прийде оновлена картка.",
    venuePayDeclineStale:
      "Ця картка вже неактуальна — плани щодо місця відтоді змінилися. Натисни нижче, щоб подивитися, що зараз.",
    venuePaySelfDm:
      "Ви зійшлися на новому місці.\n📍 {venue}\nЗакріпи його — і я оновлю ваші картки.",
    venuePaySelfBtn: "⭐ Закріпити — {stars}",
    venueSettledCard: "Готово — у вашого побачення нове місце 📍 {venue}",
    venueSettledPaidByM: "{name} оплатив зміну місця ❤️ Ваше побачення тепер у {venue}",
    venueSettledPaidByF: "{name} оплатила зміну місця ❤️ Ваше побачення тепер у {venue}",
    venueExpressPartnerFromF: "{name} обрала для тебе затишніше місце. Нове місце: 📍 {venue}",
    venueExpressPartnerFromM: "{name} обрав для тебе нове місце. Нове місце: 📍 {venue}",
    venueLapsedDm: "Зміну місця так і не закріпили — зустрічаєтесь у {venue}, як і планували.",
    venueKeepOriginalDm: "Твій метч вирішив нічого не змінювати — зустрічаєтесь у {venue}, як і планували.",
    venueInvoiceTitle: "Зміна місця побачення",
    venueInvoiceDesc: "Нове місце побачення: {venue}",
    venueInvoiceLabel: "Зміна місця",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Побачення через 5 годин! Ось теми для розмови:\n\n",
    icebreakerStreamStart: "✨ Добираю, про що вам двом поговорити…",
    noMatchStreamStart: "💫 Переглядаю кандидатів для тебе…",
    profilerSkip: "Пропустити",
    wingmanHintIntro:
      "👋 Маленька підказка — побачення через півтори години:\n\n",
    dateTerminalInvite:
      "*Побачення за {minutes} хв*\n📍 {venue}\n\nВідкрий екран побачення — він покаже дорогу. За столиком прикладіть телефони один до одного й утримуйте, щоб обмінятися контактами.",
    dateTerminalReminder:
      "*Обмін контактами відкрито*\n📍 {venue}\n\nКоли ви обоє за столиком — відкрий екран побачення, прикладіть телефони один до одного й утримуйте.",
    dateTerminalBtn: "🎟 Відкрити побачення",
    dateDayActivityStartTitle: "Сьогодні побачення",
    emergencyPushTitle: "Побачення скасовано",
    emergencyPushBody: "Відкрий Gennety — там причина.",
    dateDayActivityStartBody: "Усе потрібне — на екрані блокування.",
    venueActivityStartTitle: "Зміна місця",
    venueActivityStartPartner: "{name} пропонує {what}",
    venueActivityStartPartnerKeep: "{name} хоче залишити {venue}",
    venueActivityStartWaiting: "Чекаємо на відповідь щодо місця",
    venueActivityStartMatch: "Спільний вибір: {venue}",
    venueActivityPartnerFallback: "Твій метч",
    // The time-agreement lock-screen card (iOS `time_agreement` Live Activity,
    // decision 2026-09-23): the alert a push-to-start carries, and the one an
    // update carries when the PARTNER moved. `{when}` is a weekday + HH:mm in the
    // RECIPIENT's timezone (the weekday is dropped when the slot is today); the
    // partner name is only ever the SUBJECT — the server declines no names, which
    // is also why waiting has a nameless twin rather than reusing
    // `venueActivityPartnerFallback` ("Ждём, когда Твой мэтч ответит" would
    // capitalise mid-sentence).
    timeActivityStartTitle: "Обираємо час",
    timeActivityStartPartner: "{name} пропонує {when}",
    timeActivityStartWaiting: "Чекаємо, коли {name} відповість",
    timeActivityStartWaitingNoName: "Чекаємо на відповідь щодо часу",
    timeActivityStartMatch: "Час призначено: {when}",
    emergencyUnlocked: "Плани змінилися і зовсім не можеш прийти? Скасувати можна кнопкою нижче.",
    emergencyBtn: "Скасувати побачення",
    emergencyConfirmPrompt:
      "Якщо це просто хвилювання чи запізнення — краще залиш побачення. *Скасовуй, лише якщо точно не можеш прийти:* повернути метч буде не можна.",
    emergencyBtnConfirm: "🔴 Так, скасувати побачення",
    emergencyBtnBack: "🟢 Залишити побачення",
    emergencyAborted: "Гаразд — побачення залишається в силі. 👍",
    emergencyAskReason:
      "Напиши причину. Текст піде метчу *як є*.",
    emergencyConfirmed:
      "Побачення скасовано. Повідомлення переслано.",
    emergencyDateStarted:
      "Час побачення вже настав, тож скасувати його більше не можна. " +
      "Якщо зустріч не відбулася, я запитаю тебе про це наступного дня.",
    emergencyReceivedOther:
      "Метч скасував побачення. Ось що написав:\n\n\"{reason}\"",
    emergencyReceivedOtherIntro:
      "Метч скасував побачення. Ось що написав:",
    emergencyReceivedOtherSoftNote:
      "Це не через тебе. Gennety трохи підніме твій пріоритет у наступному підборі.",
    feedbackInvitation:
      "*Як пройшло побачення?* ✨\n\nПоділись парою деталей: чи була хімія, який був вайб, чи сподобалось місце?",
    feedbackBtnForm: "✍️ Відкрити форму",
    feedbackBtnVoice: "🎤 Записати голосом",
    attendanceAsk: "Перш ніж питати, як усе минуло — ви вчора зустрілися? 🙂",
    attendanceAskLikelyMet:
      "Схоже, вчора все відбулося 🙂 Уточню про всяк випадок: ви зустрілися?",
    attendanceAskLikelyNotMet:
      "Здається, вчора зустріч не склалася. Правильно зрозумів — ви не зустрілися?",
    attendanceBtnYes: "Так, зустрілися",
    attendanceBtnNo: "Ні, не вийшло",
    attendanceNoIntro: "Шкода, що так вийшло. Що сталося?",
    attendanceOutcomePartner: "Партнер не прийшов",
    attendanceOutcomeSelf: "Не вийшло в мене",
    attendanceOutcomeBoth: "Домовилися перенести",
    attendanceOutcomeOther: "Інше",
    attendanceNoThanks: "Дякую за відповідь — зафіксував. Шкода, що так вийшло.",
    attendanceAlreadyAnswered: "Уже відмітив, дякую ✨",
    attendancePushTitle: "Ви зустрілися?",
    attendancePushBody: "Один дотик — і я зрозумію, чи варто питати, як усе минуло.",
    feedbackVoiceAsk:
      "Просто запиши голосове 🎙️\n\n" +
      "Розкажи, як пройшло — чи була хімія, що сподобалось, що не дуже. " +
      "Хвилини цілком вистачить.",
    feedbackThanks: "Дякую! Врахую в наступному підборі ✨",
    feedbackAlreadySubmitted: "Відгук про це побачення вже є — дякую, усе збережено ✨",
    feedbackPushTitle: "Як пройшло побачення?",
    feedbackPushBody: "Хвилина твого часу — і наступного разу ми підберемо точніше.",
    matchDropPushTitle: "Твою пару знайдено",
    matchDropPushBody: "Натисни, щоб подивитися ✨",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Поскаржитися",
    reportAsk:
      "Ця скарга приватна. Що найкраще описує проблему?",
    reportCategoryFakePhotos: "Фейкові або оманливі фото",
    reportCategoryWrongPerson: "На фото інша людина",
    reportCategoryOffensive: "Грубість або дивна поведінка",
    reportCategoryUnsafe: "Мені було небезпечно",
    reportCategorySpam: "Спам або шахрайство",
    reportCategoryInappropriate: "Неприйнятний профіль",
    reportCategoryOther: "Інше",
    reportDetailAsk:
      "Є щось іще, що допоможе швидше розібратися? Можна написати, надіслати голосове або пропустити.",
    reportDetailAskOther:
      "Коротко опиши, що сталося. Можна написати або надіслати голосове.",
    reportSkipBtn: "Пропустити",
    reportThanksT1: "Прийнято — врахуємо в майбутніх метчах 🎯",
    reportThanksT2: "Скаргу зареєстровано. Дякуємо — розберемося.",
    reportThanksT3:
      "Скаргу прийнято. Акаунт цієї людини заморожено до перевірки. Дякуємо за сигнал.",
    reportFailed: "Не вдалося обробити скаргу. Спробуй за хвилину.",
    reportDuplicate: "Скаргу на цей метч уже надіслано.",
    reportBackBtn: "← Назад",
    reportCancelled: "Гаразд — скаргу не надіслано.",
    reportWarningStrike1:
      "⚠️ На тебе надійшла скарга щодо нещодавнього метчу. " +
      "Gennety очікує шанобливої та надійної поведінки. Ще одна підтверджена скарга — і акаунт буде тимчасово заблоковано.",
    reportSuspendedDM:
      "🚫 Твій акаунт заблоковано на 14 днів через повторні скарги. " +
      "У цей період метчі не надходитимуть. Автоматично розблокується після завершення терміну.",
    reportBannedDM:
      "⛔ Твій акаунт заблоковано назавжди через численні підтверджені скарги.",
    reportPendingInvestigationDM:
      "🚫 Твій акаунт заморожено для перевірки безпеки. " +
      "Команда зв'яжеться через @gennetysupport, якщо знадобляться подальші дії.",
    safetyNoteFemale:
      "*Побачення за півтори години — {location_name}*\n\n📍 *Дотримуйся плану.* Ми підібрали для вас безпечне публічне місце. Не погоджуйся переносити зустріч у відлюдне місце чи їхати в гості.\n🚗 *Транспорт.* Добирайся туди й назад самостійно — громадським транспортом, таксі чи пішки. Не сідай у машину до малознайомої людини.\n📱 *Попередь близьких.* Перешли подрузі або комусь із близьких деталі зустрічі й, якщо можеш, поділися геолокацією на вечір.\n🛑 *Твої межі.* Якщо тобі некомфортно або поведінка партнера здається дивною — можна просто встати й піти будь-якої миті. Твоя безпека важливіша за ввічливість.\n\nГарного вечора ✨",
    safetyBriefPushTitle: "Перед виходом",
    safetyBriefPushBody: "Пам'ятка безпеки на сьогодні вже в застосунку.",
    noMatchPushTitle: "Цього разу без метчу",
    noMatchPushBody: "Поки нікого відповідного не знайшлося. Пошук триває.",
    matchNudgePushTitle: "Метч усе ще чекає",
    matchNudgePushBody: "Так чи ні — обидва варіанти нормальні. Вікно ще відкрите.",
    planningNudgePushTitle: "Побаченню все ще потрібен час",
    planningNudgePushBody: "Зазирни в календар, коли буде хвилинка.",
    deadlineNudgePushTitle: "Вікно закривається",
    deadlineNudgePushBody: "Відповісти можна ще приблизно {hours}год. Так чи ні — обидва варіанти нормальні.",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Наступний метч через {d}д {h}г",
    statusHoursMinutes: "⏳ Метчі прилетять через {h}г {m}хв",
    statusMinutes: "✨ Майже готово! Метчі прилетять за {m} хв",
    statusProcessing: "✨ Скануємо твоє місто… Зазирни трохи згодом.",
    statusBannerSchedule: "Наступний підбір: {date}, {time}",
    statusBannerActive: "Ми вже шукаємо твою людину ✦",
    statusBannerSearching:
      "Шукаю твою людину — перевіряю щовечора.\n" +
      "Щойно з'явиться хтось, хто справді вартий твого часу, я напишу.",
    statusButtonDaysHours: "До підбору: {d}д {h}г",
    statusButtonHoursMinutes: "До підбору: {h}г {m}хв",
    statusButtonMinutes: "✨ До підбору: {m}хв",
    statusButtonProcessing: "✨ Підбираємо метчі",

    // --- Stage-aware banner (PRODUCT_SPEC §2.1) ---
    statusBannerDecision:
      "Залишилось на відповідь:\n\n" +
      "Твій метч чекає. Відповідай «так» або «ні» просто тут, у чаті.",
    statusBannerPlanning:
      "Побачення планується ✦\n\n" +
      "Деталі ще узгоджуються — усе по ньому в «Моєму побаченні».",
    statusBannerDate: "До побачення:",
    statusTimeDaysHours: "{d}д {h}г",
    statusTimeHoursMinutes: "{h}год {m}хв",
    statusTimeMinutes: "{m}хв",
    statusButtonDateOpen: "Деталі",

    // --- Kyiv-only market gate (PRODUCT_SPEC §1.1) ---
    statusBannerMarketPending:
      "Поки Gennety працює лише в Києві — у місті {city} ми ще не запустилися, і метчити тебе тут немає з ким.\n\nХочеш ходити на побачення в Києві? Зміни місто в меню.",
    statusButtonMenu: "Відкрити меню",
    menuCitySwitch: "📍 Змінити місто на Київ",
    citySwitchCard:
      "📍 *Твоє місто: {city}*\n\nПоки Gennety працює лише в Києві. Метчі завжди в межах одного міста, тож до запуску в місті {city} знайомити тебе тут немає з ким.\n\nЯкщо хочеш ходити на побачення в Києві — перемкнись. Анкета, фото та верифікація залишаться як є, і ти потрапиш у найближчий підбір.",
    citySwitchConfirm: "📍 Так, шукайте мені пару в Києві",
    citySwitchDone:
      "Готово — твоє місто для метчів тепер Київ 🤍\n\nТи в найближчому підборі: {date}.",
    citySwitchFailed: "Не вдалося змінити місто. Спробуй ще раз за хвилину.",
    noMatchCityNotLaunched:
      "*У місті {city} Gennety поки немає*\n\nМи працюємо лише в Києві, а метчі завжди в межах одного міста — знайомити тебе тут поки немає з ким. Анкета залишається як є, і ми напишемо, щойно відкриємо твоє місто.\n\nЯкщо хочеш ходити на побачення в Києві — перемкнись нижче й потрапиш у найближчий підбір.",
    noMatchCitySwitchBtn: "📍 Перейти на Київ",

    // --- My date (menu row + hub) + scheduled-date banner ---
    statusDateDaysHours: "💫 Побачення через {d}д {h}г",
    statusDateHoursMinutes: "💫 Побачення через {h}г {m}хв",
    statusDateMinutes: "💫 Побачення через {m} хв",
    statusDateSoon: "💫 Побачення сьогодні",
    menuMyDateDays: "💫 Моє побачення · через {d}д {h}г",
    menuMyDateHours: "💫 Моє побачення · через {h}г {m}хв",
    menuMyDateMinutes: "💫 Моє побачення · через {m} хв",
    menuMyDateSoon: "💫 Моє побачення · сьогодні",
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
    rateLimitDailyBudgetNotice: "Ти сьогодні багато пишеш 🙂 Продовжимо завтра — на сьогодні ліміт.",

    // --- Pre-date coordination (feature-flagged) ---
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
    coordProxyPushTitle: "Твоє побачення",
    coordProxyTextOnly: "У цьому чаті працюють лише текстові повідомлення — фото й голосові не передаються.",
    coordProxyClosed: "Анонімний чат закрився. Сподіваюсь, побачення пройшло чудово — зазирну завтра ✨",
    coordProxyUnavailable: "Цей анонімний чат більше недоступний.",
    coordCardProxyKicker: "АНОНІМНИЙ ЧАТ",
    coordCardProxyHead1: "Лінія",
    coordCardProxyHead2: "відкрита.",
    coordCardProxySub: "Повідомлення йдуть через мене. Контакти не розкриваються.",
    menuPremium: "✨ Gennety Premium",
    menuPremiumActive: "✨ Premium · до {date}",
    menuInviteFriend: "🎁 Запросити друга",
    referralHubTitle: "Запрошуй друзів у Gennety",
    referralHubTagline:
      "За кожного друга, який пройде перевірку за твоїм посиланням, — квиток на побачення 🎟 тобі, і йому теж.",
    referralShareButton: "📤 Запросити друга",
    referralShareCaption: "Gennety підбирає найкращу пару й сам організовує зустріч.",
    referralShareJoin: "Приєднатися до Gennety 💫",
    // --- HDYHAU (онбординговий запит про джерело, `shared/hdyhau.ts`) ---
    hdyhauQuestion: "І останнє — звідки ти про нас знаєш?",
    hdyhauFriendInPerson: "Друг розповів особисто",
    hdyhauFriendOnline: "Знайомий надіслав посилання",
    hdyhauSocialMedia: "Соцмережі",
    hdyhauSearch: "Через пошук",
    hdyhauAd: "Реклама",
    hdyhauEvent: "Вечірка або подія",
    hdyhauOther: "Звідкись іще",
    hdyhauSkip: "Пропустити",
    hdyhauThanks: "Дякуємо — це справді допомагає. 💛",
    referralRewardDm:
      "{name} — перевірку за твоїм посиланням пройдено ✨\n\nНараховано: +{tickets} 🎟\n{next}",
    referralRewardNext: "Залишилося нагород за запрошення: {remaining}.",
    referralRewardNextMax: "Це була остання нагорода за запрошення — дякуємо 💛",
    referralCardInvitedBy: "{name} кличе тебе в Gennety",
    referralCardInvitedGeneric: "Тебе запрошують",
    referralCardHeadA: "Справжні побачення.",
    referralCardHeadB: "Нуль листування.",
    referralCardSupport:
      "Gennety підбирає пару за глибокою сумісністю й сам організовує зустріч наживо.",
    referralCardGift: "{ticketsPhrase} — у подарунок",
    referralCardFooter: "gennety.com",
    premiumHubTitle: "✨ Gennety Premium",
    premiumHubBody:
      "*Gennety Premium*\n\n• *Безлімітні побачення* — твій квиток покритий щоразу, скільки б побачень не було\n• *Будь-який вечірній час* — пізні слоти в календарі відкриті для тебе\n• *Найкращі заклади* — добірка місць рівнем вище\n• *Безкоштовна зміна місця* — до двох разів за побачення, без оплати",
    premiumHubActiveNote: "У тебе Premium ✨ Активний до {date}.",
    premiumOpenCta: "Детальніше",
    premiumCancelHint:
      "Скасувати можна будь-коли — просто напиши мені, і я скасую підписку після твого підтвердження.",
    premiumManageNote: "Керувати та скасувати — у Telegram → Налаштування → Підписки.",
    premiumWelcomeDm:
      "Ласкаво просимо до Gennety Premium ✨\n\nТвої побачення тепер покриті — квиток не потрібен. Будь-який вечірній час у календарі тобі відкритий, зміна місця безкоштовна, преміум-заклади відкриті. Активно до {date}.",
    premiumExpiring3d:
      "Твій Gennety Premium завершується {date} — за три дні.\n\nЦей тариф не продовжується сам, тож покриті побачення, безкоштовна зміна місця та преміум-заклади цього дня вимкнуться. Обери наступний період: місяць або 3 / 6 місяців за нижчою ціною.",
    premiumExpiring1d:
      "Останній день твого Gennety Premium — він завершується {date}.\n\nПісля цього побачення знову коштуватимуть квиток, а преміум-заклади зачиняться. Одне натискання — і обираєш наступний період: місяць або 3 / 6 місяців за нижчою ціною.",
    premiumExpiringCta: "Обрати тариф",
    // Stars top-up warning for a RECURRING subscriber (§3.8). Distinct from
    // premiumExpiring* above: nothing is ending here — the charge is coming,
    // and it fails on an empty balance. `{amount}` is premiumRenewalAmount or
    // an empty string, so the sentence has to read correctly BOTH ways.
    premiumRenewal3d:
      "За три дні, {date}, Telegram продовжить твій Gennety Premium.{amount}\n\nСписання відбувається зірками з балансу Telegram — з картки Telegram не візьме. Якщо того дня зірок забракне, продовження не пройде і Premium стане на паузу, тож баланс варто поповнити заздалегідь: Налаштування → Мої зірки.",
    premiumRenewal1d:
      "Завтра, {date}, Telegram продовжить твій Gennety Premium.{amount}\n\nСписання йде зірками з балансу Telegram, запасної картки в нього немає — якщо завтра зірок забракне, продовження не пройде і Premium стане на паузу. Поповнити — хвилина: Налаштування → Мої зірки.",
    premiumRenewalAmount: " Спишеться {stars} ⭐.",
    premiumPlanMonthly: "1 місяць",
    premiumPlan3Months: "3 місяці",
    premiumPlan6Months: "6 місяців",
    premiumPlanSaveBadge: "−{pct}%",
    premiumPlanPerMonth: "{price}/міс",
    premiumPackageWelcomeDm:
      "Gennety Premium твій на {months} міс. ✨\n\nПобачення покриті, зміна місця безкоштовна, преміум-заклади відкриті — до {date}. Цей тариф не продовжується сам, тож я нагадаю заздалегідь.",
    premiumInvoiceTitle: "Gennety Premium",
    premiumInvoiceDesc:
      "Місячна підписка — безкоштовна зміна місця + преміум-заклади. Продовження кожні 30 днів; скасування будь-коли.",
    premiumInvoiceLabel: "Gennety Premium — 1 місяць",
    premiumCheckoutError: "Не вдалося оформити підписку. Спробуй за хвилину.",
    premiumCancelConfirm:
      "Скасовуємо Gennety Premium?\n\nPremium залишиться активним до {date} — до цієї дати все працює. Далі підписка не подовжиться і більше нічого не спишеться.",
    premiumCancelConfirmYes: "Так, скасувати",
    premiumCancelKeepBtn: "Залишити Premium",
    premiumCancelFinalConfirm:
      "Остання перевірка — точно скасовуємо Gennety Premium?\n\nPremium залишиться активним до {date}, до цієї дати нічого не зміниться. Після підтвердження автопродовження вимкнеться назавжди — захочеш повернути Premium пізніше, доведеться оплатити знову.",
    premiumCancelFinalYes: "Так, скасувати",
    premiumCancelFinalNoSoft: "Ні, залишити",
    premiumCancelFinalNoHard: "Ні, залишити",
    premiumCancelDone:
      "Готово — автоподовження вимкнено. Premium активний до {date}, більше нічого не спишеться. Повернутися можна будь-коли.",
    premiumCancelKept: "Залишаємо ✨ Premium активний до {date}.",
    premiumCancelAppStore:
      "Підписку оформлено через App Store, тож скасувати її можна лише на iPhone: Налаштування → [твоє ім'я] → Підписки → Gennety Premium → Скасувати. Доступ збережеться до {date}.",
    premiumCancelNotActive: "Зараз у тебе немає активної підписки Premium.",
    premiumCancelReasonAsk:
      "Дякуємо за час із нами 🤍 Якщо не важко — розкажи двома словами, чому скасовуєш? Це справді допомагає нам ставати кращими.",
    premiumCancelReasonSkipBtn: "Не хочу відповідати",
    premiumCancelReasonThanks: "Дякуємо, врахуємо 🤍 Premium завжди можна повернути.",

    // --- Rematch ---
    rematchOfferFamine:
      "Цього разу пари не знайшлося — справа не в тобі.\n\nМожу пошукати ще раз просто зараз: {price}. Не знайду — поверну зірки.",
    rematchOfferFailed:
      "Не склалося. Буває.\n\n" +
      "Можу піти на другий захід просто зараз і знайти тобі нову людину — {price}.\n\n" +
      "Це нове знайомство, а не гарантія побачення. Якщо нікого не знайду — зірки одразу повернуться.",
    rematchOfferNeutral:
      "Хочеш, піду на новий захід просто зараз? Одна нова людина, добір той самий: {price}.\n\n" +
      "Це нове знайомство, а не гарантія побачення. Якщо нікого не знайду — зірки одразу повернуться.",
    rematchOfferBtn: "Шукати заново — {price}",
    statusButtonRematch: "Шукати зараз",
    rematchInvoiceTitle: "Новий пошук",
    rematchInvoiceDesc: "Ще один пошук просто зараз — нова людина від Gennety.",
    rematchInvoiceLabel: "Новий пошук",
    rematchFound: "Знайшов. Зараз надішлю ✨",
    rematchNoCandidate:
      "Подивився — нових варіантів у твоєму місті зараз немає. Зірки повернув. У наступному раунді ти лишаєшся.",
    rematchRefundPending:
      "Нікого нового не знайшов, а повернення з першого разу не пройшло. Уже займаюся — зірки повернуться найближчим часом.",
    rematchUndelivered:
      "Знайшов людину, але доставити анкету не зміг — це на нашому боці. Зірки повернув, і спроба не зарахувалася.",
    rematchUndeliveredPending:
      "Знайшов людину, але доставити анкету не зміг, а повернення з першого разу не пройшло. Уже займаюся — зірки повернуться найближчим часом.",
    rematchRefunded: "Зірки за новий пошук повернулися ✨",
    rematchLimitReached:
      "Нові пошуки на зараз закінчилися. Наступний відкриється за кілька днів — звичайний підбір усе одно буде.",
    rematchUnavailable:
      "Зараз новий пошук не запустити. Якщо в тебе є метч у роботі — спершу заверши його.",
    rematchGiftFamine:
      "Я казав, що пари для тебе поки немає. Продовжив шукати — і знайшов людину, на яку варто подивитися.",
    rematchGiftFailed:
      "Минулого разу не склалося. Я повернувся до пошуку і знайшов того, хто підходить тобі більше.",
    rematchGiftNeutral:
      "Я продовжував шукати — і є людина, яку хочу тобі показати.",
    rematchSearchStep1: "🔍 Вмикаю глибокий пошук",
    rematchSearchStep2: "Дивлюся, хто зараз вільний у твоєму місті",
    rematchSearchStep3: "Звіряю за характером та інтересами",
    rematchSearchStep4: "✨ Майже — обираю одного",
    rematchCardOverline: "ТВІЙ МЕТЧМЕЙКЕР",
    rematchCardHeadline: "ЩЕ ОДИН\nЗАХІД",
    rematchCardSubline: "Нова людина, добір той самий.",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];

/** Every translation key, source-of-truth being the `en` table. For tests/tooling. */
export const TRANSLATION_KEYS = Object.keys(translations.en) as TranslationKey[];

type TranslationTable = Record<TranslationKey, string>;

const deTranslations: TranslationTable = {
  ...translations.en,
  consentMessage:
    "*Hi! Hier ist Gennety* 👋\n\nBevor wir anfangen, lies die Nutzungsbedingungen und die Datenschutzerklärung und stimme den Regeln zur Datenspeicherung zu.",
  consentAgree: "Ich akzeptiere",
  consentPrivacyButton: "Datenschutzerklärung",
  consentTermsButton: "Nutzungsbedingungen",
  welcome: "*Gennety Dating*\nWir finden dein Match und planen direkt ein echtes Date.",
  chooseLanguage: "Wähle deine Sprache:",
  philosophyPitch:
    "*Hier musst du nicht schreiben*\n\nIch lerne dich kennen, finde jemanden, der passt, und kläre Zeit und Ort selbst. Du musst nur hingehen. Los geht's?",
  philosophyContinue: "Los geht's 🚀",
  askEmail: "Schreib deine Uni-E-Mail — zum Beispiel name@knu.ua",
  invalidEmail:
    "Das sieht nicht nach einer Uni-E-Mail aus. Prüf die Adresse und schick sie noch einmal.",
  otpSent: "Ich habe einen Code an *{email}* geschickt. Gib ihn hier ein:",
  otpInvalid: "Der Code hat nicht funktioniert. Versuch es nochmal:",
  otpExpired:
    "Der Code ist abgelaufen. Gib deine E-Mail noch einmal ein, dann schicke ich einen neuen.",
  otpTooManyAttempts: "Zu viele Versuche. Gib deine E-Mail erneut ein, damit wir einen neuen Code senden.",
  otpCooldown: "Warte kurz - bitte erst in einer Minute einen neuen Code anfordern.",
  emailVerified: "E-Mail bestätigt ✨",
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
    "Fast geschafft! Schick {min}–{max} Fotos, auf denen man dich gut sieht. Keine freizügigen Bilder. Videos gehen auch — Hauptsache, man sieht dich.",
  photoReceived: "Foto {n}/{max}",
  voicePromptSkipButton: "Ohne Sprachnachricht",
  voicePromptSkipHint: "Überspringen: „{button}“, unten im Chat.",
  voicePromptPanelPlaceholder: "Mikrofon gedrückt halten — etwa 15 Sekunden",
  voicePromptRecorded:
    "Aufgenommen — hör sie dir an. Schick eine neue, um sie zu ersetzen, oder „{button}“, um sie zu verwerfen.",
  voicePromptReviewDone: "✅ Fertig",
  voicePromptSkipped: "Dann ohne Sprachnachricht — auch gut.",
  voicePromptSaved: "Gespeichert ✨ Dein Match hört sie, bevor es antwortet.",
  voicePromptTooShort: "Das war kaum eine Sekunde — die Mikrofontaste muss gehalten werden. Versuch's nochmal, ziel auf etwa 15 Sekunden.",
  voicePromptTooLong: "Etwas lang — bleib unter 30 Sekunden, sonst hört das niemand zu Ende. Nochmal aufnehmen?",
  voicePromptUnsafe: "Das kann ich nicht ins Profil stellen. Nimm etwas anderes auf — oder überspring es, es ist freiwillig.",
  voicePromptContactInfo: "Lass Namen und Nummern weg — das Treffen organisiere ich selbst, darum geht es ja. Erzähl lieber etwas über dich.",
  voicePromptUnavailable: "Ich konnte die Aufnahme nicht verarbeiten. Schick sie gleich nochmal.",
  voicePromptPitchCaption: "{name} hat das für dich aufgenommen",
  photoRejected:
    "Dein Gesicht muss auf dem Foto sichtbar sein. Versuch ein anderes Bild.",
  photoDuplicate: "Dieses Foto ist schon in deinem Profil — schick ein anderes.",
  photoDuplicateNear: "Dieses Foto ist schon in deinem Profil — schick ein anderes.",
  photoUnsafeContent:
    "Dieses Foto kann nicht im Profil veröffentlicht werden. Wähle bitte ein anderes, nicht explizites Foto.",
  photoFaceObscured:
    "Auf diesem Foto ist dein Gesicht verdeckt. Schick eins, auf dem es nicht hinter Maske oder Schal verschwindet.",
  photoMultipleFaces:
    "Dein Gesicht muss auf dem Foto sichtbar sein. Versuch ein anderes Bild.",
  photoIdentityMismatch:
    "Alle Fotos müssen zur selben Person gehören. Stelle sicher, dass dein Gesicht auf jedem Bild zu sehen ist.",
  photoIdentityUncertain:
    "Das Gesicht konnte nicht zuverlässig zugeordnet werden. Sende ein klareres Foto mit gutem Licht und gut sichtbarem Gesicht.",
  photoConsensusPending:
    "Schick noch ein Foto — mit zwei Bildern erkenne ich, dass du darauf bist.",
  photoConsensusOutlierRejected:
    "Auf einem Foto ist jemand anderes — das habe ich nicht hinzugefügt.",
  photoConsensusConfirmed: "Super, auf allen Fotos bist du ✨",
  photoConsensusNoPairCap:
    "Ich sehe noch keine zwei Fotos derselben Person. Schick noch ein klares Foto von dir.",
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
  profileConfirm: "Passt",
  profileEdit: "Etwas ändern",
  onboardingComplete:
    "*Fertig, du bist dabei!* 🎉\n\nIch suche schon dein Match — ich melde mich, sobald ich jemanden finde.",
  btnContinuePhotos: "Weiter ➡️",
  finishOnboardingFirst:
    "Schließe zuerst die Registrierung ab, dann sind Menü und Einstellungen verfügbar.\nSchreib /start, um weiterzumachen.",
  verifyPitch:
    "*Letzter Schritt — bestätige, dass du es bist*\n\nMach ein Selfie, und ich vergleiche es mit deinen Profilfotos. Fotos, auf denen du nicht bist, entferne ich.\n\nOhne den Check bekommst du weniger Vorschläge.",
  verifyPitchMandatory:
    "*Letzter Schritt — bestätige, dass du es bist*\n\nMach ein Selfie, und ich vergleiche es mit deinen Profilfotos. Wenn du nicht auf den Fotos bist, tausch sie zuerst aus. Nach dem Check suche ich sofort dein Match.",
  verifyMandatoryNotice:
    "Die Verifizierung ist jetzt für alle neuen Profile verpflichtend — das Matching startet direkt nach dem Bestehen. Dauert etwa eine Minute:",
  verifyReminderNudge:
    "Dein Profil ist fertig — es fehlt nur noch die Verifizierung. Sie dauert etwa eine Minute, und das Matching startet direkt danach:",
  verifyBtnGo: "🟢 Jetzt verifizieren",
  verifyBtnSkip: "⚪️ Erstmal überspringen",
  verifySkipNudgeCaption:
    "Kurz — hör dir das an, bevor du überspringst 👆",
  verifyBtnReconsider: "🟢 OK, ich verifiziere mich",
  verifyBtnSkipConfirm: "🔴 Trotzdem überspringen",
  // --- Photo re-upload path (a way back before/after verification) ---
  verifyBtnRedoPhotos: "📷 Andere Fotos hochladen",
  verifyBtnRedoPhotosSecondary: "📷 Erst Fotos ändern",
  verifyBtnAddPhotos: "📷 Fotos hinzufügen",
  verifyPhotosRequired:
    "Die Verifizierung vergleicht dein Selfie mit den Fotos in deinem Profil — und dort sind noch keine. " +
    "Füge zuerst mindestens {min} Fotos von dir hinzu und starte dann die Prüfung:",
  verifyBtnClearPhotos: "🗑 Alle löschen und neu hochladen",
  verifyGateLocked:
    "Menü und Matching öffnen sich direkt nach der Verifizierung. Nur dieser Schritt fehlt noch:",
  verifyPhotosRedoIntro:
    "Kein Problem — hier sind deine aktuellen Fotos. Lösch die, auf denen du nicht zu sehen bist, und lade deine eigenen hoch.",
  verifyPhotosRedoIntroRecheck:
    "Kein Problem — hier sind deine aktuellen Fotos. Lösch die, auf denen du nicht zu sehen bist, und lade deine eigenen hoch — sobald du fertig bist, prüfe ich sie automatisch erneut, ein neues Selfie brauchst du dafür nicht.",
  verifyPhotosCleared: "Fotos gelöscht. Schick {min}–{max} Fotos von dir.",
  verifyPhotosSavedRecheck:
    "Fotos aktualisiert ✅ Ich prüfe sie erneut gegen dein Verifizierungs-Selfie — du musst sie nicht wiederholen. Ich melde mich, sobald es fertig ist.",
  verifyPhotosSavedNowVerify:
    "Fotos aktualisiert ✅ Ein Schritt fehlt noch — die Verifizierung:",
  verifySkipped: "Verifizierung übersprungen. Du kannst sie später im Profilmenü machen.",
  verifyCheckAlreadyDone:
    "Schon verarbeitet - du solltest die Ergebnisnachricht oben bekommen haben. " +
    "Wenn etwas falsch wirkt, tippe auf 🟢 Jetzt verifizieren, um es erneut zu versuchen.",
  verifyRetryNotLive:
    "*Gesicht nicht erkannt*\n\nStell dich mit dem Gesicht zu hellem Licht, nimm die Brille ab und tippe noch einmal auf 🟢 Jetzt verifizieren.",
  verifyRetryUnfinished:
    "*Der Check wurde unterbrochen*\n\nMach ihn in einem Rutsch, ohne Telegram zu verlassen — das dauert etwa 15 Sekunden. Tippe auf 🟢 Jetzt verifizieren.",
  verifyRetryTechnical:
    "*Ein Fehler bei uns*\n\nTippe noch einmal auf 🟢 Jetzt verifizieren — diesmal sollte es klappen.",
  verifyReferenceExpired:
    "Wir löschen dein Verifizierungs-Selfie nach 90 Tagen, deshalb gibt es hier " +
    "nichts mehr, womit wir deine neuen Fotos abgleichen könnten. Eine weitere " +
    "10-Sekunden-Prüfung und du bist fertig - dein Profil bleibt solange online:",
  verifyOutcomeVerified:
    "Verifiziert ✨ Dein Profil ist live. Ich melde mich, wenn ich ein Match finde.",
  profilerHeadsUp:
    "Während ich jemanden für dich suche, stelle ich dir ab und zu eine einfache " +
    "Frage — was du gerade schaust, wie du dein Wochenende verbringst, was dir wichtig ist.\n\n" +
    "Antworte ehrlich und lass sie nicht liegen — je besser ich dich kenne, desto " +
    "besser bereite ich euch beide auf das Date vor: womit ihr anfangt und was ihr lieber auslasst.",
  verifyOutcomePendingReview:
    "🔍 Wir prüfen deine Profilfotos noch einmal gegen dein Verifizierungs-Selfie. Das dauert normalerweise ein paar Stunden - ich melde mich, sobald es erledigt ist.",
  verifyOutcomeRejected:
    "⚠️ *Die Fotos passen nicht zum Selfie*\n\nWenn du nicht darauf bist, tausch sie über den 📷-Button aus, dann prüfe ich neu. Wenn du es bist, mach den Check noch einmal bei gutem Licht.",
  verifyPhotosDropped:
    "Eine Sache noch: Ein paar Fotos passten nicht zum Selfie aus deiner Verifizierung, die habe ich aus deinem Profil genommen. Alles andere ist online. Lad einfach ein paar neue Aufnahmen von dir hoch, wenn du magst 📷",
  verifyPhotosBelowMinimum:
    "Du bist verifiziert ✅\n\nEin paar Fotos passten allerdings nicht zu deinem Selfie, die habe ich entfernt, und jetzt liegt dein Profil unter dem Minimum von {min} Fotos. Lad noch {need} von dir hoch, dann suche ich sofort nach einem Match 📷",
  // --- Native-app push copy for the same verification outcomes (§1.4). Own
  // strings rather than reused DM copy: these land on a lock screen, so they
  // need a title, they must stay short, and they cannot point at a Telegram
  // keyboard ("tap 📷 below") that does not exist in the app.
  verifyPushVerifiedTitle: "Verifiziert ✨",
  verifyPushVerifiedBody: "Dein Profil ist live. Ich melde mich, wenn ich ein Match finde.",
  verifyPushRejectedTitle: "Deine Fotos passen nicht",
  verifyPushRejectedBody:
    "Auf den Profilfotos ist nicht die Person aus deinem Verifizierungs-Selfie. Wenn du das nicht bist, tausch sie aus — ich prüfe automatisch erneut.",
  verifyPushPendingReviewTitle: "Wir prüfen deine Fotos",
  verifyPushPendingReviewBody:
    "Wir gleichen deine Profilfotos mit deinem Verifizierungs-Selfie ab. Meist ein paar Stunden — ich melde mich.",
  verifyPushRetryTitle: "Nur noch ein Schritt",
  verifyPushRetryBody:
    "Dein Profil ist fertig — es fehlt nur die Verifizierung. Dauert etwa eine Minute, das Matching startet direkt danach.",
  verifyPushPhotosNeededTitle: "Noch {need} Fotos",
  verifyPushPhotosNeededBody:
    "Du bist verifiziert, aber dein Profil liegt unter dem Minimum von {min} Fotos. Lad noch {need} von dir hoch, dann suche ich los.",
  verifyPushPhotosDroppedTitle: "Ein paar Fotos sind weg",
  verifyPushPhotosDroppedBody:
    "Sie passten nicht zu deinem Verifizierungs-Selfie, deshalb habe ich sie entfernt. Alles andere ist online.",
  verifyMiniAppLoading: "Verifizierung wird geöffnet…",
  verifyMiniAppFinishing: "Gleich fertig. Ergebnis wird geprüft…",
  verifyMiniAppError: "Verifizierung konnte nicht gestartet werden. Versuch es gleich noch mal.",
  verifyMiniAppCloseBtn: "Schließen",
  photoMatchMismatch:
    "⚠️ Dieses Foto passt nicht zu deinem Verifizierungs-Selfie. " +
    "Lade ein klares Foto von dir hoch, möglichst bei ähnlichem Licht.",
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
    "🎟️ *Ein kostenloses Date-Ticket gehört dir!*\n\nEin Geschenk für deine Fotos. Ein Date = 1 Ticket. Guthaben: *{balance}*",
  ticketRewardVideo:
    "🎟️ *Noch ein kostenloses Date-Ticket gehört dir!*\n\nEin Geschenk für dein Video. Ein Date = 1 Ticket. Guthaben: *{balance}*",
  ticketRewardStudent:
    "🎓 *Zwei kostenlose Date-Tickets gehören dir!*\n\nEin Geschenk für deine bestätigte Uni-E-Mail. Ein Date = 1 Ticket. Guthaben: *{balance}*",
  welcomeGiftTicket:
    "*Dein erstes Ticket geht auf mich* ❤️\n\nNormalerweise kostet ein Date 1 Ticket (~$8.49). Dieses ist gratis — es liegt schon in deiner Wallet.",
  ticketStorePurchased:
    "✨ *Zahlung erhalten!* Tickets hinzugefügt: *{count}*. Guthaben: *{balance}*",
  ticketStoreCheckoutError: "Zahlung konnte nicht bestätigt werden. Versuch es gleich noch mal.",
  premiumCheckoutAlreadySubscribed:
    "Du hast schon ein aktives Premium-Abo, deshalb wurde die Zahlung gestoppt — es wurde nichts abgebucht.",
  paymentStuckDm:
    "Deine Zahlung ist durchgegangen, aber wir konnten dir das Gekaufte nicht aushändigen — bei uns ist etwas kaputtgegangen.\n\nZahl nicht noch einmal. Wir sind bereits informiert und liefern es entweder nach oder erstatten deine Stars.",
  ticketStoreInvoiceTitle: "Gennety Date-Tickets",
  ticketStoreInvoiceDesc: "Date-Tickets für deine Wallet: {count}. Jedes Ticket deckt ein Date ab.",
  ticketGateInvoiceDesc: "Date-Zahlung. Date-Tickets: {count}. Ein Ticket gilt für eine Person.",
  ticketStoreInvoiceLabel: "Date-Tickets × {count}",
  onboardingFinalizeBlocked:
    "Ich kann dich noch nicht fertig einrichten — auf meiner Seite fehlen ein paar Angaben. Versuch es gleich noch einmal; wenn es bleibt, schreib an @gennetysupport, wir klären das.",
  onboardingPhotosNeedMore: "Fotos: {count}/{min}. Schick noch {remaining}.",
  onboardingPhotosBonusOffer:
    "Pflichtfotos erledigt ✨\nNoch {remaining} Fotos (bis {threshold}) bringen ein Gratis-Ticket. Ein kurzes Video bringt noch eins.",
  onboardingPhotosBonusOfferAfterVideo:
    "Pflichtfotos erledigt, das Video-Ticket gehört dir ✨\nNoch {remaining} Fotos (bis {threshold}) bringen ein zweites Gratis-Ticket.",
  onboardingPhotosBonusProgress:
    "Fotos: {count}/{threshold}.\nNoch {remaining}, dann gehört dir ein Gratis-Ticket.",
  onboardingPhotosBonusProgressAfterVideo:
    "Fotos: {count}/{threshold}.\nNoch {remaining}, dann gehört dir ein zweites Gratis-Ticket.",
  onboardingPhotosPhotoBonusEarned:
    "Fotos: {count}. Das Gratis-Ticket für Fotos gehört dir ✨\nDu kannst Fotos (bis {max}) oder ein Video hinzufügen — dafür gibt es noch ein Ticket.",
  onboardingPhotosBothBonusesEarned:
    "Fotos: {count}, Video da — beide Gratis-Tickets gehören dir ✨\nDu kannst noch Fotos hinzufügen (bis {max}).",
  onboardingPhotosPhotoBonusEarnedMax:
    "Alle {max} Fotos da, das Foto-Ticket gehört dir ✨\nEin kurzes Video bringt noch ein Gratis-Ticket.",
  onboardingPhotosBothBonusesEarnedMax:
    "Alle {max} Fotos und das Video sind da ✨\nBeide Gratis-Tickets gehören dir.",
  onboardingPhotosOptional:
    "Pflichtfotos erledigt.\nDu kannst weitere (bis {max}) oder ein kurzes Video hinzufügen.",
  onboardingPhotosOptionalAfterVideo:
    "Pflichtfotos und Video erledigt.\nDu kannst weitere Fotos hinzufügen (bis {max}).",
  onboardingPhotosOptionalMax: "Alle {max} Fotos sind da.\nDu kannst ein kurzes Video hinzufügen.",
  onboardingPhotosOptionalMaxAfterVideo: "Alle {max} Fotos und das Video sind da ✨",
  ticketWalletText:
    "🎟️ *Meine Tickets*\n\nTickets: *{balance}*. Jedes Date kostet 1 Ticket — nachkaufen kannst du jederzeit.",
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
  // --- Relationship intent (PRODUCT_SPEC §1.3) ---
  intentSpark: "Eine kurze, intensive Geschichte",
  intentOpen: "Mal sehen, wohin es führt",
  intentFalling: "Mich verlieben",
  intentLongterm: "Etwas Langfristiges",
  intentPrivateNote: "das siehst nur du",
  myProfileIntentLine: "🎯 Du suchst: {intent}",
  myProfileIntentUnset: "🎯 Du suchst: nicht gewählt",
  editIntentBtn: "🎯 Was ich suche",
  editIntentPrompt:
    "Wonach suchst du gerade? Wähl alles, was passt — meistens ist es nicht nur eins.\n\nDas siehst nur du — ich nutze es, um besser zu matchen.",
  editIntentCleared: "Nichts gewählt",
  editProfileBody:
    "Das lässt sich nicht ändern:\n\n• *Name:* {firstName} {surname}\n• *Alter:* {age}\n• *Universität:* {university}\n\nDu kannst bearbeiten:",
  editBioBtn: "📝 Über mich",
  editPrefsBtn: "💘 Wen ich suche",
  editMajorBtn: "💼 Was ich mache",
  editProfilePhotosBtn: "📸 Meine Fotos",
  editBioPrompt:
    "Schreib ein paar Zeilen über dich (bis 500 Zeichen) — dein Match liest sie vor dem Date.",
  editBioCurrent: "So steht es gerade da. Neuer Text ersetzt ihn:",
  editBioTooLong: "Zu lang - bleib unter 500 Zeichen.",
  editBioSaved: "„Über mich“ aktualisiert",
  editMajorPrompt:
    "Was machst du? (Job / Studium / Bereich, max. 100 Zeichen)\n👀 Für dein Match sichtbar.",
  editMajorTooLong: "Zu lang - bleib unter 100 Zeichen.",
  editMajorSaved: "Gespeichert",
  editPrefsTitle: "💘 *Wen ich suche*\n\nWas ändern?",
  editPrefsAgeBtn: "🎂 Partner-Alter",
  editPrefsDescriptionBtn: "✨ Welche Person ich suche",
  editPrefsCurrent:
    "Aktuelle Einstellungen:\n• Person: {preferences}\n• Alter: {ageRange}",
  editPrefsNotSet: "Nicht festgelegt",
  editPrefsDescriptionPrompt: "Beschreibe die Person, die du kennenlernen möchtest (max. 500 Zeichen).",
  editPrefsDescriptionEmpty: "Füge eine kurze Beschreibung hinzu — sie darf nicht leer sein.",
  editPrefsDescriptionTooLong: "Zu lang — bleib unter 500 Zeichen.",
  editPrefsDescriptionSaved: "Partnerwünsche aktualisiert",
  editHobbiesSaved: "Interessen aktualisiert",
  agentEntryPrompt: "Hier, bitte:",
  agentFallbackError: "Da ist etwas schiefgelaufen. Sag das bitte noch einmal.",
  agentBlockedVerification: "Mach zuerst die Verifizierung — danach geht alles andere auf.",
  agentBlockedSuspended:
    "Dein Konto ist gerade von unserer Seite pausiert, da kann ich hier nicht helfen. Fragen an @gennetysupport.",
  agentBlockedInvestigation:
    "Dein Konto wird gerade geprüft. Im Moment gibt es nichts zu tun — Details bekommst du bei @gennetysupport.",
  agentBlockedBanned:
    "Dieses Konto ist geschlossen. Wenn das ein Fehler ist, schreib an @gennetysupport.",
  profileEmbeddingSyncPending: "Gespeichert. Ich berücksichtige es in der nächsten Runde.",
  editPrefsBack: "⬅️ Zurück zu Bearbeiten",
  editAgeRangePrompt: "In welcher Altersspanne sollen wir nach einem Partner für dich suchen? (z. B. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Das habe ich nicht verstanden. Zwei Zahlen wie 20-28 (Bereich {min}-{max}).",
  editAgeRangeSaved: "Altersbereich aktualisiert",
  editProfilePhotosStart: "Sende neue Fotos ({min}-{max}) — einzeln oder als Album.",
  editProfilePhotosSaved: "Fotos aktualisiert",
  editProfileSaved: "Profil aktualisiert",
  photoManagerTitle: "Fotos: {count}/{max} · mindestens {min}",
  photoManagerCardDeleteBtn: "🗑 Dieses Foto löschen",
  photoManagerCardRemoved: "🗑 Foto gelöscht",
  photoManagerAddBtn: "➕ Hinzufügen",
  photoManagerDoneBtn: "Fertig",
  photoManagerMinReached: "Du brauchst mindestens {min} Fotos. Füge zuerst ein neues hinzu.",
  photoUploadStep1: "Lade deine Fotos hoch…",
  photoUploadStep2: "Prüfe die Aufnahmen…",
  photoUploadStep3: "Gleich fertig…",
  photoUploadOneStep1: "Lade dein Foto hoch…",
  photoUploadOneStep2: "Prüfe die Aufnahme…",
  photoReviewStep1: "Ich schaue mir deine Fotos an…",
  photoReviewStep2: "Gehe die Aufnahmen durch…",
  photoReviewOneStep1: "Ich schaue mir dein Foto an…",
  photoReviewOneStep2: "Gehe die Aufnahme durch…",
  photoBatchAdded: "{n} hinzugefügt · {total}/{max} im Profil",
  photoBatchNoneAdded: "Aus diesem Schwung wurde nichts übernommen.",
  photoBatchAtMax: "Du bist am Limit von {max} Fotos — lösch eins, um ein neues hinzuzufügen.",
  photoManagerDeleted: "Foto gelöscht.",
  photoStagePanelBtn: "🗂 Meine Fotos",
  photoStagePanelPlaceholder: "Schick mehr Fotos oder tippe auf 🗂",
  photoEditorIntro:
    "Das hast du bisher geschickt. Tippe auf 🗑 unter einem Foto, um es zu entfernen, oder schick neue direkt hier.",
  photoEditorBackBtn: "← Zurück zum Hochladen",
  menuVideo: "🎬 Profilvideo",
  editVideoPrompt:
    "🎬 Sende ein kurzes Profilvideo (bis {sec} Sek., max. {mb} MB). Freunde, Landschaft oder ein Party-Clip sind völlig okay — es macht dein Profil lebendiger.",
  editVideoRewardLine: "🎁 Füge jetzt eins hinzu und sichere dir ein kostenloses Date-Ticket.",
  editVideoHasOne:
    "Du hast bereits ein Profilvideo. Sende ein neues, um es zu ersetzen, oder entferne es unten.",
  editVideoRemoveBtn: "🗑 Video entfernen",
  editVideoRemoved: "Profilvideo entfernt.",
  editVideoNotAVideo: "Schick ein *Video* (bis {sec} Sek., max. {mb} MB).",
  myProfileAddVideoHint:
    "🎬 Tipp: Füge über das Menü ein kurzes Profilvideo hinzu — so fällt dein Profil mehr auf.",
  myProfileAddVideoHintReward:
    "Tipp: Füge über das Menü ein kurzes Profilvideo hinzu und sichere dir ein kostenloses Ticket 🎁.",
  pauseConfirmed: "Matching pausiert ⏸\nKeine neuen Matches, bis du fortsetzt.",
  resumeConfirmed: "Matching läuft wieder ▶️\nIch bin dran.",
  settingsTitle: "⚙️ Einstellungen",
  settingsLanguage: "🌐 Sprache",
  settingsLanguagePick: "Wähle eine Sprache:",
  settingsLanguageSaved: "Sprache aktualisiert",
  settingsTheme: "🎨 Thema",
  settingsThemePick: "Wähle dein Design:",
  settingsThemeSaved: "Thema aktualisiert",
  themeDarkOption: "🌙 Dunkel",
  themeLightOption: "☀️ Hell",
  helpBody:
    "*Brauchst du Hilfe?*\n\nProblem mit einem Match, einem Date oder dem Bot — schreib dem Support:\n\n💬 [@gennetysupport](https://t.me/gennetysupport)",
  settingsDeleteAccount: "🗑 Account löschen",
  deleteAccountConfirm:
    "*Account endgültig löschen?*\n\nProfil, Fotos und Matches sind dann weg. Das lässt sich nicht rückgängig machen.",
  deleteAccountYes: "Ja, alles löschen",
  deleteAccountNo: "Abbrechen",
  deleteAccountDone:
    "Account gelöscht. Alle Daten entfernt.\n" +
    "Wenn du zurückkommen willst, sende einfach /start.",
  deleteAccountFailed:
    "Wir konnten gerade nicht alle Daten sicher löschen. Dein Account bleibt bestehen — bitte versuche es erneut.",
  deleteAccountRefundInProgress:
    "Für deinen Account läuft noch eine Rückerstattung, und würden wir ihn jetzt löschen, wüsste sie nicht mehr, wohin. Es wurde nichts gelöscht — bitte versuche es erneut, sobald die Rückerstattung durch ist.",
  accountActionExpired: "Diese Bestätigung ist abgelaufen. Öffne die Aktion erneut.",
  statusActionUnavailable: "Diese Aktion ist für den aktuellen Accountstatus nicht verfügbar.",
  deleteFreezeIntro:
    "Warte — bevor du alles löschst 👀\n\nDu musst nicht alles verlieren. *Friere* deinen Account lieber ein: Profil, Fotos und Verifizierung bleiben erhalten, du verschwindest aus dem Matching, und beim nächsten Mal sendest du einfach /start und landest direkt in deinem fertigen Profil — ohne neue Registrierung.\n\nTrotzdem löschen? Das ist endgültig.",
  deleteFreezeBtn: "❄️ Account einfrieren",
  deleteProceedBtn: "Account trotzdem löschen",
  freezeConfirmed:
    "Erledigt — dein Account ist *eingefroren* ❄️\n\n" +
    "Du bist im Matching nicht sichtbar und bekommst keine Nachrichten. " +
    "Komm jederzeit mit /start zurück — alles ist noch da.",
  freezeWelcomeBack: "*Willkommen zurück!* Dein Account ist wieder aktiv.",
  deleteFinalYes: "Ja, löschen",
  deleteFinalNoSoft: "Nein, behalten",
  deleteFinalNoHard: "Nein, behalten",
  freezePartnerNotice:
    "Kurze Info — dein Match ist nicht mehr verfügbar, dieses Date findet also nicht statt. " +
    "Kein Stress: Beim nächsten Durchlauf hast du Priorität 💛",
  matchHeadline: "💘 Wir haben ein Match für dich!",
  matchDeadlineNotice: "Du hast 24 Stunden für deine Antwort. Ändern kannst du sie danach nicht.",
  matchStreamStart: "Warum ihr zusammenpasst…",
  matchBtnAccept: "Annehmen",
  matchBtnDecline: "❌ Passen",
  matchDeclineConfirmPrompt:
    "Wirklich passen?\n\nDas ist endgültig — diese Person wird dir nicht noch einmal vorgeschlagen.",
  matchBtnConfirmDecline: "❌ Ja, passen",
  matchBtnKeepDeciding: "← Zurück",
  matchDecisionQuestionM:
    "Willst du mit ihm auf ein Date gehen? Antworte einfach ja oder nein.",
  matchDecisionQuestionF:
    "Willst du mit ihr auf ein Date gehen? Antworte einfach ja oder nein.",
  matchTextYesConfirm: "Stark ✨ Bestätige unten — den Rest übernehme ich:",
  matchBtnConfirmGo: "💫 Ja, ich gehe hin",
  matchTextUnsure:
    "Kein Stress — sag mir einfach „ja“ oder „nein“, wenn du so weit bist.",
  matchDeclineDismissed:
    "Kein Stress — dieses Match wartet noch auf deine Antwort. 💛",
  matchAcceptedToast: "Angenommen",
  matchDecisionSavedToast: "Gespeichert",
  matchAccepted: "Angenommen ✨ Warten auf die andere Person.",
  matchBothAccepted: "Beidseitig 🤍 Lass uns eine Zeit finden.",
  matchDeclined:
    "Verstanden. Was hat nicht gepasst? Wähl eine Option oder sag es mit eigenen Worten — ich berücksichtige es beim nächsten Mal.",
  matchDeclineReasonType: "Optisch nicht mein Typ",
  matchDeclineReasonVibe: "Anderer Vibe",
  matchDeclineReasonInterests: "Interessen passen nicht",
  matchDeclineReasonLifestyle: "Lifestyle passt nicht",
  matchDeclineReasonOther: "Etwas anderes",
  matchDeclineOtherAsk:
    "Klar — schick einen kurzen Text oder eine Sprachnachricht mit dem Grund. Ich berücksichtige es in der nächsten Runde.",
  matchDeclineFeedbackSaved: "Verstanden. Die nächsten Vorschläge stelle ich darauf ein.",
  matchDeclineAlreadyNoted: "Schon notiert — danke.",
  matchDeclineFeedbackFailed: "Konnte das gerade nicht speichern. Du kannst trotzdem einen kurzen Text oder eine Sprachnachricht senden.",
  matchDeclineThanks: "Notiert. Ich suche weiter.",
  matchPeerDecided:
    "*Dein Match hat schon geantwortet*\n\nWas genau — erfährst du nach deiner Antwort.",
  matchPeerWasAccepted: "Zur Info - dein Match war dabei. Es hat diesmal nur nicht gepasst.",
  matchPeerWasDeclined: "Zur Info - dein Match hat diesmal gepasst.",
  matchAcceptedPeerDeclined:
    "Diesmal war es ein Nein von der anderen Seite. Passiert — hier gibt es ein Date nur, wenn es beidseitig ist. " +
    "Ich suche weiter; der nächste Vorschlag sitzt näher.",
  matchAcceptedPeerDeclinedPriority:
    "Diesmal war es ein Nein von der anderen Seite. Passiert — hier gibt es ein Date nur, wenn es beidseitig ist.\n\nDeine Priorität für die nächste Runde ist erhöht. Der nächste Vorschlag sitzt näher.",
  matchPhotoCaption: "{name}, {age}",
  matchVerifiedLabel: "Verifiziert",
  matchVerifiedQuote: "Verifiziert: Auf den Fotos ist wirklich diese Person.",
  matchSynergyLabel: "Kompatibilität {score}/99",
  matchSynergyHeader: "💎 {label} — {reason}",
  pitchCountdownHours: "⏳ Noch {hours}h zum Antworten",
  pitchCountdownMinutes: "⏳ Noch {minutes} Min zum Antworten",
  pitchDeadlineBtnHm: "⏳ Zeit zum Antworten: {h}h {m}m",
  pitchDeadlineBtnMin: "⏳ Zeit zum Antworten: {m}m",
  pitchCountdownTapToast: "Sag einfach ja oder nein, wenn du so weit bist — das Fenster ist noch offen ✨",
  pitchDeadlineNudge:
    "Kurzer Hinweis — dein Fenster, um auf dieses Match zu antworten, schließt in etwa {hours}h. Wenn du hingehen möchtest, sag jetzt einfach ja; kein Problem, wenn nicht.",
  stallPartnerFallbackName: "dein Match",
  stallActionExpired: "Das hat sich schon erledigt — hier gibt es nichts mehr zu beantworten.",
  matchCardExpiredAlert: "Diese Match-Karte ist nicht mehr aktiv — hier gibt es nichts mehr zu entscheiden.",
  emergencyStaleAction: "Dieses Date ist nicht mehr aktiv. Prüfe den aktuellen Status, bevor du es erneut versuchst.",
  calendarStaleAction: "Dieser Kalender ist geschlossen. Öffne die aktuelle Match-Karte, um die Änderung zu sehen.",
  stallVenueNudge:
    "Es fehlt nur noch, wo du losfährst — dann finde ich einen Ort, der für euch beide passt.",
  stallCheckInScheduling:
    "{name} wartet — ihr seid bei der Zeitwahl stehen geblieben.\nAlles noch aktuell?",
  stallCheckInVenue:
    "{name} wartet — ihr seid bei der Ortswahl stehen geblieben.\nAlles noch aktuell?",
  stallBtnStillOn: "🟢 Ja, alles bleibt",
  stallBtnPlansChanged: "Pläne haben sich geändert",
  stallPeerAsked:
    "Habe {name} an euch erinnert — warte auf Antwort.\n\nVon dir braucht es erstmal nichts.",
  stallStillOnAck: "Alles klar, bleibt so ✨",
  stallPeerStillOn: "{name} ist da, alles bleibt ✨",
  stallCancelConfirmPrompt:
    "Das Date mit {name} absagen?\n\nDas ist endgültig — dieses Paar schlage ich nicht wieder vor.",
  stallBtnCancelConfirm: "🔴 Ja, absagen",
  stallBtnCancelBack: "🟢 ← Zurück",
  stallCancelAborted: "Gut — bleibt so. 👍",
  stallCancelDone:
    "Verstanden. {name} habe ich informiert — ohne Details.\n\nDu bist wieder in der Suche.",
  stallPeerCancelled:
    "Date abgesagt — bei {name} haben sich die Pläne geändert.\n\nDas liegt nicht an dir. Ich habe deine Priorität für die nächste Runde erhöht.",
  stallTimeoutPartnerGone:
    "Date abgesagt — von {name} kam keine Antwort.\n\nSchade, aber besser jetzt als am Tag selbst. Ich habe deine Priorität für die nächste Runde erhöht.",
  stallTimeoutSelf:
    "Dein Date mit {name} ist abgesagt — zwei Tage keine Antwort, " +
    "und ich konnte euch beide nicht länger hängen lassen.\n\n" +
    "Wenn sich Pläne ändern, sag es mir einfach. Das ist völlig okay.",
  stallTimeoutVenueUnresolved:
    "Dein Date mit {name} ist abgesagt — ich habe nicht rechtzeitig einen Ort für euch beide gefunden.\n\nDas liegt an mir, nicht an euch. Ich habe deine Priorität in der nächsten Runde erhöht.",
  pitchExpired: "⏳ Zeit abgelaufen - dieser Vorschlag ist verfallen.",
  matchExpiredSilentWarning:
    "*Die Zeit zum Antworten ist um*\n\nAntworte nächstes Mal wenigstens mit „Nein“ — jemand wartet.",
  matchExpiredSilentPenalty:
    "*Die Zeit zum Antworten ist um*\n\nEs ist schon das zweite Mal, deshalb wurde dein Rating gesenkt. Antworte nächstes Mal wenigstens mit „Nein“ — jemand wartet.",
  matchExpiredYouMissedDate:
    "Wichtig — dein Match war tatsächlich dabei. Das hätte ein echtes Date werden können.\n\n",
  matchExpiredPeerIgnored:
    "Dein Match hat innerhalb von 24h nicht geantwortet, also findet das Date nicht statt. Wir sehen uns in der nächsten Runde.",
  // §3.4 — this side PASSED, and the partner then went silent. A first
  // decision leaves the row `proposed` either way, so a decliner reaches
  // expiry classified as a `responder` exactly like someone who accepted
  // and got stood up. They already got their "you passed" ack, so this is
  // deliberately a bare fact with no consolation and no card: it exists
  // only so the match doesn't vanish from the menu and banner unexplained.
  matchExpiredSelfDeclined: "Dieses Match ist geschlossen. Wir sehen uns in der nächsten Runde.",
  // Ablauf-Karte (PRODUCT_SPEC §3.4) — Überschriften bewusst geschlechtsneutral.
  expiryCardOverlineExpired: "FENSTER GESCHLOSSEN",
  expiryCardHeadlineExpired: "ZEIT\nABGELAUFEN",
  expiryCardSublineExpired: "24 Stunden ohne Antwort.\nWir sehen uns in der nächsten Runde.",
  expiryCardOverlinePenalty: "ZWEITES MAL OHNE ANTWORT",
  expiryCardHeadlinePenalty: "RATING\nGESENKT",
  expiryCardSublinePenalty: "Zweites Match ohne Antwort.\nWir sehen uns in der nächsten Runde.",
  expiryCardOverlinePeerIgnored: "NICHT DEINE SCHULD",
  expiryCardHeadlinePeerIgnored: "KEINE\nANTWORT",
  expiryCardSublinePeerIgnored:
    "Das Date findet nicht statt.\nDein Teil war rechtzeitig erledigt.",
  expiryCardOverlineMissedDate: "DU HATTEST EIN JA",
  expiryCardHeadlineMissedDate: "ES WAR\nGEGENSEITIG",
  expiryCardSublineMissedDate:
    "Dein Match wollte sich treffen.\n24 Stunden ohne Antwort.",
  expiryCaptionSilentWarning: "Antworte nächstes Mal wenigstens mit „Nein“ — jemand wartet.",
  expiryCaptionSilentPenalty:
    "Es ist schon das zweite Mal, deshalb wurde dein Rating gesenkt. Antworte nächstes Mal wenigstens mit „Nein“ — jemand wartet.",
  expiryCaptionPeerIgnored: "Wir sehen uns in der nächsten Runde.",
  noMatchThisWeekTier1:
    "*Diese Woche kein Match*\n\nIch habe niemanden gefunden, der wirklich passt, und ich schlage nicht einfach irgendwen vor. In der nächsten Runde hast du Priorität ✨",
  noMatchThisWeekTier2:
    "*Wieder kein Match*\n\nDie zweite Woche in Folge sehe ich niemanden, der wirklich passt. Danke fürs Warten — in der nächsten Runde ist deine Priorität noch höher 🤍",
  noMatchThisWeekTier3:
    "*Noch kein Match*\n\nEs gibt immer noch niemanden, der wirklich passt, und ich schlage nicht einfach irgendwen vor. Ich behalte deine Warteschlange im Blick — in der nächsten Runde bist du unter den Ersten 🤍",
  noMatchDiscountOffer:
    "🎟️ Ein kleines Dankeschön für deine Geduld: dein nächstes erstes Date gibt es mit {pct}% Rabatt auf ein Ticket. " +
    "Wir ziehen den Rabatt automatisch ab, sobald du ein Match bekommst oder deine Tickets öffnest.",
  poolExhaustedPauseNotice:
    "*Ich pausiere deine Suche*\n\nGerade gibt es wirklich niemanden für dich — das liegt nicht an dir. Sobald jemand Passendes auftaucht, hole ich dich selbst zurück in die Suche.",
  poolExhaustedResumeNotice:
    "Gute Nachrichten — jemand Passendes ist aufgetaucht, also habe ich dich zurück in die Suche geholt. Du bist in der nächsten Runde dabei 🤍",
  matchScheduleProposal: "Wie wäre es mit einer dieser Zeiten? Tipp an, was passt:",
  matchScheduleIter3:
    "Beidseitig 🤍 Öffne den Kalender und markiere passende Zeiten.",
  matchScheduleAfterTicket:
    "📅 Jetzt eure Zeit — öffne den Kalender und markiere alle passenden Slots.",
  matchScheduleBtnCalendar: "📅 Kalender öffnen",
  ticketCardCaption: "Es ist ein Match 🤍 Hol dir dein Ticket, dann wählen wir eine Zeit.",
  ticketCardCaptionPremium:
    "Es ist ein Match 🤍 Premium deckt beide Tickets ab — wir wählen direkt eine Zeit.",
  ticketButton: "🎟️ Date-Ticket holen",
  ticketViewButton: "🎟️ Dein Date-Ticket ansehen",
  ticketStatusButton: "Date öffnen",
  ticketGateWaiting: "Ticket bereit ✨ Warten auf die andere Person.",
  ticketPeerTookTheirs:
    "{name} hat gerade das eigene Date-Ticket geholt 🎟️ Deins ist das letzte — dann öffnen wir die Planung.",
  bumpVerifiedDm:
    "Ihr seid beide da ✨ Das Date ist gezählt — das nächste Ticket geht auf mich.",
  bumpDeckIntro: "Falls das Gespräch einen Anstoß braucht:",
  matchScheduleNoOverlap: "Noch keine Überschneidung - nächste Runde.",
  matchScheduled: "Fixiert — bis dann 🤝\n\n{venue}",
  matchScheduledNoReservation:
    "🍵 Zur Stoßzeit kann's voll sein - kein Stress: einfach einen Kaffee to go holen und eine Runde drehen, oder in einen anderen netten Laden nebenan schauen.",
  matchScheduledBtnOpenMaps: "📍 In Maps öffnen",
  matchScheduledBtnShare: "📤 Karte teilen",
  dateCardWhen: "WANN",
  dateCardSlogan: "Kein Chatten\nDirekt im echten Leben",
  dateCardShareCaption:
    "Teile sie ruhig — das Gesicht deines Matches ist zum Schutz seiner Privatsphäre verdeckt 💞",
  dateCardShareFailed:
    "Konnte gerade keine teilbare Karte erstellen — versuch es gleich noch einmal.",
  matchSchedulePickedPrefix: "Du hast gewählt: ",
  matchScheduleWaitingPeer: "Warten auf die andere Person...",
  matchSchedulePeerProposed:
    "Dein Match hat schon Zeiten im Kalender markiert. Öffne ihn — bestätige eine oder schlag eine eigene vor:",
  matchSchedulePeerSuggestedAlternative:
    "Dein Match hat eine andere Zeit vorgeschlagen. Schau rein — zustimmen oder selbst etwas vorschlagen.",
  matchScheduleSavedConfirmation:
    "Erledigt. Dein Match hat eine Benachrichtigung bekommen — ich melde mich, sobald eine Antwort da ist.",
  matchScheduleNoOverlapYet:
    "Ihr habt beide Zeiten markiert, aber noch passt nichts zusammen. Füg ein paar Optionen hinzu — sobald ein Slot passt, ist es fix:",
  matchSchedulePickFinalYet:
    "Eure Kalender passen schon zusammen — öffne ihn und bestätige die Zeit, die am besten passt, dann steht der Termin:",
  venueTimeCardLabel: "EUER DATE",
  venueTimeLockedCaption: "Euer Termin steht ✨",
  venueConciergeIntro:
    "*Von wo fährst du zum Date los?*\n\nSetz einen Punkt auf der Karte — Zuhause, eine Metro-Station, irgendein passender Ort. Ich finde einen Ort, den ihr beide gut erreicht.",
  venueConciergeBtnLocation: "📍 Standort senden",
  venueConciergeBtnMap: "🗺️ Auf Karte wählen",
  venueLocationFirst:
    "Zuerst das Wichtigste - *markiere, von wo du losfährst* 📍 Tippe unten, um den Punkt auf der Karte zu setzen.",
  venueOriginOutsideMarket:
    "Dieser Punkt liegt außerhalb von {city}, und Gennety ist vorerst nur dort aktiv - ich suche einen Ort in kurzer Entfernung für euch beide, von dort finde ich also keinen. Markiere den Punkt in {city}, von dem du losfährst:",
  venueVibeNoted: "Vibe notiert ✨ Jetzt wähle, von wo du kommst:",
  venueLocationNoted:
    "Startpunkt gespeichert ✨ Jetzt - welchen *Vibe* willst du? z. B. _ruhiges Cafe_, _veganer Brunch_, _Parkspaziergang_, _kleines Museum_.",
  venueSafetyOverride: "Kurzer Hinweis - ich habe stattdessen ein öffentliches Café gewählt. Erste Dates bleiben bei uns öffentlich.",
  venueWaitingPeer: "Deins ist da ✨ Wir warten auf sie...",
  venueLocationUseMap:
    "Standorte aus dem Chat kommen nicht mehr bei der Ortssuche an — markiere deinen Startpunkt unten auf der Karte 📍",
  venueTimeLapsedBackToCalendar:
    "Bis zu eurem Date bleibt zu wenig Zeit, um noch einen Treffpunkt zu finden — lass uns eine neue Zeit wählen.",
  venueSelectionFailedRetry:
    "Ich konnte gerade keinen Treffpunkt für euer Date finden — die Ortssuche ist bei uns ausgefallen. Öffne den Ortsbildschirm und bestätige deinen Startpunkt noch einmal, um es erneut zu versuchen.",
  peerWaitT1Sent: "An {name} weitergeleitet, warten auf Antwort",
  peerWaitT2Waiting: "{name} überlegt noch",
  peerWaitT3Quiet: "Von {name} noch nichts, wir warten",
  peerWaitT4Nudged: "{name} erinnert, wir warten auf Antwort",
  peerWaitT5Deadline: "Noch keine Antwort von {name}",
  peerWaitAnon: "Warten auf die andere Seite",
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
  onbAnalyzeStep1b: "💭 Denke nach…",
  verifyAnalyzeStep1: "🔍 Gleiche dein Selfie ab…",
  verifyAnalyzeStep2: "🧬 Lese Gesichtszüge…",
  verifyAnalyzeStep3: "⏳ Schließe die Prüfung ab…",
  voiceCheckStep1: "🎧 Ich höre deine Aufnahme…",
  voiceCheckStep2: "Prüfe, ob alles passt…",
  videoCheckStep1: "🎬 Ich sehe dein Video durch…",
  videoCheckStep2: "🙂 Prüfe, ob du das bist…",
  videoCheckStep3: "✨ Fast fertig…",
  skipAnalyzeStep1: "✨ Verfeinere dein Profil…",
  skipAnalyzeStep2: "🧮 Füge alles zusammen…",
  skipAnalyzeStep3: "💞 Bereite dich aufs Matching vor…",
  profilerBatchThinking: "Denke nach…",
  profilerBatchSaving: "Speichere deine Antworten…",
  profilerBatchSaved:
    "Präferenzkarte aktualisiert ✨ Ich nutze sie beim nächsten Match.",
  profilerNextAck: "Notiert…",
  profilerNextFormulating: "Denke nach…",
  profilerRefusalAck: "Okay, ich hake nicht nach. Frage ein andermal 💛",
  profilerImageUnreadable: "Hm, das konnte ich nicht erkennen 😅 Erzählst du es mir in Worten?",
  profilerLinkUnreadable: "Das kann ich nicht öffnen — wohl privat oder gelöscht 😅 Erzähl es mir in Worten oder schick ein Bild?",

  // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
  venueChangeButton: "🔄 Ort ändern",
  venueBoardPingFromF: "{name} schaut sich nach einem gemütlicheren Ort für euer Date um 👀",
  venueBoardPingFromM: "{name} schlägt vor, ein paar andere Orte für euer Date anzusehen 👀",
  venueBoardPingBtn: "Ansehen",
  venueKeepNotice: "Dein Match möchte lieber bei {venue} bleiben. Du kannst unten trotzdem einen anderen Ort vorschlagen.",
  venueBothKeepDm: "Ihr bleibt beide bei {venue} — nichts ändert sich, bis dann.",
  venueDeclinedKeepDm: "Ihr bleibt bei {venue}, wie geplant.",
  venueChangeRefunded:
    "Der Ortswechsel hat nicht geklappt, deine Sterne sind zurück. Das Date bleibt wie geplant — am bisherigen Ort.",
  primeInvoiceTitle: "Späte Abende",
  primeInvoiceDesc:
    "Öffnet 18:30, 19:00 und 19:30 an allen Tagen eures Kalenders — für euch beide, für dieses Date.",
  primeInvoiceLabel: "Späte Abende",
  primeTimeOpenedDm:
    "{name} schaltet späte Abende frei — 18:30 und später stehen jetzt in eurem Kalender.",
  primeTimeRefunded:
    "Die späten Abende wurden nicht freigeschaltet, deine Stars sind zurück. Der restliche Kalender bleibt gleich.",
  primeTimeRefundedDateOff:
    "Das Date findet nicht statt, deshalb sind die Stars für die späten Abende zurück bei dir.",
  memeCardTeaser:
    "🎭 Noch etwas über {name}.\n\nAuf die Frage, worüber sie wirklich lachen, kam keine Antwort in Worten — sondern ein Meme. Das sagt mehr über einen Menschen als drei Sätze.\n\nMöchtest du es vor dem Treffen sehen?",
  memeCardBtn: "🎭 Zeig es mir",
  memeRevealCaption: "🎭 Worüber {name} lacht:",
  memeRevealSource: "▶️ Ganz ansehen:",
  memeRevealFallback:
    "🎭 Das Bild selbst konnte ich nicht weiterschicken, also in Worten — das hat {name} auf die Frage geschickt, worüber sie lachen:\n\n_{description}_",
  memeRevealGone: "Diese Frage wurde noch einmal in Worten beantwortet — hier gibt es kein Meme mehr.",
  memeRevealUnavailable: "Diese Karte ist nicht mehr aktiv.",
  venuePayPromptDm: "Ihr habt zusammen einen neuen Ort für euer Date gewählt.\n\n📍 {venue}",
  venuePayOpenBtn: "📍 Ansehen und entscheiden",
  venueWishText:
    "{name} hat einen Ort gefunden, der ihr sehr gefällt.\n\n" +
    "Sie würde sich freuen, wenn du ihn sicherst.",
  venueWishTextFallback:
    "{name} hat einen Ort gefunden, der ihr sehr gefällt.\n\n📍 {venue}\n\n" +
    "Sie würde sich freuen, wenn du ihn sicherst.",
  venueWishPayBtn: "Sichern — {stars} ⭐",
  venueWishDeclineBtn: "Nicht diesmal",
  venuePayDeclineAck:
    "Verstanden — der Ort bleibt vorerst wie geplant. Falls er sich ändert, bekommst du eine neue Karte.",
  venuePayDeclineStale:
    "Diese Karte ist nicht mehr aktuell — die Pläne zum Ort haben sich seitdem geändert. Tippe unten, um den aktuellen Stand zu sehen.",
  venuePaySelfDm:
    "Ihr habt euch auf einen neuen Ort geeinigt.\n📍 {venue}\nSichere ihn — ich aktualisiere eure Karten.",
  venuePaySelfBtn: "⭐ Sichern — {stars}",
  venueSettledCard: "Erledigt — euer Date hat ein neues Zuhause 📍 {venue}",
  venueSettledPaidByM: "{name} hat die Ortsänderung übernommen ❤️ Euer Date findet jetzt statt in {venue}",
  venueSettledPaidByF: "{name} hat die Ortsänderung übernommen ❤️ Euer Date findet jetzt statt in {venue}",
  venueExpressPartnerFromF: "{name} hat einen gemütlicheren Ort für euer Date gewählt. Neuer Ort: 📍 {venue}",
  venueExpressPartnerFromM: "{name} hat einen neuen Ort für euer Date gewählt. Neuer Ort: 📍 {venue}",
  venueLapsedDm: "Die Ortsänderung wurde nicht gesichert — ihr trefft euch wie geplant in {venue}.",
  venueKeepOriginalDm: "Dein Match möchte nichts ändern — ihr trefft euch wie geplant in {venue}.",
  venueInvoiceTitle: "Ortsänderung",
  venueInvoiceDesc: "Neuer Date-Ort: {venue}",
  venueInvoiceLabel: "Ortsänderung",
  icebreakerIntro: "Dein Date ist in 5 Stunden! Ein paar Gesprächsstarter für dich:\n\n",
  icebreakerStreamStart: "✨ Ich stelle ein paar Gesprächsthemen für euch zusammen…",
  noMatchStreamStart: "💫 Ich gehe die Kandidaten für dich durch…",
  wingmanHintIntro: "👋 Insider-Tipp - dein Date ist in 90 Minuten:\n\n",
  dateTerminalInvite:
    "*Dein Date ist in {minutes} Min.*\n📍 {venue}\n\nÖffne den Date-Bildschirm — er zeigt dir den Weg. Am Tisch haltet ihr eure Handys mit den Oberkanten aneinander, um Kontakte auszutauschen.",
  dateTerminalReminder:
    "*Kontaktaustausch ist offen*\n📍 {venue}\n\nWenn ihr beide am Tisch sitzt, öffne den Date-Bildschirm und haltet eure Handys mit den Oberkanten aneinander.",
  dateTerminalBtn: "🎟 Date öffnen",
  dateDayActivityStartTitle: "Heute ist dein Date",
  emergencyPushTitle: "Dein Date ist abgesagt",
  emergencyPushBody: "Öffne Gennety — dort steht der Grund.",
  dateDayActivityStartBody: "Alles Wichtige liegt auf deinem Sperrbildschirm.",
  venueActivityStartTitle: "Ortswechsel",
  venueActivityStartPartner: "{name} schlägt {what} vor",
  venueActivityStartPartnerKeep: "{name} möchte {venue} behalten",
  venueActivityStartWaiting: "Wir warten auf eine Antwort zum Ort",
  venueActivityStartMatch: "Ihr habt beide {venue} gewählt",
  venueActivityPartnerFallback: "Dein Match",
  // The time-agreement lock-screen card (iOS `time_agreement` Live Activity,
  // decision 2026-09-23): the alert a push-to-start carries, and the one an
  // update carries when the PARTNER moved. `{when}` is a weekday + HH:mm in the
  // RECIPIENT's timezone (the weekday is dropped when the slot is today); the
  // partner name is only ever the SUBJECT — the server declines no names, which
  // is also why waiting has a nameless twin rather than reusing
  // `venueActivityPartnerFallback` ("Ждём, когда Твой мэтч ответит" would
  // capitalise mid-sentence).
  timeActivityStartTitle: "Zeit wählen",
  timeActivityStartPartner: "{name} schlägt {when} vor",
  timeActivityStartWaiting: "Wir warten auf eine Antwort von {name}",
  timeActivityStartWaitingNoName: "Wir warten auf eine Antwort zur Zeit",
  timeActivityStartMatch: "Termin steht: {when}",
  profilerSkip: "Überspringen",
  emergencyUnlocked: "Pläne geändert und du kannst wirklich nicht? Du kannst unten absagen.",
  emergencyBtn: "Date absagen",
  emergencyConfirmPrompt:
    "Wenn es nur Nervosität oder eine Verspätung ist, behalte lieber das Date. *Sag nur ab, wenn du wirklich nicht kommen kannst:* Das Match lässt sich nicht zurückholen.",
  emergencyBtnConfirm: "🔴 Ja, Date absagen",
  emergencyBtnBack: "🟢 Date behalten",
  emergencyAborted: "Okay — dein Date bleibt bestehen. 👍",
  emergencyAskReason: "Schreib deinen Grund. Das geht *wortwörtlich* an dein Match.",
  emergencyConfirmed: "Date abgesagt. Deine Nachricht wurde weitergeleitet.",
  emergencyDateStarted:
    "Die Uhrzeit deines Dates ist schon erreicht, daher kann es nicht mehr abgesagt werden. " +
    "Falls es nicht stattgefunden hat, frage ich dich am nächsten Tag danach.",
  emergencyReceivedOther: "Dein Match hat das Date abgesagt. Das wurde geschrieben:\n\n\"{reason}\"",
  emergencyReceivedOtherIntro: "Dein Match hat das Date abgesagt. Das wurde geschrieben:",
  emergencyReceivedOtherSoftNote:
    "Das liegt nicht an dir. Gennety erhöht deine Priorität für die nächste Runde ein wenig.",
  feedbackInvitation:
    "*Wie lief dein Date?* ✨\n\nTeil ein paar Details: gab es Chemie, wie war der Vibe, hat dir der Ort gefallen?",
  feedbackBtnForm: "✍️ Feedback-Formular öffnen",
  feedbackBtnVoice: "🎤 Stattdessen Sprachnachricht senden",
  attendanceAsk: "Bevor ich frage, wie es war — habt ihr euch gestern tatsächlich getroffen? 🙂",
  attendanceAskLikelyMet:
    "Klingt, als hätte es gestern geklappt 🙂 Nur zur Sicherheit: Habt ihr euch getroffen?",
  attendanceAskLikelyNotMet:
    "Sieht aus, als hätte es gestern nicht geklappt. Richtig verstanden — ihr habt euch nicht getroffen?",
  attendanceBtnYes: "Ja, wir haben uns getroffen",
  attendanceBtnNo: "Nein, es kam nicht dazu",
  attendanceNoIntro: "Schade, dass es nicht geklappt hat. Was ist passiert?",
  attendanceOutcomePartner: "Die andere Person kam nicht",
  attendanceOutcomeSelf: "Es lag an mir",
  attendanceOutcomeBoth: "Wir haben verschoben",
  attendanceOutcomeOther: "Etwas anderes",
  attendanceNoThanks: "Danke für die Antwort — notiert. Schade, dass es so lief.",
  attendanceAlreadyAnswered: "Schon notiert, danke ✨",
  attendancePushTitle: "Habt ihr euch getroffen?",
  attendancePushBody: "Ein Tippen, und ich weiß, ob ich nach dem Date fragen soll.",
  feedbackVoiceAsk:
    "Nimm einfach eine Sprachnachricht auf 🎙️\n\n" +
    "Erzähl, wie das Date lief - gab es Chemie? Was mochtest du? " +
    "Was hat nicht funktioniert? Eine Minute reicht.",
  feedbackThanks: "Danke! Ich berücksichtige es in der nächsten Runde ✨",
  feedbackAlreadySubmitted: "Du hast uns schon erzählt, wie dieses Date war — danke, es ist gespeichert ✨",
  feedbackPushTitle: "Wie war dein Date?",
  feedbackPushBody: "Eine Minute von dir, und das nächste Match passt besser.",
  matchDropPushTitle: "Dein Match ist da",
  matchDropPushBody: "Tippe zum Ansehen ✨",
  reportBtn: "🚨 Melden",
  reportAsk: "Diese Meldung ist privat. Was beschreibt das Problem am besten?",
  reportCategoryFakePhotos: "Fake- oder irreführende Fotos",
  reportCategoryWrongPerson: "Falsche Person auf dem Foto",
  reportCategoryOffensive: "Unhöflichkeit oder seltsames Verhalten",
  reportCategoryUnsafe: "Ich habe mich unsicher gefühlt",
  reportCategorySpam: "Spam oder Betrug",
  reportCategoryInappropriate: "Unangemessenes Profil",
  reportCategoryOther: "Anderes",
  reportDetailAsk: "Noch etwas, das die Prüfung beschleunigt? Du kannst tippen, eine Sprachnachricht senden oder überspringen.",
  reportDetailAskOther: "Beschreib bitte kurz, was passiert ist. Du kannst tippen oder eine Sprachnachricht senden.",
  reportSkipBtn: "Überspringen",
  reportThanksT1: "Verstanden - wir nutzen das, um deine zukünftigen Matches zu verbessern 🎯",
  reportThanksT2: "Gemeldet. Danke - wir kümmern uns darum.",
  reportThanksT3:
    "Meldung erhalten. Der Account dieser Person ist bis zur Prüfung eingefroren. Danke für den Hinweis.",
  reportFailed: "Konnte die Meldung gerade nicht verarbeiten. Versuch es in einer Minute nochmal.",
  reportDuplicate: "Du hast dieses Match bereits gemeldet.",
  reportBackBtn: "← Zurück",
  reportCancelled: "Alles klar — keine Meldung gesendet.",
  reportWarningStrike1:
    "⚠️ Achtung: Wir haben eine Meldung zu deinem Verhalten bei einem aktuellen Match erhalten. " +
    "Gennety erwartet respektvolles und verlässliches Verhalten. Eine weitere bestätigte Meldung sperrt deinen Account vorübergehend.",
  reportSuspendedDM:
    "🚫 Dein Account wurde wegen wiederholter Meldungen für 14 Tage gesperrt. " +
    "In dieser Zeit erhältst du keine Matches. Danach wird er automatisch reaktiviert.",
  reportBannedDM: "⛔ Dein Account wurde wegen mehrerer bestätigter Meldungen dauerhaft gesperrt.",
  reportPendingInvestigationDM:
    "🚫 Dein Account wurde für eine Sicherheitsprüfung eingefroren. " +
    "Unser Team meldet sich über @gennetysupport, falls weitere Schritte nötig sind.",
  safetyNoteFemale:
    "*Dein Date ist in 90 Minuten — {location_name}*\n\n📍 *Bleib beim Plan.* Wir haben einen sicheren öffentlichen Ort für euch gewählt. Stimm keinem Wechsel an einen privaten Ort zu und geh nicht mit zu jemandem nach Hause.\n🚗 *Transport.* Komm selbst hin und zurück — mit ÖPNV, Taxi oder zu Fuß. Steig nicht bei jemandem ins Auto, den du kaum kennst.\n📱 *Sag jemandem Bescheid.* Schick die Treffdetails an eine Freundin oder Familie und teile, wenn möglich, deinen Standort für den Abend.\n🛑 *Deine Grenzen.* Wenn du dich unwohl fühlst oder das Verhalten komisch wirkt, kannst du jederzeit einfach aufstehen und gehen. Deine Sicherheit ist wichtiger als Höflichkeit.\n\nHab einen schönen Abend ✨",
  safetyBriefPushTitle: "Bevor du losgehst",
  safetyBriefPushBody: "Deine Sicherheits-Checkliste für heute Abend liegt in der App.",
  noMatchPushTitle: "Diesmal kein Match",
  noMatchPushBody: "Noch niemand Passendes gefunden. Die Suche läuft weiter.",
  matchNudgePushTitle: "Dein Match wartet noch",
  matchNudgePushBody: "Ja oder nein — beides ist okay. Das Fenster ist noch offen.",
  planningNudgePushTitle: "Deinem Date fehlt noch die Zeit",
  planningNudgePushBody: "Schau in den Kalender, wenn du kurz Zeit hast.",
  deadlineNudgePushTitle: "Das Fenster schließt sich",
  deadlineNudgePushBody: "Noch etwa {hours} Std. Zeit zu antworten. Ja oder nein — beides ist okay.",
  statusDaysHours: "⏳ Nächstes Match in {d}T {h}Std",
  statusHoursMinutes: "⏳ Matches kommen in {h}Std {m}Min",
  statusMinutes: "✨ Fast bereit! Matches kommen in {m} Min",
  statusProcessing: "✨ Analysiere deine Stadt... Schau später nochmal rein.",
  statusBannerSchedule: "Nächste Runde: {date}, {time}",
  statusBannerActive: "Wir suchen bereits nach deinem Menschen ✦",
  statusBannerSearching:
    "Ich suche deinen Menschen — ich schaue jeden Abend nach.\n" +
    "Sobald jemand da ist, der deine Zeit wirklich wert ist, melde ich mich.",
  statusButtonDaysHours: "Nächste Runde in {d}T {h}Std",
  statusButtonHoursMinutes: "Nächste Runde in {h}Std {m}Min",
  statusButtonMinutes: "✨ Nächste Runde in {m}Min",
  statusButtonProcessing: "✨ Matching läuft",

  // --- Stage-aware banner (PRODUCT_SPEC §2.1) ---
  statusBannerDecision:
    "Zeit zum Antworten:\n\n" +
    "Dein Match wartet. Antworte hier im Chat mit ja oder nein.",
  statusBannerPlanning:
    "Dein Date wird geplant ✦\n\n" +
    "Die Details werden noch geklärt — alles dazu findest du unter Mein Date.",
  statusBannerDate: "Bis zu deinem Date:",
  statusTimeDaysHours: "{d}T {h}Std",
  statusTimeHoursMinutes: "{h}Std {m}Min",
  statusTimeMinutes: "{m}Min",
  statusButtonDateOpen: "Details",

  // --- Kyiv-only market gate (PRODUCT_SPEC §1.1) ---
  statusBannerMarketPending:
    "Gennety ist vorerst nur in Kyjiw am Start — in {city} sind wir noch nicht gestartet, " +
    "hier gibt es also niemanden, mit dem wir dich matchen könnten.\n\n" +
    "Bereit für Dates in Kyjiw? Wechsle deine Stadt im Menü.",
  statusButtonMenu: "Menü öffnen",
  menuCitySwitch: "📍 Stadt auf Kyjiw wechseln",
  citySwitchCard:
    "📍 *Deine Stadt: {city}*\n\nGennety ist vorerst nur in Kyjiw am Start. Matches finden immer innerhalb einer Stadt statt — bis wir in {city} starten, gibt es hier niemanden, den wir dir vorstellen könnten.\n\nWenn du in Kyjiw auf Dates gehen möchtest, wechsle einfach: Profil, Fotos und Verifizierung bleiben genau so, und du bist in der nächsten Runde dabei.",
  citySwitchConfirm: "📍 Ja, matcht mich in Kyjiw",
  citySwitchDone:
    "Erledigt — deine Match-Stadt ist jetzt Kyjiw 🤍\n\nDu bist in der nächsten Runde dabei: {date}.",
  citySwitchFailed: "Der Stadtwechsel hat gerade nicht geklappt. Versuch es gleich noch einmal.",
  noMatchCityNotLaunched:
    "*In {city} gibt es Gennety noch nicht*\n\nBisher sind wir nur in Kyjiw, und Matches finden immer innerhalb einer Stadt statt — hier gibt es also noch niemanden, den ich dir vorstellen könnte. Dein Profil bleibt wie es ist, und wir melden uns, sobald wir deine Stadt öffnen.\n\nWenn du in Kyjiw auf Dates gehen möchtest, wechsle unten — dann bist du in der nächsten Runde dabei.",
  noMatchCitySwitchBtn: "📍 Zu Kyjiw wechseln",

  // --- My date (menu row + hub) + scheduled-date banner ---
  statusDateDaysHours: "💫 Date in {d}T {h}Std",
  statusDateHoursMinutes: "💫 Date in {h}Std {m}Min",
  statusDateMinutes: "💫 Date in {m} Min",
  statusDateSoon: "💫 Date ist heute",
  menuMyDateDays: "💫 Mein Date · in {d}T {h}Std",
  menuMyDateHours: "💫 Mein Date · in {h}Std {m}Min",
  menuMyDateMinutes: "💫 Mein Date · in {m} Min",
  menuMyDateSoon: "💫 Mein Date · heute",
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
    "Du hast heute viel geschrieben 🙂 Machen wir morgen weiter — das Tageslimit ist erreicht.",

  // --- Live Photo admission ---
  livePhotoMissingStatic:
    "Diesem Live Photo fehlt das Standbild — so kann ich es nicht prüfen. Schick es als normales Foto oder nimm ein anderes.",
  livePhotoTooLong:
    "Live Photos dürfen höchstens 10 Sekunden lang sein. Schick ein kürzeres oder ein normales Foto.",
  livePhotoTooLarge:
    "Live Photos dürfen höchstens 10 MB groß sein. Schick ein kleineres oder ein normales Foto.",

  // --- Date Ticket DMs ---
  ticketBothSecuredDm: "Beide Tickets sind da 🎟️ Euer Date steht — fehlt nur die Zeit.",
  ticketPartnerPaidDm: "{name} hat dein Ticket schon bezahlt ❤️ Für dich fällt nichts an.",
  ticketCoveredHerConfirm:
    "💛 Erledigt — du hast {name}s Ticket übernommen. Sobald sie es sieht, sag ich dir Bescheid.",
  ticketPartnerSawItDm: "❤️ {name} hat gesehen, dass du ihr Ticket übernommen hast.",
  ticketRefundedDm:
    "Dein Ticket ist zurück in deiner Wallet, und das Date steht. Lass uns eine Zeit wählen 📅",
  ticketRefundedToWallet:
    "🎟️ Dein Date-Ticket liegt wieder in deiner Wallet — für das nächste Date.",
  ticketRefundedToWalletBoth:
    "🎟️ Beide von dir bezahlten Date-Tickets liegen wieder in deiner Wallet — für das nächste Date.",

  // --- Pre-date coordination ---
  coordProxyOpenedEnterPrompt:
    "Dein anonymer Chat ist offen 🕶\n\n" +
    "Nachrichten laufen über mich, Kontakte bleiben privat. Gut, um euch zu finden oder kurz Bescheid zu geben. Schließt ein paar Stunden nach dem Date.",
  coordEnterBtn: "💬 Chat öffnen",
  coordExitBtn: "❌ Chat verlassen",
  coordReportBtn: "🚨 Melden",
  coordChatEntered:
    "Du bist im anonymen Chat 🕶 Schreib einfach, ich leite weiter. Du kannst jederzeit raus.",
  coordChatExited: "Chat verlassen. /menu bringt dich zurück.",
  coordProxyRelayPrefix: "💬 Dein Date: ",
  coordProxyPushTitle: "Dein Date",
  coordProxyTextOnly:
    "Hier gehen nur Textnachrichten durch — Fotos und Sprachnachrichten leite ich nicht weiter.",
  coordProxyClosed:
    "Der anonyme Chat ist zu. Ich hoffe, das Date war gut — morgen melde ich mich ✨",
  coordProxyUnavailable: "Dieser anonyme Chat ist nicht mehr verfügbar.",
  coordCardProxyKicker: "ANONYMER CHAT",
  coordCardProxyHead1: "Die Leitung",
  coordCardProxyHead2: "ist offen.",
  coordCardProxySub: "Nachrichten laufen über mich. Keine Kontakte werden geteilt.",
  menuPremium: "✨ Gennety Premium",
  menuPremiumActive: "✨ Premium · bis {date}",
  menuInviteFriend: "🎁 Freund einladen",
  referralHubTitle: "Lade deine Freunde zu Gennety ein",
  referralHubTagline:
    "Für jeden Freund, der über deinen Link die Verifizierung besteht, bekommst du ein Date-Ticket 🎟 — und er auch.",
  referralShareButton: "📤 Freund einladen",
  referralShareCaption: "Gennety findet dein bestes Match und plant das Treffen selbst.",
  referralShareJoin: "Gennety beitreten 💫",
  hdyhauQuestion: "Noch eine letzte Frage — woher kennst du uns?",
  hdyhauFriendInPerson: "Ein Freund hat es mir persönlich erzählt",
  hdyhauFriendOnline: "Ein Freund hat mir einen Link geschickt",
  hdyhauSocialMedia: "Social Media",
  hdyhauSearch: "Über die Suche",
  hdyhauAd: "Eine Anzeige",
  hdyhauEvent: "Ein Event oder eine Party",
  hdyhauOther: "Woanders",
  hdyhauSkip: "Überspringen",
  hdyhauThanks: "Danke - das hilft wirklich. 💛",
  referralRewardDm:
    "{name} hat die Verifizierung über deinen Link bestanden.\n\nGutgeschrieben: +{tickets} 🎟\n{next}",
  referralRewardNext: "Verbleibende Einladungsbelohnungen: {remaining}.",
  referralRewardNextMax: "Das war deine letzte Einladungsbelohnung — danke 💛",
  referralCardInvitedBy: "Eingeladen von {name}",
  referralCardInvitedGeneric: "Du bist eingeladen",
  referralCardHeadA: "Echte Dates.",
  referralCardHeadB: "Null Chatten.",
  referralCardSupport:
    "Gennety findet dein Match nach tiefer Kompatibilität und organisiert das Treffen persönlich.",
  referralCardGift: "{ticketsPhrase} — geschenkt",
  referralCardFooter: "gennety.com",
  premiumHubTitle: "✨ Gennety Premium",
  premiumHubBody:
    "*Gennety Premium*\n\n• *Unbegrenzte Dates* — dein Ticket ist jedes Mal abgedeckt, egal wie oft\n• *Jede Abendzeit* — die späten Slots im Kalender bleiben für dich offen\n• *Die besten Orte* — eine Auswahl an Orten eine Klasse höher\n• *Kostenlose Ortswechsel* — bis zu zweimal pro Date, ohne Gebühr",
  premiumHubActiveNote: "Du bist Premium ✨ Aktiv bis {date}.",
  premiumOpenCta: "Mehr erfahren",
  premiumCancelHint:
    "Du kannst jederzeit kündigen — schreib es mir einfach hier, ich erledige es nach deiner Bestätigung.",
  premiumManageNote: "Verwalten oder kündigen jederzeit in Telegram → Einstellungen → Abos.",
  premiumWelcomeDm:
    "Willkommen bei Gennety Premium ✨\n\nDeine Dates sind ab jetzt abgedeckt — kein Ticket nötig. Jede Abendzeit im Kalender steht dir offen, Ortswechsel gehen auf uns, und die Premium-Orte sind frei. Aktiv bis {date}.",
  premiumExpiring3d:
    "Dein Gennety Premium endet am {date} — in drei Tagen.\n\nDieser Tarif verlängert sich nicht von selbst: abgedeckte Dates, kostenlose Ortswechsel und die Premium-Orte hören an dem Tag auf. Wähle den nächsten Zeitraum: ein Monat oder 3 / 6 Monate zum günstigeren Preis.",
  premiumExpiring1d:
    "Letzter Tag deines Gennety Premium — es endet am {date}.\n\nDanach kostet ein Date wieder ein Ticket und die Premium-Orte sind wieder gesperrt. Ein Tipp genügt für den nächsten Zeitraum: ein Monat oder 3 / 6 Monate zum günstigeren Preis.",
  premiumExpiringCta: "Tarif wählen",
  // Stars top-up warning for a RECURRING subscriber (§3.8). Distinct from
  // premiumExpiring* above: nothing is ending here — the charge is coming,
  // and it fails on an empty balance. `{amount}` is premiumRenewalAmount or
  // an empty string, so the sentence has to read correctly BOTH ways.
  premiumRenewal3d:
    "In drei Tagen, am {date}, verlängert Telegram dein Gennety Premium.{amount}\n\nAbgebucht wird in Stars von deinem Telegram-Guthaben — auf eine Karte weicht Telegram nicht aus. Reichen die Stars an dem Tag nicht, scheitert die Verlängerung und Premium pausiert. Lade lieber vorher auf: Einstellungen → Meine Stars.",
  premiumRenewal1d:
    "Morgen, am {date}, verlängert Telegram dein Gennety Premium.{amount}\n\nAbgebucht wird in Stars von deinem Telegram-Guthaben, eine Karte als Rückfall gibt es nicht — reicht das Guthaben morgen nicht, scheitert die Verlängerung und Premium pausiert. Aufladen dauert einen Moment: Einstellungen → Meine Stars.",
  premiumRenewalAmount: " Es kostet {stars} ⭐.",
  premiumPlanMonthly: "1 Monat",
  premiumPlan3Months: "3 Monate",
  premiumPlan6Months: "6 Monate",
  premiumPlanSaveBadge: "−{pct}%",
  premiumPlanPerMonth: "{price}/Mon.",
  premiumPackageWelcomeDm:
    "Gennety Premium gehört dir für {months} Monate ✨\n\nDates abgedeckt, Ortswechsel kostenlos, Premium-Orte frei — bis {date}. Dieser Tarif verlängert sich nicht automatisch, also erinnere ich dich rechtzeitig.",
  premiumInvoiceTitle: "Gennety Premium",
  premiumInvoiceDesc:
    "Monatliches Abo — kostenlose Ortswechsel + Premium-Orte. Verlängert alle 30 Tage; jederzeit kündbar.",
  premiumInvoiceLabel: "Gennety Premium — 1 Monat",
  premiumCheckoutError: "Das Abo konnte nicht gestartet werden. Bitte gleich nochmal.",
  premiumCancelConfirm:
    "Gennety Premium kündigen?\n\nPremium bleibt bis {date} aktiv — bis dahin funktioniert alles. Danach verlängert es sich nicht und es wird nichts mehr berechnet.",
  premiumCancelConfirmYes: "Ja, kündigen",
  premiumCancelKeepBtn: "Premium behalten",
  premiumCancelFinalConfirm:
    "Letzte Prüfung — Gennety Premium wirklich kündigen?\n\nPremium bleibt bis {date} aktiv, bis dahin ändert sich nichts. Nach der Bestätigung ist die automatische Verlängerung endgültig aus — willst du Premium später zurück, zahlst du erneut.",
  premiumCancelFinalYes: "Ja, kündigen",
  premiumCancelFinalNoSoft: "Nein, behalten",
  premiumCancelFinalNoHard: "Nein, behalten",
  premiumCancelDone:
    "Erledigt — die automatische Verlängerung ist aus. Premium bleibt bis {date} aktiv, weitere Kosten entstehen nicht. Du kannst jederzeit wieder abonnieren.",
  premiumCancelKept: "Bleibt ✨ Premium ist bis {date} aktiv.",
  premiumCancelAppStore:
    "Dieses Abo wurde über den App Store abgeschlossen und kann nur auf deinem iPhone gekündigt werden: Einstellungen → [dein Name] → Abonnements → Gennety Premium → Kündigen. Dein Zugang bleibt bis {date}.",
  premiumCancelNotActive: "Du hast gerade kein aktives Premium-Abo.",
  premiumCancelReasonAsk:
    "Danke, dass du dabei warst 🤍 Wenn es dir nichts ausmacht — warum kündigst du? Ein, zwei Worte helfen uns wirklich, besser zu werden.",
  premiumCancelReasonSkipBtn: "Lieber nicht",
  premiumCancelReasonThanks: "Danke, notiert 🤍 Du kannst Premium jederzeit zurückholen.",

  // --- Rematch ---
  rematchOfferFamine:
    "Diesmal kein Match — das liegt nicht an dir.\n\nIch kann sofort noch einmal suchen: {price}. Finde ich niemanden, bekommst du deine Stars zurück.",
  rematchOfferFailed:
    "Hat nicht gepasst. Kommt vor.\n\n" +
    "Ich kann sofort noch mal suchen und dir jemand Neues bringen — {price}.\n\n" +
    "Das kauft ein neues Kennenlernen, kein garantiertes Date. Finde ich niemanden, bekommst du deine Stars direkt zurück.",
  rematchOfferNeutral:
    "Soll ich sofort noch mal suchen? Eine neue Person, gleiche Auswahl: {price}.\n\n" +
    "Das kauft ein neues Kennenlernen, kein garantiertes Date. Finde ich niemanden, bekommst du deine Stars direkt zurück.",
  rematchOfferBtn: "Neu suchen — {price}",
  statusButtonRematch: "Jetzt suchen",
  rematchInvoiceTitle: "Neue Suche",
  rematchInvoiceDesc: "Noch eine Suche, sofort — eine neue Person, ausgewählt von Gennety.",
  rematchInvoiceLabel: "Neue Suche",
  rematchFound: "Hab jemanden. Schicke dir gleich die Details ✨",
  rematchNoCandidate:
    "Ich habe geschaut — in deiner Stadt gibt es gerade niemand Neues für dich. Deine Stars sind zurück. Für die nächste Runde bist du dabei.",
  rematchRefundPending:
    "Ich habe niemanden Neues gefunden, und die Rückerstattung hat beim ersten Versuch nicht geklappt. Ich kümmere mich — deine Stars sind gleich zurück.",
  rematchUndelivered:
    "Ich habe jemanden gefunden, konnte das Profil aber nicht zustellen — das liegt an uns. Deine Stars sind zurück, und der Versuch zählt nicht.",
  rematchUndeliveredPending:
    "Ich habe jemanden gefunden, konnte das Profil aber nicht zustellen, und die Rückerstattung hat beim ersten Versuch nicht geklappt. Ich kümmere mich — deine Stars sind gleich zurück.",
  rematchRefunded: "Deine Stars für die neue Suche sind zurück ✨",
  rematchLimitReached:
    "Deine zusätzlichen Suchen sind vorerst aufgebraucht. Die nächste gibt es in ein paar Tagen — die reguläre Runde kommt trotzdem.",
  rematchUnavailable:
    "Eine neue Suche geht gerade nicht. Wenn du ein laufendes Match hast, schließ das zuerst ab.",
  rematchGiftFamine:
    "Ich hatte gesagt, dass es gerade kein Match für dich gibt. Ich habe weitergesucht — und jemanden gefunden, der deine Zeit wert ist.",
  rematchGiftFailed:
    "Letztes Mal hat es nicht geklappt. Ich bin zurück in die Suche und habe jemanden gefunden, der besser zu dir passt.",
  rematchGiftNeutral:
    "Ich habe weitergesucht — und da ist jemand, den du kennenlernen solltest.",
  rematchSearchStep1: "🔍 Starte die Tiefensuche",
  rematchSearchStep2: "Ich schaue, wer gerade in deiner Stadt frei ist",
  rematchSearchStep3: "Ich gleiche Charakter und Interessen ab",
  rematchSearchStep4: "✨ Gleich — ich wähle eine Person aus",
  rematchCardOverline: "DEIN MATCHMAKER",
  rematchCardHeadline: "NOCH EIN\nVERSUCH",
  rematchCardSubline: "Eine neue Person, dieselbe Auswahl.",
};

const plTranslations: TranslationTable = {
  ...translations.en,
  consentMessage:
    "*Cześć! Tu Gennety* 👋\n\nZanim zaczniemy, przeczytaj Warunki korzystania i Politykę prywatności i zaakceptuj zasady przechowywania danych.",
  consentAgree: "Akceptuję",
  consentPrivacyButton: "Polityka prywatności",
  consentTermsButton: "Warunki usługi",
  welcome: "*Gennety Dating*\nDobieramy parę i od razu umawiamy randkę na żywo.",
  chooseLanguage: "Wybierz język:",
  philosophyPitch:
    "*Tu nie trzeba pisać*\n\nPoznam cię, znajdę pasującą osobę i sam ustalę czas i miejsce. Tobie zostaje tylko przyjść. Ruszamy?",
  philosophyContinue: "Ruszamy 🚀",
  askEmail: "Napisz swój uczelniany e-mail — na przykład name@knu.ua",
  invalidEmail: "To nie wygląda na uczelniany e-mail. Sprawdź adres i wyślij jeszcze raz.",
  otpSent: "Wysłałem kod na *{email}*. Wpisz go tutaj:",
  otpInvalid: "Ten kod nie zadziałał. Spróbuj ponownie:",
  otpExpired: "Kod wygasł. Wpisz e-mail jeszcze raz — wyślę nowy.",
  otpTooManyAttempts: "Za dużo prób. Wpisz e-mail ponownie, wyślemy nowy kod.",
  otpCooldown: "Poczekaj chwilę - nowy kod możesz zamówić za minutę.",
  emailVerified: "E-mail potwierdzony ✨",
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
    "Prawie gotowe! Wyślij {min}–{max} zdjęć, na których dobrze cię widać. Bez odważnych zdjęć. Wideo też może być — byle było cię widać.",
  photoReceived: "Zdjęcie {n}/{max}",
  voicePromptSkipButton: "Bez wiadomości głosowej",
  voicePromptSkipHint: "Pominąć — przycisk „{button}” na dole czatu.",
  voicePromptPanelPlaceholder: "Przytrzymaj mikrofon — jakieś 15 sekund",
  voicePromptRecorded:
    "Nagrane — posłuchaj. Wyślij inne, żeby zastąpić, albo „{button}”, żeby usunąć.",
  voicePromptReviewDone: "✅ Gotowe",
  voicePromptSkipped: "To bez wiadomości głosowej — w porządku.",
  voicePromptSaved: "Zapisane ✨ Twój match usłyszy to przed odpowiedzią.",
  voicePromptTooShort: "To ledwie sekunda — przycisk mikrofonu trzeba przytrzymać. Spróbuj jeszcze raz, celuj w jakieś 15 sekund.",
  voicePromptTooLong: "Trochę za długo — zmieść się w 30 sekundach, inaczej nikt tego nie dosłucha. Nagrasz jeszcze raz?",
  voicePromptUnsafe: "Tego nie mogę umieścić w profilu. Nagraj coś innego — albo pomiń, to nieobowiązkowe.",
  voicePromptContactInfo: "Nicków i numerów lepiej nie podawaj — spotkanie organizuję ja, o to właśnie chodzi. Opowiedz lepiej coś o sobie.",
  voicePromptUnavailable: "Nie udało mi się przetworzyć nagrania. Wyślij je jeszcze raz za chwilę.",
  voicePromptPitchCaption: "{name}: wiadomość głosowa dla ciebie",
  photoRejected:
    "Na zdjęciu musi być widoczna Twoja twarz. Spróbuj innego ujęcia.",
  photoDuplicate: "To zdjęcie jest już w profilu — wyślij inne.",
  photoDuplicateNear: "To zdjęcie jest już w profilu — wyślij inne.",
  photoUnsafeContent:
    "Tego zdjęcia nie można opublikować w profilu. Wybierz inne zdjęcie bez treści erotycznych.",
  photoFaceObscured:
    "Na tym zdjęciu twarz jest zasłonięta. Wyślij ujęcie, na którym nie zakrywa jej maska ani szalik.",
  photoMultipleFaces:
    "Na zdjęciu musi być widoczna Twoja twarz. Spróbuj innego ujęcia.",
  photoIdentityMismatch:
    "Wszystkie zdjęcia muszą należeć do jednej osoby. Upewnij się, że Twoja twarz jest na każdym ujęciu.",
  photoIdentityUncertain:
    "Nie udało się wiarygodnie dopasować twarzy. Wyślij wyraźniejsze zdjęcie z lepszym światłem i dobrze widoczną twarzą.",
  photoConsensusPending: "Wyślij jeszcze jedno zdjęcie — po dwóch ujęciach poznam, że to ty.",
  photoConsensusOutlierRejected: "Na jednym zdjęciu jest ktoś inny — tego nie dodałem.",
  photoConsensusConfirmed: "Świetnie, na wszystkich zdjęciach jesteś ty ✨",
  photoConsensusNoPairCap:
    "Nadal nie widzę dwóch zdjęć tej samej osoby. Wyślij jeszcze jedno wyraźne zdjęcie siebie.",
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
  profileConfirm: "Wygląda dobrze",
  profileEdit: "Zmień coś",
  onboardingComplete: "*Gotowe, wchodzisz!* 🎉\n\nJuż szukam ci pary — napiszę, gdy tylko znajdę.",
  btnContinuePhotos: "Dalej ➡️",
  finishOnboardingFirst:
    "Najpierw dokończ rejestrację, potem menu i ustawienia będą dostępne.\nWpisz /start, aby kontynuować.",
  verifyPitch:
    "*Ostatni krok — potwierdź, że to ty*\n\nZrób selfie, a porównam je ze zdjęciami w profilu. Zdjęcia, na których nie ma ciebie, usunę.\n\nBez weryfikacji propozycji będzie mniej.",
  verifyPitchMandatory:
    "*Ostatni krok — potwierdź, że to ty*\n\nZrób selfie, a porównam je ze zdjęciami w profilu. Jeśli na zdjęciach nie ma ciebie — najpierw je wymień. Po weryfikacji od razu zacznę szukać pary.",
  verifyMandatoryNotice:
    "Weryfikacja jest teraz obowiązkowa dla wszystkich nowych profili — dobieranie par zacznie się zaraz po jej zaliczeniu. Zajmie to około minuty:",
  verifyReminderNudge:
    "Twój profil jest gotowy — został tylko krok weryfikacji. Zajmie to około minuty, a dobieranie par zacznie się zaraz potem:",
  verifyBtnGo: "🟢 Zweryfikuj teraz",
  verifyBtnSkip: "⚪️ Pomiń na razie",
  verifySkipNudgeCaption:
    "Chwila — posłuchaj tego, zanim pominiesz 👆",
  verifyBtnReconsider: "🟢 Dobra, zweryfikuję się",
  verifyBtnSkipConfirm: "🔴 Pomiń mimo to",
  // --- Photo re-upload path (a way back before/after verification) ---
  verifyBtnRedoPhotos: "📷 Wgraj inne zdjęcia",
  verifyBtnRedoPhotosSecondary: "📷 Najpierw zmienię zdjęcia",
  verifyBtnAddPhotos: "📷 Dodaj zdjęcia",
  verifyPhotosRequired:
    "Weryfikacja porównuje selfie ze zdjęciami w twoim profilu — a na razie ich nie ma. " +
    "Najpierw dodaj swoje zdjęcia (minimum: {min}), potem uruchom kontrolę:",
  verifyBtnClearPhotos: "🗑 Usuń wszystkie i wgraj od nowa",
  verifyGateLocked:
    "Menu i dobieranie par otworzą się zaraz po weryfikacji. Został tylko ten krok:",
  verifyPhotosRedoIntro:
    "Bez problemu — oto Twoje obecne zdjęcia. Usuń te, na których nie ma Ciebie, i wgraj własne.",
  verifyPhotosRedoIntroRecheck:
    "Bez problemu — oto Twoje obecne zdjęcia. Usuń te, na których nie ma Ciebie, i wgraj własne — gdy skończysz, sprawdzę je automatycznie ponownie, nowe selfie nie będzie potrzebne.",
  verifyPhotosCleared: "Zdjęcia usunięte. Prześlij {min}–{max} swoich zdjęć.",
  verifyPhotosSavedRecheck:
    "Zdjęcia zaktualizowane ✅ Sprawdzam je ponownie względem selfie z weryfikacji — nie musisz jej powtarzać. Napiszę, gdy skończę.",
  verifyPhotosSavedNowVerify:
    "Zdjęcia zaktualizowane ✅ Został ostatni krok — weryfikacja:",
  verifySkipped: "Weryfikacja pominięta. Możesz ją przejść później w menu profilu.",
  verifyCheckAlreadyDone:
    "Już przetworzone - powinna pojawić się wiadomość z wynikiem powyżej. " +
    "Jeśli coś wygląda źle, kliknij 🟢 Zweryfikuj teraz, aby spróbować ponownie.",
  verifyRetryNotLive:
    "*Nie udało się rozpoznać twarzy*\n\nStań twarzą do jasnego światła, zdejmij okulary i jeszcze raz kliknij 🟢 Zweryfikuj teraz.",
  verifyRetryUnfinished:
    "*Weryfikacja została przerwana*\n\nPrzejdź ją za jednym razem, nie zamykając Telegrama — to około 15 sekund. Kliknij 🟢 Zweryfikuj teraz.",
  verifyRetryTechnical:
    "*Błąd po naszej stronie*\n\nKliknij jeszcze raz 🟢 Zweryfikuj teraz — tym razem powinno się udać.",
  verifyReferenceExpired:
    "Usuwamy selfie z weryfikacji po 90 dniach, więc nie mamy już do czego " +
    "porównać twoich nowych zdjęć. Jeszcze jedna 10-sekundowa kontrola i gotowe - " +
    "twój profil w tym czasie pozostaje aktywny:",
  verifyOutcomeVerified:
    "Zweryfikowane ✨ Profil aktywny. Odezwę się, gdy znajdę dopasowanie.",
  profilerHeadsUp:
    "Kiedy szukam dla ciebie kogoś, będę od czasu do czasu zadawać proste pytania — " +
    "co oglądasz, jak spędzasz weekendy, co cię wciąga.\n\n" +
    "Odpowiadaj szczerze i nie odkładaj tego — im lepiej cię znam, tym lepiej " +
    "przygotuję was oboje na spotkanie: od czego zacząć rozmowę i czego lepiej nie ruszać.",
  verifyOutcomePendingReview:
    "🔍 Jeszcze raz sprawdzamy zdjęcia z profilu względem selfie z weryfikacji. Zwykle zajmuje to kilka godzin - napiszę, gdy będzie gotowe.",
  verifyOutcomeRejected:
    "⚠️ *Zdjęcia nie pasują do selfie*\n\nJeśli to nie ty — wymień je przyciskiem 📷, sprawdzę ponownie. Jeśli to ty — przejdź weryfikację jeszcze raz przy dobrym świetle.",
  verifyPhotosDropped:
    "Jedna rzecz: część zdjęć nie pasowała do selfie z weryfikacji, więc zdjąłem je z profilu. Reszta jest widoczna. Dorzuć jeszcze kilka swoich ujęć, kiedy będziesz mieć chwilę 📷",
  verifyPhotosBelowMinimum:
    "Weryfikacja zaliczona ✅\n\nAle część zdjęć nie pasowała do selfie, więc je zdjąłem i teraz w profilu jest mniej niż {min} zdjęć. Dodaj jeszcze {need} swoich, a od razu zacznę szukać pary 📷",
  // --- Native-app push copy for the same verification outcomes (§1.4). Own
  // strings rather than reused DM copy: these land on a lock screen, so they
  // need a title, they must stay short, and they cannot point at a Telegram
  // keyboard ("tap 📷 below") that does not exist in the app.
  verifyPushVerifiedTitle: "Zweryfikowane ✨",
  verifyPushVerifiedBody: "Profil jest aktywny. Odezwę się, gdy znajdę dopasowanie.",
  verifyPushRejectedTitle: "Zdjęcia nie pasują",
  verifyPushRejectedBody:
    "Na zdjęciach w profilu nie ma osoby z selfie z weryfikacji. Jeśli to nie Ty, podmień je — sprawdzę ponownie automatycznie.",
  verifyPushPendingReviewTitle: "Sprawdzamy zdjęcia",
  verifyPushPendingReviewBody:
    "Porównujemy zdjęcia z profilu z selfie z weryfikacji. Zwykle kilka godzin — napiszę, gdy skończymy.",
  verifyPushRetryTitle: "Został jeden krok",
  verifyPushRetryBody:
    "Profil jest gotowy — brakuje tylko weryfikacji. To około minuty, dobieranie par zacznie się zaraz potem.",
  verifyPushPhotosNeededTitle: "Dodaj jeszcze {need} zdjęć",
  verifyPushPhotosNeededBody:
    "Jesteś zweryfikowany, ale w profilu jest mniej niż {min} zdjęć. Dodaj jeszcze {need} swoich, a zacznę szukać.",
  verifyPushPhotosDroppedTitle: "Część zdjęć zniknęła",
  verifyPushPhotosDroppedBody:
    "Nie pasowały do selfie z weryfikacji, więc je zdjąłem. Reszta jest widoczna.",
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
    "🎟️ *Darmowy bilet na randkę jest twój!*\n\nTo prezent za zdjęcia. Jedna randka = 1 bilet. Saldo: *{balance}*",
  ticketRewardVideo:
    "🎟️ *Kolejny darmowy bilet jest twój!*\n\nTo prezent za wideo. Jedna randka = 1 bilet. Saldo: *{balance}*",
  ticketRewardStudent:
    "🎓 *Dwa darmowe bilety są twoje!*\n\nTo prezent za potwierdzony uczelniany e-mail. Jedna randka = 1 bilet. Saldo: *{balance}*",
  welcomeGiftTicket:
    "*Pierwszy bilet ode mnie* ❤️\n\nZwykle randka kosztuje 1 bilet (~$8.49). Ten jest za darmo — już jest w portfelu.",
  ticketStorePurchased: "✨ *Płatność przeszła!* Dodane bilety: *{count}*. Saldo: *{balance}*",
  ticketStoreCheckoutError: "Nie udało się potwierdzić płatności. Spróbuj ponownie.",
  premiumCheckoutAlreadySubscribed:
    "Masz już aktywną subskrypcję Premium, więc płatność została zatrzymana — nic nie pobrano.",
  paymentStuckDm:
    "Płatność przeszła, ale nie udało się wydać zakupu — coś zepsuło się po naszej stronie.\n\nNie płać drugi raz. Już o tym wiemy i albo wydamy zakup, albo zwrócimy gwiazdki.",
  ticketStoreInvoiceTitle: "Bilety Gennety",
  ticketStoreInvoiceDesc:
    "{count} bilet(ów) dodanych do portfela. Każdy bilet pokrywa jedną randkę.",
  ticketGateInvoiceDesc: "Opłata za randkę. Bilety: {count}. Jeden bilet — na jedną osobę.",
  ticketStoreInvoiceLabel: "Bilety Gennety × {count}",
  onboardingFinalizeBlocked:
    "Nie mogę jeszcze dokończyć konfiguracji — po mojej stronie brakuje kilku danych. Spróbuj ponownie za chwilę; jeśli to się powtórzy, napisz na @gennetysupport, ogarniemy to.",
  onboardingPhotosNeedMore: "Zdjęcia: {count}/{min}. Wyślij jeszcze {remaining}.",
  onboardingPhotosBonusOffer:
    "Wymagane zdjęcia są ✨\nJeszcze {remaining} zdjęć (do {threshold}) — i darmowy bilet. Za krótkie wideo — kolejny.",
  onboardingPhotosBonusOfferAfterVideo:
    "Wymagane zdjęcia są, bilet za wideo jest twój ✨\nJeszcze {remaining} zdjęć (do {threshold}) — i drugi darmowy bilet.",
  onboardingPhotosBonusProgress:
    "Zdjęcia: {count}/{threshold}.\nJeszcze {remaining} — i darmowy bilet jest twój.",
  onboardingPhotosBonusProgressAfterVideo:
    "Zdjęcia: {count}/{threshold}.\nJeszcze {remaining} — i drugi darmowy bilet jest twój.",
  onboardingPhotosPhotoBonusEarned:
    "Zdjęcia: {count}. Darmowy bilet za zdjęcia jest twój ✨\nMożesz dodać zdjęcia (do {max}) albo wideo — za nie kolejny bilet.",
  onboardingPhotosBothBonusesEarned:
    "Zdjęcia: {count}, wideo jest — oba darmowe bilety są twoje ✨\nMożesz dodać jeszcze zdjęcia (do {max}).",
  onboardingPhotosPhotoBonusEarnedMax:
    "Wszystkie {max} zdjęć są, bilet za zdjęcia jest twój ✨\nZa krótkie wideo — kolejny darmowy bilet.",
  onboardingPhotosBothBonusesEarnedMax:
    "Wszystkie {max} zdjęć i wideo są ✨\nOba darmowe bilety są twoje.",
  onboardingPhotosOptional:
    "Wymagane zdjęcia są.\nMożesz dodać więcej (do {max}) albo krótkie wideo.",
  onboardingPhotosOptionalAfterVideo:
    "Wymagane zdjęcia i wideo są.\nMożesz dodać więcej zdjęć (do {max}).",
  onboardingPhotosOptionalMax: "Wszystkie {max} zdjęć są.\nMożesz dodać krótkie wideo.",
  onboardingPhotosOptionalMaxAfterVideo: "Wszystkie {max} zdjęć i wideo są ✨",
  ticketWalletText:
    "🎟️ *Moje bilety*\n\nBilety: *{balance}*. Każda randka kosztuje 1 bilet — dokupić można w każdej chwili.",
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
  // --- Relationship intent (PRODUCT_SPEC §1.3) ---
  intentSpark: "Jasna historia",
  intentOpen: "Zobaczymy, dokąd to zaprowadzi",
  intentFalling: "Zakochać się",
  intentLongterm: "Coś na dłużej",
  intentPrivateNote: "widzisz to tylko ty",
  myProfileIntentLine: "🎯 Szukasz: {intent}",
  myProfileIntentUnset: "🎯 Szukasz: nie wybrano",
  editIntentBtn: "🎯 Czego szukam",
  editIntentPrompt:
    "Czego teraz szukasz? Zaznacz wszystko, co pasuje — zwykle to nie jedno.\n\nWidzisz to tylko ty — pomaga mi lepiej dobierać parę.",
  editIntentCleared: "Nic nie wybrano",
  editProfileBody:
    "Tego nie można zmienić:\n\n• *Imię i nazwisko:* {firstName} {surname}\n• *Wiek:* {age}\n• *Uniwersytet:* {university}\n\nMożesz edytować:",
  editBioBtn: "📝 O mnie",
  editPrefsBtn: "💘 Kogo szukam",
  editMajorBtn: "💼 Czym się zajmujesz",
  editProfilePhotosBtn: "📸 Moje zdjęcia",
  editBioPrompt:
    "Napisz kilka zdań o sobie (do 500 znaków) — twój match przeczyta je przed randką.",
  editBioCurrent: "Teraz jest tak. Nowy tekst go zastąpi:",
  editBioTooLong: "Za długie - zmieść się w 500 znakach.",
  editBioSaved: "„O mnie” zaktualizowane",
  editMajorPrompt:
    "Czym się zajmujesz? (praca / studia / branża, maks. 100 znaków)\n👀 Widoczne dla Twojej pary.",
  editMajorTooLong: "Za długie - zmieść się w 100 znakach.",
  editMajorSaved: "Zapisano",
  editPrefsTitle: "💘 *Kogo szukam*\n\nCo zmienić?",
  editPrefsAgeBtn: "🎂 Wiek partnera",
  editPrefsDescriptionBtn: "✨ Jakiej osoby szukam",
  editPrefsCurrent:
    "Aktualne ustawienia:\n• Osoba: {preferences}\n• Wiek: {ageRange}",
  editPrefsNotSet: "Nie ustawiono",
  editPrefsDescriptionPrompt: "Opisz osobę, którą chcesz poznać (maks. 500 znaków).",
  editPrefsDescriptionEmpty: "Dodaj krótki opis — nie może być pusty.",
  editPrefsDescriptionTooLong: "Za długie — zmieść się w 500 znakach.",
  editPrefsDescriptionSaved: "Preferencje zaktualizowane",
  editHobbiesSaved: "Zainteresowania zaktualizowane",
  agentEntryPrompt: "Proszę:",
  agentFallbackError: "Coś poszło nie tak. Powtórz, proszę.",
  agentBlockedVerification: "Najpierw przejdź weryfikację — potem otworzy się reszta.",
  agentBlockedSuspended:
    "Twoje konto jest teraz wstrzymane po naszej stronie, więc tu nie pomogę. Pytania na @gennetysupport.",
  agentBlockedInvestigation:
    "Twoje konto jest w trakcie weryfikacji. Na razie nie ma co robić — szczegóły powie @gennetysupport.",
  agentBlockedBanned:
    "To konto jest zamknięte. Jeśli uważasz, że to błąd, napisz na @gennetysupport.",
  profileEmbeddingSyncPending: "Zapisane. Uwzględnię to przy następnym doborze.",
  editPrefsBack: "⬅️ Wróć do edycji",
  editAgeRangePrompt: "W jakim przedziale wiekowym mamy szukać dla Ciebie partnera? (np. 20-28)\nMin: {min}, Max: {max}.",
  editAgeRangeInvalid: "Nie łapię. Podaj dwie liczby, np. 20-28 (zakres {min}-{max}).",
  editAgeRangeSaved: "Zakres wieku zaktualizowany",
  editProfilePhotosStart: "Wyślij nowe zdjęcia ({min}-{max}) — pojedynczo lub jako album.",
  editProfilePhotosSaved: "Zdjęcia zaktualizowane",
  editProfileSaved: "Profil zaktualizowany",
  photoManagerTitle: "Zdjęcia: {count}/{max} · minimum {min}",
  photoManagerCardDeleteBtn: "🗑 Usuń to zdjęcie",
  photoManagerCardRemoved: "🗑 Zdjęcie usunięte",
  photoManagerAddBtn: "➕ Dodaj",
  photoManagerDoneBtn: "Gotowe",
  photoManagerMinReached: "Potrzebujesz co najmniej {min} zdjęć. Najpierw dodaj nowe.",
  photoUploadStep1: "Wgrywam Twoje zdjęcia…",
  photoUploadStep2: "Sprawdzam kadry…",
  photoUploadStep3: "Jeszcze chwila…",
  photoUploadOneStep1: "Wgrywam Twoje zdjęcie…",
  photoUploadOneStep2: "Sprawdzam kadr…",
  photoReviewStep1: "Oglądam Twoje zdjęcia…",
  photoReviewStep2: "Przeglądam kadry…",
  photoReviewOneStep1: "Oglądam Twoje zdjęcie…",
  photoReviewOneStep2: "Przeglądam kadr…",
  photoBatchAdded: "Dodano: {n} · {total}/{max} w profilu",
  photoBatchNoneAdded: "Z tej partii nic nie zostało dodane.",
  photoBatchAtMax: "Masz limit {max} zdjęć — usuń jedno, aby dodać nowe.",
  photoManagerDeleted: "Zdjęcie usunięte.",
  photoStagePanelBtn: "🗂 Moje zdjęcia",
  photoStagePanelPlaceholder: "Wyślij więcej zdjęć lub kliknij 🗂",
  photoEditorIntro:
    "Oto wszystkie twoje zdjęcia. Kliknij 🗑 pod dowolnym zdjęciem, aby je usunąć, albo wyślij nowe tutaj.",
  photoEditorBackBtn: "← Wróć do wysyłania",
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
    "Wskazówka: dodaj krótkie wideo do profilu z menu i zdobądź darmowy bilet 🎁.",
  pauseConfirmed: "Matching wstrzymany ⏸\nNie będzie nowych dopasowań, dopóki go nie wznowisz.",
  resumeConfirmed: "Matching znowu działa ▶️\nJuż działam.",
  settingsTitle: "⚙️ Ustawienia",
  settingsLanguage: "🌐 Język",
  settingsLanguagePick: "Wybierz język:",
  settingsLanguageSaved: "Język zaktualizowany",
  settingsTheme: "🎨 Motyw",
  settingsThemePick: "Wybierz wygląd:",
  settingsThemeSaved: "Motyw zaktualizowany",
  themeDarkOption: "🌙 Ciemny",
  themeLightOption: "☀️ Jasny",
  helpBody:
    "*Potrzebujesz pomocy?*\n\nProblem z matchem, randką albo botem — napisz do supportu:\n\n💬 [@gennetysupport](https://t.me/gennetysupport)",
  settingsDeleteAccount: "🗑 Usuń konto",
  deleteAccountConfirm:
    "*Usunąć konto na zawsze?*\n\nZnikną profil, zdjęcia i matche. Tego nie da się cofnąć.",
  deleteAccountYes: "Tak, usuń wszystko",
  deleteAccountNo: "Anuluj",
  deleteAccountDone:
    "Konto usunięte. Wszystkie dane wyczyszczone.\n" +
    "Chcesz wrócić? Po prostu wyślij /start.",
  deleteAccountFailed:
    "Nie udało się teraz bezpiecznie usunąć wszystkich danych. Konto pozostało — spróbuj ponownie.",
  deleteAccountRefundInProgress:
    "Na Twoim koncie wciąż trwa zwrot środków i gdybyśmy usunęli konto teraz, nie byłoby go dokąd zwrócić. Nic nie zostało usunięte — spróbuj ponownie, gdy zwrot dotrze.",
  accountActionExpired: "To potwierdzenie wygasło. Otwórz działanie ponownie.",
  statusActionUnavailable: "Ta czynność jest niedostępna dla bieżącego statusu konta.",
  deleteFreezeIntro:
    "Zaczekaj — zanim wszystko usuniesz 👀\n\nNie musisz tracić wszystkiego. Lepiej *zamroź* konto: profil, zdjęcia i weryfikacja zostają, znikasz z dopasowywania, a następnym razem wystarczy wysłać /start, by wrócić prosto do swojego gotowego profilu — bez ponownej rejestracji.\n\nNadal chcesz usunąć? Tego nie da się cofnąć.",
  deleteFreezeBtn: "❄️ Zamroź konto",
  deleteProceedBtn: "Mimo to usuń konto",
  freezeConfirmed:
    "Gotowe — Twoje konto jest *zamrożone* ❄️\n\n" +
    "Nie widać Cię w dopasowywaniu i nie będę pisać. " +
    "Wróć kiedy chcesz przez /start — wszystko czeka na swoim miejscu.",
  freezeWelcomeBack: "*Witaj z powrotem!* Konto odmrożone.",
  deleteFinalYes: "Tak, usuń",
  deleteFinalNoSoft: "Nie, zostaw",
  deleteFinalNoHard: "Nie, zostaw",
  freezePartnerNotice:
    "Ważne — Twoje dopasowanie nie jest już dostępne, więc ta randka się nie odbędzie. " +
    "Spokojnie: w następnej turze masz priorytet 💛",
  matchHeadline: "💘 Znaleźliśmy dla Ciebie dopasowanie!",
  matchDeadlineNotice: "Na odpowiedź masz 24 godziny. Potem nie można zmienić zdania.",
  matchStreamStart: "Czemu do siebie pasujecie…",
  matchBtnAccept: "Akceptuj",
  matchBtnDecline: "❌ Odpuść",
  matchDeclineConfirmPrompt:
    "Na pewno pasujesz?\n\nTo decyzja ostateczna — tej osoby już nie zobaczysz.",
  matchBtnConfirmDecline: "❌ Tak, odpuść",
  matchBtnKeepDeciding: "← Wróć",
  matchDecisionQuestionM:
    "Chcesz iść z nim na randkę? Po prostu odpowiedz tak albo nie.",
  matchDecisionQuestionF:
    "Chcesz iść z nią na randkę? Po prostu odpowiedz tak albo nie.",
  matchTextYesConfirm: "Świetnie ✨ Potwierdź poniżej — resztą zajmę się ja:",
  matchBtnConfirmGo: "💫 Tak, idę na randkę",
  matchTextUnsure:
    "Bez pośpiechu — gdy zdecydujesz, napisz mi po prostu „tak” albo „nie”.",
  matchDeclineDismissed:
    "Bez pośpiechu — to dopasowanie wciąż czeka na Twoją odpowiedź. 💛",
  matchAcceptedToast: "Przyjęte",
  matchDecisionSavedToast: "Zapisane",
  matchAccepted: "Przyjęte ✨ Czekamy na drugą osobę.",
  matchBothAccepted: "Wzajemne 🤍 Znajdźmy termin.",
  matchDeclined:
    "Jasne. Co nie pasowało? Wybierz opcję albo napisz własnymi słowami — uwzględnię to następnym razem.",
  matchDeclineReasonType: "Wyglądowo nie mój typ",
  matchDeclineReasonVibe: "Inny vibe",
  matchDeclineReasonInterests: "Zainteresowania nie pasują",
  matchDeclineReasonLifestyle: "Styl życia nie pasuje",
  matchDeclineReasonOther: "Coś innego",
  matchDeclineOtherAsk:
    "Okej — wyślij krótki tekst albo wiadomość głosową z powodem. Uwzględnię to przy następnym doborze.",
  matchDeclineFeedbackSaved: "Zapisane. Kolejne propozycje ustawię pod to.",
  matchDeclineAlreadyNoted: "Już zapisane — dzięki.",
  matchDeclineFeedbackFailed: "Nie udało się teraz zapisać. Nadal możesz wysłać krótki tekst albo głosówkę.",
  matchDeclineThanks: "Jasne. Szukam dalej.",
  matchPeerDecided:
    "*Twój match już odpowiedział*\n\nCo dokładnie — dowiesz się po swojej odpowiedzi.",
  matchPeerWasAccepted: "FYI - Twoje dopasowanie było na tak. Tym razem po prostu się nie złożyło.",
  matchPeerWasDeclined: "FYI - Twoje dopasowanie tym razem odpuściło.",
  matchAcceptedPeerDeclined:
    "Tym razem z drugiej strony padło „nie”. Zdarza się — tu randka dzieje się tylko przy wzajemnym zainteresowaniu. " +
    "Szukam dalej; następna propozycja będzie bliżej.",
  matchAcceptedPeerDeclinedPriority:
    "Tym razem z drugiej strony padło „nie”. Zdarza się — tu randka dzieje się tylko przy wzajemnym zainteresowaniu.\n\nPodniosłem Twój priorytet przy kolejnym doborze. Następna propozycja będzie bliżej.",
  matchPhotoCaption: "{name}, {age}",
  matchVerifiedLabel: "Zweryfikowano",
  matchVerifiedQuote: "Zweryfikowane: na zdjęciach naprawdę jest ta osoba.",
  matchSynergyLabel: "Zgodność {score}/99",
  matchSynergyHeader: "💎 {label} — {reason}",
  pitchCountdownHours: "⏳ Zostało {hours}h na odpowiedź",
  pitchCountdownMinutes: "⏳ Zostało {minutes} min na odpowiedź",
  pitchDeadlineBtnHm: "⏳ Zostało na odpowiedź: {h}h {m}m",
  pitchDeadlineBtnMin: "⏳ Zostało na odpowiedź: {m}m",
  pitchCountdownTapToast: "Po prostu powiedz tak lub nie, gdy będziesz gotowy — okno wciąż jest otwarte ✨",
  pitchDeadlineNudge:
    "Małe przypomnienie — okno na odpowiedź na to dopasowanie zamknie się za około {hours}h. Jeśli chcesz iść, po prostu powiedz teraz tak; jeśli nie — też w porządku.",
  stallPartnerFallbackName: "twoje dopasowanie",
  stallActionExpired: "To już się rozstrzygnęło — nie ma tu na co odpowiadać.",
  matchCardExpiredAlert: "Ta karta dopasowania nie jest już aktywna — nie ma tu już nic do decydowania.",
  emergencyStaleAction: "Ta randka nie jest już aktywna. Sprawdź aktualny status przed kolejną próbą.",
  calendarStaleAction: "Ten kalendarz jest już zamknięty. Otwórz aktualną kartę dopasowania, aby zobaczyć zmianę.",
  stallVenueNudge:
    "Zostało tylko zaznaczyć, skąd wyruszasz — wtedy znajdę miejsce wygodne dla was oboje.",
  stallCheckInScheduling:
    "{name} czeka — zatrzymaliście się na wyborze godziny.\nWciąż aktualne?",
  stallCheckInVenue:
    "{name} czeka — zatrzymaliście się na wyborze miejsca.\nWciąż aktualne?",
  stallBtnStillOn: "🟢 Tak, wszystko aktualne",
  stallBtnPlansChanged: "Plany się zmieniły",
  stallPeerAsked:
    "Przypomniałem {name} o was — czekam na odpowiedź.\n\nOd ciebie na razie nic nie trzeba.",
  stallStillOnAck: "Jasne, wszystko aktualne ✨",
  stallPeerStillOn: "{name} jest w kontakcie, wszystko aktualne ✨",
  stallCancelConfirmPrompt:
    "Odwołujemy randkę z {name}?\n\nTo decyzja ostateczna — tej pary już nie zaproponuję.",
  stallBtnCancelConfirm: "🔴 Tak, odwołaj",
  stallBtnCancelBack: "🟢 ← Wróć",
  stallCancelAborted: "Dobrze — wszystko zostaje. 👍",
  stallCancelDone: "Rozumiem. {name} poinformowałem — bez szczegółów.\n\nWracasz do wyszukiwania.",
  stallPeerCancelled:
    "Randka odwołana — u {name} zmieniły się plany.\n\n" +
    "To nie o ciebie. Podniosłem twój priorytet w następnym doborze.",
  stallTimeoutPartnerGone:
    "Randka odwołana — od {name} nie było odpowiedzi.\n\n" +
    "Szkoda, ale lepiej teraz niż w dniu spotkania. Podniosłem twój priorytet w następnym doborze.",
  stallTimeoutSelf:
    "Twoja randka z {name} została odwołana — dwa dni bez odpowiedzi, " +
    "a nie mogłem trzymać was oboje w zawieszeniu.\n\n" +
    "Jeśli plany się zmieniają — po prostu napisz. To normalne.",
  stallTimeoutVenueUnresolved:
    "Twoja randka z {name} została odwołana — nie udało mi się na czas znaleźć dla was miejsca.\n\nTo moja wina, nie wasza. Podniosłem twój priorytet w następnym doborze.",
  pitchExpired: "⏳ Czas minął - ta propozycja wygasła.",
  matchExpiredSilentWarning:
    "*Czas na odpowiedź minął*\n\nNastępnym razem odpowiedz chociaż „nie” — ktoś czeka.",
  matchExpiredSilentPenalty:
    "*Czas na odpowiedź minął*\n\nTo już drugi raz, więc ocena została obniżona. Następnym razem odpowiedz chociaż „nie” — ktoś czeka.",
  matchExpiredYouMissedDate: "Ważne — twój match był na tak. To mogła być prawdziwa randka.\n\n",
  matchExpiredPeerIgnored:
    "Twój match nie odpowiedział w ciągu 24h, więc randka się nie odbędzie. Widzimy się przy następnym doborze.",
  // §3.4 — this side PASSED, and the partner then went silent. A first
  // decision leaves the row `proposed` either way, so a decliner reaches
  // expiry classified as a `responder` exactly like someone who accepted
  // and got stood up. They already got their "you passed" ack, so this is
  // deliberately a bare fact with no consolation and no card: it exists
  // only so the match doesn't vanish from the menu and banner unexplained.
  matchExpiredSelfDeclined: "Match zamknięty. Widzimy się przy następnym doborze.",
  // Karta wygaśnięcia (PRODUCT_SPEC §3.4). Nagłówki są neutralne płciowo —
  // forma "odpuściłeś/odpuściłaś" jest nieczytelna w dużym stopniu pisma.
  // Polskie znaki diakrytyczne wymagają PEŁNEGO Unbounded (`unbounded-700.woff`),
  // nie podzbiorów `latin`/`cyrillic` — patrz `services/expiry-card.ts`.
  expiryCardOverlineExpired: "OKNO ZAMKNIĘTE",
  expiryCardHeadlineExpired: "CZAS\nMINĄŁ",
  expiryCardSublineExpired:
    "Minęły 24 godziny bez odpowiedzi.\nCzekamy na ciebie przy następnym doborze.",
  expiryCardOverlinePenalty: "DRUGI RAZ BEZ ODPOWIEDZI",
  expiryCardHeadlinePenalty: "RATING\nOBNIŻONY",
  expiryCardSublinePenalty:
    "Drugi match bez odpowiedzi.\nCzekamy na ciebie przy następnym doborze.",
  expiryCardOverlinePeerIgnored: "TO NIE O TOBIE",
  expiryCardHeadlinePeerIgnored: "BRAK\nODPOWIEDZI",
  expiryCardSublinePeerIgnored:
    "Randka się nie odbędzie.\nTwoja część została zrobiona na czas.",
  expiryCardOverlineMissedDate: "TO BYŁO NA TAK",
  expiryCardHeadlineMissedDate: "TO BYŁO\nWZAJEMNE",
  expiryCardSublineMissedDate:
    "Twoje dopasowanie chciało się spotkać.\n24 godziny bez odpowiedzi.",
  expiryCaptionSilentWarning: "Następnym razem odpowiedz chociaż „nie” — ktoś czeka.",
  expiryCaptionSilentPenalty:
    "To już drugi raz, więc ocena została obniżona. Następnym razem odpowiedz chociaż „nie” — ktoś czeka.",
  expiryCaptionPeerIgnored: "Widzimy się przy następnym doborze.",
  noMatchThisWeekTier1:
    "*W tym tygodniu bez matcha*\n\nNie znalazłem nikogo, kto naprawdę pasuje, a nie chcę proponować byle kogo. Przy następnym doborze masz priorytet ✨",
  noMatchThisWeekTier2:
    "*Znowu bez matcha*\n\nDrugi tydzień z rzędu nie widzę nikogo, kto naprawdę pasuje. Dzięki, że czekasz — przy następnym doborze twój priorytet jest jeszcze wyższy 🤍",
  noMatchThisWeekTier3:
    "*Na razie bez matcha*\n\nNadal nie ma nikogo, kto naprawdę pasuje, a nie będę proponować byle kogo. Pilnuję twojej kolejki — przy następnym doborze jesteś wśród pierwszych 🤍",
  noMatchDiscountOffer:
    "🎟️ Małe podziękowanie za cierpliwość: Twoja następna pierwsza randka z rabatem {pct}% na jeden bilet. " +
    "Zastosujemy rabat automatycznie, gdy trafi Ci się para lub otworzysz swoje bilety.",
  poolExhaustedPauseNotice:
    "*Wstrzymuję wyszukiwanie*\n\nTeraz naprawdę nie ma nikogo dla ciebie — to nie twoja wina. Gdy tylko pojawi się ktoś pasujący, sam przywrócę cię do wyszukiwania.",
  poolExhaustedResumeNotice:
    "Dobre wieści — pojawił się ktoś pasujący, więc przywróciłem cię do wyszukiwania. Jesteś w następnym doborze 🤍",
  matchScheduleProposal: "Co powiesz na jedną z tych opcji? Kliknij, co pasuje:",
  matchScheduleIter3:
    "Wzajemnie ✨ Otwórz kalendarz i zaznacz pasujące godziny.",
  matchScheduleAfterTicket:
    "📅 Teraz wybierz czas — otwórz kalendarz i zaznacz wszystkie pasujące terminy.",
  matchScheduleBtnCalendar: "📅 Otwórz kalendarz",
  ticketCardCaption: "To match 🤍 Weź bilet — i wybierzemy termin.",
  ticketCardCaptionPremium: "To match 🤍 Premium pokrywa oba bilety — od razu wybieramy termin.",
  ticketButton: "🎟️ Odbierz bilet na randkę",
  ticketViewButton: "🎟️ Zobacz swój bilet na randkę",
  ticketStatusButton: "Otwórz randkę",
  ticketGateWaiting: "Bilet gotowy ✨ Czekamy na drugą osobę.",
  ticketPeerTookTheirs:
    "{name} ma już bilet na randkę 🎟️ Został twój — potem otwieramy planowanie.",
  bumpVerifiedDm:
    "Jesteście oboje na miejscu ✨ Randka zaliczona — bilet na następną ode mnie.",
  bumpDeckIntro: "Jeśli rozmowa będzie potrzebowała kierunku:",
  matchScheduleNoOverlap: "Jeszcze brak wspólnego terminu - kolejna runda.",
  matchScheduled: "Ustalone — do zobaczenia 🤝\n\n{venue}",
  matchScheduledNoReservation:
    "🍵 W godzinach szczytu może być pełno - nic się nie stanie: można wziąć kawę na wynos i się przejść albo wpaść do innego miłego miejsca obok.",
  matchScheduledBtnOpenMaps: "📍 Otwórz w Mapach",
  matchScheduledBtnShare: "📤 Udostępnij kartę",
  dateCardWhen: "KIEDY",
  dateCardSlogan: "Bez pisania\nOd razu na żywo",
  dateCardShareCaption:
    "Udostępniaj śmiało — twarz Twojego matcha jest zasłonięta dla ochrony jego prywatności 💞",
  dateCardShareFailed:
    "Nie udało się przygotować karty do udostępnienia — spróbuj za chwilę.",
  matchSchedulePickedPrefix: "Twój wybór: ",
  matchScheduleWaitingPeer: "Czekamy na drugą osobę...",
  matchSchedulePeerProposed:
    "Twój match zaznaczył już godziny w kalendarzu. Otwórz — potwierdź jedną albo zaproponuj własną:",
  matchSchedulePeerSuggestedAlternative:
    "Twój match zaproponował inny termin. Zerknij — możesz się zgodzić albo zaproponować swój.",
  matchScheduleSavedConfirmation: "Gotowe. Twój match dostał powiadomienie — napiszę, gdy odpowie.",
  matchScheduleNoOverlapYet:
    "Oboje zaznaczyliście godziny, ale jeszcze nic się nie pokrywa. Dodaj kilka opcji — gdy tylko jakiś slot się zgodzi, klepnięte:",
  matchSchedulePickFinalYet:
    "Wasze kalendarze już się pokrywają — otwórz go i potwierdź najlepszy termin, a randka jest klepnięta:",
  venueTimeCardLabel: "WASZA RANDKA",
  venueTimeLockedCaption: "Termin waszej randki jest ustalony ✨",
  venueConciergeIntro:
    "*Skąd pojedziesz na randkę?*\n\nZaznacz punkt na mapie — dom, metro, dowolne wygodne miejsce. Dobiorę lokal, do którego wygodnie dotrzecie oboje.",
  venueConciergeBtnLocation: "📍 Wyślij lokalizację",
  venueConciergeBtnMap: "🗺️ Wybierz na mapie",
  venueLocationFirst:
    "Najpierw najważniejsze - *zaznacz, skąd będziesz wyruszać* 📍 Kliknij poniżej, aby zaznaczyć punkt na mapie.",
  venueOriginOutsideMarket:
    "Ten punkt jest poza {city}, a Gennety działa na razie tylko tam - szukam miejsca blisko was obojga, więc stamtąd nie znajdę żadnego. Zaznacz punkt w {city}, z którego wyruszysz:",
  venueVibeNoted: "Vibe zapisany ✨ Teraz wybierz, skąd będziesz jechać:",
  venueLocationNoted:
    "Punkt startowy zapisany ✨ Teraz - jaki *vibe* chcesz? np. _cicha kawiarnia_, _wegański brunch_, _spacer po parku_, _małe muzeum_.",
  venueSafetyOverride: "Mała uwaga - wybraliśmy publiczną kawiarnię. Pierwsze randki trzymamy w publicznych miejscach.",
  venueWaitingPeer: "Twoje zapisane ✨ Czekamy na nich...",
  venueLocationUseMap:
    "Lokalizacje wysłane w czacie nie trafiają już do wyszukiwania miejsca — zaznacz punkt startowy na mapie poniżej 📍",
  venueTimeLapsedBackToCalendar:
    "Do randki zostało za mało czasu, żeby zdążyć znaleźć miejsce — wybierzmy nową godzinę.",
  venueSelectionFailedRetry:
    "Nie udało się teraz dobrać miejsca na randkę — wyszukiwanie miejsc zawiodło po naszej stronie. Otwórz ekran miejsca i jeszcze raz potwierdź punkt startowy, żeby spróbować ponownie.",
  peerWaitT1Sent: "Przekazaliśmy {name}, czekamy na odpowiedź",
  peerWaitT2Waiting: "{name} jeszcze się zastanawia",
  peerWaitT3Quiet: "Od {name} cisza, czekamy",
  peerWaitT4Nudged: "Przypomnieliśmy {name}, czekamy na odpowiedź",
  peerWaitT5Deadline: "{name} długo nie odpowiada",
  peerWaitAnon: "Czekamy na drugą stronę",
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
  onbAnalyzeStep1b: "💭 Myślę…",
  verifyAnalyzeStep1: "🔍 Porównuję twoje selfie…",
  verifyAnalyzeStep2: "🧬 Analizuję rysy twarzy…",
  verifyAnalyzeStep3: "⏳ Kończę weryfikację…",
  voiceCheckStep1: "🎧 Słucham twojego nagrania…",
  voiceCheckStep2: "Sprawdzam, czy wszystko gra…",
  videoCheckStep1: "🎬 Przeglądam twój film…",
  videoCheckStep2: "🙂 Sprawdzam, czy to ty…",
  videoCheckStep3: "✨ Prawie gotowe…",
  skipAnalyzeStep1: "✨ Dopracowuję twój profil…",
  skipAnalyzeStep2: "🧮 Składam wszystko w całość…",
  skipAnalyzeStep3: "💞 Przygotowuję cię do doboru…",
  profilerBatchThinking: "Myślę…",
  profilerBatchSaving: "Zapisuję twoje odpowiedzi…",
  profilerBatchSaved:
    "Karta preferencji zaktualizowana ✨ Uwzględnię ją przy następnym doborze.",
  profilerNextAck: "Zapisane…",
  profilerNextFormulating: "Myślę…",
  profilerRefusalAck: "Okej, nie drążę. Zapytam innym razem 💛",
  profilerImageUnreadable: "Hm, nie udało mi się tego odczytać 😅 Opowiesz słowami?",
  profilerLinkUnreadable: "Nie mogę tego otworzyć — chyba prywatne albo usunięte 😅 Opowiesz słowami albo wrzucisz obrazek?",

  // --- Phase 3.7b: Venue change v2 (paid multiplayer board) ---
  venueChangeButton: "🔄 Zmień miejsce",
  venueBoardPingFromF: "{name} rozgląda się za przytulniejszym miejscem na waszą randkę 👀",
  venueBoardPingFromM: "{name} proponuje spojrzeć na kilka innych miejsc na waszą randkę 👀",
  venueBoardPingBtn: "Zobacz",
  venueKeepNotice: "Twój match wolałby zostać w {venue}. Możesz zaproponować inne miejsce poniżej.",
  venueBothKeepDm: "Oboje zostajecie w {venue} — nic się nie zmienia, do zobaczenia.",
  venueDeclinedKeepDm: "Zostajecie w {venue}, zgodnie z planem.",
  venueChangeRefunded:
    "Zmiana miejsca nie doszła do skutku, gwiazdki wróciły do Ciebie. Randka jest aktualna — w dotychczasowym miejscu.",
  primeInvoiceTitle: "Późne wieczory",
  primeInvoiceDesc:
    "Otworzy 18:30, 19:00 i 19:30 we wszystkie dni waszego kalendarza — dla was obojga, na tę randkę.",
  primeInvoiceLabel: "Późne wieczory",
  primeTimeOpenedDm:
    "{name} otwiera późne wieczory — 18:30 i później są teraz w waszym kalendarzu.",
  primeTimeRefunded:
    "Późne wieczory się nie otworzyły, gwiazdki wróciły do ciebie. Reszta kalendarza bez zmian.",
  primeTimeRefundedDateOff:
    "Randka się nie odbędzie, więc gwiazdki za późne wieczory wróciły do ciebie.",
  memeCardTeaser:
    "🎭 Jeszcze jedno o {name}.\n\nKiedy zapytałem, co naprawdę śmieszy, nie było odpowiedzi słowami — przyleciał mem. To mówi o człowieku więcej niż trzy zdania.\n\nChcesz go zobaczyć przed spotkaniem?",
  memeCardBtn: "🎭 Pokaż",
  memeRevealCaption: "🎭 Co śmieszy {name}:",
  memeRevealSource: "▶️ Zobacz w całości:",
  memeRevealFallback:
    "🎭 Samego obrazka nie udało się przesłać, więc słowami. {name} — o tym, co śmieszy:\n\n_{description}_",
  memeRevealGone: "Na to pytanie odpowiedziano ponownie słowami — nie ma tu już mema.",
  memeRevealUnavailable: "Ta karta nie jest już aktywna.",
  venuePayPromptDm: "Razem wybraliście nowe miejsce na randkę.\n\n📍 {venue}",
  venuePayOpenBtn: "📍 Zobacz i zdecyduj",
  venueWishText:
    "{name} znalazła miejsce, które bardzo jej się podoba.\n\n" +
    "Będzie jej miło, jeśli to Ty je zatwierdzisz.",
  venueWishTextFallback:
    "{name} znalazła miejsce, które bardzo jej się podoba.\n\n📍 {venue}\n\n" +
    "Będzie jej miło, jeśli to Ty je zatwierdzisz.",
  venueWishPayBtn: "Zatwierdź — {stars} ⭐",
  venueWishDeclineBtn: "Nie tym razem",
  venuePayDeclineAck:
    "Rozumiem — miejsce na razie zostaje bez zmian. Jeśli się zmieni, dostaniesz nową kartę.",
  venuePayDeclineStale:
    "Ta karta jest już nieaktualna — plany co do miejsca się od tego czasu zmieniły. Kliknij poniżej, żeby zobaczyć, jak jest teraz.",
  venuePaySelfDm:
    "Zgodziliście się na nowe miejsce.\n📍 {venue}\nZatwierdź je — zaktualizuję wasze karty.",
  venuePaySelfBtn: "⭐ Zatwierdź — {stars}",
  venueSettledCard: "Gotowe — wasza randka ma nowe miejsce 📍 {venue}",
  venueSettledPaidByM: "{name} opłacił zmianę miejsca ❤️ Wasza randka odbędzie się w {venue}",
  venueSettledPaidByF: "{name} opłaciła zmianę miejsca ❤️ Wasza randka odbędzie się w {venue}",
  venueExpressPartnerFromF: "{name} wybrała dla was przytulniejsze miejsce. Nowe miejsce: 📍 {venue}",
  venueExpressPartnerFromM: "{name} wybrał dla was nowe miejsce. Nowe miejsce: 📍 {venue}",
  venueLapsedDm: "Zmiana miejsca nie została zatwierdzona — spotykacie się w {venue}, jak planowano.",
  venueKeepOriginalDm: "Twój match nie chce nic zmieniać — spotykacie się w {venue}, jak planowano.",
  venueInvoiceTitle: "Zmiana miejsca randki",
  venueInvoiceDesc: "Nowe miejsce randki: {venue}",
  venueInvoiceLabel: "Zmiana miejsca",
  icebreakerIntro: "Twoja randka jest za 5 godzin! Kilka tematów na start:\n\n",
  icebreakerStreamStart: "✨ Dobieram kilka tematów do rozmowy dla was…",
  noMatchStreamStart: "💫 Przeglądam dopasowania dla Ciebie…",
  wingmanHintIntro: "👋 Wskazówka od środka - randka jest za 90 minut:\n\n",
  dateTerminalInvite:
    "*Randka za {minutes} min*\n📍 {venue}\n\nOtwórz ekran randki — pokaże ci drogę. Przy stoliku przyłóżcie telefony do siebie i przytrzymajcie, żeby wymienić się kontaktami.",
  dateTerminalReminder:
    "*Wymiana kontaktów otwarta*\n📍 {venue}\n\nGdy oboje będziecie przy stoliku — otwórz ekran randki, przyłóżcie telefony do siebie i przytrzymajcie.",
  dateTerminalBtn: "🎟 Otwórz randkę",
  dateDayActivityStartTitle: "Dziś masz randkę",
  emergencyPushTitle: "Randka odwołana",
  emergencyPushBody: "Otwórz Gennety — tam jest powód.",
  dateDayActivityStartBody: "Wszystko, czego potrzebujesz, jest na ekranie blokady.",
  venueActivityStartTitle: "Zmiana miejsca",
  venueActivityStartPartner: "{name} proponuje {what}",
  venueActivityStartPartnerKeep: "{name} chce zostawić {venue}",
  venueActivityStartWaiting: "Czekamy na odpowiedź w sprawie miejsca",
  venueActivityStartMatch: "Wspólny wybór: {venue}",
  venueActivityPartnerFallback: "Twój match",
  // The time-agreement lock-screen card (iOS `time_agreement` Live Activity,
  // decision 2026-09-23): the alert a push-to-start carries, and the one an
  // update carries when the PARTNER moved. `{when}` is a weekday + HH:mm in the
  // RECIPIENT's timezone (the weekday is dropped when the slot is today); the
  // partner name is only ever the SUBJECT — the server declines no names, which
  // is also why waiting has a nameless twin rather than reusing
  // `venueActivityPartnerFallback` ("Ждём, когда Твой мэтч ответит" would
  // capitalise mid-sentence).
  timeActivityStartTitle: "Wybieramy czas",
  timeActivityStartPartner: "{name} proponuje {when}",
  timeActivityStartWaiting: "Czekamy, aż {name} odpowie",
  timeActivityStartWaitingNoName: "Czekamy na odpowiedź w sprawie czasu",
  timeActivityStartMatch: "Czas ustalony: {when}",
  profilerSkip: "Pomiń",
  emergencyUnlocked: "Plany się zmieniły i naprawdę nie możesz przyjść? Możesz odwołać poniżej.",
  emergencyBtn: "Odwołaj randkę",
  emergencyConfirmPrompt:
    "Jeśli to tylko stres albo spóźnienie — lepiej zostaw randkę. *Odwołuj tylko, jeśli naprawdę nie możesz przyjść:* matcha nie da się przywrócić.",
  emergencyBtnConfirm: "🔴 Tak, odwołaj randkę",
  emergencyBtnBack: "🟢 Zostaw randkę",
  emergencyAborted: "Okej — Twoja randka jest aktualna. 👍",
  emergencyAskReason: "Napisz powód. To pójdzie do Twojego dopasowania *słowo w słowo*.",
  emergencyConfirmed: "Randka odwołana. Twoja wiadomość została przekazana.",
  emergencyDateStarted:
    "Godzina randki już minęła, więc nie da się jej już odwołać. " +
    "Jeśli do spotkania nie doszło, zapytam cię o to następnego dnia.",
  emergencyReceivedOther: "Twoje dopasowanie odwołało randkę. Oto co napisali:\n\n\"{reason}\"",
  emergencyReceivedOtherIntro: "Twoje dopasowanie odwołało randkę. Oto co napisali:",
  emergencyReceivedOtherSoftNote:
    "To nie przez Ciebie. Gennety trochę podniesie Twój priorytet przy kolejnym doborze.",
  feedbackInvitation:
    "*Jak poszła randka?* ✨\n\nPodziel się kilkoma szczegółami: była chemia, jaki był vibe, czy miejsce się podobało?",
  feedbackBtnForm: "✍️ Otwórz formularz feedbacku",
  feedbackBtnVoice: "🎤 Wyślij głosówkę zamiast tego",
  attendanceAsk: "Zanim zapytam, jak było — spotkaliście się wczoraj? 🙂",
  attendanceAskLikelyMet:
    "Wygląda na to, że wczoraj się udało 🙂 Dla pewności: spotkaliście się?",
  attendanceAskLikelyNotMet:
    "Wygląda na to, że wczoraj nie wyszło. Dobrze rozumiem — nie spotkaliście się?",
  attendanceBtnYes: "Tak, spotkaliśmy się",
  attendanceBtnNo: "Nie, nie doszło do spotkania",
  attendanceNoIntro: "Szkoda, że nie wyszło. Co się stało?",
  attendanceOutcomePartner: "Druga osoba nie przyszła",
  attendanceOutcomeSelf: "Z mojej strony nie wyszło",
  attendanceOutcomeBoth: "Umówiliśmy się na inny raz",
  attendanceOutcomeOther: "Coś innego",
  attendanceNoThanks: "Dzięki za odpowiedź — zanotowałem. Szkoda, że tak wyszło.",
  attendanceAlreadyAnswered: "Już zanotowałem, dzięki ✨",
  attendancePushTitle: "Spotkaliście się?",
  attendancePushBody: "Jedno tapnięcie i będę wiedział, czy pytać, jak było.",
  feedbackVoiceAsk:
    "Po prostu nagraj wiadomość głosową 🎙️\n\n" +
    "Opowiedz, jak poszła randka - była chemia? Co Ci się podobało? " +
    "Co nie zadziałało? Minuta wystarczy.",
  feedbackThanks: "Dzięki! Uwzględnię to przy następnym doborze ✨",
  feedbackAlreadySubmitted: "Już opowiedziałeś(-aś), jak poszła ta randka — dzięki, zapisane ✨",
  feedbackPushTitle: "Jak poszła randka?",
  feedbackPushBody: "Minuta twojego czasu, a następne dopasowanie będzie trafniejsze.",
  matchDropPushTitle: "Twój match już jest",
  matchDropPushBody: "Kliknij, aby zobaczyć ✨",
  reportBtn: "🚨 Zgłoś",
  reportAsk: "To zgłoszenie jest prywatne. Co najlepiej opisuje problem?",
  reportCategoryFakePhotos: "Fałszywe albo mylące zdjęcia",
  reportCategoryWrongPerson: "Inna osoba na zdjęciu",
  reportCategoryOffensive: "Niegrzeczność lub dziwne zachowanie",
  reportCategoryUnsafe: "Było niebezpiecznie",
  reportCategorySpam: "Spam albo oszustwo",
  reportCategoryInappropriate: "Nieodpowiedni profil",
  reportCategoryOther: "Inne",
  reportDetailAsk: "Coś jeszcze, co pomoże szybciej to sprawdzić? Możesz napisać, wysłać głosówkę albo pominąć.",
  reportDetailAskOther: "Opisz krótko, co się stało. Możesz napisać albo wysłać głosówkę.",
  reportSkipBtn: "Pomiń",
  reportThanksT1: "Jasne - użyjemy tego, żeby lepiej stroić przyszłe dopasowania 🎯",
  reportThanksT2: "Zgłoszone. Dzięki - zajmiemy się tym.",
  reportThanksT3:
    "Zgłoszenie przyjęte. Konto tej osoby jest zamrożone do czasu weryfikacji. Dzięki za sygnał.",
  reportFailed: "Nie udało się teraz obsłużyć zgłoszenia. Spróbuj za minutę.",
  reportDuplicate: "To dopasowanie zostało już zgłoszone.",
  reportBackBtn: "← Wróć",
  reportCancelled: "Okej — zgłoszenie nie zostało wysłane.",
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
    "*Randka za 90 minut — {location_name}*\n\n📍 *Trzymaj się planu.* Wybraliśmy dla was bezpieczne publiczne miejsce. Nie zgadzaj się na przeniesienie spotkania w ustronne miejsce ani na wizytę u kogoś.\n🚗 *Transport.* Dojedź i wróć samodzielnie — komunikacją, taksówką albo pieszo. Nie wsiadaj do auta z osobą, której prawie nie znasz.\n📱 *Powiedz bliskim.* Prześlij szczegóły spotkania przyjaciółce albo komuś bliskiemu i jeśli możesz, udostępnij lokalizację na wieczór.\n🛑 *Twoje granice.* Jeśli czujesz dyskomfort albo zachowanie drugiej osoby wydaje się dziwne, możesz po prostu wstać i wyjść w każdej chwili. Twoje bezpieczeństwo jest ważniejsze niż uprzejmość.\n\nDobrego wieczoru ✨",
  safetyBriefPushTitle: "Zanim wyjdziesz",
  safetyBriefPushBody: "Twoja lista bezpieczeństwa na dziś jest już w aplikacji.",
  noMatchPushTitle: "Tym razem bez matcha",
  noMatchPushBody: "Na razie nie znalazł się nikt odpowiedni. Poszukiwania trwają.",
  matchNudgePushTitle: "Twój match wciąż czeka",
  matchNudgePushBody: "Tak lub nie — obie opcje są w porządku. Okno jest wciąż otwarte.",
  planningNudgePushTitle: "Randce wciąż brakuje godziny",
  planningNudgePushBody: "Zajrzyj do kalendarza, gdy będziesz mieć chwilę.",
  deadlineNudgePushTitle: "Okno się zamyka",
  deadlineNudgePushBody: "Zostało około {hours} godz. na odpowiedź. Tak lub nie — obie opcje są w porządku.",
  statusDaysHours: "⏳ Następne dopasowanie za {d}d {h}h",
  statusHoursMinutes: "⏳ Dopasowania wlecą za {h}h {m}min",
  statusMinutes: "✨ Prawie gotowe! Dopasowania wlecą za {m} min",
  statusProcessing: "✨ Analizujemy Twoje miasto... Zajrzyj trochę później.",
  statusBannerSchedule: "Następny dobór: {date}, {time}",
  statusBannerActive: "Już szukamy Twojej osoby ✦",
  statusBannerSearching:
    "Szukam Twojej osoby — sprawdzam każdego wieczoru.\n" +
    "Gdy tylko pojawi się ktoś naprawdę wart Twojego czasu, odezwę się.",
  statusButtonDaysHours: "Do doboru: {d}d {h}h",
  statusButtonHoursMinutes: "Do doboru: {h}h {m}min",
  statusButtonMinutes: "✨ Do doboru: {m}min",
  statusButtonProcessing: "✨ Dobieramy dopasowania",

  // --- Stage-aware banner (PRODUCT_SPEC §2.1) ---
  statusBannerDecision:
    "Zostało na odpowiedź:\n\n" +
    "Twój match czeka. Odpowiedz tak lub nie tutaj, na czacie.",
  statusBannerPlanning:
    "Randka jest planowana ✦\n\n" +
    "Szczegóły są jeszcze ustalane — wszystko o niej jest w Mojej randce.",
  statusBannerDate: "Do randki:",
  statusTimeDaysHours: "{d}d {h}h",
  statusTimeHoursMinutes: "{h}h {m}min",
  statusTimeMinutes: "{m}min",
  statusButtonDateOpen: "Szczegóły",

  // --- Kyiv-only market gate (PRODUCT_SPEC §1.1) ---
  statusBannerMarketPending:
    "Na razie Gennety działa tylko w Kijowie — w mieście {city} jeszcze nie wystartowaliśmy, więc nie ma tu kogo Ci dopasować.\n\nChcesz chodzić na randki w Kijowie? Zmień miasto w menu.",
  statusButtonMenu: "Otwórz menu",
  menuCitySwitch: "📍 Zmień miasto na Kijów",
  citySwitchCard:
    "📍 *Twoje miasto: {city}*\n\nNa razie Gennety działa tylko w Kijowie. Dopasowania zawsze są w obrębie jednego miasta, więc dopóki nie wystartujemy w mieście {city}, nie ma tu kogo Ci przedstawić.\n\nJeśli chcesz chodzić na randki w Kijowie — przełącz się. Profil, zdjęcia i weryfikacja zostaną bez zmian, a Ty trafisz do najbliższego doboru.",
  citySwitchConfirm: "📍 Tak, szukajcie mi pary w Kijowie",
  citySwitchDone:
    "Gotowe — Twoje miasto dopasowań to teraz Kijów 🤍\n\nJesteś w najbliższym doborze: {date}.",
  citySwitchFailed: "Nie udało się teraz zmienić miasta. Spróbuj ponownie za chwilę.",
  noMatchCityNotLaunched:
    "*W mieście {city} Gennety jeszcze nie ma*\n\nNa razie działamy tylko w Kijowie, a dopasowania zawsze są w obrębie jednego miasta — więc nie mam ci tu jeszcze kogo przedstawić. Profil zostaje bez zmian, a odezwiemy się, gdy tylko otworzymy twoje miasto.\n\nJeśli chcesz chodzić na randki w Kijowie — przełącz się poniżej i trafisz do najbliższego doboru.",
  noMatchCitySwitchBtn: "📍 Przejdź na Kijów",

  // --- My date (menu row + hub) + scheduled-date banner ---
  statusDateDaysHours: "💫 Randka za {d}d {h}h",
  statusDateHoursMinutes: "💫 Randka za {h}h {m}min",
  statusDateMinutes: "💫 Randka za {m} min",
  statusDateSoon: "💫 Randka dzisiaj",
  menuMyDateDays: "💫 Moja randka · za {d}d {h}h",
  menuMyDateHours: "💫 Moja randka · za {h}h {m}min",
  menuMyDateMinutes: "💫 Moja randka · za {m} min",
  menuMyDateSoon: "💫 Moja randka · dzisiaj",
  menuMyDatePlanning: "⏳ Randka jest planowana",
  dateHubNoActive: "Nie masz teraz zaplanowanej randki.",
  dateHubHeaderScheduled: "💫 Twoja randka z {name}",
  dateHubPlanningProposed:
    "Masz dopasowanie z {name}. Sprawdź ofertę powyżej — i po prostu daj znać, czy chcesz iść.",
  dateHubPlanningNegotiating: "Masz dopasowanie z {name}! Wybierz pasujący czas:",
  dateHubPlanningVenue:
    "Prawie gotowe z {name}. Zaznacz, skąd będziesz wyruszać:",
  voiceTranscriptionFailed: "Nie dosłyszałem — możesz napisać tekstem?",
  voiceTooLong: "Ta głosówka jest trochę długa. Do 5 minut albo po prostu napisz tekst.",
  rateLimitFloodNotice:
    "Oho, sporo wiadomości naraz — daj mi kilka sekund, potem ruszamy dalej. 🙂",
  rateLimitDailyBudgetNotice: "Dużo dziś piszesz 🙂 Kontynuujmy jutro — na dziś limit.",

  // --- Live Photo admission ---
  livePhotoMissingStatic:
    "W tym Live Photo brakuje klatki zdjęcia, więc nie mogę go sprawdzić. Wyślij zwykłe zdjęcie albo inne Live Photo.",
  livePhotoTooLong:
    "Live Photo może mieć najwyżej 10 sekund. Wyślij krótsze albo zwykłe zdjęcie.",
  livePhotoTooLarge:
    "Live Photo może ważyć najwyżej 10 MB. Wyślij mniejsze albo zwykłe zdjęcie.",

  // --- Date Ticket DMs ---
  // Phrased around the gendered past tense: passive ("jest opłacony") and
  // grammatical agreement with the noun ("druga strona nie odebrała") keep these
  // correct for any user/partner gender without slash-forms.
  ticketBothSecuredDm: "Oba bilety są 🎟️ Randka aktualna — zostaje termin.",
  ticketPartnerPaidDm:
    "Twój bilet jest już opłacony przez {name} ❤️ Nic nie płacisz.",
  ticketCoveredHerConfirm:
    "💛 Gotowe — bilet dla {name} opłacony. Dam znać, gdy tylko go zobaczy.",
  ticketPartnerSawItDm: "❤️ {name} już wie, że bilet jest od Ciebie.",
  ticketRefundedDm: "Twój bilet wrócił do portfela, a randka jest aktualna. Wybierzmy termin 📅",
  ticketRefundedToWallet:
    "🎟️ Twój bilet wrócił do portfela — wykorzystasz go na następnej randce.",
  ticketRefundedToWalletBoth:
    "🎟️ Oba bilety, które opłaciłeś, wróciły do twojego portfela — wykorzystasz je na następnej randce.",

  // --- Pre-date coordination ---
  coordProxyOpenedEnterPrompt:
    "Anonimowy czat jest otwarty 🕶\n\n" +
    "Wiadomości idą przeze mnie, kontakty zostają prywatne. Przyda się, żeby się znaleźć albo dać znać o spóźnieniu. Zamyka się parę godzin po randce.",
  coordEnterBtn: "💬 Wejdź na czat",
  coordExitBtn: "❌ Opuść czat",
  coordReportBtn: "🚨 Zgłoś",
  coordChatEntered:
    "Jesteś na anonimowym czacie 🕶 Pisz normalnie — przekażę dalej. Możesz wyjść w każdej chwili.",
  coordChatExited: "Czat zamknięty. /menu wraca do menu.",
  coordProxyRelayPrefix: "💬 Twój match: ",
  coordProxyPushTitle: "Twój match",
  coordProxyTextOnly:
    "Tu przechodzą tylko wiadomości tekstowe — zdjęć i głosówek nie przekazuję.",
  coordProxyClosed:
    "Anonimowy czat zamknięty. Mam nadzieję, że randka wyszła — odezwę się jutro ✨",
  coordProxyUnavailable: "Ten anonimowy czat nie jest już dostępny.",
  coordCardProxyKicker: "ANONIMOWY CZAT",
  coordCardProxyHead1: "Linia",
  coordCardProxyHead2: "otwarta.",
  coordCardProxySub: "Wiadomości idą przeze mnie. Kontakty pozostają ukryte.",
  menuPremium: "✨ Gennety Premium",
  menuPremiumActive: "✨ Premium · do {date}",
  menuInviteFriend: "🎁 Zaproś znajomego",
  referralHubTitle: "Zapraszaj znajomych do Gennety",
  referralHubTagline:
    "Za każdego znajomego, który przejdzie weryfikację przez twój link, dostajesz bilet na randkę 🎟 — a on też.",
  referralShareButton: "📤 Zaproś znajomego",
  referralShareCaption: "Gennety dobiera najlepszą parę i sam organizuje spotkanie.",
  referralShareJoin: "Dołącz do Gennety 💫",
  hdyhauQuestion: "I ostatnie — skąd o nas wiesz?",
  hdyhauFriendInPerson: "Znajomy powiedział mi osobiście",
  hdyhauFriendOnline: "Znajomy przysłał mi link",
  hdyhauSocialMedia: "Media społecznościowe",
  hdyhauSearch: "Przez wyszukiwarkę",
  hdyhauAd: "Reklama",
  hdyhauEvent: "Impreza lub wydarzenie",
  hdyhauOther: "Skądinąd",
  hdyhauSkip: "Pomiń",
  hdyhauThanks: "Dzięki - to naprawdę pomaga. 💛",
  referralRewardDm:
    "{name} przeszedł(-eszła) weryfikację przez twój link.\n\nNaliczono: +{tickets} 🎟\n{next}",
  referralRewardNext: "Pozostałe nagrody za zaproszenia: {remaining}.",
  referralRewardNextMax: "To była twoja ostatnia nagroda za zaproszenie — dziękujemy 💛",
  referralCardInvitedBy: "Zaproszenie od {name}",
  referralCardInvitedGeneric: "Masz zaproszenie",
  referralCardHeadA: "Prawdziwe randki.",
  referralCardHeadB: "Zero pisania.",
  referralCardSupport:
    "Gennety dobiera parę według głębokiej zgodności i sam organizuje spotkanie na żywo.",
  referralCardGift: "{ticketsPhrase} — w prezencie",
  referralCardFooter: "gennety.com",
  premiumHubTitle: "✨ Gennety Premium",
  premiumHubBody:
    "*Gennety Premium*\n\n• *Nielimitowane randki* — twój bilet jest pokryty za każdym razem, niezależnie od liczby randek\n• *Każda wieczorna godzina* — późne sloty w kalendarzu są dla ciebie otwarte\n• *Najlepsze lokale* — wybór miejsc o poziom wyżej\n• *Darmowa zmiana miejsca* — do dwóch razy na randkę, bez opłat",
  premiumHubActiveNote: "Masz Premium ✨ Aktywne do {date}.",
  premiumOpenCta: "Dowiedz się więcej",
  premiumCancelHint:
    "Możesz anulować w każdej chwili — po prostu napisz do mnie, a anuluję po Twoim potwierdzeniu.",
  premiumManageNote: "Zarządzaj lub anuluj w Telegram → Ustawienia → Subskrypcje.",
  premiumWelcomeDm:
    "Witaj w Gennety Premium ✨\n\nTwoje randki są od teraz pokryte — bilet niepotrzebny. Każda wieczorna godzina w kalendarzu jest dla ciebie otwarta, zmiany miejsca na nasz koszt, miejsca premium odblokowane. Aktywne do {date}.",
  premiumExpiring3d:
    "Twoje Gennety Premium kończy się {date} — za trzy dni.\n\nTen plan nie odnawia się sam, więc pokryte randki, darmowe zmiany miejsca i miejsca premium przestaną działać tego dnia. Wybierz kolejny okres: miesiąc albo 3 / 6 miesięcy taniej.",
  premiumExpiring1d:
    "Ostatni dzień twojego Gennety Premium — kończy się {date}.\n\nPotem randka znów kosztuje bilet, a miejsca premium się zamykają. Jedno tapnięcie wybiera kolejny okres: miesiąc albo 3 / 6 miesięcy taniej.",
  premiumExpiringCta: "Wybierz plan",
  // Stars top-up warning for a RECURRING subscriber (§3.8). Distinct from
  // premiumExpiring* above: nothing is ending here — the charge is coming,
  // and it fails on an empty balance. `{amount}` is premiumRenewalAmount or
  // an empty string, so the sentence has to read correctly BOTH ways.
  premiumRenewal3d:
    "Za trzy dni, {date}, Telegram odnowi twoje Gennety Premium.{amount}\n\nOpłata schodzi w gwiazdkach z salda Telegrama — z karty Telegram nie pobierze. Jeśli tego dnia gwiazdek zabraknie, odnowienie się nie uda i Premium się zatrzyma, więc lepiej doładować wcześniej: Ustawienia → Moje gwiazdki.",
  premiumRenewal1d:
    "Jutro, {date}, Telegram odnowi twoje Gennety Premium.{amount}\n\nOpłata schodzi w gwiazdkach z salda Telegrama i nie ma zapasowej karty — jeśli jutro zabraknie gwiazdek, odnowienie się nie uda i Premium się zatrzyma. Doładowanie to chwila: Ustawienia → Moje gwiazdki.",
  premiumRenewalAmount: " Koszt: {stars} ⭐.",
  premiumPlanMonthly: "1 miesiąc",
  premiumPlan3Months: "3 miesiące",
  premiumPlan6Months: "6 miesięcy",
  premiumPlanSaveBadge: "−{pct}%",
  premiumPlanPerMonth: "{price}/mies.",
  premiumPackageWelcomeDm:
    "Gennety Premium jest twoje na {months} mies. ✨\n\nRandki pokryte, zmiany miejsca za darmo, miejsca premium odblokowane — do {date}. Ten plan nie odnawia się sam, więc przypomnę zawczasu.",
  premiumInvoiceTitle: "Gennety Premium",
  premiumInvoiceDesc:
    "Miesięczna subskrypcja — darmowe zmiany miejsca + miejsca premium. Odnawia się co 30 dni; anulujesz kiedy chcesz.",
  premiumInvoiceLabel: "Gennety Premium — 1 miesiąc",
  premiumCheckoutError: "Nie udało się rozpocząć subskrypcji. Spróbuj za chwilę.",
  premiumCancelConfirm:
    "Anulować Gennety Premium?\n\nPremium pozostanie aktywne do {date} — do tego czasu wszystko działa. Później nie odnowi się i nic więcej nie zostanie pobrane.",
  premiumCancelConfirmYes: "Tak, anuluj",
  premiumCancelKeepBtn: "Zostaw Premium",
  premiumCancelFinalConfirm:
    "Ostatnie sprawdzenie — na pewno anulować Gennety Premium?\n\nPremium pozostanie aktywne do {date}, do tego czasu nic się nie zmieni. Po potwierdzeniu automatyczne odnawianie zostanie wyłączone na stałe — jeśli zechcesz wrócić do Premium później, zapłacisz ponownie.",
  premiumCancelFinalYes: "Tak, anuluj",
  premiumCancelFinalNoSoft: "Nie, zostaw",
  premiumCancelFinalNoHard: "Nie, zostaw",
  premiumCancelDone:
    "Gotowe — automatyczne odnawianie wyłączone. Premium jest aktywne do {date}, nic więcej nie zostanie pobrane. Możesz wrócić w każdej chwili.",
  premiumCancelKept: "Zostaje ✨ Premium jest aktywne do {date}.",
  premiumCancelAppStore:
    "Ta subskrypcja została kupiona przez App Store, więc można ją anulować tylko na iPhonie: Ustawienia → [twoje imię] → Subskrypcje → Gennety Premium → Anuluj. Dostęp pozostanie do {date}.",
  premiumCancelNotActive: "Nie masz teraz aktywnej subskrypcji Premium.",
  premiumCancelReasonAsk:
    "Dzięki za czas z nami 🤍 Jeśli możesz — napisz w dwóch słowach, czemu rezygnujesz? To naprawdę pomaga nam być lepszymi.",
  premiumCancelReasonSkipBtn: "Wolę nie mówić",
  premiumCancelReasonThanks: "Dziękujemy, zapiszemy 🤍 Premium zawsze można przywrócić.",

  // --- Rematch ---
  rematchOfferFamine:
    "Tym razem nie było pary — to nie twoja wina.\n\nMogę poszukać jeszcze raz od razu: {price}. Jeśli nikogo nie znajdę — oddam gwiazdki.",
  rematchOfferFailed:
    "Nie wyszło. Zdarza się.\n\n" +
    "Mogę pójść na drugie podejście teraz i znaleźć ci nową osobę — {price}.\n\n" +
    "To nowe poznanie, nie gwarancja randki. Jeśli nikogo nie znajdę — gwiazdki wracają od razu.",
  rematchOfferNeutral:
    "Chcesz, żebym poszukał jeszcze raz, teraz? Jedna nowa osoba, ten sam dobór: {price}.\n\n" +
    "To nowe poznanie, nie gwarancja randki. Jeśli nikogo nie znajdę — gwiazdki wracają od razu.",
  rematchOfferBtn: "Szukaj jeszcze raz — {price}",
  statusButtonRematch: "Szukaj teraz",
  rematchInvoiceTitle: "Nowe wyszukiwanie",
  rematchInvoiceDesc: "Jeszcze jedno wyszukiwanie, od razu — nowa osoba od Gennety.",
  rematchInvoiceLabel: "Nowe wyszukiwanie",
  rematchFound: "Mam kogoś. Zaraz wysyłam szczegóły ✨",
  rematchNoCandidate:
    "Sprawdziłem — w twoim mieście nie ma teraz nikogo nowego. Gwiazdki wróciły. W kolejnej rundzie zostajesz.",
  rematchRefundPending:
    "Nie znalazłem nikogo nowego, a zwrot za pierwszym razem nie przeszedł. Zajmuję się tym — gwiazdki wrócą niedługo.",
  rematchUndelivered:
    "Znalazłem kogoś, ale nie udało mi się dostarczyć profilu — to po naszej stronie. Gwiazdki wróciły, a próba się nie liczy.",
  rematchUndeliveredPending:
    "Znalazłem kogoś, ale nie udało mi się dostarczyć profilu, a zwrot za pierwszym razem nie przeszedł. Zajmuję się tym — gwiazdki wrócą niedługo.",
  rematchRefunded: "Gwiazdki za nowe wyszukiwanie wróciły ✨",
  rematchLimitReached:
    "Dodatkowe wyszukiwania na razie się skończyły. Następne otworzy się za kilka dni — zwykły dobór i tak będzie.",
  rematchUnavailable:
    "Teraz nie da się uruchomić nowego wyszukiwania. Jeśli masz match w toku — najpierw go dokończ.",
  rematchGiftFamine:
    "Mówiłem, że na razie nie ma dla ciebie pary. Szukałem dalej — i znalazłem kogoś, na kogo warto spojrzeć.",
  rematchGiftFailed:
    "Ostatnio nie wyszło. Wróciłem do szukania i znalazłem kogoś, kto pasuje ci bardziej.",
  rematchGiftNeutral:
    "Szukałem dalej — i jest ktoś, kogo chcę ci pokazać.",
  rematchSearchStep1: "🔍 Włączam głębokie wyszukiwanie",
  rematchSearchStep2: "Sprawdzam, kto jest teraz wolny w twoim mieście",
  rematchSearchStep3: "Porównuję charakter i zainteresowania",
  rematchSearchStep4: "✨ Już prawie — wybieram jedną osobę",
  rematchCardOverline: "TWÓJ MATCHMAKER",
  rematchCardHeadline: "NOWE\nPODEJŚCIE",
  rematchCardSubline: "Nowa osoba, ten sam dobór.",
};

const translationsByLanguage: Record<Language, TranslationTable> = {
  en: translations.en,
  ru: translations.ru,
  uk: translations.uk,
  de: deTranslations,
  pl: plTranslations,
};

/** Replace `{param}` placeholders. Shared by `t()` and the variant picker. */
export function interpolate(
  text: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return text;
  let out = text;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Get a translated string, with optional placeholder replacement */
export function t(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return interpolate(translationsByLanguage[lang][key], params);
}

/** Russian/Ukrainian/Polish plural selection (1 → one, 2-4 → few, else → many),
 * mirroring the equivalent helper in `services/founder-notify.ts`. */
function slavicPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Fully declined "{count} {unit}" phrase for a number of Date Tickets.
 * `interpolate()` only does flat `{placeholder}` substitution, and Slavic/
 * Germanic plural rules ("1 date ticket" vs "3 date tickets", "1 билет" vs
 * "3 билета" vs "5 билетов") can't be expressed as a single translation string —
 * so this is computed in code and passed in as one interpolated value. Used
 * where a whole-word ticket count is shown (`referralCardGift`).
 */
export function dateTicketsPhrase(lang: Language, tickets: number): string {
  switch (lang) {
    case "de":
      return `${tickets} Date-Ticket${tickets === 1 ? "" : "s"}`;
    case "ru":
      return `${tickets} ${slavicPlural(tickets, "билет", "билета", "билетов")} на свидание`;
    case "uk":
      return `${tickets} ${slavicPlural(tickets, "квиток", "квитки", "квитків")} на побачення`;
    case "pl":
      return `${tickets} ${slavicPlural(tickets, "bilet", "bilety", "biletów")} na randkę`;
    default:
      return `${tickets} date ticket${tickets === 1 ? "" : "s"}`;
  }
}

/**
 * "{count} places" for the venue-change lock-screen alert ("Anna suggests 2
 * places"), declined in code for the same reason as `dateTicketsPhrase`.
 * Polish is spelled out rather than routed through `slavicPlural`: Polish keeps
 * the singular for exactly one (21 → "21 miejsc", not "21 miejsce"), and the
 * board holds up to 21 cards plus the current venue.
 */
export function venuePlacesPhrase(lang: Language, count: number): string {
  switch (lang) {
    case "de":
      return `${count} ${count === 1 ? "Ort" : "Orte"}`;
    case "ru":
      return `${count} ${slavicPlural(count, "место", "места", "мест")}`;
    case "uk":
      return `${count} ${slavicPlural(count, "місце", "місця", "місць")}`;
    case "pl": {
      const mod10 = count % 10;
      const mod100 = count % 100;
      const form =
        count === 1
          ? "miejsce"
          : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
            ? "miejsca"
            : "miejsc";
      return `${count} ${form}`;
    }
    default:
      return `${count} place${count === 1 ? "" : "s"}`;
  }
}

/**
 * Escape Telegram Markdown v1 special characters so user-provided
 * content doesn't break `parse_mode: "Markdown"`.
 */
export function escapeMd(text: string): string {
  return text.replace(/[[_*`]/g, "\\$&");
}
