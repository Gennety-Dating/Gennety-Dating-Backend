import { describe, expect, it } from "vitest";
import { serializeUser } from "./routes/serializers.js";

type UserInput = Parameters<typeof serializeUser>[0];

describe("native auth serializer across Pulse rollouts", () => {
  const legacyUser = {
    id: "00000000-0000-4000-8000-000000000001",
    email: null, universityDomain: null, firstName: null, surname: null,
    age: null, gender: null, preference: null, major: null, language: "en",
    theme: "dark", themeMode: "system", status: "onboarding",
    onboardingStep: "consent", termsAccepted: false, researchOptIn: false,
    ticketBalance: 0,
  };

  it("includes false in JSON when the deployed Prisma model predates Pulse", () => {
    // This is the shape returned by the pre-Pulse production Prisma client.
    const payload = JSON.parse(JSON.stringify(serializeUser(legacyUser as UserInput)));
    expect(payload).toEqual({ ...legacyUser, analyticsOptIn: false });
  });

  it.each([true, false])("preserves explicit consent %s", (analyticsOptIn) => {
    const user = { ...legacyUser, analyticsOptIn } as UserInput;
    expect(serializeUser(user).analyticsOptIn).toBe(analyticsOptIn);
  });
});
