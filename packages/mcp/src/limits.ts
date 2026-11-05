/**
 * Valet's spend limits (D297): the most an agent's own key may borrow, and deposit into partner vaults, in USDG, in one
 * action and in any 24 hours, set by the wallet's owner in this server's environment. Loans, loops and LP loans count
 * against the borrowing limits by their principal, deposits (into an LP vault too, and a park's, D334) against the
 * deposit limits by their amount. Repaying, taking an LP position back, cashing out, withdrawing, exiting a partner vault
 * or a rehypo pool now, cancelling, collecting and claiming an LP
 * vault's bonus bring money or collateral back to the wallet and are not limited, nor is an action in an asset other
 * than USDG (the founder's choice). A roll counts only what it borrows beyond the loan it
 * repays (the founder, 18 October 2026): gage-sdk rolls a loan into one of the same size, so a roll counts nothing, as
 * repaying does; leaving a loan to roll by itself, or ending that, moves nothing, nor does a rating of gage (D302). On
 * mainnet each limit has a default, 100 USDG an action and 250 in 24 hours, which the owner may lift with `off` (D311:
 * whether an agent signs without limits is its owner's choice); on the testnet there is none unless one is set.
 *
 * The 24 hours count across restarts and across every gage-mcp on this computer acting for the wallet: each action that
 * counts holds its amount as a file in the wallet's folder, named after its time, kind and amount. The file is made
 * first, then every hold of the last 24 hours is added up, its own included, so two processes never pass a limit
 * together (both may refuse when they race for the last room, the safe direction). A hold is given back when the action
 * itself never went out or reverted, and kept otherwise, also when its outcome is unknown or the process dies.
 *
 * These limits guard against an agent's mistakes and against instructions hidden in what it reads. An agent that can
 * edit this server's settings or files can lift them, as it can any setting on its own computer.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError, MAINNET, type Hold, type SpendLimit, type View } from "gage-sdk";
import type { Address } from "viem";

export type Kind = "borrow" | "deposit";
/** One kind's limits in raw USDG (6 decimals): `each` an action, `day` in any 24 hours; null for none. */
export interface Limit { each: bigint | null; day: bigint | null }
export interface Limits { borrow: Limit; deposit: Limit }

const USDG_UNIT = 1_000_000n;
const DAY = 86_400;
/** Mainnet's limits where the owner sets none (the founder, 18 October 2026). */
export const MAINNET_LIMITS: Limits = {
  borrow: { each: 100n * USDG_UNIT, day: 250n * USDG_UNIT },
  deposit: { each: 100n * USDG_UNIT, day: 250n * USDG_UNIT },
};
/** The settings, by kind: an action, then 24 hours. */
const SETTINGS: Record<Kind, { each: string; day: string }> = {
  borrow: { each: "GAGE_MAX_BORROW_USDG", day: "GAGE_MAX_BORROW_DAY_USDG" },
  deposit: { each: "GAGE_MAX_DEPOSIT_USDG", day: "GAGE_MAX_DEPOSIT_DAY_USDG" },
};
const NOT_LIMITED = [
  "reclaim", "cash_out", "roll (a loan of the same size)", "auto_roll", "cancel_auto_roll", "earn_redeem", "cancel", "collect", "feedback",
  "lp_repay", "lp_roll (to a loan no larger)", "lp_return_position", "lp_collect", "lp_withdraw", "lp_redeem", "lp_claim_bonus", "lp_wrap", "lp_unwrap",
  "lp_create_vault", "lp_vault_add_pool", "lp_vault_remove_pool", "unpark", "rehypo_exit_now", "earn_exit_now", "earn_exit_list", "earn_exit_cancel",
  "earn_exit_collect", "actions in an asset other than USDG",
];
/** What the limits leave free (`NOT_LIMITED`), in words, for the guide, `init` and `gage_limits`. */
export const NOT_LIMITED_WORDS = "Repaying (an LP loan too), taking an LP position back, cashing out, rolling a loan over at the same size (an LP loan to one no larger), leaving a loan to roll by itself or ending that, withdrawing, unparking, exiting a partner vault or a rehypo pool now and listing an exit's next loan, cancelling, collecting, claiming an LP vault's bonus, wrapping or unwrapping Fables receipts, a curator's opening an LP vault or changing its pools and rating gage are not limited, nor are actions in an asset other than USDG.";

/**
 * A setting's amount of USDG, whole or with up to six decimals, as raw USDG, or null for `off` (no limit, D311); anything
 * else is refused in fixed words naming it.
 */
function amountOf(name: string, value: string): bigint | null {
  const written = value.trim();
  if (written.toLowerCase() === "off") return null;
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(written)) throw new ApiError("INVALID_LIMIT", `${name} must be an amount of USDG, such as 100 or 0.5, or off`, 400);
  const [whole = "0", decimals = ""] = written.split(".");
  return BigInt(whole) * USDG_UNIT + BigInt(decimals.padEnd(6, "0"));
}

/**
 * The limits a server signs under on `chainId`: each setting given (`off` for none), else mainnet's default for it. On
 * the testnet a setting not given is no limit, and with none given there are no limits at all (null).
 */
export function limitsFrom(env: NodeJS.ProcessEnv, chainId: number): Limits | null {
  const given = (name: string) => (env[name] ?? "").trim() !== "";
  const settings = Object.values(SETTINGS).flatMap((s) => [s.each, s.day]);
  if (chainId !== MAINNET && !settings.some(given)) return null;
  const pick = (kind: Kind, which: "each" | "day") => {
    const name = SETTINGS[kind][which];
    return given(name) ? amountOf(name, env[name]!) : chainId === MAINNET ? MAINNET_LIMITS[kind][which] : null;
  };
  return { borrow: { each: pick("borrow", "each"), day: pick("borrow", "day") }, deposit: { each: pick("deposit", "each"), day: pick("deposit", "day") } };
}

/** Raw USDG as it is written: 100, 20.5, 0.000001. */
export function usdgText(raw: bigint): string {
  const whole = raw / USDG_UNIT, part = (raw % USDG_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return part ? `${whole}.${part}` : `${whole}`;
}

const HOLD = /^(\d+)-(borrow|deposit)-(\d+)-\d+-[0-9a-f]+\.hold$/;

/** The wallet's holds of the last 24 hours, in one folder per wallet and chain, readable by this user only. */
export class Ledger {
  constructor(private readonly dir: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /**
   * The holds of the last 24 hours of `kind`, summed; older holds are deleted on the way. A folder that cannot be read
   * refuses: none read is not none held (the audit of 18 October 2026: a folder one could write in but not read let
   * every action through).
   */
  used(kind: Kind): bigint {
    const since = this.now() - DAY;
    let sum = 0n;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
      throw new ApiError("LIMITS_UNREADABLE", "The spend limits' record cannot be read; check the permissions of GAGE_HOME", 500);
    }
    for (const name of names) {
      const hold = HOLD.exec(name);
      if (!hold) continue;
      if (Number(hold[1]) <= since) { this.drop(name); continue; }
      if (hold[2] === kind) sum += BigInt(hold[3]!);
    }
    return sum;
  }

  /** Holds `amount` of `kind` against `day` (none when null): made first, then counted with every other, or refused. */
  hold(kind: Kind, amount: bigint, day: bigint | null, refuse: (used: bigint) => ApiError): Hold {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.ownFolder();
    const name = `${this.now()}-${kind}-${amount}-${process.pid}-${randomBytes(4).toString("hex")}.hold`;
    writeFileSync(path.join(this.dir, name), "", { flag: "wx", mode: 0o600 });
    let used: bigint;
    try { used = this.used(kind); } catch (error) { this.drop(name); throw error; }
    if (day !== null && used > day) {
      this.drop(name);
      throw refuse(used - amount);
    }
    return { release: (sent) => { if (!sent) this.drop(name); } };
  }

  /** The folder is this user's, and no one else may write in it: another user could add or remove holds there. */
  private ownFolder() {
    if (process.platform === "win32") return;
    const folder = statSync(this.dir), uid = process.getuid?.();
    if (!folder.isDirectory() || (uid !== undefined && folder.uid !== uid) || (folder.mode & 0o022) !== 0) {
      throw new ApiError("LIMITS_UNSAFE", "The spend limits' record is in a folder another user can write in; keep GAGE_HOME this user's only (chmod 700)", 500);
    }
  }

  private drop(name: string) {
    try { unlinkSync(path.join(this.dir, name)); } catch { /* gone already */ }
  }
}

/** What an action counts as, in raw USDG; null for one that is not limited. */
function counted(view: View, usdg: Address): { kind: Kind; amount: bigint; what: string } | null {
  const isUsdg = (asset?: { token: Address }) => asset === undefined || asset.token.toLowerCase() === usdg.toLowerCase();
  switch (view.action) {
    case "borrow": return isUsdg(view.asset) ? { kind: "borrow", amount: BigInt(view.principal), what: "This loan borrows" } : null;
    // A loop or a put in a lend asset (its `asset`) borrows that asset: not limited, as a loan in it is not.
    case "leverage": return isUsdg(view.asset) ? { kind: "borrow", amount: BigInt(view.principal), what: "This loop borrows" } : null;
    case "put_open": return isUsdg(view.asset) ? { kind: "borrow", amount: BigInt(view.principal), what: "This put borrows" } : null;
    case "earn_deposit": return isUsdg(view.asset) ? { kind: "deposit", amount: BigInt(view.amount), what: "This deposit is" } : null;
    // The LP lane lends and takes USDG alone (docs/api.md "LP lane"): an LP loan counts its principal, an LP vault's
    // deposit its amount. A borrow planned once its loan is open answers lp_withdraw's view: it borrows nothing new.
    case "lp_borrow": return { kind: "borrow", amount: BigInt(view.principal), what: "This LP loan borrows" };
    case "lp_deposit": return { kind: "deposit", amount: BigInt(view.amount), what: "This deposit is" };
    case "lp_roll": {
      // As a roll: only what the new LP loan borrows beyond the one it repays.
      const more = BigInt(view.principal) - BigInt(view.oldPrincipal);
      return more > 0n ? { kind: "borrow", amount: more, what: "This LP roll borrows a further" } : null;
    }
    // Wrapping Fables receipts into a position, or unwrapping one, moves no USDG. A borrow against receipts is planned,
    // and limited as lp_borrow, once its wrap is mined (gage-sdk's run asks again with the loan's own plan).
    case "lp_wrap": case "lp_unwrap": return null;
    // A curator opening an LP vault or changing its pools (D318) moves no USDG.
    case "lp_create_vault": case "lp_vault_add_pool": case "lp_vault_remove_pool": return null;
    case "roll": case "put_roll": {
      // Only what the new loan borrows beyond the old one; a roll of the same size borrows nothing new.
      const more = BigInt(view.principal) - BigInt(view.oldPrincipal);
      return more > 0n && isUsdg(view.asset) ? { kind: "borrow", amount: more, what: "This roll borrows a further" } : null;
    }
    // Bringing money or collateral back, or moving nothing now: never counted. A cash-out repays the loan from the sale
    // of its pledge and pays the wallet the rest, as repaying would bring the pledge back. A rating of gage (D302) moves no money.
    case "cancel": case "reclaim": case "cash_out": case "auto_roll": case "cancel_auto_roll": case "earn_redeem": case "collect": case "feedback": return null;
    // A put closed out of its pledge brings the rest of it back; leaving a put to roll by itself, or ending that, moves nothing now.
    case "put_close": case "put_auto_roll": case "put_cancel_auto_roll": return null;
    // Repaying an LP loan, taking its position back, collecting its fees, withdrawing credits, redeeming LP vault shares
    // and claiming a bonus bring money or a position back to the wallet.
    case "lp_repay": case "lp_return_position": case "lp_collect": case "lp_withdraw": case "lp_redeem": case "lp_claim_bonus": return null;
    // Parking a position deposits what it held into a partner vault (D334), counted as a deposit in USDG; unparking
    // withdraws from one into the wallet's own new position.
    case "park": return isUsdg({ token: view.token }) ? { kind: "deposit", amount: BigInt(view.amount), what: "This park deposits" } : null;
    case "unpark": return null;
    // A rehypo pool's exit now (root D357) commits the source's vault shares for the LP leaving: money comes back.
    case "rehypo_exit_now": return null;
    // A partner vault's exit now (Intent D57) commits the wallet's own shares, which a sale redeems for it; listing the
    // exit's next loan, cancelling it and collecting what its sales paid move nothing out.
    case "earn_exit_now": case "earn_exit_list": case "earn_exit_cancel": case "earn_exit_collect": return null;
  }
}

const FREE: Hold = { release: () => undefined };

/** The spend limit gage-sdk asks with each action's plan, before anything is sent (D297). */
export function spendLimit(limits: Limits, ledger: Ledger, usdg: Address): SpendLimit {
  return (view) => {
    const c = counted(view, usdg);
    if (!c) return FREE;
    const limit = limits[c.kind], setting = SETTINGS[c.kind];
    const verb = c.kind === "borrow" ? "borrow" : "deposit";
    const amount = usdgText(c.amount);
    if (limit.each !== null && c.amount > limit.each) {
      const per = c.kind === "borrow" ? "a loan or loop" : "at a time";
      throw new ApiError("SPEND_LIMIT", `${c.what} ${amount} USDG: this wallet may ${verb} at most ${usdgText(limit.each)} USDG ${per} (${setting.each})`, 403);
    }
    return ledger.hold(c.kind, c.amount, limit.day, (used) => new ApiError("SPEND_LIMIT_DAY",
      `${c.what} ${amount} USDG, and ${usdgText(used)} of the ${usdgText(limit.day!)} USDG this wallet may ${verb} in 24 hours are used (${setting.day})`, 403));
  };
}

/** Each limit and what is left of it, raw USDG as decimal strings (null for none), for `gage_limits` and the guide. */
export function limitsOf(limits: Limits, ledger: Ledger, usdg: Address) {
  const one = (kind: Kind) => {
    const { each, day } = limits[kind], used = ledger.used(kind);
    return { perAction: each?.toString() ?? null, per24Hours: day?.toString() ?? null, used: used.toString(), left: day === null ? null : (day > used ? day - used : 0n).toString() };
  };
  return { asset: { token: usdg, symbol: "USDG", decimals: 6 }, borrow: one("borrow"), deposit: one("deposit"), notLimited: NOT_LIMITED };
}

/** The limits in a sentence, for the guide and `init`. */
export function limitsSentence(limits: Limits): string {
  const part = (kind: Kind) => {
    const { each, day } = limits[kind];
    const verb = kind === "borrow" ? "borrows" : "deposits", per = kind === "borrow" ? "a loan or loop" : "at a time";
    const caps = [each === null ? null : `${usdgText(each)} USDG ${per}`, day === null ? null : `${usdgText(day)} USDG in any 24 hours`].filter(Boolean);
    return caps.length ? `${verb} at most ${caps.join(" and ")}` : `${verb} without a limit`;
  };
  return `it ${part("borrow")}, and ${part("deposit")}. ${NOT_LIMITED_WORDS}`;
}
