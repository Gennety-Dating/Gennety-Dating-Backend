# Profile Media Validation Implementation Plan

> **Status:** IMPLEMENTED IN CODE. AWS IAM and local ffmpeg are verified;
> rollout remains blocked until production ffmpeg is verified and real-media
> QA passes. Feature flag remains off.
> **Scope:** Telegram onboarding photos, Telegram Live Photos, Telegram profile
> video, profile-photo editing, and mobile/public photo upload.
> **Primary product rule:** every accepted photo must contain the same profile
> owner; an accepted profile video must be safe and contain sufficient,
> temporally distributed evidence of that owner without requiring the owner to
> dominate the whole video.
> **Chosen V1 architecture:** local frame extraction with `ffmpeg`, AWS
> Rekognition Image APIs, OpenAI Moderation for selected frames, and existing
> Whisper transcription for audio. No S3, SNS, SQS, Face Collection, or new AWS
> credentials are required for V1.

## 1. Goals

1. Reject exact and visually near-duplicate profile photos, including common
   re-encodes, resizes, screenshots, and minor crops where detectable.
2. Require one clear face in every static profile photo and Live Photo still.
3. Require all profile photos to depict the same person before Persona
   verification.
4. Continue using the Persona selfie as the stronger identity reference after
   verification.
5. Reject explicit or otherwise prohibited photo and video content before it
   becomes profile media.
6. Allow travel, group, party, and lifestyle videos where the profile owner is
   present but does not dominate most frames.
7. Give the user a short, specific, localized recovery message for every
   rejection.
8. Never grant the video ticket bonus until the video has passed validation.
9. Never expose credentials, raw media, biometric crops, provider payloads, or
   sensitive user data in logs, chat, Obsidian, tests, or browser-agent output.

## 2. Non-goals

- No global face database and no duplicate-account search.
- No AWS Rekognition Face Collection in V1.
- No permanent storage of extracted video frames or face crops.
- No automatic editing, blurring, or partial publication of rejected videos.
- No requirement that the owner appear in every frame or in 70% of frames.
- No S3/Rekognition Video asynchronous pipeline in V1.
- No changes to Persona liveness or the 90-day verified-selfie retention rule.

## 3. Product decisions

### 3.1 Photo policy

An accepted photo must:

- be a decodable supported image;
- pass image moderation;
- contain exactly one sufficiently visible face;
- not be an exact or near duplicate of an accepted profile photo;
- match the onboarding identity reference or Persona selfie.

The first accepted onboarding photo becomes the temporary identity reference.
The onboarding copy must explicitly ask for a clear, mostly frontal first
photo. Later photos are compared against the best available reference:

1. Persona verified selfie, when retained and available;
2. otherwise the first accepted onboarding photo;
3. optionally a second high-quality accepted photo when the first comparison is
   borderline.

Passing this pre-Persona comparison only proves that the profile photos contain
the same person. Persona later proves that the person is the account owner.

### 3.2 Video policy

Video acceptance has two independent gates:

```text
SAFE_CONTENT && OWNER_PRESENCE_EVIDENCE
```

The owner does not need to dominate the video. Scenery-only frames do not count
against the owner. Other people are allowed.

Minimum owner evidence:

- at least 3 high-quality matched frames;
- matched frames from at least 2 distinct temporal clusters;
- clusters separated by at least `max(2 seconds, 20% of video duration)`;
- for videos longer than 20 seconds, matches must occur in at least 2 of the 3
  temporal thirds;
- at least one match must have a face large and sharp enough for a reliable
  comparison.

This accepts a travel video where the user appears in roughly 10-30% of the
useful frames while rejecting a long unrelated clip with only a one-second
selfie appended at the start or end.

Other faces:

- group scenes are allowed;
- a sampled frame counts as owner-present when any detected face matches;
- unmatched faces do not cause rejection by themselves;
- reject as `mostly_other_person` only when face-bearing samples are dominated
  by a recurring non-owner subject and the owner barely meets or fails the
  distributed-evidence rule;
- do not apply this rule to scenery or object-only frames.

### 3.3 Moderation policy

Hard reject:

- explicit sexual activity;
- explicit nudity or exposed intimate parts;
- sexual content involving or plausibly involving minors;
- graphic violence or other content prohibited by the profile-media policy.

Do not automatically reject solely for:

- ordinary swimwear;
- beach or pool scenes;
- non-explicit kissing;
- sports clothing;
- travel footage;
- group parties without prohibited content.

Borderline suggestive results are evaluated with both AWS and OpenAI signals.
Provider disagreement or low-confidence ambiguity returns a retry/review-style
message, never an accusation.

### 3.4 Infrastructure failure policy

- Production validation fails closed: unvalidated media is not published.
- The user is told that processing is temporarily unavailable and can retry.
- Local development and CI may use an explicit disabled/test provider mode.
- A missing API key or disabled AWS provider must never silently approve media
  when production validation is enabled.

## 4. V1 validation pipeline

### 4.1 Shared image pipeline

Run gates cheap-first and reuse one downloaded buffer:

1. Validate declared size and sniff the real MIME type.
2. Decode through `ffmpeg`; reject corrupt or unsupported media.
3. Calculate SHA-256 for exact duplicate detection.
4. Calculate a 64-bit perceptual difference hash from a normalized grayscale
   frame produced by `ffmpeg`.
5. Compare hashes against all existing profile photos, maximum six:
   - exact SHA match: reject `duplicate_exact`;
   - low perceptual Hamming distance: reject `duplicate_near`;
   - ambiguous band: ask the OpenAI vision classifier whether this is the same
     underlying photograph after crop, resize, screenshot, or re-encoding.
6. Run OpenAI image moderation.
7. Run AWS `DetectModerationLabels`.
8. Run AWS `DetectFaces` and require exactly one usable face.
9. Run identity comparison with AWS `CompareFaces`.
10. Persist only after every required gate passes.

The initial dHash thresholds must be calibrated with fixtures rather than
treated as permanent product constants. Start evaluation around:

- Hamming distance `0..5`: near duplicate;
- `6..12`: ambiguous, use the pairwise classifier;
- above `12`: likely distinct.

### 4.2 Video pipeline

1. Reject videos over 60 seconds.
2. For the standard Telegram Bot API, reject videos over 20 MB because
   `getFile` cannot download larger files for validation.
3. Send one localized, self-replacing "Checking your video..." status message.
4. Download the video to a unique temporary directory with restrictive
   permissions.
5. Use `ffprobe` to verify container, codec, duration, dimensions, and stream
   metadata.
6. Use `ffmpeg` through `spawn`/`execFile`, never shell interpolation.
7. Extract:
   - uniformly spaced frames;
   - scene-change frames;
   - a hard maximum of 24 analysis frames;
   - normalized JPEG frames small enough for provider APIs.
8. Moderate all sampled frames with bounded concurrency:
   - AWS `DetectModerationLabels` as the primary image signal;
   - OpenAI Moderation as an independent signal.
9. Detect faces in sampled frames with AWS `DetectFaces`.
10. For every usable face-bearing frame, compare all detected candidate faces
    against the identity reference and keep the best owner match.
11. Apply the distributed owner-evidence rule from section 3.2.
12. Extract audio, when present, to the existing Whisper-compatible format.
13. Transcribe with the existing Whisper service and moderate the text with
    OpenAI Moderation.
14. Delete temporary video, audio, frames, and crops in `finally`, on timeout,
    and on every rejection path.
15. Persist the video and grant the one-time ticket only after approval.

Default processing limits:

```text
download timeout:        20 seconds
ffprobe timeout:         10 seconds
ffmpeg extraction:       30 seconds
provider concurrency:    4
maximum sampled frames:  24
whole validation budget: 60 seconds
```

These are implementation defaults and must be measured in dev QA before
production rollout.

## 5. User experience

### 5.1 Copy before upload

The photo-stage introduction in all five languages must communicate:

- upload 2-6 different photos;
- the first photo should clearly show the user's face;
- every photo must show the same person;
- a short profile video may include friends or scenery, but the user's face
  must be clearly visible in several moments;
- explicit content is not allowed.

### 5.2 Result codes and user messages

The validation service returns stable reason codes. Handlers map them to shared
i18n and never expose raw provider labels or confidence scores.

| Code | User-facing meaning |
|---|---|
| `duplicate_exact` | This exact photo is already present. |
| `duplicate_near` | This appears to be the same photo after editing or re-upload. |
| `unsafe_content` | This media contains a segment that cannot be published. |
| `no_face` | No sufficiently clear face was found. |
| `multiple_faces_photo` | A profile photo must contain only the user. |
| `identity_mismatch` | The face does not match the other profile photos. |
| `identity_uncertain` | Lighting, size, or angle prevents a reliable comparison. |
| `video_owner_missing` | The user's face was not found clearly enough. |
| `video_owner_too_brief` | The face appears too briefly or in only one moment. |
| `video_mostly_other_person` | The clip primarily presents another person. |
| `video_too_large_to_check` | The bot cannot safely process this file size. |
| `processing_unavailable` | Temporary provider or processing failure; retry. |

For ambiguous identity, ask for a clearer replacement rather than claiming
fraud. For unsafe content, do not quote the exact explicit label unless product
or legal policy later requires it.

### 5.3 Progress behavior

- Photos continue using the existing burst accumulator and one response per
  album/burst.
- Add rejection counters by reason so a mixed album receives one concise
  summary.
- Video validation shows an editable status message and removes/replaces it
  with the final result.
- A rejected video never replaces an existing valid profile video.
- A replacement video is committed atomically only after validation.

## 6. Code design

### 6.1 New services

Recommended modules:

```text
apps/bot/src/services/profile-media-validation/
  types.ts
  image-fingerprint.ts
  image-moderation.ts
  photo-validation.ts
  video-probe.ts
  video-frames.ts
  video-validation.ts
  temp-media.ts
```

Responsibilities:

- `types.ts`: result unions, reason codes, provider-neutral evidence types.
- `image-fingerprint.ts`: SHA-256, normalized dHash, Hamming distance.
- `image-moderation.ts`: combine AWS and OpenAI moderation into policy results.
- `photo-validation.ts`: orchestration for duplicate, moderation, face count,
  and identity gates.
- `video-probe.ts`: safe `ffprobe` metadata extraction.
- `video-frames.ts`: uniform plus scene-change extraction with frame cap.
- `video-validation.ts`: moderation, owner evidence, audio moderation, policy.
- `temp-media.ts`: restrictive temp directory lifecycle and guaranteed cleanup.

### 6.2 Existing modules to change

- `services/face-match.ts`
  - add provider-neutral wrappers for `DetectFaces` and
    `DetectModerationLabels`;
  - preserve existing `CompareFaces` contract and verification behavior.
- `services/vision/validate-face.ts`
  - retain compatibility initially;
  - migrate callers to the structured buffer-based validator;
  - remove the production fail-open path after all callers migrate.
- `services/storage.ts`
  - download Telegram media once and reuse the buffer;
  - enforce byte ceilings while streaming/downloading where possible.
- `handlers/onboarding/conversational.ts`
  - apply the new photo pipeline;
  - validate video before persistence/reward;
  - extend burst summaries with stable reason counts.
- `handlers/menu/edit-profile.ts`
  - use the same photo validator;
  - compare against existing persisted photos across editing sessions.
- `public/routes/me.ts`
  - use the same photo validator for mobile uploads;
  - return stable machine-readable error codes.
- `services/telegram-profile-media.ts`
  - change Telegram-processable video limit to 20 MB;
  - preserve 60-second duration limit.
- `packages/shared/src/i18n.ts`
  - add all reason-code messages in `en`, `ru`, `uk`, `de`, and `pl`.
- `packages/shared/src/profile-media.ts`
  - add optional non-sensitive validation metadata to video media:
    `validationVersion` and `validatedAt`;
  - do not store extracted faces, frame images, transcripts, or provider
    request payloads.
- `packages/shared/src/constants.ts`
  - shared video/frame limits and validation-version constant.

### 6.3 No Prisma migration for V1

V1 recomputes fingerprints from the maximum six existing photos during upload.
This avoids new biometric/hash columns and schema rollout risk. The profile
media JSON can carry only approval metadata.

If production measurements show repeated downloads are too expensive, propose a
separate reviewed schema change for persistent non-reversible image hashes.

### 6.4 Feature flags and non-secret config

Add:

```dotenv
PROFILE_MEDIA_VALIDATION_ENABLED=false
PROFILE_MEDIA_VALIDATION_FAIL_OPEN=false
PROFILE_VIDEO_MAX_ANALYSIS_FRAMES=24
PROFILE_VIDEO_VALIDATION_TIMEOUT_MS=60000
```

Rules:

- flag defaults off for rollout;
- production fail-open remains false;
- local tests inject providers and do not require real credentials;
- no new secret environment variable is required for V1.

## 7. AWS permissions and browser-agent handoff

### 7.1 Required V1 IAM actions

The existing IAM user `gennety-bot-rekognition` should have only:

```json
[
  "rekognition:CompareFaces",
  "rekognition:DetectFaces",
  "rekognition:DetectModerationLabels"
]
```

Do not attach broad policies such as `AmazonRekognitionFullAccess`,
`AmazonS3FullAccess`, or administrator access.

### 7.2 Browser-agent prompt: audit and update IAM

Use this prompt when the implementation reaches the real-provider integration
gate:

```text
Open the AWS Management Console using the already authenticated browser session.

Goal:
Safely inspect and, only if necessary, update the permissions of the existing
IAM user named "gennety-bot-rekognition" for Gennety Dating V1 profile-media
validation.

Required permissions:
- rekognition:CompareFaces
- rekognition:DetectFaces
- rekognition:DetectModerationLabels

Security constraints:
1. Do not create or rotate access keys.
2. Do not open, reveal, copy, transcribe, screenshot, or return any Access Key
   ID, Secret Access Key, account ID, sign-in URL, session token, ARN containing
   the account number, billing data, or unrelated resource names.
3. Do not attach AdministratorAccess, AmazonRekognitionFullAccess, or any broad
   S3/SNS/SQS policy.
4. Keep the policy resource scope at "*" only because these three Rekognition
   image actions do not support useful per-resource scoping.
5. Do not change any other IAM user, role, group, policy, or credential.
6. Before clicking the final Save/Create/Apply button, summarize the exact
   action names and ask for confirmation if the interface shows any permission
   beyond the three listed actions.

Preferred result:
- Reuse or create one narrowly named inline policy such as
  "GennetyProfileMediaValidationV1".
- Policy effect Allow, action list exactly the three required actions,
  resource "*".

Return only this redacted summary:
- IAM user found: yes/no
- CompareFaces allowed: yes/no
- DetectFaces allowed: yes/no
- DetectModerationLabels allowed: yes/no
- Change applied: yes/no
- Unexpected permissions encountered: yes/no, with action names only

Never include credentials, account identifiers, ARNs, screenshots, or policy
documents containing identifiers in the response.
```

### 7.3 Credential handling

Expected path: no credential work. The existing values remain in `.env` and
`.env.local`.

Before real-provider QA, Codex should verify presence without printing values:

```sh
node -e '
for (const k of ["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"]) {
  const v = process.env[k] ?? "";
  console.log(`${k}: ${v.length > 0 ? "present" : "missing"}`);
}'
```

Use the repository's normal dotenv loading when implementing the actual
preflight script. Never use `cat .env`, `env`, `printenv`, shell tracing, or a
command that prints secret values.

### 7.4 Emergency-only browser-agent prompt: create replacement key

Use only if the existing key is confirmed absent, revoked, or unusable and the
user explicitly approves rotation:

```text
Open AWS IAM in the already authenticated browser session and navigate only to
the existing IAM user "gennety-bot-rekognition".

Goal:
Create one replacement programmatic access key only after confirming that the
user has explicitly approved credential rotation.

Security constraints:
1. Do not delete or deactivate the old key yet.
2. Do not reveal, read aloud, copy into chat, transcribe, screenshot, download
   into the repository, or include the Access Key ID or Secret Access Key in
   your response.
3. Stop on the one-time credentials screen. Tell the human user to copy the two
   values directly into the local secret files. Do not interact with the code
   editor or terminal.
4. Return no account ID, ARN, session token, or credential fragment.
5. After the human confirms that both local and production secret files were
   updated and tested, a separate explicit task may deactivate the old key.

Return only:
- replacement key created: yes/no
- one-time credential screen open for human copy: yes/no
- old key left active: yes/no
```

### 7.5 Human credential copy procedure

Only for the emergency rotation branch:

1. Keep the AWS one-time credential screen open.
2. Open `/Users/pro/Desktop/Gennety Dating/.env.local` locally.
3. Replace only:

   ```dotenv
   AWS_ACCESS_KEY_ID=<paste directly from AWS>
   AWS_SECRET_ACCESS_KEY=<paste directly from AWS>
   ```

4. Update `/Users/pro/Desktop/Gennety Dating/.env` only when it is intentionally
   maintained as the local production-env copy.
5. Do not paste either value into Codex chat, browser-agent chat, Obsidian,
   terminal history, screenshots, or documentation.
6. Save the file and tell Codex only: `AWS credentials updated locally`.
7. Codex runs a redacted credential-presence check and a minimal AWS smoke test
   that outputs only success/failure and error class.
8. Production `/opt/gennety/.env` is updated during the documented deploy
   window through a non-echoing editor or secure file sync. Never pass secrets
   as command-line arguments.
9. After local and production tests pass, explicitly approve deactivation of
   the old key.

## 8. Local system dependency

V1 requires `ffmpeg` and `ffprobe`.

Preflight:

```sh
ffmpeg -version
ffprobe -version
```

Local installation is an operating-system action and must not modify
`package.json`. Production installation must follow `deploy.md` and be performed
before enabling the feature flag.

Browser-agent interaction is not required for `ffmpeg`; Codex can inspect and
install it through the terminal during the implementation/deploy phase when
authorized.

## 9. Implementation phases

### Phase 0: Baseline and policy fixtures

- Record focused baseline tests for onboarding, edit photos, public photo API,
  face match, Telegram media extraction, tickets, and shared i18n.
- Add synthetic/redacted fixtures:
  - exact duplicate;
  - resized/re-encoded duplicate;
  - cropped duplicate;
  - same person across different photos;
  - different people;
  - one-person, group, and no-face images;
  - safe travel/group video;
  - owner only briefly at start;
  - owner in two separated travel scenes;
  - explicit-content test fixture represented by mocked provider labels, not
    committed real explicit media.
- Keep real user photos and videos out of git.

Exit gate: existing behavior tests pass before implementation changes.

### Phase 1: Provider-neutral result model

- Add structured result unions and stable reason codes.
- Add policy combiner for AWS/OpenAI moderation.
- Add production fail-closed semantics and explicit test provider mode.
- Unit-test every policy branch.

Exit gate: no handler behavior changes yet; service tests green.

### Phase 2: Image fingerprints and photo validation

- Implement SHA-256 and `ffmpeg`-normalized dHash.
- Implement exact, near, and ambiguous duplicate flow.
- Add `DetectFaces` and `DetectModerationLabels` wrappers.
- Implement pre-Persona same-person comparison.
- Prefer Persona selfie through the existing verified-user gate.
- Refactor Telegram and mobile photo callers to pass one downloaded buffer.

Exit gate:

- duplicate variants rejected;
- genuinely different photos accepted;
- all upload surfaces share the same validator;
- no production fail-open path.

### Phase 3: Photo UX integration

- Extend album accumulator reason counts.
- Add localized messages in all five languages.
- Update initial media-stage guidance.
- Ensure bonus photo counting includes only approved photos.
- Preserve Live Photo static-frame behavior.

Exit gate: focused onboarding/edit/mobile tests and shared i18n tests green.

### Phase 4: Video extraction and moderation

- Add safe temporary-directory management.
- Add `ffprobe` metadata validation.
- Add uniform plus scene-change frame extraction.
- Enforce 20 MB Telegram analysis limit.
- Add frame moderation with bounded concurrency.
- Add audio extraction, Whisper transcription, and text moderation.

Exit gate:

- corrupt/oversized/unsafe provider-result fixtures rejected;
- temp artifacts are removed on success, rejection, timeout, and thrown errors.

### Phase 5: Video owner evidence

- Detect all faces in sampled frames.
- Compare candidate faces against Persona selfie or onboarding photo reference.
- Group matches into temporal clusters.
- Apply the distributed-evidence policy.
- Add the `mostly_other_person` safeguard conservatively and keep it separately
  tunable/disableable until QA data exists.

Exit gate:

- travel/group fixture with owner in separated scenes passes;
- scenery-only video fails owner evidence;
- one-second appended selfie fails;
- group video is not rejected merely because other people appear.

### Phase 6: Video onboarding integration

- Validate before writing `Profile.profileMedia`.
- Preserve existing valid video when replacement fails.
- Grant ticket only after approval.
- Add editable progress status.
- Add idempotency/in-flight guard for repeated upload updates.

Exit gate: handler tests cover pass, each rejection class, provider failure,
replacement behavior, and ticket idempotency.

### Phase 7: AWS browser handoff and real-provider QA

- [x] Run the browser-agent IAM prompt from section 7.2.
- [x] Verify credentials are present without printing them.
- [x] Run a redacted `DetectModerationLabels` smoke test with a synthetic PNG.
- [x] Run the local ffmpeg pipeline on a generated video with frames and audio.
- Test with approved synthetic/consenting QA media only.
- Calibrate face and moderation thresholds from false accept/reject evidence.

Exit gate: real provider calls work in dev and no secret appears in logs or
captured evidence.

### Phase 8: Documentation and rollout

- Update `PRODUCT_SPEC.md` video and photo invariants.
- Update `ARCHITECTURE.md` media-validation ownership and provider flow.
- Update `.env.example`, `.env.local.example`, `deploy.md`, `TESTING.md`, and
  `E2E_QA_PLAN.md`.
- Add Obsidian session and changelog notes; add an ADR because this changes
  media safety, biometric comparison, and core onboarding assumptions.
- Deploy with `PROFILE_MEDIA_VALIDATION_ENABLED=false`.
- Install/verify production `ffmpeg`.
- Run production configuration smoke checks.
- Enable for internal/test accounts first, then full onboarding.

Exit gate: tests/typecheck/build green, docs current, rollback verified.

## 10. Test matrix

### Photos

- exact same Telegram delivery;
- same image uploaded as document;
- resized JPEG;
- recompressed JPEG;
- screenshot with small border;
- moderate crop;
- different photo from same session/person;
- twins/lookalikes;
- glasses, hat, beard, makeup, low light, side angle;
- no face, tiny face, multiple faces;
- unsafe provider label;
- AWS down, OpenAI down, `ffmpeg` missing;
- verified selfie available/unavailable;
- Telegram, Live Photo still, edit profile, and mobile API parity.

### Videos

- owner speaking to camera;
- owner appears in 2 separated travel scenes;
- group video with owner in about 20-30% of sampled frames;
- mostly scenery with sufficient distributed owner evidence;
- scenery only;
- another person only;
- owner appears only in first second;
- owner appears only in final second;
- many group faces with owner present;
- unsafe scene at beginning/middle/end;
- safe beach/swimwear footage;
- explicit audio with safe imagery;
- no audio;
- corrupt container;
- unsupported codec;
- exactly 20 MB and just over 20 MB;
- exactly 60 seconds and just over 60 seconds;
- provider timeout and process timeout;
- replacement of existing video;
- duplicate Telegram update;
- cleanup after every result.

## 11. Observability and privacy

Allowed structured log fields:

```text
validationVersion
mediaType
resultCode
durationMs
sampledFrameCount
ownerEvidenceFrameCount
ownerEvidenceClusterCount
providerErrorClass
```

Forbidden:

- AWS/OpenAI credentials or headers;
- Telegram `file_id` or signed URLs;
- raw frame bytes or base64;
- face crops;
- transcripts;
- raw moderation payloads;
- verified selfie paths;
- user photos/videos in fixtures or Obsidian.

Metrics should distinguish user-content rejection from provider/infrastructure
failure so product tuning does not mistake outages for unsafe uploads.

## 12. Rollout and rollback

Rollout:

1. Merge with feature flag off.
2. Deploy and verify `ffmpeg`.
3. Verify IAM through the browser-agent task.
4. Enable for dev bot and consenting QA accounts.
5. Review false rejects, latency, and provider errors.
6. Enable production validation.

Rollback:

- set `PROFILE_MEDIA_VALIDATION_ENABLED=false`;
- restart PM2 with updated env;
- keep prior valid media untouched;
- do not auto-approve media that failed during the incident;
- restore the previous code only if the feature-flag rollback is insufficient.

Do not remove IAM permissions during an active rollback investigation. Remove
unused permissions only after the old code path is fully retired and verified.

## 13. Optional V2: managed AWS Rekognition Video

Adopt only when V1 latency, throughput, or moderation coverage justifies the
extra infrastructure.

V2 requires:

- private S3 bucket in the Rekognition region;
- public access blocked;
- default encryption;
- lifecycle deletion of temporary videos after one day;
- `StartContentModeration` and `GetContentModeration`;
- narrowly scoped S3 object permissions;
- polling initially, or SNS/SQS later at higher volume.

It still does not require new credentials if the existing IAM user is extended.
V2 must receive its own architecture approval because it introduces temporary
AWS video storage and changes data ownership/retention.

### Browser-agent prompt: V2 infrastructure

```text
This task is for the separately approved Gennety Dating Rekognition Video V2
rollout. Do not perform it unless the implementation plan explicitly marks V2
approved.

In AWS Console:
1. Create one private S3 bucket in the same region as Rekognition.
2. Enable Block Public Access for every option.
3. Enable default SSE-S3 encryption.
4. Add a lifecycle rule that permanently deletes temporary video objects after
   1 day.
5. Do not enable public website hosting, object ACLs, versioning, replication,
   access logging to another bucket, or KMS unless separately requested.
6. Extend only the existing "gennety-bot-rekognition" IAM user with:
   - rekognition:StartContentModeration
   - rekognition:GetContentModeration
   - s3:PutObject
   - s3:GetObject
   - s3:DeleteObject
   - s3:GetBucketLocation
7. Scope S3 object actions only to the new bucket and its temporary-media
   prefix.
8. Do not create access keys, SNS, SQS, Lambda, or a Face Collection.
9. Do not expose account IDs, ARNs, bucket names, credentials, or screenshots
   in chat. Return only redacted yes/no completion fields.

Before each final create/save action, verify that no broader permission or
public-access setting is present.
```

## 14. Definition of done

- Every photo surface enforces duplicate, safety, one-face, and same-person
  rules through one shared service.
- Video safety and owner-presence validation run before persistence.
- Travel/group videos pass without a 70% face requirement.
- Explicit media is rejected without partial publication.
- Video reward is post-validation and idempotent.
- Production does not silently fail open.
- No new AWS credentials are required in the normal path.
- Browser-agent prompts enforce least privilege and secret redaction.
- All focused tests, package typechecks, build, docs, Obsidian updates, commit,
  and push are complete.
