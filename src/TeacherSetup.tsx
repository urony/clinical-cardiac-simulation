import { useState } from "react";
import { testConnection } from "../lib/ai-client";
import { buildClassLink, newClassId, validateConfig, type ClassConfig } from "../lib/class-link";
import { wizardLink } from "../lib/links";
import { getProvider, keyFormatWarning, providerLabel, providersForTeachers, type ModelRole } from "../lib/providers";

const roles: { role: ModelRole; label: string; explanation: string }[] = [
  { role: "classifier", label: "זיהוי השאלה", explanation: "מבין לאיזה פרטים בתיק המקרה מתייחסת שאלת התלמיד. נקרא בכל שאלה." },
  { role: "response", label: "תשובת המטופל", explanation: "מנסח את תשובת המטופל מתוך הפרטים שנבחרו. נקרא בכל שאלה." },
  { role: "feedback", label: "משוב", explanation: "כותב את המשוב לתלמיד בסוף הסימולציה." },
];
const DAY = 24 * 60 * 60 * 1000;
const expiryOptions = [{ days: 7, label: "שבוע" }, { days: 14, label: "שבועיים" }, { days: 30, label: "חודש" }, { days: 90, label: "3 חודשים" }, { days: 0, label: "ללא תפוגה" }];
const sortedProviders = providersForTeachers();

export default function TeacherSetup() {
  const [providerId, setProviderId] = useState(sortedProviders[0].id);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [className, setClassName] = useState("");
  const [model, setModel] = useState("");
  const [roleModels, setRoleModels] = useState<Partial<Record<ModelRole, string>>>({});
  const [maxCalls, setMaxCalls] = useState("200");
  const [maxPerMinute, setMaxPerMinute] = useState("20");
  const [maxTokens, setMaxTokens] = useState("");
  const [expiryDays, setExpiryDays] = useState(14);
  const [understood, setUnderstood] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const provider = getProvider(providerId)!;
  const wizardHref = wizardLink();
  const keyWarning = keyFormatWarning(provider, apiKey);

  /** One model for everything unless the teacher chose a different one for a specific part. */
  function chosenModels(): Partial<Record<ModelRole, string>> {
    const entries = roles.map(({ role }) => [role, (roleModels[role] ?? "").trim() || model.trim()] as const).filter(([, value]) => value);
    return Object.fromEntries(entries);
  }

  function buildConfig(): ClassConfig {
    return {
      version: 1, classId: newClassId(), providerId, apiKey: apiKey.trim(),
      models: chosenModels(),
      className: className.trim() || undefined,
      expiresAt: expiryDays ? Date.now() + expiryDays * DAY : undefined,
      maxCalls: maxCalls.trim() ? Number(maxCalls) : undefined,
      maxPerMinute: maxPerMinute.trim() ? Number(maxPerMinute) : undefined,
      maxOutputTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
    };
  }

  function createLink() {
    setError(""); setLink(""); setStatus("");
    const config = buildConfig();
    const problem = validateConfig(config);
    if (problem) { setError(problem); return; }
    setLink(buildClassLink(`${window.location.origin}${window.location.pathname}`, config));
  }

  async function check() {
    setError(""); setStatus(""); setBusy(true);
    try {
      await testConnection({ providerId, apiKey: apiKey.trim(), models: chosenModels() });
      setStatus("החיבור עובד: הספק, המפתח וכל המודלים שנבחרו אושרו.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "בדיקת החיבור נכשלה."); }
    finally { setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(link); setStatus("הקישור הועתק."); }
    catch { setStatus("לא ניתן להעתיק אוטומטית. סמנו את הקישור והעתיקו ידנית."); }
  }

  return <main className="clinic-shell setup">
    <header className="topbar"><div><p className="eyebrow">למורים</p><h1>הקמת כיתה</h1></div><a className="back" href="#">לסימולטור</a></header>
    <div className="panel">
      <p>הזינו מפתח API של ספק בינה מלאכותית, ותקבלו קישור לשליחה לתלמידים. התלמידים לא יצטרכו להזין או לראות מפתח בממשק. המפתח נשמר רק בקישור, לא בשרת שלנו.</p>
      {wizardHref && <p className="help-link">אין לכם מפתח API? <a className="text-link" href={wizardHref} target="_blank" rel="noopener noreferrer">אשף ההשגה צעד־אחר־צעד (נפתח בלשונית חדשה)</a>. אחרי שתקבלו מפתח, חזרו לכאן והדביקו אותו.</p>}
      <div className="notice-box">
        <b>לפני שיוצרים קישור: חשוב לדעת</b>
        <ul>
          <li><b>המפתח נכלל בקישור.</b> תלמיד שמבין בטכנולוגיה יכול לחלץ אותו ולהעתיק אותו.</li>
          <li><b>השתמשו במפתח נפרד לסימולטור</b>, עם מכסה או הוצאה מרבית והרשאות מוגבלות ככל שהספק מאפשר, או במפתח חינמי. בסוף היחידה אפשר למחוק או לבטל אותו.</li>
          <li><b>העלות והאחריות הן שלכם.</b> כל שימוש במפתח, גם של מי שהעתיק אותו, חל על החשבון שלכם אצל הספק.</li>
          <li><b>המגבלות כאן הן רכות:</b> הן נאכפות בדפדפן של התלמיד וניתן לעקוף אותן. ההגנה האמיתית היא המכסה שהוגדרה אצל הספק.</li>
          <li><b>שיחות התלמידים נשלחות לספק</b> שבחרתם. {provider.dataNotice} יש לוודא בתנאי הספק העדכניים. <span className="muted">(מידע נכון ל-17.10.2026)</span></li>
        </ul>
      </div>

      <label className="field">שם הכיתה (לא חובה)
        <input name="class-label" value={className} maxLength={60} onChange={(event) => setClassName(event.target.value)} placeholder="למשל: י׳ 2 ביולוגיה" autoComplete="off"/>
      </label>

      <label className="field">ספק בינה מלאכותית
        <select value={providerId} onChange={(event) => { setProviderId(event.target.value); setModel(""); setRoleModels({}); setLink(""); }}>
          {sortedProviders.map((item) => <option key={item.id} value={item.id}>{providerLabel(item)}</option>)}
        </select>
      </label>
      {provider.status === "untested" && <p className="warn">ספק זה הוגדר לפי התיעוד, אך עדיין לא נבדק מול השירות האמיתי. השתמשו ב״בדוק חיבור״ ובצעו ניסיון לפני שליחה לתלמידים.</p>}
      {provider.lowFreeQuota && <p className="warn">המכסה החינמית של ספק זה נגמרה מהר בניסוי. לכיתה שלמה כדאי לשקול ספק אחר או מסלול בתשלום.</p>}
      {provider.notes && <p className="muted">{provider.notes}</p>}

      <label className="field">מפתח API
        <span className="row">
          {/* A text field drawn as dots: browsers treat password fields as logins and offer saved passwords. */}
          <input className={showKey ? "" : "secret-input"} type="text" name="class-secret-value" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setLink(""); }}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} dir="ltr" data-lpignore="true" data-1p-ignore="true" data-form-type="other"/>
          <button type="button" className="back" onClick={() => setShowKey(!showKey)}>{showKey ? "הסתר" : "הצג"}</button>
        </span>
      </label>
      {keyWarning && <p className="warn" role="alert">{keyWarning}</p>}

      <label className="field">מודל (לא חובה)
        <input name="class-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider.defaultModels.response} dir="ltr" autoComplete="off"/>
      </label>
      <p className="muted">ריק = המודלים המומלצים של הספק. אם תכתבו שם מודל, הוא ישמש לכל חלקי הסימולציה. רשימת המודלים אינה בדיקה פדגוגית או קלינית, ומפתח במסלול חינמי עשוי לעבוד רק עם מודלים מסוימים.</p>
      <details className="models"><summary>מתקדם: מודל נפרד לכל חלק בסימולציה</summary>
        {roles.map(({ role, label, explanation }) => <label className="field" key={role}>{label}
          <span className="muted">{explanation}</span>
          <input name={`class-model-${role}`} value={roleModels[role] ?? ""} onChange={(event) => setRoleModels({ ...roleModels, [role]: event.target.value })} placeholder={model.trim() || provider.defaultModels[role]} dir="ltr" autoComplete="off"/>
        </label>)}
      </details>

      <fieldset className="models"><legend>הגבלות (רכות)</legend>
        <label className="field">מספר פניות AI מרבי לכל תלמיד (שאלה אחת בדרך כלל דורשת 2 פניות; ריק = ללא הגבלה)
          <input type="number" min={1} value={maxCalls} onChange={(event) => setMaxCalls(event.target.value)} dir="ltr"/>
        </label>
        <label className="field">קצב: מספר פניות AI מרבי לדקה בכל תלמיד (ריק = ללא הגבלה)
          <input type="number" min={1} max={600} value={maxPerMinute} onChange={(event) => setMaxPerMinute(event.target.value)} dir="ltr"/>
        </label>
        <label className="field">אורך תשובה מרבי בטוקנים (ריק = ברירת מחדל)
          <input type="number" min={100} max={8000} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} dir="ltr"/>
        </label>
        <label className="field">תוקף הקישור
          <select value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>{expiryOptions.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}</select>
        </label>
      </fieldset>

      <label className="check"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)}/> קראתי והבנתי: המפתח ייחשף בקישור, והעלות והאחריות עליי.</label>

      <div className="actions">
        <button type="button" className="back" disabled={busy || !apiKey.trim()} onClick={check}>{busy ? "בודק…" : "בדוק חיבור (שולח בקשה קצרה לספק)"}</button>
        <button type="button" className="primary" disabled={!understood || !apiKey.trim()} onClick={createLink}>צור קישור כיתה</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="save-status" role="status">{status}</p>}

      {link && <div className="link-box">
        <b>קישור הכיתה</b>
        <p className="muted">שלחו לתלמידים את הקישור בלבד. אל תפרסמו אותו ברבים.</p>
        <textarea readOnly rows={4} value={link} dir="ltr" onFocus={(event) => event.currentTarget.select()}/>
        <button type="button" className="primary" onClick={copy}>העתק קישור</button>
      </div>}
    </div>
  </main>;
}
