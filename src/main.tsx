import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import App from "./App";
import TeacherSetup from "./TeacherSetup";
import { parseHash } from "../lib/class-link";

/** Hash routes: `#/setup` = teacher setup, `#c=…` = a student's class link, anything else = plain simulator. */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (hash === "#/setup") return <TeacherSetup />;
  const parsed = parseHash(hash);
  if (parsed.status === "invalid") return <main className="clinic-shell"><div className="panel"><h1>הקישור אינו תקין</h1><p className="error" role="alert">{parsed.reason} בקשו מהמורה קישור חדש.</p></div></main>;
  if (parsed.status === "expired") return <main className="clinic-shell"><div className="panel"><h1>הקישור פג תוקף</h1><p>בקשו מהמורה קישור חדש.</p></div></main>;
  // `key` forces a fresh App when the class link changes.
  return <App key={hash} classConfig={parsed.status === "ok" ? parsed.config : null} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
