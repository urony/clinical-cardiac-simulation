import { useState } from "react";
import { testConnection } from "../lib/ai-client";
import { buildClassLink, newClassId, validateConfig, type ClassConfig } from "../lib/class-link";
import { wizardLink } from "../lib/links";
import { DEFAULT_PROVIDER_ID, getProvider, providers, type ModelRole } from "../lib/providers";

const roleLabels: Record<ModelRole, string> = { classifier: "זיהוי השאלה", response: "תשובת המטופל", feedback: "משוב" };
const DAY = 24 * 60 * 60 * 1000;
const expiryOptions = [{ days: 7, label: "שבוע" }, { days: 14, label: "שבועיים" }, { days: 30, label: "חודש" }, { days: 90, label: "3 חודשים" }, { days: 0, label: "ללא תפוגה" }];

export default function TeacherSetup() {
  const [providerId, setProviderId] = useState(DEFAULT_PROVIDER_ID);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [className, setClassName] = useState("");
  const [models, setModels] = useState<Partial<Record<ModelRole, string>>>({});
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

  function buildConfig(): ClassConfig {
    return {
      version: 1, classId: newClassId(), providerId, apiKey: apiKey.trim(),
      models: Object.fromEntries(Object.entries(models).filter(([, value]) => value?.trim()).map(([role, value]) => [role, value!.trim()])),
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
      await testConnection({ providerId, apiKey: apiKey.trim(), models });
      setStatus("החיבור עובד: הספק, המודל והמפתח אושרו.");
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
      {wizardHref && <p className="help-link">אין לכם מפתח API? <a href={wizardHref} target="_blank" rel="noopener noreferrer">אשף ההשגה צעד־אחר־צעד (נפתח בלשונית חדשה)</a>. אחרי שתקבלו מפתח, חזרו לכאן והדביקו אותו.</p>}
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
        <input value={className} maxLength={60} onChange={(event) => setClassName(event.target.value)} placeholder="למשל: י׳ 2 ביולוגיה"/>
      </label>

      <label className="field">ספק בינה מלאכותית
        <select value={providerId} onChange={(event) => { setProviderId(event.target.value); setModels({}); setLink(""); }}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.status === "untested" ? " (לא נבדק)" : ""}</option>)}
        </select>
      </label>
      {provider.status === "untested" && <p className="warn">ספק זה הוגדר לפי התיעוד, אך עדיין לא נבדק מול השירות האמיתי. השתמשו ב״בדוק חיבור״ ובצעו ניסיון לפני שליחה לתלמידים.</p>}
      {provider.notes && <p className="muted">{provider.notes}</p>}

      <label className="field">מפתח API
        <span className="row"><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setLink(""); }} autoComplete="off" spellCheck={false} dir="ltr"/><button type="button" className="back" onClick={() => setShowKey(!showKey)}>{showKey ? "הסתר" : "הצג"}</button></span>
      </label>

      <fieldset className="models"><legend>מודלים (ברירת המחדל מומלצת ואפשר לשנות)</legend>
        {(Object.keys(roleLabels) as ModelRole[]).map((role) => <label className="field" key={role}>{roleLabels[role]}
          <input value={models[role] ?? ""} onChange={(event) => setModels({ ...models, [role]: event.target.value })} placeholder={provider.defaultModels[role]} dir="ltr"/>
        </label>)}
        <p className="muted">רשימת המודלים אינה בדיקה פדגוגית או קלינית. מפתח במסלול חינמי עשוי לעבוד רק עם מודלים מסוימים.</p>
      </fieldset>

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
