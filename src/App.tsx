"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { availableCases, catalogEntry, type CaseId } from "../lib/case-catalog";
import { loadCase } from "../lib/case-loader";
import { generateFeedback } from "../lib/feedback";
import { DEFAULT_PROVIDER_ID } from "../lib/providers";
import { loadSession, saveSession } from "../lib/session-store";
import { runSimulationStep, type SimulationRequest } from "../lib/simulation";

type Stage = "welcome" | "picture" | "anamnesis" | "examination" | "immediateTests" | "rationale1" | "diagnosis" | "followupTests" | "interim" | "results" | "rationale2" | "decision" | "record" | "explanation" | "feedback";
type Action = { id: string; label: string; area: string };
type Result = { id: string; label: string; answer: string; area: string };
type Message = { role: string; text: string };
type Rationale = { action: Action; answer: string };
type FeedbackDomain = { good: string[]; reconsider: string[] };
type Feedback = Record<string, FeedbackDomain>;
const stages: { id: Stage; title: string }[] = [
  ["welcome", "פתיחה"], ["picture", "תמונת פתיחה"], ["anamnesis", "אנמנזה"], ["examination", "בדיקה גופנית"], ["immediateTests", "בדיקות בסיסיות"],
  ["rationale1", "הנמקות א׳"], ["diagnosis", "אבחנה ראשונית"], ["followupTests", "בדיקות המשך"], ["interim", "פעולת ביניים"], ["results", "תוצאות"],
  ["rationale2", "הנמקות ב׳"], ["decision", "החלטה סופית"], ["record", "רשומה רפואית"], ["explanation", "הסבר למטופל"], ["feedback", "משוב ודוח"],
].map(([id, title]) => ({ id: id as Stage, title }));

const introductions: Partial<Record<Stage, string>> = {
  welcome: "סימולציה לימודית בלבד. אין ציונים או רמזים בזמן אמת; המשוב יופיע רק בדוח.",
  picture: "זהו המידע הראשוני בלבד. מכאן מתחילים את האנמנזה.",
  anamnesis: "שאל שאלות חופשיות את המטופל. אפשר לחזור לשלב הזה גם בהמשך הבירור הראשוני.",
  examination: "תאר מה תרצה לבדוק. אפשר לחזור גם לשלב זה עד לסיום הבדיקות הבסיסיות.",
  immediateTests: "בקש בדיקות בחופשיות. לדוגמה: „אבקש אק״ג, ספירת דם וכימיה בדם”. לפני התוצאות תראה אילו בדיקות זוהו ותאשר אותן.",
  diagnosis: "כתוב אבחנה מובילה, אבחנות מבדלות, ומה הנתונים שעליהם התבססת.",
  followupTests: "בקש בדיקות המשך נחוצות. לדוגמה: „אבקש אקו לב במאמץ”. תוצאותיהן יופיעו רק לאחר פעולת הביניים.",
  interim: "החלט מה לעשות עד לתוצאות: לשחרר לביתו או להפנות לבית חולים. נמק והצע טיפול ברור כעת.",
  results: "חלף שבוע בסימולציה. כאן מופיעות רק תוצאות בדיקות ההמשך שאישרת קודם.",
  decision: "כתוב רק את האבחנה הסופית ואת השינוי, אם ישנו, בהמלצות או בטיפול.",
  record: "זהו גיליון רפואי. הפרטים והבדיקות ממולאים עבורך; השלם רק את החשיבה והטיפול שלך.",
  explanation: "הסבר למטופל בשפה פשוטה. אפשר לכתוב, או להקליט: ההקלטה תתומלל ותוכל לערוך את התמלול לפני אישור.",
};

const fields: Partial<Record<Stage, string[]>> = {
  diagnosis: ["אבחנה מובילה", "אבחנות מבדלות", "הבסיס לחשיבה"],
  interim: ["החלטה עד לתוצאות", "הנמקה", "טיפול והמלצות כעת"],
  decision: ["מהי האבחנה הסופית שלך?", "האם אתה משנה משהו בהמלצות או בטיפול שהצעת קודם? אם כן — מה ולמה?"],
  record: ["פרטים כלליים", "מחלות עבר ותרופות", "תלונה עיקרית ואנמנזה", "בדיקה גופנית", "בדיקות ותוצאות", "אבחנה מובילה ואבחנה מבדלת", "טיפול והמלצות"],
};
const recordFieldNames = fields.record || [];

const phaseFor = (stage: Stage) => stage === "anamnesis" ? "anamnesis" : stage === "examination" ? "examination" : stage === "immediateTests" ? "immediateTests" : "followupTests";
const areaFor = (stage: Stage) => stage === "anamnesis" ? "אנמנזה" : stage === "examination" ? "בדיקה גופנית" : stage === "immediateTests" ? "בדיקות בסיסיות" : "בדיקות המשך";

export default function Home() {
  const [code, setCode] = useState("SIM-XXXXXX");
  const [caseId, setCaseId] = useState<CaseId>(availableCases[0].id);
  const [key, setKey] = useState("");
  const [stage, setStage] = useState<Stage>("welcome");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stageNotice, setStageNotice] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [pending, setPending] = useState<Action[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [rationale1, setRationale1] = useState<Rationale[]>([]);
  const [rationale2, setRationale2] = useState<Rationale[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [transcript, setTranscript] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [restore, setRestore] = useState("");
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState("");
  const [printRequested, setPrintRequested] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<{ stop: () => void } | null>(null);
  const chunks = useRef<Blob[]>([]);
  const index = stages.findIndex((item) => item.id === stage);
  const current = stages[index];
  const meta = catalogEntry(caseId);

  useEffect(() => {
    const existing = localStorage.getItem("clinical-sim-code");
    if (existing) {
      // localStorage is unavailable during SSR, so the saved code can only be applied after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCode(existing);
      return;
    }
    // Some browsers and embedded Site runtimes do not expose crypto.randomUUID.
    // A short local recovery code does not need cryptographic randomness.
    const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Array.from({ length: 10 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    setCode(`SIM-${token.toUpperCase()}`);
  }, []);
  useEffect(() => {
    if (code !== "SIM-XXXXXX") localStorage.setItem("clinical-sim-code", code);
  }, [code]);
  useEffect(() => {
    if (!printRequested || !feedback) return;
    // One-shot flag: reset it before opening the print dialog.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrintRequested(false);
    window.setTimeout(() => window.print(), 0);
  }, [printRequested, feedback]);
  useEffect(() => {
    if (stage === "welcome") return;
    const snapshot = { caseId, stage, messages, actions, results, rationale1, rationale2, form, transcript, feedback, completed: stage === "feedback" };
    const timer = setTimeout(() => {
      try { saveSession(code, snapshot); setNotice("ההתקדמות נשמרה בדפדפן הזה."); }
      catch { setNotice("השמירה אינה זמינה כרגע."); }
    }, 900);
    return () => clearTimeout(timer);
  }, [code, caseId, stage, messages, actions, results, rationale1, rationale2, form, transcript, feedback]);
  async function restoreSession() {
    try {
      const saved = loadSession(restore) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (saved.caseId && availableCases.some((item) => item.id === saved.caseId)) setCaseId(saved.caseId as CaseId);
      setStage(saved.stage); setMessages(saved.messages || []); setActions(saved.actions || []); setResults(saved.results || []); setRationale1(saved.rationale1 || []); setRationale2(saved.rationale2 || []); setForm(saved.form || {}); setTranscript(saved.transcript || ""); setFeedback(saved.feedback || null);
      setNotice("הסימולציה שוחזרה.");
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "לא ניתן לשחזר את הסימולציה."); }
  }
  function transition(to: Stage) {
    setStage(to);
    setStageNotice(`השלב הושלם. כעת אתה בשלב: ${stages.find((item) => item.id === to)?.title ?? "השלב הבא"}.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function goBack() { if (["anamnesis", "examination", "immediateTests"].includes(stage) && index > 2) setStage(stages[index - 1].id); }
  function storeActions(items: Action[]) { setActions((old) => [...old, ...items.filter((item) => !old.some((existing) => existing.id === item.id && existing.area === item.area))]); }

  async function step(request: SimulationRequest) {
    return runSimulationStep({ config: { providerId: DEFAULT_PROVIDER_ID, apiKey: key }, entry: catalogEntry(caseId), caseFile: await loadCase(caseId) }, request);
  }
  async function ask(event: FormEvent) {
    event.preventDefault(); if (!question.trim() || !key) return;
    const text = question.trim(); setQuestion(""); setBusy(true); setError("");
    try {
      const phase = phaseFor(stage);
      if (stage === "immediateTests" || stage === "followupTests") {
        const data = await step({ phase, question: text, mode: "recognize" });
        const found = (data.recognized || []).map((item: { id: string; label: string }) => ({ ...item, area: areaFor(stage) }));
        setPending(found); setSelected(found.map((item: Action) => item.id));
      } else {
        setMessages((old) => [...old, { role: "הרופא", text }]);
        const data = await step({ phase, question: text });
        setMessages((old) => [...old, { role: stage === "anamnesis" ? "המטופל" : "המערכת", text: data.answer ?? "" }]);
        storeActions((data.matchedActions || []).map((item: { id: string; label: string }) => ({ ...item, area: areaFor(stage) })));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "לא התקבלה תשובה."); }
    finally { setBusy(false); }
  }
  async function executeTests() {
    if (!pending) return; setBusy(true); setError("");
    try {
      const data = await step({ phase: phaseFor(stage), question: "בצע את הבדיקות שאושרו", mode: "execute", selectedIds: selected });
      const approved = pending.filter((item) => selected.includes(item.id));
      storeActions(approved);
      setResults((old) => [...old, ...(data.results || []).map((item: { id: string; label: string; answer: string }) => ({ ...item, area: areaFor(stage) }))]);
      setMessages((old) => [...old, { role: "המערכת", text: stage === "immediateTests" ? "התוצאות מוצגות כעת בתיק הבדיקות." : "הבקשות אושרו. התוצאות יופיעו לאחר פעולת הביניים." }]);
      setPending(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "לא ניתן להציג תוצאות."); }
    finally { setBusy(false); }
  }
  function prepareRationales(first: boolean) {
    // Ask about work the learner actually performed, but never make the first
    // recorded item (often “why did you come now?”) a privileged question.
    // The random draw keeps the representative's questions varied between
    // runs while retaining one example from every relevant domain.
    const randomItems = (area: string, amount: number) => actions
      .filter((item, pos, list) => item.area === area && list.findIndex((other) => other.id === item.id) === pos)
      .filter((item) => item.id !== "AN-006" && item.id !== "AN-008")
      .sort(() => Math.random() - 0.5)
      .slice(0, amount);
    const picked = first ? [...randomItems("אנמנזה", 1), ...randomItems("בדיקה גופנית", 1), ...randomItems("בדיקות בסיסיות", 3)].slice(0, 5) : randomItems("בדיקות המשך", 2);
    const values = picked.map((action) => ({ action, answer: "" }));
    if (first) setRationale1(values); else setRationale2(values);
  }
  const testSummary = results.map((item) => `${item.label}: ${item.answer.replace(/; /g, " | ")}`).join("\n");
  const recordDefaults = {
    "פרטים כלליים": `${meta.initials}, ${meta.sex}, בן/בת ${meta.age}.`,
    "בדיקות ותוצאות": testSummary || "לא תועדו עדיין בדיקות שאושרו.",
  };
  async function createFeedback(printAfter = false, reportType: "ביניים" | "סופי" = "סופי") {
    if (!key) { setError("יש להכניס מפתח API כדי להפיק משוב."); return false; }
    setBusy(true); setError(""); setPrintRequested(printAfter);
    try {
      setFeedback(await generateFeedback({ providerId: DEFAULT_PROVIDER_ID, apiKey: key }, await loadCase(caseId), { caseId, stage, actions, results, rationale1, rationale2, form, transcript, reportType }));
      return true;
    } catch (caught) { setPrintRequested(false); setError(caught instanceof Error ? caught.message : "לא ניתן להפיק משוב."); }
    finally { setBusy(false); }
    return false;
  }
  function printFinalReport() {
    if (feedback) {
      setPrintRequested(true);
      return;
    }
    void createFeedback(true, "סופי");
  }
  function printInterimReport() {
    // This report is a printable snapshot of local work. It does not require
    // an AI response, so it remains available even when feedback is pending.
    setError("");
    window.setTimeout(() => window.print(), 0);
  }
  function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const media = new MediaRecorder(stream); recorder.current = media; chunks.current = [];
      media.ondataavailable = (event) => chunks.current.push(event.data);
      media.onstop = () => { setAudio(URL.createObjectURL(new Blob(chunks.current, { type: "audio/webm" }))); stream.getTracks().forEach((track) => track.stop()); };
      media.start();
      const BrowserWindow = window as unknown as { SpeechRecognition?: new () => { lang: string; continuous: boolean; interimResults: boolean; onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void; start: () => void; stop: () => void }; webkitSpeechRecognition?: new () => { lang: string; continuous: boolean; interimResults: boolean; onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void; start: () => void; stop: () => void } };
      const Speech = BrowserWindow.SpeechRecognition || BrowserWindow.webkitSpeechRecognition;
      if (Speech) { const listener = new Speech(); listener.lang = "he-IL"; listener.continuous = true; listener.interimResults = false; listener.onresult = (event) => { let words = ""; for (let pos = event.resultIndex; pos < event.results.length; pos += 1) words += event.results[pos][0].transcript; if (words) setTranscript((old) => `${old}${old ? " " : ""}${words}`); }; listener.start(); recognition.current = listener; }
      else setNotice("ההקלטה נשמרת, אך תמלול אוטומטי אינו זמין בדפדפן זה. יש לכתוב את ההסבר ידנית.");
      setRecording(true);
    }).catch(() => setError("לא ניתן להפעיל את המיקרופון. אפשר לכתוב את ההסבר ידנית."));
  }
  function stopRecording() { recorder.current?.stop(); recognition.current?.stop(); recognition.current = null; setRecording(false); }
  function chooseCase(id: CaseId) {
    if (stage !== "welcome") return;
    setCaseId(id); setMessages([]); setActions([]); setResults([]); setPending(null); setSelected([]); setRationale1([]); setRationale2([]); setForm({}); setTranscript(""); setFeedback(null); setError(""); setNotice("");
  }
  const visibleResults = stage === "immediateTests" ? results.filter((item) => item.area === "בדיקות בסיסיות") : stage === "results" ? results.filter((item) => item.area === "בדיקות המשך") : [];

  return <main className="clinic-shell">
    <header className="topbar"><div><p className="eyebrow">סימולציה קלינית לימודית · {meta.id}</p><h1>המרפאה הקרדיולוגית הווירטואלית</h1></div><div className="case-chip"><span>קוד תלמיד</span><strong>{code}</strong><small>לשחזור עד 14 יום</small><div className="restore"><input value={restore} onChange={(event) => setRestore(event.target.value.toUpperCase())} placeholder="SIM-XXXXXX"/><button onClick={restoreSession}>שחזור</button></div></div></header>
    {stageNotice && <p className="stage-status">{stageNotice}</p>}{notice && <p className="save-status">{notice}</p>}
    <nav className="progress">{stages.map((item, pos) => <span key={item.id} className={pos === index ? "active" : pos < index ? "done" : ""}>{pos + 1}. {item.title}</span>)}</nav>
    <div className="workspace"><aside className="patient-card"><div className="avatar">{meta.initials.slice(0, 1)}</div><p className="card-label">פניית המטופל · {meta.id}</p><h2>{meta.initials}</h2><p>{availableCases.find((item) => item.id === caseId)?.demographics}</p><p><b>תלונה מרכזית:</b> {availableCases.find((item) => item.id === caseId)?.chiefComplaint}</p><div className="rule"/><TestFile results={results}/>{stage !== "feedback" && <button className="finish" onClick={printInterimReport}>הדפס / שמור דוח PDF ביניים</button>}</aside>
      <section className="conversation"><div className="conversation-heading"><div><p className="card-label">שלב {index + 1} מתוך {stages.length}</p><h2>{current.title}</h2></div>{["anamnesis", "examination", "immediateTests"].includes(stage) && index > 2 && <button className="back" onClick={goBack}>חזרה לשלב הקודם</button>}</div>
        {!key && stage !== "welcome" && <div className="pilot-key"><strong>חיבור AI</strong><p>הדבק את מפתח ה־API כדי להפעיל את הסימולציה. המפתח אינו מוצג בדוח ואינו נשמר בקוד.</p><input type="password" value={key} onChange={(event) => setKey(event.target.value.trim())} placeholder="sk-proj-…"/></div>}
        {introductions[stage] && <div className="stage-intro">{introductions[stage]}</div>}
        {stage === "welcome" && <Welcome caseId={caseId} chooseCase={chooseCase} next={() => transition("picture")}/>} {stage === "picture" && <Picture demographics={availableCases.find((item) => item.id === caseId)?.demographics || ""} chiefComplaint={availableCases.find((item) => item.id === caseId)?.chiefComplaint || ""} next={() => transition("anamnesis")}/>} 
        {(["anamnesis", "examination"] as Stage[]).includes(stage) && <><Chat messages={messages}/><Ask question={question} setQuestion={setQuestion} label={stage === "anamnesis" ? "מה תרצה לשאול את המטופל?" : "איזו בדיקה גופנית תרצה לבצע?"} ask={ask} busy={busy} disabled={!key} error={error}/><button className="finish stage-finish" onClick={() => transition(stages[index + 1].id)}>סיימתי שלב זה</button></>}
        {(["immediateTests", "followupTests"] as Stage[]).includes(stage) && <><Chat messages={messages}/><Ask question={question} setQuestion={setQuestion} label="איזו בדיקה תרצה לבקש?" ask={ask} busy={busy} disabled={!key} error={error}/>{pending && <ConfirmTests items={pending} selected={selected} setSelected={setSelected} execute={executeTests}/>}<ResultCards results={visibleResults}/><button className="finish stage-finish" onClick={() => { if (stage === "immediateTests") { prepareRationales(true); transition("rationale1"); } else transition("interim"); }}>סיימתי לבקש בדיקות</button></>}
        {stage === "rationale1" && <Rationales items={rationale1} setItems={setRationale1} title="פרופ׳ שחף מבקשת הנמקות" intro="פרופ׳ שחף, נציגת קופת החולים, מבקשת להבין את ההיגיון הרפואי מאחורי פעולות שביצעת." prompt={(action) => `ביצעת ${action.label}. מה היה ההיגיון הרפואי מאחורי פעולה זו במקרה הזה?`} next={() => transition("diagnosis")}/>} 
        {stage === "diagnosis" && <FormFields fields={fields.diagnosis || []} form={form} setForm={setForm} next={() => transition("followupTests")}/>} 
        {stage === "interim" && <FormFields fields={fields.interim || []} form={form} setForm={setForm} hints={{ "החלטה עד לתוצאות": "האם לשחרר לביתו עד לתוצאות, או להפנות לבית חולים?", "הנמקה": "הסבר בקצרה מדוע בחרת בכך.", "טיפול והמלצות כעת": "מה ייעשה כעת ומה ייאמר למטופל?" }} next={() => transition("results")}/>} 
        {stage === "results" && <div className="panel"><ResultCards results={visibleResults}/><button className="primary" onClick={() => { prepareRationales(false); transition("rationale2"); }}>המשך להנמקות</button></div>}
        {stage === "rationale2" && <Rationales items={rationale2} setItems={setRationale2} title="פרופ׳ שחף: הנמקות לבדיקות המשך" intro="הסבר מדוע שלחת כל בדיקה וכיצד תוצאתה השפיעה על האבחנה." prompt={(action) => `בחרת ${action.label}. מדוע שלחת לבדיקה זו וכיצד תוצאתה משפיעה על האבחנה?`} next={() => transition("decision")}/>} 
        {stage === "decision" && <FormFields fields={fields.decision || []} form={form} setForm={setForm} next={() => transition("record")}/>} 
        {stage === "record" && <FormFields fields={fields.record || []} form={{ ...recordDefaults, ...form }} setForm={setForm} readonly={Object.keys(recordDefaults)} next={() => transition("explanation")}/>} 
        {stage === "explanation" && <div className="panel"><label className="record-control"><b>הסבר כתוב / תמלול מאושר</b><textarea rows={8} value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="הסבר למטופל בשפה פשוטה…"/></label><div className="audio-controls">{!recording ? <button className="back" onClick={startRecording}>התחל הקלטה</button> : <button className="danger" onClick={stopRecording}>עצור הקלטה</button>}{audio && <><audio controls src={audio}/><a href={audio} download="הסבר-למטופל.webm">הורד הקלטה</a></>}</div><button className="primary" disabled={busy} onClick={async () => { if (await createFeedback()) transition("feedback"); }}>{busy ? "מפיקים משוב…" : "אשר והפק משוב"}</button>{error && <p className="error">{error}</p>}</div>}
        {stage === "feedback" && <FeedbackView feedback={feedback} busy={busy} regenerate={() => void createFeedback()} print={printFinalReport}/>} 
      </section></div>
    <PrintableReport code={code} stage={stage} messages={messages} actions={actions} results={results} rationale1={rationale1} rationale2={rationale2} form={{ ...recordDefaults, ...form }} transcript={transcript} feedback={feedback}/>
  </main>;
}

function Welcome({ caseId, chooseCase, next }: { caseId: CaseId; chooseCase: (id: CaseId) => void; next: () => void }) { const selected = availableCases.find((item) => item.id === caseId); return <div className="panel"><h3>מי מחכה לך במיון?</h3><p>בחר למי לגשת. בשלב זה מוצגים רק פרטים אישיים בסיסיים והתלונה המרכזית.</p><div className="case-options">{availableCases.map((item) => <button type="button" className={item.id === caseId ? "case-option selected" : "case-option"} onClick={() => chooseCase(item.id)} key={item.id}><b>{item.demographics}</b><span>תלונה מרכזית: {item.chiefComplaint}</span></button>)}</div><button className="primary" onClick={next}>גש אל {selected?.demographics}</button></div>; }
function Picture({ demographics, chiefComplaint, next }: { demographics: string; chiefComplaint: string; next: () => void }) { return <div className="panel"><h3>פניית המטופל</h3><p><b>{demographics}</b></p><p><b>תלונה מרכזית:</b> {chiefComplaint}</p><p>מכאן מתחילים באנמנזה. המטופל ימסור מידע נוסף רק בתגובה לשאלותיך.</p><button className="primary" onClick={next}>התחל אנמנזה</button></div>; }
function Chat({ messages }: { messages: Message[] }) { return <div className="messages">{messages.map((message, index) => <div className={`message ${message.role === "המטופל" ? "patient" : message.role === "הרופא" ? "student" : "system"}`} key={`${message.role}-${index}`}><span>{message.role}</span><p>{message.text}</p></div>)}</div>; }
function Ask({ question, setQuestion, label, ask, busy, disabled, error }: { question: string; setQuestion: (value: string) => void; label: string; ask: (event: FormEvent) => void; busy: boolean; disabled: boolean; error: string }) { return <form className="ask-form" onSubmit={ask}><label>{label}</label><div className="input-row"><textarea rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy || disabled}/><button disabled={busy || disabled || !question.trim()}>שלח</button></div>{error && <p className="error">{error}</p>}</form>; }
function ConfirmTests({ items, selected, setSelected, execute }: { items: Action[]; selected: string[]; setSelected: (value: string[]) => void; execute: () => void }) { return <div className="confirm"><b>הבנתי שביקשת:</b>{items.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}/>{item.label}</label>)}<button className="primary" onClick={execute}>אשר</button></div>; }
function ResultCards({ results }: { results: Result[] }) { return results.length ? <div className="result-list"><h3>תוצאות שהתקבלו</h3>{results.map((result) => <article key={`${result.area}-${result.id}`}><h4>{result.label}</h4>{result.answer.split("; ").map((line) => <p key={line}>{line}</p>)}</article>)}</div> : null; }
function TestFile({ results }: { results: Result[] }) { return <details className="test-file"><summary>תיק הבדיקות ({results.length})</summary>{results.length ? results.map((result) => <p key={`${result.area}-${result.id}`}><b>{result.label}</b><br/>{result.answer.replace(/; /g, " · ")}</p>) : <p>עדיין אין תוצאות בתיק.</p>}</details>; }
function Rationales({ items, setItems, title, intro, prompt, next }: { items: Rationale[]; setItems: (value: Rationale[]) => void; title: string; intro: string; prompt: (action: Action) => string; next: () => void }) { return <div className="panel rationale"><h3>{title}</h3><div className="professor"><b>פרופ׳ שחף · קופת החולים</b><p>{intro}</p></div>{items.length ? items.map((item, index) => <div className="rationale-question" key={`${item.action.id}-${index}`}><p><b>{prompt(item.action)}</b></p><textarea rows={4} value={item.answer} onChange={(event) => setItems(items.map((other, pos) => pos === index ? { ...other, answer: event.target.value } : other))}/></div>) : <p>לא תועדו פעולות מתאימות לתשאול בשלב זה. הדבר יקבל התייחסות במשוב.</p>}<button className="primary" onClick={next}>שמור והמשך</button></div>; }
function FormFields({ fields, form, setForm, readonly = [], hints = {}, next }: { fields: string[]; form: Record<string, string>; setForm: (value: Record<string, string>) => void; readonly?: string[]; hints?: Record<string, string>; next: () => void }) { return <div className="summary-form">{fields.map((field) => <label key={field}>{field}{hints[field] && <span>{hints[field]}</span>}<textarea rows={4} readOnly={readonly.includes(field)} value={form[field] || ""} onChange={(event) => setForm({ ...form, [field]: event.target.value })}/></label>)}<button className="primary" onClick={next}>שמור והמשך</button></div>; }
function FeedbackView({ feedback, busy, regenerate, print }: { feedback: Feedback | null; busy: boolean; regenerate: () => void; print: () => void }) { return <div className="panel feedback"><h3>משוב איכותני</h3>{busy ? <p>פרופ׳ שחף מכינה משוב. הדוח ייפתח אוטומטית כשתבקש הדפסה לאחר סיום ההפקה.</p> : feedback ? Object.entries(feedback).map(([heading, domain]) => <section key={heading}><h4>{heading}</h4><b>מה נעשה היטב</b><ul>{domain.good.map((line) => <li key={line}>{line}</li>)}</ul><b>מה חשוב לשקול מחדש</b><ul>{domain.reconsider.map((line) => <li key={line}>{line}</li>)}</ul></section>) : <p>המשוב טרם הופק.</p>}<button className="back" disabled={busy} onClick={regenerate}>הפק/עדכן משוב</button><button className="print" disabled={busy} onClick={print}>{busy ? "מפיקים דוח…" : "הדפס / שמור PDF סופי"}</button></div>; }
function professorQuestion(item: Rationale) { return item.action.area === "בדיקות המשך" ? `בחרת ${item.action.label}. מדוע שלחת לבדיקה זו וכיצד תוצאתה השפיעה על האבחנה?` : `ביצעת ${item.action.label}. מה היה ההיגיון הרפואי מאחורי פעולה זו במקרה הזה?`; }
function PrintableReport({ code, stage, messages, actions, results, rationale1, rationale2, form, transcript, feedback }: { code: string; stage: Stage; messages: Message[]; actions: Action[]; results: Result[]; rationale1: Rationale[]; rationale2: Rationale[]; form: Record<string, string>; transcript: string; feedback: Feedback | null }) { const record = recordFieldNames.map((label) => [label, form[label] || "לא מולא"] as const); const otherAnswers = Object.entries(form).filter(([label]) => !recordFieldNames.includes(label)); return <section className="print-report"><h1>המרפאה הקרדיולוגית הווירטואלית</h1><p>דוח {stage === "feedback" ? "סופי" : "ביניים"} · קוד תלמיד: {code}</p><h2>תמליל הפעילות</h2>{messages.length ? messages.map((message, index) => <p key={index}><b>{message.role}:</b> {message.text}</p>) : <p>לא תועד תמליל בשלב זה.</p>}<h2>פעולות ובדיקות שבוצעו</h2>{actions.map((action) => <p key={`${action.area}-${action.id}`}><b>{action.area}:</b> {action.label}</p>)}<h2>תוצאות שהתקבלו</h2>{results.map((result) => <p key={`${result.area}-${result.id}`}><b>{result.label}:</b> {result.answer.replace(/; /g, " | ")}</p>)}<h2>פניות פרופ׳ שחף והנמקות התלמיד</h2>{[...rationale1, ...rationale2].length ? [...rationale1, ...rationale2].map((item, index) => <section className="print-rationale" key={index}><h3>פנייה {index + 1}: {item.action.label}</h3><p><b>שאלת פרופ׳ שחף:</b> {professorQuestion(item)}</p><p><b>תשובת התלמיד:</b> {item.answer || "לא נענתה הנמקה"}</p></section>) : <p>לא נבחרו פניות להנמקה בשלב זה.</p>}<h2>רשומה רפואית</h2>{record.map(([label, value]) => <p key={label}><b>{label}:</b> {value}</p>)}{otherAnswers.length ? <><h2>החלטות והערכת התלמיד</h2>{otherAnswers.map(([label, value]) => <p key={label}><b>{label}:</b> {value || "לא מולא"}</p>)}</> : null}{transcript ? <><h2>הסבר למטופל — תמלול מאושר</h2><p>{transcript}</p></> : <><h2>הסבר למטופל — תמלול מאושר</h2><p>לא נמסר תמלול.</p></>}{feedback && <><h2>משוב פרופ׳ שחף</h2>{Object.entries(feedback).map(([title, domain]) => <section key={title}><h3>{title}</h3><b>מה נעשה היטב</b><ul>{domain.good.map((line) => <li key={line}>{line}</li>)}</ul><b>מה חשוב לשקול מחדש</b><ul>{domain.reconsider.map((line) => <li key={line}>{line}</li>)}</ul></section>)}</>}</section>; }
