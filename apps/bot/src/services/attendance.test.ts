import { describe, it, expect } from "vitest";
import {
  attendanceQuestionKey,
  classifyAttendanceReply,
  isAttendanceOutcome,
  isNoShow,
  resolvePairAttendance,
} from "./attendance.js";

describe("resolvePairAttendance", () => {
  it("is unknown when nobody answered — silence is not a no-show", () => {
    expect(resolvePairAttendance({ dateAttendedA: null, dateAttendedB: null })).toBe("unknown");
  });

  it("one yes settles it for the pair", () => {
    // Явка — свойство пары: человек, который был на свидании, знает это про
    // обоих. Ждать второго ответа значило бы терять факт из-за молчания.
    expect(resolvePairAttendance({ dateAttendedA: true, dateAttendedB: null })).toBe("met");
    expect(resolvePairAttendance({ dateAttendedA: null, dateAttendedB: true })).toBe("met");
  });

  it("one no settles it too — the person who didn't come won't answer", () => {
    expect(resolvePairAttendance({ dateAttendedA: false, dateAttendedB: null })).toBe("not_met");
  });

  it("keeps a disagreement visible instead of collapsing it", () => {
    expect(resolvePairAttendance({ dateAttendedA: true, dateAttendedB: false })).toBe("disputed");
    expect(resolvePairAttendance({ dateAttendedA: false, dateAttendedB: true })).toBe("disputed");
  });
});

describe("isNoShow", () => {
  const noOutcome = { attendanceOutcomeA: null, attendanceOutcomeB: null };

  it("returns null — not false — when nobody answered", () => {
    // Это и есть правило «нет данных, а не 0»: `false` здесь означал бы, что
    // мы знаем об отсутствии no-show, а мы не знаем ничего.
    expect(isNoShow({ dateAttendedA: null, dateAttendedB: null, ...noOutcome })).toBeNull();
  });

  it("is false when the date happened", () => {
    expect(isNoShow({ dateAttendedA: true, dateAttendedB: null, ...noOutcome })).toBe(false);
  });

  it("is true only when somebody was actually left waiting", () => {
    expect(
      isNoShow({
        dateAttendedA: false,
        dateAttendedB: null,
        attendanceOutcomeA: "no_show_partner",
        attendanceOutcomeB: null,
      }),
    ).toBe(true);
  });

  it("a mutual reschedule is NOT a no-show", () => {
    // Свидание не состоялось, но пострадавшего нет — это разные факты, и для
    // возврата билета разница принципиальная.
    expect(
      isNoShow({
        dateAttendedA: false,
        dateAttendedB: false,
        attendanceOutcomeA: "both_rescheduled",
        attendanceOutcomeB: "both_rescheduled",
      }),
    ).toBe(false);
  });

  it("a disputed pair still surfaces a claimed no-show", () => {
    expect(
      isNoShow({
        dateAttendedA: false,
        dateAttendedB: true,
        attendanceOutcomeA: "no_show_partner",
        attendanceOutcomeB: null,
      }),
    ).toBe(true);
  });
});

describe("classifyAttendanceReply", () => {
  it("reads short confirmations in every onboarding language", () => {
    for (const yes of ["да", "Да!", "так", "yes", "we met", "ja", "tak"]) {
      expect(classifyAttendanceReply(yes)).toBe("yes");
    }
    for (const no of ["нет", "не встретились", "ні", "no", "nein", "nie"]) {
      expect(classifyAttendanceReply(no)).toBe("no");
    }
  });

  it("matches the WHOLE utterance, never a substring", () => {
    // «нет мы встретились» начинается с «нет» и означает «да». Подстрочное
    // совпадение записало бы в метрику противоположный факт.
    expect(classifyAttendanceReply("нет мы встретились")).toBe("unclear");
    expect(classifyAttendanceReply("да не пришла она")).toBe("unclear");
  });

  it("hands anything long back to the agent", () => {
    expect(
      classifyAttendanceReply(
        "ну как сказать, посидели минут двадцать и разошлись, было неловко",
      ),
    ).toBe("unclear");
  });

  it("is unclear on empty input", () => {
    expect(classifyAttendanceReply("   ")).toBe("unclear");
  });
});

describe("attendanceQuestionKey", () => {
  it("maps every tone to its own copy", () => {
    expect(attendanceQuestionKey("unknown")).toBe("attendanceAsk");
    expect(attendanceQuestionKey("likely_met")).toBe("attendanceAskLikelyMet");
    expect(attendanceQuestionKey("likely_not_met")).toBe("attendanceAskLikelyNotMet");
  });
});

describe("isAttendanceOutcome", () => {
  it("accepts the whitelist and nothing else", () => {
    expect(isAttendanceOutcome("no_show_partner")).toBe(true);
    expect(isAttendanceOutcome("both_rescheduled")).toBe(true);
    expect(isAttendanceOutcome("NO_SHOW")).toBe(false);
    expect(isAttendanceOutcome(null)).toBe(false);
  });
});
