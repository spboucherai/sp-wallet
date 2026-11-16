"""Generates src/sp_wallet/models.py from docs/openapi/trading-v1.json (the contract of the SP Trading API).

    uv run python scripts/gen_models.py            write the file
    uv run python scripts/gen_models.py --check    exit 1 when the committed file is not what the document gives

Only the JSON Schema subset the document uses is understood (type, properties, required, additionalProperties, items,
prefixItems, enum, anyOf and the validation keywords); anything else raises instead of guessing.
tests/test_models_drift.py regenerates and compares, and separately walks the document against the model classes.
"""

from __future__ import annotations

import json
import keyword
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
OPENAPI_PATH = HERE.parents[2] / "docs" / "openapi" / "trading-v1.json"
OUTPUT_PATH = HERE.parent / "src" / "sp_wallet" / "models.py"

KNOWN = {
    "type", "properties", "required", "additionalProperties", "items", "prefixItems", "enum", "anyOf", "description", "default",
    "pattern", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
}  # fmt: skip

#: operationId -> name of the response model
RESPONSE_NAMES = {
    "getOpenApi": "OpenApiDocument", "listMarkets": "MarketList", "getMarket": "MarketDetail", "getOrderbook": "Orderbook",
    "getCandles": "Candles", "getPortfolio": "Portfolio", "getBalances": "Balances", "getActivity": "Activity",
    "listPositions": "Positions", "listOrders": "Orders", "getOrder": "OrderDetail", "listStrategies": "Strategies",
    "listAgents": "Agents", "getRisk": "Risk",
}  # fmt: skip
#: operationId -> name of the request-body model (identical schemas share one class: the first name wins)
REQUEST_NAMES = {
    "placeOrder": "OrderRequest", "previewOrder": "OrderRequest", "closePosition": "ClosePositionRequest",
    "reducePosition": "ReducePositionRequest", "createStrategy": "CreateStrategyRequest", "backtestStrategy": "BacktestRequest",
    "startStrategy": "StartRequest", "startAgent": "StartRequest", "stopStrategy": "StopRequest", "stopAgent": "StopRequest",
    "createAgent": "CreateAgentRequest",
}  # fmt: skip
#: mechanical name of a nested object (Parent + Property [+ Item]) -> the name used
NESTED_NAMES = {
    "MarketListMarketsItem": "Market", "MarketListErrorsItem": "PartialError", "CandlesCandlesItem": "Candle",
    "PortfolioWalletBalancesItem": "PortfolioBalance", "PortfolioAccountsItem": "PortfolioAccount", "BalancesBalancesItem": "Balance",
    "ActivityItemsItem": "ActivityItem", "PositionsPositionsItem": "Position", "OrdersOrdersItem": "OrderSummary",
    "OrderDetailOrder": "Order", "StrategiesLibraryItem": "StrategyLibraryEntry", "StrategiesVersionsItem": "StrategyVersion",
    "AgentsAgentsItem": "Agent", "RiskKillSwitch": "KillSwitch", "RiskCapabilityLocksItem": "CapabilityLock", "RiskAccountsItem": "RiskAccount",
}  # fmt: skip


def snake(name: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()
    s = re.sub(r"[^a-z0-9_]", "_", s)
    if not s or s[0].isdigit():
        s = f"f_{s}"
    return f"{s}_" if keyword.iskeyword(s) else s


def pascal(name: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]+", name) if p)


class Generator:
    def __init__(self) -> None:
        self.classes: dict[str, str] = {}  # name -> source
        self.by_schema: dict[str, str] = {}  # canonical schema JSON (+ kind) -> name

    def type_of(self, s: Any, hint: str, request: bool) -> str:
        if s is True or s == {}:
            return "Any"
        if not isinstance(s, dict):
            raise ValueError(f"unsupported schema: {s!r}")
        unknown = set(s) - KNOWN
        if unknown:
            raise ValueError(f"unsupported JSON Schema keyword(s) {sorted(unknown)} — extend gen_models.py")
        if "enum" in s:
            return f"Literal[{', '.join(json.dumps(v) for v in s['enum'])}]"
        if "anyOf" in s:
            return " | ".join(self.type_of(x, hint, request) for x in s["anyOf"])
        t = s.get("type")
        if isinstance(t, list):
            return " | ".join(self.type_of({**s, "type": x}, hint, request) for x in t)
        if t is None:
            return "Any"
        if t == "null":
            return "None"
        if t == "boolean":
            return "bool"
        if t in ("string", "integer", "number"):
            base = {"string": "str", "integer": "int", "number": "Decimal"}[t]
            if not request:
                return base
            c = []
            if "pattern" in s:
                c.append(f"pattern={s['pattern']!r}")
            if "minLength" in s:
                c.append(f"min_length={s['minLength']}")
            if "maxLength" in s:
                c.append(f"max_length={s['maxLength']}")
            if "minimum" in s:
                c.append(f"ge={s['minimum']}")
            if "maximum" in s:
                c.append(f"le={s['maximum']}")
            return f"Annotated[{base}, Field({', '.join(c)})]" if c else base
        if t == "array":
            if "prefixItems" in s:
                if s.get("items") is not False:
                    raise ValueError("open tuples are not supported")
                return f"tuple[{', '.join(self.type_of(x, hint, request) for x in s['prefixItems'])}]"
            inner = f"list[{self.type_of(s.get('items', True), hint + 'Item', request)}]"
            c = []
            if request and "minItems" in s:
                c.append(f"min_length={s['minItems']}")
            if request and "maxItems" in s:
                c.append(f"max_length={s['maxItems']}")
            return f"Annotated[{inner}, Field({', '.join(c)})]" if c else inner
        if t == "object":
            if not s.get("properties"):
                return "dict[str, Any]"
            return self.model(s, hint, request)
        raise ValueError(f"unsupported type {t!r}")

    def model(self, s: dict[str, Any], hint: str, request: bool) -> str:
        key = json.dumps(s, sort_keys=True) + ("|request" if request else "|response")
        if key in self.by_schema:
            return self.by_schema[key]
        name = NESTED_NAMES.get(hint, hint)
        if name in self.classes:
            raise ValueError(f"two different schemas want the class name {name}: add an entry to NESTED_NAMES")
        self.by_schema[key] = name
        self.classes[name] = ""  # reserve the position after its dependencies are known
        required = set(s.get("required", []))
        open_ = s.get("additionalProperties") is not False
        lines = [f"class {name}({'RequestModel' if request else 'ApiModel'}):"]
        doc = s.get("description")
        extra = "extra members are allowed by the contract" if open_ else "closed object in the contract"
        lines.append(f'    """{(doc + " — ") if doc else ""}{extra}"""')
        lines.append("")
        fields = []
        for prop, ps in s["properties"].items():
            py = snake(prop)
            ann = self.type_of(ps, name + pascal(prop), request)
            args = []
            if prop not in required:
                if "None" not in ann.split(" | "):
                    ann += " | None"
                args.append("default=None")
            if py != prop:
                args.append(f"alias={prop!r}")
            desc = ps.get("description")
            if "default" in ps:
                desc = f"{desc + ' — ' if desc else ''}server default: {json.dumps(ps['default'])}"
            if desc:
                args.append(f"description={desc!r}")
            fields.append(f"    {py}: {ann}" + (f" = Field({', '.join(args)})" if args else ""))
        lines += fields
        del self.classes[name]
        self.classes[name] = "\n".join(lines)
        return name


def generate(document: dict[str, Any]) -> str:
    g = Generator()
    ops = [(o["operationId"], method.upper(), path, o) for path, item in document["paths"].items() for method, o in item.items()]
    responses: dict[str, str] = {}
    requests: dict[str, str] = {}
    for op_id, _method, _path, o in ops:
        ok = o["responses"].get("200", {}).get("content", {}).get("application/json")
        if ok:
            responses[op_id] = g.model(ok["schema"], RESPONSE_NAMES[op_id], request=False)
        body = o.get("requestBody", {}).get("content", {}).get("application/json")
        if body:
            requests[op_id] = g.model(body["schema"], REQUEST_NAMES[op_id], request=True)

    out = [
        '"""Models of the SP Trading API.',
        "",
        "GENERATED by scripts/gen_models.py from docs/openapi/trading-v1.json — do not edit.",
        "tests/test_models_drift.py fails when this file is not what the generator gives, or when a model no longer",
        "matches the document.",
        "",
        "Money, prices and sizes are decimal STRINGS (`str`) exactly as the API sends them: use `sp_wallet.to_decimal`.",
        "The few members the API sends as JSON numbers are `Decimal` (the SDK never parses a number as a binary float).",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from decimal import Decimal",
        "from typing import Annotated, Any, Literal",
        "",
        "from pydantic import Field",
        "",
        "from ._models_base import ApiModel, RequestModel",
        "",
        f"API_VERSION = {document['info']['version']!r}",
        f"SCOPES: tuple[str, ...] = ({', '.join(repr(s['scope']) for s in document['x-spw-scopes'])},)",
        "#: inert on a key that is not bound to a trading mandate (403 `mandate_required`)",
        f"EXECUTION_SCOPES: tuple[str, ...] = ({', '.join(repr(s['scope']) for s in document['x-spw-scopes'] if s['execution'])},)",
        f"WEBHOOK_EVENTS: tuple[str, ...] = ({', '.join(repr(e['event']) for e in document['x-spw-webhook-events'])},)",
        "",
    ]
    for src in g.classes.values():
        out += ["", src, ""]
    out += ["", "#: operationId -> (method, path template, scope, implemented by the server, mutating/idempotency-keyed, needs a mandate)"]
    out.append("OPERATIONS: dict[str, tuple[str, str, str, bool, bool, bool]] = {")
    for op_id, method, path, o in ops:
        idem = any(p["in"] == "header" and p["name"] == "Idempotency-Key" and p.get("required") for p in o.get("parameters", []))
        out.append(
            f"    {op_id!r}: ({method!r}, {path!r}, {o['x-spw-scope']!r}, {o['x-spw-implemented'] is True}, {idem}, "
            f"{o.get('x-spw-requires-mandate') is True}),"
        )
    out.append("}")
    out.append("#: operationId -> response model")
    out.append("RESPONSE_MODELS: dict[str, type[ApiModel]] = {" + ", ".join(f"{k!r}: {v}" for k, v in responses.items()) + "}")
    out.append("#: operationId -> request-body model")
    out.append("REQUEST_MODELS: dict[str, type[RequestModel]] = {" + ", ".join(f"{k!r}: {v}" for k, v in requests.items()) + "}")
    out.append("")
    names = sorted([*g.classes, "API_VERSION", "SCOPES", "EXECUTION_SCOPES", "WEBHOOK_EVENTS", "OPERATIONS", "RESPONSE_MODELS", "REQUEST_MODELS"])
    out.append("__all__ = [" + ", ".join(repr(n) for n in names) + "]")
    out.append("")
    return "\n".join(out)


def main() -> int:
    text = generate(json.loads(OPENAPI_PATH.read_text()))
    if "--check" in sys.argv:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_text() != text:
            print("src/sp_wallet/models.py is out of date: run `uv run python scripts/gen_models.py`", file=sys.stderr)
            return 1
        print("src/sp_wallet/models.py is up to date")
        return 0
    OUTPUT_PATH.write_text(text)
    print(f"wrote {OUTPUT_PATH} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
