import { existsSync, readFileSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { loopRouterAbi } from "../src/abi.js";

// The router's build, as CI's contract artifacts job compiles it and every package job unpacks it (forge build in
// contracts/ locally); skipped without one, as the keeper's ABI test is. scripts/check-abi-drift.mjs holds the same set
// to the build in CI.
const ARTIFACT = new URL("../../../contracts/out/LoopRouter.sol/LoopRouter.json", import.meta.url);

interface Shape { type: string; name: string; indexed?: true; components?: Shape[] }
const params = (list: readonly AbiParameter[] = []): Shape[] => list.map((p) => ({
  type: p.type, name: p.name ?? "", ...("indexed" in p && p.indexed ? { indexed: true as const } : {}), ...("components" in p ? { components: params(p.components) } : {}),
}));
/** An entry as the chain sees it, its names included and Solidity's internal types left out. */
const shape = (entry: Abi[number]) => {
  const e = entry as { type: string; name?: string; inputs?: readonly AbiParameter[]; outputs?: readonly AbiParameter[]; stateMutability?: string; anonymous?: boolean };
  return {
    type: e.type, name: e.name ?? "", inputs: params(e.inputs), outputs: params(e.outputs),
    stateMutability: e.type === "function" ? e.stateMutability : undefined, anonymous: e.type === "event" ? Boolean(e.anonymous) : undefined,
  };
};
const names = (abi: Abi, type: string) => abi.flatMap((e) => (e.type === type && "name" in e ? [e.name] : [])).sort();

describe("the loop router ABI", () => {
  it("has its three ways to buy, what the SDK reads of it and its events (D242, D243)", () => {
    expect(names(loopRouterAbi, "function")).toEqual(["V3_FACTORY", "executorAllowed", "loop", "loopV3", "loopVia"]);
    expect(names(loopRouterAbi, "event")).toEqual(["BoughtVia", "Looped"]);
  });

  it.skipIf(!existsSync(ARTIFACT))("is the compiled router's, entry for entry, with every error the router can revert with", () => {
    const built = (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi }).abi;
    for (const entry of loopRouterAbi) {
      const twin = built.find((b) => b.type === entry.type && "name" in b && "name" in entry && b.name === entry.name);
      expect(twin && shape(twin), `${entry.type} ${"name" in entry ? entry.name : ""}`).toEqual(shape(entry));
    }
    expect(names(loopRouterAbi, "error")).toEqual(names(built, "error"));
  });
});
