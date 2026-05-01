
import { useState, useCallback } from "react";
import { SYSTEM_PROMPT } from "../agent/systemPrompt.js";

const INDIVIDUALS = [{"id":"@I292519753206@","name":"John Widdop","sex":"M","birth_year":1647,"birth_place":"Keighley, Yorkshire, , England","generation":11,"confidence":"C","score":7,"warnings":["No source evidence attached"],"alerts":["EARLY-ERA: Birth 1647. Pre-civil registration. Verify against surviving parish records."]},{"id":"@I292519753182@","name":"Mary Jackson","sex":"F","birth_year":1620,"birth_place":"Horton-in-Ribblesdale, Yorkshire.","generation":11,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["EARLY-ERA: Birth 1620. Pre-civil registration. Verify against surviving parish records."]},{"id":"@I292519753236@","name":"Mary Watters","sex":"F","birth_year":1644,"birth_place":"Keighley, Yorkshire, England","generation":11,"confidence":"C","score":5,"warnings":["No source evidence attached"],"alerts":["EARLY-ERA: Birth 1644. Pre-civil registration. Verify against surviving parish records."]},{"id":"@I292519759126@","name":"William Cockcroft","sex":"M","birth_year":null,"birth_place":"","generation":11,"confidence":"C","score":3,"warnings":["No birth date recorded"],"alerts":[]},{"id":"@I292519753159@","name":"William Redman","sex":"M","birth_year":1618,"birth_place":"Heptonstall, Yorkshire, England","generation":11,"confidence":"C","score":8,"warnings":["No source evidence attached"],"alerts":["EARLY-ERA: Birth 1618. Pre-civil registration. Verify against surviving parish records."]},{"id":"@I292515693494@","name":"Isabella Walbank","sex":"F","birth_year":null,"birth_place":"","generation":8,"confidence":"C","score":5,"warnings":["No birth date recorded"],"alerts":[]},{"id":"@I292519753383@","name":"Mary Smith","sex":"F","birth_year":1714,"birth_place":"Shelf, Halifax, Yorkshire","generation":8,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1714. No GRO certificate available. Verify against parish records."]},{"id":"@I292519753346@","name":"Michael Bentley","sex":"M","birth_year":1710,"birth_place":"Coley, Halifax, Yorkshire","generation":8,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1710. No GRO certificate available. Verify against parish records."]},{"id":"@I292525419652@","name":"Elizabeth Smales","sex":"F","birth_year":1781,"birth_place":"Kippax, Yorkshire","generation":7,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1781. No GRO certificate available. Verify against parish records."]},{"id":"@I292519753055@","name":"Jane Dobson","sex":"F","birth_year":1740,"birth_place":"Coley, Halifax, Yorkshire","generation":7,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1740. No GRO certificate available. Verify against parish records."]},{"id":"@I292525419763@","name":"John Scott","sex":"M","birth_year":1746,"birth_place":"Gildersome, Yorkshire West Riding","generation":7,"confidence":"C","score":7,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1746. No GRO certificate available. Verify against parish records."]},{"id":"@I292519752991@","name":"Joseph Bentley","sex":"M","birth_year":1739,"birth_place":"Northowram, Halifax, Yorkshire","generation":7,"confidence":"C","score":8,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1739. No GRO certificate available. Verify against parish records."]},{"id":"@I292525419632@","name":"William Smales","sex":"M","birth_year":1776,"birth_place":"Kippax, Yorkshire","generation":7,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1776. No GRO certificate available. Verify against parish records."]},{"id":"@I292519741543@","name":"Ann Scott","sex":"F","birth_year":1776,"birth_place":"Gildersome, Yorkshire","generation":6,"confidence":"C","score":8,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1776. No GRO certificate available. Verify against parish records."]},{"id":"@I292519741509@","name":"Betty Green","sex":"F","birth_year":1780,"birth_place":"Northamptonshire, England","generation":6,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1780. No GRO certificate available. Verify against parish records."]},{"id":"@I292525419602@","name":"Elizabeth Smales","sex":"F","birth_year":1803,"birth_place":"Kippax, Yorkshire","generation":6,"confidence":"C","score":7,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1803. No GRO certificate available. Verify against parish records."]},{"id":"@I292708275002@","name":"John Pickersgill","sex":"M","birth_year":1800,"birth_place":"Methley, Yorkshire","generation":6,"confidence":"C","score":5,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1800. No GRO certificate available. Verify against parish records."]},{"id":"@I292511631506@","name":"John White","sex":"M","birth_year":1787,"birth_place":"Leeds, Yorkshire","generation":6,"confidence":"C","score":5,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1787. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902695@","name":"Peter Matthews","sex":"M","birth_year":1797,"birth_place":"Ireland","generation":6,"confidence":"C","score":7,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1797. No GRO certificate available. Verify against parish records."]},{"id":"@I292511631522@","name":"Rachel Simpson","sex":"F","birth_year":1788,"birth_place":"Leeds, Yorkshire","generation":6,"confidence":"C","score":7,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1788. No GRO certificate available. Verify against parish records."]},{"id":"@I292519741530@","name":"Richard Buttery","sex":"M","birth_year":1779,"birth_place":"Gildersome, West Yorkshire","generation":6,"confidence":"C","score":8,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1779. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902699@","name":"Richard Sweeting","sex":"M","birth_year":1759,"birth_place":"Brayton, Yorkshire","generation":6,"confidence":"C","score":6,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1759. No GRO certificate available. Verify against parish records."]},{"id":"@I292519741489@","name":"Timothy Bentley","sex":"M","birth_year":1768,"birth_place":"Southowram, Halifax, Yorkshire","generation":6,"confidence":"C","score":8,"warnings":["No source evidence attached"],"alerts":["PRE-GRO: Birth 1768. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902698@","name":"Ann Sweeting","sex":"F","birth_year":1802,"birth_place":"Monks Frystone, Yorkshire","generation":5,"confidence":"D","score":6,"warnings":["Birth date is estimated","Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1802. No GRO certificate available. Verify against parish records."]},{"id":"@I292525963932@","name":"Elenor (Ellen)","sex":"F","birth_year":1854,"birth_place":"Leeds, Yorkshire","generation":5,"confidence":"D","score":7,"warnings":["Sources are family tree entries only"],"alerts":[]},{"id":"@I1825902694@","name":"Elizabeth Ramsbottom","sex":"F","birth_year":null,"birth_place":"","generation":5,"confidence":"D","score":0,"warnings":["No birth date recorded","No source evidence attached"],"alerts":[]},{"id":"@I292511586593@","name":"Jane Baren","sex":"F","birth_year":1839,"birth_place":"Horsham, Sussex","generation":5,"confidence":"D","score":4,"warnings":["No source evidence attached"],"alerts":[]},{"id":"@I292511586637@","name":"Joseph White","sex":"M","birth_year":1833,"birth_place":"Leeds, Yorkshire","generation":5,"confidence":"D","score":8,"warnings":["Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1833. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902693@","name":"Peter Matthews","sex":"M","birth_year":1851,"birth_place":"Leeds","generation":5,"confidence":"D","score":4,"warnings":["No source evidence attached"],"alerts":[]},{"id":"@I292515657561@","name":"Elizabeth Cockcroft","sex":"F","birth_year":1705,"birth_place":"Heptonstall, West Yorkshire","generation":8,"confidence":"D","score":7,"warnings":["Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1705. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902701@","name":"John Wainwright","sex":"M","birth_year":1738,"birth_place":"Ferry Fryston, Yorkshire","generation":7,"confidence":"D","score":8,"warnings":["Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1738. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902702@","name":"Mary Beardshaw","sex":"F","birth_year":1743,"birth_place":"Monk Frystone, Yorkshire","generation":7,"confidence":"D","score":8,"warnings":["Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1743. No GRO certificate available. Verify against parish records."]},{"id":"@I1825902700@","name":"Ann Wainwright","sex":"F","birth_year":1766,"birth_place":"Hillam, Monk Frystone, Yorkshire","generation":6,"confidence":"D","score":8,"warnings":["Sources are family tree entries only"],"alerts":["PRE-GRO: Birth 1766. No GRO certificate available. Verify against parish records."]}];

const CONF_STYLE = {
  A: { bg: "#E2EFDA", text: "#1F6B3A", label: "VERIFIED" },
  B: { bg: "#DEEAF1", text: "#1F497D", label: "PROBABLE" },
  C: { bg: "#FFF2CC", text: "#BF6F00", label: "UNCERTAIN" },
  D: { bg: "#FCE4D6", text: "#C00000", label: "UNVERIFIED" },
};

function Badge({ conf }) {
  const s = CONF_STYLE[conf] || CONF_STYLE.D;
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      background: s.bg, color: s.text, fontWeight: 700, fontSize: 11,
      letterSpacing: 0.5
    }}>{conf} {s.label}</span>
  );
}

function IndividualCard({ person, selected, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: "10px 14px", marginBottom: 6, borderRadius: 6,
      border: selected ? "2px solid #2E75B6" : "1px solid #ddd",
      background: selected ? "#EBF3FB" : "#fff",
      cursor: "pointer", transition: "all 0.15s"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{person.name || "Unknown"}</span>
        <Badge conf={person.confidence} />
      </div>
      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
        Gen {person.generation} · b.{person.birth_year || "?"} · {person.birth_place || "place unknown"}
      </div>
    </div>
  );
}

function ResultPanel({ result, loading, error }) {
  if (loading) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, color: "#666" }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
      <div style={{ fontWeight: 600 }}>Searching public records...</div>
      <div style={{ fontSize: 13, marginTop: 6, color: "#999" }}>FreeBMD · FamilySearch · County Archives</div>
    </div>
  );
  if (error) return (
    <div style={{ padding: 20, background: "#FCE4D6", borderRadius: 8, color: "#C00000" }}>
      <strong>Search error:</strong> {error}
    </div>
  );
  if (!result) return (
    <div style={{ color: "#aaa", textAlign: "center", padding: 40, fontSize: 14 }}>
      Select an individual from the list and run the agent to begin
    </div>
  );
  return (
    <div style={{ whiteSpace: "pre-wrap", fontFamily: "Georgia, serif", fontSize: 14, lineHeight: 1.7, color: "#222" }}>
      {result}
    </div>
  );
}

export default function App() {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState({});

  const filtered = INDIVIDUALS.filter(p =>
    filter === "all" ? true : p.confidence === filter
  ).sort((a, b) => {
    // D first, then C; within each, sort by generation desc (older = higher priority)
    if (a.confidence !== b.confidence) return a.confidence === "D" ? -1 : 1;
    return b.generation - a.generation;
  });

  const runAgent = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const person = selected;
    const userMessage = `Please research this individual from the Sutcliffe family tree:

Name: ${person.name}
Sex: ${person.sex === "M" ? "Male" : person.sex === "F" ? "Female" : "Unknown"}
Approximate birth year: ${person.birth_year || "Unknown"}
Birth place: ${person.birth_place || "Unknown"}
Generation from root (Richard David Sutcliffe b.1972): ${person.generation}
Current confidence band: ${person.confidence} (${CONF_STYLE[person.confidence]?.label})
Current evidence score: ${person.score}/20
Known warnings: ${person.warnings.join("; ") || "None"}
Known alerts: ${person.alerts.join("; ") || "None"}

Please search public records to find primary source evidence for this individual. If you find a match, provide the source citation in full and recommend a new confidence band. If you cannot find a match, explain what you searched and why it returned no results.`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: userMessage }]
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      const text = data.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n\n");

      setResult(text);
      setHistory(h => ({ ...h, [person.id]: text }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const cCounts = { C: INDIVIDUALS.filter(p => p.confidence === "C").length,
                    D: INDIVIDUALS.filter(p => p.confidence === "D").length };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", display: "flex", height: "100vh", background: "#F5F6FA" }}>
      {/* Left panel */}
      <div style={{ width: 320, borderRight: "1px solid #ddd", display: "flex", flexDirection: "column", background: "#fff" }}>
        <div style={{ padding: "16px 14px 10px", borderBottom: "1px solid #eee" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1F3864" }}>Record Discovery Agent</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Sutcliffe Family Tree · v1.0</div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            {["all","C","D"].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: "4px 10px", borderRadius: 4, border: "1px solid #ddd",
                background: filter === f ? "#2E75B6" : "#fff",
                color: filter === f ? "#fff" : "#444",
                fontWeight: filter === f ? 700 : 400, fontSize: 12, cursor: "pointer"
              }}>
                {f === "all" ? `All (${cCounts.C + cCounts.D})` : f === "C" ? `C Uncertain (${cCounts.C})` : `D Unverified (${cCounts.D})`}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px" }}>
          {filtered.map(p => (
            <IndividualCard
              key={p.id} person={p}
              selected={selected?.id === p.id}
              onClick={() => {
                setSelected(p);
                setResult(history[p.id] || null);
                setError(null);
              }}
            />
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #ddd", background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {selected ? (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#1F3864" }}>{selected.name}</div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                b.{selected.birth_year || "?"} · {selected.birth_place || "place unknown"} · Gen {selected.generation} · <Badge conf={selected.confidence} />
                {history[selected.id] && <span style={{ marginLeft: 8, fontSize: 11, color: "#1F6B3A" }}>✓ Previously searched</span>}
              </div>
              {selected.warnings.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 12, color: "#BF6F00" }}>
                  ⚠ {selected.warnings.join(" · ")}
                </div>
              )}
              {selected.alerts.length > 0 && (
                <div style={{ fontSize: 12, color: "#C00000", marginTop: 2 }}>
                  ⛔ {selected.alerts[0]}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#aaa", fontSize: 14 }}>No individual selected</div>
          )}
          <button
            onClick={runAgent}
            disabled={!selected || loading}
            style={{
              padding: "8px 20px", borderRadius: 6, border: "none",
              background: !selected || loading ? "#ccc" : "#2E75B6",
              color: "#fff", fontWeight: 700, fontSize: 14, cursor: !selected || loading ? "not-allowed" : "pointer"
            }}
          >
            {loading ? "Searching..." : "Run Agent"}
          </button>
        </div>

        {/* Result area */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <div style={{ maxWidth: 800, margin: "0 auto", background: "#fff", borderRadius: 8, padding: 24, border: "1px solid #eee", minHeight: 300 }}>
            <ResultPanel result={result} loading={loading} error={error} />
          </div>

          {/* Info box */}
          {!result && !loading && (
            <div style={{ maxWidth: 800, margin: "16px auto 0", padding: "12px 16px", background: "#DEEAF1", borderRadius: 8, fontSize: 13, color: "#1F497D" }}>
              <strong>How this agent works:</strong> It takes the selected individual, constructs targeted search queries for FreeBMD, FamilySearch, and county archive catalogues, then evaluates each candidate record against name variants, date tolerance, and geographic plausibility. It recommends a confidence band upgrade only when a specific source citation supports it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
