/**
 * Python side of the Scapy packet engine, executed inside Pyodide (browser Web
 * Worker, or Node for tests). JSON strings in, JSON strings out. Field values
 * from the UI are applied with Scapy's own field conversion — user input is
 * never evaluated as Python.
 *
 * Two shims make Scapy usable under Emscripten (verified with Scapy 2.8.0 /
 * Pyodide 0.26.4): Emscripten's socket module disables IPv6, so the IPv6
 * text<->binary conversions are routed to Scapy's pure-Python implementations;
 * and every address is set explicitly by the simulator, so Scapy never has to
 * resolve a host interface (it has no I/O here — packets are only built/parsed).
 */
export const SCAPY_ENGINE_PY = String.raw`
import json, socket, importlib

socket.has_ipv6 = True
from scapy import pton_ntop
_pton, _ntop = socket.inet_pton, socket.inet_ntop
socket.inet_pton = lambda af, a: pton_ntop._inet6_pton(a) if af == socket.AF_INET6 else _pton(af, a)
socket.inet_ntop = lambda af, b: pton_ntop._inet6_ntop(b) if af == socket.AF_INET6 else _ntop(af, b)

from scapy.config import conf
from scapy.packet import Packet, NoPayload
from scapy import fields as F

conf.verb = 0

# scapy.layers.http is omitted: it imports ssl, a separate multi-MB Pyodide package.
MODULES = [
    "scapy.layers.l2", "scapy.layers.inet", "scapy.layers.inet6", "scapy.layers.dns",
    "scapy.layers.dhcp", "scapy.layers.dhcp6", "scapy.layers.ntp", "scapy.layers.vxlan",
    "scapy.layers.snmp", "scapy.layers.tftp", "scapy.layers.rip", "scapy.layers.vrrp",
    "scapy.layers.hsrp", "scapy.layers.l2tp", "scapy.layers.sctp", "scapy.layers.radius",
    "scapy.layers.netflow",
    "scapy.contrib.bgp", "scapy.contrib.ospf", "scapy.contrib.igmp", "scapy.contrib.igmpv3", "scapy.contrib.mpls",
    "scapy.contrib.bfd", "scapy.contrib.lldp", "scapy.contrib.lacp", "scapy.contrib.pim",
    "scapy.contrib.erspan", "scapy.contrib.geneve", "scapy.contrib.stamp", "scapy.contrib.isis",
]

PROTOCOLS = {}
LOAD_ERRORS = {}
for _m in MODULES:
    try:
        mod = importlib.import_module(_m)
    except Exception as e:
        LOAD_ERRORS[_m] = "%s: %s" % (type(e).__name__, e)
        continue
    for _name, _obj in vars(mod).items():
        if isinstance(_obj, type) and issubclass(_obj, Packet) and _obj.__module__ == mod.__name__ and _obj.fields_desc:
            PROTOCOLS.setdefault(_name, _obj)


def _base(f):
    # Conditional/MultipleType wrappers hide the real field type.
    while hasattr(f, "fld"):
        f = f.fld
    if isinstance(f, F.MultipleTypeField):
        f = f.dflt
    return f


def _kind(f):
    b = _base(f)
    if isinstance(b, F.MACField): return "mac"
    if isinstance(b, (F.IPField,)): return "ipv4"
    if isinstance(b, (F.IP6Field,)): return "ipv6"
    if isinstance(b, F.FlagsField): return "flags"
    if isinstance(b, (F.PacketListField, F.PacketField)): return "packet"
    if isinstance(b, F.FieldListField): return "list"
    if isinstance(b, F._EnumField): return "enum"
    if isinstance(b, (F.StrField,)): return "str"
    fmt = getattr(b, "fmt", "") or ""
    if (isinstance(b.default, int) and not isinstance(b.default, bool)) or (fmt and fmt[-1] in "BHIQbhiq"):
        return "int"
    return "str"


def _display_name(cls, fallback):
    n = getattr(cls, "name", None)
    return n if isinstance(n, str) else fallback


import re
_MAC = re.compile(r"^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$")


def _check_address(proto, f, v):
    # Scapy would treat any other string as a hostname to resolve (or a Net
    # range expanding to many packets); the simulator only allows literals.
    kind = _kind(f)
    if not isinstance(v, str) or kind not in ("mac", "ipv4", "ipv6"):
        return
    try:
        if kind == "mac" and _MAC.match(v):
            return
        if kind == "ipv4":
            socket.inet_aton(v)
            if v.count(".") == 3:
                return
        if kind == "ipv6":
            pton_ntop._inet6_pton(v)
            return
    except Exception:
        pass
    raise ValueError("%s.%s: '%s' is not a valid %s address" % (proto, f.name, v, kind.upper()))


def _jsonable(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, bytes):
        return v.decode("latin-1")
    return repr(v)


def protocols():
    out = []
    for name, cls in sorted(PROTOCOLS.items(), key=lambda kv: kv[0].lower()):
        out.append({"proto": name, "name": _display_name(cls, name), "module": cls.__module__.replace("scapy.", "")})
    return json.dumps({"protocols": out, "loadErrors": LOAD_ERRORS})


def describe(proto):
    cls = PROTOCOLS.get(proto)
    if cls is None:
        raise ValueError("unknown protocol %s" % proto)
    fields = []
    for f in cls.fields_desc:
        b = _base(f)
        info = {"name": f.name, "type": type(b).__name__, "kind": _kind(f), "default": _jsonable(f.default)}
        if isinstance(b, F._EnumField) and getattr(b, "i2s", None):
            info["choices"] = {str(k): str(v) for k, v in list(b.i2s.items())[:256]}
        if isinstance(b, F.FlagsField):
            info["flags"] = [str(n) for n in b.names] if not isinstance(b.names, str) else list(b.names)
        if isinstance(b, (F.PacketListField, F.PacketField)) and isinstance(getattr(b, "cls", None), type):
            info["packetClass"] = b.cls.__name__
        fields.append(info)
    return json.dumps({"proto": proto, "name": _display_name(cls, proto), "fields": fields})


def _value(v):
    # {"proto": X, "fields": {...}} builds a nested packet (e.g. DNS qd=DNSQR).
    if isinstance(v, dict) and "proto" in v:
        return _layer(v)
    if isinstance(v, list):
        return [_value(x) for x in v]
    return v


def _layer(spec):
    proto = spec.get("proto")
    cls = PROTOCOLS.get(proto)
    if cls is None:
        raise ValueError("unknown protocol %s" % proto)
    by_name = {f.name: f for f in cls.fields_desc}
    kwargs = {}
    for k, v in (spec.get("fields") or {}).items():
        if k not in by_name:
            raise ValueError("%s has no field '%s'" % (proto, k))
        _check_address(proto, by_name[k], v)
        kwargs[k] = _value(v)
    return cls(**kwargs)


def _dissection(pkt):
    layers = []
    p = pkt
    while p is not None and not isinstance(p, NoPayload):
        fields = []
        for f in p.fields_desc:
            try:
                val = f.i2repr(p, p.getfieldval(f.name))
            except Exception:
                continue
            fields.append({"name": f.name, "value": str(val)})
        layers.append({"proto": type(p).__name__, "name": _display_name(type(p), type(p).__name__), "fields": fields})
        p = p.payload
    return {"summary": pkt.summary(), "layers": layers, "show": pkt.show2(dump=True)}


def build(stack_json):
    stack = json.loads(stack_json)
    if not stack:
        raise ValueError("empty layer stack")
    pkt = None
    for spec in stack:
        layer = _layer(spec)
        pkt = layer if pkt is None else pkt / layer
    raw = bytes(pkt)
    first = PROTOCOLS[stack[0]["proto"]]
    d = _dissection(first(raw))
    d["hex"] = raw.hex()
    return json.dumps(d)


def dissect(hexstr, first="Ether"):
    cls = PROTOCOLS.get(first)
    if cls is None:
        raise ValueError("unknown protocol %s" % first)
    return json.dumps(_dissection(cls(bytes.fromhex(hexstr))))
`;
