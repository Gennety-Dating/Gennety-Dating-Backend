import { describe, it, expect } from "vitest";
import {
  computeMatchConversion,
  isGhostDuringScheduling,
  isPaidDate,
  paidDatesInWindow,
  refundReasonFor,
  type ConversionMatchInput,
} from "./match-conversion.js";

function m(partial: Partial<ConversionMatchInput> = {}): ConversionMatchInput {
  return {
    id: "m1",
    source: "weekly",
    isTestPair: false,
    acceptedByA: true,
    acceptedByB: true,
    status: "completed",
    ticketStatus: "completed",
    ticketPaidA: new Date("2026-08-10T10:00:00Z"),
    ticketPaidB: new Date("2026-08-10T11:00:00Z"),
    dateAttendedA: null,
    dateAttendedB: null,
    attendanceOutcomeA: null,
    attendanceOutcomeB: null,
    stallCheckInSentAtA: null,
    stallCheckInSentAtB: null,
    stallConfirmedAtA: null,
    stallConfirmedAtB: null,
    refundedSlots: 0,
    createdAt: new Date("2026-08-08T00:00:00Z"),
    ...partial,
  };
}

describe("denominator", () => {
  it("counts only matches both sides accepted", () => {
    const out = computeMatchConversion([
      m({ acceptedByA: true, acceptedByB: true }),
      m({ acceptedByA: true, acceptedByB: null }),
      m({ acceptedByA: null, acceptedByB: null }),
      m({ acceptedByA: true, acceptedByB: false }),
    ]);
    expect(out.confirmed).toBe(1);
  });

  it("excludes synthetic matches — they can never buy a ticket", () => {
    // Синтетический партнёр по построению всегда отказывает (§3.1c). Без этого
    // фильтра конверсия — вечный 0% по конструкции, а не по факту.
    const out = computeMatchConversion([
      m({ source: "synthetic" }),
      m({ source: "synthetic" }),
      m({ source: "weekly" }),
    ]);
    expect(out.excludedSynthetic).toBe(2);
    expect(out.confirmed).toBe(1);
  });

  it("excludes test pairs by the health verdict, not by a negative telegramId", () => {
    const out = computeMatchConversion([m({ isTestPair: true }), m()]);
    expect(out.excludedTest).toBe(1);
    expect(out.confirmed).toBe(1);
  });

  it("returns null — not 0% — when nothing qualifies", () => {
    const out = computeMatchConversion([]);
    expect(out.confirmed).toBe(0);
    expect(out.netPct).toBeNull();
    expect(out.grossPct).toBeNull();
    expect(out.noShowRateOfPaidPct).toBeNull();
  });
});

describe("numerator", () => {
  it("needs BOTH tickets — one is not a paid date", () => {
    // §3.5b — жёсткий гейт: календарь не открывается, пока не оплачены оба.
    expect(isPaidDate(m({ ticketStatus: "completed" }))).toBe(true);
    expect(isPaidDate(m({ ticketStatus: "partial" }))).toBe(false);

    const out = computeMatchConversion([
      m({ ticketStatus: "completed" }),
      m({ ticketStatus: "partial" }),
      m({ ticketStatus: "pending" }),
    ]);
    expect(out.ticketsPurchased).toBe(1);
    expect(out.ticketsPartial).toBe(1);
    expect(out.grossPct).toBe(33.3);
  });
});

describe("deductions", () => {
  it("counts a spoiled match ONCE even when it is a no-show AND a refund", () => {
    // Буквальная формула ТЗ (`no_show + ghost + refunded`) вычла бы этот матч
    // трижды и увела числитель в минус.
    const out = computeMatchConversion([
      m({
        dateAttendedA: false,
        attendanceOutcomeA: "no_show_partner",
        refundedSlots: 2,
        status: "completed",
      }),
      m(),
      m(),
      m(),
    ]);
    expect(out.noShow).toBe(1);
    expect(out.refunded).toBe(1);
    expect(out.deductions).toBe(1);
    expect(out.netPct).toBe(75);
    expect(out.grossPct).toBe(100);
  });

  it("never subtracts a match that was never in the numerator", () => {
    // Матч без оплаченных билетов, закончившийся гостингом, — это не «минус
    // одна продажа», это просто не продажа.
    const out = computeMatchConversion([
      m({
        ticketStatus: "pending",
        ticketPaidA: null,
        ticketPaidB: null,
        status: "cancelled",
        stallCheckInSentAtA: new Date(),
      }),
      m(),
    ]);
    expect(out.ghostDuringScheduling).toBe(1);
    expect(out.deductions).toBe(0);
    expect(out.netPct).toBe(50);
  });

  it("a mutual reschedule is not a deduction", () => {
    const out = computeMatchConversion([
      m({
        dateAttendedA: false,
        dateAttendedB: false,
        attendanceOutcomeA: "both_rescheduled",
        attendanceOutcomeB: "both_rescheduled",
      }),
    ]);
    expect(out.noShow).toBe(0);
    expect(out.deductions).toBe(0);
    expect(out.netPct).toBe(100);
  });

  it("reports planning quality against SOLD tickets, not against all matches", () => {
    const out = computeMatchConversion([
      m({ dateAttendedA: false, attendanceOutcomeA: "no_show_partner" }),
      m(),
      m({ ticketStatus: "pending" }),
    ]);
    // 1 no-show из 2 проданных = 50%, а не 33% от трёх подтверждённых.
    expect(out.noShowRateOfPaidPct).toBe(50);
  });
});

describe("isGhostDuringScheduling", () => {
  it("needs a stall check-in that went unanswered", () => {
    expect(
      isGhostDuringScheduling(
        m({ status: "cancelled", stallCheckInSentAtB: new Date(), stallConfirmedAtB: null }),
      ),
    ).toBe(true);
  });

  it("is false when the side confirmed", () => {
    expect(
      isGhostDuringScheduling(
        m({
          status: "cancelled",
          stallCheckInSentAtB: new Date(),
          stallConfirmedAtB: new Date(),
        }),
      ),
    ).toBe(false);
  });

  it("is false for a cancellation that never involved the stall chain", () => {
    // Экстренная отмена, модерация, заморозка — check-in там не отправлялся.
    expect(isGhostDuringScheduling(m({ status: "cancelled" }))).toBe(false);
  });
});

describe("refundReasonFor", () => {
  it("is null when nothing came back", () => {
    expect(refundReasonFor(m())).toBeNull();
  });

  it("derives the real path rather than guessing between two values", () => {
    expect(
      refundReasonFor(
        m({ refundedSlots: 2, dateAttendedA: false, attendanceOutcomeA: "no_show_partner" }),
      ),
    ).toBe("no_show");
    expect(
      refundReasonFor(
        m({ refundedSlots: 1, status: "cancelled", stallCheckInSentAtA: new Date() }),
      ),
    ).toBe("ghost_during_scheduling");
    expect(refundReasonFor(m({ refundedSlots: 2, status: "cancelled" }))).toBe(
      "cancelled_before_date",
    );
  });
});

describe("paidDatesInWindow", () => {
  const since = new Date("2026-08-10T00:00:00Z");
  const until = new Date("2026-08-17T00:00:00Z");

  it("counts matches, not payers — one man paying for two is ONE date", () => {
    expect(paidDatesInWindow([m()], since, until)).toBe(1);
  });

  it("dates the sale by the SECOND slot, since one ticket is not a paid date", () => {
    const early = m({
      ticketPaidA: new Date("2026-08-05T10:00:00Z"),
      ticketPaidB: new Date("2026-08-12T10:00:00Z"),
    });
    expect(paidDatesInWindow([early], since, until)).toBe(1);

    const outside = m({
      ticketPaidA: new Date("2026-08-05T10:00:00Z"),
      ticketPaidB: new Date("2026-08-09T10:00:00Z"),
    });
    expect(paidDatesInWindow([outside], since, until)).toBe(0);
  });

  it("ignores synthetic and test pairs here too", () => {
    expect(paidDatesInWindow([m({ source: "synthetic" }), m({ isTestPair: true })], since, until)).toBe(0);
  });
});
