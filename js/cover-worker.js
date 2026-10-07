// 買い目計算をバックグラウンドで実行する
importScripts("covering.js");

self.onmessage = e => {
  const { allowed, probs, filters, radius, timeBudgetMs } = e.data;
  try {
    const t0 = performance.now();
    const U = buildUniverse(allowed, probs, filters);
    if (U.codes.length > MAX_UNIVERSE) {
      throw new Error(`絞り込み後も ${U.codes.length.toLocaleString()} 通りあり、計算上限 (${MAX_UNIVERSE.toLocaleString()} 通り) を超えています。マルチを減らすか、除外条件を強めてください。`);
    }
    const res = bestCover(U, radius, probs, timeBudgetMs);
    const verified = verifyCover(U, res.tickets, radius);
    const sim = simulatePrizes(res.tickets, probs, U.n);
    self.postMessage({
      ok: true,
      n: U.n,
      productSize: U.productSize,
      productMass: U.productMass,
      universeSize: U.codes.length,
      universeMass: U.mass,
      removed: U.removed,
      tickets: res.tickets,
      ticketMass: ticketMass(res.tickets, probs, U.n),
      runs: res.runs,
      verified,
      sim,
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
