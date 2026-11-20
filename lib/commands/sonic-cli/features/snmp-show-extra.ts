/**
 * KLISH `show snmp-server group | user | view | interface-traps` (enable-view,
 * data/device-capture/klish-xml/snmp.xml:127-232), rendered with the 4.5
 * sonic-mgmt-framework templates show_snmp_group.j2 / show_snmp_user.j2 /
 * show_snmp_view.j2 / show_snmp_if_trap.j2 (header lines use Python str.center).
 *
 * Users come from the live SNMP config (SNMP_USER rows written by KLISH
 * `snmp-server user` / Click `config snmp user add`); the auth/priv columns are
 * the lower-case protocol or "None" (sonic_cli_snmp.py snmp_user_get). VACM groups
 * and views are not modelled by the simulator's SNMP agent, so — like a switch with
 * no `snmp-server group|view` configured — those tables print only their headers;
 * a user's group is "None" (no VACM membership). Per-interface trap disables
 * (`no snmp trap enable` in interface mode) are not stored either, so every port
 * keeps the default (enabled) and the interface-traps table is empty.
 */
import { registerModal } from "../registry";
import { peekSnmpConfig } from "../../../protocols/snmp-config";
import { lines, pyCenter } from "./klish-show-util";

registerModal({
  id: "snmp-show-extra",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "snmp-server" || args.length !== 2) return null;
    const sub = args[1].toLowerCase();

    if (sub === "user") {
      const users = [...(peekSnmpConfig(ctx.device)?.users ?? [])].sort((x, y) => x.name.localeCompare(y.name));
      const rows = [" ", `${pyCenter("User Name", 32)} ${pyCenter("Group Name", 32)} ${pyCenter("Auth ", 9)} Privacy`, "-------------------------------- -------------------------------- ---------- -------"];
      for (const u of users) {
        const auth = u.authType && u.type !== "noAuthNoPriv" ? (u.authType === "MD5" ? "md5" : "sha") : "None";
        const priv = u.encType && u.type === "Priv" ? u.encType.toLowerCase() : "None";
        rows.push(`${u.name.padEnd(32)} ${"None".padEnd(32)} ${auth.padEnd(10)} ${priv.padEnd(7)}`);
      }
      rows.push(" ");
      return lines(rows);
    }
    if (sub === "group") {
      return lines([
        " ",
        `${pyCenter("Group Name", 16)} ${pyCenter("Model: Security", 20)} ${pyCenter("Read View", 16)} ${pyCenter("Write View", 16)} ${pyCenter("Notify View", 16)}`,
        "---------------- -------------------- ---------------- ---------------- ----------------",
        " ",
      ]);
    }
    if (sub === "view") {
      return lines([
        " ",
        `${pyCenter("View Name", 32)} ${pyCenter("OID Tree", 110)} ${pyCenter("Type", 8)}`,
        `${"-".repeat(32)} ${"-".repeat(109)}  ${"-".repeat(8)}`,
        " ",
      ]);
    }
    if (sub === "interface-traps") {
      return lines([" ", `${pyCenter("Interface Name", 32)} ${pyCenter("Status", 32)}`, `${"-".repeat(32)} ${"-".repeat(32)}`, " "]);
    }
    return null;
  },
});
