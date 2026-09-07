-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions" VERSION "1.11";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions" VERSION "1.3";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "plpgsql" WITH SCHEMA "pg_catalog" VERSION "1.0";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault" VERSION "0.3.1";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions" VERSION "1.1";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public" VERSION "0.8.2";

-- CreateEnum
CREATE TYPE "public"."AiMemoryExportPreference" AS ENUM ('undecided', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "public"."Gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "public"."GenderPreference" AS ENUM ('men', 'women', 'both');

-- CreateEnum
CREATE TYPE "public"."Language" AS ENUM ('en', 'ru', 'uk', 'de', 'pl');

-- CreateEnum
CREATE TYPE "public"."MatchEventActionType" AS ENUM ('PROPOSAL_SHOWN', 'ACCEPTED', 'DECLINED', 'DATE_COMPLETED', 'CHEMISTRY_POSITIVE', 'CHEMISTRY_NEGATIVE', 'EXPIRED_SILENT', 'EXPIRED_PEER_IGNORED');

-- CreateEnum
CREATE TYPE "public"."MatchRadius" AS ENUM ('campus_only', 'citywide');

-- CreateEnum
CREATE TYPE "public"."MatchStatus" AS ENUM ('proposed', 'negotiating', 'negotiating_venue', 'scheduled', 'cancelled', 'completed', 'expired');

-- CreateEnum
CREATE TYPE "public"."MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "public"."OnboardingStep" AS ENUM ('consent', 'language', 'conversational', 'completed');

-- CreateEnum
CREATE TYPE "public"."Platform" AS ENUM ('telegram', 'mobile', 'both');

-- CreateEnum
CREATE TYPE "public"."ProfilerPriority" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "public"."Theme" AS ENUM ('light', 'dark');

-- CreateEnum
CREATE TYPE "public"."ThemeMode" AS ENUM ('system', 'light', 'dark');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('onboarding', 'active', 'paused', 'frozen', 'suspended', 'pending_investigation', 'banned');

-- CreateEnum
CREATE TYPE "public"."VerificationStatus" AS ENUM ('unverified', 'pending', 'pending_review', 'verified', 'rejected');

-- CreateTable
CREATE TABLE "public"."ad_spend" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_usd_cents" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bot_sessions" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_sessions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."chat_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "surface" TEXT,
    "summary" TEXT NOT NULL,
    "actions" JSONB,
    "telegram_message_id" INTEGER,
    "match_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "media" JSONB,

    CONSTRAINT "chat_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."client_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "install_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "app_version" TEXT,
    "app_build" TEXT,
    "os_version" TEXT,
    "locale" TEXT,

    CONSTRAINT "client_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."curated_venues" (
    "id" UUID NOT NULL,
    "university_domain" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "google_maps_uri" TEXT,
    "place_id" TEXT,
    "utc_offset_minutes" INTEGER,
    "opening_hours" JSONB,
    "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "vibe_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photo_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'base',
    "city_key" TEXT,
    "editorial_summary" TEXT,
    "facet_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hard_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hours_confidence" TEXT NOT NULL DEFAULT 'unknown',
    "price_level" TEXT,
    "primary_type" TEXT,
    "rating" DOUBLE PRECISION,
    "user_rating_count" INTEGER,
    "photo_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "curated_venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."date_bump_sessions" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "user_a_shake_at" TIMESTAMP(3),
    "user_b_shake_at" TIMESTAMP(3),
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "icebreaker_deck" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "date_bump_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."email_otps" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_feedback" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" INTEGER,
    "safety" TEXT,
    "text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_round_pairings" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "spot_label" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "mission_a" TEXT,
    "mission_b" TEXT,
    "met_confirmed_a" TIMESTAMP(3),
    "met_confirmed_b" TIMESTAMP(3),
    "thumbs_a" BOOLEAN,
    "thumbs_b" BOOLEAN,
    "match_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_round_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_rounds" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "opens_at" TIMESTAMP(3) NOT NULL,
    "closes_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_staff_tokens" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_staff_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_ticket_tiers" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'free_rsvp',
    "title" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "requires_admission" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_ticket_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_tickets" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "tier_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "qr_nonce" TEXT NOT NULL,
    "checked_in_at" TIMESTAMP(3),
    "checked_in_by_token_id" UUID,
    "perk_redeemed_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "recap_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."events" (
    "id" UUID NOT NULL,
    "city_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'launch',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "curated_venue_id" UUID,
    "venue_name" TEXT NOT NULL,
    "venue_address" TEXT NOT NULL,
    "venue_lat" DOUBLE PRECISION NOT NULL,
    "venue_lng" DOUBLE PRECISION NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "admission_policy" TEXT NOT NULL DEFAULT 'manual',
    "auto_apply_on_verification" BOOLEAN NOT NULL DEFAULT false,
    "target_male_share" DOUBLE PRECISION,
    "ratio_tolerance" DOUBLE PRECISION NOT NULL DEFAULT 0.08,
    "auto_approve_score" INTEGER,
    "review_floor_score" INTEGER,
    "admission_opens_at" TIMESTAMP(3),
    "admission_closes_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."founder_reports" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "week_of" TIMESTAMP(3) NOT NULL,
    "data_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "founder_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."live_activity_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "activity_type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "match_id" UUID,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_activity_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."match_events" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "action_type" "public"."MatchEventActionType" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."match_score_logs" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "score_explicit" DOUBLE PRECISION NOT NULL,
    "score_research" DOUBLE PRECISION NOT NULL,
    "score_league" DOUBLE PRECISION NOT NULL,
    "score_penalty" DOUBLE PRECISION NOT NULL,
    "score_age_pref" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "score_total" DOUBLE PRECISION NOT NULL,
    "embedding_distance" DOUBLE PRECISION,
    "starvation_bonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score_type" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "score_intent" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "match_score_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."matches" (
    "id" UUID NOT NULL,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "status" "public"."MatchStatus" NOT NULL DEFAULT 'proposed',
    "pitch_for_a" TEXT,
    "pitch_for_b" TEXT,
    "synergy_score" INTEGER,
    "synergy_reason" TEXT,
    "accepted_by_a" BOOLEAN,
    "accepted_by_b" BOOLEAN,
    "rejection_reason_a" TEXT,
    "rejection_reason_b" TEXT,
    "scheduling_iteration" INTEGER NOT NULL DEFAULT 0,
    "proposed_times" TIMESTAMP(3)[],
    "available_times_a" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "available_times_b" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "picked_time_a" TIMESTAMP(3),
    "picked_time_b" TIMESTAMP(3),
    "agreed_time" TIMESTAMP(3),
    "venue_name" TEXT,
    "venue_address" TEXT,
    "vibe_text_a" TEXT,
    "vibe_text_b" TEXT,
    "vibe_lat_a" DOUBLE PRECISION,
    "vibe_lng_a" DOUBLE PRECISION,
    "vibe_address_a" TEXT,
    "vibe_address_b" TEXT,
    "vibe_lat_b" DOUBLE PRECISION,
    "vibe_lng_b" DOUBLE PRECISION,
    "parsed_category_a" TEXT,
    "parsed_category_b" TEXT,
    "venue_lat" DOUBLE PRECISION,
    "venue_lng" DOUBLE PRECISION,
    "venue_google_maps_uri" TEXT,
    "venue_photo_url" TEXT,
    "venue_photo_name" TEXT,
    "venue_prompt_asked_at" TIMESTAMP(3),
    "icebreakers_sent_at" TIMESTAMP(3),
    "safety_note_sent_at" TIMESTAMP(3),
    "emergency_cancelled_by" UUID,
    "emergency_reason" TEXT,
    "feedback_by_a" TEXT,
    "feedback_by_b" TEXT,
    "feedback_prompted_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "pitch_message_id_a" INTEGER,
    "pitch_message_id_b" INTEGER,
    "calendar_message_id_a" INTEGER,
    "calendar_message_id_b" INTEGER,
    "nudge1_sent_at" TIMESTAMP(3),
    "nudge2_sent_at" TIMESTAMP(3),
    "proposal_nudge1_sent_at" TIMESTAMP(3),
    "proposal_nudge2_sent_at" TIMESTAMP(3),
    "sched_nudge1_sent_at" TIMESTAMP(3),
    "sched_nudge2_sent_at" TIMESTAMP(3),
    "ice_breakers_a" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ice_breakers_b" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "safety_ack_a" BOOLEAN NOT NULL DEFAULT false,
    "safety_ack_b" BOOLEAN NOT NULL DEFAULT false,
    "wingman_hint_a" TEXT,
    "wingman_hint_b" TEXT,
    "wingman_sent_at" TIMESTAMP(3),
    "ticket_price_cents" INTEGER NOT NULL DEFAULT 699,
    "ticket_paid_a" TIMESTAMP(3),
    "ticket_paid_b" TIMESTAMP(3),
    "paid_for_partner_by_a" BOOLEAN NOT NULL DEFAULT false,
    "paid_for_partner_by_b" BOOLEAN NOT NULL DEFAULT false,
    "partner_paid_seen_at" TIMESTAMP(3),
    "partner_paid_nudged_at" TIMESTAMP(3),
    "ticket_status" TEXT NOT NULL DEFAULT 'pending',
    "ticket_expires_at" TIMESTAMP(3),
    "coord_offer_sent_at" TIMESTAMP(3),
    "coord_initiator_id" UUID,
    "coord_method" TEXT,
    "coord_chosen_at" TIMESTAMP(3),
    "coord_partner_consent" BOOLEAN,
    "coord_resolved_at" TIMESTAMP(3),
    "proxy_opened_at" TIMESTAMP(3),
    "proxy_closes_at" TIMESTAMP(3),
    "proxy_closed_at" TIMESTAMP(3),
    "venue_change_status" TEXT,
    "venue_change_proposer_id" UUID,
    "venue_change_proposed_at" TIMESTAMP(3),
    "venue_change_expires_at" TIMESTAMP(3),
    "venue_change_resolved_at" TIMESTAMP(3),
    "venue_change_name" TEXT,
    "venue_change_address" TEXT,
    "venue_change_lat" DOUBLE PRECISION,
    "venue_change_lng" DOUBLE PRECISION,
    "venue_change_maps_uri" TEXT,
    "venue_change_place_id" TEXT,
    "venue_change_comment" TEXT,
    "venue_likes_a" JSONB[],
    "venue_likes_b" JSONB[],
    "venue_change_photo_url" TEXT,
    "venue_change_photo_name" TEXT,
    "venue_change_paid_by_id" UUID,
    "venue_change_paid_at" TIMESTAMP(3),
    "venue_change_pay_declined_at" TIMESTAMP(3),
    "venue_change_offer_pay_sent_at" TIMESTAMP(3),
    "venue_change_ping_sent_to_a_at" TIMESTAMP(3),
    "venue_change_ping_sent_to_b_at" TIMESTAMP(3),
    "venue_change_ping_msg_id_a" INTEGER,
    "venue_change_ping_msg_id_b" INTEGER,
    "venue_change_express_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "date_card_file_id_a" TEXT,
    "date_card_file_id_b" TEXT,
    "venue_change_tier" TEXT,
    "venue_fit_by_a" TEXT,
    "venue_fit_by_b" TEXT,
    "venue_fit_reasons_by_a" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "venue_fit_reasons_by_b" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "venue_intent_a" JSONB,
    "venue_intent_b" JSONB,
    "venue_midpoint_lat" DOUBLE PRECISION,
    "venue_midpoint_lng" DOUBLE PRECISION,
    "venue_place_id" TEXT,
    "venue_selection_attempts" INTEGER NOT NULL DEFAULT 0,
    "venue_selection_confidence" DOUBLE PRECISION,
    "venue_selection_error" TEXT,
    "venue_selection_next_retry_at" TIMESTAMP(3),
    "venue_selection_reason" TEXT,
    "venue_selection_version" TEXT,
    "venue_source" TEXT,
    "proposal_deadline_nudge_sent_at" TIMESTAMP(3),
    "synergy_reason_b" TEXT,
    "rematch_paid_by_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'weekly',
    "peer_wait_edited_at_a" TIMESTAMP(3),
    "peer_wait_edited_at_b" TIMESTAMP(3),
    "peer_wait_message_id_a" INTEGER,
    "peer_wait_message_id_b" INTEGER,
    "peer_wait_started_at_a" TIMESTAMP(3),
    "peer_wait_started_at_b" TIMESTAMP(3),
    "scheduling_opened_at" TIMESTAMP(3),
    "stall_check_in_sent_at_a" TIMESTAMP(3),
    "stall_check_in_sent_at_b" TIMESTAMP(3),
    "stall_confirmed_at_a" TIMESTAMP(3),
    "stall_confirmed_at_b" TIMESTAMP(3),
    "venue_nudge1_sent_at" TIMESTAMP(3),
    "venue_nudge2_sent_at" TIMESTAMP(3),
    "venue_change_count" INTEGER NOT NULL DEFAULT 0,
    "attendance_outcome_a" TEXT,
    "attendance_outcome_b" TEXT,
    "date_attended_a" BOOLEAN,
    "date_attended_b" BOOLEAN,
    "prime_time_paid_by_id" UUID,
    "prime_time_unlocked_at" TIMESTAMP(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."media_validation_rejections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "media_type" TEXT NOT NULL,
    "rejection_reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_validation_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "public"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."no_match_notices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "drop_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "no_match_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."onboarding_progress" (
    "user_id" UUID NOT NULL,
    "completed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skipped_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "asked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "current_question" TEXT,
    "collector_version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "backfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "public"."onboarding_step_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dwell_ms" INTEGER,
    "language" TEXT,
    "platform" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_step_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."phone_otps" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "code_hash" TEXT,
    "provider_request_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."prime_time_purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "external_payment_id" TEXT NOT NULL,
    "amount_stars" INTEGER NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "refund_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prime_time_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."profiler_answers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" TEXT NOT NULL,
    "priority" "public"."ProfilerPriority" NOT NULL,
    "answer_text" TEXT,
    "answered_at" TIMESTAMP(3),
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skip_returned" BOOLEAN NOT NULL DEFAULT false,
    "cycle_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiler_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "height" INTEGER,
    "hobbies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "partner_preferences" TEXT,
    "psychological_summary" TEXT,
    "negative_constraints" TEXT,
    "age_range_min" INTEGER,
    "age_range_max" INTEGER,
    "embedding" vector(1536),
    "embedding_dirty" BOOLEAN NOT NULL DEFAULT false,
    "embedding_dirty_at" TIMESTAMP(3),
    "elo_score" INTEGER NOT NULL DEFAULT 500,
    "elo_matches_played" INTEGER NOT NULL DEFAULT 0,
    "elo_seeded_at" TIMESTAMP(3),
    "elo_seed_details" JSONB,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "profile_media" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "reference_face_embedding" JSONB,
    "uploaded_photo_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pending_photo_candidates" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "accepted_photo_count" INTEGER NOT NULL DEFAULT 0,
    "photo_face_scores" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "match_radius" "public"."MatchRadius" NOT NULL DEFAULT 'campus_only',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "location_updated_at" TIMESTAMP(3),
    "home_city" TEXT,
    "home_country_code" TEXT,
    "home_city_key" TEXT,
    "home_place_id" TEXT,
    "last_matched_at" TIMESTAMP(3),
    "missed_weeks" INTEGER NOT NULL DEFAULT 0,
    "standby_count" INTEGER NOT NULL DEFAULT 0,
    "last_missed_at" TIMESTAMP(3),
    "silent_ignore_count" INTEGER NOT NULL DEFAULT 0,
    "time_zone" TEXT,
    "profiler_started_at" TIMESTAMP(3),
    "profiler_next_at" TIMESTAMP(3),
    "profiler_active_question_id" TEXT,
    "profiler_batch_remaining" INTEGER NOT NULL DEFAULT 0,
    "photo_bonus_ticket_at" TIMESTAMP(3),
    "video_bonus_ticket_at" TIMESTAMP(3),
    "friday_vibe_text" TEXT,
    "vibe_focus_text" TEXT,
    "energy_axis" DOUBLE PRECISION,
    "orientation_axis" DOUBLE PRECISION,
    "social_role" TEXT,
    "anchor_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vibe_extracted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "appearance_tags" JSONB,
    "type_pref_tags" JSONB,
    "type_radar_age_band" TEXT,
    "type_radar_answers" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "type_radar_completed_at" TIMESTAMP(3),
    "profiler_answer_window_until" TIMESTAMP(3),
    "profiler_question_message_id" INTEGER,
    "starvation_paused_at" TIMESTAMP(3),
    "relationship_intents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reliability_score" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promo_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "ticket_reward" INTEGER NOT NULL DEFAULT 1,
    "premium_months" INTEGER NOT NULL DEFAULT 3,
    "max_redemptions" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promo_redemptions" (
    "id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tickets_applied" INTEGER NOT NULL,
    "months_applied" INTEGER NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."proxy_messages" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxy_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."rematch_purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "external_payment_id" TEXT NOT NULL,
    "amount_stars" INTEGER NOT NULL,
    "amount_cents" INTEGER,
    "result_match_id" UUID,
    "framing" TEXT,
    "resolved_at" TIMESTAMP(3),
    "refund_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rematch_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "raw_text" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "reason_summary" TEXT,
    "admin_reviewed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_ledger" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "external_payment_id" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "amount" INTEGER,
    "currency" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "subscription_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."system_knowledge" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ticket_ledger" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "match_id" UUID,
    "amount_cents" INTEGER,
    "bundle_size" INTEGER,
    "external_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount_stars" INTEGER,

    CONSTRAINT "ticket_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_activity_days" (
    "activity_date" DATE NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("activity_date","user_id","platform")
);

-- CreateTable
CREATE TABLE "public"."user_blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "match_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_scratch_maps" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "explored_tiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "explored_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discovered_venues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_scratch_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "telegram_username" TEXT,
    "email" TEXT,
    "university_domain" TEXT,
    "first_name" TEXT,
    "surname" TEXT,
    "age" INTEGER,
    "gender" "public"."Gender",
    "preference" "public"."GenderPreference",
    "major" TEXT,
    "language" "public"."Language",
    "theme" "public"."Theme" NOT NULL DEFAULT 'dark',
    "theme_chosen_at" TIMESTAMP(3),
    "status" "public"."UserStatus" NOT NULL DEFAULT 'onboarding',
    "onboarding_step" "public"."OnboardingStep" NOT NULL DEFAULT 'consent',
    "ai_memory_export_preference" "public"."AiMemoryExportPreference" NOT NULL DEFAULT 'undecided',
    "ai_memory_export_preference_at" TIMESTAMP(3),
    "has_consented" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMP(3),
    "terms_accepted" BOOLEAN NOT NULL DEFAULT false,
    "terms_accepted_at" TIMESTAMP(3),
    "research_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "email_otp" TEXT,
    "email_otp_expires_at" TIMESTAMP(3),
    "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "phone_verified_at" TIMESTAMP(3),
    "registration_track" TEXT,
    "message_history" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "last_message_at" TIMESTAMP(3),
    "last_pre_match_announce_at" TIMESTAMP(3),
    "re_engagement_step" INTEGER NOT NULL DEFAULT 0,
    "re_engagement_next_at" TIMESTAMP(3),
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "suspended_until" TIMESTAMP(3),
    "status_message_id" INTEGER,
    "platform" "public"."Platform" NOT NULL DEFAULT 'telegram',
    "push_token" TEXT,
    "push_platform" TEXT,
    "verification_status" "public"."VerificationStatus" NOT NULL DEFAULT 'unverified',
    "selfie_path" TEXT,
    "persona_inquiry_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "verification_skipped_at" TIMESTAMP(3),
    "verified_selfie_path" TEXT,
    "face_match_score" DOUBLE PRECISION,
    "face_matched_at" TIMESTAMP(3),
    "referral_source" TEXT,
    "ticket_balance" INTEGER NOT NULL DEFAULT 0,
    "ticket_discount_pct" INTEGER NOT NULL DEFAULT 0,
    "ticket_discount_granted_at" TIMESTAMP(3),
    "ticket_discount_expires_at" TIMESTAMP(3),
    "ticket_discount_consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "founder_notified_at" TIMESTAMP(3),
    "premium_auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "premium_external_id" TEXT,
    "premium_provider" TEXT,
    "premium_since" TIMESTAMP(3),
    "premium_until" TIMESTAMP(3),
    "promo_redeemed_at" TIMESTAMP(3),
    "referral_counted_at" TIMESTAMP(3),
    "referral_invitee_premium_at" TIMESTAMP(3),
    "referral_verified_count" INTEGER NOT NULL DEFAULT 0,
    "pending_liveness_session_id" TEXT,
    "biometric_consent_at" TIMESTAMP(3),
    "biometric_consent_version" TEXT,
    "policy_version" TEXT,
    "synthetic_at" TIMESTAMP(3),
    "premium_reminder_1d_at" TIMESTAMP(3),
    "premium_reminder_3d_at" TIMESTAMP(3),
    "scratch_map_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "theme_mode" "public"."ThemeMode" NOT NULL DEFAULT 'dark',
    "ticket_discount_source" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."venue_change_purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "external_payment_id" TEXT NOT NULL,
    "amount_stars" INTEGER NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "refund_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_change_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."venue_selection_logs" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "parser_version" TEXT NOT NULL,
    "ranker_version" TEXT NOT NULL,
    "intent_a" JSONB NOT NULL,
    "intent_b" JSONB NOT NULL,
    "top_candidates" JSONB NOT NULL,
    "selected_source" TEXT,
    "selected_place_id" TEXT,
    "failure_reason" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "places_call_count" INTEGER NOT NULL,
    "chip_corrections" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "city_key" TEXT,

    CONSTRAINT "venue_selection_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."voice_prompts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "telegram_file_id" TEXT,
    "storage_path" TEXT,
    "duration_sec" INTEGER NOT NULL,
    "mime_type" TEXT,
    "file_size" INTEGER,
    "waveform" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "transcript" TEXT,
    "validation_version" INTEGER,
    "validated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."waitlist_applications" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'screening',
    "score_at_tiering" INTEGER,
    "gender_at_tiering" TEXT,
    "tiered_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_channel_category_period_start_period_end_key" ON "public"."ad_spend"("channel" ASC, "category" ASC, "period_start" ASC, "period_end" ASC);

-- CreateIndex
CREATE INDEX "ad_spend_period_start_idx" ON "public"."ad_spend"("period_start" ASC);

-- CreateIndex
CREATE INDEX "chat_events_telegram_message_id_idx" ON "public"."chat_events"("telegram_message_id" ASC);

-- CreateIndex
CREATE INDEX "chat_events_user_id_created_at_idx" ON "public"."chat_events"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "client_events_install_id_occurred_at_idx" ON "public"."client_events"("install_id" ASC, "occurred_at" ASC);

-- CreateIndex
CREATE INDEX "client_events_received_at_idx" ON "public"."client_events"("received_at" ASC);

-- CreateIndex
CREATE INDEX "client_events_type_occurred_at_idx" ON "public"."client_events"("type" ASC, "occurred_at" ASC);

-- CreateIndex
CREATE INDEX "curated_venues_city_key_tier_active_idx" ON "public"."curated_venues"("city_key" ASC, "tier" ASC, "active" ASC);

-- CreateIndex
CREATE INDEX "curated_venues_university_domain_category_active_idx" ON "public"."curated_venues"("university_domain" ASC, "category" ASC, "active" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "date_bump_sessions_match_id_key" ON "public"."date_bump_sessions"("match_id" ASC);

-- CreateIndex
CREATE INDEX "email_otps_email_created_at_idx" ON "public"."email_otps"("email" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "event_feedback_event_id_safety_idx" ON "public"."event_feedback"("event_id" ASC, "safety" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "event_feedback_event_id_user_id_key" ON "public"."event_feedback"("event_id" ASC, "user_id" ASC);

-- CreateIndex
CREATE INDEX "event_round_pairings_event_id_user_a_id_idx" ON "public"."event_round_pairings"("event_id" ASC, "user_a_id" ASC);

-- CreateIndex
CREATE INDEX "event_round_pairings_event_id_user_b_id_idx" ON "public"."event_round_pairings"("event_id" ASC, "user_b_id" ASC);

-- CreateIndex
CREATE INDEX "event_round_pairings_round_id_idx" ON "public"."event_round_pairings"("round_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "event_rounds_event_id_index_key" ON "public"."event_rounds"("event_id" ASC, "index" ASC);

-- CreateIndex
CREATE INDEX "event_staff_tokens_event_id_idx" ON "public"."event_staff_tokens"("event_id" ASC);

-- CreateIndex
CREATE INDEX "event_ticket_tiers_event_id_idx" ON "public"."event_ticket_tiers"("event_id" ASC);

-- CreateIndex
CREATE INDEX "event_tickets_event_id_status_idx" ON "public"."event_tickets"("event_id" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "event_tickets_event_id_user_id_key" ON "public"."event_tickets"("event_id" ASC, "user_id" ASC);

-- CreateIndex
CREATE INDEX "events_city_key_status_starts_at_idx" ON "public"."events"("city_key" ASC, "status" ASC, "starts_at" ASC);

-- CreateIndex
CREATE INDEX "founder_reports_created_at_idx" ON "public"."founder_reports"("created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "founder_reports_token_key" ON "public"."founder_reports"("token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "live_activity_tokens_user_id_activity_type_kind_key" ON "public"."live_activity_tokens"("user_id" ASC, "activity_type" ASC, "kind" ASC);

-- CreateIndex
CREATE INDEX "match_events_action_type_created_at_idx" ON "public"."match_events"("action_type" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "match_events_actor_id_created_at_idx" ON "public"."match_events"("actor_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "match_events_match_id_created_at_idx" ON "public"."match_events"("match_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "match_events_target_id_created_at_idx" ON "public"."match_events"("target_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "match_score_logs_created_at_idx" ON "public"."match_score_logs"("created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "match_score_logs_match_id_key" ON "public"."match_score_logs"("match_id" ASC);

-- CreateIndex
CREATE INDEX "match_score_logs_score_total_idx" ON "public"."match_score_logs"("score_total" ASC);

-- CreateIndex
CREATE INDEX "matches_coord_method_proxy_closed_at_idx" ON "public"."matches"("coord_method" ASC, "proxy_closed_at" ASC);

-- CreateIndex
CREATE INDEX "matches_status_coord_offer_sent_at_idx" ON "public"."matches"("status" ASC, "coord_offer_sent_at" ASC);

-- CreateIndex
CREATE INDEX "matches_status_created_at_idx" ON "public"."matches"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "matches_ticket_status_ticket_expires_at_idx" ON "public"."matches"("ticket_status" ASC, "ticket_expires_at" ASC);

-- CreateIndex
CREATE INDEX "matches_user_a_id_user_b_id_idx" ON "public"."matches"("user_a_id" ASC, "user_b_id" ASC);

-- CreateIndex
CREATE INDEX "matches_venue_change_status_venue_change_expires_at_idx" ON "public"."matches"("venue_change_status" ASC, "venue_change_expires_at" ASC);

-- CreateIndex
CREATE INDEX "media_validation_rejections_media_type_rejection_reason_cre_idx" ON "public"."media_validation_rejections"("media_type" ASC, "rejection_reason" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "media_validation_rejections_user_id_created_at_idx" ON "public"."media_validation_rejections"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "messages_user_id_created_at_idx" ON "public"."messages"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "no_match_notices_drop_date_idx" ON "public"."no_match_notices"("drop_date" ASC);

-- CreateIndex
CREATE INDEX "no_match_notices_sent_at_idx" ON "public"."no_match_notices"("sent_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "no_match_notices_user_id_drop_date_key" ON "public"."no_match_notices"("user_id" ASC, "drop_date" ASC);

-- CreateIndex
CREATE INDEX "onboarding_step_events_step_kind_created_at_idx" ON "public"."onboarding_step_events"("step" ASC, "kind" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "onboarding_step_events_user_id_created_at_idx" ON "public"."onboarding_step_events"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "phone_otps_phone_created_at_idx" ON "public"."phone_otps"("phone" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "prime_time_purchases_external_payment_id_key" ON "public"."prime_time_purchases"("external_payment_id" ASC);

-- CreateIndex
CREATE INDEX "prime_time_purchases_status_created_at_idx" ON "public"."prime_time_purchases"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "prime_time_purchases_user_id_created_at_idx" ON "public"."prime_time_purchases"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "profiler_answers_user_id_idx" ON "public"."profiler_answers"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "profiler_answers_user_id_question_id_key" ON "public"."profiler_answers"("user_id" ASC, "question_id" ASC);

-- CreateIndex
CREATE INDEX "profiles_profiler_next_at_idx" ON "public"."profiles"("profiler_next_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "public"."profiles"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "public"."promo_codes"("code" ASC);

-- CreateIndex
CREATE INDEX "promo_redemptions_promo_code_id_redeemed_at_idx" ON "public"."promo_redemptions"("promo_code_id" ASC, "redeemed_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_promo_code_id_user_id_key" ON "public"."promo_redemptions"("promo_code_id" ASC, "user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_user_id_key" ON "public"."promo_redemptions"("user_id" ASC);

-- CreateIndex
CREATE INDEX "proxy_messages_match_id_created_at_idx" ON "public"."proxy_messages"("match_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "rematch_purchases_external_payment_id_key" ON "public"."rematch_purchases"("external_payment_id" ASC);

-- CreateIndex
CREATE INDEX "rematch_purchases_status_created_at_idx" ON "public"."rematch_purchases"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "rematch_purchases_user_id_created_at_idx" ON "public"."rematch_purchases"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "reports_reported_id_tier_created_at_idx" ON "public"."reports"("reported_id" ASC, "tier" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "reports_reporter_id_match_id_key" ON "public"."reports"("reporter_id" ASC, "match_id" ASC);

-- CreateIndex
CREATE INDEX "reports_tier_admin_reviewed_created_at_idx" ON "public"."reports"("tier" ASC, "admin_reviewed" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_ledger_external_payment_id_key" ON "public"."subscription_ledger"("external_payment_id" ASC);

-- CreateIndex
CREATE INDEX "subscription_ledger_user_id_created_at_idx" ON "public"."subscription_ledger"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "system_knowledge_key_key" ON "public"."system_knowledge"("key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_ledger_external_payment_id_key" ON "public"."ticket_ledger"("external_payment_id" ASC);

-- CreateIndex
CREATE INDEX "ticket_ledger_user_id_created_at_idx" ON "public"."ticket_ledger"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "user_activity_days_activity_date_idx" ON "public"."user_activity_days"("activity_date" ASC);

-- CreateIndex
CREATE INDEX "user_activity_days_user_id_activity_date_idx" ON "public"."user_activity_days"("user_id" ASC, "activity_date" ASC);

-- CreateIndex
CREATE INDEX "user_blocks_blocked_id_idx" ON "public"."user_blocks"("blocked_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key" ON "public"."user_blocks"("blocker_id" ASC, "blocked_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_scratch_maps_user_id_key" ON "public"."user_scratch_maps"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "public"."user_sessions"("refresh_token_hash" ASC);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "public"."user_sessions"("user_id" ASC, "revoked_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_persona_inquiry_id_key" ON "public"."users"("persona_inquiry_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "public"."users"("phone" ASC);

-- CreateIndex
CREATE INDEX "users_premium_until_idx" ON "public"."users"("premium_until" ASC);

-- CreateIndex
CREATE INDEX "users_status_re_engagement_next_at_idx" ON "public"."users"("status" ASC, "re_engagement_next_at" ASC);

-- CreateIndex
CREATE INDEX "users_status_suspended_until_idx" ON "public"."users"("status" ASC, "suspended_until" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "public"."users"("telegram_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "venue_change_purchases_external_payment_id_key" ON "public"."venue_change_purchases"("external_payment_id" ASC);

-- CreateIndex
CREATE INDEX "venue_change_purchases_status_created_at_idx" ON "public"."venue_change_purchases"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "venue_change_purchases_user_id_created_at_idx" ON "public"."venue_change_purchases"("user_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "venue_selection_logs_city_key_created_at_idx" ON "public"."venue_selection_logs"("city_key" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "venue_selection_logs_match_id_created_at_idx" ON "public"."venue_selection_logs"("match_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "venue_selection_logs_mode_created_at_idx" ON "public"."venue_selection_logs"("mode" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "voice_prompts_user_id_key" ON "public"."voice_prompts"("user_id" ASC);

-- CreateIndex
CREATE INDEX "waitlist_applications_event_id_tier_idx" ON "public"."waitlist_applications"("event_id" ASC, "tier" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_applications_event_id_user_id_key" ON "public"."waitlist_applications"("event_id" ASC, "user_id" ASC);

-- AddForeignKey
ALTER TABLE "public"."chat_events" ADD CONSTRAINT "chat_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."client_events" ADD CONSTRAINT "client_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."date_bump_sessions" ADD CONSTRAINT "date_bump_sessions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_feedback" ADD CONSTRAINT "event_feedback_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_feedback" ADD CONSTRAINT "event_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_round_pairings" ADD CONSTRAINT "event_round_pairings_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."event_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_round_pairings" ADD CONSTRAINT "event_round_pairings_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_round_pairings" ADD CONSTRAINT "event_round_pairings_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_rounds" ADD CONSTRAINT "event_rounds_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_staff_tokens" ADD CONSTRAINT "event_staff_tokens_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_ticket_tiers" ADD CONSTRAINT "event_ticket_tiers_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_tickets" ADD CONSTRAINT "event_tickets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_tickets" ADD CONSTRAINT "event_tickets_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "public"."event_ticket_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."event_tickets" ADD CONSTRAINT "event_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."match_events" ADD CONSTRAINT "match_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."match_events" ADD CONSTRAINT "match_events_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."match_events" ADD CONSTRAINT "match_events_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."match_score_logs" ADD CONSTRAINT "match_score_logs_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."matches" ADD CONSTRAINT "matches_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."matches" ADD CONSTRAINT "matches_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."media_validation_rejections" ADD CONSTRAINT "media_validation_rejections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."no_match_notices" ADD CONSTRAINT "no_match_notices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."onboarding_progress" ADD CONSTRAINT "onboarding_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."onboarding_step_events" ADD CONSTRAINT "onboarding_step_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."prime_time_purchases" ADD CONSTRAINT "prime_time_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profiler_answers" ADD CONSTRAINT "profiler_answers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promo_redemptions" ADD CONSTRAINT "promo_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."proxy_messages" ADD CONSTRAINT "proxy_messages_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rematch_purchases" ADD CONSTRAINT "rematch_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reports" ADD CONSTRAINT "reports_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reports" ADD CONSTRAINT "reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_ledger" ADD CONSTRAINT "subscription_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ticket_ledger" ADD CONSTRAINT "ticket_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_activity_days" ADD CONSTRAINT "user_activity_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_blocks" ADD CONSTRAINT "user_blocks_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_scratch_maps" ADD CONSTRAINT "user_scratch_maps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."venue_change_purchases" ADD CONSTRAINT "venue_change_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."venue_selection_logs" ADD CONSTRAINT "venue_selection_logs_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."voice_prompts" ADD CONSTRAINT "voice_prompts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."waitlist_applications" ADD CONSTRAINT "waitlist_applications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."waitlist_applications" ADD CONSTRAINT "waitlist_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

