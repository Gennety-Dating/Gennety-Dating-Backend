# Type Radar — Band A FINAL manifest (24/24 accepted)

Age band A = 22–28 (women rendered 24, men 26). Source of truth for attributes:
`packages/shared/src/type-radar.ts`. Target folder for deploy:
`apps/webapp/public/radar/a/<id>.jpg` (currently staged in
`~/Desktop/type-radar-final/band-A/`).

Status legend: **kept** = original first-pass image was fine; **regen** =
replaced via a corrected prompt; **regen◐** = accepted with a minor noted
caveat (candidates to improve later if the axis looks weak, not blockers).

## Females
| id  | attributes | status | note |
|-----|-----------|--------|------|
| f01 | blonde / long / slim / elegant / no      | kept   | |
| f02 | brunette / long / athletic / sporty / no | regen◐ | athletic reads a touch slim |
| f03 | red / short / slim / edgy / yes          | regen  | (fixed Asian→EE) |
| f04 | brunette / short / curvy / elegant / no  | regen  | fit slim-thick, black dress, tattoo cleaned |
| f05 | blonde / short / athletic / edgy / yes   | kept   | |
| f06 | red / long / curvy / sporty / no         | regen  | |
| f07 | brunette / long / slim / sporty / yes    | regen  | (fixed ethnicity) |
| f08 | blonde / long / curvy / edgy / no        | regen  | fitted tee = curvy; text/tattoo cleaned |
| f09 | red / short / athletic / elegant / no    | regen◐ | not a selfie now; athletic reads slim |
| f10 | brunette / short / slim / edgy / no       | regen  | (tattoo label fixed → none) |
| f11 | blonde / short / curvy / sporty / yes    | regen  | reference for "correct curvy" |
| f12 | red / long / athletic / elegant / yes    | kept   | |

## Males
| id  | attributes | status | note |
|-----|-----------|--------|------|
| m01 | dark / clean / lean / classic / no       | kept   | |
| m02 | light / beard / athletic / sporty / no   | kept   | |
| m03 | dark / beard / athletic / edgy / yes     | regen◐ | not a selfie now; reads lean not athletic |
| m04 | light / clean / athletic / classic / no  | regen  | (tattoo label fixed → none) |
| m05 | dark / beard / big / sporty / no          | regen◐ | big reads muscular; tiny pants logo |
| m06 | light / clean / lean / edgy / yes        | kept   | |
| m07 | dark / clean / athletic / sporty / yes   | regen  | (clothing text fixed) |
| m08 | light / beard / lean / classic / yes     | regen  | not a selfie now |
| m09 | dark / beard / lean / sporty / no         | regen  | (clothing text fixed) |
| m10 | light / clean / big / edgy / no          | kept   | |
| m11 | dark / clean / big / classic / yes       | regen  | big reference (fixed ethnicity) |
| m12 | light / beard / big / edgy / no          | kept   | |

## Assembly checklist (do this before deploy / band B/C)
1. In `band-A/`, replace the 16 regenerated frames (everything except the 8
   **kept**: f01,f05,f12,m01,m02,m06,m10,m12) with the accepted versions,
   saved under the exact `<id>.jpg` name — the id is the ONLY link to attributes.
2. Confirm 24 files, no stray old rejects, no mirror-selfie / text / wrong-build
   leftovers.
3. `regen◐` rows are accepted but are the first candidates to improve if, in
   shadow-mode data, the build axis (athletic vs slim) reads weak.

## Next
- Band B (29–37) + C (38–48): same 24 profiles, age descriptor swapped to
  32/33 and 42/43, reusing the finalized band-A prompts (curvy/big/no-text/
  no-mirror language already proven) → far fewer QC rounds expected.
- Then implementation: additive DB schema (Profile columns + `scoreType`) →
  radar routes → Mini App phase → `V_type` engine wiring. Pure math + dataset
  contract already shipped and unit-tested in `packages/shared/src/type-radar.ts`.
