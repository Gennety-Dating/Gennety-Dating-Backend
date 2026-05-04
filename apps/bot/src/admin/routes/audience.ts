import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  AGE_BUCKETS,
  ageBucket,
  type AgeBucket,
  MAJOR_CLUSTERS,
  majorCluster,
  type MajorCluster,
} from "../utils/buckets.js";
import {
  detectSocialEnergy,
  detectAttachmentStyle,
  detectHumorStyle,
  detectCommunicationStyle,
  SOCIAL_ENERGY_VALUES,
  ATTACHMENT_STYLE_VALUES,
  HUMOR_STYLE_VALUES,
  COMMUNICATION_STYLE_VALUES,
} from "../utils/psych-scan.js";
import { getOrCompute } from "../utils/cache.js";

export const audienceRouter: Router = Router();

/**
 * Heavy aggregate over the full user base. Cached 10 min — the figures
 * shift slowly and a 10-min TTL is a reasonable compromise between
 * dashboard freshness and DB load.
 */
audienceRouter.get(
  "/admin/analytics/audience",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("audience:v1", 600, async () => {
        // Single broad query — joins we'd otherwise issue separately.
        // 50k users × ~2KB each is ~100MB; if this grows we'll move to
        // raw aggregation SQL. For now the explicit dashboard scan is
        // simpler and fast enough.
        const users = await prisma.user.findMany({
          select: {
            age: true,
            major: true,
            status: true,
            profile: {
              select: {
                ethnicity: true,
                hobbies: true,
                psychologicalSummary: true,
                matchRadius: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        });

        // Age buckets
        const ageBuckets: Record<AgeBucket, number> = {
          "18-22": 0, "23-27": 0, "28-35": 0, "36+": 0, unknown: 0,
        };
        // Major clusters
        const majorClusters: Record<MajorCluster, number> = {
          STEM: 0, Humanities: 0, Arts: 0, Business: 0, Health: 0, Other: 0, Unknown: 0,
        };
        // Ethnicity (raw, free-text)
        const ethnicity = new Map<string, number>();
        // Hobbies (unnest)
        const hobbies = new Map<string, number>();
        // Psych dimensions
        const socialEnergy = Object.fromEntries(
          SOCIAL_ENERGY_VALUES.map((k) => [k, 0]),
        ) as Record<string, number>;
        const attachmentStyle = Object.fromEntries(
          ATTACHMENT_STYLE_VALUES.map((k) => [k, 0]),
        ) as Record<string, number>;
        const humorStyle = Object.fromEntries(
          HUMOR_STYLE_VALUES.map((k) => [k, 0]),
        ) as Record<string, number>;
        const communicationStyle = Object.fromEntries(
          COMMUNICATION_STYLE_VALUES.map((k) => [k, 0]),
        ) as Record<string, number>;
        // Match radius
        const matchRadius = { campus_only: 0, citywide: 0, unknown: 0 };
        // Geo feasibility
        let geoKnown = 0;

        for (const u of users) {
          ageBuckets[ageBucket(u.age)]++;
          majorClusters[majorCluster(u.major)]++;

          const p = u.profile;
          if (p) {
            if (p.ethnicity && p.ethnicity.trim().length > 0) {
              const key = p.ethnicity.trim().toLowerCase();
              ethnicity.set(key, (ethnicity.get(key) ?? 0) + 1);
            }
            for (const h of p.hobbies ?? []) {
              const key = h.trim().toLowerCase();
              if (!key) continue;
              hobbies.set(key, (hobbies.get(key) ?? 0) + 1);
            }
            socialEnergy[detectSocialEnergy(p.psychologicalSummary)]++;
            attachmentStyle[detectAttachmentStyle(p.psychologicalSummary)]++;
            humorStyle[detectHumorStyle(p.psychologicalSummary)]++;
            communicationStyle[detectCommunicationStyle(p.psychologicalSummary)]++;
            if (p.matchRadius === "campus_only") matchRadius.campus_only++;
            else if (p.matchRadius === "citywide") matchRadius.citywide++;
            else matchRadius.unknown++;
            if (p.latitude !== null && p.longitude !== null) geoKnown++;
          } else {
            matchRadius.unknown++;
          }
        }

        const topHobbies = Array.from(hobbies.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        const topEthnicity = Array.from(ethnicity.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        return {
          totalUsers: users.length,
          age: AGE_BUCKETS.map((b) => ({ bucket: b, count: ageBuckets[b] })),
          majorClusters: MAJOR_CLUSTERS.map((c) => ({
            cluster: c, count: majorClusters[c],
          })),
          topHobbies,
          ethnicity: topEthnicity,
          socialEnergy: SOCIAL_ENERGY_VALUES.map((v) => ({
            value: v, count: socialEnergy[v] ?? 0,
          })),
          attachmentStyle: ATTACHMENT_STYLE_VALUES.map((v) => ({
            value: v, count: attachmentStyle[v] ?? 0,
          })),
          humorStyle: HUMOR_STYLE_VALUES.map((v) => ({
            value: v, count: humorStyle[v] ?? 0,
          })),
          communicationStyle: COMMUNICATION_STYLE_VALUES.map((v) => ({
            value: v, count: communicationStyle[v] ?? 0,
          })),
          matchRadius,
          geo: {
            known: geoKnown,
            unknown: users.length - geoKnown,
            knownPct: users.length > 0 ? +(geoKnown / users.length).toFixed(4) : 0,
          },
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] audience error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Grid-aggregated heatmap. Returns ~1km cells with count ≥ 3 (k-anonymity)
 * for users who explicitly opted into research. Never returns raw points.
 *
 * Cell size: 0.01 degrees ≈ 1.1km lat / 0.7km lng at 45°. Good enough for
 * a campus/city overview without leaking individuals.
 */
audienceRouter.get(
  "/admin/analytics/audience/heatmap",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("heatmap:v1", 3600, async () => {
        const profiles = await prisma.profile.findMany({
          where: {
            latitude: { not: null },
            longitude: { not: null },
            user: { researchOptIn: true },
          },
          select: { latitude: true, longitude: true },
        });

        const cells = new Map<string, { lat: number; lng: number; count: number }>();
        for (const p of profiles) {
          if (p.latitude === null || p.longitude === null) continue;
          const lat = Math.round(p.latitude * 100) / 100;
          const lng = Math.round(p.longitude * 100) / 100;
          const key = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
          const existing = cells.get(key);
          if (existing) existing.count++;
          else cells.set(key, { lat, lng, count: 1 });
        }

        // k-anon: drop singletons / pairs
        const safeCells = Array.from(cells.values()).filter((c) => c.count >= 3);
        return {
          cellCount: safeCells.length,
          totalUsers: profiles.length,
          totalAggregated: safeCells.reduce((acc, c) => acc + c.count, 0),
          cells: safeCells,
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] heatmap error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
