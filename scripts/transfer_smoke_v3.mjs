const BASE_URL = process.env.TRANSFER_SMOKE_BASE_URL || "http://localhost:3000";

function toTop(items, size = 10) {
  return [...items.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, size);
}

async function readJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  return res.json();
}

async function main() {
  try {
    const summary = await readJson("/api/dev/transfers/summary?limit=2000");
    const matches = await readJson("/api/dev/transfers/matches?state=all&limit=2000");

    if (!summary?.ok || !matches?.ok) {
      console.log("transfer-smoke-v3 SKIP: API returned non-ok payload.");
      return;
    }

    const rows = Array.isArray(matches.rows) ? matches.rows : [];
    if (rows.length === 0) {
      console.log("transfer-smoke-v3 SKIP: no transfer matches found in current dataset.");
      return;
    }

    let matched = 0;
    let uncertain = 0;
    let accountKeyClosure = 0;
    let nameClosureOnly = 0;
    const penaltyCounter = new Map();

    for (const row of rows) {
      const state = String(row.state || "");
      if (state === "matched") matched += 1;
      if (state === "uncertain") uncertain += 1;

      const explain = row.explain || {};
      const keyClosure =
        explain.accountKeyMatchAtoB === true || explain.accountKeyMatchBtoA === true;
      const nameClosure =
        explain.nameMatchAtoB === true || explain.nameMatchBtoA === true;

      if (state === "matched" && keyClosure) {
        accountKeyClosure += 1;
      }
      if (state === "matched" && !keyClosure && nameClosure) {
        nameClosureOnly += 1;
      }

      const penalties = Array.isArray(explain.penalties) ? explain.penalties : [];
      for (const penalty of penalties) {
        const key = String(penalty || "").trim();
        if (!key) continue;
        penaltyCounter.set(key, (penaltyCounter.get(key) || 0) + 1);
      }
    }

    console.log("transfer-smoke-v3 summary");
    console.log(`baseUrl=${BASE_URL}`);
    console.log(`rows=${rows.length}`);
    console.log(`matched=${matched}`);
    console.log(`matched_with_accountKey_closure=${accountKeyClosure}`);
    console.log(`matched_with_name_closure_only=${nameClosureOnly}`);
    console.log(`uncertain=${uncertain}`);

    const topPenalties = toTop(penaltyCounter, 10);
    if (topPenalties.length === 0) {
      console.log("top_penalties=none");
      return;
    }

    console.log("top_penalties:");
    for (const item of topPenalties) {
      console.log(`- ${item.name}: ${item.count}`);
    }
  } catch (err) {
    console.log(
      `transfer-smoke-v3 SKIP: failed to call ${BASE_URL} dev APIs (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

main();
