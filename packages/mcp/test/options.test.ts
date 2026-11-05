import { describe, expect, it } from "vitest";
import { gageOptions } from "../src/options.js";

describe("gage-sdk's options from the environment", () => {
  it("take a Rates API key from GAGE_API_KEY (D382), and none when it is unset or blank", () => {
    const key = "a".repeat(40);
    expect(gageOptions({ GAGE_API_KEY: ` ${key} `, GAGE_NETWORK: "testnet", GAGE_RATES_URL: "https://rates.test" }))
      .toEqual({ network: "testnet", ratesUrl: "https://rates.test", apiKey: key });
    expect(gageOptions({ GAGE_API_KEY: " " })).toEqual({});
    expect(gageOptions({})).toEqual({});
  });
});
