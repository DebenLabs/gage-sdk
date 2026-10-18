import { describe, expect, it } from "vitest";
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, quoteExactOut, sqrtPriceAtTick, type TickReader } from "../src/v4math.js";
import { POOL, V3_POOL } from "../src/testing.js";

/** A pool's initialized ticks as a fake reader: the bitmap words and liquidityNet it was given, every other word empty. */
const reader = (words: Record<number, bigint>, nets: Record<number, bigint>): TickReader & { reads: number } => {
  const r = {
    reads: 0,
    bitmap: (word: number) => { r.reads += 1; return Promise.resolve(words[word] ?? 0n); },
    liquidityNet: (tick: number) => { r.reads += 1; return Promise.resolve(nets[tick] ?? 0n); },
  };
  return r;
};

describe("ticks and prices", () => {
  it("are v4-core's TickMath: the price at a tick, rounded up, from the least tick to the greatest", () => {
    expect(sqrtPriceAtTick(0)).toBe(1n << 96n);
    expect(sqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(sqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
    expect(sqrtPriceAtTick(1)).toBe(79_232_123_823_359_799_118_286_999_568n);
    expect(sqrtPriceAtTick(-1)).toBe(79_224_201_403_219_477_170_569_942_574n);
    expect(() => sqrtPriceAtTick(MAX_TICK + 1)).toThrow();
  });
  it("put the fake pools' ticks where their prices are", () => {
    for (const p of [POOL, V3_POOL]) {
      expect(sqrtPriceAtTick(p.tick) <= p.sqrtPriceX96 && p.sqrtPriceX96 < sqrtPriceAtTick(p.tick + 1)).toBe(true);
    }
  });
});

// A v4 pool built and swapped by v4-core's own PoolManager (forge, v4-core's Deployers and PoolSwapTest): 0.3% fee,
// tick spacing 60, the price of testing.ts's POOL, 1e15 of liquidity over the full range and three narrow positions
// around the price: 1.5e16 on [-223380, -223320] (the price's own), 4e15 on [-223320, -223140] and 6e15 on
// [-223560, -223380]. Each exact-output swap's input is what the PoolManager charged, the swap reverted between them.
describe("an exact-output quote across initialized ticks", () => {
  const pool = { sqrtPriceX96: 1_120_455_419_495_722_798_374_638n, tick: -223_339, liquidity: 16_000_000_000_000_000n, feePips: 3000n, tickSpacing: 60 };
  const words = {
    [-58]: 2_305_843_009_213_693_952n,
    [-15]: 3_177_685_677_423_314_508_660_663_753_482_698_752n,
    57: 50_216_813_883_093_446_110_686_315_385_661_331_328_818_843_555_712_276_103_168n,
  };
  const nets = { [-887_220]: 1_000_000_000_000_000n, [-223_560]: 6_000_000_000_000_000n, [-223_380]: 9_000_000_000_000_000n, [-223_320]: -11_000_000_000_000_000n, [-223_140]: -4_000_000_000_000_000n, 887_220: -1_000_000_000_000_000n };

  it("is what the PoolManager charges, buying currency0 (the price rises through the ticks above)", async () => {
    for (const [out, paid] of [
      [100_000_000_000_000_000n, 20_061_954n], [1_000_000_000_000_000_000n, 200_779_272n], [3_000_000_000_000_000_000n, 604_935_806n],
      [10_000_000_000_000_000_000n, 2_143_856_667n], [30_000_000_000_000_000_000n, 9_211_199_277n],
    ] as const) expect(await quoteExactOut(pool, out, false, reader(words, nets)), String(out)).toBe(paid);
  });

  it("is what the PoolManager charges, buying currency1 (the price falls through the ticks below)", async () => {
    for (const [out, paid] of [
      [20_000_000n, 100_309_768_922_852_450n], [200_000_000n, 1_003_896_354_481_071_256n], [600_000_000n, 3_017_495_272_879_405_258n],
      [2_000_000_000n, 10_324_869_845_774_678_971n], [6_000_000_000n, 42_504_289_854_272_234_423n],
    ] as const) expect(await quoteExactOut(pool, out, true, reader(words, nets)), String(out)).toBe(paid);
  });

  it("is null where the pool cannot sell that much before the price limit, or within the reads it is allowed", async () => {
    // The whole curve above holds about 1e15 / sqrt(price) of currency0: far less than this.
    expect(await quoteExactOut(pool, 10n ** 36n, false, reader(words, nets))).toBeNull();
    // An empty bitmap is one range all the way: walking it word by word stops at the read bound.
    const empty = reader({}, {});
    expect(await quoteExactOut({ ...pool, liquidity: 10n ** 9n }, 10n ** 18n, false, empty, 8)).toBeNull();
    expect(empty.reads).toBe(8);
  });
});
