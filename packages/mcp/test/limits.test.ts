import { chmodSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { View } from "gage-sdk";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { Ledger, limitsFrom, limitsOf, limitsSentence, MAINNET_LIMITS, spendLimit, usdgText } from "../src/limits.js";

const USDG = "0x8c41f4a6c2e1b8a4e3c4f6b7d8e9f0a1b2c3d4e5" as Address;
const NVDA = "0x1111111111111111111111111111111111111111" as Address;
const dir = () => path.join(mkdtempSync(path.join(tmpdir(), "gage-limits-")), "wallet");
const usd = (n: number) => String(BigInt(Math.round(n * 1_000_000)));
const borrow = (n: number, token: Address = USDG) => ({ action: "borrow", principal: usd(n), asset: { token, symbol: token === USDG ? "USDG" : "NVDAx", decimals: 6 } }) as unknown as View;
const loop = (n: number) => ({ action: "leverage", principal: usd(n) }) as unknown as View;
const deposit = (n: number, token?: Address) => ({ action: "earn_deposit", amount: usd(n), ...(token ? { asset: { token, symbol: "NVDAx", decimals: 18 } } : {}) }) as unknown as View;
const code = async (f: () => unknown) => { try { await f(); return "none"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("Valet's spend limits (D297)", () => {
  it("are 100 USDG an action and 250 in 24 hours on mainnet, for loans and for deposits apart; none on the testnet unless set", () => {
    expect(MAINNET_LIMITS).toEqual({ borrow: { each: 100_000_000n, day: 250_000_000n }, deposit: { each: 100_000_000n, day: 250_000_000n } });
    expect(limitsFrom({}, 4663)).toEqual(MAINNET_LIMITS);
    expect(limitsFrom({}, 46630)).toBeNull();
    expect(limitsFrom({ GAGE_MAX_DEPOSIT_USDG: "20.5" }, 46630)).toEqual({ borrow: { each: null, day: null }, deposit: { each: 20_500_000n, day: null } });
    expect(limitsFrom({ GAGE_MAX_BORROW_USDG: "1000", GAGE_MAX_BORROW_DAY_USDG: "0", GAGE_MAX_DEPOSIT_DAY_USDG: " 75 " }, 4663))
      .toEqual({ borrow: { each: 1_000_000_000n, day: 0n }, deposit: { each: 100_000_000n, day: 75_000_000n } });
  });

  it("are lifted one by one by the owner's off, on mainnet as on the testnet (D311)", () => {
    expect(limitsFrom({ GAGE_MAX_BORROW_USDG: "off", GAGE_MAX_DEPOSIT_DAY_USDG: " OFF " }, 4663))
      .toEqual({ borrow: { each: null, day: 250_000_000n }, deposit: { each: 100_000_000n, day: null } });
    const all = { GAGE_MAX_BORROW_USDG: "off", GAGE_MAX_BORROW_DAY_USDG: "off", GAGE_MAX_DEPOSIT_USDG: "off", GAGE_MAX_DEPOSIT_DAY_USDG: "off" };
    expect(limitsFrom(all, 4663)).toEqual({ borrow: { each: null, day: null }, deposit: { each: null, day: null } });
    expect(limitsSentence(limitsFrom(all, 4663)!)).toContain("it borrows without a limit, and deposits without a limit.");
    expect(limitsFrom({ GAGE_MAX_BORROW_USDG: "off" }, 46630)).toEqual({ borrow: { each: null, day: null }, deposit: { each: null, day: null } });
  });

  it("refuse a setting that is neither an amount of USDG nor off, naming the setting", () => {
    for (const bad of ["-1", "1e6", "ten", "0.1234567", "none", "of", "1,000", "Infinity"]) {
      expect(() => limitsFrom({ GAGE_MAX_BORROW_DAY_USDG: bad }, 4663)).toThrow(/GAGE_MAX_BORROW_DAY_USDG/);
    }
  });

  it("refuse a loan or a loop above the limit for one, and hold nothing for it", async () => {
    const ledger = new Ledger(dir());
    const limit = spendLimit(MAINNET_LIMITS, ledger, USDG);
    expect(await code(() => limit(borrow(100.000001)))).toBe("SPEND_LIMIT");
    expect(await code(() => limit(loop(150)))).toBe("SPEND_LIMIT");
    expect(await code(() => limit(deposit(101)))).toBe("SPEND_LIMIT");
    expect(ledger.used("borrow")).toBe(0n);
    await expect(Promise.resolve().then(() => limit(borrow(150)))).rejects.toThrow("This loan borrows 150 USDG: this wallet may borrow at most 100 USDG a loan or loop (GAGE_MAX_BORROW_USDG)");
  });

  it("count loans and loops together over 24 hours, and deposits apart", async () => {
    const ledger = new Ledger(dir());
    const limit = spendLimit(MAINNET_LIMITS, ledger, USDG);
    await (await limit(borrow(100))).release(true);
    await (await limit(loop(100))).release(true);
    expect(ledger.used("borrow")).toBe(200_000_000n);
    await expect(Promise.resolve().then(() => limit(borrow(60)))).rejects.toThrow("This loan borrows 60 USDG, and 200 of the 250 USDG this wallet may borrow in 24 hours are used (GAGE_MAX_BORROW_DAY_USDG)");
    await (await limit(borrow(50))).release(true);
    expect(await code(() => limit(borrow(0.01)))).toBe("SPEND_LIMIT_DAY");
    // Deposits have their own 250.
    await (await limit(deposit(100))).release(true);
    expect(ledger.used("deposit")).toBe(100_000_000n);
  });

  // The audit of 18 October 2026 (I1): a record it cannot read counted as nothing held, so a folder writable but not
  // readable let every action through; one others can write in could have holds added or hidden. Both refuse.
  it("refuse to hold when their folder cannot be read, or others can write in it", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const folder = dir(), limit = spendLimit(MAINNET_LIMITS, new Ledger(folder), USDG);
    await (await limit(borrow(1))).release(true);
    chmodSync(folder, 0o300);
    try { expect(await code(() => limit(borrow(1)))).toBe("LIMITS_UNREADABLE"); } finally { chmodSync(folder, 0o700); }
    chmodSync(folder, 0o733);
    try { expect(await code(() => limit(borrow(1)))).toBe("LIMITS_UNSAFE"); } finally { chmodSync(folder, 0o700); }
    // Neither refusal left a hold behind.
    expect(readdirSync(folder)).toHaveLength(1);
  });

  it("give an amount back when the action itself never went out, and keep it when it did", async () => {
    const ledger = new Ledger(dir());
    const limit = spendLimit(MAINNET_LIMITS, ledger, USDG);
    const hold = await limit(borrow(100));
    expect(ledger.used("borrow")).toBe(100_000_000n);
    await hold.release(false);
    expect(ledger.used("borrow")).toBe(0n);
    await (await limit(borrow(100))).release(true);
    expect(ledger.used("borrow")).toBe(100_000_000n);
  });

  it("count across every process and restart: a held amount is a file in the wallet's own folder", async () => {
    const folder = dir();
    const one = spendLimit(MAINNET_LIMITS, new Ledger(folder), USDG);
    const two = spendLimit(MAINNET_LIMITS, new Ledger(folder), USDG);
    const first = await one(borrow(100));
    const second = await two(borrow(100));
    // Two holds in flight count before either ends: the third, in either process, has 50 left.
    expect(await code(() => one(borrow(60)))).toBe("SPEND_LIMIT_DAY");
    await first.release(true);
    await second.release(true);
    expect(new Ledger(folder).used("borrow")).toBe(200_000_000n);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toHaveLength(2);
  });

  it("forget what is older than 24 hours, and read no other file as a hold", async () => {
    const folder = dir();
    let now = 1_800_000_000;
    const ledger = new Ledger(folder, () => now);
    const limit = spendLimit(MAINNET_LIMITS, ledger, USDG);
    await (await limit(borrow(100))).release(true);
    await (await limit(borrow(100))).release(true);
    writeFileSync(path.join(folder, "notes.txt"), "not a hold");
    now += 86_400 - 1;
    expect(ledger.used("borrow")).toBe(200_000_000n);
    now += 1;
    expect(ledger.used("borrow")).toBe(0n);
    await (await limit(borrow(100))).release(true);
    expect(readdirSync(folder).sort()).toEqual([expect.stringMatching(/^1800086400-borrow-100000000-\d+-[0-9a-f]+\.hold$/), "notes.txt"]);
    // A file's name is what counts, not its time on disk.
    utimesSync(path.join(folder, "notes.txt"), 0, 0);
    expect(ledger.used("borrow")).toBe(100_000_000n);
  });

  it("leave free what brings money or collateral back, and what is in another asset than USDG (the founder's call)", async () => {
    const ledger = new Ledger(dir());
    const limit = spendLimit({ borrow: { each: 0n, day: 0n }, deposit: { each: 0n, day: 0n } }, ledger, USDG);
    for (const action of ["reclaim", "cash_out", "earn_redeem", "cancel", "collect", "auto_roll", "cancel_auto_roll"]) await (await limit({ action } as unknown as View)).release(true);
    await (await limit(borrow(5_000, NVDA))).release(true);
    await (await limit(deposit(5_000, NVDA))).release(true);
    expect(ledger.used("borrow") + ledger.used("deposit")).toBe(0n);
    expect(await code(() => limit(borrow(1)))).toBe("SPEND_LIMIT");
  });

  it("count a roll only for what it borrows beyond the loan it repays (the founder, 18 October 2026)", async () => {
    const ledger = new Ledger(dir());
    const limit = spendLimit(MAINNET_LIMITS, ledger, USDG);
    const roll = (old: number, now: number, token: Address = USDG) => ({ action: "roll", oldPrincipal: usd(old), principal: usd(now), asset: { token, symbol: "USDG", decimals: 6 } }) as unknown as View;
    // gage-sdk rolls at the same size: a 5,000 USDG loan rolls with nothing counted, as repaying it would.
    await (await limit(roll(5_000, 5_000))).release(true);
    expect(ledger.used("borrow")).toBe(0n);
    // Were a roll ever to borrow more, the further amount alone would count.
    await (await limit(roll(5_000, 5_060))).release(true);
    expect(ledger.used("borrow")).toBe(60_000_000n);
    await expect(Promise.resolve().then(() => limit(roll(1_000, 1_101)))).rejects.toThrow("This roll borrows a further 101 USDG: this wallet may borrow at most 100 USDG a loan or loop (GAGE_MAX_BORROW_USDG)");
    await (await limit(roll(1_000, 9_000, NVDA))).release(true);
    expect(ledger.used("borrow")).toBe(60_000_000n);
  });

  it("say in one sentence what they hold and what they leave free, as notLimited lists it", () => {
    expect(limitsSentence(MAINNET_LIMITS)).toBe("it borrows at most 100 USDG a loan or loop and 250 USDG in any 24 hours, and deposits at most 100 USDG at a time and 250 USDG in any 24 hours. "
      + "Repaying, cashing out, rolling a loan over at the same size, leaving a loan to roll by itself or ending that, withdrawing, cancelling, collecting and rating gage are not limited, nor are actions in an asset other than USDG.");
  });

  it("say what each limit is and what is left of it, as raw USDG", async () => {
    const ledger = new Ledger(dir());
    await (await spendLimit(MAINNET_LIMITS, ledger, USDG)(deposit(40))).release(true);
    expect(limitsOf(MAINNET_LIMITS, ledger, USDG)).toEqual({
      asset: { token: USDG, symbol: "USDG", decimals: 6 },
      borrow: { perAction: "100000000", per24Hours: "250000000", used: "0", left: "250000000" },
      deposit: { perAction: "100000000", per24Hours: "250000000", used: "40000000", left: "210000000" },
      notLimited: ["reclaim", "cash_out", "roll (a loan of the same size)", "auto_roll", "cancel_auto_roll", "earn_redeem", "cancel", "collect", "feedback", "actions in an asset other than USDG"],
    });
    expect(limitsOf({ borrow: { each: null, day: null }, deposit: { each: 5n, day: null } }, ledger, USDG).borrow).toEqual({ perAction: null, per24Hours: null, used: "0", left: null });
    expect([usdgText(100_000_000n), usdgText(20_500_000n), usdgText(1n), usdgText(0n)]).toEqual(["100", "20.5", "0.000001", "0"]);
  });
});
