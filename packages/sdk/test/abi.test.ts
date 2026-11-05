import { existsSync, readFileSync, statSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { clPoolAbi, fablesHookAbi, fablesWrapperAbi, loopRouterAbi, lpAdapterAbi, lpCoreAbi, lpRegistryAbi, lpVaultAbi, lpVaultFactoryAbi, positionManagerAbi, putRouterAbi } from "../src/abi.js";

// The router's build, as CI's contract artifacts job compiles it and every package job unpacks it (forge build in
// contracts/ locally); skipped without one, as the keeper's ABI test is. scripts/check-abi-drift.mjs holds the same set
// to the build in CI.
const ARTIFACT = new URL("../../../contracts/out/LoopRouter.sol/LoopRouter.json", import.meta.url);
const PUT_ARTIFACT = new URL("../../../contracts/out/PutRouter.sol/PutRouter.json", import.meta.url);

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

describe("the put router ABI", () => {
  it("has the calls a borrower sends, what the SDK reads of it and its events", () => {
    expect(names(putRouterAbi, "function")).toEqual(["CORE", "USDG", "V3_FACTORY", "autoRolls", "cancelAutoRoll", "close", "evidenceFor", "paused", "roll", "rollableAt", "setAutoRoll"]);
    expect(names(putRouterAbi, "event")).toEqual(["AutoRollCancelled", "AutoRollCarried", "AutoRollSet", "Closed", "Rolled"]);
  });

  it.skipIf(!existsSync(PUT_ARTIFACT))("is the compiled router's, entry for entry, with every error the router can revert with", () => {
    const built = (JSON.parse(readFileSync(PUT_ARTIFACT, "utf8")) as { abi: Abi }).abi;
    for (const entry of putRouterAbi) {
      const twin = built.find((b) => b.type === entry.type && "name" in b && "name" in entry && b.name === entry.name);
      expect(twin && shape(twin), `${entry.type} ${"name" in entry ? entry.name : ""}`).toEqual(shape(entry));
    }
    expect(names(putRouterAbi, "error")).toEqual(names(built, "error"));
  });
});

// The LP lane's fragments (docs/api.md "LP lane"), against the default build (contracts/out, as CI's drift check reads
// it) or the lane's own profile (FOUNDRY_PROFILE=lp, contracts/out-lp), the newer where both exist (a local checkout
// may hold one older than its sources); skipped without either.
const lpArtifact = (name: string) => [`../../../contracts/out/${name}.sol/${name}.json`, `../../../contracts/out-lp/${name}.sol/${name}.json`]
  .map((p) => new URL(p, import.meta.url)).filter((u) => existsSync(u)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

describe("the LP lane's ABIs", () => {
  const sets = [["LPCore", lpCoreAbi], ["LPRegistry", lpRegistryAbi], ["LPVault", lpVaultAbi], ["ILPAdapter", lpAdapterAbi], ["FablesPositionWrapper", fablesWrapperAbi], ["LPVaultFactory", lpVaultFactoryAbi]] as const;
  for (const [name, abi] of sets) {
    const artifact = lpArtifact(name);
    it.skipIf(!artifact)(`${name}: every entry the SDK uses is the build's, names and all`, () => {
      const built = (JSON.parse(readFileSync(artifact!, "utf8")) as { abi: Abi }).abi;
      // An overloaded function (the vault's ERC-4626 deposit and redeem, each with a least-out twin, D319) is matched by
      // its input types too.
      const types = (e: Abi[number]) => ("inputs" in e ? e.inputs.map((i) => i.type).join() : "");
      for (const entry of abi) {
        if (!("name" in entry)) continue;
        const twin = built.find((b) => b.type === entry.type && "name" in b && b.name === entry.name && types(b) === types(entry));
        expect(twin && shape(twin), `${name} ${entry.type} ${entry.name}`).toEqual(shape(entry));
      }
    });
  }

  // The Fables hook is Fables' own contract: what the lane's interface to it names is checked against its build, the rest
  // (receipt approvals, staking, the pause) against the live hook's selectors when the fragments were written.
  const ledger = lpArtifact("IFablesLedger");
  it.skipIf(!ledger)("IFablesLedger: what the SDK asks a Fables hook that the lane's own interface names is the build's", () => {
    const built = (JSON.parse(readFileSync(ledger!, "utf8")) as { abi: Abi }).abi;
    const shared = fablesHookAbi.filter((e) => "name" in e && built.some((b) => b.type === e.type && "name" in b && b.name === e.name));
    expect(shared.map((e) => ("name" in e ? e.name : ""))).toEqual(["balanceOf", "rangeKey"]);
    for (const entry of shared) {
      const twin = built.find((b) => b.type === entry.type && "name" in b && "name" in entry && b.name === entry.name);
      expect(twin && shape(twin)).toEqual(shape(entry));
    }
  });

  it("asks a Fables hook only for its receipts, their approvals and staking, its pause and a range's key", () => {
    expect(names(fablesHookAbi, "function")).toEqual(["allowance", "approve", "balanceOf", "isOperator", "paused", "rangeKey", "unstake", "userPosition"]);
    expect(names(fablesWrapperAbi, "function")).toEqual(["nextTokenId", "position", "unwrap", "wrap"]);
  });

  it("asks a position manager only for what both Uniswap v3's and Ramses V3's answer, and a pool for slot0's first two fields", () => {
    expect(names(positionManagerAbi, "function")).toEqual(["approve", "balanceOf", "getApproved", "isApprovedForAll", "ownerOf", "tokenOfOwnerByIndex"]);
    expect(names(clPoolAbi, "function")).toEqual(["slot0"]);
  });
});
