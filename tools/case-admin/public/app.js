// Local case-management interface. All text is inserted with textContent / createTextNode only.
(() => {
  const token = document.querySelector('meta[name="admin-token"]').content;
  const app = document.getElementById("app");

  async function api(method, path, body) {
    const response = await fetch(path, { method, headers: { "content-type": "application/json", "x-admin-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "שגיאה");
    return data;
  }

  /** Tiny element builder: h("div", {class: "x", onclick: fn}, "text", childNode). */
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "class") node.className = value;
      else if (key === "value") node.value = value;
      else if (key === "checked" || key === "disabled" || key === "selected") node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  const state = { info: null, draftId: null, step: 1, brief: null, view: null, sheet: null, filter: "all", job: null, check: null, message: "", publishResult: null };

  const STEPS = [[1, "1. תיאור המקרה"], [2, "2. הפקת טיוטה"], [3, "3. סקירה ועריכה"], [4, "4. בדיקה והוספה לאתר"]];
  const FIELDS = [
    ["topic", "נושא ואבחנה", "האבחנה של המקרה, וקבוצת הגיל/רמת התלמידים."],
    ["goals", "מטרות למידה", "מה התלמיד אמור להבין או לעשות בסוף."],
    ["patient", "המטופל", "ראשי תיבות, גיל, מין, מקצוע, מצב משפחתי, סגנון דיבור (מדבר מעט/הרבה, מודאג, שיתופי...)."],
    ["complaint", "תלונה מרכזית ופתיחה", "מה המטופל אומר שהוא מרגיש. בלי אבחנה ובלי מדדים חיוניים."],
    ["history", "אנמנזה: עובדות מרכזיות", "מאפייני התסמין, מחלות רקע, תרופות, הרגלים, היסטוריה משפחתית, גורמי סיכון, וגם מה שלילי."],
    ["exam", "בדיקה גופנית: ממצאים מרכזיים", "סימנים חיוניים, ממצאים תקינים וחריגים."],
    ["tests", "בדיקות עזר", "אק״ג, בדיקות דם, הדמיה: תוצאות מרכזיות, כולל ערכים מספריים אם יש."],
    ["followup", "בדיקות המשך", "אקו, מבחן מאמץ וכו' ותוצאותיהן."],
    ["decisions", "החלטות וטיפול", "אבחנות מבדלות, ההחלטה המיידית הנכונה, טיפול והמלצות, מה מסוכן."],
    ["feedback", "נקודות לחשיבה ולמשוב", "מה חשוב שהמשוב יבדוק."],
  ];

  async function refreshInfo() { state.info = await api("GET", "/api/state"); }
  const say = (text) => { state.message = text; };

  // ---- shared pieces -----------------------------------------------------------------------------
  function header() {
    return h("header", { class: "top" }, h("h1", {}, "ממשק ניהול מקרים"), h("span", { class: "local" }, "רץ על המחשב שלך בלבד · לא חלק מהאתר הציבורי"),
      state.draftId ? h("button", { onclick: goHome }, "← לרשימת המקרים") : null);
  }
  function goHome() { state.draftId = null; state.view = null; state.check = null; state.publishResult = null; load(); }
  function demoBanner() {
    return state.info?.demo ? h("div", { class: "banner" }, h("b", {}, "מצב הדגמה: "), "התוכן הוא טקסט דוגמה בלבד, ללא AI אמיתי וללא עלות. אי אפשר להוסיף מקרה לאתר ממצב זה.") : null;
  }
  function render(...content) {
    clear(app);
    app.append(header(), h("main", {}, demoBanner(), state.message ? h("div", { class: "banner", role: "status" }, state.message) : null, ...content));
    state.message = "";
  }
  function stepNav() {
    return h("nav", { class: "steps", "aria-label": "שלבי העבודה" }, STEPS.map(([n, label]) => h("button", { class: state.step === n ? "active" : "", onclick: () => go(n) }, label)));
  }
  async function go(step) { state.step = step; await load(); }

  // ---- home ------------------------------------------------------------------------------------------
  function renderHome() {
    const info = state.info;
    render(
      h("div", { class: "panel" }, h("h2", {}, "מקרים באתר"),
        h("div", { class: "cases" }, info.cases.map((entry) => h("div", { class: "card" }, h("b", {}, entry.id), h("div", {}, entry.demographics), h("div", { class: "muted" }, "תלונה: " + entry.chiefComplaint))))),
      h("div", { class: "panel" }, h("h2", {}, "טיוטות"),
        info.drafts.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "מקרה"), h("th", {}, "נושא"), h("th", {}, "מצב"), h("th", {}, ""))),
          h("tbody", {}, info.drafts.map((draft) => h("tr", {}, h("td", {}, draft.id), h("td", {}, draft.topic || "(ללא נושא)"), h("td", {}, draft.status === "published" ? h("span", { class: "tag ok" }, "נוסף לאתר") : h("span", { class: "tag" }, draft.hasDraft ? "בעבודה" : "רק תיאור")),
            h("td", {}, h("button", { onclick: () => openDraft(draft.id) }, "פתח")))))) : h("p", { class: "muted" }, "אין טיוטות עדיין."),
        h("p", {}, h("button", { class: "primary", onclick: newDraft }, "+ מקרה חדש (" + info.nextCaseId + ")")))
    );
  }
  async function newDraft() { try { const { id } = await api("POST", "/api/drafts", {}); await openDraft(id); } catch (error) { say(error.message); renderHome(); } }
  async function openDraft(id) { state.draftId = id; state.step = 1; state.view = null; state.check = null; state.publishResult = null; state.job = null; await load(); }

  // ---- draft screens ---------------------------------------------------------------------------------
  async function load() {
    try {
      await refreshInfo();
      if (!state.draftId) return renderHome();
      state.brief = await api("GET", `/api/drafts/${state.draftId}`);
      if (state.step === 3) state.view = await api("GET", `/api/drafts/${state.draftId}/view`).catch(() => null);
      if (state.step === 4) state.check = await api("POST", `/api/drafts/${state.draftId}/check`, {});
      renderDraft();
    } catch (error) { say(error.message); render(h("p", {}, "אירעה שגיאה: " + error.message), h("button", { onclick: goHome }, "חזרה")); }
  }

  function renderDraft() {
    const body = state.step === 1 ? stepBrief() : state.step === 2 ? stepGenerate() : state.step === 3 ? stepReview() : stepPublish();
    render(h("h2", {}, "מקרה " + state.draftId), stepNav(), body);
  }

  function stepBrief() {
    const meta = state.brief.meta;
    const inputs = {};
    const complaint = h("input", { value: meta.chiefComplaint ?? "", maxlength: "200", placeholder: "למשל: כאב חד בצד הגב לאחר מאמץ" });
    const status = h("span", { class: "saved" });
    const save = async () => {
      const fields = Object.fromEntries(Object.entries(inputs).map(([key, el]) => [key, el.value]));
      await api("PUT", `/api/drafts/${state.draftId}/brief`, { fields, chiefComplaint: complaint.value });
      status.textContent = "נשמר ✓";
    };
    return h("div", { class: "panel" },
      h("p", {}, "תארו את המקרה בעברית חופשית. ככל שיהיו יותר פרטים, ה-AI ימציא פחות. ", h("b", {}, "אתם נושאים באחריות לתוכן הקליני: ")),
      FIELDS.map(([key, title, hint]) => { const area = h("textarea", { onblur: save }, ""); area.value = meta.fields?.[key] ?? ""; inputs[key] = area; return h("label", { class: "field" }, title, h("small", {}, hint), area); }),
      h("label", { class: "field" }, "תלונה מרכזית שהתלמיד רואה לפני הפגישה", h("small", {}, "משפט קצר, ללא אבחנה וללא מדדים חיוניים. חובה כדי להוסיף את המקרה לאתר."), complaint),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { await save(); await go(2); } }, "שמור והמשך להפקת טיוטה"), h("button", { onclick: save }, "שמור"), status));
  }

  function stepGenerate() {
    const info = state.info;
    const plan = state.brief.plan;
    const provider = h("select", {}, info.providers.map((item) => h("option", { value: item.id, selected: item.id === info.ai.providerId }, item.label)));
    const model = h("input", { value: info.ai.model, placeholder: "ריק = המודל המומלץ של הספק", dir: "ltr" });
    const key = h("input", { class: "secret", type: "text", autocomplete: "off", spellcheck: "false", dir: "ltr", placeholder: info.ai.keySet ? "המפתח מוגדר (השאירו ריק כדי לשמור אותו)" : "הדביקו כאן את מפתח ה-API" });
    const saved = h("span", { class: "saved" });
    const progress = h("ul", { class: "progress" });
    const status = h("p", {});
    const saveSettings = async () => { const result = await api("POST", "/api/ai-config", { providerId: provider.value, model: model.value, apiKey: key.value.trim() }); key.value = ""; saved.textContent = result.keySet ? "הגדרות נשמרו, המפתח מוגדר ✓" : "הגדרות נשמרו (אין עדיין מפתח)"; await refreshInfo(); };
    const start = async (mode) => {
      try {
        await saveSettings();
        let overwrite = false;
        if (state.brief.hasDraft) { if (!window.confirm("כבר יש טיוטה. יצירה מחדש תמחק את כל העריכות שלך. להמשיך?")) return; overwrite = true; }
        const result = await api("POST", `/api/drafts/${state.draftId}/generate`, { mode, overwrite });
        if (result.done) { await go(3); return; }
        status.textContent = "ה-AI מכין את הטיוטה. זה לוקח כמה דקות; אפשר להשאיר את הדף פתוח.";
        const timer = setInterval(async () => {
          try {
            const job = await api("GET", `/api/jobs/${result.jobId}`);
            clear(progress);
            job.progress.forEach((step) => progress.append(h("li", {}, `${step.sheet}: ${step.items} פריטים${step.attempt > 1 ? " (ניסיון חוזר)" : ""}`)));
            if (job.status === "done") { clearInterval(timer); say(job.problems.length ? `הטיוטה מוכנה, אבל ${job.problems.length} פריטים לא התקבלו מהמודל ויש למלא אותם ידנית.` : "הטיוטה מוכנה. עברו עליה בשלב הבא."); await go(3); }
            if (job.status === "error") { clearInterval(timer); status.textContent = "ההפקה נכשלה: " + job.error; }
          } catch (error) { clearInterval(timer); status.textContent = error.message; }
        }, 1500);
      } catch (error) { status.textContent = error.message; }
    };
    const providerName = () => info.providers.find((item) => item.id === provider.value)?.label ?? provider.value;
    return h("div", { class: "panel" },
      h("h3", {}, "הגדרות ה-AI"),
      info.demo ? h("p", { class: "muted" }, "במצב הדגמה לא נדרש מפתח.") : h("div", {},
        h("label", { class: "field" }, "ספק", provider), h("label", { class: "field" }, "מודל (לא חובה)", model),
        h("label", { class: "field" }, "מפתח API", h("small", {}, "נשמר בזיכרון של השרת המקומי בלבד עד שתסגרו אותו. לא נכתב לקובץ ולא נשלח לדף."), key),
        h("div", { class: "row" }, h("button", { onclick: saveSettings }, "שמור הגדרות"), saved)),
      h("h3", {}, "מה ייעשה"),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "גיליון"), h("th", {}, "פריטים"), h("th", {}, "קריאות"))), h("tbody", {}, plan.steps.map((step) => h("tr", {}, h("td", {}, step.sheet), h("td", {}, step.items), h("td", {}, step.calls))))),
      h("p", { class: "banner" }, `סה״כ כ-${plan.calls} קריאות למודל (בלי ניסיונות חוזרים). ההפקה שולחת את תיאור המקרה ללא מידע אישי לספק שנבחר, ועולה כסף לפי התעריף שלו או מנצלת את המכסה החינמית שלו. התוצאה היא טיוטה שאתם עוברים עליה.`),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => start("ai") }, info.demo ? "הפק טיוטת דוגמה" : "הפק טיוטה בעזרת AI"),
        h("button", { onclick: () => start("empty") }, "התחל טיוטה ריקה (אמלא בעצמי)")),
      status, progress, state.brief.problems.length ? h("div", { class: "errors" }, h("b", {}, "פריטים שלא התקבלו:"), h("ul", {}, state.brief.problems.slice(0, 30).map((line) => h("li", {}, line)))) : null,
      h("p", { class: "muted" }, "ספק נבחר: " + providerName()));
  }

  // ---- review -----------------------------------------------------------------------------------------
  function stepReview() {
    if (!state.view) return h("div", { class: "panel" }, h("p", {}, "עדיין אין טיוטה. חזרו לשלב 2."), h("button", { onclick: () => go(2) }, "לשלב 2"));
    const { view, stats } = state.view;
    state.sheet ??= view[0].sheet;
    const current = view.find((sheet) => sheet.sheet === state.sheet) ?? view[0];
    const tabs = h("div", { class: "sheets" }, view.map((sheet) => {
      const flagged = sheet.items.filter((item) => item.needsReview && !item.reviewed).length;
      const empty = sheet.items.filter((item) => !item.filled).length;
      return h("button", { class: state.sheet === sheet.sheet ? "active" : "", onclick: () => { state.sheet = sheet.sheet; renderDraft(); } }, sheet.title, flagged ? ` · ${flagged} לבדיקה` : "", empty ? ` · ${empty} ריקים` : "");
    }));
    const filter = h("select", { onchange: (event) => { state.filter = event.target.value; renderDraft(); } },
      [["all", "כל הפריטים"], ["flag", "רק פריטים לבדיקה"], ["empty", "רק פריטים ריקים"]].map(([value, label]) => h("option", { value, selected: state.filter === value }, label)));
    const items = current.items.filter((item) => state.filter === "all" || (state.filter === "flag" && item.needsReview && !item.reviewed) || (state.filter === "empty" && !item.filled));
    return h("div", { class: "panel" },
      h("p", {}, `מולאו ${stats.filled} מתוך ${stats.total} פריטים. ${stats.flagged ? `${stats.flaggedChecked} מתוך ${stats.flagged} פריטים שה-AI סימן אושרו כנבדקים.` : "אין פריטים שסומנו לבדיקה."} השינויים נשמרים אוטומטית.`),
      h("div", { class: "row" }, tabs), h("label", { class: "field" }, "סינון", filter),
      h("p", { class: "muted" }, current.guide),
      h("p", { class: "banner" }, h("b", {}, "מה זה פריט צהוב? "), "פריט שה-AI כתבה בלי שנמסר לה מידע עליו בתיאור, או שהיא לא בטוחה בו. קראו אותו, תקנו אם צריך, וסמנו \"בדקתי\". פריט ללא צבע (כחול דק) נכתב לפי התיאור שלכם, אבל גם אותו כדאי לקרוא."),
      items.length ? items.map(itemCard) : h("p", { class: "ok-box" }, "אין פריטים להצגה בסינון הזה."),
      h("p", {}, h("button", { class: "primary", onclick: () => go(4) }, "המשך לבדיקה והוספה")));
  }

  function itemCard(item) {
    const saved = h("span", { class: "saved" });
    const save = async (column, value) => { try { await api("PATCH", `/api/drafts/${state.draftId}/entry`, { sheet: state.sheet, id: item.id, column, value }); saved.textContent = "נשמר ✓"; } catch (error) { saved.textContent = error.message; } };
    const choices = { "חשיבות במקרה": ["חיוני במקרה", "חשוב", "משלים", "בדרך כלל לא מרכזי"] };
    const controls = item.columns.map((column) => {
      const editor = choices[column]
        ? h("select", { onchange: (event) => save(column, event.target.value) }, h("option", { value: "" }, "— בחרו —"), choices[column].map((option) => h("option", { value: option, selected: item.values[column] === option }, option)))
        : (() => { const area = h("textarea", { onchange: (event) => save(column, event.target.value) }); area.value = item.values[column]; return area; })();
      return h("label", { class: "field" }, column, editor);
    });
    const review = item.needsReview ? h("label", { class: "row" }, h("input", { type: "checkbox", style: "width:auto", checked: item.reviewed, onchange: async (event) => { await api("PATCH", `/api/drafts/${state.draftId}/entry`, { sheet: state.sheet, id: item.id, reviewed: event.target.checked }); state.view = await api("GET", `/api/drafts/${state.draftId}/view`); renderDraft(); } }), "בדקתי את הפריט הזה") : null;
    return h("div", { class: "item" + (item.needsReview && !item.reviewed ? " flagged" : "") + (item.filled ? "" : " empty") },
      h("h4", {}, item.label, item.unit ? h("span", { class: "muted" }, `(${item.unit})`) : null, item.needsReview ? h("span", { class: "tag flag" }, item.reviewed ? "נבדק" : "ה-AI לא בטוחה, נא לבדוק") : null, h("small", { class: "muted" }, item.id)),
      item.note ? h("div", { class: "note" }, "הערת ה-AI: " + item.note) : null, controls, review, saved);
  }

  // ---- check and publish --------------------------------------------------------------------------------
  function stepPublish() {
    const check = state.check;
    const complaint = h("input", { value: state.brief.meta.chiefComplaint ?? "", maxlength: "200" });
    const confirmBox = h("input", { type: "checkbox", style: "width:auto" });
    const publishButton = h("button", { class: "primary", disabled: true }, "הוסף את המקרה לאתר");
    const sync = () => { publishButton.disabled = !(check.canPublish && confirmBox.checked); };
    confirmBox.addEventListener("change", sync);
    publishButton.addEventListener("click", async () => {
      if (!window.confirm("להוסיף את המקרה לקובצי האתר? הפעולה כותבת קבצים בפרויקט (ללא commit).")) return;
      try { state.publishResult = await api("POST", `/api/drafts/${state.draftId}/publish`, { confirm: true }); say("המקרה נוסף לקובצי הפרויקט."); await refreshInfo(); renderDraft(); } catch (error) { say(error.message); renderDraft(); }
    });
    sync();
    if (state.publishResult) return h("div", { class: "panel" }, h("div", { class: "ok-box" }, h("b", {}, "המקרה " + state.publishResult.entry.id + " נוסף לקבצי הפרויקט."), h("ul", {}, state.publishResult.written.map((line) => h("li", {}, line))), h("p", {}, "קובץ Excel: " + state.publishResult.excel)),
      h("p", {}, "הצעדים הבאים (בחלון הפקודות, בתיקיית הפרויקט):"), h("pre", {}, state.publishResult.nextSteps.join("\n")), h("p", { class: "muted" }, "האתר הציבורי יתעדכן רק אחרי push."));
    return h("div", { class: "panel" },
      h("label", { class: "field" }, "תלונה מרכזית שהתלמיד רואה", h("small", {}, "בלי אבחנה."), complaint),
      h("div", { class: "row" }, h("button", { onclick: async () => { await api("PUT", `/api/drafts/${state.draftId}/brief`, { fields: state.brief.meta.fields, chiefComplaint: complaint.value }); state.brief = await api("GET", `/api/drafts/${state.draftId}`); state.check = await api("POST", `/api/drafts/${state.draftId}/check`, {}); renderDraft(); } }, "שמור ובדוק שוב")),
      h("h3", {}, "מצב"),
      check.blockers.length ? h("div", { class: "errors" }, h("b", {}, "מה חוסם את ההוספה:"), h("ul", {}, check.blockers.map((line) => h("li", {}, line)))) : h("div", { class: "ok-box" }, "הבדיקה עברה. אפשר להוסיף את המקרה."),
      check.errorCount ? h("div", { class: "errors" }, h("b", {}, `שגיאות (${check.errorCount}; מוצגות עד 200):`), h("ul", {}, check.errors.slice(0, 60).map((line) => h("li", {}, line))), check.errorCount > 60 ? h("p", { class: "muted" }, "…ועוד. השתמשו בסינון \"רק פריטים ריקים\" בשלב 3.") : null) : null,
      check.warnings.length ? h("div", { class: "banner" }, h("b", {}, "אזהרות:"), h("ul", {}, check.warnings.map((line) => h("li", {}, line)))) : null,
      check.unreviewed.length ? h("div", { class: "banner" }, h("b", {}, `${check.unreviewed.length} פריטים ש-ה-AI לא הייתה בטוחה בהם וטרם נבדקו:`),
        h("ul", {}, check.unreviewed.slice(0, 40).map((item) => h("li", {}, h("button", { class: "link", onclick: () => { state.sheet = item.sheet; state.filter = "flag"; go(3); } }, `${item.sheetTitle} · ${item.label}`)))),
        check.unreviewed.length > 40 ? h("p", { class: "muted" }, "…ועוד") : null,
        h("p", {}, h("button", { class: "primary", onclick: () => { state.sheet = check.unreviewed[0].sheet; state.filter = "flag"; go(3); } }, "עבור על הפריטים לבדיקה"))) : null,
      h("label", { class: "row" }, confirmBox, "בדקתי את התוכן הקליני של המקרה ואני אחראי עליו."),
      h("p", {}, publishButton, " ", h("span", { class: "muted" }, "הפעולה לא מבצעת commit ולא מפרסמת את האתר.")),
      state.info.python ? null : h("p", { class: "muted" }, "Python עם openpyxl לא נמצא: ייווצר רק קובץ JSON, ללא עותק Excel."));
  }

  load();
})();
