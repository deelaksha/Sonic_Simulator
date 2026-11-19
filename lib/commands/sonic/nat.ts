/**
 * Click `show nat translations [count]` / `show nat statistics` (sonic-utilities
 * show/nat.py → scripts/natshow -t / -c / -s). Rendered from the live NAT
 * translation table (lib/protocols/nat.ts). Configuration is the KLISH `nat`
 * sub-mode (lib/commands/sonic-cli/features/nat.ts).
 */
import { line } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { tabulate } from "../../protocols/acl-rules";
import { renderNatTranslations, renderNatStatistics, renderNatCount } from "../../protocols/nat";

const show: SonicCmd[] = [
  {
    path: ["nat", "translations"],
    summary: "Show NAT translations (natshow -t; `count` = natshow -c)",
    run: (args, ctx) => ({ output: (args[0] === "count" ? renderNatCount(ctx.device) : renderNatTranslations(ctx.device, tabulate)).map((t) => line(t)) }),
  },
  {
    path: ["nat", "statistics"],
    summary: "Show NAT statistics (natshow -s)",
    run: (_args, ctx) => ({ output: renderNatStatistics(ctx.device, tabulate).map((t) => line(t)) }),
  },
];

export const natModule: SonicFeatureModule = { id: "nat", config: [], show };
