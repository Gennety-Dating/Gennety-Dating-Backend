export type NameGender = "male" | "female";

// Irregular stems and names whose stress changes the usual -ия rule.
const DATIVE: Readonly<Record<string, string>> = {
  павел: "павлу", лев: "льву", пётр: "петру", петр: "петру",
  любовь: "любови", нель: "нели", нинель: "нинели",
  агарь: "агари", рахиль: "рахили", руфь: "руфи",
  суламифь: "суламифи", эсфирь: "эсфири", юдифь: "юдифи", рашель: "рашели",
  алия: "алие", альфия: "альфие", зульфия: "зульфие",
  лия: "лие", мия: "мие", ия: "ие", бия: "бие",
};

/** Russian dative only; no transliteration or guesswork for mixed-script names. */
export function russianNameDative(name: string, gender?: NameGender | null): string {
  if (!/^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$/u.test(name)) return name;
  return name.split("-").map((part) => {
    const lower = part.toLowerCase();
    let result = DATIVE[lower];
    if (!result) {
      if (lower.endsWith("ия")) result = lower.slice(0, -1) + "и";
      else if (/[ая]$/u.test(lower)) result = lower.slice(0, -1) + "е";
      else if (gender === "male" && /[йь]$/u.test(lower)) result = lower.slice(0, -1) + "ю";
      else if (gender === "male" && /[бвгджзклмнпрстфхцчшщ]$/u.test(lower)) result = lower + "у";
      else return part;
    }
    if (part === part.toUpperCase()) return result.toUpperCase();
    if (part[0] === part[0]?.toUpperCase()) return result[0]!.toUpperCase() + result.slice(1);
    return result;
  }).join("-");
}
