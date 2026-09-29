// `show vrrp` role computation lives in the Click module (lib/commands/sonic/vrrp.ts)
// so it works from both the bash shell (routers) and the modal CLI (which delegates
// `show` to Click). This file intentionally registers nothing.
export {};
