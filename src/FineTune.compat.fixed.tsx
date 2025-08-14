
import React, { useMemo, useState } from "react";

/** ---------- Shared Types (keep in sync with main app) ---------- */

export type TransferMode = "budget_total" | "direct_to_dest";

export interface BudgetRow {
  account: string;
  description: string;
  current_budget: number;
  proposed_budget: number;
  change: number;
  mtdc_eligible: boolean;
  notes?: string;
  encumbrances?: number;
  balance_available?: number;
}

export interface RatesData {
  fa_rate: number; // e.g., 0.276
  wrs_account_numbers: {
    fa: string; // F&A account (where F&A gets posted)
  };
  mtdc_eligible_accounts: string[];
}

export interface TransferItem {
  id: number;
  from: string;
  to: string;
  mode: TransferMode;
  amount: number; // dollars (user enters)
  note?: string;
}

export interface MappingRow {
  from_account: string;
  to_account: string;
  direct_cents: number;
  fa_cents: number;
  total_cents: number;
  dest_mtdc_eligible: boolean;
  note?: string;
}

/** ---------- Cents-safe Utilities (no padStart/padEnd/includes) ---------- */

export const toCents = (v: number | string): number => {
  if (typeof v === "number" && isFinite(v)) {
    // round to 2 decimals then scale
    return Math.round(v * 100);
  }
  const raw = ("" + (v as any)).trim();
  if (!raw) return 0;

  // keep sign
  const negative = raw[0] == "-";
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const intPart = parts[0] ? parts[0] : "0";
  const fracSrc = parts.length > 1 ? parts[1] : "";
  const fracPart = (fracSrc + "00").slice(0, 2); // take at most 2, right-padded with 0s

  const dollars = parseInt(intPart || "0", 10);
  const cents = parseInt(fracPart || "0", 10);
  const total = dollars * 100 + cents;
  return negative ? -total : total;
};

export const fromCents = (c: number): number => {
  // convert back to dollars with 2 decimals
  return Math.round(c) / 100;
};

export const fmtUSD = (n: number): string => {
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  const parts = fixed.split(".");
  const ints = parts[0];
  const frac = parts.length > 1 ? parts[1] : "00";
  // add simple thousands separators
  const rgx = /(\d+)(\d{3})/;
  let x = ints;
  let outSign = "";
  if (x[0] === "-") {
    outSign = "-";
    x = x.slice(1);
  }
  while (rgx.test(x)) {
    x = x.replace(rgx, "$1,$2");
  }
  return outSign + x + "." + frac;
};

/** ---------- Core math ---------- */

export function computeTransferImpact(
  rates: RatesData,
  rows: BudgetRow[],
  fromAcct: string,
  toAcct: string,
  mode: TransferMode,
  amountDollars: number
): { mapping: MappingRow; previewRows: BudgetRow[] } {
  const faAccount = rates.wrs_account_numbers.fa;
  const destIsMTDC = (rates.mtdc_eligible_accounts || []).indexOf(toAcct) >= 0;
  const faRate = rates.fa_rate || 0;

  const fromRow = rows.find((r) => r.account === fromAcct);
  const toRow = rows.find((r) => r.account === toAcct);
  if (!fromRow) throw new Error("Unknown source account: " + fromAcct);
  if (!toRow) throw new Error("Unknown destination account: " + toAcct);
  if (fromAcct === toAcct) throw new Error("From/To must differ.");
  if (!isFinite(amountDollars) || amountDollars <= 0) throw new Error("Amount must be > 0");

  const fromAvail = (typeof fromRow.balance_available === "number" ? fromRow.balance_available! : (fromRow.proposed_budget - (fromRow.encumbrances || 0)));
  const capCents = toCents(fromAvail);
  let totalCents = toCents(amountDollars);
  if (totalCents > capCents) totalCents = capCents;

  let directCents = totalCents;
  let faCents = 0;

  if (mode === "budget_total") {
    if (destIsMTDC) {
      // total = direct + fa = direct * (1 + faRate) => direct = total / (1 + faRate)
      directCents = Math.floor(totalCents / (1 + faRate));
      faCents = totalCents - directCents;
    } else {
      directCents = totalCents;
      faCents = 0;
    }
  } else {
    // direct_to_dest
    if (destIsMTDC) {
      faCents = Math.round(directCents * faRate);
      totalCents = directCents + faCents;
      if (totalCents > capCents) {
        // rescale down to fit cap
        const scale = capCents / totalCents;
        directCents = Math.floor(directCents * scale);
        faCents = capCents - directCents;
        totalCents = capCents;
      }
    } else {
      faCents = 0;
      totalCents = directCents;
    }
  }

  // Build preview rows
  const preview = rows.map((r) => ({ ...r }));
  const f = preview.find((r) => r.account === fromAcct)!;
  const t = preview.find((r) => r.account === toAcct)!;
  const faRow = preview.find((r) => r.account === faAccount);

  f.proposed_budget = fromCents(toCents(f.proposed_budget) - totalCents);
  t.proposed_budget = fromCents(toCents(t.proposed_budget) + directCents);
  if (destIsMTDC && faCents > 0) {
    if (!faRow) throw new Error("F&A account not found in budget rows");
    faRow.proposed_budget = fromCents(toCents(faRow.proposed_budget) + faCents);
  }

  const mapping: MappingRow = {
    from_account: fromAcct,
    to_account: toAcct,
    direct_cents: directCents,
    fa_cents: faCents,
    total_cents: totalCents,
    dest_mtdc_eligible: !!destIsMTDC,
    note: ""
  };

  return { mapping, previewRows: preview };
}

export function applyOne(
  rows: BudgetRow[],
  m: MappingRow,
  rates: RatesData
): BudgetRow[] {
  const faAccount = rates.wrs_account_numbers.fa;
  const out = rows.map((r) => ({ ...r }));
  const f = out.find((r) => r.account === m.from_account);
  const t = out.find((r) => r.account === m.to_account);
  const fa = out.find((r) => r.account === faAccount);
  if (!f || !t) return rows;

  f.proposed_budget = fromCents(toCents(f.proposed_budget) - m.total_cents);
  t.proposed_budget = fromCents(toCents(t.proposed_budget) + m.direct_cents);
  if (m.dest_mtdc_eligible && m.fa_cents > 0 && fa) {
    fa.proposed_budget = fromCents(toCents(fa.proposed_budget) + m.fa_cents);
  }
  return out;
}

export function projectWithTransfers(
  rates: RatesData,
  rows: BudgetRow[],
  snapshot: BudgetRow[],
  transfers: TransferItem[]
): { finalRows: BudgetRow[]; mapping: MappingRow[] } {
  let working = rows.map((r) => ({ ...r }));
  const mapping: MappingRow[] = [];

  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const { mapping: m } = computeTransferImpact(
      rates,
      working,
      t.from,
      t.to,
      t.mode,
      t.amount
    );
    if (t.note) m.note = t.note;
    working = applyOne(working, m, rates);
    mapping.push(m);
  }
  return { finalRows: working, mapping };
}

/** ---------- UI: Fine-Tune Panel ---------- */

interface FineTunePanelProps {
  transfers: TransferItem[];
  setTransfers: (t: TransferItem[]) => void;
  mappingLog: MappingRow[];
  setMappingLog: (m: MappingRow[]) => void;
  newBudget: BudgetRow[];
  setNewBudget: (rows: BudgetRow[] | ((prev: BudgetRow[]) => BudgetRow[])) => void;
  currentSnapshot: BudgetRow[];
  ratesData: RatesData;
}

export const FineTunePanel: React.FC<FineTunePanelProps> = (props) => {
  const {
    transfers,
    setTransfers,
    mappingLog,
    setMappingLog,
    newBudget,
    setNewBudget,
    currentSnapshot,
    ratesData
  } = props;

  const [form, setForm] = useState<{
    from: string;
    to: string;
    mode: TransferMode;
    amount: string;
    note: string;
  }>({
    from: "",
    to: "",
    mode: "budget_total",
    amount: "",
    note: ""
  });

  const accounts = useMemo(() => newBudget.map((r) => r.account), [newBudget]);

  const addTransfer = () => {
    const amt = parseFloat(form.amount || "0");
    if (!form.from || !form.to || !isFinite(amt) || amt <= 0) return;
    const next: TransferItem = {
      id: Date.now(),
      from: form.from,
      to: form.to,
      mode: form.mode,
      amount: amt,
      note: form.note || ""
    };
    setTransfers([...(transfers || []), next]);
  };

  const applyAll = () => {
    const { finalRows, mapping } = projectWithTransfers(
      ratesData,
      newBudget,
      currentSnapshot,
      transfers || []
    );
    setNewBudget(finalRows);
    setMappingLog(mapping);
  };

  const removeTransfer = (id: number) => {
    setTransfers((transfers || []).filter((t) => t.id !== id));
  };

  return (
    <div className="border rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <select
          className="border rounded px-2 py-1"
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        >
          <option value="">From account…</option>
          {accounts.map((a) => (
            <option key={"f-" + a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <select
          className="border rounded px-2 py-1"
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        >
          <option value="">To account…</option>
          {accounts.map((a) => (
            <option key={"t-" + a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <select
          className="border rounded px-2 py-1"
          value={form.mode}
          onChange={(e) => setForm({ ...form, mode: e.target.value as TransferMode })}
        >
          <option value="budget_total">Enter total moved (direct+F&A)</option>
          <option value="direct_to_dest">Enter direct to destination</option>
        </select>

        <input
          className="border rounded px-2 py-1"
          placeholder="Amount (e.g., 5000)"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />

        <button
          className="bg-gray-900 text-white rounded px-3 py-1"
          onClick={addTransfer}
          title="Queue this transfer"
        >
          Queue
        </button>
      </div>

      <input
        className="border rounded px-2 py-1 w-full"
        placeholder="Optional note"
        value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />

      {(transfers || []).length > 0 && (
        <div className="border rounded p-3">
          <div className="font-medium mb-2">Pending transfers</div>
          <ul className="space-y-1">
            {(transfers || []).map((t) => (
              <li key={t.id} className="flex items-center justify-between">
                <span>
                  {t.from} → {t.to} · {t.mode} · ${fmtUSD(t.amount)} {t.note ? " · " + t.note : ""}
                </span>
                <button
                  className="text-sm text-red-600 underline"
                  onClick={() => removeTransfer(t.id)}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <button className="bg-blue-600 text-white rounded px-3 py-1" onClick={applyAll}>
              Apply all
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** ---------- UI: Projected table & mapping ---------- */

interface ProjectedProps {
  finalRows: BudgetRow[];
  mapping: MappingRow[];
  ratesData: RatesData;
}

export const ProjectedBudgetTable: React.FC<ProjectedProps> = ({ finalRows, mapping }) => {
  const totalProposed = finalRows.reduce((s, r) => s + (r.proposed_budget || 0), 0);
  return (
    <div className="mt-6 space-y-6">
      <div>
        <div className="font-semibold mb-2">Projected Budget</div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-2 py-1 text-left">Account</th>
                <th className="border px-2 py-1 text-left">Description</th>
                <th className="border px-2 py-1 text-right">Proposed</th>
              </tr>
            </thead>
            <tbody>
              {finalRows.map((r) => (
                <tr key={"row-" + r.account}>
                  <td className="border px-2 py-1">{r.account}</td>
                  <td className="border px-2 py-1">{r.description}</td>
                  <td className="border px-2 py-1 text-right">${fmtUSD(r.proposed_budget || 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="border px-2 py-1 font-semibold" colSpan={2}>Total</td>
                <td className="border px-2 py-1 text-right font-semibold">${fmtUSD(totalProposed)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div>
        <div className="font-semibold mb-2">Transfer Mapping (audit)</div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="border px-2 py-1 text-left">From</th>
                <th className="border px-2 py-1 text-left">To</th>
                <th className="border px-2 py-1 text-right">Direct</th>
                <th className="border px-2 py-1 text-right">F&A</th>
                <th className="border px-2 py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((m, i) => (
                <tr key={"m-" + i}>
                  <td className="border px-2 py-1">{m.from_account}</td>
                  <td className="border px-2 py-1">{m.to_account}</td>
                  <td className="border px-2 py-1 text-right">${fmtUSD(fromCents(m.direct_cents))}</td>
                  <td className="border px-2 py-1 text-right">${fmtUSD(fromCents(m.fa_cents))}</td>
                  <td className="border px-2 py-1 text-right">${fmtUSD(fromCents(m.total_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
