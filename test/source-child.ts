// Child process for the concurrent single-fetch test: one getReading, result on stdout.
import { getReading } from "../src/source/index.ts";

const r = await getReading();
process.stdout.write(JSON.stringify({ status: r.status, detail: r.detail ?? null, used: r.snapshot?.windows.seven_day?.usedPct ?? null }));
