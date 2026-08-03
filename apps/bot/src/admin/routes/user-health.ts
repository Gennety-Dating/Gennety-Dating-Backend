/**
 * GET /admin/users/:id/health — классификация ОДНОГО аккаунта плюс причина.
 *
 * Существует ради вопроса «почему этот человек попал в suspicious/cold_open»:
 * агрегат в `/admin/stats` показывает числа, но не показывает, какое правило
 * сработало. Только чтение, только под админским ключом; переписка не
 * возвращается — счётчики и метаданные.
 */
import { Router, type Request, type Response } from "express";
import { isUuid } from "../utils/uuid.js";
import { classifyOneUser } from "../utils/user-health-source.js";

export const userHealthRouter: Router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

userHealthRouter.get("/admin/users/:id/health", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    // Не-UUID до Prisma доводить нельзя: он бросит P2023, и опечатка в id
    // станет неотличима от аварии сервера.
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }

    const result = await classifyOneUser(id);
    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { input, verdict } = result;
    const daysSinceLastMessage = input.lastMessageAt
      ? +((Date.now() - input.lastMessageAt.getTime()) / DAY_MS).toFixed(1)
      : null;

    res.json({
      user_id: input.id,
      classification: verdict.classification,
      subclass: verdict.subclass,
      reason: verdict.reason,
      rules_fired: verdict.rules_fired,
      matchmaking_eligible: verdict.matchmaking_eligible,
      user_summary: {
        first_name: input.firstName,
        status: input.status,
        onboarding_step: input.onboardingStep,
        verification_status: input.verificationStatus,
        message_count_in: input.messageCountIn,
        created_at: input.createdAt.toISOString(),
        last_message_at: input.lastMessageAt?.toISOString() ?? null,
        days_since_last_message: daysSinceLastMessage,
      },
      // Сырые сигналы, по которым принималось решение — чтобы «почему» можно
      // было проверить, а не принимать на веру.
      signals: {
        photo_count: input.photoCount,
        face_match_score: input.faceMatchScore,
        face_matched_at: input.faceMatchedAt?.toISOString() ?? null,
        median_response_sec: input.medianResponseSec,
        response_samples: input.responseSamples,
        registration_burst_size: input.registrationBurstSize,
      },
    });
  } catch (err) {
    console.error("[admin] user health error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
