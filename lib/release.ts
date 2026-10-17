/**
 * Results of follow-up tests (Holter, stress test, ...) take time: the student sees them only from the
 * "results" stage onward. Until then they must not appear in the patient's file, the medical record
 * defaults, the interim report, or the interim feedback.
 */
export const FOLLOWUP_AREA = "בדיקות המשך";

export const FOLLOWUP_WAIT_MESSAGE =
  "הבדיקות בדרך ולוקחות זמן, והתוצאות יגיעו בהמשך. עבור לשלב הבא והמשך לחשוב ולקבל החלטות לפי מה שיש לך עכשיו, עד שיגיעו הבדיקות המתקדמות.";

export function releasedResults<T extends { area: string }>(results: T[], followupReleased: boolean): T[] {
  return followupReleased ? results : results.filter((result) => result.area !== FOLLOWUP_AREA);
}
