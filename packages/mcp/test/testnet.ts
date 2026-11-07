import { TESTNET_MANIFEST } from "gage-sdk";

/** NVDAx's puts, once its generation's own puts release names its put router: #760 for r4, after its activation for r11's r5. */
export const TESTNET_PUTS = Boolean((TESTNET_MANIFEST as unknown as { intentV1Assets?: Record<string, { putRouter?: string }> }).intentV1Assets?.NVDAx?.putRouter);
/** The testnet's current generations as bundled: the USDG one and each lend asset's. */
const generations = [(TESTNET_MANIFEST as unknown as { intentV1: { rolloverRouter?: string; exitDesk?: string } }).intentV1,
  ...Object.values((TESTNET_MANIFEST as unknown as { intentV1Assets?: Record<string, { rolloverRouter?: string; exitDesk?: string }> }).intentV1Assets ?? {})];
/** Retained asset routers only close positions and end instructions; they enable no new put or roll. */
const retained = Object.values((TESTNET_MANIFEST as unknown as { intentV1AssetsPrevious?: Record<string, { entry: { rolloverRouter?: string; putRouter?: string } }[]> }).intentV1AssetsPrevious ?? {})
  .flatMap((rows) => rows.map(({ entry }) => entry));
/** Rolling over, once a testnet generation's rollover release names its router (r11's, 23 October 2026; a fresh USDG
 * generation names none until its own, as r13's on 29 October, while the lend assets keep theirs), and rolling over by
 * itself once the release also names the keeper (`rolloverExecutor`, D285). */
export const TESTNET_ROLLS = generations.some((g) => Boolean(g.rolloverRouter));
const keeper = Boolean((TESTNET_MANIFEST as unknown as { rolloverExecutor?: string }).rolloverExecutor);
const cancelRolls = TESTNET_ROLLS || retained.some((g) => Boolean(g.rolloverRouter));
const closePuts = TESTNET_PUTS || retained.some((g) => Boolean(g.putRouter));
export const ROLLS = [...(TESTNET_ROLLS ? ["roll", ...(keeper ? ["auto_roll"] : [])] : []), ...(cancelRolls ? ["cancel_auto_roll"] : [])];
export const PUTS = [
  ...(TESTNET_PUTS ? ["put_open"] : []), ...(closePuts ? ["put_close"] : []),
  ...(TESTNET_PUTS ? ["put_roll", ...(keeper ? ["put_auto_roll"] : [])] : []), ...(closePuts ? ["put_cancel_auto_roll"] : []),
];
/** The testnet's LP lane, once public: the bundled release keeps a hidden one only for its pools, which park serves (D334). */
export const TESTNET_LP = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { public?: boolean } }).lpLane?.public);
/** Fables' wrap and unwrap, while the public lane names a Fables adapter (the testnet's from 29 October 2026). */
export const TESTNET_FABLES = TESTNET_LP && Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { adapters?: { kind: string }[] } }).lpLane?.adapters?.some((a) => a.kind === "fables"));
/** A reserve vault's sGAGE claim, once the public lane names its rewards bridge (D454: the testnet's from 7 November 2026). */
export const TESTNET_LP_REWARDS = TESTNET_LP && Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { rewardsBridge?: string } }).lpLane?.rewardsBridge);
/** Park and unpark, wherever the release names an LP lane, its switch on or off (D334). */
export const TESTNET_PARK = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: unknown }).lpLane);
/** Exit now (Intent D57, root D357), once a current generation names the chain's exit desk (r13's, 29 October 2026). */
export const EXITS = generations.some((g) => Boolean(g.exitDesk)) ? ["rehypo_exit_now", "earn_exit_now", "earn_exit_list", "earn_exit_cancel", "earn_exit_collect"] : [];
/** The testnet's tools with a key: 27 without the lane, rolls, puts, park or exits (the free-cash read and the two pool
 * vault tools among them); the lane's 28 while public (four reads, and a prepare and an action for each of its twelve
 * actions), 32 with Fables' wrap and unwrap, and 2 more for the sGAGE claim once the lane names its rewards bridge; a prepare
 * and an action for each roll and put action, and a quote only where puts open; park's read, and a prepare and an action for
 * park and unpark; a prepare and an action for each exit action. */
export const TESTNET_TOOLS = 33 + (TESTNET_LP ? 28 : 0) + (TESTNET_FABLES ? 4 : 0) + (TESTNET_LP_REWARDS ? 2 : 0) + 2 * ROLLS.length + (TESTNET_PUTS ? 1 : 0) + 2 * PUTS.length
  + (TESTNET_PARK ? 5 : 0) + 2 * EXITS.length;
