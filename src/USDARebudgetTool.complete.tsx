import React, { useMemo, useState, useEffect } from "react";

/**
 * USDA Rebudget Tool (complete, self-contained)
 * - Upload rates.json and a simple budget file (JSON or CSV)
 * - Make manual transfers on Fine-Tune tab with automatic F&A logic
 * - Export mapping CSV and final projected budget CSV on Export tab
 *
 * Notes:
 * - No external icon libraries required
 * - No ellipsis characters in strings or comments
 * - Works in CodeSandbox with React + TypeScript template
 */

// ---------- Types ----------
type RatesData = {
  fa_rate?: { rate?: number };
  wrs_account_numbers?: { indirect_costs?: string };
  mtdc_eligible_accounts?: string[];
};

type BudgetRow = {
  account: string;
  description: string;
  current_budget: number;
  proposed_budget: number;
  encumbrances?: number;
  change?: number;
};

type TransferMode = "budget_total" | "direct_to_dest";

type TransferItem = {
  id: string;
  from: string;
  to: string;
  amount_cents: number;
  mode: TransferMode;
};

type MappingRow = {
  id: string;
  from: string;
  to: string;
  source_out_cents: number;
  direct_to_dest_cents: number;
  fa_added_to_fanda_cents: number;
  dest_mtdc_eligible: boolean;
  mode: TransferMode;
};

// ---------- Helpers (pure) ----------
const toCents = (v: number | string) => {
  const s = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
  const [i, f = ""] = s.replace(/[^0-9.-]/g, "").split(".");
  return (parseInt(i || "0", 10) * 100) + (parseInt((f || "").padEnd(2, "0").slice(0, 2), 10) || 0);
};

const fromCents = (c: number) =>
  `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

const mulRate = (cents: number, rate: number) => Math.round(cents * rate);
const divByOnePlus = (cents: number, rate: number) => Math.round(cents / (1 + rate));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const isMtdcEligible = (acct: string, rates: RatesData) => {
  if (!rates) return false;
  const fanda = rates?.wrs_account_numbers?.indirect_costs || "58960";
  if (acct === fanda) return false;
  const elig = rates.mtdc_eligible_accounts || [];
  return elig.includes(acct);
};

const faRateForDest = (_destAcct: string, rates: RatesData) => Number(rates?.fa_rate?.rate ?? 0);

const encumbrancesFor = (acct: string, snapshot: BudgetRow[]) => {
  const row = snapshot.find((r) => r.account === acct);
  return Number(row?.encumbrances ?? 0);
};

const baselineSum = (rows: BudgetRow[]) =>
  sum(rows.filter((r) => r.account !== "SUMMARY").map((r) => toCents(r.current_budget)));

function computeTransferImpact(
  ratesData: RatesData,
  toAcct: string,
  amountCents: number,
  mode: TransferMode
) {
  const eligible = isMtdcEligible(toAcct, ratesData);
  const r = eligible ? faRateForDest(toAcct, ratesData) : 0;
  if (amountCents <= 0) throw new Error("Amount must be greater than zero");
  if (mode === "budget_total") {
    const source_out = amountCents;
    const direct_to_dest = r ? divByOnePlus(amountCents, r) : amountCents;
    const fa_added = r ? (source_out - direct_to_dest) : 0;
    return { source_out, direct_to_dest, fa_added, eligible };
  } else {
    const direct_to_dest = amountCents;
    const fa_added = r ? mulRate(direct_to_dest, r) : 0;
    const source_out = direct_to_dest + fa_added;
    return { source_out, direct_to_dest, fa_added, eligible };
  }
}

function applyOne(
  ratesData: RatesData,
  baselineRows: BudgetRow[],
  snapshot: BudgetRow[],
  fromAcct: string,
  toAcct: string,
  amountCents: number,
  mode: TransferMode
) {
  const fandaAcct = ratesData?.wrs_account_numbers?.indirect_costs || "58960";
  if (fromAcct === fandaAcct || toAcct === fandaAcct) throw new Error("Direct transfers to or from F&A are not allowed.");
  const rows = baselineRows.filter((r) => r.account !== "SUMMARY").map((r) => ({ ...r }));
  let fandaRow = rows.find((r) => r.account === fandaAcct);
  if (!fandaRow) {
    fandaRow = {
      account: fandaAcct,
      description: "F&A",
      current_budget: 0,
      proposed_budget: 0,
      change: 0,
      encumbrances: 0
    };
    rows.push(fandaRow);
  }
  const fromRow = rows.find((r) => r.account === fromAcct);
  const toRow = rows.find((r) => r.account === toAcct);
  if (!fromRow) throw new Error(`Unknown source account ${fromAcct}`);
  if (!toRow) throw new Error(`Unknown destination account ${toAcct}`);
  if (fromAcct === toAcct) throw new Error("From and To must differ");

  const { source_out, direct_to_dest, fa_added, eligible } = computeTransferImpact(ratesData, toAcct, amountCents, mode);
  const enc = encumbrancesFor(fromAcct, snapshot);
  const fromAfter = toCents(fromRow.proposed_budget) - source_out;
  if (fromAfter < toCents(enc)) throw new Error(`Transfer would breach encumbrance on ${fromAcct}`);
  if (fromAfter < 0) throw new Error(`Transfer would make ${fromAcct} negative`);

  // Apply as currency numbers (not strings)
  fromRow.proposed_budget = Number(fromRow.proposed_budget) - Number(fromCents(source_out));
  toRow.proposed_budget = Number(toRow.proposed_budget) + Number(fromCents(direct_to_dest));
  fandaRow.proposed_budget = Number(fandaRow.proposed_budget) + Number(fromCents(fa_added));
  rows.forEach((r) => { r.change = Number(r.proposed_budget) - Number(r.current_budget); });

  const logRow: MappingRow = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    from: fromAcct,
    to: toAcct,
    source_out_cents: source_out,
    direct_to_dest_cents: direct_to_dest,
    fa_added_to_fanda_cents: fa_added,
    dest_mtdc_eligible: eligible,
    mode
  };
  const before = baselineSum(baselineRows);
  const after = baselineSum(rows);
  if (before !== after) throw new Error("Totals do not reconcile after transfer");
  return { rows, logRow };
}

function projectWithTransfers(
  ratesData: RatesData,
  baselineRows: BudgetRow[],
  snapshot: BudgetRow[],
  transfers: TransferItem[]
) {
  let working = baselineRows;
  const logs: MappingRow[] = [];
  for (const t of transfers) {
    const out = applyOne(ratesData, working, snapshot, t.from, t.to, t.amount_cents, t.mode);
    working = out.rows;
    logs.push(out.logRow);
  }
  return { finalRows: working, mapping: logs };
}

// ---------- Small CSV helpers ----------
function toCsvRow(fields: (string | number | boolean)[]) {
  return fields
    .map((f) => {
      const s = String(f ?? "");
      if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}

function downloadCsv(filename: string, header: string[], rows: (string | number | boolean)[][]) {
  const csv = [toCsvRow(header), ...rows.map(toCsvRow)].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- UI Components ----------
function UploadPanel({
  onRatesLoaded,
  onBudgetLoaded,
  useMock
}: {
  onRatesLoaded: (r: RatesData) => void;
  onBudgetLoaded: (b: BudgetRow[]) => void;
  useMock?: boolean;
}) {
  const [ratesName, setRatesName] = useState<string>("");
  const [budName, setBudName] = useState<string>("");

  useEffect(() => {
    if (!useMock) return;
    // Provide a tiny mock baseline so Fine-Tune can be tested quickly
    const mockRates: RatesData = {
      fa_rate: { rate: 0.276 },
      wrs_account_numbers: { indirect_costs: "58960" },
      mtdc_eligible_accounts: ["51110", "52000", "53000"]
    };
    const mockBudget: BudgetRow[] = [
      { account: "53800", description: "Student Aid", current_budget: 50000, proposed_budget: 50000, encumbrances: 0 },
      { account: "51110", description: "PI Summer", current_budget: 0, proposed_budget: 0, encumbrances: 0 },
      { account: "52000", description: "Supplies", current_budget: 20000, proposed_budget: 20000, encumbrances: 0 },
      { account: "58960", description: "F&A", current_budget: 30000, proposed_budget: 30000, encumbrances: 0 }
    ];
    onRatesLoaded(mockRates);
    onBudgetLoaded(mockBudget);
  }, [useMock, onRatesLoaded, onBudgetLoaded]);

  const handleRates = async (f: File) => {
    const txt = await f.text();
    const parsed = JSON.parse(txt);
    setRatesName(f.name);
    onRatesLoaded(parsed);
  };

  const parseBudgetCsv = (txt: string): BudgetRow[] => {
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("CSV must have a header and at least one row");
    const header = lines[0].split(",").map((s) => s.trim());
    const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const aIdx = idx("account");
    const dIdx = idx("description");
    const cIdx = idx("current_budget");
    const pIdx = idx("proposed_budget");
    const eIdx = idx("encumbrances");
    if (aIdx < 0 || dIdx < 0 || cIdx < 0 || pIdx < 0) throw new Error("CSV must include account, description, current_budget, proposed_budget");
    const rows: BudgetRow[] = lines.slice(1).map((line) => {
      const cells = line.split(",").map((s) => s.trim());
      return {
        account: cells[aIdx],
        description: cells[dIdx],
        current_budget: Number(cells[cIdx] || 0),
        proposed_budget: Number(cells[pIdx] || 0),
        encumbrances: Number(cells[eIdx] || 0)
      };
    });
    return rows;
  };

  const handleBudget = async (f: File) => {
    const txt = await f.text();
    let rows: BudgetRow[] = [];
    try {
      if (txt.trim().startsWith("{") || txt.trim().startsWith("[")) {
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) {
          rows = parsed as BudgetRow[];
        } else if (parsed && Array.isArray((parsed as any).rows)) {
          rows = (parsed as any).rows as BudgetRow[];
        }
      } else {
        rows = parseBudgetCsv(txt);
      }
    } catch (e) {
      alert("Could not parse budget file. Provide JSON or CSV with account, description, current_budget, proposed_budget, encumbrances");
      return;
    }
    setBudName(f.name);
    onBudgetLoaded(rows);
  };

  return (
    <div className="border rounded p-3 bg-white">
      <div className="mb-3">
        <label className="block text-sm font-medium mb-1">Upload rates.json</label>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) handleRates(f);
          }}
        />
        {ratesName && <div className="text-xs text-gray-600 mt-1">Loaded {ratesName}</div>}
      </div>
      <div className="mb-3">
        <label className="block text-sm font-medium mb-1">Upload baseline budget (JSON or CSV)</label>
        <input
          type="file"
          accept=".json,application/json,.csv,text/csv"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) handleBudget(f);
          }}
        />
        {budName && <div className="text-xs text-gray-600 mt-1">Loaded {budName}</div>}
      </div>
      <div className="text-xs text-gray-600">
        CSV headers required: account, description, current_budget, proposed_budget, optional encumbrances
      </div>
    </div>
  );
}

function TransferPanel({
  transfers,
  setTransfers,
  mappingLog,
  setMappingLog,
  newBudget,
  setNewBudget,
  currentSnapshot,
  ratesData
}: {
  transfers: TransferItem[];
  setTransfers: React.Dispatch<React.SetStateAction<TransferItem[]>>;
  mappingLog: MappingRow[];
  setMappingLog: React.Dispatch<React.SetStateAction<MappingRow[]>>;
  newBudget: BudgetRow[];
  setNewBudget: React.Dispatch<React.SetStateAction<BudgetRow[]>>;
  currentSnapshot: BudgetRow[];
  ratesData: RatesData;
}) {
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [mode, setMode] = useState<TransferMode>("direct_to_dest");
  const [amount, setAmount] = useState<string>("");
  const [preview, setPreview] = useState<{ source_out: number; direct_to_dest: number; fa_added: number; eligible: boolean } | null>(null);

  const accounts = useMemo(
    () => newBudget.filter((r) => r.account !== "SUMMARY" && r.account !== (ratesData?.wrs_account_numbers?.indirect_costs || "58960")),
    [newBudget, ratesData]
  );

  useEffect(() => {
    try {
      const cents = toCents(amount);
      if (!to || !cents) {
        setPreview(null);
        return;
      }
      const { source_out, direct_to_dest, fa_added, eligible } = computeTransferImpact(ratesData, to, cents, mode);
      setPreview({ source_out, direct_to_dest, fa_added, eligible });
    } catch {
      setPreview(null);
    }
  }, [to, amount, mode, ratesData]);

  return (
    <div className="border border-gray-200 rounded p-4 bg-gray-50">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div>
          <label className="block text-sm mb-1">From</label>
          <select className="w-full border rounded px-2 py-2" value={from} onChange={(e) => setFrom((e.target as any).value)}>
            <option value="">Select</option>
            {accounts.map((r) => (
              <option key={r.account} value={r.account}>
                {r.account} — {r.description}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">To</label>
          <select className="w-full border rounded px-2 py-2" value={to} onChange={(e) => setTo((e.target as any).value)}>
            <option value="">Select</option>
            {accounts.map((r) => (
              <option key={r.account} value={r.account}>
                {r.account} — {r.description}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">Amount (USD)</label>
          <input
            className="w-full border rounded px-2 py-2"
            value={amount}
            onChange={(e) => setAmount((e.target as any).value)}
            placeholder="10000.00"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Mode</label>
          <select className="w-full border rounded px-2 py-2" value={mode} onChange={(e) => setMode(((e.target as any).value) as TransferMode)}>
            <option value="budget_total">budget_total</option>
            <option value="direct_to_dest">direct_to_dest</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            className="bg-blue-600 text-white px-3 py-2 rounded hover:bg-blue-700"
            onClick={() => {
              if (!from || !to) return alert("Select From and To");
              const cents = toCents(amount);
              if (!cents) return alert("Enter a positive amount");
              try {
                const fromRow = newBudget.find((r) => r.account === from);
                if (!fromRow) throw new Error("Source account not found in baseline");
                const enc = encumbrancesFor(from, currentSnapshot);
                const { source_out } = computeTransferImpact(ratesData, to, cents, mode);
                const fromAfter = toCents(fromRow.proposed_budget) - source_out;
                if (fromAfter < toCents(enc)) return alert(`Would breach encumbrance on ${from}`);
                if (fromAfter < 0) return alert(`Would make ${from} negative`);

                const newItem: TransferItem = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  from,
                  to,
                  amount_cents: cents,
                  mode
                };
                setTransfers((prev) => [...prev, newItem]);
                setAmount("");
                setPreview(null);
              } catch (e: any) {
                alert(e.message || String(e));
              }
            }}
          >
            Apply
          </button>
          <button
            className="bg-gray-200 px-3 py-2 rounded hover:bg-gray-300"
            onClick={() => {
              setTransfers([]);
              setMappingLog([]);
            }}
          >
            Clear All
          </button>
        </div>
      </div>

      <div className="text-xs text-gray-600 mt-2">
        {mode === "budget_total"
          ? "budget_total: move this total from the source; destination receives the direct remainder after F&A"
          : "direct_to_dest: give the destination this direct amount; the source covers direct plus F&A"}
      </div>

      {preview && (
        <div className="mt-3 p-2 border rounded bg-white text-sm">
          <strong>Preview:</strong>{" "}
          Source out ${fromCents(preview.source_out)} • Direct to dest ${fromCents(preview.direct_to_dest)} • F&A to 58960 ${fromCents(preview.fa_added)} • MTDC {preview.eligible ? "Yes" : "No"}
        </div>
      )}

      {transfers.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium mb-2">Pending Transfers</h4>
          <ul className="text-sm list-disc list-inside">
            {transfers.map((t) => (
              <li key={t.id}>
                {t.from} to {t.to} ${fromCents(t.amount_cents)} [{t.mode}]
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProjectedBudgetTable({
  finalRows,
  mapping,
  ratesData
}: {
  finalRows: BudgetRow[];
  mapping: MappingRow[];
  ratesData: RatesData;
}) {
  const addedFA = mapping.reduce((s: number, m: MappingRow) => s + (m.fa_added_to_fanda_cents || 0), 0);

  return (
    <div>
      <div className="mb-2 text-sm text-gray-700">
        Added F&A from transfers: <span className="font-medium">${fromCents(addedFA)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border border-gray-300">
          <thead className="bg-gray-50">
            <tr>
              <th className="border px-4 py-2 text-left">WRS Account</th>
              <th className="border px-4 py-2 text-left">Description</th>
              <th className="border px-4 py-2 text-right">Current Budget</th>
              <th className="border px-4 py-2 text-right">Proposed Budget Final</th>
              <th className="border px-4 py-2 text-right">Delta vs Current</th>
              <th className="border px-4 py-2 text-center">MTDC</th>
            </tr>
          </thead>
          <tbody>
            {finalRows.map((row, idx) => (
              row.account !== "SUMMARY" && (
                <tr key={idx}>
                  <td className="border px-4 py-2 font-mono text-sm">{row.account}</td>
                  <td className="border px-4 py-2">{row.description}</td>
                  <td className="border px-4 py-2 text-right">${Number(row.current_budget).toLocaleString()}</td>
                  <td className="border px-4 py-2 text-right">${Number(row.proposed_budget).toLocaleString()}</td>
                  <td className="border px-4 py-2 text-right">${(Number(row.proposed_budget) - Number(row.current_budget)).toLocaleString()}</td>
                  <td className="border px-4 py-2 text-center">
                    {row.account === (ratesData?.wrs_account_numbers?.indirect_costs || "58960") ? "-" : (isMtdcEligible(row.account, ratesData) ? "Yes" : "No")}
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm">View Mapping Log</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full border border-gray-300 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-2 py-1">From to To</th>
                <th className="border px-2 py-1">Source Out</th>
                <th className="border px-2 py-1">Direct</th>
                <th className="border px-2 py-1">F&A to 58960</th>
                <th className="border px-2 py-1">MTDC</th>
                <th className="border px-2 py-1">Mode</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((m, i) => (
                <tr key={i}>
                  <td className="border px-2 py-1">{m.from} to {m.to}</td>
                  <td className="border px-2 py-1 text-right">${fromCents(m.source_out_cents)}</td>
                  <td className="border px-2 py-1 text-right">${fromCents(m.direct_to_dest_cents)}</td>
                  <td className="border px-2 py-1 text-right">${fromCents(m.fa_added_to_fanda_cents)}</td>
                  <td className="border px-2 py-1 text-center">{m.dest_mtdc_eligible ? "Yes" : "No"}</td>
                  <td className="border px-2 py-1">{m.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ExportPanel({
  mapping,
  finalRows
}: {
  mapping: MappingRow[];
  finalRows: BudgetRow[];
}) {
  return (
    <div className="border rounded p-3 bg-white">
      <div className="mb-3">
        <button
          className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-black"
          onClick={() => {
            if (!mapping || mapping.length === 0) {
              alert("No manual transfers to export");
              return;
            }
            const header = [
              "id",
              "from",
              "to",
              "source_out_cents",
              "direct_to_dest_cents",
              "fa_added_to_fanda_cents",
              "dest_mtdc_eligible",
              "mode"
            ];
            const rows = mapping.map((m) => [
              m.id,
              m.from,
              m.to,
              m.source_out_cents,
              m.direct_to_dest_cents,
              m.fa_added_to_fanda_cents,
              m.dest_mtdc_eligible,
              m.mode
            ]);
            downloadCsv("rebudget_mapping.csv", header, rows);
          }}
        >
          Download Transfer Mapping CSV
        </button>
      </div>

      <div>
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          onClick={() => {
            if (!finalRows || finalRows.length === 0) {
              alert("No final budget to export");
              return;
            }
            const header = ["account", "description", "current_budget", "proposed_budget", "encumbrances", "change"];
            const rows = finalRows.map((r) => [
              r.account,
              r.description,
              r.current_budget,
              r.proposed_budget,
              r.encumbrances ?? 0,
              r.change ?? (Number(r.proposed_budget) - Number(r.current_budget))
            ]);
            downloadCsv("new_budget_final.csv", header, rows);
          }}
        >
          Download Final Budget CSV
        </button>
      </div>
    </div>
  );
}

// ---------- Main Component ----------
export default function USDARebudgetTool() {
  const [activeTab, setActiveTab] = useState<"upload" | "adjust" | "export">("upload");
  const [ratesData, setRatesData] = useState<RatesData | null>(null);
  const [currentSnapshot, setCurrentSnapshot] = useState<BudgetRow[]>([]);
  const [newBudget, setNewBudget] = useState<BudgetRow[]>([]);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [mappingLog, setMappingLog] = useState<MappingRow[]>([]);
  const [useMock, setUseMock] = useState<boolean>(true); // set true for quick testing

  // Keep a simple snapshot: if none provided, mirror newBudget with encumbrances default to zero
  useEffect(() => {
    if (newBudget.length > 0 && currentSnapshot.length === 0) {
      setCurrentSnapshot(newBudget.map((r) => ({ ...r, encumbrances: Number(r.encumbrances ?? 0) })));
    }
  }, [newBudget, currentSnapshot.length]);

  // Recompute mapping when inputs change
  const projection = useMemo(() => {
    if (!ratesData || newBudget.length === 0) return { finalRows: newBudget, mapping: [] as MappingRow[] };
    try {
      return projectWithTransfers(ratesData, newBudget, currentSnapshot, transfers);
    } catch (e) {
      console.warn(e);
      return { finalRows: newBudget, mapping: [] as MappingRow[] };
    }
  }, [ratesData, newBudget, currentSnapshot, transfers]);

  useEffect(() => {
    setMappingLog(projection.mapping);
  }, [projection.mapping]);

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }} className="p-4 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold mb-3">USDA Rebudget Tool</h1>

      <div className="flex gap-2 mb-3">
        <button
          className={`px-3 py-2 rounded border ${activeTab === "upload" ? "bg-gray-900 text-white" : "bg-white"}`}
          onClick={() => setActiveTab("upload")}
        >
          Upload
        </button>
        <button
          className={`px-3 py-2 rounded border ${activeTab === "adjust" ? "bg-gray-900 text-white" : "bg-white"}`}
          onClick={() => setActiveTab("adjust")}
          disabled={!ratesData || newBudget.length === 0}
          title={!ratesData || newBudget.length === 0 ? "Load rates and a budget first" : ""}
        >
          Fine-Tune Budget
        </button>
        <button
          className={`px-3 py-2 rounded border ${activeTab === "export" ? "bg-gray-900 text-white" : "bg-white"}`}
          onClick={() => setActiveTab("export")}
        >
          Export
        </button>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useMock}
            onChange={(e) => setUseMock(e.target.checked)}
          />
          Load mock data on start
        </label>
      </div>

      {activeTab === "upload" && (
        <UploadPanel
          onRatesLoaded={(r) => setRatesData(r)}
          onBudgetLoaded={(b) => {
            // Normalize numbers
            const normalized = b.map((row) => ({
              ...row,
              current_budget: Number(row.current_budget || 0),
              proposed_budget: Number(row.proposed_budget || 0),
              encumbrances: Number(row.encumbrances || 0),
              change: Number(row.proposed_budget || 0) - Number(row.current_budget || 0)
            }));
            setNewBudget(normalized);
          }}
          useMock={useMock}
        />
      )}

      {activeTab === "adjust" && (
        <div className="relative">
          {!ratesData || newBudget.length === 0 ? (
            <div className="text-gray-600">Upload rates and a baseline budget first</div>
          ) : (
            <div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <h4 className="text-sm font-medium text-blue-900 mb-2">Manual Transfers</h4>
                <p className="text-blue-800 text-sm">
                  Use this to make reallocations after personnel planning. F&A is added automatically when the destination is MTDC eligible and posted to the F&A account.
                </p>
              </div>
              <TransferPanel
                transfers={transfers}
                setTransfers={setTransfers}
                mappingLog={mappingLog}
                setMappingLog={setMappingLog}
                newBudget={newBudget}
                setNewBudget={setNewBudget}
                currentSnapshot={currentSnapshot}
                ratesData={ratesData}
              />
              <ProjectedBudgetTable
                finalRows={projection.finalRows}
                mapping={projection.mapping}
                ratesData={ratesData}
              />
            </div>
          )}
        </div>
      )}

      {activeTab === "export" && (
        <ExportPanel mapping={mappingLog} finalRows={projection.finalRows} />
      )}
    </div>
  );
}
