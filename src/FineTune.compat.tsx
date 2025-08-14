import React, { useMemo, useState, useEffect } from "react";

/**
 * FineTune module: reusable overlay for manual transfers
 * - Cents-safe math
 * - Automatic F&A to indirects account when destination is MTDC-eligible
 * - Encumbrance and negative checks
 *
 * Usage in host app:
 *  1) Ensure you have these states in your host component:
 *     const [transfers, setTransfers] = useState<TransferItem[]>([]);
 *     const [mappingLog, setMappingLog] = useState<MappingRow[]>([]);
 *  2) Render <FineTunePanel .../> in your "adjust" tab and pass required props.
 *  3) For export, use mappingLog and finalRows from projectWithTransfers(...).
 */

// ---------- Types ----------
export type RatesData = {
  fa_rate?: { rate?: number };
  wrs_account_numbers?: { indirect_costs?: string };
  mtdc_eligible_accounts?: string[];
};

export type BudgetRow = {
  account: string;
  description: string;
  current_budget: number | string;
  proposed_budget: number | string;
  encumbrances?: number | string;
  change?: number | string;
};

export type TransferMode = "budget_total" | "direct_to_dest";

export type TransferItem = {
  id: string;
  from: string;
  to: string;
  amount_cents: number;
  mode: TransferMode;
};

export type MappingRow = {
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
export const toCents = (v: number | string) => {
  const s = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
  const cleaned = s.replace(/[^0-9.-]/g, "");
  const parts = cleaned.split(".");
  const intPart = parts[0] || "0";
  const fracSrc = parts.length > 1 ? parts[1] : "";
  const padded = (fracSrc + "00");
  const fracPart = padded.slice(0, 2);
  const negative = intPart.startsWith("-");
  const intDigits = negative ? intPart.slice(1) : intPart;
  const dollars = parseInt(intDigits || "0", 10);
  const cents = parseInt(fracPart || "0", 10);
  const total = dollars * 100 + cents;
  return negative ? -total : total;
};
  const [i, f = ""] = s.replace(/[^0-9.-]/g, "").split(".");
  return (parseInt(i || "0", 10) * 100) + (parseInt((f || "")(2, "0").slice(0, 2), 10) || 0);
};

export const fromCents = (c: number) =>
  `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100)(2, "0")}`;

export const mulRate = (cents: number, rate: number) => Math.round(cents * rate);
export const divByOnePlus = (cents: number, rate: number) => Math.round(cents / (1 + rate));
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const isMtdcEligible = (acct: string, rates: RatesData) => {
  if (!rates) return false;
  const fanda = rates?.wrs_account_numbers?.indirect_costs || "58960";
  if (acct === fanda) return false;
  const elig = rates.mtdc_eligible_accounts || [];
  return elig.indexOf(acct);
};

export const faRateForDest = (_destAcct: string, rates: RatesData) => Number(rates?.fa_rate?.rate ?? 0);

export const encumbrancesFor = (acct: string, snapshot: BudgetRow[]) => {
  const row = snapshot.find((r) => r.account === acct);
  return Number(row?.encumbrances ?? 0);
};

export const baselineSum = (rows: BudgetRow[]) =>
  sum(rows.filter((r) => r.account !== "SUMMARY").map((r) => toCents(r.current_budget as number)));

export function computeTransferImpact(
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

export function applyOne(
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
  const fromAfter = toCents(fromRow.proposed_budget as number) - source_out;
  if (fromAfter < toCents(enc)) throw new Error(`Transfer would breach encumbrance on ${fromAcct}`);
  if (fromAfter < 0) throw new Error(`Transfer would make ${fromAcct} negative`);

  // Apply as currency numbers
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

export function projectWithTransfers(
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

// ---------- UI pieces ----------
export function FineTunePanel({
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
                const fromAfter = toCents(fromRow.proposed_budget as number) - source_out;
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

export function ProjectedBudgetTable({
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
