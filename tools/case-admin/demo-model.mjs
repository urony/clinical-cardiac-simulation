// A stand-in "model" for trying the admin interface without an API key or any cost (`npm run admin -- --demo`).
// Its content is meaningless dummy text, so cases created in demo mode can never be published.
import { IMPORTANCE } from "../case-tool/case-validation.mjs";

const META = {
  "ראשי תיבות מטופל": "ד׳ ד׳",
  "גיל": "50",
  "מין": "גבר",
  "אבחנה ידועה למערכת": "מחלת דוגמה",
  "נוסח פתיחה לתלמיד": "ד׳ ד׳, גבר בן 50, פונה בשל תלונה לדוגמה.",
};

export async function demoComplete(request) {
  const columns = request.json.schema.properties.items.items.properties.fields.required;
  const listed = JSON.parse(request.user.split("הפריטים (החזר פריט אחד לכל מזהה):\n")[1].split("\n\n")[0]);
  const items = listed.map((item, index) => {
    const flagged = index % 7 === 3;
    return {
      id: item.id,
      fields: Object.fromEntries(columns.map((column) => [column, column === "חשיבות במקרה" ? IMPORTANCE[index % IMPORTANCE.length] : column === "ערך" && META[item.id] ? META[item.id] : column === "ערך" && /^IT-/.test(item.id) ? String(10 + index) : `[דוגמה] ${column} (${item.label || item.id})`])),
      needsReview: flagged,
      note: flagged ? "פריט דוגמה שסומן לבדיקה, כדי לנסות את מסך הסקירה" : "",
    };
  });
  return JSON.stringify({ items });
}
