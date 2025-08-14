import React, { useState } from "react";
import USDARebudgetTool from "./USDARebudgetTool.zfix";

/**
 * Minimal smoke tests that exercise the same math used by the Fine-Tune overlay:
 * - cents-safe conversions
 * - direct_to_dest and budget_total modes
 * - automatic F&A when dest is MTDC-eligible
 *
 * This doesn’t reach into the tool’s internal state; it just verifies the math engine.
 */

const toCents = (v: number | string) => {
  const s = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
  const [i, f = ""] = s.replace(/[^0-9.-]/g, "").split(".");
  return (
    parseInt(i || "0", 10) * 100 +
    (parseInt((f || "").padEnd(2, "0").slice(0, 2), 10) || 0)
  );
};
const fromCents = (c: number) =>
  `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(
    Math.abs(c) % 100
  ).padStart(2, "0")}`;

const mulRate = (c: number, r: number) => Math.round(c * r);
const divByOnePlus = (c: number, r: number) => Math.round(c / (1 + r));

type Mode = "direct_to_dest" | "budget_total";

/** Pure transfer impact, mirroring the app’s logic */
function computeTransferImpact({
  mtdcEligible,
  faRate,
  amountCents,
  mode,
}: {
  mtdcEligible: boolean;
  faRate: number; // e.g., 0.276
  amountCents: number;
  mode: Mode;
}) {
  const r = mtdcEligible ? faRate : 0;
  if (amountCents <= 0) throw new Error("Amount must be > 0");

  if (mode === "budget_total") {
    const source_out = amountCents;
    const direct_to_dest = r ? divByOnePlus(amountCents, r) : amountCents;
    const fa_added = r ? source_out - direct_to_dest : 0;
    return { source_out, direct_to_dest, fa_added };
  } else {
    const direct_to_dest = amountCents;
    const fa_added = r ? mulRate(direct_to_dest, r) : 0;
    const source_out = direct_to_dest + fa_added;
    return { source_out, direct_to_dest, fa_added };
  }
}

export default function SmokeHarness() {
  const [log, setLog] = useState<string[]>([]);

  const run = () => {
    const L: string[] = [];
    const rate = 0.276;

    // Case A: direct_to_dest = $10,000 to an MTDC-eligible dest
    {
      const r = computeTransferImpact({
        mtdcEligible: true,
        faRate: rate,
        amountCents: toCents(10000),
        mode: "direct_to_dest",
      });
      L.push(
        `A) direct_to_dest $10,000 → Source out $${fromCents(
          r.source_out
        )}, Direct $${fromCents(r.direct_to_dest)}, F&A $${fromCents(
          r.fa_added
        )}`
      );
      // Expect F&A = 10,000 * 0.276 = 2,760; source_out = 12,760
      if (r.source_out !== toCents(12760) || r.fa_added !== toCents(2760)) {
        L.push("❌ A failed expected values");
      } else {
        L.push("✅ A passed");
      }
    }

    // Case B: budget_total = $20,000 to an MTDC-eligible dest
    {
      const r = computeTransferImpact({
        mtdcEligible: true,
        faRate: rate,
        amountCents: toCents(20000),
        mode: "budget_total",
      });
      L.push(
        `B) budget_total $20,000 → Source out $${fromCents(
          r.source_out
        )}, Direct $${fromCents(r.direct_to_dest)}, F&A $${fromCents(
          r.fa_added
        )}`
      );
      // Direct = 20000 / 1.276 = 15,673.98; F&A = 4,326.02 (rounded cents)
      if (
        r.direct_to_dest !== toCents(15673.98) ||
        r.fa_added !== toCents(4326.02)
      ) {
        L.push("❌ B failed expected values");
      } else {
        L.push("✅ B passed");
      }
    }

    // Case C: Non-MTDC destination → F&A should be $0, sums must conserve
    {
      const r = computeTransferImpact({
        mtdcEligible: false,
        faRate: rate,
        amountCents: toCents(5000),
        mode: "direct_to_dest",
      });
      L.push(
        `C) Non-MTDC, direct_to_dest $5,000 → Source out $${fromCents(
          r.source_out
        )}, Direct $${fromCents(r.direct_to_dest)}, F&A $${fromCents(
          r.fa_added
        )}`
      );
      if (r.fa_added !== 0 || r.source_out !== toCents(5000)) {
        L.push("❌ C failed expected values");
      } else {
        L.push("✅ C passed");
      }
    }

    setLog(L);
  };

  return (
    <div style={{ padding: 16 }}>
      <h2>Engine Smoke Tests</h2>
      <button
        onClick={run}
        style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}
      >
        Run Smoke Tests
      </button>
      <pre
        style={{
          background: "#0b1020",
          color: "#d9e1ff",
          padding: 12,
          borderRadius: 8,
          whiteSpace: "pre-wrap",
        }}
      >
        {log.length ? log.join("\n") : "Click the button to run tests…"}
      </pre>

      <hr style={{ margin: "20px 0" }} />
      <h2>Tool Under Test</h2>
      <p style={{ marginBottom: 8 }}>
        Use the app below as normal (upload your WRS export and rates file,
        compute the New Budget, then open the
        <strong> Fine-Tune Budget</strong> tab to perform manual transfers and
        export the CSV).
      </p>
      <USDARebudgetTool />
    </div>
  );
}
